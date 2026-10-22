/**
 * task 详情页头部「运行态徽标 + 停止键外观」的判定（纯函数、可单测；client / server 都能 import）
 *
 * 背景（第二轮 review V6-02）：AI 用 ask_user 提问后，**runStatus 仍是 running**——等答案靠一条前台
 * curl 阻塞，既不 run.cancel() 也不把 runStatus 切成 awaiting_user（见 CHANGELOG「同一轮等答案」）。
 * 所以头部只看 runStatus 必然写「运行中」+ 一直转圈的「停止」，侧栏（taskStageLine 看 hasPendingAsk）
 * 却写「待回答」——两处互相矛盾，用户还可能误点停止、打断一个本来只需回答的问题。
 *
 * 取舍：
 *  - 徽标：等待回答时写「待回答」（与侧栏同词）；
 *  - 停止键：**不移除**。等答案期间底部输入条不是停止键（composer 的 isRunning = runActive && !pendingAsk），
 *    头部这颗是用户在会话卡死时唯一的停止入口，拿掉就没有退路了。只把「转圈」换成静态图标、补一句说明；
 *  - 停止键的显隐仍然只由 `isStopButtonVisible(task)`（只看 runStatus）决定——那是安全契约
 *    （点下去走 stopTaskAgent 核弹路径），这里**不并** runActive / awaitingAsk。
 */

import { RUN_STATUS_LABEL, RUN_STATUS_VARIANT } from "@/lib/task-display";
import type { RunStatus } from "@/lib/types";

/** 与侧栏 taskStageLine 同一个词（改词要两处一起改） */
export const AWAITING_ANSWER_LABEL = "待回答";

type BadgeVariant = (typeof RUN_STATUS_VARIANT)[RunStatus];

export type TaskHeaderRunBadge =
  | { kind: "none" }
  /** 失败：页面用「小圆点 + 弱化文字」的特殊样式，不画 Badge */
  | { kind: "error"; label: string }
  | { kind: "badge"; label: string; variant: BadgeVariant; awaitingAnswer: boolean };

/**
 * @param awaitingAsk 是否有未了结的 ask_user 提问（页面用 findPendingAskEvent(task.events)，
 *   与 canAdvance / 底部输入条同口径）
 */
export const deriveTaskHeaderRunBadge = (
  runStatus: RunStatus,
  awaitingAsk: boolean,
): TaskHeaderRunBadge => {
  // 失败：提问已经没人接，不能写成「待回答」
  if (runStatus === "error") {
    return { kind: "error", label: RUN_STATUS_LABEL.error };
  }
  // 空闲：不画。残留一条没了结的 ask 事件也不画（会话已不在、等不到答案）
  if (runStatus === "idle") return { kind: "none" };
  if (awaitingAsk) {
    return {
      kind: "badge",
      label: AWAITING_ANSWER_LABEL,
      // 沿用 awaiting_user 的徽标样式（「等你」的中性 secondary），不新增色档
      variant: RUN_STATUS_VARIANT.awaiting_user,
      awaitingAnswer: true,
    };
  }
  return {
    kind: "badge",
    label: RUN_STATUS_LABEL[runStatus],
    variant: RUN_STATUS_VARIANT[runStatus],
    awaitingAnswer: false,
  };
};

/**
 * chat 头部的运行态徽标（第三轮 review R3-03）。
 *
 * 与 task 头部（deriveTaskHeaderRunBadge）的差异是**既有**的、这里保持：
 *  - chat 静息就是 awaiting_user（你一句我一句的正常状态）→ 不画徽标，不画「等待回复」；
 *  - 失败仍是 Badge（task 头部是小圆点 + 弱化文字的特殊样式），所以 error 也走 badge 分支。
 * 只补一个口径：running 且有未答提问 = 「待回答」（同一轮 curl 等答案时 runStatus 仍是 running，
 * 直接写 RUN_STATUS_LABEL 就是「运行中」，与底部状态行「等你回答」自相矛盾）。
 *
 * @param awaitingAsk 是否有未了结的 ask_user 提问（findPendingAskEvent(task.events)，与 task 头部同口径）
 */
export const deriveChatHeaderRunBadge = (
  runStatus: RunStatus,
  awaitingAsk: boolean,
): TaskHeaderRunBadge => {
  if (runStatus === "idle" || runStatus === "awaiting_user") return { kind: "none" };
  if (runStatus === "running" && awaitingAsk) {
    return deriveTaskHeaderRunBadge(runStatus, true);
  }
  return {
    kind: "badge",
    label: RUN_STATUS_LABEL[runStatus],
    variant: RUN_STATUS_VARIANT[runStatus],
    awaitingAnswer: false,
  };
};

export interface TaskStopButtonView {
  /** 图标是否转圈（AI 真在跑才转；等你回答时转圈会说谎） */
  spinning: boolean;
  /** Tooltip 说明（null = 不加） */
  tooltip: string | null;
}

/**
 * 头部停止键的外观。能力不变（点了照样弹确认、照样停），只换图标和说明。
 * 文案里「待答提问作废」有据：stop-task 会 supersedePendingAsks(id, "用户停止")。
 */
export const taskStopButtonView = (awaitingAnswer: boolean): TaskStopButtonView =>
  awaitingAnswer
    ? {
        spinning: false,
        tooltip:
          "AI 在等你回答提问，先答题即可继续。仍要停止：会中断本次会话，待答提问作废",
      }
    : { spinning: true, tooltip: null };
