/**
 * 代码查看器的「按行」数据层（纯函数）
 *
 * Prism 的 tokenize 给的是跨行的 token 树（多行注释 / 模板字符串是一个 token）；
 * 查看器要「一行一个节点」才能做行号、虚拟列表、行内搜索高亮，所以这里把 token 树摊平并按换行切开。
 * 全程产出 React 可直接渲染的 {text,type} 段，不拼 HTML 字符串，也就没有 dangerouslySetInnerHTML。
 */

import { tokenize, type Grammar, type Token } from "prismjs";

/** 一小段同类文本；type 是空格分隔的 CSS 类名（`keyword`、`string template-string` …） */
export interface Segment {
  text: string;
  type?: string;
}

export interface MarkedSegment extends Segment {
  mark?: "hit" | "active";
}

/** 行拆分：LF / CRLF / CR 都认（混用换行的文件只读展示，不能留 \r） */
export const splitLines = (text: string): string[] => text.split(/\r\n|\n|\r/);

type PrismNode = string | Token;

const typeClass = (t: Token): string => {
  const alias = Array.isArray(t.alias) ? t.alias.join(" ") : t.alias;
  return alias ? `${t.type} ${alias}` : t.type;
};

/** 递归摊平 token 树：内层 token 的类型覆盖外层（模板字符串里的插值按插值着色） */
const flatten = (nodes: PrismNode[], inherited: string | undefined, out: Segment[]): void => {
  for (const node of nodes) {
    if (typeof node === "string") {
      if (node) out.push({ text: node, type: inherited });
      continue;
    }
    const cls = typeClass(node);
    const content = node.content;
    if (typeof content === "string") {
      if (content) out.push({ text: content, type: cls });
    } else if (Array.isArray(content)) {
      flatten(content as PrismNode[], cls, out);
    } else {
      flatten([content as PrismNode], cls, out);
    }
  }
};

/**
 * 文本 → 每行的段列表。grammar 为 null 时每行一个无类型段。
 * 行数 = splitLines(text).length（末尾换行会多出一个空行，与编辑器 / 行号口径一致）。
 */
export const tokenizeToLines = (text: string, grammar: Grammar | null): Segment[][] => {
  const normalized = text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
  if (!grammar) return normalized.split("\n").map((l) => [{ text: l }]);

  const flat: Segment[] = [];
  flatten(tokenize(normalized, grammar) as PrismNode[], undefined, flat);

  const lines: Segment[][] = [[]];
  for (const seg of flat) {
    const parts = seg.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ text: part, type: seg.type });
    });
  }
  return lines;
};

export interface LineMatch {
  line: number;
  start: number;
  end: number;
}

/** 在各行里找子串（不跨行）。命中数封顶，避免搜一个字母把 UI 拖垮 */
export const findMatches = (
  lines: readonly string[],
  query: string,
  caseSensitive: boolean,
  limit = 5000,
): { matches: LineMatch[]; capped: boolean } => {
  const matches: LineMatch[] = [];
  if (!query) return { matches, capped: false };
  const qLower = caseSensitive ? query : query.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const orig = lines[i]!;
    let hay = caseSensitive ? orig : orig.toLowerCase();
    let q = qLower;
    // 极个别字符（如 İ）小写后长度会变，命中偏移就和原文错位、高亮会画歪：这一行退回按原文精确匹配
    if (hay.length !== orig.length) {
      hay = orig;
      q = query;
    }
    let from = 0;
    for (;;) {
      const at = hay.indexOf(q, from);
      if (at === -1) break;
      if (matches.length >= limit) return { matches, capped: true };
      matches.push({ line: i, start: at, end: at + q.length });
      from = at + q.length;
    }
  }
  return { matches, capped: false };
};

/**
 * 把一行里的命中区间切进段里（区间按 start 升序、互不重叠，findMatches 的产出天然满足）。
 * 段被区间切开后各自保留原来的 type，高亮靠 mark 标记（渲染成 <mark>）。
 */
export const markSegments = (
  segments: readonly Segment[],
  ranges: readonly { start: number; end: number; active: boolean }[],
): MarkedSegment[] => {
  if (ranges.length === 0) return segments.map((s) => ({ ...s }));
  const out: MarkedSegment[] = [];
  let offset = 0;
  let ri = 0;
  for (const seg of segments) {
    const segStart = offset;
    const segEnd = offset + seg.text.length;
    let cursor = segStart;
    while (ri < ranges.length && ranges[ri]!.start < segEnd) {
      const r = ranges[ri]!;
      const from = Math.max(r.start, cursor);
      const to = Math.min(r.end, segEnd);
      if (from > cursor) out.push({ text: seg.text.slice(cursor - segStart, from - segStart), type: seg.type });
      if (to > from) {
        out.push({
          text: seg.text.slice(from - segStart, to - segStart),
          type: seg.type,
          mark: r.active ? "active" : "hit",
        });
      }
      cursor = Math.max(cursor, to);
      // 区间跨出本段：留给下一段继续切
      if (r.end > segEnd) break;
      ri++;
    }
    if (cursor < segEnd) out.push({ text: seg.text.slice(cursor - segStart), type: seg.type });
    offset = segEnd;
  }
  return out;
};

/** 超过这个字符数不做语法着色（Prism 同步 tokenize，几十万字符会卡住 UI 线程）；仍有行号 / 搜索 */
export const HIGHLIGHT_MAX_CHARS = 150_000;
/** 编辑器每次按键都要整体重新着色：上限比只读查看更低 */
export const EDIT_HIGHLIGHT_MAX_CHARS = 60_000;
