/**
 * 产物栏 Markdown 搜索：按渲染可见文本分段计数（与 rehype 文本节点遍历同序）
 */

import { toString } from "mdast-util-to-string";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

import {
  findOccurrencesInFields,
  normalizePaneSearchQuery,
  type SearchableField,
  type SearchOccurrence,
} from "@/lib/text-search-highlight";
import { remarkCodeReference } from "@/lib/remark-code-reference";
import { remarkKeepTrailingUnderscore } from "@/lib/remark-keep-trailing-underscore";
import { remarkTrimAutolinkCjk } from "@/lib/remark-trim-autolink-cjk";

type MdastNode = {
  type: string;
  value?: string;
  alt?: string | null;
  url?: string;
  children?: MdastNode[];
};

/** 按文档序收集可见文本片段（不含 link URL / 原始 markdown 标记） */
export const collectMarkdownVisibleTextSegments = (tree: MdastNode): string[] => {
  const segments: string[] = [];

  const walk = (node: MdastNode): void => {
    switch (node.type) {
      case "text":
        if (node.value) segments.push(node.value);
        return;
      case "inlineCode":
      case "code":
        if (node.value) segments.push(node.value);
        return;
      case "image":
        if (node.alt?.trim()) segments.push(node.alt);
        return;
      case "link":
      case "paragraph":
      case "heading":
      case "listItem":
      case "tableCell":
      case "emphasis":
      case "strong":
      case "delete":
      case "blockquote":
      case "root":
      case "table":
      case "tableRow":
        node.children?.forEach(walk);
        return;
      default:
        if (node.children?.length) node.children.forEach(walk);
    }
  };

  walk(tree);
  return segments;
};

const buildMarkdownProcessor = () =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkCodeReference)
    .use(remarkKeepTrailingUnderscore)
    .use(remarkTrimAutolinkCjk);

let cachedProcessor: ReturnType<typeof buildMarkdownProcessor> | null = null;

const getMarkdownProcessor = () => {
  if (!cachedProcessor) cachedProcessor = buildMarkdownProcessor();
  return cachedProcessor;
};

export const markdownToMdast = (markdown: string): MdastNode => {
  const processor = getMarkdownProcessor();
  const tree = processor.parse(markdown);
  return processor.runSync(tree) as MdastNode;
};

/** 单段 fallback（测试 / 调试） */
export const markdownVisiblePlainText = (markdown: string): string =>
  toString(markdownToMdast(markdown));

/** 可见 markdown 分段 → 可搜索字段（与 rehype 文本节点遍历同序） */
export const markdownToSearchableFields = (
  content: string,
  ownerId: string,
  field: string,
): SearchableField[] => {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const segments = collectMarkdownVisibleTextSegments(markdownToMdast(trimmed));
  return segments.map((text) => ({ ownerId, field, text }));
};

export const searchMarkdownVisibleContent = (
  content: string,
  query: string,
  ownerId = "artifact",
  field = "body",
): SearchOccurrence[] => {
  const q = normalizePaneSearchQuery(query);
  if (!q) return [];
  const fields = markdownToSearchableFields(content, ownerId, field);
  if (fields.length === 0) return [];
  return findOccurrencesInFields(fields, query);
};
