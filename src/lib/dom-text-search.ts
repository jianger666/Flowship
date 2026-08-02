/**
 * 基于渲染后 DOM 的栏内搜索。
 *
 * Streamdown 会按块 memo，动态替换 rehype 插件不保证所有块重新渲染；因此搜索高亮
 * 必须以用户真正看到的 DOM 文本为准。CSS Custom Highlight 不改 React 管理的 DOM，
 * 可安全地在查询变化和虚拟列表换页时重建。
 */

export interface DomSearchMatch {
  range: Range;
  ownerId: string | null;
  ownerOccurrenceIndex: number;
}

interface TextSegment {
  node: Text;
  flatStart: number;
  flatEnd: number;
  block: Element;
}

const BLOCK_SELECTOR = [
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
].join(",");

const isSearchableTextNode = (node: Text, root: Element): boolean => {
  if (!node.data) return false;
  const parent = node.parentElement;
  if (!parent || !root.contains(parent)) return false;
  if (
    parent.closest(
      '[data-pane-search-ignore],script,style,noscript,textarea,input,select,option,[hidden],[aria-hidden="true"]',
    )
  ) {
    return false;
  }
  return true;
};

const nearestBlock = (node: Text, root: Element): Element =>
  node.parentElement?.closest(BLOCK_SELECTOR) ?? root;

const collectTextSegments = (
  root: Element,
): { flatText: string; segments: TextSegment[] } => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: TextSegment[] = [];
  let flatText = "";
  let previousBlock: Element | null = null;

  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const node = current as Text;
    if (!isSearchableTextNode(node, root)) continue;
    const block = nearestBlock(node, root);
    // 不同块之间插不可匹配的分隔符，避免段尾 + 下一段段首被误拼成结果；同一块里的
    // inline span / link / Streamdown token 则无缝拼接，支持一个单词被拆到多个节点。
    if (previousBlock && previousBlock !== block) flatText += "\u0000";
    const flatStart = flatText.length;
    flatText += node.data;
    segments.push({ node, flatStart, flatEnd: flatText.length, block });
    previousBlock = block;
  }

  return { flatText, segments };
};

const segmentAt = (
  segments: readonly TextSegment[],
  flatOffset: number,
): TextSegment | null =>
  segments.find(
    (segment) => flatOffset >= segment.flatStart && flatOffset < segment.flatEnd,
  ) ?? null;

/** 大小写不敏感，返回渲染后可见文字对应的 DOM Range。 */
export const findDomTextRanges = (root: Element, query: string): Range[] => {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  const { flatText, segments } = collectTextSegments(root);
  const lower = flatText.toLocaleLowerCase();
  const ranges: Range[] = [];
  let cursor = 0;

  while (cursor < lower.length) {
    const start = lower.indexOf(normalized, cursor);
    if (start < 0) break;
    const end = start + normalized.length;
    const startSegment = segmentAt(segments, start);
    const endSegment = segmentAt(segments, end - 1);
    if (startSegment && endSegment) {
      const range = document.createRange();
      range.setStart(startSegment.node, start - startSegment.flatStart);
      range.setEnd(endSegment.node, end - endSegment.flatStart);
      ranges.push(range);
    }
    cursor = end;
  }

  return ranges;
};

export const findOwnerDomSearchMatches = (
  root: Element,
  query: string,
): DomSearchMatch[] => {
  const matches: DomSearchMatch[] = [];
  const owners = root.querySelectorAll<HTMLElement>("[data-search-owner-id]");
  owners.forEach((owner) => {
    const ownerId = owner.dataset.searchOwnerId;
    if (!ownerId) return;
    const markedRoots = Array.from(
      owner.querySelectorAll<HTMLElement>("[data-search-content]"),
    ).filter(
      (candidate) =>
        !candidate.parentElement?.closest("[data-search-content]"),
    );
    const contentRoots: Element[] = markedRoots.length > 0 ? markedRoots : [owner];
    let ownerOccurrenceIndex = 0;
    contentRoots.forEach((contentRoot) => {
      findDomTextRanges(contentRoot, query).forEach((range) => {
        matches.push({ range, ownerId, ownerOccurrenceIndex });
        ownerOccurrenceIndex += 1;
      });
    });
  });
  return matches;
};

export const findRootDomSearchMatches = (
  root: Element,
  query: string,
): DomSearchMatch[] =>
  findDomTextRanges(root, query).map((range, ownerOccurrenceIndex) => ({
    range,
    ownerId: null,
    ownerOccurrenceIndex,
  }));

const getHighlightRegistry = (): HighlightRegistry | null => {
  if (typeof CSS === "undefined" || !CSS.highlights) return null;
  if (typeof Highlight === "undefined") return null;
  return CSS.highlights;
};

export const clearDomSearchHighlights = (
  normalName: string,
  activeName: string,
): void => {
  const registry = getHighlightRegistry();
  registry?.delete(normalName);
  registry?.delete(activeName);
};

export const applyDomSearchHighlights = (
  matches: readonly DomSearchMatch[],
  normalName: string,
  activeName: string,
  isActive: (match: DomSearchMatch) => boolean,
): void => {
  const registry = getHighlightRegistry();
  if (!registry) return;
  const activeRanges: Range[] = [];
  const normalRanges: Range[] = [];
  matches.forEach((match) => {
    (isActive(match) ? activeRanges : normalRanges).push(match.range);
  });
  registry.set(normalName, new Highlight(...normalRanges));
  registry.set(activeName, new Highlight(...activeRanges));
};

export const scrollDomSearchMatchIntoView = (
  match: DomSearchMatch | undefined,
  scrollRoot?: HTMLElement | null,
): boolean => {
  const element = match?.range.startContainer.parentElement;
  if (!element) return false;

  const findScrollableAncestor = (start: HTMLElement): HTMLElement | null => {
    let current = start.parentElement;
    while (current) {
      const overflowY = getComputedStyle(current).overflowY;
      if (
        /(auto|scroll|overlay)/.test(overflowY) &&
        current.scrollHeight > current.clientHeight
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  };

  const scroller = scrollRoot ?? findScrollableAncestor(element);
  if (!scroller) {
    element.scrollIntoView({ block: "center", behavior: "auto" });
    return true;
  }

  // 按 Range 的真实矩形定位，而不是滚动它的 parentElement。一个 Markdown 段落可能
  // 高于整个视口，滚到段落中心并不能保证具体命中词出现在屏幕里。
  const rangeRect = match.range.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const targetTop =
    scroller.scrollTop +
    rangeRect.top -
    scrollerRect.top -
    (scroller.clientHeight - rangeRect.height) / 2;
  scroller.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
  return true;
};

/** 当前全局 occurrence 在同一 owner 内的序号，用于虚拟行挂载后找真实 DOM Range。 */
export const ownerOccurrenceIndexAt = <T extends { ownerId: string }>(
  occurrences: readonly T[],
  activeIndex: number,
): number => {
  const active = occurrences[activeIndex];
  if (!active) return -1;
  let ownerIndex = 0;
  for (let i = 0; i < activeIndex; i += 1) {
    if (occurrences[i]?.ownerId === active.ownerId) ownerIndex += 1;
  }
  return ownerIndex;
};
