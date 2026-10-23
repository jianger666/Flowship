/**
 * 提问时间线的服务端扫盘（src/lib/server/events-outline.ts）：events.jsonl → 大纲，带增量缓存。
 *
 * 钉死：
 *   1. 只挑属主可见的 user_reply / action_start，顺序 = 磁盘顺序；预览口径与前端同一个 toOutlineItem；
 *   2. 增量：第二次只扫新追加的部分（缓存偏移前进、结果含新项）；不是整份重扫；
 *   3. 缓存只是提示、用前必验：整文件被替换（回退 = tmp + rename 新 inode / 内容变短）→ 从头扫，
 *      不会留着回退前的项；前缀被原地改写（inode 不变、长度不缩）→ 指纹对不上也从头扫；
 *   4. 半行（正在追加 / 崩溃残留）不处理、偏移停在它前面，补全换行后下一次才出现——不重复、不丢；
 *   5. 坏行 / 缺字段的行跳过、不抛；文件不存在 = 空大纲；
 *   6. 同一任务并发请求共用一次扫描；跨 1MB 块边界的长行不被切坏；
 *   7. 上限：返回最新的 OUTLINE_MAX_ITEMS 项、truncated=true。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-events-outline-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { getEventsLogPath, taskDir } = await import("@/lib/server/task-fs-core");
const {
  clearEventsOutlineCache,
  peekOutlineCacheItemCount,
  peekOutlineCacheOffset,
  readEventsOutline,
} = await import(
  "@/lib/server/events-outline"
);
const { OUTLINE_MAX_ITEMS } = await import("@/lib/stream-outline");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`events-outline DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

let seq = 0;
const ev = (kind: TaskEvent["kind"], text: string, meta?: Record<string, unknown>): TaskEvent => {
  seq += 1;
  return {
    id: `ev_${String(seq).padStart(6, "0")}`,
    ts: 1_700_000_000_000 + seq * 1000,
    seq,
    kind,
    text,
    ...(meta ? { meta } : {}),
  };
};
const line = (e: TaskEvent): string => `${JSON.stringify(e)}\n`;

let taskId = "";
const alloc = async (): Promise<string> => {
  taskId = `t_eo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await fs.mkdir(taskDir(taskId), { recursive: true });
  return taskId;
};
const write = (events: TaskEvent[]) =>
  fs.writeFile(getEventsLogPath(taskId), events.map(line).join(""), "utf8");
const append = (raw: string) => fs.appendFile(getEventsLogPath(taskId), raw, "utf8");

beforeEach(async () => {
  clearEventsOutlineCache();
  await alloc();
});
afterEach(async () => {
  await fs.rm(taskDir(taskId), { recursive: true, force: true }).catch(() => {});
});

describe("readEventsOutline：扫盘口径", () => {
  it("只挑 user_reply / action_start，保持磁盘顺序，预览与前端同口径", async () => {
    const u1 = ev("user_reply", "第一问");
    const act = ev("action_start", "开始 Plan（plan）n=2\n用户指令：先出方案");
    const u2 = ev("user_reply", "第二问\n换行");
    await write([
      ev("info", "boot"),
      u1,
      ev("thinking", "想"),
      ev("assistant_message", "答"),
      ev("tool_call", "shell", { name: "shell" }),
      act,
      ev("tool_result", "ok"),
      u2,
    ]);
    const out = await readEventsOutline(taskId);
    expect(out.truncated).toBe(false);
    expect(out.items.map((i) => [i.id, i.kind, i.text])).toEqual([
      [u1.id, "user_reply", "第一问"],
      [act.id, "action_start", "开始 Plan #2 · 先出方案"],
      [u2.id, "user_reply", "第二问 换行"],
    ]);
  });

  it("群里陌生人的提问 / 旁路 run 的事件 / 消音的：不进（与前端 isHiddenFromEventStream 同一个闸）", async () => {
    const mine = ev("user_reply", "我的问题");
    await write([
      ev("user_reply", "陌生人", { source: "feishu_group", restrictedRunTag: "r1" }),
      mine,
      ev("user_reply", "旁路", { groupRun: "g1" }),
      ev("user_reply", "消音", { muted: true }),
    ]);
    expect((await readEventsOutline(taskId)).items.map((i) => i.id)).toEqual([mine.id]);
  });

  it("定时触发项带 schedule 标记", async () => {
    await write([
      ev("user_reply", "[SCHEDULE_FIRED id=s1]\n样板", { source: "schedule", scheduleTitle: "看 CI" }),
    ]);
    const [it1] = (await readEventsOutline(taskId)).items;
    expect(it1!.schedule).toBe(true);
    expect(it1!.text).toBe("定时 · 看 CI");
  });

  it("文件不存在 / 空文件 = 空大纲", async () => {
    expect(await readEventsOutline(taskId)).toEqual({ items: [], truncated: false });
    await fs.writeFile(getEventsLogPath(taskId), "", "utf8");
    expect(await readEventsOutline(taskId)).toEqual({ items: [], truncated: false });
  });

  it("坏行 / 缺 id 或 ts 的行跳过、不抛；好行照常", async () => {
    const good = ev("user_reply", "好的");
    await append('{"kind":"user_reply","text":"缺 id 缺 ts"}\n');
    await append('{"kind":"user_reply", 这不是 json}\n');
    await append(`{"id":"x1","kind":"user_reply","text":"缺 ts"}\n`);
    await append(line(good));
    const out = await readEventsOutline(taskId);
    expect(out.items.map((i) => i.id)).toEqual([good.id]);
  });

  it("大行（模拟几 MB 的 tool_result）夹在中间不影响前后；跨 1MB 块边界的长提问不被切坏", async () => {
    const before = ev("user_reply", "前");
    const giant = ev("tool_result", "x".repeat(1024 * 1024 + 4321));
    const longAsk = ev("user_reply", `${"长".repeat(1024 * 1024 + 777)}尾`);
    const after = ev("user_reply", "后");
    await write([before, giant, longAsk, after]);
    const out = await readEventsOutline(taskId);
    expect(out.items.map((i) => i.id)).toEqual([before.id, longAsk.id, after.id]);
    // 长提问的预览是前缀 + 省略号（不是被块边界截断后的残片）
    expect(out.items[1]!.text.startsWith("长")).toBe(true);
    expect(out.items[1]!.text.endsWith("…")).toBe(true);
  });
});

describe("readEventsOutline：增量缓存", () => {
  it("第二次只扫新追加的部分：偏移前进到文件末、结果含新项、旧项不重复", async () => {
    const a = ev("user_reply", "a");
    await write([a, ev("assistant_message", "答")]);
    const first = await readEventsOutline(taskId);
    expect(first.items.map((i) => i.id)).toEqual([a.id]);
    const off1 = peekOutlineCacheOffset(taskId)!;
    expect(off1).toBe((await fs.stat(getEventsLogPath(taskId))).size);

    const b = ev("user_reply", "b");
    await append(line(ev("assistant_message", "又答")));
    await append(line(b));
    const second = await readEventsOutline(taskId);
    expect(second.items.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(peekOutlineCacheOffset(taskId)!).toBeGreaterThan(off1);
    expect(peekOutlineCacheOffset(taskId)!).toBe((await fs.stat(getEventsLogPath(taskId))).size);

    // 没有新内容：结果不变、偏移不变
    const third = await readEventsOutline(taskId);
    expect(third.items.map((i) => i.id)).toEqual([a.id, b.id]);
  });

  it("返回的是副本：调用方改它不污染缓存", async () => {
    await write([ev("user_reply", "a"), ev("user_reply", "b")]);
    const first = await readEventsOutline(taskId);
    first.items.length = 0;
    const again = await readEventsOutline(taskId);
    expect(again.items).toHaveLength(2);
  });

  it("整文件被替换（回退：tmp + rename、内容变短）→ 缓存作废、从头扫，回退前的项不残留", async () => {
    const a = ev("user_reply", "a");
    const b = ev("user_reply", "b");
    const c = ev("user_reply", "c");
    await write([a, b, c]);
    expect((await readEventsOutline(taskId)).items).toHaveLength(3);

    // 模拟 truncateEventsBeforeEventId：写 tmp 再 rename（新 inode、变短）
    const file = getEventsLogPath(taskId);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, line(a), "utf8");
    await fs.rename(tmp, file);
    const out = await readEventsOutline(taskId);
    expect(out.items.map((i) => i.id)).toEqual([a.id]);
  });

  it("回退之后又追加了和被删的一样长 / 更长的内容：新文件 inode 不同，照样从头扫", async () => {
    const a = ev("user_reply", "a");
    const b = ev("user_reply", "b");
    await write([a, b]);
    await readEventsOutline(taskId);
    const file = getEventsLogPath(taskId);
    const replacement = ev("user_reply", "替换后的，故意写得比原来都长一些以便长度不缩短");
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, line(replacement) + line(ev("user_reply", "尾巴")), "utf8");
    await fs.rename(tmp, file);
    const out = await readEventsOutline(taskId);
    expect(out.items.map((i) => i.text)).toEqual([
      "替换后的，故意写得比原来都长一些以便长度不缩短",
      "尾巴",
    ]);
  });

  it("inode 没变、长度也没缩，但已扫部分被原地改写（指纹对不上）→ 从头扫", async () => {
    const a = ev("user_reply", "原文 AAAA");
    const b = ev("user_reply", "b");
    await write([a, b]);
    await readEventsOutline(taskId);
    const file = getEventsLogPath(taskId);
    // 原地改写：id 与正文都换成同字节长度的另一份（open r+ 写，inode 不变、文件大小不变）
    const a2 = { ...a, id: "ev_REPLCD", text: "原文 BBBB" };
    expect(Buffer.byteLength(line(a2))).toBe(Buffer.byteLength(line(a)));
    const before = await fs.stat(file);
    const fh = await fs.open(file, "r+");
    try {
      await fh.write(line(a2) + line(b), 0);
    } finally {
      await fh.close();
    }
    const after = await fs.stat(file);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    const out = await readEventsOutline(taskId);
    expect(out.items.map((i) => i.id)).toEqual(["ev_REPLCD", b.id]);
  });

  it("任务删了（文件没了）→ 空大纲、缓存清掉", async () => {
    await write([ev("user_reply", "a")]);
    await readEventsOutline(taskId);
    expect(peekOutlineCacheOffset(taskId)).not.toBeNull();
    await fs.rm(getEventsLogPath(taskId));
    expect(await readEventsOutline(taskId)).toEqual({ items: [], truncated: false });
    expect(peekOutlineCacheOffset(taskId)).toBeNull();
  });
});

describe("readEventsOutline：半行与并发", () => {
  it("半行（没有换行结尾）不处理、偏移停在它前面；补全换行后下一次才出现，不重复不丢", async () => {
    const a = ev("user_reply", "a");
    await write([a]);
    const b = ev("user_reply", "b");
    const bRaw = line(b);
    const half = bRaw.slice(0, Math.floor(bRaw.length / 2));
    await append(half);
    const first = await readEventsOutline(taskId);
    expect(first.items.map((i) => i.id)).toEqual([a.id]);
    expect(peekOutlineCacheOffset(taskId)).toBe(Buffer.byteLength(line(a)));

    await append(bRaw.slice(half.length));
    const second = await readEventsOutline(taskId);
    expect(second.items.map((i) => i.id)).toEqual([a.id, b.id]);
    const third = await readEventsOutline(taskId);
    expect(third.items.map((i) => i.id)).toEqual([a.id, b.id]);
  });

  it("同一任务并发请求共用一次扫描（拿到的是同一份结果）", async () => {
    await write([ev("user_reply", "a"), ev("user_reply", "b")]);
    const p1 = readEventsOutline(taskId);
    const p2 = readEventsOutline(taskId);
    expect(p2).toBe(p1);
    expect((await p1).items).toHaveLength(2);
    // 结束后不再复用旧 promise（否则永远拿不到新内容）
    await append(line(ev("user_reply", "c")));
    expect((await readEventsOutline(taskId)).items).toHaveLength(3);
  });
});

describe("readEventsOutline：上限", () => {
  it(`超过 ${OUTLINE_MAX_ITEMS} 项：返回最新的那些、truncated=true`, async () => {
    const total = OUTLINE_MAX_ITEMS + 25;
    const events: TaskEvent[] = [];
    for (let i = 0; i < total; i += 1) events.push(ev("user_reply", `q${i}`));
    await write(events);
    const out = await readEventsOutline(taskId);
    expect(out.items).toHaveLength(OUTLINE_MAX_ITEMS);
    expect(out.truncated).toBe(true);
    expect(out.items[0]!.text).toBe("q25");
    expect(out.items[out.items.length - 1]!.text).toBe(`q${total - 1}`);
  });

  it("缓存内存有界：只多留 1 项（够判断 truncated），增量追加后仍有界、窗口随最新滑动", async () => {
    const total = OUTLINE_MAX_ITEMS + 25;
    const events: TaskEvent[] = [];
    for (let i = 0; i < total; i += 1) events.push(ev("user_reply", `q${i}`));
    await write(events);
    await readEventsOutline(taskId);
    expect(peekOutlineCacheItemCount(taskId)).toBe(OUTLINE_MAX_ITEMS + 1);

    // 增量追加 3 条：缓存仍是 MAX+1、返回的窗口前移 3 项、最新项在末尾
    await append(line(ev("user_reply", "n1")) + line(ev("user_reply", "n2")) + line(ev("user_reply", "n3")));
    const out = await readEventsOutline(taskId);
    expect(peekOutlineCacheItemCount(taskId)).toBe(OUTLINE_MAX_ITEMS + 1);
    expect(out.items).toHaveLength(OUTLINE_MAX_ITEMS);
    expect(out.truncated).toBe(true);
    expect(out.items[0]!.text).toBe("q28");
    expect(out.items[out.items.length - 1]!.text).toBe("n3");
  });

  it("恰好 MAX 项：不算截断（缓存多留的那 1 项只在真的超过时才出现）", async () => {
    const events: TaskEvent[] = [];
    for (let i = 0; i < OUTLINE_MAX_ITEMS; i += 1) events.push(ev("user_reply", `q${i}`));
    await write(events);
    const out = await readEventsOutline(taskId);
    expect(out.items).toHaveLength(OUTLINE_MAX_ITEMS);
    expect(out.truncated).toBe(false);
    expect(out.items[0]!.text).toBe("q0");
  });
});
