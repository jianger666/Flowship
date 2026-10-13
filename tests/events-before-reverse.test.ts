/**
 * readEventsBefore 反向读：与「全量读 + findIndex」逐条等价，且连续上拉的 IO 量跟页大小同阶。
 *
 * 旧实现每翻一页都从文件头流式扫到锚点——翻最近几页也要读几乎整个文件。
 * 新实现从文件尾往回找锚点、连续翻页时 seek 到已知偏移；偏移缓存只是提示、用前必校验。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-events-before-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const { EVENTS_FILE, readEvents, readEventsBefore, taskDir } = await import(
  "@/lib/server/task-fs-core"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`events-before DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

let taskSeq = 0;
const newTaskId = (): string => `t_before_${++taskSeq}`;
const eventsPath = (id: string) => path.join(taskDir(id), EVENTS_FILE);

const writeRaw = async (id: string, content: string): Promise<void> => {
  await fs.mkdir(taskDir(id), { recursive: true });
  await fs.writeFile(eventsPath(id), content, "utf-8");
};

/** 可复现的伪随机（mulberry32） */
const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const mk = (i: number, text: string): TaskEvent => ({
  id: `ev_${i}`,
  ts: 1000 + i,
  kind: "info",
  text,
});

const TEXTS = [
  "短文本",
  "含中文的一行 ✓ 多字节",
  "emoji 😀🚀 和 𠮷 四字节",
  "x".repeat(300),
  "混合 mixed 内容 ".repeat(40),
];

/** 构造一份「脏」文件：多字节 / 超长行（跨 64KB 块）/ 空行 / 坏行 / CRLF / 末尾半行 */
const buildDirtyFile = (
  seed: number,
  n: number,
  opts: { crlf?: boolean; trailingHalf?: boolean } = {},
): { content: string; validIds: string[] } => {
  const r = rng(seed);
  const eol = opts.crlf ? "\r\n" : "\n";
  const lines: string[] = [];
  const validIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.03) {
      lines.push(""); // 空行
      continue;
    }
    if (roll < 0.06) {
      lines.push('{"id":"bad","ts":1,"kind":"info","text":"断'); // 坏行
      continue;
    }
    const big = roll > 0.985;
    const text = big
      ? "大".repeat(30_000 + Math.floor(r() * 40_000)) // UTF-8 下 ≈ 90~210KB：跨多个 64KB 块
      : TEXTS[Math.floor(r() * TEXTS.length)]!;
    lines.push(JSON.stringify(mk(i, text)));
    validIds.push(`ev_${i}`);
  }
  let content = lines.join(eol) + eol;
  if (opts.trailingHalf) content += '{"id":"ev_half","ts":9,"kind":"info","tex';
  return { content, validIds };
};

/** 对照基准：给定全量事件 + findIndex（旧语义） */
const legacyFrom = (
  all: TaskEvent[],
  beforeId: string,
  limit: number,
): { events: TaskEvent[]; hasMore: boolean } => {
  const idx = all.findIndex((e) => e.id === beforeId);
  if (idx < 0) return { events: [], hasMore: false };
  const start = Math.max(0, idx - limit);
  return { events: all.slice(start, idx), hasMore: start > 0 };
};

