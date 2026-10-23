/**
 * diff 词级（intra-line）高亮：纯逻辑层（无 React、无 DOM）。
 *
 * 为什么要做词级：
 *   整行红 / 绿只能告诉读者「这一行变了」，一对被修改的行里真正改了哪几个词仍要肉眼比对。
 *   GitHub 的做法是在整行底色之上，只把变了的词用更深的底色标出来，这里照此实现。
 *
 * 为什么按「token」而不是按字符 diff：
 *   字符级 diff 会把 `foo` → `bar` 拆成零碎的字母对齐（碰巧共有的 `o`、`a` 被判为未变），
 *   读起来是碎的；按「词 / 空白 / 单个标点」切开后，变化边界天然落在词边界上。
 *   CJK 没有空格分词，一整句中文会变成一个「词」，所以汉字 / 假名 / 韩文逐字成 token。
 *
 * 为什么要做语义清理与相似度保护：
 *   - 相邻两处改动之间只夹着 `, ` 之类的标点，分开标会出现「深-浅-深」的斑点，合并后更连贯；
 *   - 改动区间两端带的空格没有信息量，收掉；但纯空白的改动（缩进变了）本身就是改动，要保留；
 *   - 两行几乎没有共同内容时，满行深色没有信息量，直接返回 null，渲染端只做整行着色。
 *
 * 为什么有规模上限：
 *   diffArrays 最坏 O(N*D)，压缩后的超长行（minified 代码、lock 文件）会卡主线程，
 *   词级高亮只是锦上添花，超限就放弃。配对 DP 同理（m*n 上限）。
 *
 * 所有偏移都是 UTF-16 code unit 偏移（与 `String.prototype.slice` 一致），渲染端可直接 slice。
 */

import { diffArrays } from "diff";

import type { DiffSyntaxToken } from "@/lib/diff-syntax";
import { isNoNewlineMarker } from "@/lib/diff/marker";
import type { DiffViewLine } from "@/lib/tool-display";

/** [start, end) 的 UTF-16 code unit 偏移，基于传入的那一行文本 */
export interface InlineRange {
  start: number;
  end: number;
}

// ---------- 规模与阈值 ----------

/** 单行最大长度（UTF-16 单元）：超过则不做词级 diff */
const MAX_LINE_LENGTH = 2000;
/** 单侧最大 token 数：超过则不做词级 diff */
const MAX_TOKENS = 800;
/** 相似度下限：未变字符占比低于它说明整行都被重写了 */
const MIN_SIMILARITY = 0.35;
/** 合并相邻 range 时，中间夹着的「纯标点 / 空白」最长允许多少字符 */
const MERGE_GAP_MAX_CHARS = 2;
/** 不等长块配对：m*n 超过它就不配对（DP 是 O(m*n) 且每格要算 bigram） */
export const PAIR_MAX_CELLS = 900;
/** 不等长块配对：bigram Dice 系数达到它才允许配成一对 */
const PAIR_MIN_SIMILARITY = 0.5;
/**
 * 一次 computeIntralineRanges 里最多对多少字符做词级 diff（每对两侧长度之和累计）。
 * 单对有行长 / token 数上限，但几千行改写的大 diff 加起来仍会拖慢主线程；
 * 用完后面的块只做整行着色（渲染端对没有 range 的行本来就是这么处理的）。
 * 20 万字符 ≈ 一千多对常见长度的行，正常改动远用不到。
 */
export const INTRALINE_TOTAL_BUDGET = 200_000;

// ---------- 字符分类 ----------

const WORD_CHAR_RE = /^[\p{L}\p{N}_$]$/u;
const HAS_WORD_CHAR_RE = /[\p{L}\p{N}_$]/u;
const CJK_CHAR_RE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const SPACE_CHAR_RE = /^\s$/u;

type CharClass = "word" | "space" | "other";

/** CJK 归为 other：它们必须逐字成 token，不能像拉丁字母那样黏成「词」 */
const classify = (ch: string): CharClass => {
  if (CJK_CHAR_RE.test(ch)) return "other";
  if (WORD_CHAR_RE.test(ch)) return "word";
  if (SPACE_CHAR_RE.test(ch)) return "space";
  return "other";
};

