/**
 * P1-02：events.jsonl 尾部反向读 / cursor 流式分页正确性
 * - tail 与全量 slice(-n) 一致
 * - 崩溃半行容忍
 * - before 分页与旧 findIndex+slice 语义一致
 * - 空文件 / 单行边界
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；ESM 静态 import 会 hoist，
 * 必须先钉 FLOWSHIP_DATA_DIR 再动态 import，否则全量并行时多文件撞 cwd/data/tasks。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { TaskEvent } from "@/lib/types";

// OS 保证唯一；必须在动态 import 之前钉死 env
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-events-tail-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const {
  EVENTS_FILE,
  readEvents,
  readEventsBefore,
  readEventsTail,
  taskDir,
} = await import("@/lib/server/task-fs-core");

// 锁死落在 TMP：防 DATA_DIR 误冻到 cwd/data 污染正式数据 / 并行串扰
if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`events-tail DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const TASK_ID = "t_events_tail_1";

const makeEv = (i: number): TaskEvent => ({
  id: `ev_${i}`,
  ts: 1_000 + i,
  kind: "info",
  text: `事件 ${i} 含中文`,
});

const eventsPath = () => path.join(taskDir(TASK_ID), EVENTS_FILE);

const writeJsonl = async (lines: string[]): Promise<void> => {
  const dir = taskDir(TASK_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(eventsPath(), lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
};

/** 旧逻辑：全量 read + slice / findIndex（对照基准） */
const legacyTail = async (n: number): Promise<TaskEvent[]> => {
  const all = await readEvents(TASK_ID);
  return all.slice(-n);
};

const legacyBefore = async (
  beforeId: string,
  limit: number,
): Promise<{ events: TaskEvent[]; hasMore: boolean }> => {
  const all = await readEvents(TASK_ID);
  const idx = all.findIndex((e) => e.id === beforeId);
  if (idx < 0) return { events: [], hasMore: false };
  const start = Math.max(0, idx - limit);
  return { events: all.slice(start, idx), hasMore: start > 0 };
};

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("readEventsTail", () => {
  it("5000 条：tail(100) 与全量 slice(-100) 一致，且 hasMore=true", async () => {
    const n = 5000;
    const lines = Array.from({ length: n }, (_, i) => JSON.stringify(makeEv(i)));
    await writeJsonl(lines);

    const { events, hasMore } = await readEventsTail(TASK_ID, 100);
    const expected = await legacyTail(100);

    expect(hasMore).toBe(true);
    expect(events.map((e) => e.id)).toEqual(expected.map((e) => e.id));
    expect(events).toHaveLength(100);
    expect(events[0]!.id).toBe("ev_4900");
    expect(events[99]!.id).toBe("ev_4999");
  });

  it("总量 ≤ n 时 hasMore=false、返回全部", async () => {
    await writeJsonl([
      JSON.stringify(makeEv(0)),
      JSON.stringify(makeEv(1)),
      JSON.stringify(makeEv(2)),
    ]);
    const { events, hasMore } = await readEventsTail(TASK_ID, 100);
    expect(hasMore).toBe(false);
    expect(events.map((e) => e.id)).toEqual(["ev_0", "ev_1", "ev_2"]);
  });

  it("空文件 → 空数组", async () => {
    await writeJsonl([]);
    const { events, hasMore } = await readEventsTail(TASK_ID, 50);
    expect(events).toEqual([]);
    expect(hasMore).toBe(false);
  });

  it("文件不存在 → 空数组", async () => {
    await fs.rm(taskDir(TASK_ID), { recursive: true, force: true });
    const { events, hasMore } = await readEventsTail(TASK_ID, 50);
    expect(events).toEqual([]);
    expect(hasMore).toBe(false);
  });

  it("单行文件（无尾换行）", async () => {
    const dir = taskDir(TASK_ID);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(eventsPath(), JSON.stringify(makeEv(7)), "utf-8");
    const { events, hasMore } = await readEventsTail(TASK_ID, 10);
    expect(hasMore).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("ev_7");
  });

  it("崩溃半行：末尾截断 JSON 被跳过，仍返回完整行", async () => {
    const good = [makeEv(0), makeEv(1), makeEv(2)].map((e) => JSON.stringify(e));
    const dir = taskDir(TASK_ID);
    await fs.mkdir(dir, { recursive: true });
    // 完整行 + 半行（无收尾 }、无换行）
    await fs.writeFile(
      eventsPath(),
      good.join("\n") + "\n" + '{"id":"ev_bad","ts":9,"kind":"info","tex',
      "utf-8",
    );

    const { events, hasMore } = await readEventsTail(TASK_ID, 10);
    expect(hasMore).toBe(false);
    expect(events.map((e) => e.id)).toEqual(["ev_0", "ev_1", "ev_2"]);

    // 与全量 readEvents 容忍语义一致
    const all = await readEvents(TASK_ID);
    expect(all.map((e) => e.id)).toEqual(["ev_0", "ev_1", "ev_2"]);
  });

  it("CRLF 换行", async () => {
    const lines = [makeEv(0), makeEv(1), makeEv(2)].map((e) => JSON.stringify(e));
    const dir = taskDir(TASK_ID);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(eventsPath(), lines.join("\r\n") + "\r\n", "utf-8");
    const { events, hasMore } = await readEventsTail(TASK_ID, 2);
    expect(hasMore).toBe(true);
    expect(events.map((e) => e.id)).toEqual(["ev_1", "ev_2"]);
  });
});

describe("readEventsBefore", () => {
  it("与旧 findIndex+slice 结果一致（含 hasMore）", async () => {
    const n = 500;
    await writeJsonl(
      Array.from({ length: n }, (_, i) => JSON.stringify(makeEv(i))),
    );

    const before = "ev_400";
    const limit = 50;
    const got = await readEventsBefore(TASK_ID, before, limit);
    const legacy = await legacyBefore(before, limit);

    expect(got.events.map((e) => e.id)).toEqual(legacy.events.map((e) => e.id));
    expect(got.hasMore).toBe(legacy.hasMore);
    expect(got.events).toHaveLength(50);
    expect(got.events[0]!.id).toBe("ev_350");
    expect(got.events[49]!.id).toBe("ev_399");
    expect(got.hasMore).toBe(true);
  });

  it("锚点靠近文件头：hasMore=false", async () => {
    await writeJsonl(
      Array.from({ length: 20 }, (_, i) => JSON.stringify(makeEv(i))),
    );
    const got = await readEventsBefore(TASK_ID, "ev_5", 50);
    expect(got.events.map((e) => e.id)).toEqual([
      "ev_0",
      "ev_1",
      "ev_2",
      "ev_3",
      "ev_4",
    ]);
    expect(got.hasMore).toBe(false);
  });

  it("锚点不存在 → 空页", async () => {
    await writeJsonl([JSON.stringify(makeEv(0)), JSON.stringify(makeEv(1))]);
    const got = await readEventsBefore(TASK_ID, "missing", 10);
    expect(got).toEqual({ events: [], hasMore: false });
  });
});
