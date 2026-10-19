/**
 * 事件流「不渲染」单一闸（只滤显示、不滤落盘）
 *
 * 协议内部步骤、消音审计、和卡片已经说过的话，都从这里过。
 * 新藏一类：往 {@link isHiddenFromEventStream} 加分支，不要在组件里再写一份 filter。
 */

import {
  isAskExpireMarkerEvent,
  isAskSkipMarkerEvent,
} from "@/lib/ask-pending";
import {
  isAskWaitCommand,
  toolArgsLookLikeAskWait,
} from "@/lib/ask-wait-detect";
import { isBootStageInfo } from "@/lib/chat-stream-display";
import { isShellBackgroundMarkerEvent } from "@/lib/shell-background";
import { isInTurnToolErrorEvent } from "@/lib/tool-display";
import {
  groupRunTagOf,
  isGroupQaQuestionEvent,
  isGroupQaSummaryEvent,
} from "@/lib/group-qa";
import type { TaskEvent } from "@/lib/types";

/**
 * chat 历史噪声：旧版「Chat 任务启动 (model:…)」info。
 * 勿误伤重连 info（meta.kind=reconnecting / reconnected）和压缩过程行。
 */
export const isChatStartupNoiseInfo = (ev: TaskEvent): boolean => {
  if (ev.kind !== "info") return false;
  const metaKind = ev.meta?.kind;
  if (
    metaKind === "reconnecting" ||
    metaKind === "reconnected" ||
    metaKind === "compaction" ||
    metaKind === "sdk_summary"
  ) {
    return false;
  }
  return /^Chat 任务启动/.test(ev.text);
};

/** 提问等答案的前台 curl（tool_call / tool_result）——用户只该看见答题卡 */
export const isAskWaitStreamEvent = (ev: TaskEvent): boolean => {
  if (ev.kind !== "tool_call" && ev.kind !== "tool_result") return false;
  if (toolArgsLookLikeAskWait(ev.meta?.args)) return true;
  const blobs: unknown[] = [ev.text, ev.meta?.args, ev.meta?.output];
  for (const blob of blobs) {
    if (typeof blob === "string" && isAskWaitCommand(blob)) return true;
  }
  return false;
};

export const isHiddenFromEventStream = (
  ev: TaskEvent,
  opts?: { isChat?: boolean },
): boolean => {
  // 交卷 / 提问成功后被平台消音的模型输出（thinking / 正文 / 工具）
  if (ev.meta?.muted === true) return true;
  // 跳过 / 过期标记：卡片折叠行已经说了，别同话说两遍
  if (isAskSkipMarkerEvent(ev) || isAskExpireMarkerEvent(ev)) return true;
  // 后台 shell 运行 / 结束标记：只给 shell 块的转圈用（见 buildStreamItems），本身不是一行内容
  if (isShellBackgroundMarkerEvent(ev)) return true;
  // 提问挂着的 ask-wait curl：协议内部，不是用户要看的工作过程
  if (isAskWaitStreamEvent(ev)) return true;
  // 回合内工具失败误写成 kind=error（红卡留给整轮崩溃）
  if (isInTurnToolErrorEvent(ev)) return true;
  // 群问答 tab 的内容：非属主群问题 + 轮次汇总。主流程默认隐藏，切 tab 看。
  // 属主群消息（无 runTag）不在此列。
  if (isGroupQaQuestionEvent(ev) || isGroupQaSummaryEvent(ev)) return true;
  // 答疑旁路 run 的过程事件（meta.groupRun = runTag，不论 kind）：归「群问答」tab 的「查看过程」，
  // 不混进属主自己的会话。error 也在此列——它是别人提问触发的旁路 run 失败，不是属主自己运行的错误，
  // 属主主流不该被它吹爆（失败本身 tab 里该轮有「失败」标 + 过程里有 error 行）。
  // 「属主自己运行的错误永远可见」的既有原则不受影响：属主主链的事件不会带 groupRun。
  if (groupRunTagOf(ev) !== "") return true;
  if (opts?.isChat) {
    // 启动进度：ephemeral 的「状态」，由底部状态行单独呈现，不进事件流
    if (isChatStartupNoiseInfo(ev) || isBootStageInfo(ev)) {
      return true;
    }
  }
  return false;
};