/** 对照基准：全量 read + findIndex（旧语义）；循环里请改用 legacyFrom 避免重复读文件 */
const legacyBefore = async (
  id: string,
  beforeId: string,
  limit: number,
): Promise<{ events: TaskEvent[]; hasMore: boolean }> =>
  legacyFrom(await readEvents(id), beforeId, limit);

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("与全量读逐条等价（差分）", () => {
  const variants: Array<{
    name: string;
    seed: number;
    opts: { crlf?: boolean; trailingHalf?: boolean };
  }> = [
    { name: "LF + 脏数据", seed: 1, opts: {} },
    { name: "CRLF", seed: 2, opts: { crlf: true } },
    { name: "末尾崩溃半行", seed: 3, opts: { trailingHalf: true } },
    { name: "CRLF + 末尾半行", seed: 4, opts: { crlf: true, trailingHalf: true } },
  ];

  for (const v of variants) {
    it(`${v.name}：抽样锚点 × 多种 limit，事件与 hasMore 都与全量读一致（冷、热缓存各一遍）`, async () => {
      const id = newTaskId();
      const { content, validIds } = buildDirtyFile(v.seed, 700, v.opts);
      await writeRaw(id, content);

      const r = rng(v.seed + 100);
      const anchors = new Set<string>([
        validIds[0]!, // 第一条（前面没有事件）
        validIds[1]!,
        validIds[validIds.length - 1]!, // 最后一条
        "ev_not_exist",
      ]);
      for (let k = 0; k < 40; k++) {
        anchors.add(validIds[Math.floor(r() * validIds.length)]!);
      }

      const all = await readEvents(id); // 对照基准只读一次
      for (const pass of ["冷", "热"]) {
        for (const anchor of anchors) {
          for (const limit of [1, 7, 50, 500]) {
            const got = await readEventsBefore(id, anchor, limit);
            const want = legacyFrom(all, anchor, limit);
            expect(
              got.events.map((e) => e.id),
              `${pass}缓存 anchor=${anchor} limit=${limit}`,
            ).toEqual(want.events.map((e) => e.id));
            expect(got.hasMore, `${pass}缓存 anchor=${anchor} limit=${limit}`).toBe(
              want.hasMore,
            );
          }
        }
      }
    });
  }

  it("单页超大行：锚点前一行 > 64KB（跨块拼接）也不丢不乱", async () => {
    const id = newTaskId();
    const lines = [
      JSON.stringify(mk(0, "头")),
      JSON.stringify(mk(1, "中".repeat(60_000))), // ≈180KB
      JSON.stringify(mk(2, "尾")),
      JSON.stringify(mk(3, "再尾")),
    ];
    await writeRaw(id, lines.join("\n") + "\n");

    for (const anchor of ["ev_1", "ev_2", "ev_3"]) {
      const got = await readEventsBefore(id, anchor, 10);
      const want = await legacyBefore(id, anchor, 10);
      expect(got.events.map((e) => e.id)).toEqual(want.events.map((e) => e.id));
      expect(got.hasMore).toBe(want.hasMore);
    }
    const got = await readEventsBefore(id, "ev_3", 10);
    expect(got.events[1]!.text).toBe("中".repeat(60_000)); // 内容完整、没被块边界切坏
  });
});

describe("连续上拉：从最新一路翻到最开头，拼起来恰好是全量历史", () => {
  it("每页锚点 = 上一页第一条；页与页无重叠无遗漏；最后一页 hasMore=false", async () => {
    const id = newTaskId();
    const { content } = buildDirtyFile(7, 1500, {});
    await writeRaw(id, content);
    const all = await readEvents(id);

    const PAGE = 64;
    let anchor = all[all.length - 20]!.id; // 模拟首屏尾部窗口的第一条
    const collected: TaskEvent[] = [];
    let guard = 0;
    for (;;) {
      const got = await readEventsBefore(id, anchor, PAGE);
      collected.unshift(...got.events);
      if (!got.hasMore) break;
      anchor = got.events[0]!.id;
      if (++guard > 1000) throw new Error("翻页没有收敛");
    }

    const anchorIdx = all.length - 20;
    expect(collected.map((e) => e.id)).toEqual(
      all.slice(0, anchorIdx).map((e) => e.id),
    );
  });
});

