/**
 * events.jsonl 的坏行不再静默（Q9-08）——读路径
 *
 * 之前的缺陷：读 events.jsonl 时，「非空但解析不了」的行（崩溃半行 / 断电后的全 0 填充 / 磁盘问题）被悄悄跳过——
 * 用户只看到对话少了一截，不知道为什么，日志里也没有任何线索。
 *
 * 现在：读到坏行 → 计数 + 记第一处的字节偏移与长度 → 每进程每任务 warn 一次（不带行内容）；
 * `readEventsWithStats` / `readEventsTail` 把统计带回给调用方，hydrate 再放进 `Task.eventsSkipped`（见 watch-task-events-skipped.test.ts）。
 *
 * 钉死：
 *   A. 分类：事件 / 空白行 / 坏行；中间坏行计数与偏移按**字节**；一大段 NUL 只算 1 条；空行、纯空白行、CRLF 不算坏行；
 *      事件列表与旧解析口径逐条一致（参考实现差分）
 *   B. 文件尾**没有换行结尾**的最后一段不能算坏行（append 正在写一行时读者会瞬时读到半行——误报风险）：
 *      尾半行不计；完整但缺换行的尾行是事件；含 NUL 的尾段（断电后全 0 填充）才计；分两次写完一个大行时中途读不误报；
 *      崩溃遗留的尾半行在下一次 append 被补 `\n` 隔离后变成中间坏行、这时才计
 *   C. readEventsTail：窗口内计数 + 偏移、坏行跨 64KB 块边界只计 1 条且偏移精确、窗口外（没读到）的不计、干净文件不带字段
 *   D. readEventsBefore：只数锚点之前（这页 / 更早）读到的坏行；锚点之后的不计；缓存命中路径同样会数
 *   E. warn：同任务多次读只 warn 1 次（含全量 / 尾部 / 翻页混合）、文本不含坏行内容与数据目录、不同任务各一次、重置后再 warn
 *   F. readEventsWithOffsets：每条有效事件的行首字节偏移 + 整份原始字节
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-events-bad-lines-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const {
  EVENTS_FILE,
  __resetSkippedEventLinesWarnedForTests,
  appendEventLine,
  newEventId,
  readEvents,
  readEventsBefore,
  readEventsTail,
  readEventsWithOffsets,
  readEventsWithStats,
  taskDir,
} = await import("@/lib/server/task-fs-core");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`events-bad-lines DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const ids: string[] = [];
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  __resetSkippedEventLinesWarnedForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of ids.splice(0)) {
    await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  }
});

const mkEv = (kind: TaskEvent["kind"], text: string): TaskEvent => ({
  id: newEventId(),
  ts: Date.now(),
  kind,
  text,
});

const alloc = async (): Promise<string> => {
  const id = `t_ebl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

const eventsPath = (id: string): string => path.join(taskDir(id), EVENTS_FILE);

/** 一条事件的整行字节（带换行） */
const evBytes = (ev: TaskEvent): Buffer =>
  Buffer.from(JSON.stringify(ev) + "\n", "utf-8");

type Part = Buffer | string;
const toBuf = (p: Part): Buffer =>
  typeof p === "string" ? Buffer.from(p, "utf-8") : p;

/** 把若干片段原样拼成 events.jsonl 的内容写盘，返回写入的字节 */
const put = async (id: string, ...parts: Part[]): Promise<Buffer> => {
  const body = Buffer.concat(parts.map(toBuf));
  await fs.writeFile(eventsPath(id), body);
  return body;
};

const len = (...parts: Part[]): number =>
  parts.reduce((n, p) => n + toBuf(p).length, 0);

const idsOf = (evs: TaskEvent[]): string[] => evs.map((e) => e.id);

/** 本进程 warn 里「events.jsonl 有 N 条记录无法解析」那一类（别的 warn 不算） */
const skippedWarns = (): string[] =>
  warn.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((m) => m.includes("events.jsonl 有"));

