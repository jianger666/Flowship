/**
 * R14 Q20-06：周期定时 `markMissed` 把「错过的节拍数」封顶到「剩余名额」（`max_runs - seq`，至少 1）。
 *
 * 背景：周期定时设了 `max_runs`，应用关了 / 电脑睡了很久，醒来时错过的节拍数原来**全记**
 * （间隔 1 分钟睡 24 小时 = 1440 次）：`seq` / `missedCount` / 提示文案都夸张成「错过 1440 次」，
 * 而它实际最多还剩几次名额（`max_runs=3`、已用 2 次 → 最多还剩 1 次）。修后：错过数封顶到 `max_runs - seq`（至少 1）；
 * 不设 `max_runs` 的周期定时仍如实记全部。
 *
 * 分三块：
 * 1. 纯函数 `markMissed`（用 `buildScheduleRecord` 造记录、手工设 `seq` / `nextFireAt`）的回归用例；
 * 2. 封顶之外的老行为不变（对照）；
 * 3. runner 层：真实落盘 + 假时钟，`tick()` 发现睡过头后写给用户的那条提示文案。
 *
 * 回归 = 修复前（BF）会红；对照 = BF / SH 两边都绿。DATA_DIR 须在动态 import 前钉死（同 schedule-runner.test）。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SCHEDULE_MAX_MAX_RUNS,
  buildScheduleRecord,
  countSlotsUpTo,
  markMissed,
  type ScheduleCreateInput,
  type ScheduleRecord,
} from "@/lib/schedule";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-missed-cap-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const runnerMod = await import("../src/lib/server/schedule-runner");
const store = await import("../src/lib/server/schedule-store");
const { taskDir } = await import("../src/lib/server/task-fs-core");
const { createScheduleRunner, defaultStoreDeps } = runnerMod;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const MIN = 60_000;
/** 原计划的触发时刻（= 记录的 nextFireAt）。纯函数与时区无关，用 UTC 常量即可 */
const T0 = Date.UTC(2026, 9, 25, 2, 0, 0);
const NOTE = "睡眠";

/** 周期定时（间隔 1 分钟，`nextFireAt = T0`）；`patch` 手工覆盖 `seq` 等运行期字段 */
const everyRec = (
  input: Partial<ScheduleCreateInput> = {},
  patch: Partial<ScheduleRecord> = {},
): ScheduleRecord => ({
  ...buildScheduleRecord(
    "t_cap",
    { kind: "every", title: "盯部署", message: "看部署进度", firstFireAt: T0, intervalMs: MIN, ...input },
    T0 - 10 * MIN,
    "sch_cap",
  ),
  ...patch,
});

/** 醒来的时刻：让 [T0, now] 之间恰好落 `slots` 个节拍（首点算第一个），并当场用 `countSlotsUpTo` 验证构造没错 */
const wakeAt = (slots: number): number => {
  const now = T0 + (slots - 1) * MIN + 30_000;
  expect(countSlotsUpTo(T0, MIN, now), "测试构造：醒来时刻应恰好错过 slots 个节拍").toBe(slots);
  return now;
};

// ----------------- 1. 回归：封顶到剩余名额 -----------------

