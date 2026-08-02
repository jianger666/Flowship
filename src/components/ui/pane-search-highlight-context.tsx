"use client";

import { createContext, useContext } from "react";

import type { SearchOccurrence } from "@/lib/text-search-highlight";
import { firstGlobalIndexForField } from "@/lib/text-search-highlight";

export interface PaneSearchHighlightValue {
  query: string;
  activeGlobalIndex: number;
  occurrences: readonly SearchOccurrence[];
  /** 至少有一个 occurrence 的 ownerId（供折叠行 / 工作过程组强制展开） */
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

/** 某 owner+field 的首个 globalIndex（供 Markdown / 纯文本高亮） */
export const useSearchFieldGlobalOffset = (
  ownerId: string,
  field: string,
): { query: string; activeGlobalIndex: number; globalOffset: number } | null => {
  const ctx = usePaneSearchHighlight();
  if (!ctx || !ctx.query.trim()) return null;
  const globalOffset = firstGlobalIndexForField(
    ctx.occurrences,
    ownerId,
    field,
  );
  if (globalOffset < 0) return null;
  return {
    query: ctx.query,
    activeGlobalIndex: ctx.activeGlobalIndex,
    globalOffset,
  };
};
