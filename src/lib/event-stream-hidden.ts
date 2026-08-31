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
import { isInTurnToolErrorEvent } from "@/lib/tool-display";
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
  // 提问挂着的 ask-wait curl：协议内部，不是用户要看的工作过程
  if (isAskWaitStreamEvent(ev)) return true;
  // 回合内工具失败误写成 kind=error（红卡留给整轮崩溃）
  if (isInTurnToolErrorEvent(ev)) return true;
  if (opts?.isChat) {
    if (isChatStartupNoiseInfo(ev) || isBootStageInfo(ev)) return true;
  }
  return false;
};
