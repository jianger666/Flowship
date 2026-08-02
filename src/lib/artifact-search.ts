/**
 * 产物栏内联搜索（纯函数）
 */

import { searchMarkdownVisibleContent } from "@/lib/markdown-visible-search";
import {
  normalizePaneSearchQuery,
  type SearchOccurrence,
} from "@/lib/text-search-highlight";

export { normalizePaneSearchQuery as normalizeArtifactSearchQuery };

export const searchArtifactContent = (
  content: string,
  query: string,
  ownerId = "artifact",
): SearchOccurrence[] => searchMarkdownVisibleContent(content, query, ownerId, "body");

export const countArtifactOccurrences = (
  content: string,
  query: string,
): number => searchArtifactContent(content, query).length;
