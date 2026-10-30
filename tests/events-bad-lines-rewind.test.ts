/**
 * 回退重写 events.jsonl 保留原文（Q9-08）
 *
 * 之前的缺陷：`truncateEventsBeforeEventId` 是「解析 → slice → 重新序列化」——保留段里读不出来的坏行
 * （崩溃半行 / 全 0 填充 / 非 UTF-8 字节）在这一步被永久抹掉，而用户只是想「回退一下」；
 * `restoreEventsRawText`（后置失败时把 events 写回截断前的原文）又是按字符串比较 / 写回，非 UTF-8 字节会被改写成 U+FFFD。
 *
 * 现在：目标行行首之前的字节**原样**保留（含坏行 / 空行 / CRLF），备份与写回都按字节。
 *
 * 钉死：
 *   A. 坏行在保留段 → 逐字节还在；坏行在被截掉的段 → 随之消失（这是合理的）；
 *      目标之前只有坏行时文件**不是空的**（旧实现会写空文件）；正常文件与旧实现的输出逐字节相同；
 *      目标不存在 → null、文件不动；返回的 kept / truncatedCount 只数有效事件
 *   B. restoreEventsRawText：Buffer 备份逐字节写回（含非 UTF-8 / NUL）；文件只被追加过则不动；string 备份兼容
 *   C. 截断 → 补偿还原的往返：文件与截断前逐字节相同
 *   D. 截断之后：保留的坏行仍被统计、后续 append 照常接在后面
 *
 * 完整的 rewind 主流程（git 仓回滚 / rewind_points / meta）由既有的 chat-checkpoint / rewind 系列用例覆盖。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，必须先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-events-bad-rewind-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { restoreEventsRawText, truncateEventsBeforeEventId } = await import(
  "@/lib/server/chat-checkpoint"
);
const {
  EVENTS_FILE,
  __resetSkippedEventLinesWarnedForTests,
  appendEventLine,
  newEventId,
  readEventsWithStats,
  taskDir,
} = await import("@/lib/server/task-fs-core");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`events-bad-lines-rewind DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const ids: string[] = [];
beforeEach(() => {
  __resetSkippedEventLinesWarnedForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
  const id = `t_ebr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

const eventsPath = (id: string): string => path.join(taskDir(id), EVENTS_FILE);
const read = (id: string): Buffer => readFileSync(eventsPath(id));

const evBytes = (ev: TaskEvent): Buffer =>
  Buffer.from(JSON.stringify(ev) + "\n", "utf-8");

type Part = Buffer | string;
const cat = (...parts: Part[]): Buffer =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf-8") : p)));

const put = async (id: string, ...parts: Part[]): Promise<Buffer> => {
  const body = cat(...parts);
  await fs.writeFile(eventsPath(id), body);
  return body;
};

/** 一条「读不出来」的坏行：半截 JSON + 非 UTF-8 字节 + NUL（不含换行） */
const BAD = cat('{"id":"x","text":"', Buffer.from([0xff, 0xfe, 0x00, 0x00, 0xc3, 0x28, 0x80]));