describe("IO 量：连续上拉跟页大小同阶、不再随「锚点离文件头多远」放大", () => {
  it("8MB 文件翻 20 页：总读取字节远小于文件大小（旧实现每页都要读 ≈ 整个文件）", async () => {
    const id = newTaskId();
    const lines: string[] = [];
    const filler = "z".repeat(180);
    const N = 40_000;
    for (let i = 0; i < N; i++) lines.push(JSON.stringify(mk(i, filler)));
    await writeRaw(id, lines.join("\n") + "\n");
    const { size } = await fs.stat(eventsPath(id));
    expect(size).toBeGreaterThan(7_000_000);

    // 统计该文件上所有 read 的字节数
    let bytesRead = 0;
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const fh = await realOpen(...args);
      if (String(args[0]) !== eventsPath(id)) return fh;
      const realRead = fh.read.bind(fh) as (...a: unknown[]) => Promise<{
        bytesRead: number;
      }>;
      (fh as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        const res = await realRead(...a);
        bytesRead += res.bytesRead;
        return res;
      };
      return fh;
    }) as unknown as typeof fs.open);

    const PAGE = 100;
    let anchor = `ev_${N - 50}`; // 模拟首屏尾部窗口的第一条（离文件尾很近）
    let pages = 0;
    for (; pages < 20; pages++) {
      const got = await readEventsBefore(id, anchor, PAGE);
      expect(got.events).toHaveLength(PAGE);
      anchor = got.events[0]!.id;
    }

    // 20 页 ≈ 2000 条 ≈ 0.4MB 的有效数据；允许块对齐 / 校验读的开销，但必须远小于一次全文件扫描
    expect(bytesRead).toBeLessThan(size / 4);
  });
});

