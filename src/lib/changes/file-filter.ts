/**
 * 代码改动面板的文件搜索过滤：纯逻辑层（无 React、无 DOM）。
 *
 * 语义：输入按空白切成多个词，所有词都要在 path 里出现（AND），大小写不敏感的子串匹配。
 * 比单个整串匹配更顺手——`lib diff ts` 能同时命中 `src/lib/diff-syntax.ts`，不必记完整顺序。
 *
 * 高亮偏移为什么不能直接用 `toLowerCase()` 后的下标：
 *   大小写转换可能改变字符串长度（`"İ".toLowerCase()` 是两个码元 `i̇`），
 *   在小写串里找到的下标拿回原串切片会整体错位。
 *   所以 matchRanges 逐位置在**原串**上比较：每个原字符单独转小写后与词对齐，
 *   返回的区间永远是原 path 的偏移。
 */

/** 用户输入 → 小写词表（按空白切、去空；全空返回 []） */
export const parseFileQuery = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

/** 所有词都要在 path 里出现（大小写不敏感的子串匹配）；词表为空 = true */
export const matchesFileQuery = (path: string, terms: readonly string[]): boolean => {
  if (terms.length === 0) return true;
  const lower = path.toLowerCase();
  return terms.every((t) => {
    const term = t.toLowerCase();
    // 空词视为不约束（防御：调用方没经过 parseFileQuery 时可能混进 ""）
    if (term.length === 0) return true;
    return lower.includes(term);
  });
};

/** 码点宽度：代理对占两个码元 */
const cpWidth = (path: string, index: number): number => {
  const cp = path.codePointAt(index);
  return cp !== undefined && cp > 0xffff ? 2 : 1;
};

/**
 * 在 path 的 start 位置尝试匹配 term（term 已小写），成功返回原串里的结束偏移，否则 -1。
 * 逐个原字符转小写后与 term 对齐；若 term 恰好在某个字符的小写展开中间结束（如词 `i` 对 `İ`），
 * 也算命中并覆盖整个原字符——与 `lower.includes(term)` 的命中集合保持一致，避免「匹配上了却没高亮」。
 */
const matchAt = (path: string, start: number, term: string): number => {
  let k = start;
  let j = 0;
  while (j < term.length) {
    if (k >= path.length) return -1;
    const w = cpWidth(path, k);
    const lc = path.slice(k, k + w).toLowerCase();
    const rest = term.length - j;
    if (lc.length <= rest) {
      if (!term.startsWith(lc, j)) return -1;
      j += lc.length;
    } else {
      // term 剩余部分比该字符的小写展开短：只要是它的前缀就算命中
      if (!lc.startsWith(term.slice(j))) return -1;
      j = term.length;
    }
    k += w;
  }
  return k;
};

/**
 * 用于高亮命中片段：返回合并后的升序不重叠 `[start, end)` 区间
 * （大小写不敏感，偏移基于原 path；重叠与相邻的区间会合并）。
 */
export const matchRanges = (path: string, terms: readonly string[]): Array<[number, number]> => {
  const raw: Array<[number, number]> = [];
  for (const t of terms) {
    const term = t.toLowerCase();
    if (term.length === 0) continue;
    for (let i = 0; i < path.length; i += cpWidth(path, i)) {
      const end = matchAt(path, i, term);
      if (end > i) raw.push([i, end]);
    }
  }
  if (raw.length === 0) return [];
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [[raw[0][0], raw[0][1]]];
  for (let n = 1; n < raw.length; n++) {
    const last = merged[merged.length - 1];
    const [s, e] = raw[n];
    if (s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
};
