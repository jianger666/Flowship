"use client";

import type { ReactNode } from "react";

import { useSearchFieldGlobalOffset } from "@/components/ui/pane-search-highlight-context";
import { highlightPlainText } from "@/lib/text-search-highlight";

interface Props {
  ownerId: string;
  field: string;
  text: string;
  className?: string;
}

/** 纯文本 + 栏内搜索 mark 高亮（保留 whitespace-pre-wrap 由 className 控制） */
export const SearchHighlightText = ({
  ownerId,
  field,
  text,
  className,
}: Props): ReactNode => {
  const highlight = useSearchFieldGlobalOffset(ownerId, field);
  const content = highlight
    ? highlightPlainText(
        text,
        highlight.query,
        highlight.activeGlobalIndex,
        highlight.globalOffset,
      )
    : text;
  // data-search-content 把可搜索正文和时间、类型标签、操作按钮等行级 UI 隔开。
  // DOM 搜索据此只计算用户真正期望搜索的正文。
  return (
    <span data-search-content="true" className={className}>
      {content}
    </span>
  );
};