describe("A. 分类与统计（readEventsWithStats）", () => {
  it("干净文件：没有坏行 → skipped=null、不 warn", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "a");
    const e2 = mkEv("assistant_message", "b");
    await put(id, evBytes(e1), evBytes(e2));

    const r = await readEventsWithStats(id);
    expect(idsOf(r.events)).toEqual([e1.id, e2.id]);
    expect(r.skipped).toBeNull();
    expect(skippedWarns()).toHaveLength(0);
  });

  it("中间一条半截 JSON：事件少一条、计 1 条；偏移与长度按字节（不是字符数）", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "a");
    const e2 = mkEv("info", "b");
    const bad = Buffer.from('{"id":"x","kind":"info","text":"中文半行', "utf-8");
    // 夹具自检：字节数 ≠ 字符数，下面的偏移断言才真的在区分「按字节」还是「按字符」
    expect(bad.length).toBeGreaterThan(bad.toString("utf-8").length);
    await put(id, evBytes(e1), bad, "\n", evBytes(e2));

    const r = await readEventsWithStats(id);
    expect(idsOf(r.events)).toEqual([e1.id, e2.id]);
    expect(r.skipped).toEqual({
      count: 1,
      firstOffset: len(evBytes(e1)),
      firstLength: bad.length,
    });
  });

  it("5000 个 NUL 夹在两个事件之间（断电后的全 0 填充）：只算 1 条", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "a");
    const e2 = mkEv("info", "b");
    await put(id, evBytes(e1), Buffer.alloc(5000), "\n", evBytes(e2));

    const r = await readEventsWithStats(id);
    expect(idsOf(r.events)).toEqual([e1.id, e2.id]);
    expect(r.skipped).toEqual({
      count: 1,
      firstOffset: len(evBytes(e1)),
      firstLength: 5000,
    });
  });

  it("多处坏行：count 累加；first 是最靠文件头的那处", async () => {
    const id = await alloc();
    const [e1, e2, e3] = [mkEv("info", "1"), mkEv("info", "2"), mkEv("info", "3")];
    await put(
      id,
      evBytes(e1),
      "{bad-1\n",
      evBytes(e2),
      "{bad-2\n",
      "{bad-3\n",
      evBytes(e3),
    );

    const r = await readEventsWithStats(id);
    expect(idsOf(r.events)).toEqual([e1.id, e2.id, e3.id]);
    expect(r.skipped).toEqual({
      count: 3,
      firstOffset: len(evBytes(e1)),
      firstLength: len("{bad-1"),
    });
  });

  it("空行 / 纯空白行 / CRLF 行不算坏行；CRLF 行照常解析", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "1");
    const e2 = mkEv("info", "2");
    await put(
      id,
      evBytes(e1),
      "\n",
      "   \t \n",
      JSON.stringify(e2) + "\r\n",
      "\n",
    );

    const r = await readEventsWithStats(id);
    expect(idsOf(r.events)).toEqual([e1.id, e2.id]);
    expect(r.skipped).toBeNull();
    expect(skippedWarns()).toHaveLength(0);
  });

  it("合法 JSON 但不是对象（null / 数字 / 字符串 / 布尔 / 数组）：算坏行、不进事件列表（全量读与尾部读一致）", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "1");
    const e2 = mkEv("info", "2");
    const notObjects = ["null", "0", "false", '""', "123", '"str"', "true", "[]", "[1]", '[{"id":"x"}]'];
    await put(id, evBytes(e1), ...notObjects.map((s) => s + "\n"), evBytes(e2));

    const r = await readEventsWithStats(id);
    expect(idsOf(r.events)).toEqual([e1.id, e2.id]);
    expect(r.skipped?.count).toBe(notObjects.length);
    const tail = await readEventsTail(id, 50);
    expect(idsOf(tail.events)).toEqual([e1.id, e2.id]);
    expect(tail.skipped?.count).toBe(notObjects.length);
  });

  it("非 UTF-8 字节的坏行：算 1 条，不影响前后事件", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "1");
    const e2 = mkEv("info", "2");
    const bad = Buffer.from([0x7b, 0xff, 0xfe, 0xc3, 0x28, 0x80]);
    await put(id, evBytes(e1), bad, "\n", evBytes(e2));

    const r = await readEventsWithStats(id);
    expect(idsOf(r.events)).toEqual([e1.id, e2.id]);
    expect(r.skipped).toEqual({
      count: 1,
      firstOffset: len(evBytes(e1)),
      firstLength: bad.length,
    });
  });

  it("坏行是文件第一行：偏移是 0（全量 / 尾部 / 翻页三条路径一致，翻页看 warn 里的偏移）", async () => {
    const id = await alloc();
    const [e1, e2] = [mkEv("info", "1"), mkEv("info", "2")];
    await put(id, "{bad-first\n", evBytes(e1), evBytes(e2));
    const expected = { count: 1, firstOffset: 0, firstLength: len("{bad-first") };

    expect((await readEventsWithStats(id)).skipped).toEqual(expected);
    expect((await readEventsTail(id, 10)).skipped).toEqual(expected);

    __resetSkippedEventLinesWarnedForTests();
    warn.mockClear();
    const page = await readEventsBefore(id, e2.id, 10);
    expect(idsOf(page.events)).toEqual([e1.id]);
    const w = skippedWarns();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("字节偏移 0、长 10 字节");
  });

  it("readEvents 与 readEventsWithStats 给出同一份事件", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "1");
    const e2 = mkEv("info", "2");
    await put(id, evBytes(e1), "{bad\n", evBytes(e2));
    expect(idsOf(await readEvents(id))).toEqual(
      idsOf((await readEventsWithStats(id)).events),
    );
  });

  it("事件列表与旧解析口径逐条一致（参考实现差分，随机混合文件）", async () => {
    // 旧实现（改前）：整份按 utf-8 读 → split(/\r?\n/) → trim → JSON.parse，失败 / 空行跳过
    const legacy = (raw: string): string[] =>
      raw
        .split(/\r?\n/)
        .map((line) => {
          const t = line.trim();
          if (!t) return null;
          try {
            return JSON.parse(t) as { id: string } | null;
          } catch {
            return null;
          }
        })
        .filter((x): x is { id: string } => !!x)
        .map((x) => x.id);

    // 确定性伪随机（LCG），失败时可复现
    let seed = 20261024;
    const rnd = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const garbage = (): Buffer => {
      switch (rnd(5)) {
        case 0:
          return Buffer.from('{"id":"half","ts":1,"ki');
        case 1:
          return Buffer.alloc(1 + rnd(300));
        case 2:
          return Buffer.from([0x7b, 0xff, 0xfe, 0x80, 0x0d]);
        case 3:
          return Buffer.from("   ");
        default:
          return Buffer.from("{{{");
      }
    };

    for (let round = 0; round < 40; round++) {
      const id = await alloc();
      const parts: Buffer[] = [];
      const n = 1 + rnd(30);
      for (let i = 0; i < n; i++) {
        const kind = rnd(4);
        if (kind === 0) parts.push(Buffer.from("\n"));
        else if (kind === 1) {
          parts.push(Buffer.concat([garbage(), Buffer.from("\n")]));
        } else if (kind === 2) {
          const ev = mkEv("info", `r${round}-${i}`);
          parts.push(Buffer.from(JSON.stringify(ev) + "\r\n"));
        } else {
          parts.push(evBytes(mkEv("assistant_message", `r${round}-${i}`)));
        }
      }
      // 文件尾：一半的文件以换行结尾，另一半留一个没结束的尾段（半行 / 完整 JSON 缺换行）
      if (rnd(2) === 0) {
        parts.push(
          rnd(2) === 0
            ? Buffer.from('{"id":"tail","ts":1,')
            : Buffer.from(JSON.stringify(mkEv("info", `tail-${round}`))),
        );
      }
      const body = await put(id, ...parts);
      const expected = legacy(body.toString("utf-8"));
      const got = idsOf((await readEventsWithStats(id)).events);
      expect(got, `round ${round}`).toEqual(expected);
      expect(idsOf((await readEventsTail(id, 1000)).events), `tail round ${round}`).toEqual(
        expected,
      );
    }
  });
});

