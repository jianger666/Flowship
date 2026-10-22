"use client";

/**
 * 事件流行内动作上下文（避开改 event-stream：由 ChatView 注入）
 *
 * 错误卡的「重试」需要「把最后一条用户消息原样再发」这个能力，而它住在 ChatView
 * （只有那里握着 ledger / 提交锁 / prepareRunArgs）。逐层往下传 prop 要动 event-stream
 * 的 props 与 itemContent——沿用 ComposerSessionProvider 同款做法：Context 注入。
 *
 * 无 Provider 时能力自动关闭、按钮不渲染（task 详情页、chat 页各自在上层注入）。
 */

import { createContext, useContext, type ReactNode } from "react";

import type { TaskEvent } from "@/lib/types";

export interface StreamActionsValue {
  /**
   * 重试上一轮：把触发失败那一轮的用户消息（含原图 / 原附件）原样再发。
   * 语义与「重新生成」一致——append-only、历史保留、不 fork 截断。
   *
   * `source` = 错误卡按 {@link resolveErrorRecovery} 判定出的那条触发消息（要重发的就是它）；
   * 不传才退回「最后一条用户消息」。没有可重试的消息时调用方自行 no-op。
   */
  onRetryLastMessage?: (source?: TaskEvent) => void | Promise<void>;
  /**
   * 重新推进：推进失败 / action 跑挂的错误卡用（重放用户消息对这类失败没有意义）。
   * 只有 task 详情页注入（chat 没有「推进」）；调用方负责校验当前能不能推进（运行中 / 终态 / 等提问）。
   */
  onReadvance?: () => void;
  /**
   * 把文本放回输入框（前置到现有草稿前、聚焦）：排队消息被丢（V3-05）时用。
   * 只有握着输入框草稿的一层（chat 的 EventStream）注入；没有输入框就不注入、卡片不画这个按钮。
   */
  onRestoreDraft?: (text: string) => void;
}

const StreamActionsContext = createContext<StreamActionsValue | null>(null);

export const StreamActionsProvider = ({
  value,
  children,
}: {
  value: StreamActionsValue;
  children: ReactNode;
}) => (
  <StreamActionsContext.Provider value={value}>
    {children}
  </StreamActionsContext.Provider>
);

export const useStreamActions = (): StreamActionsValue | null =>
  useContext(StreamActionsContext);
