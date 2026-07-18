"use client";

/**
 * Composer 会话上下文（避开改 event-stream：由 ChatView / TaskTalkComposer 注入）
 *
 * 承载 `@` 引用 / ↑ 输入历史 / 未绑仓警示所需的 task 侧数据。
 * Composer 内部可选消费；无 Provider 时三项能力全部关闭。
 */

import { createContext, useContext, type ReactNode } from "react";

import type { TaskEvent } from "@/lib/types";

export interface ComposerSessionValue {
  taskId: string;
  repoPaths: string[];
  /**
   * 本会话历史输入（user_reply 的 text），**新→旧**（↑ 先翻最近一条）。
   * 切会话时 Provider 重挂 / value 换 taskId，composer 内游标自行重置。
   */
  inputHistory: string[];
  /** chat + 未绑仓时显示警示条 */
  showUnboundBanner?: boolean;
  /** 警示条「绑定」——通常打开 ChatWorkdirPicker */
  onBindWorkdir?: () => void;
}

const ComposerSessionContext = createContext<ComposerSessionValue | null>(
  null,
);

export const ComposerSessionProvider = ({
  value,
  children,
}: {
  value: ComposerSessionValue;
  children: ReactNode;
}) => (
  <ComposerSessionContext.Provider value={value}>
    {children}
  </ComposerSessionContext.Provider>
);

export const useComposerSession = (): ComposerSessionValue | null =>
  useContext(ComposerSessionContext);

/** 从 events 抽 user_reply 文本，新→旧、去空、连续相同去重 */
export const buildInputHistory = (events: TaskEvent[]): string[] => {
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind !== "user_reply") continue;
    const t = (ev.text ?? "").trim();
    if (!t) continue;
    if (out.length > 0 && out[out.length - 1] === t) continue;
    out.push(t);
  }
  return out;
};