describe("B. 文件尾没有换行的最后一段（别把「正在写的行」当坏行）", () => {
  const HALF = '{"id":"evt_half","ts":1,"ki';

  it("尾段是合法 JSON 的前缀（append 写到一半）：三个读函数都不计、事件不含它", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "a");
    await put(id, evBytes(e1), HALF);

    const stats = await readEventsWithStats(id);
    expect(idsOf(stats.events)).toEqual([e1.id]);
    expect(stats.skipped).toBeNull();

    const tail = await readEventsTail(id, 10);
    expect(idsOf(tail.events)).toEqual([e1.id]);
    expect(tail.skipped).toBeUndefined();

    const withOffsets = await readEventsWithOffsets(id);
    expect(idsOf(withOffsets.events)).toEqual([e1.id]);

    expect(skippedWarns()).toHaveLength(0);
  });

  it("文件以空行开头、以半行结尾：尾半行照样不计（判「有没有结束」看的是文件最后一个字节，不是第一个）", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "a");
    await put(id, "\n", evBytes(e1), HALF);

    const stats = await readEventsWithStats(id);
    expect(idsOf(stats.events)).toEqual([e1.id]);
    expect(stats.skipped).toBeNull();
    const tail = await readEventsTail(id, 10);
    expect(idsOf(tail.events)).toEqual([e1.id]);
    expect(tail.skipped).toBeUndefined();
    expect(skippedWarns()).toHaveLength(0);
  });

  it("尾半行前面还有一条真坏行：尾半行不计、前面那条照常计 1（尾段规则只管文件最后一段）", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "a");
    const e2 = mkEv("info", "b");
    const BAD = '{"id":"evt_bad","ts":1,"kind":"info","text":"half\n'; // 有结束的坏行（带换行）
    await put(id, evBytes(e1), BAD, evBytes(e2), HALF);
    const expected = { count: 1, firstOffset: len(evBytes(e1)), firstLength: len(BAD) - 1 };

    const stats = await readEventsWithStats(id);
    expect(idsOf(stats.events)).toEqual([e1.id, e2.id]);
    expect(stats.skipped).toEqual(expected);
    const tail = await readEventsTail(id, 10);
    expect(idsOf(tail.events)).toEqual([e1.id, e2.id]);
    expect(tail.skipped).toEqual(expected);
  });

  it("尾段是完整的 JSON 只是缺换行：照旧当事件读到，不计", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "a");
    const e2 = mkEv("info", "b");
    await put(id, evBytes(e1), JSON.stringify(e2));

    const stats = await readEventsWithStats(id);
    expect(idsOf(stats.events)).toEqual([e1.id, e2.id]);
    expect(stats.skipped).toBeNull();
    const tail = await readEventsTail(id, 10);
    expect(idsOf(tail.events)).toEqual([e1.id, e2.id]);
    expect(tail.skipped).toBeUndefined();
    expect(skippedWarns()).toHaveLength(0);
  });

  it("尾段含 NUL（断电后文件长度已更新、数据块全 0）：不可能是正在写的行，计 1 条（三个读函数一致）", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "a");
    await put(id, evBytes(e1), Buffer.alloc(300));
    const expected = { count: 1, firstOffset: len(evBytes(e1)), firstLength: 300 };

    expect((await readEventsWithStats(id)).skipped).toEqual(expected);
    expect((await readEventsTail(id, 10)).skipped).toEqual(expected);
    // 偏移版：同样计一次 → 同进程已 warn 过，所以这里不再断言 warn；只看它不抛、事件对
    expect(idsOf((await readEventsWithOffsets(id)).events)).toEqual([e1.id]);
  });

  it("append 分两次写完一个 ~20KB 的大行：中途读不误报，写完后读到完整事件", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "a");
    const big = mkEv("assistant_message", "x".repeat(20_000));
    const json = JSON.stringify(big);
    await put(id, evBytes(e1));

    // 只写了前 9000 字节、还没有换行 = append 进行中
    await fs.appendFile(eventsPath(id), json.slice(0, 9000));
    const midStats = await readEventsWithStats(id);
    expect(idsOf(midStats.events)).toEqual([e1.id]);
    expect(midStats.skipped).toBeNull();
    const midTail = await readEventsTail(id, 10);
    expect(idsOf(midTail.events)).toEqual([e1.id]);
    expect(midTail.skipped).toBeUndefined();
    expect(skippedWarns()).toHaveLength(0);

    await fs.appendFile(eventsPath(id), json.slice(9000) + "\n");
    const done = await readEventsWithStats(id);
    expect(idsOf(done.events)).toEqual([e1.id, big.id]);
    expect(done.skipped).toBeNull();
    expect(skippedWarns()).toHaveLength(0);
  });

  it("崩溃遗留的尾半行：下一次 appendEventLine 补 \\n 把它隔离成中间坏行，这时才计 1 条", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "a");
    const e2 = mkEv("info", "b");
    await put(id, evBytes(e1), HALF);
    expect((await readEventsWithStats(id)).skipped).toBeNull(); // 隔离之前：不计

    await appendEventLine(id, e2); // 本进程首次写该任务：核对末字节、补换行

    const after = await readEventsWithStats(id);
    expect(idsOf(after.events)).toEqual([e1.id, e2.id]);
    expect(after.skipped).toEqual({
      count: 1,
      firstOffset: len(evBytes(e1)),
      firstLength: len(HALF),
    });
  });
});

