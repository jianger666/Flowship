/**
 * 批次派生单测：多次 plan / 补需求后，build 选择必须来自同一份派生视图。
 */
import { describe, expect, it } from "vitest";

import { buildDefaultDailyTaskTitle, computeBatchProgress } from "@/lib/task-display";
import type {
  ActionRecord,
  ActionType,
  PlanBatch,
  ReplanMode,
  Task,
} from "@/lib/types";

const batch = (id: string, title: string): PlanBatch => ({
  id,
  title,
  testStrategy: "after",
  taskRefs: [`Task ${id}`],
});

const action = (
  n: number,
  type: ActionType,
  patch: Partial<ActionRecord> = {},
): ActionRecord => ({
  id: `act_${n}`,
  n,
  type,
  status: "completed",
  userInstruction: "",
  artifactPath: `actions/${n}-${type}.md`,
  startedAt: n,
  endedAt: n,
  ...patch,
});

const taskWithActions = (actions: ActionRecord[]): Task =>
  ({
    id: "task_1",
    mode: "task",
    title: "批次测试",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: ["/repo"],
    actions,
  }) as Task;

describe("computeBatchProgress 多 plan 派生", () => {
  it("旧 task 无 replanMode 时保持 latest-only，并兼容历史裸 batch id", () => {
    const task = taskWithActions([
      action(1, "plan", { planBatches: [batch("b1", "旧接口")] }),
      action(2, "build", { requestedBatchIds: ["b1"] }),
      action(3, "plan", {
        planBatches: [batch("b1", "新接口"), batch("b2", "新页面")],
      }),
    ]);

    const progress = computeBatchProgress(task);

    expect(progress.batches.map((b) => b.sourcePlanActionId)).toEqual([
      "act_3",
      "act_3",
    ]);
    expect(progress.done).toBe(1);
    expect(progress.remaining.map((b) => b.rawId)).toEqual(["b2"]);
  });

  it("append replan 只追加新批次，旧完成状态保留且新批次可选", () => {
    const task = taskWithActions([
      action(1, "plan", { planBatches: [batch("b1", "接口层")] }),
      action(2, "build", { requestedBatchIds: ["b1"] }),
      action(3, "plan", {
        replanMode: "append" satisfies ReplanMode,
        planBatches: [batch("b1", "跨学科线索")],
      }),
    ]);

    const progress = computeBatchProgress(task);

    expect(progress.batches.map((b) => b.effectiveId)).toEqual([
      "act_1:b1",
      "act_3:b1",
    ]);
    expect(progress.done).toBe(1);
    expect(progress.remaining.map((b) => b.effectiveId)).toEqual(["act_3:b1"]);
  });

  it("append 疑似重复只标记 duplicate，不自动合并", () => {
    const task = taskWithActions([
      action(1, "plan", { planBatches: [batch("b1", "接口层")] }),
      action(2, "plan", {
        replanMode: "append" satisfies ReplanMode,
        planBatches: [batch("b1", "接口层")],
      }),
    ]);

    const progress = computeBatchProgress(task);

    expect(progress.batches).toHaveLength(2);
    expect(progress.batches[1].duplicateOfEffectiveId).toBe("act_1:b1");
  });

  it("rebuild 只替代此前 pending 批次，已 built 历史保留", () => {
    const task = taskWithActions([
      action(1, "plan", {
        planBatches: [batch("b1", "已完成接口"), batch("b2", "旧页面")],
      }),
      action(2, "build", { requestedBatchIds: ["b1"] }),
      action(3, "plan", {
        replanMode: "rebuild" satisfies ReplanMode,
        planBatches: [batch("b1", "新页面")],
      }),
    ]);

    const progress = computeBatchProgress(task);

    expect(progress.batches.map((b) => b.effectiveId)).toEqual([
      "act_1:b1",
      "act_3:b1",
    ]);
    expect(progress.superseded.map((b) => b.effectiveId)).toEqual(["act_1:b2"]);
    expect(progress.done).toBe(1);
  });

  it("awaiting_ack 的 build 计入已完成（推进窗口期不重复勾选）", () => {
    const task = taskWithActions([
      action(1, "plan", {
        planBatches: [batch("b1", "接口"), batch("b2", "页面")],
      }),
      action(2, "build", {
        status: "awaiting_ack",
        requestedBatchIds: ["b1"],
      }),
    ]);

    const progress = computeBatchProgress(task);

    expect(progress.done).toBe(1);
    expect(progress.remaining.map((b) => b.rawId)).toEqual(["b2"]);
  });
});

describe("buildDefaultDailyTaskTitle", () => {
  it("日常 · 首仓短名 · 时间（多仓只取第一个）", () => {
    const now = new Date(2026, 6, 24, 13, 45); // 月 0-based → 7 月
    const title = buildDefaultDailyTaskTitle(
      ["/Users/me/work/crm-web", "/Users/me/work/crm-api"],
      now,
    );
    expect(title.startsWith("日常 · crm-web · ")).toBe(true);
    expect(title).toContain(
      now.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  });

  it("无仓路径兜底短名「任务」", () => {
    const title = buildDefaultDailyTaskTitle([], new Date(2026, 0, 1, 0, 0));
    expect(title.startsWith("日常 · 任务 · ")).toBe(true);
  });
});
