/**
 * 侧栏 taskStageLine：待回答 / 已暂停 / 待确认 三态
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

  it("断掉态（awaiting_user + running + 无 ask）→ 已暂停", () => {
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
      status: "已暂停",
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