describe("C. readEventsTail", () => {
  it("窗口内的坏行：带回 skipped（计数 + 偏移）；events 与全量读的末尾一致", async () => {
    const id = await alloc();
    const [e1, e2, e3] = [mkEv("info", "1"), mkEv("info", "2"), mkEv("info", "3")];
    await put(id, evBytes(e1), "{bad\n", evBytes(e2), evBytes(e3));

    const r = await readEventsTail(id, 10);
    expect(idsOf(r.events)).toEqual([e1.id, e2.id, e3.id]);
    expect(r.hasMore).toBe(false);
    expect(r.skipped).toEqual({
      count: 1,
      firstOffset: len(evBytes(e1)),
      firstLength: len("{bad"),
    });
  });

  it("坏行跨 64KB 块边界：只计 1 条，行首偏移精确（carry 拼接没有把它算成两半）", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "head");
    const head = evBytes(e1);
    const bad = Buffer.alloc(20_000, 0x78); // 20000 个 'x'：不是 JSON、中间没有换行
    const suffix: Buffer[] = [];
    let suffixBytes = 0;
    while (suffixBytes < 55_000) {
      const b = evBytes(mkEv("assistant_message", "s".repeat(100)));
      suffix.push(b);
      suffixBytes += b.length;
    }
    await put(id, head, bad, "\n", ...suffix);

    // 夹具自检：尾部读的第一块从 size-64KB 起，那个位置要落在坏行**内部**，否则这条用例没在测跨块
    const size = head.length + bad.length + 1 + suffixBytes;
    const boundary = size - 64 * 1024;
    expect(boundary).toBeGreaterThan(head.length);
    expect(boundary).toBeLessThan(head.length + bad.length);

    const r = await readEventsTail(id, 1000); // 总事件数 < 1000 → 一直读到文件头
    expect(r.events).toHaveLength(1 + suffix.length);
    expect(r.skipped).toEqual({
      count: 1,
      firstOffset: head.length,
      firstLength: bad.length,
    });
  });

  it("窗口外（尾部读取没读到的更早部分）的坏行不计", async () => {
    const id = await alloc();
    const bad = Buffer.from("{bad-far-away");
    const evs: Buffer[] = [];
    let bytes = 0;
    while (bytes < 70_000) {
      const b = evBytes(mkEv("assistant_message", "s".repeat(100)));
      evs.push(b);
      bytes += b.length;
    }
    await put(id, bad, "\n", ...evs);
    // 夹具自检：文件比一个读块 + 坏行大，坏行在第一块之外
    expect(bad.length + 1 + bytes).toBeGreaterThan(64 * 1024 + bad.length + 1);

    const r = await readEventsTail(id, 5);
    expect(r.events).toHaveLength(5);
    expect(r.hasMore).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(skippedWarns()).toHaveLength(0);
  });

  it("干净的文件：返回值里没有 skipped 字段", async () => {
    const id = await alloc();
    await put(id, evBytes(mkEv("info", "1")), evBytes(mkEv("info", "2")));
    const r = await readEventsTail(id, 10);
    expect(r).not.toHaveProperty("skipped");
  });

  it("原始条数封顶（50,000）提前停止：封顶之外更早的坏行不计；封顶之内的照计", async () => {
    // 5 万多条相邻的 thinking 会被合并成 1 条逻辑事件：带一个永不命中的锚点，读取会一路往前读、直到原始条数封顶才停
    const thinking = (i: number): string =>
      JSON.stringify({ id: `evt_th${i}`, ts: 1, kind: "thinking", text: "x" }) + "\n";
    const body = (head: string, count: number, badAt: number | null): string => {
      const out: string[] = [head];
      for (let i = 0; i < count; i++) {
        if (i === badAt) out.push("{broken-inside\n");
        out.push(thinking(i));
      }
      return out.join("");
    };
    const tail = (id: string) => readEventsTail(id, 5, { anchor: () => false });

    // 坏行在文件最前面、离封顶边界很远（封顶窗口之外、没读到）：不计；hasMore 说明前面还有
    const far = await alloc();
    await put(far, body("{broken-far\n", 50_010, null));
    const r1 = await tail(far);
    expect(r1.hasMore).toBe(true);
    expect(r1.skipped).toBeUndefined();

    // 坏行紧挨着封顶边界（刚好封顶在最早那条 thinking 上，坏行与它在同一个块里、只差一行）：
    // 封顶时这一块里余下的（更早的）行也不再看，所以不计
    const edge = await alloc();
    await put(edge, body("{broken-edge\n", 50_000, null));
    const r2 = await tail(edge);
    expect(r2.hasMore).toBe(true);
    expect(r2.skipped).toBeUndefined();

    // 坏行靠近文件尾（封顶窗口之内）：照计 1
    const near = await alloc();
    await put(near, body("", 50_010, 50_000));
    const r3 = await tail(near);
    expect(r3.skipped?.count).toBe(1);
  });

  it("空文件 / 不存在的文件：照旧返回空、不抛", async () => {
    const id = await alloc();
    expect(await readEventsTail(id, 10)).toEqual({ events: [], hasMore: false });
    await put(id);
    expect(await readEventsTail(id, 10)).toEqual({ events: [], hasMore: false });
  });
});

