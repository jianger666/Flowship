"use client";

/**
 * 事件流行内动作上下文（避开改 event-stream：由 ChatView 注入）
 *
 * 错误卡的「重试」需要「把最后一条用户消息原样再发」这个能力，而它住在 ChatView
 * （只有那里握着 ledger / 提交锁 / prepareRunArgs）。逐层往下传 prop 要动 event-stream
 * 的 props 与 itemContent——沿用 ComposerSessionProvider 同款做法：Context 注入。
 *
 * 无 Provider（如 task 详情页的 log 形态）时能力自动关闭、按钮不渲染。
 */

import { createContext, useContext, type ReactNode } from "react";

export interface StreamActionsValue {
  /**
   * 重试上一轮：把最后一条用户消息（含原图 / 原附件）原样再发。
   * 语义与「重新生成」一致——append-only、历史保留、不 fork 截断。
   * 没有可重试的消息时调用方自行 no-op。
   */
  onRetryLastMessage?: () => void | Promise<void>;
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
