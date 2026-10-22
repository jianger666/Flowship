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
  lang?: string | null;
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
        if (node.value) segments.push(node.value);
        return;
      case "code":
        // mermaid 围栏渲染成图（svg 文字不是 DOM 正文、DOM 搜索侧整块忽略），模型里也不计（D3-02）
        if (node.value && node.lang?.toLowerCase() !== "mermaid") segments.push(node.value);
        return;
      case "image":
        // 图片 alt 不是 DOM 文本节点（渲染出来只有 <img alt>），DOM 侧永远搜不到；
        // 模型里计了就会「计数 3、能跳转的只有 2」，按序号对位后整条 owner 的后续命中全错位（D3-02）
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

/**
 * 「文本 → 可见分段」缓存（D3-03）。搜索开着时 `searchEventStreamRenderOccurrences` 随每个键 / 每个吐字帧重跑，
 * 原先每次把已载入的**全部** AI 回复重新 unified 解析一遍（5 千项 0.5 秒 / 键）。
 * 按文本内容缓存（分段只取决于文本，与 ownerId / field 无关）：敲查询词时全部命中缓存、只剩字符串扫描；
 * 流式中那一条每帧文本都变，只重解析它自己。有界：条目数 LRU（Map 插入序）+ 总字符预算 + 超长文本不入缓存。
 *
 * Q7b-02：key 是全文，流式每一帧都是新字符串，一条 50KB 回复吐 2000 帧就是 2000 份 ~25KB 的 key + 分段数组
 * （数十 MB 驻留，还把稳定回复的条目挤出 LRU）。两道收口：
 * - **被取代的前缀帧立刻淘汰**：新插入的文本以「上一次插入的文本」为前缀（流式帧是严格追加的），说明上一条是过时帧，
 *   不会再被命中——直接删掉，流式期间缓存里始终只留最新一帧；
 * - **总字符预算**（Σ key.length ≤ 4M 字符 ≈ 8MB）：超了从最久未用的开始淘汰，不再只按条数限（4000 × 20 万字的理论上限）。
 */
const VISIBLE_SEGMENTS_CACHE_LIMIT = 4000;
const VISIBLE_SEGMENTS_CACHE_MAX_LEN = 200_000;
const VISIBLE_SEGMENTS_CACHE_MAX_CHARS = 4_000_000;
/** 过时帧判定的下限：太短的文本（「好的」→「好的，…」）重解析几乎免费、也最容易是巧合前缀，不淘汰 */
const SUPERSEDED_PREFIX_MIN_LEN = 200;
const visibleSegmentsCache = new Map<string, readonly string[]>();
let visibleSegmentsCacheChars = 0;
/**
 * 最近插入的几个 key（第五轮 P4）：原先只记「上一次插入的一个」，两条流并发吐字时彼此交替插入，
 * 每条流的上一帧都不是「上一次插入的」→ 过时帧淘汰失效，退化成只靠 LRU / 字符预算兜底。
 * 记最近 RECENT_INSERTED_KEYS_MAX 个：新帧只要是其中任一个的严格前缀就淘汰那个（有界、每次插入只做个位数次 startsWith）。
 * key 被淘汰 / 删除时同步移出，不额外钉住长字符串。
 */
const RECENT_INSERTED_KEYS_MAX = 8;
const recentInsertedKeys: string[] = [];
let visibleSegmentsParses = 0;

/** 诊断 / 测试用：解析次数与缓存规模（`chars` = 缓存里全部 key 的字符总数） */
export const markdownVisibleSegmentsCacheStats = (): {
  parses: number;
  size: number;
  limit: number;
  chars: number;
  maxChars: number;
} => ({
  parses: visibleSegmentsParses,
  size: visibleSegmentsCache.size,
  limit: VISIBLE_SEGMENTS_CACHE_LIMIT,
  chars: visibleSegmentsCacheChars,
  maxChars: VISIBLE_SEGMENTS_CACHE_MAX_CHARS,
});

const deleteCachedSegments = (key: string): void => {
  if (visibleSegmentsCache.delete(key)) visibleSegmentsCacheChars -= key.length;
  const at = recentInsertedKeys.indexOf(key);
  if (at >= 0) recentInsertedKeys.splice(at, 1);
};

const visibleSegmentsOf = (trimmed: string): readonly string[] => {
  const cacheable = trimmed.length <= VISIBLE_SEGMENTS_CACHE_MAX_LEN;
  if (cacheable) {
    const hit = visibleSegmentsCache.get(trimmed);
    if (hit) {
      visibleSegmentsCache.delete(trimmed);
      visibleSegmentsCache.set(trimmed, hit);
      return hit;
    }
  }
  visibleSegmentsParses++;
  const segments = collectMarkdownVisibleTextSegments(markdownToMdast(trimmed));
  if (cacheable) {
    // 最近插入的某个 key 是本条的严格前缀（且够长）→ 它是被取代的流式帧，不会再命中，立刻删（Q7b-02；多流并发见 recentInsertedKeys）
    for (let i = recentInsertedKeys.length - 1; i >= 0; i -= 1) {
      const k = recentInsertedKeys[i]!;
      if (k.length >= SUPERSEDED_PREFIX_MIN_LEN && k.length < trimmed.length && trimmed.startsWith(k)) {
        deleteCachedSegments(k); // 同时把它移出 recentInsertedKeys
      }
    }
    visibleSegmentsCache.set(trimmed, segments);
    visibleSegmentsCacheChars += trimmed.length;
    recentInsertedKeys.push(trimmed);
    if (recentInsertedKeys.length > RECENT_INSERTED_KEYS_MAX) recentInsertedKeys.shift();
    // 条数 + 总字符预算双上限：从最久未用（Map 插入序最前）开始淘汰；刚插入的这条自己不淘汰
    while (
      visibleSegmentsCache.size > 1 &&
      (visibleSegmentsCache.size > VISIBLE_SEGMENTS_CACHE_LIMIT ||
        visibleSegmentsCacheChars > VISIBLE_SEGMENTS_CACHE_MAX_CHARS)
    ) {
      const oldest = visibleSegmentsCache.keys().next().value as string;
      deleteCachedSegments(oldest);
    }
  }
  return segments;
};

/** 可见 markdown 分段 → 可搜索字段（与 rehype 文本节点遍历同序） */
export const markdownToSearchableFields = (
  content: string,
  ownerId: string,
  field: string,
): SearchableField[] => {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const segments = visibleSegmentsOf(trimmed);
  // segment = 文本节点序号：同一条回复里多个文本节点的第一个命中，(owner, field, start) 都是 0，
  // 身份必须带段序号才不会在重算后全部被认成「第 1 个」（D3-01）
  return segments.map((text, segment) => ({ ownerId, field, text, segment }));
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
