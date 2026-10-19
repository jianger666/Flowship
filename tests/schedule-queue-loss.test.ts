/**
 * 排队中的定时消息被停止 / 回退清掉 → 会话内提示（review 🟡「chat 忙时入队 202 就记已送达」）。
 *
 * 会话在跑时定时消息进 chat 队列、下游回 202，runner 记成已送达；用户随后点停止，队列被清并发 `queue_failed`，
 * 这次其实没执行，一次性定时就静默蒸发。这里验：
 *  - 纯函数：从 queue itemId（`<scheduleId>.<seq>.<attempt>`）认出是哪条定时；提示文案
 *  - 真实链路：真 task-stream 全局流 publish `queue_failed` → 真落盘一条 info（schedule 子类）；
 *    普通用户消息的 itemId / 任务被删 / 重复帧 / 重复启动订阅 都不会多提示
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-queue-loss-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const {
  parseScheduleClientItemId,
  queueLostText,
} = await import("@/lib/schedule");
const { clearEventSeqCounter, readEvents, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const store = await import("@/lib/server/schedule-store");
const { publishTaskStreamEvent } = await import("@/lib/server/task-stream");
const { handleQueueFailedFrame, startScheduleQueueLossWatcher } = await import(
  "@/lib/server/schedule-queue-loss"
);

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 18, 2, 0, 0);

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("parseScheduleClientItemId", () => {
  it("认出 <scheduleId>.<seq>.<attempt>", () => {
    expect(parseScheduleClientItemId("sch_mgx3k1_ab12c.3.2")).toEqual({
      scheduleId: "sch_mgx3k1_ab12c",
      seq: 3,
      attempt: 2,
    });
  });

  it("认不出的一律 null：普通用户消息的 itemId、缺段、多段、带空白", () => {
    for (const id of ["", "item_1", "q_17c8", "sch_x.1", "sch_x.1.2.3", "sch_x.a.1", "sch_x. 1.1", "xsch_x.1.1", "sch_.1.1"]) {
      expect(parseScheduleClientItemId(id), id).toBeNull();
    }
  });
});

describe("queueLostText", () => {
  const once = { title: "看 CI", kind: "once" as const, status: "done" as const };
  const every = { title: "盯部署", kind: "every" as const, status: "active" as const };

  it("一次性：说明没执行 + 需要请重新设置", () => {
    const t = queueLostText(once, "stopped");
    expect(t).toContain("定时「看 CI」");
    expect(t).toContain("没有执行");
    expect(t).toContain("会话被停止了");
    expect(t).toContain("一次性定时，需要的话请重新设置");
  });

  it("周期（进行中）：说明下一次照常；已暂停 / 取消的不乱许诺", () => {
    expect(queueLostText(every, "rewound")).toContain("会话被回退了");
    expect(queueLostText(every, "rewound")).toContain("周期定时不受影响，下一次照常触发");
    expect(queueLostText({ ...every, status: "paused" }, "stopped")).not.toContain("照常触发");
    expect(queueLostText({ ...every, status: "cancelled" }, "stopped")).not.toContain("照常触发");
  });

  it("记录读不到：通用措辞；其它 reason 带原因码", () => {
    const t = queueLostText(undefined, "flush_error");
    expect(t).toContain("一条定时消息");
    expect(t).toContain("会话出错了（flush_error）");
    expect(t).not.toContain("重新设置");
  });

  it("标题里的换行不会撑破提示", () => {
    expect(queueLostText({ ...once, title: "a\nb" }, "stopped")).toContain("定时「a b」");
  });
});

describe("真实链路：全局流 queue_failed → 会话内提示", () => {
  const ids: string[] = [];
  let seq = 0;

  const makeMeta = (id: string): TaskMetaV06 =>
    ({
      id,
      title: `queue-loss ${id}`,
      mode: "chat",
      repoStatus: "developing",
      runStatus: "idle",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }) as unknown as TaskMetaV06;

  const newTaskWithSchedule = async (kind: "once" | "every" = "once") => {
    seq += 1;
    const taskId = `t_ql_${Date.now()}_${seq}`;
    ids.push(taskId);
    await writeMeta(makeMeta(taskId));
    await fs.mkdir(taskDir(taskId), { recursive: true });
    const created = await store.createSchedule(
      taskId,
      kind === "once"
        ? { kind, title: "看 CI", message: "去看 CI", firstFireAt: NOW + 10 * MIN }
        : { kind, title: "盯部署", message: "看进度", firstFireAt: NOW + 10 * MIN, intervalMs: 10 * MIN },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    return { taskId, scheduleId: created.record.id };
  };

  const scheduleInfos = async (taskId: string) =>
    (await readEvents(taskId)).filter((e) => e.kind === "info" && e.meta?.subkind === "schedule");

  const waitFor = async (cond: () => Promise<boolean>, ms = 3000): Promise<void> => {
    const start = Date.now();
    while (!(await cond())) {
      if (Date.now() - start > ms) throw new Error("waitFor 超时");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  afterEach(() => {
    for (const id of ids.splice(0)) clearEventSeqCounter(id);
  });

  it("queue_failed 帧里有定时的 itemId → 落一条 info（schedule 子类、phase=failed），文案带标题；重复启动订阅也只提示一次", async () => {
    const { taskId, scheduleId } = await newTaskWithSchedule("once");
    startScheduleQueueLossWatcher();
    startScheduleQueueLossWatcher(); // 幂等：不会叠出两份订阅

    publishTaskStreamEvent(taskId, {
      kind: "queue_failed",
      itemIds: ["user_item_1", `${scheduleId}.1.1`],
      reason: "stopped",
    });
    await waitFor(async () => (await scheduleInfos(taskId)).length >= 1);
    await new Promise((r) => setTimeout(r, 80)); // 留时间给「如果有第二份订阅就会多写一条」

    const infos = await scheduleInfos(taskId);
    expect(infos).toHaveLength(1);
    expect(infos[0]!.text).toContain("定时「看 CI」");
    expect(infos[0]!.text).toContain("没有执行");
    expect(infos[0]!.text).toContain("会话被停止了");
    expect(infos[0]!.meta).toMatchObject({ subkind: "schedule", scheduleId, phase: "failed" });
  });

  it("重复启动：先摘掉上一份订阅（不靠「按 key 去重」兜底——去重会把叠出来的第二份订阅掩盖掉）", () => {
    startScheduleQueueLossWatcher();
    const g = globalThis as unknown as Record<string, (() => void) | undefined>;
    const key = "__flowshipScheduleQueueLossUnsubV1__";
    const real = g[key]!;
    expect(typeof real).toBe("function");
    const spy = vi.fn(real);
    g[key] = spy;
    startScheduleQueueLossWatcher();
    expect(spy).toHaveBeenCalledTimes(1); // 旧订阅被摘
    expect(g[key]).not.toBe(spy); // 换成了新的
  });

  it("非 queue_failed 的帧一律忽略：不进处理函数、也不刷告警（task-stream 上每个事件都会经过这个订阅）", async () => {
    const { taskId } = await newTaskWithSchedule("once");
    startScheduleQueueLossWatcher();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      publishTaskStreamEvent(taskId, {
        kind: "event",
        event: { id: "e_ql_1", ts: Date.now(), kind: "info", text: "普通事件" } as never,
      });
      await new Promise((r) => setTimeout(r, 80));
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("[schedule-queue-loss]"))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("同一条消息的 queue_failed 双发 → 只提示一次", async () => {
    const { taskId, scheduleId } = await newTaskWithSchedule("every");
    startScheduleQueueLossWatcher();
    for (let i = 0; i < 3; i++) {
      publishTaskStreamEvent(taskId, { kind: "queue_failed", itemIds: [`${scheduleId}.2.1`], reason: "cancelled" });
    }
    await waitFor(async () => (await scheduleInfos(taskId)).length >= 1);
    await new Promise((r) => setTimeout(r, 80));
    const infos = await scheduleInfos(taskId);
    expect(infos).toHaveLength(1);
    expect(infos[0]!.text).toContain("周期定时不受影响");
  });

  it("不会误报：普通用户消息的 itemId、任务被删（deleted / task_gone）都不提示", async () => {
    const { taskId, scheduleId } = await newTaskWithSchedule("once");
    startScheduleQueueLossWatcher();
    publishTaskStreamEvent(taskId, { kind: "queue_failed", itemIds: ["q_17c8", "item_2"], reason: "stopped" });
    publishTaskStreamEvent(taskId, { kind: "queue_failed", itemIds: [`${scheduleId}.1.1`], reason: "deleted" });
    publishTaskStreamEvent(taskId, { kind: "queue_failed", itemIds: [`${scheduleId}.1.1`], reason: "task_gone" });
    await new Promise((r) => setTimeout(r, 150));
    expect(await scheduleInfos(taskId)).toHaveLength(0);
  });

  it("定时记录读不出来 → 通用措辞照样提示（不因为读失败就吞掉）", async () => {
    const { taskId, scheduleId } = await newTaskWithSchedule("once");
    // schedules.json 的位置换成目录：readSchedules 抛 EISDIR
    await fs.rm(path.join(taskDir(taskId), "schedules.json"));
    await fs.mkdir(path.join(taskDir(taskId), "schedules.json"));
    const n = await handleQueueFailedFrame(taskId, [`${scheduleId}.1.1`], "error");
    expect(n).toBe(1);
    const infos = await scheduleInfos(taskId);
    expect(infos[0]!.text).toContain("一条定时消息");
    expect(infos[0]!.text).toContain("会话出错了（error）");
  });

  it("任务已经不在了（没有 meta）：不抛、不计数，也不会替它重建出一个空目录", async () => {
    const ghost = "t_ql_never_existed";
    const n = await handleQueueFailedFrame(ghost, ["sch_zzz.1.1"], "stopped");
    expect(n).toBe(0);
    await expect(fs.stat(taskDir(ghost))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