describe("A. truncateEventsBeforeEventId：目标之前的原文逐字节保留", () => {
  it("坏行 / 空行 / CRLF 行在保留段：新文件 = 原文件目标行之前的字节，逐字节相同", async () => {
    const id = await alloc();
    const [e1, e2, e3, target, e5] = [
      mkEv("info", "1"),
      mkEv("info", "2"),
      mkEv("info", "3"),
      mkEv("user_reply", "target"),
      mkEv("assistant_message", "5"),
    ];
    const keep = cat(
      evBytes(e1),
      BAD,
      "\n",
      evBytes(e2),
      "\n", // 空行
      JSON.stringify(e3) + "\r\n", // CRLF 行
    );
    await put(id, keep, evBytes(target), evBytes(e5));

    const res = await truncateEventsBeforeEventId(id, target.id);

    expect(read(id).equals(keep)).toBe(true);
    expect(res).toEqual({ kept: [e1, e2, e3], truncatedCount: 2 });
  });

  it("坏行在被截掉的那一段：随之消失，保留段不变", async () => {
    const id = await alloc();
    const [e1, target, e3] = [
      mkEv("info", "1"),
      mkEv("user_reply", "target"),
      mkEv("info", "3"),
    ];
    await put(id, evBytes(e1), evBytes(target), BAD, "\n", evBytes(e3));

    const res = await truncateEventsBeforeEventId(id, target.id);

    expect(read(id).equals(evBytes(e1))).toBe(true);
    expect(res).toEqual({ kept: [e1], truncatedCount: 2 }); // target + e3；坏行不是事件、不计
  });

  it("目标之前只有坏行：文件不是空的、坏行还在（旧实现会写空文件）；kept 为空", async () => {
    const id = await alloc();
    const [target, e2] = [mkEv("user_reply", "target"), mkEv("info", "2")];
    const keep = cat(BAD, "\n");
    await put(id, keep, evBytes(target), evBytes(e2));

    const res = await truncateEventsBeforeEventId(id, target.id);

    expect(read(id).equals(keep)).toBe(true);
    expect(res).toEqual({ kept: [], truncatedCount: 2 });
  });

  it("目标是第一条事件且前面什么都没有：空文件（与旧实现相同）", async () => {
    const id = await alloc();
    const [target, e2] = [mkEv("user_reply", "target"), mkEv("info", "2")];
    await put(id, evBytes(target), evBytes(e2));

    const res = await truncateEventsBeforeEventId(id, target.id);

    expect(read(id).length).toBe(0);
    expect(res).toEqual({ kept: [], truncatedCount: 2 });
  });

  it("正常文件（每行都是 JSON.stringify 写的）：与旧实现「重新序列化」的输出逐字节相同", async () => {
    const id = await alloc();
    const evs = [
      mkEv("info", "1"),
      mkEv("assistant_message", "你好 \u2028 \"引号\" \\ 反斜杠"),
      mkEv("info", "3"),
      mkEv("user_reply", "target"),
      mkEv("info", "5"),
    ];
    await put(id, ...evs.map(evBytes));

    await truncateEventsBeforeEventId(id, evs[3]!.id);

    // 旧实现：kept.map(JSON.stringify).join("\n") + "\n"
    const legacy = evs
      .slice(0, 3)
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";
    expect(read(id).toString("utf-8")).toBe(legacy);
  });

  it("目标不存在：返回 null，文件一个字节都不动", async () => {
    const id = await alloc();
    const original = await put(id, evBytes(mkEv("info", "1")), BAD, "\n");
    const res = await truncateEventsBeforeEventId(id, "evt_not_exist");
    expect(res).toBeNull();
    expect(read(id).equals(original)).toBe(true);
  });

  it("文件不存在：返回 null（不创建文件）", async () => {
    const id = await alloc();
    expect(await truncateEventsBeforeEventId(id, "evt_x")).toBeNull();
    await expect(fs.stat(eventsPath(id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("不留 tmp 文件", async () => {
    const id = await alloc();
    const [e1, target] = [mkEv("info", "1"), mkEv("user_reply", "target")];
    await put(id, evBytes(e1), BAD, "\n", evBytes(target));
    await truncateEventsBeforeEventId(id, target.id);
    const left = (await fs.readdir(taskDir(id))).filter((f) => f.includes(".tmp"));
    expect(left).toEqual([]);
  });
});

describe("B. restoreEventsRawText：按字节比较、按字节写回", () => {
  it("Buffer 备份：文件被改写过 → 逐字节还原（含非 UTF-8 / NUL）", async () => {
    const id = await alloc();
    const [e1, target] = [mkEv("info", "1"), mkEv("user_reply", "target")];
    const original = await put(id, evBytes(e1), BAD, "\n", evBytes(target));
    const backup = read(id);
    await truncateEventsBeforeEventId(id, target.id); // 改写：当前内容不再以备份为前缀
    expect(read(id).equals(backup)).toBe(false);

    await restoreEventsRawText(id, backup);

    expect(read(id).equals(original)).toBe(true);
  });

  it("备份之后文件只被追加过：不写回（否则会抹掉这期间追加的行）", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "1");
    const extra = mkEv("info", "追加的");
    await put(id, evBytes(e1), BAD, "\n");
    const backup = read(id);
    await fs.appendFile(eventsPath(id), evBytes(extra));
    const afterAppend = read(id);

    await restoreEventsRawText(id, backup);

    expect(read(id).equals(afterAppend)).toBe(true);
  });

  it("文件不存在（备份是空）：什么都不做、不创建文件", async () => {
    const id = await alloc();
    await restoreEventsRawText(id, Buffer.alloc(0));
    await expect(fs.stat(eventsPath(id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("备份非空但文件已被删：写回备份", async () => {
    const id = await alloc();
    const backup = cat(evBytes(mkEv("info", "1")), BAD, "\n");
    await restoreEventsRawText(id, backup);
    expect(read(id).equals(backup)).toBe(true);
  });

  it("string 备份（旧调用方式）：按 UTF-8 编码，行为兼容", async () => {
    const id = await alloc();
    const [e1, target] = [mkEv("info", "你好"), mkEv("user_reply", "target")];
    await put(id, evBytes(e1), evBytes(target));
    const backupText = read(id).toString("utf-8");
    await truncateEventsBeforeEventId(id, target.id);

    await restoreEventsRawText(id, backupText);

    expect(read(id).toString("utf-8")).toBe(backupText);
  });

  it("string 备份 + 文件之后只被追加：同样不写回（按字节比较——含多字节字符也对）", async () => {
    const id = await alloc();
    await put(id, evBytes(mkEv("info", "你好，世界")));
    const backupText = read(id).toString("utf-8");
    await fs.appendFile(eventsPath(id), evBytes(mkEv("info", "追加")));
    const afterAppend = read(id);

    await restoreEventsRawText(id, backupText);

    expect(read(id).equals(afterAppend)).toBe(true);
  });

  // 「按字节比较」的反面是「按 UTF-8 字符串比较」：非法字节 0xFF / 0xFE 解码后都是 U+FFFD，字符串口径分不出它们，
  // 会把「备份之后被改写过」误判成「只被追加」而不写回（审查 AI 的变异 CC07：.equals(backupBytes) → 字符串比较，改前没有测试变红）。
  // 下面两条的夹具前提（字节不同、字符串相同）在用例里自证，夹具漂移了会先红在前提上、不会悄悄空转。
  const tail = (b: number): Buffer => cat('{"id":"x","text":"', Buffer.from([b]), '"}\n');

  it("备份与当前文件只在一个非法 UTF-8 字节上不同（0xFF vs 0xFE，解码后都是 U+FFFD），当前文件还更长：判为被改写、写回备份（按字节比较，不是字符串）", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "1");
    await put(id, evBytes(e1), tail(0xff));
    const backup = read(id);
    const current = await put(id, evBytes(e1), tail(0xfe), evBytes(mkEv("info", "追加的")));
    // 夹具前提：前 backup.length 个字节不同，但按 UTF-8 解码后一模一样（否则这条测的不是「字节比较 vs 字符串比较」）
    expect(current.length).toBeGreaterThan(backup.length);
    expect(current.subarray(0, backup.length).equals(backup)).toBe(false);
    expect(current.subarray(0, backup.length).toString("utf-8")).toBe(backup.toString("utf-8"));

    await restoreEventsRawText(id, backup);

    expect(read(id).equals(backup)).toBe(true);
  });

  it("同上、但当前文件与备份等长（只差那一个非法字节）：同样写回备份", async () => {
    const id = await alloc();
    const e1 = mkEv("info", "1");
    await put(id, evBytes(e1), tail(0xff));
    const backup = read(id);
    const current = await put(id, evBytes(e1), tail(0xfe));
    expect(current.length).toBe(backup.length);
    expect(current.equals(backup)).toBe(false);
    expect(current.toString("utf-8")).toBe(backup.toString("utf-8"));

    await restoreEventsRawText(id, backup);

    expect(read(id).equals(backup)).toBe(true);
  });
});

describe("C. 截断 → 补偿还原的往返（rewind 后置失败的补偿路径）", () => {
  it("截断前的字节备份 → 截断 → 还原：文件与截断前逐字节相同", async () => {
    const id = await alloc();
    const [e1, e2, target, e4] = [
      mkEv("info", "1"),
      mkEv("info", "2"),
      mkEv("user_reply", "target"),
      mkEv("info", "4"),
    ];
    const original = await put(
      id,
      evBytes(e1),
      BAD,
      "\n",
      evBytes(e2),
      JSON.stringify(target) + "\r\n",
      BAD,
      "\n",
      evBytes(e4),
    );
    const backup = read(id);

    await truncateEventsBeforeEventId(id, target.id);
    expect(read(id).length).toBeLessThan(original.length);
    await restoreEventsRawText(id, backup);

    expect(read(id).equals(original)).toBe(true);
  });
});

describe("D. 截断之后", () => {
  it("保留的坏行仍被统计；后续 append 照常接在后面", async () => {
    const id = await alloc();
    const [e1, e2, target, e4, e5] = [
      mkEv("info", "1"),
      mkEv("info", "2"),
      mkEv("user_reply", "target"),
      mkEv("info", "4"),
      mkEv("info", "5"),
    ];
    await put(id, evBytes(e1), BAD, "\n", evBytes(e2), evBytes(target), evBytes(e4));

    await truncateEventsBeforeEventId(id, target.id);

    const afterTruncate = await readEventsWithStats(id);
    expect(afterTruncate.events.map((e) => e.id)).toEqual([e1.id, e2.id]);
    expect(afterTruncate.skipped?.count).toBe(1);

    await appendEventLine(id, e5);
    const afterAppend = await readEventsWithStats(id);
    expect(afterAppend.events.map((e) => e.id)).toEqual([e1.id, e2.id, e5.id]);
    expect(afterAppend.skipped?.count).toBe(1);
  });
});