describe("Q20-06 回归：错过的节拍数封顶到「剩余名额」（max_runs - seq，至少 1）", () => {
  it("R1 max_runs=3、已用 2 次（剩 1 次）、间隔 1 分钟、睡 24 小时（错过 1440 个节拍）→ missedCount 只加 1，seq=3，done，note 不再写「错过 1440 次」", () => {
    const r = everyRec({ maxRuns: 3 }, { seq: 2 });
    const out = markMissed(r, wakeAt(1440), NOTE);
    // 改前：missedCount=1440、seq=1442、note 含「错过 1440 次」
    expect(out.missedCount).toBe(1);
    expect(out.seq).toBe(3);
    expect(out.status).toBe("done");
    expect(out.nextFireAt).toBeNull();
    expect(out.endNote).toContain("用完");
    const last = out.history.at(-1)!;
    expect(last).toMatchObject({ outcome: "missed", dueAt: T0 });
    expect(last.note).not.toContain("错过 1440 次");
    // 封顶后只算 1 次：单次错过不附「（错过 N 次）」，note 原样
    expect(last.note).toBe(NOTE);
  });

  it("R2 max_runs=10、已用 8 次、错过 5 个节拍 → 封顶成剩余的 2 次：missedCount 加 2，seq=10，done，note 含「错过 2 次」", () => {
    const out = markMissed(everyRec({ maxRuns: 10 }, { seq: 8 }), wakeAt(5), NOTE);
    // 改前：missedCount=5、seq=13、note 含「错过 5 次」
    expect(out.missedCount).toBe(2);
    expect(out.seq).toBe(10);
    expect(out.status).toBe("done");
    expect(out.nextFireAt).toBeNull();
    const note = out.history.at(-1)!.note;
    expect(note).toContain("错过 2 次");
    expect(note).not.toContain("错过 5 次");
  });

  /** 额外的封顶边界：都是「错过数 > 剩余名额」，改前一律全记 */
  const CAP_ROWS = [
    {
      name: "R4 已认领满（seq ≥ max_runs 的异常存量记录）：剩余名额算 ≤ 0 也至少记 1 次，不是 0 次也不是全记",
      maxRuns: 3,
      seq: 3,
      slots: 5,
      wantMissed: 1,
      wantSeq: 4,
    },
    {
      name: "R5 max_runs=1：睡过 100 个节拍也只记 1 次",
      maxRuns: 1,
      seq: 0,
      slots: 100,
      wantMissed: 1,
      wantSeq: 1,
    },
    {
      name: `R6 max_runs 取上限 ${SCHEDULE_MAX_MAX_RUNS}、睡一天（1440 个节拍）：封顶到 ${SCHEDULE_MAX_MAX_RUNS}，不是 1440`,
      maxRuns: SCHEDULE_MAX_MAX_RUNS,
      seq: 0,
      slots: 1440,
      wantMissed: SCHEDULE_MAX_MAX_RUNS,
      wantSeq: SCHEDULE_MAX_MAX_RUNS,
    },
  ];
  for (const row of CAP_ROWS) {
    it(`[额外] ${row.name}`, () => {
      const out = markMissed(everyRec({ maxRuns: row.maxRuns }, { seq: row.seq }), wakeAt(row.slots), NOTE);
      expect(out.missedCount).toBe(row.wantMissed);
      expect(out.seq).toBe(row.wantSeq);
      expect(out.status).toBe("done");
      expect(out.nextFireAt).toBeNull();
    });
  }
});

// ----------------- 2. 对照：封顶之外的老行为不变 -----------------

describe("Q20-06 对照：封顶之外的老行为不变（BF / SH 两边都绿）", () => {
  it("C1 不设 max_runs：错过的节拍全记（1440 次，missedCount 与 seq 都加 1440），仍 active，下一次落在原节奏上", () => {
    const out = markMissed(everyRec({}, { seq: 5 }), wakeAt(1440), NOTE);
    expect(out.missedCount).toBe(1440);
    expect(out.seq).toBe(5 + 1440);
    expect(out.status).toBe("active");
    expect(out.nextFireAt).toBe(T0 + 1440 * MIN);
    expect(out.history.at(-1)!.note).toContain("错过 1440 次");
  });

  it("C2 max_runs=10、已用 2 次、错过 3 个节拍（没超剩余名额）→ 照实记 3，seq=5，仍 active；入参不被改动", () => {
    const r = everyRec({ maxRuns: 10 }, { seq: 2 });
    const out = markMissed(r, wakeAt(3), NOTE);
    expect(out.missedCount).toBe(3);
    expect(out.seq).toBe(5);
    expect(out.status).toBe("active");
    expect(out.nextFireAt).toBe(T0 + 3 * MIN);
    expect(out.history.at(-1)!.note).toContain("错过 3 次");
    expect(r.seq).toBe(2);
    expect(r.history).toEqual([]);
  });

  it("C3 剩余名额恰好等于错过数（max_runs=10、已用 7 次、错过 3 个）→ 记 3，seq=10，done", () => {
    const out = markMissed(everyRec({ maxRuns: 10 }, { seq: 7 }), wakeAt(3), NOTE);
    expect(out.missedCount).toBe(3);
    expect(out.seq).toBe(10);
    expect(out.status).toBe("done");
    expect(out.nextFireAt).toBeNull();
    expect(out.history.at(-1)!.note).toContain("错过 3 次");
  });

  it("C4 max_runs=10、已用 9 次（剩 1）、醒来时刚过到点不到一个间隔（countSlotsUpTo=1）→ 记 1，seq=10，done，单次不附「错过 N 次」", () => {
    const now = T0 + 30_000;
    expect(countSlotsUpTo(T0, MIN, now)).toBe(1);
    const out = markMissed(everyRec({ maxRuns: 10 }, { seq: 9 }), now, NOTE);
    expect(out).toMatchObject({ missedCount: 1, seq: 10, status: "done", nextFireAt: null });
    expect(out.history.at(-1)!.note).toBe(NOTE);
  });

  it("C4b 「至少记 1 次」：醒来时刻早于到点（countSlotsUpTo=0——调用方不会这么传，但纯函数里的 Math.max(1, …) 要保住）→ 照记 1，有无 max_runs 都一样", () => {
    const now = T0 - 5_000;
    expect(countSlotsUpTo(T0, MIN, now)).toBe(0);
    const capped = markMissed(everyRec({ maxRuns: 10 }, { seq: 9 }), now, NOTE);
    expect(capped).toMatchObject({ missedCount: 1, seq: 10, status: "done" });
    const uncapped = markMissed(everyRec({}, { seq: 4 }), now, NOTE);
    expect(uncapped).toMatchObject({ missedCount: 1, seq: 5, status: "active" });
  });

  it("C5 一次性定时的 markMissed 不变：missedCount +1、seq +1、status=missed，endNote 记原因，nextFireAt 清空", () => {
    const once = buildScheduleRecord(
      "t_cap",
      { kind: "once", title: "看 CI", message: "去看 CI 结果", firstFireAt: T0 },
      T0 - 10 * MIN,
      "sch_once",
    );
    const out = markMissed(once, T0 + 8 * 60 * MIN, NOTE);
    expect(out).toMatchObject({ status: "missed", missedCount: 1, seq: 1, nextFireAt: null, endNote: NOTE });
    expect(out.history.at(-1)).toMatchObject({ outcome: "missed", dueAt: T0, note: NOTE });
  });
});

