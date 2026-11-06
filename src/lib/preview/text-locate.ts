/**
 * 在「一串文本节点」里找子串（纯函数，文档查找用）
 *
 * 渲染后的文档（markdown / docx）的文本被拆在许多 DOM 文本节点里（粗体、链接、行内代码各占一个），
 * 一个查询词可能横跨几个节点。这里把节点文本拼起来搜，再把命中区间映回「第几个节点的第几个字符」，
 * 调用方据此造 DOM Range 交给 CSS Custom Highlight。DOM 部分在 hooks，这里不碰 DOM，所以能在 node 里测。
 */

export interface NodeMatch {
  startNode: number;
  startOffset: number;
  endNode: number;
  /** 开区间末端：在 endNode 内的字符偏移（exclusive） */
  endOffset: number;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const locateMatches = (
  nodeTexts: readonly string[],
  query: string,
  caseSensitive = false,
  limit = 1000,
): { matches: NodeMatch[]; capped: boolean } => {
  if (!query) return { matches: [], capped: false };

  // 只保留非空节点，starts[k] = 第 k 个非空节点在拼接串里的起点；origin[k] = 它在 nodeTexts 里的下标
  const starts: number[] = [];
  const origin: number[] = [];
  let hay = "";
  for (let i = 0; i < nodeTexts.length; i++) {
    const t = nodeTexts[i]!;
    if (!t) continue;
    starts.push(hay.length);
    origin.push(i);
    hay += t;
  }

  // 二分：最后一个 starts[k] <= pos 的 k
  const nodeAt = (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const re = new RegExp(escapeRegExp(query), caseSensitive ? "g" : "gi");
  const matches: NodeMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(hay)) !== null) {
    if (matches.length >= limit) return { matches, capped: true };
    const s = m.index;
    const e = s + m[0].length;
    const a = nodeAt(s);
    const b = nodeAt(e - 1);
    matches.push({
      startNode: origin[a]!,
      startOffset: s - starts[a]!,
      endNode: origin[b]!,
      endOffset: e - starts[b]!,
    });
    // 命中不重叠地往后走（regex 已保证 lastIndex = e）
  }
  return { matches, capped: false };
};
