/**
 * 栏内搜索：纯文本 occurrence 索引（大小写不敏感）。高亮走 DOM CSS Highlight（lib/dom-text-search）
 */

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
  /**
   * 同一 (owner, field) 下的文本段序号（markdown 里每个可见文本节点一段；纯文本字段无此项）。
   * `start` 是**段内**偏移——一条回复有多段时，没有它的话每段的第一个命中身份都是 `(owner, field, 0)`，
   * 流式 / 新事件追加后按身份找回选中项会全部落到第一个同位命中（D3-01）。
   */
  segment?: number;
  start: number;
  end: number;
}

export interface SearchableField {
  ownerId: string;
  field: string;
  text: string;
  /** 见 {@link SearchOccurrence.segment}；markdown 分段索引时填 */
  segment?: number;
}

/** 命中的身份（跨重算稳定）：owner + field + 段序号 + 段内偏移 */
export const searchOccurrenceIdentity = (
  o: Pick<SearchOccurrence, "ownerId" | "field" | "segment" | "start">,
): string => `${o.ownerId}|${o.field}|${o.segment ?? -1}|${o.start}`;

/** 按字段顺序分配 globalIndex（与栏内导航计数一致） */
export const findOccurrencesInFields = (
  fields: readonly SearchableField[],
  query: string,
): SearchOccurrence[] => {
  const q = normalizePaneSearchQuery(query);
  if (!q) return [];
  const out: SearchOccurrence[] = [];
  let global = 0;
  for (const { ownerId, field, text, segment } of fields) {
    for (const range of findOccurrenceRanges(text, query)) {
      out.push({
        globalIndex: global,
        ownerId,
        field,
        ...(segment === undefined ? {} : { segment }),
        start: range.start,
        end: range.end,
      });
      global += 1;
    }
  }
  return out;
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