/**
 * 文本 -> token：词 / 空白 / 单个标点；`join("")` 恒等于原文。
 *
 * 连续的词字符（`\p{L}` `\p{N}` `_` `$`）合为一个 token，连续空白合为一个 token，
 * 其余（标点、符号、CJK 字符）每个字符一个 token。
 * 按 code point 迭代，emoji 等代理对不会被拆成两个半个 code unit。
 */
export const tokenizeForDiff = (text: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let currentClass: CharClass = "other";
  for (const ch of text) {
    const cls = classify(ch);
    if (current !== "" && cls === currentClass && cls !== "other") {
      current += ch;
      continue;
    }
    if (current !== "") tokens.push(current);
    current = ch;
    currentClass = cls;
  }
  if (current !== "") tokens.push(current);
  return tokens;
};

// ---------- 单对行的词级差异 ----------

/** 去掉行尾的 `\r`（CRLF 文件）：它不是可见内容，既不参与 diff 也不能被标记 */
const stripTrailingCr = (text: string): string => text.replace(/\r+$/, "");

/** 往 range 列表追加一段；与上一段首尾相接就并入，保持升序且不重叠 */
const pushRange = (list: InlineRange[], start: number, end: number): void => {
  if (start >= end) return;
  const last = list[list.length - 1];
  if (last && last.end === start) {
    last.end = end;
    return;
  }
  list.push({ start, end });
};

/**
 * 语义清理 a)：相邻两个 range 之间若只夹着很短的纯标点 / 空白（如 `, `、` + `、`.`），合并成一个。
 * 否则 `f(a, b)` -> `f(x, y)` 会标成「a」「b」两个孤立的点，读起来不如整段 `a, b` 连贯。
 */
const mergeCloseRanges = (
  ranges: readonly InlineRange[],
  text: string,
): InlineRange[] => {
  const out: InlineRange[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last) {
      const gap = text.slice(last.end, r.start);
      if (gap.length <= MERGE_GAP_MAX_CHARS && !HAS_WORD_CHAR_RE.test(gap)) {
        last.end = r.end;
        continue;
      }
    }
    out.push({ start: r.start, end: r.end });
  }
  return out;
};

/**
 * 语义清理 b)：range 首尾的空白收掉，高亮不带多余空格。
 * 整段都是空白（缩进变了）时保留原样：缩进变化本身就是有意义的改动，收掉就没东西可标了。
 */
const trimRangeWhitespace = (
  ranges: readonly InlineRange[],
  text: string,
): InlineRange[] =>
  ranges.map(({ start, end }) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text.charAt(s))) s += 1;
    if (s === e) return { start, end };
    while (e > s && /\s/.test(text.charAt(e - 1))) e -= 1;
    return { start: s, end: e };
  });

const cleanRanges = (
  ranges: readonly InlineRange[],
  text: string,
): InlineRange[] => trimRangeWhitespace(mergeCloseRanges(ranges, text), text);

const sumLength = (tokens: readonly string[]): number => {
  let n = 0;
  for (const t of tokens) n += t.length;
  return n;
};

/**
 * 廉价预检（不分词、不 diff）：两行字符多重集的交集大小，是它们公共内容的严格上界
 * （公共子序列不可能比「共有的字符个数」更长，词级的「未变字符」又是公共子序列的一部分）。
 * 连这个上界都够不到相似度下限，后面的相似度保护必然会拒掉它——不必白做分词和 diffArrays。
 * 只提前拒绝「反正会被拒」的，不改变任何结果（性质测试钉死：预检拒绝 ⇒ diffLineWords 为 null）。
 * 入参应是已去掉行尾 `\r` 的文本（与 diffLineWords 内部一致）。
 */
export const mayBeSimilar = (a: string, b: string): boolean => {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return false;
  const counts = new Map<number, number>();
  for (let i = 0; i < a.length; i += 1) {
    const c = a.charCodeAt(i);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length; i += 1) {
    const c = b.charCodeAt(i);
    const left = counts.get(c);
    if (left !== undefined && left > 0) {
      shared += 1;
      counts.set(c, left - 1);
    }
  }
  return shared / maxLen >= MIN_SIMILARITY;
};

