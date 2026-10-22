/**
 * events.jsonl 末尾有崩溃半行时，下一条事件不能被粘进坏行（2026-10-20 第二轮 review V8-01）。
 *
 * 复现：进程在写一条事件中途崩溃 / ENOSPC，文件末尾留下 `{"id":"half"…` 且没有换行；
 * 重启后下一条 appendFile 直接接在后面 → 这一行变成「坏半行 + 新事件」，整行解析失败，
 * 新事件当次上屏、刷新后读不回来。修法：每个 task 在本进程内首次写之前核对末字节，缺换行先补。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结，必须先钉 env 再动态 import。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-events-torn-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { appendEventLine, newEventId, readEvents, taskDir } = await import(
  "@/lib/server/task-fs-core"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const mkEvent = (text: string): TaskEvent =>
  ({
    id: newEventId(),
    ts: Date.now(),
    kind: "info",
    text,
  }) as TaskEvent;

const prepare = async (taskId: string, initial: string): Promise<string> => {
  await fs.mkdir(taskDir(taskId), { recursive: true });
  const file = path.join(taskDir(taskId), "events.jsonl");
  await fs.writeFile(file, initial, "utf-8");
  return file;
};

describe("events.jsonl 崩溃半行不吞掉下一条事件（V8-01）", () => {
  it("末尾是没写完的半行：新事件独占一行、读得回来；坏半行被隔离", async () => {
    const taskId = "t_1700000000001_torn1";
    const good = mkEvent("before-crash");
    const file = await prepare(
      taskId,
      JSON.stringify(good) + "\n" + '{"id":"half","ts":1,"kind":"info","text":"没写完',
    );

    const next = mkEvent("after-crash");
    expect(await appendEventLine(taskId, next)).toBe(true);

    const raw = await fs.readFile(file, "utf-8");
    // 新事件不能和坏半行在同一行
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('{"id":"half","ts":1,"kind":"info","text":"没写完');
    expect(JSON.parse(lines[2]!).text).toBe("after-crash");

    const read = await readEvents(taskId);
    expect(read.map((e) => e.text)).toEqual(["before-crash", "after-crash"]);
  });

  it("末尾正常（以换行结尾）：不多补空行", async () => {
    const taskId = "t_1700000000002_torn2";
    const good = mkEvent("clean");
    const file = await prepare(taskId, JSON.stringify(good) + "\n");

    expect(await appendEventLine(taskId, mkEvent("next"))).toBe(true);
    const raw = await fs.readFile(file, "utf-8");
    expect(raw.includes("\n\n")).toBe(false);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("文件为空 / 首条事件：不补前导换行", async () => {
    const taskId = "t_1700000000003_torn3";
    const file = await prepare(taskId, "");
    expect(await appendEventLine(taskId, mkEvent("first"))).toBe(true);
    const raw = await fs.readFile(file, "utf-8");
    expect(raw.startsWith("\n")).toBe(false);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("连续追加多条：只在首条前核对一次，之后行格式不变", async () => {
    const taskId = "t_1700000000004_torn4";
    const file = await prepare(taskId, '{"id":"half"');
    for (const t of ["a", "b", "c"]) {
      expect(await appendEventLine(taskId, mkEvent(t))).toBe(true);
    }
    const lines = (await fs.readFile(file, "utf-8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    const read = await readEvents(taskId);
    expect(read.map((e) => e.text)).toEqual(["a", "b", "c"]);
  });
});