describe("偏移缓存只是提示：陈旧时退回扫描、绝不翻出错页", () => {
  const ids = (xs: TaskEvent[]) => xs.map((e) => e.id);

  it("文件被重写（前面插入内容、偏移整体后移）：同一个 beforeId 仍与全量读一致", async () => {
    const id = newTaskId();
    const base = Array.from({ length: 300 }, (_, i) => mk(i, "原始内容 ".repeat(5)));
    await writeRaw(id, base.map((e) => JSON.stringify(e)).join("\n") + "\n");

    // 翻两页，把 ev_200 / ev_150 等锚点的偏移缓存起来
    const p1 = await readEventsBefore(id, "ev_250", 50);
    expect(ids(p1.events)[0]).toBe("ev_200");
    await readEventsBefore(id, "ev_200", 50);

    // 重写：id 相同但每条都变长了 → 所有事件的行首偏移都变了（缓存里的偏移必然陈旧）
    const rewritten = base.map((e) => mk(Number(e.id.slice(3)), "重写后更长的内容 ".repeat(20)));
    await writeRaw(id, rewritten.map((e) => JSON.stringify(e)).join("\n") + "\n");

    for (const anchor of ["ev_250", "ev_200", "ev_150"]) {
      const got = await readEventsBefore(id, anchor, 50);
      const want = await legacyBefore(id, anchor, 50);
      expect(ids(got.events), anchor).toEqual(ids(want.events));
      expect(got.hasMore, anchor).toBe(want.hasMore);
      // 内容也必须是重写后的（不是缓存 / 旧文件的）
      expect(got.events[0]!.text).toContain("重写后更长的内容");
    }
  });

  it("偏移仍是行首、但那一行已是别的事件（等长行 + 删掉开头几条）：id 校验必须拦下", async () => {
    // 行等长 → 删掉开头 K 条后，所有事件偏移整体前移恰好 K 行：缓存里的偏移依然落在「某一行的行首」，
    // 只是那一行现在装着别的事件。只有「行 id === 锚点 id」这道校验能识破。
    const id = newTaskId();
    const mkFixed = (i: number): TaskEvent => ({
      id: `ev_${String(i).padStart(4, "0")}`,
      ts: 1000 + i,
      kind: "info",
      text: "等长内容 ".repeat(6),
    });
    const all = Array.from({ length: 300 }, (_, i) => mkFixed(i));
    await writeRaw(id, all.map((e) => JSON.stringify(e)).join("\n") + "\n");

    await readEventsBefore(id, "ev_0250", 50); // 缓存 ev_0200 / ev_0250 的行首偏移

    const kept = all.slice(10); // 删掉最前 10 条（等长行 → 偏移整体前移 10 行）
    await writeRaw(id, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");

    for (const anchor of ["ev_0250", "ev_0200"]) {
      const got = await readEventsBefore(id, anchor, 50);
      const want = legacyFrom(kept, anchor, 50);
      expect(ids(got.events), anchor).toEqual(ids(want.events));
      expect(got.hasMore, anchor).toBe(want.hasMore);
    }
  });

  it("缓存的偏移落在某行中间：校验不是行首 → 退回扫描", async () => {
    const id = newTaskId();
    const evs = Array.from({ length: 200 }, (_, i) => mk(i, "内容 ".repeat(8)));
    await writeRaw(id, evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
    await readEventsBefore(id, "ev_150", 30); // 缓存 ev_120 的偏移

    // 在文件最前面插一个字节：之后所有偏移都错位 1 字节、落在行中间
    const cur = await fs.readFile(eventsPath(id), "utf-8");
    await fs.writeFile(eventsPath(id), "\n" + cur, "utf-8");

    const got = await readEventsBefore(id, "ev_120", 30);
    const want = await legacyBefore(id, "ev_120", 30);
    expect(ids(got.events)).toEqual(ids(want.events));
    expect(got.hasMore).toBe(want.hasMore);
  });

  it("文件被截断到锚点之前：缓存偏移越界 → 锚点不存在 → 空页（与全量读一致）", async () => {
    const id = newTaskId();
    const evs = Array.from({ length: 200 }, (_, i) => mk(i, "内容 ".repeat(8)));
    await writeRaw(id, evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
    await readEventsBefore(id, "ev_190", 30); // 缓存 ev_160 / ev_190

    await writeRaw(id, evs.slice(0, 50).map((e) => JSON.stringify(e)).join("\n") + "\n");

    const got = await readEventsBefore(id, "ev_160", 30);
    expect(got).toEqual({ events: [], hasMore: false });
  });

  it("不同任务的缓存互不串（同一个 eventId 在两个任务里偏移不同）", async () => {
    const a = newTaskId();
    const b = newTaskId();
    await writeRaw(a, Array.from({ length: 100 }, (_, i) => JSON.stringify(mk(i, "短"))).join("\n") + "\n");
    await writeRaw(b, Array.from({ length: 100 }, (_, i) => JSON.stringify(mk(i, "长内容 ".repeat(30)))).join("\n") + "\n");

    await readEventsBefore(a, "ev_90", 20); // 缓存 a 的 ev_70
    const got = await readEventsBefore(b, "ev_70", 20);
    const want = await legacyBefore(b, "ev_70", 20);
    expect(ids(got.events)).toEqual(ids(want.events));
  });
});

describe("边界", () => {
  it("limit=0 / 空 beforeId / 文件不存在 / 空文件 → 空页", async () => {
    const id = newTaskId();
    expect(await readEventsBefore(id, "ev_1", 10)).toEqual({ events: [], hasMore: false });
    await writeRaw(id, "");
    expect(await readEventsBefore(id, "ev_1", 10)).toEqual({ events: [], hasMore: false });
    await writeRaw(id, JSON.stringify(mk(0, "x")) + "\n");
    expect(await readEventsBefore(id, "ev_0", 0)).toEqual({ events: [], hasMore: false });
    expect(await readEventsBefore(id, "", 10)).toEqual({ events: [], hasMore: false });
  });

  it("锚点就是第一条 → 空页且 hasMore=false；单行无尾换行文件", async () => {
    const id = newTaskId();
    await writeRaw(id, JSON.stringify(mk(0, "唯一一条")));
    expect(await readEventsBefore(id, "ev_0", 10)).toEqual({ events: [], hasMore: false });
  });
});