/**
 * 一对行的词级差异。返回 null = 不值得标（两行相同 / 相似度过低整行都变了 / 超出规模上限）。
 *
 * 行尾 `\r` 不参与 diff，range 的偏移基于「去掉尾部 `\r` 之后的文本」（与原文前缀一致）。
 * 返回的 range 升序、互不重叠、非空、`end` 不超过对应文本长度（不含行尾 `\r`）。
 */
export const diffLineWords = (
  oldText: string,
  newText: string,
): { old: InlineRange[]; new: InlineRange[] } | null => {
  const a = stripTrailingCr(oldText);
  const b = stripTrailingCr(newText);
  if (a === b) return null;
  if (a.length > MAX_LINE_LENGTH || b.length > MAX_LINE_LENGTH) return null;
  if (!mayBeSimilar(a, b)) return null;

  const aTokens = tokenizeForDiff(a);
  const bTokens = tokenizeForDiff(b);
  if (aTokens.length > MAX_TOKENS || bTokens.length > MAX_TOKENS) return null;

  // 快速路径：先裁公共前后缀，大多数「改了一两个词」的行中间只剩几个 token
  const minLen = Math.min(aTokens.length, bTokens.length);
  let prefix = 0;
  while (prefix < minLen && aTokens[prefix] === bTokens[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    aTokens[aTokens.length - 1 - suffix] === bTokens[bTokens.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const prefixLen = sumLength(aTokens.slice(0, prefix));
  const suffixLen = sumLength(aTokens.slice(aTokens.length - suffix));
  const aMid = aTokens.slice(prefix, aTokens.length - suffix);
  const bMid = bTokens.slice(prefix, bTokens.length - suffix);

  const oldRanges: InlineRange[] = [];
  const newRanges: InlineRange[] = [];
  let common = prefixLen + suffixLen;
  let oldPos = prefixLen;
  let newPos = prefixLen;

  if (aMid.length > 0 || bMid.length > 0) {
    for (const part of diffArrays(aMid, bMid)) {
      const len = sumLength(part.value);
      if (part.added) {
        pushRange(newRanges, newPos, newPos + len);
        newPos += len;
      } else if (part.removed) {
        pushRange(oldRanges, oldPos, oldPos + len);
        oldPos += len;
      } else {
        common += len;
        oldPos += len;
        newPos += len;
      }
    }
  }

  // 相似度保护：几乎没有共同内容时满行深色没有信息量
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0 || common / maxLen < MIN_SIMILARITY) return null;

  const old = cleanRanges(oldRanges, a);
  const next = cleanRanges(newRanges, b);
  if (old.length === 0 && next.length === 0) return null;
  return { old, new: next };
};

// ---------- 删除块 / 新增块的配对 ----------

/** 字符 bigram 多重集（按 code point，避免把代理对拆开） */
const bigramCounts = (text: string): Map<string, number> => {
  const chars = Array.from(text);
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const key = chars[i] + chars[i + 1];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

/**
 * 两行的字符 bigram Dice 系数（0..1）。
 * 先去掉首尾空白再比：缩进相同的两行不该仅因为一排空格就显得相似。
 * 极短文本（不足 2 个字符，没有 bigram）：相同视为 1，否则 0。
 */
const lineSimilarity = (x: string, y: string): number => {
  const a = x.trim();
  const b = y.trim();
  if (a === b) return 1;
  if (Array.from(a).length < 2 || Array.from(b).length < 2) return 0;
  const ca = bigramCounts(a);
  const cb = bigramCounts(b);
  let totalA = 0;
  let totalB = 0;
  let shared = 0;
  for (const n of ca.values()) totalA += n;
  for (const n of cb.values()) totalB += n;
  for (const [key, n] of ca) shared += Math.min(n, cb.get(key) ?? 0);
  return (2 * shared) / (totalA + totalB);
};

/**
 * 一个删除块与紧随其后的新增块的配对：返回 (del 下标, add 下标) 对，两个下标都严格递增。
 *
 * - 两边等长：无条件按序一一配对（与 GitHub 一致，等长基本就是逐行改写）。
 * - 不等长：m*n 不超过 900 时用 bigram Dice 相似度做单调对齐 DP（类似 LCS，
 *   只有相似度 >= 0.5 的对才允许配对），取总相似度最大的配对集合；超过则不配对。
 */
export const pairChangeBlock = (
  dels: readonly string[],
  adds: readonly string[],
): Array<{ del: number; add: number }> => {
  const m = dels.length;
  const n = adds.length;
  if (m === 0 || n === 0) return [];

  if (m === n) {
    return dels.map((_, i) => ({ del: i, add: i }));
  }
  if (m * n > PAIR_MAX_CELLS) return [];

  // sim[i][j]：dels[i] 与 adds[j] 的相似度；不达标记 0（等价于禁止配对）
  const sim: number[][] = [];
  for (let i = 0; i < m; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < n; j += 1) {
      const del = dels[i] ?? "";
      const add = adds[j] ?? "";
      // 超长行（minified / 锁文件）：逐字符 bigram 太贵，而且 diffLineWords 本来就不给它标词级——不配对
      const s =
        del.length > MAX_LINE_LENGTH || add.length > MAX_LINE_LENGTH ? 0 : lineSimilarity(del, add);
      row.push(s >= PAIR_MIN_SIMILARITY ? s : 0);
    }
    sim.push(row);
  }

  const dp: number[][] = [];
  for (let i = 0; i <= m; i += 1) dp.push(new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const s = sim[i - 1]?.[j - 1] ?? 0;
      const best = Math.max(dp[i - 1]?.[j] ?? 0, dp[i]?.[j - 1] ?? 0);
      const row = dp[i];
      if (row) {
        row[j] = s > 0 ? Math.max(best, (dp[i - 1]?.[j - 1] ?? 0) + s) : best;
      }
    }
  }

  // 回溯：优先走对角线（配对），保证同分时尽量多配
  const pairs: Array<{ del: number; add: number }> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const cur = dp[i]?.[j] ?? 0;
    const s = sim[i - 1]?.[j - 1] ?? 0;
    if (s > 0 && cur === (dp[i - 1]?.[j - 1] ?? 0) + s) {
      pairs.push({ del: i - 1, add: j - 1 });
      i -= 1;
      j -= 1;
    } else if (cur === (dp[i - 1]?.[j] ?? 0)) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return pairs.reverse();
};

// ---------- 整份可见行序列 ----------

/**
 * 整份可见行序列 -> 每行的词级 range。
 *
 * 块 = 连续的 del 行 + 紧随其后的连续 add 行（context / hunk 行会打断块）；
 * 只有 del 或只有 add 的块没有可比对的另一侧，不处理。
 * 返回 Map<lines 下标, InlineRange[]>，只包含有 range 的行：
 * 旧侧范围挂在 del 行下标上、新侧范围挂在 add 行下标上。
 */
export const computeIntralineRanges = (
  lines: readonly DiffViewLine[],
): Map<number, InlineRange[]> => {
  const result = new Map<number, InlineRange[]>();
  let budget = INTRALINE_TOTAL_BUDGET;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.kind !== "del") {
      i += 1;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i]?.kind === "del") i += 1;
    const delEnd = i;
    // 旧侧最后一行没有结尾换行时，git 会在删行后面插一条标记再接增行：标记属于前面那一行，
    // 不能当成「上下文」把「删 → 增」切开，否则「最后一行被改 + 无结尾换行」就配不上对、没有词级高亮
    const marker = lines[i];
    if (delEnd > delStart && marker && isNoNewlineMarker(marker)) i += 1;
    const addStart = i;
    while (i < lines.length && lines[i]?.kind === "add") i += 1;
    const delCount = delEnd - delStart;
    const addCount = i - addStart;
    if (addCount === 0) continue;

    const dels = lines.slice(delStart, delEnd).map((l) => l.text);
    const adds = lines.slice(addStart, i).map((l) => l.text);
    for (const pair of pairChangeBlock(dels, adds)) {
      if (pair.del >= delCount || pair.add >= addCount) continue;
      const a = dels[pair.del] ?? "";
      const b = adds[pair.add] ?? "";
      // 反正会被拒的（超长 / 相似度上界不够）既不花时间也不占预算
      if (
        a.length > MAX_LINE_LENGTH ||
        b.length > MAX_LINE_LENGTH ||
        !mayBeSimilar(stripTrailingCr(a), stripTrailingCr(b))
      ) {
        continue;
      }
      budget -= a.length + b.length;
      // 预算用完：后面的块只做整行着色，已经算出的照常返回
      if (budget < 0) return result;
      const diff = diffLineWords(a, b);
      if (!diff) continue;
      if (diff.old.length > 0) result.set(delStart + pair.del, diff.old);
      if (diff.new.length > 0) result.set(addStart + pair.add, diff.new);
    }
  }
  return result;
};

