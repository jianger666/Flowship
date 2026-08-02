/**
 * 栏内搜索：纯文本 occurrence 索引与高亮（大小写不敏感）
 */

import type { ReactNode } from "react";
import { createElement, Fragment } from "react";

export const normalizePaneSearchQuery = (query: string): string =>
  query.trim().toLowerCase();

export interface TextOccurrenceRange {
  start: number;
  end: number;
}

/** 非重叠 occurrence 区间（end 不含） */
export const findOccurrenceRanges = (
  text: string,
  query: string,
): TextOccurrenceRange[] => {
  const q = normalizePaneSearchQuery(query);
  if (!q || !text) return [];
  const lower = text.toLowerCase();
  const ranges: TextOccurrenceRange[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const found = lower.indexOf(q, cursor);
    if (found < 0) break;
    ranges.push({ start: found, end: found + q.length });
    cursor = found + q.length;
  }
  return ranges;
};

export const countOccurrences = (text: string, query: string): number =>
  findOccurrenceRanges(text, query).length;

export interface SearchOccurrence {
  globalIndex: number;
  ownerId: string;
  field: string;
  start: number;
  end: number;
}

export interface SearchableField {
  ownerId: string;
  field: string;
  text: string;
}

/** 按字段顺序分配 globalIndex（与栏内导航计数一致） */
export const findOccurrencesInFields = (
  fields: readonly SearchableField[],
  query: string,
): SearchOccurrence[] => {
  const q = normalizePaneSearchQuery(query);
  if (!q) return [];
  const out: SearchOccurrence[] = [];
  let global = 0;
  for (const { ownerId, field, text } of fields) {
    for (const range of findOccurrenceRanges(text, query)) {
      out.push({
        globalIndex: global,
        ownerId,
        field,
        start: range.start,
        end: range.end,
      });
      global += 1;
    }
  }
  return out;
};

export const SEARCH_MARK_ACTIVE_CLASS =
  "rounded-sm bg-amber-300/75 px-0.5 text-foreground ring-2 ring-amber-500/80 dark:bg-amber-500/50 dark:ring-amber-400/70";
export const SEARCH_MARK_CLASS =
  "rounded-sm bg-amber-200/85 px-0.5 text-foreground dark:bg-amber-500/35";

export const SEARCH_OCCURRENCE_ATTR = "data-search-occurrence";

/** 在指定 pane 根内定位 occurrence（禁止 document 全局 query） */
export const findSearchOccurrenceElement = (
  root: ParentNode | null | undefined,
  globalIndex: number,
): Element | null => {
  if (!root || globalIndex < 0) return null;
  return root.querySelector(`[${SEARCH_OCCURRENCE_ATTR}="${globalIndex}"]`);
};

export const scrollSearchOccurrenceIntoView = (
  root: ParentNode | null | undefined,
  globalIndex: number,
  options: ScrollIntoViewOptions = { block: "center", behavior: "smooth" },
): boolean => {
  const el = findSearchOccurrenceElement(root, globalIndex);
  if (!el) return false;
  el.scrollIntoView(options);
  return true;
};

export const highlightPlainText = (
  text: string,
  query: string,
  activeGlobalIndex: number,
  /** 本段文本第一个匹配的 globalIndex；-1 表示无匹配 */
  globalOffset: number,
): ReactNode => {
  const q = query.trim();
  if (!q || !text) return text;
  const ranges = findOccurrenceRanges(text, q);
  if (ranges.length === 0) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, i) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    const globalIndex = globalOffset >= 0 ? globalOffset + i : -1;
    const isActive =
      globalIndex >= 0 && activeGlobalIndex >= 0 && globalIndex === activeGlobalIndex;
    parts.push(
      createElement(
        "mark",
        {
          key: `s-${range.start}-${i}`,
          "data-search-occurrence":
            globalIndex >= 0 ? String(globalIndex) : undefined,
          className: isActive ? SEARCH_MARK_ACTIVE_CLASS : SEARCH_MARK_CLASS,
        },
        text.slice(range.start, range.end),
      ),
    );
    cursor = range.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length === 1 ? parts[0]! : createElement(Fragment, null, ...parts);
};

/** 本字段第一个 occurrence 的 globalIndex；无匹配返回 -1 */
export const firstGlobalIndexForField = (
  occurrences: readonly SearchOccurrence[],
  ownerId: string,
  field: string,
): number => {
  const hit = occurrences.find((o) => o.ownerId === ownerId && o.field === field);
  return hit?.globalIndex ?? -1;
};

export const stepOccurrenceIndex = (
  current: number,
  total: number,
  direction: "next" | "prev",
): number => {
  if (total <= 0) return -1;
  if (current < 0) return direction === "next" ? 0 : total - 1;
  if (direction === "next") return (current + 1) % total;
  return (current - 1 + total) % total;
};

export const stabilizeOccurrenceIndex = (
  prevIndex: number,
  total: number,
): number => {
  if (total <= 0) return -1;
  if (prevIndex >= 0 && prevIndex < total) return prevIndex;
  return 0;
};