describe("D. readEventsBefore（翻页）", () => {
  it("只数锚点之前（这页 / 更早）的坏行；锚点之后的坏行不计", async () => {
    const id = await alloc();
    const [e1, e2, e3, e4] = [
      mkEv("info", "1"),
      mkEv("info", "2"),
      mkEv("info", "3"),
      mkEv("info", "4"),
    ];
    await put(
      id,
      evBytes(e1),
      "{bad-before\n",
      evBytes(e2),
      evBytes(e3),
      "{bad-after\n",
      evBytes(e4),
    );

    const page = await readEventsBefore(id, e3.id, 10);
    expect(idsOf(page.events)).toEqual([e1.id, e2.id]);
    expect(page.hasMore).toBe(false);

    const w = skippedWarns();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("有 1 条"); // 只有锚点之前的那一条
    expect(w[0]).toContain(`字节偏移 ${len(evBytes(e1))}`);
  });

  it("锚点之后只有坏行：翻页不 warn", async () => {
    const id = await alloc();
    const [e1, e2] = [mkEv("info", "1"), mkEv("info", "2")];
    await put(id, evBytes(e1), evBytes(e2), "{bad-after\n");

    const page = await readEventsBefore(id, e2.id, 10);
    expect(idsOf(page.events)).toEqual([e1.id]);
    expect(skippedWarns()).toHaveLength(0);
  });

  it("连续翻页（第二页走锚点偏移缓存）：只数读到的范围——第一页没碰到的坏行，第二页才数到", async () => {
    const id = await alloc();
    const [e1, e2, e3, e4] = [
      mkEv("info", "1"),
      mkEv("info", "2"),
      mkEv("info", "3"),
      mkEv("info", "4"),
    ];
    await put(id, evBytes(e1), "{bad-A\n", evBytes(e2), evBytes(e3), evBytes(e4));

    const p1 = await readEventsBefore(id, e4.id, 1);
    expect(idsOf(p1.events)).toEqual([e3.id]);
    expect(skippedWarns()).toHaveLength(0); // 第一页只读到 e3、e2：坏行在更早处，没数到

    const p2 = await readEventsBefore(id, e3.id, 1); // 锚点偏移来自上一页的缓存
    expect(idsOf(p2.events)).toEqual([e2.id]);
    const w = skippedWarns();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("有 1 条");
  });
});