// ---------- 语法 token 与词级 range 的叠加 ----------

/** 叠加后的片段：语法样式 + 是否落在词级高亮范围内 */
export interface OverlaySegment extends DiffSyntaxToken {
  mark?: boolean;
}

/** 夹到 [0, length]、丢掉空段、排序并合并重叠 / 相接的 range；永远不抛错 */
const normalizeRanges = (
  ranges: readonly InlineRange[],
  length: number,
): InlineRange[] => {
  const clamped: InlineRange[] = [];
  for (const r of ranges) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) continue;
    const start = Math.max(0, Math.floor(r.start));
    const end = Math.min(length, Math.floor(r.end));
    if (start < end) clamped.push({ start, end });
  }
  clamped.sort((x, y) => x.start - y.start || x.end - y.end);
  const merged: InlineRange[] = [];
  for (const r of clamped) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
};

/**
 * 把语法高亮 token（可空）与词级 range 叠加，渲染端据此输出 `<span>`。
 * 拼接所有 segment 的 content 恒等于 `text`。
 *
 * - tokens 为空 / null，或拼起来与 text 不一致：退化成单个无色 token。
 *   宁可丢颜色，也不能让渲染出的文字与源码不一致。
 * - ranges 为空：原样返回 token（不额外加 `mark: false`）。
 * - 否则在 range 边界处切开 token；range 内的片段 `mark: true` 并保留原 token 的样式。
 */
