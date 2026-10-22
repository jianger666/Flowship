"use client";

import type { ReactNode } from "react";

interface Props {
  /** 保留给调用点自述「这段文本属于哪个 owner / 字段」；高亮由 DOM 搜索按 data-search-owner-id 统一做 */
  ownerId?: string;
  field?: string;
  text: string;
  className?: string;
}

/**
 * 纯文本正文容器（保留 whitespace-pre-wrap 由 className 控制）。
 * data-search-content 把可搜索正文和时间、类型标签、操作按钮等行级 UI 隔开，
 * DOM 搜索据此只计算用户真正期望搜索的正文。
 */
export const SearchHighlightText = ({ text, className }: Props): ReactNode => (
  <span data-search-content="true" className={className}>
    {text}
  </span>
);