describe("E. warn：每进程每任务一次，不含内容", () => {
  it("同一任务读很多次（全量 / 尾部 / 翻页 / 带偏移混着）只 warn 1 次", async () => {
    const id = await alloc();
    const [e1, e2, e3] = [mkEv("info", "1"), mkEv("info", "2"), mkEv("info", "3")];
    await put(id, evBytes(e1), "{bad\n", evBytes(e2), evBytes(e3));

    await readEvents(id);
    await readEvents(id);
    await readEventsWithStats(id);
    await readEventsTail(id, 10);
    await readEventsTail(id, 10);
    await readEventsBefore(id, e3.id, 10);
    await readEventsWithOffsets(id);
    expect(skippedWarns()).toHaveLength(1);
  });

  // 每条读路径各自都要上报：上面「混着读只 warn 1 次」只数总数，某一条路径漏了上报时会被别的路径顶替而漏过
  const readers: Record<string, (id: string, anchorId: string) => Promise<unknown>> = {
    readEvents: (id) => readEvents(id),
    readEventsWithStats: (id) => readEventsWithStats(id),
    readEventsTail: (id) => readEventsTail(id, 10),
    readEventsBefore: (id, anchorId) => readEventsBefore(id, anchorId, 10),
    readEventsWithOffsets: (id) => readEventsWithOffsets(id),
  };
  it.each(Object.keys(readers))("%s：只经这一条路径读，也会上报坏行（warn 1 次）", async (name) => {
    const id = await alloc();
    const [e1, e2] = [mkEv("info", "1"), mkEv("info", "2")];
    await put(id, evBytes(e1), "{bad\n", evBytes(e2));
    await readers[name]!(id, e2.id);
    expect(skippedWarns()).toHaveLength(1);
  });

  it("warn 文本：含任务 id / 条数 / 字节偏移与长度；不含坏行内容、不含数据目录", async () => {
    const SECRET = "sk-LEAK-0123456789abcdef";
    const id = await alloc();
    const e1 = mkEv("info", "1");
    const e2 = mkEv("info", "2");
    const bad = Buffer.from(`{"id":"x","text":"${SECRET}`);
    await put(id, evBytes(e1), bad, "\n", evBytes(e2));

    await readEvents(id);

    const w = skippedWarns();
    expect(w).toHaveLength(1);
    const msg = w[0]!;
    expect(msg).toContain(id);
    expect(msg).toContain("有 1 条");
    expect(msg).toContain(`字节偏移 ${len(evBytes(e1))}`);
    expect(msg).toContain(`长 ${bad.length} 字节`);
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain("LEAK"); // 坏行里除了凭据样的前缀、连半截内容都不该出现
    expect(msg).not.toContain('"text"');
    expect(msg).not.toContain(TMP_ROOT);
  });

  it("不同任务各 warn 一次", async () => {
    const a = await alloc();
    const b = await alloc();
    for (const id of [a, b]) {
      await put(id, evBytes(mkEv("info", "1")), "{bad\n");
    }
    await readEvents(a);
    await readEvents(b);
    await readEvents(a);
    const w = skippedWarns();
    expect(w).toHaveLength(2);
    expect(w.some((m) => m.includes(a))).toBe(true);
    expect(w.some((m) => m.includes(b))).toBe(true);
  });

  it("重置「已 warn」记录后会再 warn（测试隔离用的钩子）", async () => {
    const id = await alloc();
    await put(id, evBytes(mkEv("info", "1")), "{bad\n");
    await readEvents(id);
    expect(skippedWarns()).toHaveLength(1);
    __resetSkippedEventLinesWarnedForTests();
    await readEvents(id);
    expect(skippedWarns()).toHaveLength(2);
  });

  it("「已 warn 的任务」集合涨到上限（2000）后清空重来：不崩、新任务照样 warn 一次、集合从头计", async () => {
    const SET_KEY = "__flowshipSkippedEventLinesWarnedV1__";
    const g = globalThis as unknown as Record<string, Set<string> | undefined>;
    // 集合挂在 globalThis 上：直接预灌到上限，比真造 2000 个坏任务快得多，也更确定
    g[SET_KEY] = new Set(Array.from({ length: 2000 }, (_, i) => `t_fake_${i}`));

    const a = await alloc();
    await put(a, evBytes(mkEv("info", "x")), "{broken\n");
    await readEventsWithStats(a);
    expect(skippedWarns()).toHaveLength(1);
    expect(g[SET_KEY]!.size).toBe(1); // 溢出 → 清空后只剩刚加进去的这一个
    expect(g[SET_KEY]!.has(a)).toBe(true);

    // 清空之后照常去重：第二个坏任务 warn 一次（累计 2），同一个任务再读不再 warn
    const b = await alloc();
    await put(b, evBytes(mkEv("info", "y")), "{broken\n");
    await readEventsWithStats(b);
    await readEventsWithStats(b);
    expect(skippedWarns()).toHaveLength(2);
    expect(g[SET_KEY]!.size).toBe(2);
  });

  it("干净文件不 warn", async () => {
    const id = await alloc();
    await put(id, evBytes(mkEv("info", "1")), evBytes(mkEv("info", "2")));
    await readEvents(id);
    await readEventsTail(id, 10);
    expect(skippedWarns()).toHaveLength(0);
  });
});

