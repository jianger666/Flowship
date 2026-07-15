/**
 * 批次派生单测：多次 plan / 补需求后，build 选择必须来自同一份派生视图。
 */
import { describe, expect, it } from "vitest";

import { computeBatchProgress } from "@/lib/task-display";
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
});