export const overlayRanges = (
  text: string,
  tokens: readonly DiffSyntaxToken[] | null | undefined,
  ranges: readonly InlineRange[] | undefined,
): OverlaySegment[] => {
  if (text === "") return [];

  let base: readonly DiffSyntaxToken[] = [{ content: text }];
  if (tokens && tokens.length > 0) {
    let joined = "";
    for (const t of tokens) joined += t.content;
    if (joined === text) base = tokens;
  }

  const marks = ranges && ranges.length > 0 ? normalizeRanges(ranges, text.length) : [];
  if (marks.length === 0) return base.map((t) => ({ ...t }));

  const out: OverlaySegment[] = [];
  let pos = 0; // 当前 token 在 text 中的起点
  let ri = 0; // 第一个可能与当前 token 相交的 range
  for (const token of base) {
    const tokenEnd = pos + token.content.length;
    if (token.content === "") continue;

    // 已经整个落在当前 token 之前的 range 不会再用到
    while (ri < marks.length && (marks[ri]?.end ?? 0) <= pos) ri += 1;

    let cursor = pos;
    for (let k = ri; k < marks.length; k += 1) {
      const r = marks[k];
      if (!r || r.start >= tokenEnd) break;
      const from = Math.max(r.start, pos);
      const to = Math.min(r.end, tokenEnd);
      if (from > cursor) {
        out.push({ ...token, content: text.slice(cursor, from) });
      }
      out.push({ ...token, content: text.slice(from, to), mark: true });
      cursor = to;
    }
    if (cursor < tokenEnd) {
      out.push({ ...token, content: text.slice(cursor, tokenEnd) });
    }
    pos = tokenEnd;
  }
  return out;
};