// ----------------- 3. runner 层：tick 发现睡过头后的提示文案 -----------------

describe("Q20-06 runner 层：真实落盘 + 假时钟，tick 发现睡过头后写给用户的提示", () => {
  /** 假时钟的起点：创建定时的时刻；首次触发在它之后 1 分钟 */
  const BASE = Date.UTC(2026, 9, 25, 2, 0, 0);

  let seqNo = 0;
  const freshTask = async (): Promise<string> => {
    seqNo += 1;
    const id = `t_cap_${seqNo}`;
    await fs.mkdir(taskDir(id), { recursive: true });
    return id;
  };

  beforeEach(() => {
    runnerMod.__resetScheduleRunnerStateForTest();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  /** 假时钟 + 假投递 + 真落盘：只扫本用例的任务，免得别的用例留下的记录串进来 */
  const setup = async () => {
    const taskId = await freshTask();
    const clock = { now: BASE };
    const notices: string[] = [];
    const delivered: string[] = [];
    const runner = createScheduleRunner({
      ...defaultStoreDeps(),
      liveTaskIds: () => [taskId],
      now: () => clock.now,
      deliver: async (req) => {
        delivered.push(req.clientItemId);
        return { kind: "delivered" };
      },
      notify: async (_taskId, text) => {
        notices.push(text);
      },
    });
    return { taskId, clock, notices, delivered, runner };
  };

  /** 建一条间隔 1 分钟的周期定时（首次触发 = BASE + 1 分钟）；`seq` 非 0 时手工写成「已认领过这么多次」 */
  const createEvery = async (taskId: string, opts: { maxRuns?: number; seq?: number }): Promise<void> => {
    const created = await store.createSchedule(
      taskId,
      {
        kind: "every",
        title: "盯部署",
        message: "看部署进度",
        firstFireAt: BASE + MIN,
        intervalMs: MIN,
        ...(opts.maxRuns !== undefined ? { maxRuns: opts.maxRuns } : {}),
      },
      BASE,
    );
    if (!created.ok) throw new Error(created.error);
    if (opts.seq) {
      const seq = opts.seq;
      const out = await store.mutateSchedules(taskId, (list) => ({
        list: list.map((r) => ({ ...r, seq })),
        result: null,
      }));
      if (!out.ok) throw new Error("写入 seq 失败");
    }
  };

  it("R3 回归：max_runs=3、已用 2 次、睡 24 小时 → tick 只记 1 次，提示是「错过了一次」而不是「错过了 1440 次」", async () => {
    const h = await setup();
    await createEvery(h.taskId, { maxRuns: 3, seq: 2 });
    h.clock.now = BASE + 24 * 60 * MIN; // 睡了 24 小时：从 BASE + 1 分钟起落了 1440 个节拍
    await h.runner.tick();

    expect(h.delivered).toHaveLength(0); // 错过不补发
    expect(h.notices).toHaveLength(1);
    // 改前：「周期定时「盯部署」错过了 1440 次（…）」
    expect(h.notices[0]).toContain("错过了一次");
    expect(h.notices[0]).not.toContain("1440");
    const [saved] = await store.readSchedules(h.taskId);
    expect(saved).toMatchObject({ status: "done", missedCount: 1, seq: 3, fireCount: 0 });
  });

  it("C6 对照：不设 max_runs，同样睡 24 小时 → 仍如实写「错过了 1440 次」，周期继续（封顶只对有 max_runs 的生效）", async () => {
    const h = await setup();
    await createEvery(h.taskId, {});
    h.clock.now = BASE + 24 * 60 * MIN;
    await h.runner.tick();

    expect(h.delivered).toHaveLength(0);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("错过了 1440 次");
    const [saved] = await store.readSchedules(h.taskId);
    expect(saved).toMatchObject({ status: "active", missedCount: 1440, seq: 1440, nextFireAt: BASE + 1441 * MIN });
  });
});