describe("F. readEventsWithOffsets", () => {
  it("offsets[i] 是第 i 条有效事件的行首字节偏移；raw 是整份原始字节（含坏行 / 空行）", async () => {
    const id = await alloc();
    const [e1, e2, e3] = [mkEv("info", "1"), mkEv("info", "2"), mkEv("info", "3")];
    const body = await put(id, evBytes(e1), "{bad\n", "\n", evBytes(e2), evBytes(e3));

    const r = await readEventsWithOffsets(id);
    expect(idsOf(r.events)).toEqual([e1.id, e2.id, e3.id]);
    const o2 = len(evBytes(e1)) + len("{bad\n") + len("\n");
    expect(r.offsets).toEqual([0, o2, o2 + len(evBytes(e2))]);
    expect(r.raw.equals(body)).toBe(true);
    // 偏移指向的确是各自那一行的行首
    for (let i = 0; i < r.events.length; i++) {
      const start = r.offsets[i]!;
      const end = r.raw.indexOf(0x0a, start);
      expect((JSON.parse(r.raw.subarray(start, end).toString("utf-8")) as TaskEvent).id).toBe(
        r.events[i]!.id,
      );
    }
  });

  it("文件不存在 → 事件 / 偏移 / 原始字节都是空", async () => {
    const id = await alloc();
    const r = await readEventsWithOffsets(id);
    expect(r.events).toEqual([]);
    expect(r.offsets).toEqual([]);
    expect(r.raw.length).toBe(0);
  });
});
