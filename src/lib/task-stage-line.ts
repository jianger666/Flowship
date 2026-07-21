/**
 * 侧栏 task 行「阶段 · 状态」监控行判定（从 task-list-item 抽出可单测）。
 *
 * 「待回答」必须看 hasPendingAsk（meta.pendingAskId），不能只看
 * awaiting_user + lastActionStatus=running——断掉态同组合、无题可答。
 */

import { actionDisplayLabel } from "@/lib/task-display";
import type { TaskSummary } from "@/lib/types";

export type TaskStageLine = {
  stage: string;
  status: string;
  tone: "run" | "wait";
};

/**
 * @param seenAt 该 task 详情上次打开时间（待确认已读即清）
 * @returns null = 不出第二行（空闲 / 静息 / chat）
 */
export const taskStageLine = (
  task: TaskSummary,
  seenAt: number,
): TaskStageLine | null => {
  if (task.mode === "chat") return null;
  const stage = task.lastActionType
    ? actionDisplayLabel({ type: task.lastActionType }, "short")
    : "未开始";
  if (task.runStatus === "running") {
    return { stage, status: "运行中", tone: "run" };
  }
  if (task.runStatus === "awaiting_user") {
    // 交卷等审阅
    if (task.lastActionStatus === "awaiting_ack") {
      // 已读即清：点进详情看过 → 回归静息单行；新交卷 updatedAt 前移再亮
      if (seenAt >= task.updatedAt) return null;
      return { stage, status: "待确认", tone: "wait" };
    }
    // 真有 pending ask → 待回答（不做已读清除：不答永远停）
    if (task.hasPendingAsk) {
      return { stage, status: "待回答", tone: "wait" };
    }
    // awaiting_user + action 仍 running、但无 ask = 非正常断掉（重连失败等）
    // 用户可在任务里说话唤醒——标「已暂停」别误导成有题
    if (task.lastActionStatus === "running") {
      return { stage, status: "已暂停", tone: "wait" };
    }
  }
  return null;
};
