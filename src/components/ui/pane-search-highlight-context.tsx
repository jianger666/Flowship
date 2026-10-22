"use client";

import { createContext, useContext } from "react";

/**
 * 栏内搜索上下文：只带「模型有命中的 owner 集合」（供折叠行 / 工作过程组强制展开）。
 * 文本高亮统一走 DOM 的 CSS Custom Highlight（lib/dom-text-search），这里不再带 query / occurrences——
 * 旧的行内 `<mark>` 管线（rehype 插件 + highlightPlainText）在 src 内早已零调用，D3-07 已清掉。
 */
export interface PaneSearchHighlightValue {
  /** 至少有一个 occurrence 的 ownerId */
  hitOwnerIds: ReadonlySet<string>;
}

const PaneSearchHighlightContext = createContext<PaneSearchHighlightValue | null>(
  null,
);

export const PaneSearchHighlightProvider = PaneSearchHighlightContext.Provider;

export const usePaneSearchHighlight = (): PaneSearchHighlightValue | null =>
  useContext(PaneSearchHighlightContext);

export const useOwnerHasSearchHit = (ownerId: string): boolean => {
  const ctx = usePaneSearchHighlight();
  return Boolean(ctx?.hitOwnerIds.has(ownerId));
};
