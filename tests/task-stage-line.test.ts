/**
 * 侧栏 taskStageLine：待回答 / 待输入 / 待确认 三态
 */
import { describe, expect, it } from "vitest";

import { taskStageLine } from "@/lib/task-stage-line";
import type { TaskSummary } from "@/lib/types";

const base = (
  partial: Partial<TaskSummary> &
    Pick<TaskSummary, "runStatus" | "lastActionStatus">,
): TaskSummary =>
  ({
    id: "t1",
    title: "侧栏判定",
    mode: "task",
    repoStatus: "developing",
    currentActionId: "act_1",
    mrs: [],
    repoPaths: ["/repo"],
    createdAt: 1,
    updatedAt: 100,
    actionCount: 1,
    lastActionType: "plan",
    ...partial,
  }) as TaskSummary;

describe("taskStageLine", () => {
  it("running + hasPendingAsk（同一轮 curl 等答案）→ 待回答", () => {
    const line = taskStageLine(
      base({
        runStatus: "running",
        lastActionStatus: "running",
        hasPendingAsk: true,
      }),
      0,
    );
    expect(line).toEqual({
      stage: "方案",
      status: "待回答",
      tone: "wait",
    });
  });

  it("真 ask（awaiting_user + hasPendingAsk）→ 待回答", () => {
    const line = taskStageLine(
      base({
        runStatus: "awaiting_user",
        lastActionStatus: "running",
        hasPendingAsk: true,
      }),
      0,
    );
    expect(line).toEqual({
      stage: "方案",
      status: "待回答",
      tone: "wait",
    });
  });

  it("断掉/等输入态（awaiting_user + running + 无 ask）→ 待输入", () => {
    const line = taskStageLine(
      base({
        runStatus: "awaiting_user",
        lastActionStatus: "running",
        hasPendingAsk: false,
      }),
      0,
    );
    expect(line).toEqual({
      stage: "方案",
      status: "待输入",
      tone: "wait",
    });
  });

  it("awaiting_ack 未读 → 待确认（不受 hasPendingAsk 影响）", () => {
    const line = taskStageLine(
      base({
        runStatus: "awaiting_user",
        lastActionStatus: "awaiting_ack",
        hasPendingAsk: false,
        updatedAt: 200,
      }),
      0,
    );
    expect(line).toEqual({
      stage: "方案",
      status: "待确认",
      tone: "wait",
    });
  });
});
