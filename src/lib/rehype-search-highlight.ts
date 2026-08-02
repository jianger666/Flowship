/**
 * rehype：在渲染后的文本节点内插入 <mark> 搜索高亮
 */

import type { SearchOccurrence } from "@/lib/text-search-highlight";
import {
  findOccurrenceRanges,
  normalizePaneSearchQuery,
  SEARCH_MARK_ACTIVE_CLASS,
  SEARCH_MARK_CLASS,
} from "@/lib/text-search-highlight";

type HastNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

export type { HastNode };

const cloneNode = (node: HastNode): HastNode => ({
  ...node,
  properties: node.properties ? { ...node.properties } : undefined,
  children: node.children?.map(cloneNode),
});

const wrapTextMatches = (
  text: string,
  query: string,
  activeGlobalIndex: number,
  globalOffset: number,
): HastNode[] => {
  const q = query.trim();
  if (!q || !text) return [{ type: "text", value: text }];

  const ranges = findOccurrenceRanges(text, q);
  if (ranges.length === 0) return [{ type: "text", value: text }];

  const nodes: HastNode[] = [];
  let cursor = 0;
  ranges.forEach((range, i) => {
    if (range.start > cursor) {
      nodes.push({ type: "text", value: text.slice(cursor, range.start) });
    }
    const globalIndex = globalOffset >= 0 ? globalOffset + i : -1;
    const isActive =
      globalIndex >= 0 && activeGlobalIndex >= 0 && globalIndex === activeGlobalIndex;
    nodes.push({
      type: "element",
      tagName: "mark",
      properties: {
        className: isActive ? SEARCH_MARK_ACTIVE_CLASS : SEARCH_MARK_CLASS,
        ...(globalIndex >= 0
          ? { dataSearchOccurrence: String(globalIndex) }
          : {}),
      },
      children: [{ type: "text", value: text.slice(range.start, range.end) }],
    });
    cursor = range.end;
  });
  if (cursor < text.length) nodes.push({ type: "text", value: text.slice(cursor) });
  return nodes;
};

const walkReplaceText = (
  node: HastNode,
  query: string,
  activeGlobalIndex: number,
  globalOffsetRef: { value: number },
): void => {
  if (!node.children?.length) return;
  const nextChildren: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const offset = globalOffsetRef.value;
      const wrapped = wrapTextMatches(
        child.value,
        query,
        activeGlobalIndex,
        offset,
      );
      const matchCount = findOccurrenceRanges(child.value, query).length;
      globalOffsetRef.value += matchCount;
      nextChildren.push(...wrapped);
      continue;
    }
    walkReplaceText(child, query, activeGlobalIndex, globalOffsetRef);
    nextChildren.push(child);
  }
  node.children = nextChildren;
};

export interface RehypeSearchHighlightOptions {
  query: string;
  activeGlobalIndex: number;
  /** 本 markdown 源文第一个 occurrence 的 globalIndex */
  globalOffset: number;
}

/** 工厂：供 Streamdown rehypePlugins 使用 */
export const rehypeSearchHighlight = (options: RehypeSearchHighlightOptions) => {
  const q = normalizePaneSearchQuery(options.query);
  return () => (tree: HastNode) => {
    if (!q) return;
    const root = cloneNode(tree);
    walkReplaceText(root, options.query, options.activeGlobalIndex, {
      value: options.globalOffset,
    });
    Object.assign(tree, root);
  };
};

/** 与 walkReplaceText 同序：按 HAST 可见文本节点分配 globalIndex */
export const findOccurrencesInHast = (
  tree: HastNode,
  query: string,
  ownerId: string,
  field: string,
): SearchOccurrence[] => {
  const q = normalizePaneSearchQuery(query);
  if (!q) return [];
  const out: SearchOccurrence[] = [];
  let global = 0;

  const walk = (node: HastNode): void => {
    if (!node.children?.length) return;
    for (const child of node.children) {
      if (child.type === "text" && typeof child.value === "string") {
        for (const range of findOccurrenceRanges(child.value, query)) {
          out.push({
            globalIndex: global,
            ownerId,
            field,
            start: range.start,
            end: range.end,
          });
          global += 1;
        }
        continue;
      }
      walk(child);
    }
  };

  walk(tree);
  return out;
};

/** 测试 / 调试：对 HAST 树应用搜索高亮（原地变异） */
export const applyRehypeSearchHighlightToTree = (
  tree: HastNode,
  options: RehypeSearchHighlightOptions,
): HastNode => {
  const plugin = rehypeSearchHighlight(options);
  plugin()(tree);
  return tree;
};

/** 从 occurrence 列表取某字段的首个 globalIndex */
export const globalOffsetForField = (
  occurrences: readonly SearchOccurrence[],
  ownerId: string,
  field: string,
): number => {
  const hit = occurrences.find((o) => o.ownerId === ownerId && o.field === field);
  return hit?.globalIndex ?? -1;
};
