/**
 * 栏内搜索：纯文本 occurrence 索引（大小写不敏感）。高亮走 DOM CSS Highlight（lib/dom-text-search）
 */

export const normalizePaneSearchQuery = (query: string): string =>
  query.trim().toLowerCase();

export interface TextOccurrenceRange {
  start: number;
  end: number;
}

/**
 * 小写化后的文本 + 「小写码元 → 原文区间」映射。
 * `toLowerCase()` 可能改变长度（`"İ"`（U+0130）小写成两个码元 `i̇`），此时小写串里的下标不能直接当原文偏移用
 * （DOM 高亮 / 导航定位会整体错位）。长度没变时 starts / ends 为 null（下标一一对应、零额外开销）。
 */
const lowerWithOffsetMap = (
  text: string,
): { lower: string; starts: number[] | null; ends: number[] | null } => {
  const whole = text.toLowerCase();
  if (whole.length === text.length) return { lower: whole, starts: null, ends: null };
  // 逐码点小写：每个小写码元记下它来自原文哪个码点（[start, end)）
  let lower = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i) as number);
    const lc = ch.toLowerCase();
    for (let k = 0; k < lc.length; k += 1) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    lower += lc;
    i += ch.length;
  }
  return { lower, starts, ends };
};

/** 非重叠 occurrence 区间（end 不含；偏移都是**原文**的码元下标） */
export const findOccurrenceRanges = (
  text: string,
  query: string,
): TextOccurrenceRange[] => {
  const q = normalizePaneSearchQuery(query);
  if (!q || !text) return [];
  const { lower, starts, ends } = lowerWithOffsetMap(text);
  const ranges: TextOccurrenceRange[] = [];
  let cursor = 0;
  // 原文空间里上一个命中的结束位置：命中落在同一个展开字符（İ）内部时避免区间重叠
  let lastEnd = 0;
  while (cursor < lower.length) {
    const found = lower.indexOf(q, cursor);
    if (found < 0) break;
    const matchEnd = found + q.length;
    const start = starts ? starts[found] : found;
    const end = ends ? ends[matchEnd - 1] : matchEnd;
    if (start >= lastEnd) {
      ranges.push({ start, end });
      lastEnd = end;
    }
    cursor = matchEnd;
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
