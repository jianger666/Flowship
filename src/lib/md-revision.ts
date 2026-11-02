/**
 * Markdown 修订视图（Word Track Changes 风格）纯函数层
 *
 * 流程：
 * 1. remark-parse 拆新旧两版为顶层块 → 先按指纹裁掉公共前后缀，剩余部分 LCS + Jaccard 对齐
 *    （块数 × 块数过大 / 文档过大时改用指纹 LCS，不算相似度矩阵）
 * 2. 纯文本类块（paragraph / heading / list / blockquote / thematicBreak）词级 diff，
 *    用 PUA 哨兵嵌回合并 md；复杂块（code / table / math / html / mermaid）整块标记；
 *    嵌在 list / blockquote 里的围栏代码等「不能掺哨兵」的节点若被词级 diff 碰到 → 该块整块标记
 * 3. remarkSentinelToRevision 把文本里的哨兵切成 data.hName=ins|del 节点，
 *    Streamdown 渲染成 <ins>/<del>
 *
 * 块指纹 = 结构签名（行内格式 / 链接目标 / 嵌套深度 / 有序性 / 代码 lang 等 + 文本），
 * 文字没变但结构变了（加粗、缩进成子项、围栏语言）→ 整块标 modified、不做词级哨兵。
 *
 * 解析口径 = 渲染口径（remark-parse + gfm + cjk-friendly + math，插件表与渲染侧共用 revision-syntax-plugins.ts）：
 * 否则表格会被当成段落，哨兵塞进分隔行把表格拆成带字面 `|` 的段落，顶层块数也会和渲染端错位；
 * 公式被当成段落文本，哨兵塞进 KaTeX 源码 → 公式报错且哨兵泄漏。
 *
 * 边界策略（哨兵跨 inline 节点）——生产端（mergeInlineableBlock）合并前先验：
 * - 哨兵必须「开…闭」成对落在同一个 text / inlineCode 节点里（跨节点的哨兵——整个列表项 / 引用段落的
 *   新增 / 删除、跨加粗边界——渲染端会静默吞掉）→ 整块按 modified 出新版原文（block）
 * - 哨兵落在渲染端消费不了的字段（link.title / image.alt·title / 自动链接 url / code·html 的 value…）→
 *   整块替换（replace），不擦哨兵：擦了会改坏 url / title，漏了会泄漏
 * - 行内结构复验：哨兵（私有区字符）会改变强调 / 删除线边界判定（CJK 标点紧邻的 `**“重点”**内容`），
 *   合并串解析、归约掉被删片段后的节点类型序列与新版解析不一致 → 整块按 modified 出新版原文（见 inlineShape）
 * - 消费端 remarkSentinelToRevision 仍保留兜底（孤儿哨兵剥掉、link/image 拍平成文本），只防坏输入
 *
 * 性能边界：Myers diff 是 O(N·D)，整段改写时 D≈N（13 万字符的单段改写实测 44s）。
 * 词级 diff / 指纹 LCS 都带 maxEditLength 上限，词级另有整次构建的累计预算；
 * 超限 → 该块按块 modified（词级）/ 按顺序贪心配对（块级对齐），stats.degraded = true。
 */

import { diffArrays } from "diff";
import { toString } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { REVISION_PARSE_REMARK_PLUGINS } from "./revision-syntax-plugins";

// ---------- 哨兵（PUA 私有区、正文几乎不可能撞） ----------
/** 新增片段起/止 */
export const INS_OPEN = "\uE000";
export const INS_CLOSE = "\uE001";
/** 删除片段起/止 */
export const DEL_OPEN = "\uE002";
export const DEL_CLOSE = "\uE003";

const SENTINEL_RE = new RegExp(
  `${INS_OPEN}|${INS_CLOSE}|${DEL_OPEN}|${DEL_CLOSE}`,
  "g",
);

export type BlockRevisionStatus =
  | "unchanged"
  | "modified"
  | "added"
  | "removed";

export interface BlockMark {
  /** 合并 md 里顶层块的 0-based 下标 */
  index: number;
  status: "modified" | "added" | "removed";
  /** modified / removed 时附旧版该块原文，给角标 popover 用 */
  oldSource?: string;
}

export interface RevisionStats {
  /** 词级新增计数 */
  ins: number;
  /** 词级删除计数 */
  del: number;
  /**
   * 文档过大时跳过词级内联、只做块级标注。
   * UI 据此提示「已简化为块级修订」。
   */
  degraded?: boolean;
  /**
   * 最终复验发现合并 md 里哨兵残留 / 不成对 / 落进消费不了的字段（生产端本应已拦住，这是最后一道兜底）：
   * 整份修订视图已降级为「无修订标记的纯渲染」（渲染新版全文、没有任何标记）。UI 据此提示。
   */
  leakFallback?: boolean;
}

export interface RevisionView {
  mergedMd: string;
  blockMarks: BlockMark[];
  stats: RevisionStats;
}

// 自描述最小 mdast（跟仓库其它 remark 插件一致、不绑 @types/mdast 运行时）
interface MdNode {
  type: string;
  value?: string;
  lang?: string | null;
  depth?: number;
  /** list 有序 / 无序——指纹必须区分，否则同文字 ul/ol 静默判 equal */
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  meta?: string | null;
  title?: string | null;
  url?: string;
  alt?: string;
  children?: MdNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

interface ParsedBlock {
  type: string;
  /** 原文切片（含围栏 / 标记） */
  source: string;
  /** 指纹：结构签名（类型 + 行内格式 + 嵌套 + lang/depth/url 等 + 文本），见 blockFingerprint */
  fingerprint: string;
  /** 纯文本（对齐相似度用） */
  plain: string;
  /** 是否走词级内联（否 = 整块标记） */
  inlineable: boolean;
  node: MdNode;
  /** 惰性缓存：词集合（Jaccard）——对齐 DP 里同一块会被比对很多次，只分词一次 */
  words?: Set<string>;
  /** 惰性缓存：字符频次（charOverlap，已去空白）+ 总数 */
  chars?: { freq: Map<string, number>; total: number };
}

const COMPLEX_TYPES = new Set([
  "code",
  "table",
  "html",
  "math",
  "yaml",
  "toml",
]);

/** 块是否禁止词级哨兵（哨兵会污染围栏 / 表格语法） */
const isComplexBlock = (node: MdNode): boolean => {
  if (COMPLEX_TYPES.has(node.type)) return true;
  // mermaid / math 常落在 code 围栏；lang 再兜一层
  if (node.type === "code") {
    const lang = (node.lang ?? "").toLowerCase();
    if (lang === "mermaid" || lang === "math" || lang === "katex") return true;
  }
  return false;
};

/** 纯文本类：可做词级内联 */
const isInlineableBlock = (node: MdNode): boolean => {
  if (isComplexBlock(node)) return false;
  return (
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "list" ||
    node.type === "blockquote" ||
    node.type === "thematicBreak"
  );
};

const normalizePlain = (s: string): string =>
  s.replace(/\s+/g, " ").trim();

/**
 * 块的纯文本（对齐相似度用）。表格的行 / 单元格之间补空格：
 * mdast-util-to-string 会把单元格直接粘成一个词（`AB12`），小表格（短文本只看词 Jaccard）
 * 加一行 / 一列就几乎与旧表零重合，配不成 modified、变成两张表 removed + added。
 */
const TABLE_CONTAINER_TYPES = new Set(["table", "tableRow"]);
const blockPlainText = (node: MdNode): string =>
  TABLE_CONTAINER_TYPES.has(node.type) && node.children
    ? node.children.map(blockPlainText).join(" ")
    : toString(node as never);

/**
 * 影响渲染语义的节点浅字段：标题层级 / 列表有序性与起号 / 松散·紧凑（spread：渲染成有无 <p>）/
 * 任务勾选 / 代码 lang·meta / 链接·图片目标 / 引用标识
 */
const SIGNATURE_FIELDS = [
  "depth",
  "ordered",
  "start",
  "spread",
  "checked",
  "lang",
  "meta",
  "url",
  "title",
  "alt",
  "identifier",
  "referenceType",
  "align",
] as const;

/** 文本叶子折叠空白（与 plain 口径一致：软换行 / 多空格不算改动） */
const collapseWs = (s: string): string => s.replace(/\s+/g, " ");

/**
 * 结构签名：递归序列化子树里「影响渲染」的信息，O(节点数)。
 * - 节点类型 + 浅字段（见 SIGNATURE_FIELDS）：强调 / 加粗 / 行内代码 / 链接目标 / 列表嵌套与有序性 / 代码 lang 全进来
 * - 相邻 text 先合并再折叠空白（text 被解析器切碎不算改动）
 * - code / inlineCode / html 等其它带 value 的叶子原样保留（代码缩进、空白都算改动）
 * 写法差异（`*a*` vs `_a_`、`-` vs `*` 列表标记、setext vs ATX 标题）AST 相同 → 签名相同，不误标。
 */
const nodeSignature = (node: MdNode): string => {
  let head = node.type;
  const rec = node as unknown as Record<string, unknown>;
  for (const key of SIGNATURE_FIELDS) {
    const v = rec[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      head += `\0${key}=${String(v)}`;
    } else if (Array.isArray(v)) {
      head += `\0${key}=${v.map((x) => String(x ?? "")).join(",")}`;
    }
  }
  if (typeof node.value === "string") {
    const value = node.type === "text" ? collapseWs(node.value) : node.value;
    return `${head}:${JSON.stringify(value)}`;
  }
  const parts: string[] = [];
  let textRun: string | null = null;
  const flushText = () => {
    if (textRun === null) return;
    parts.push(`text:${JSON.stringify(collapseWs(textRun))}`);
    textRun = null;
  };
  for (const c of node.children ?? []) {
    if (c.type === "text" && typeof c.value === "string") {
      textRun = (textRun ?? "") + c.value;
      continue;
    }
    flushText();
    parts.push(nodeSignature(c));
  }
  flushText();
  return `${head}(${parts.join("\x01")})`;
};

/**
 * 块指纹 = 整个块子树的结构签名（含文本）。
 * 旧指纹只有 type + 纯文本 + 少量字段：`**关键**`→关键、列表缩进成子项、围栏 js→ts 都判 equal，
 * 修订视图显示「无变化」。
 */
const blockFingerprint = (node: MdNode): string => nodeSignature(node);

/**
 * 与渲染端同口径：gfm（表格 / 任务列表 / 删除线 / 自动链接）+ cjk-friendly + math，
 * 插件表与 Streamdown 的 `plugins` 共用 revision-syntax-plugins.ts 里的同一份（见该文件注释）；
 * 冻结后的 processor 可复用，不必每次重建
 */
const markdownParser = unified()
  .use(remarkParse)
  .use(REVISION_PARSE_REMARK_PLUGINS);

const parseBlocks = (md: string): ParsedBlock[] => {
  const tree = markdownParser.parse(md) as unknown as MdNode;
  const children = tree.children ?? [];
  return children.map((node) => {
    const start = node.position?.start?.offset ?? 0;
    const end = node.position?.end?.offset ?? start;
    const source = md.slice(start, end);
    const plain = normalizePlain(blockPlainText(node));
    const fingerprint = blockFingerprint(node);
    return {
      type: node.type,
      source,
      fingerprint,
      plain,
      inlineable: isInlineableBlock(node),
      node,
    };
  });
};

/**
 * 引用 / 脚注定义的解析上下文。
 *
 * 为什么逐块验收要带上定义块：`[1]` / `[文档][1]` / `[^1]` 是否成为 linkReference / footnoteReference，
 * 取决于整篇里有没有同名的 `[1]: url` 定义。逐块验收若只解析这一个块，`[1]` 只是一段文本，
 * 哨兵成对落在同一个 text 里 → 验收放行；而渲染端（整篇解析）里 `[1]` 是独立的引用节点，
 * 把「开…闭」哨兵切到两个节点 → 孤儿哨兵，修订样式丢失（最终复验 guard 会把整篇降级成无标记全文）。
 * 验收时把定义块拼在被验块前面一起解析、再切掉定义部分，两边的解析结果就一致了。
 */
interface DefContext {
  prefix: string;
  /** prefix 单独解析出的顶层块数（拼接解析后要切掉这么多块） */
  count: number;
}

const EMPTY_DEF_CONTEXT: DefContext = { prefix: "", count: 0 };

const DEFINITION_BLOCK_TYPES = new Set(["definition", "footnoteDefinition"]);

/**
 * 收集新旧两版里的顶层定义块（按源码去重）。合并文档里新旧块都会出现（removed / replace 的旧块也在），
 * 取并集才与整篇解析时可见的定义集合一致。没有定义时返回空上下文，验收路径零额外开销。
 */
const buildDefContext = (
  oldBlocks: ParsedBlock[],
  newBlocks: ParsedBlock[],
): DefContext => {
  const sources = new Set<string>();
  for (const b of [...oldBlocks, ...newBlocks]) {
    if (DEFINITION_BLOCK_TYPES.has(b.type)) sources.add(b.source);
  }
  if (sources.size === 0) return EMPTY_DEF_CONTEXT;
  const prefix = `${[...sources].join("\n\n")}\n\n`;
  return { prefix, count: parseBlocks(prefix).length };
};

/**
 * 解析单块源码（带定义上下文）。定义部分被后文吞掉导致块数不够时自然得到比预期少的块，
 * 调用方要求「严格单块」，所以会回退成 replace，不会放宽验收。
 */
const parseBlocksWithDefs = (md: string, defs: DefContext): ParsedBlock[] =>
  defs.count === 0
    ? parseBlocks(md)
    : parseBlocks(defs.prefix + md).slice(defs.count);

/** 块的词集合（去空白 token），惰性缓存——对齐 DP 里同一块要和对面很多块比，只分词一次 */
const blockWords = (b: ParsedBlock): Set<string> => {
  if (!b.words) {
    b.words = new Set(tokenize(b.plain).filter((t) => t.trim().length > 0));
  }
  return b.words;
};

/** 块的字符频次（去空白，按码点），惰性缓存 */
const blockChars = (
  b: ParsedBlock,
): { freq: Map<string, number>; total: number } => {
  if (!b.chars) {
    const freq = new Map<string, number>();
    let total = 0;
    for (const ch of b.plain.replace(/\s+/g, "")) {
      freq.set(ch, (freq.get(ch) ?? 0) + 1);
      total += 1;
    }
    b.chars = { freq, total };
  }
  return b.chars;
};

/** 词集合 Jaccard；空对空视为 1 */
const jaccard = (a: ParsedBlock, b: ParsedBlock): number => {
  if (a.plain === b.plain) return 1;
  const sa = blockWords(a);
  const sb = blockWords(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
};

/** 字符多重集合重合率——短中文标题词少时 Jaccard 易掉到阈值下（多重集合交 = 每个字符取两边较小频次求和） */
const charOverlap = (a: ParsedBlock, b: ParsedBlock): number => {
  const ca = blockChars(a);
  const cb = blockChars(b);
  if (ca.total === 0 && cb.total === 0) return 1;
  if (ca.total === 0 || cb.total === 0) return 0;
  // 遍历较小的 Map，查较大的
  const [small, large] = ca.freq.size <= cb.freq.size ? [ca, cb] : [cb, ca];
  let inter = 0;
  for (const [ch, n] of small.freq) {
    const m = large.freq.get(ch);
    if (m !== undefined) inter += Math.min(n, m);
  }
  return (2 * inter) / (ca.total + cb.total);
};

/** 短纯文本：禁用 charOverlap（汉字重合易把整段替换误判成 modified） */
const SHORT_PLAIN_LIMIT = 30;

/** 同类型块相似度：长文本取 Jaccard / charOverlap 较高者；短文本只用词 Jaccard */
const blockSimilarity = (a: ParsedBlock, b: ParsedBlock): number => {
  if (a.fingerprint === b.fingerprint) return 1;
  if (a.type !== b.type) return 0;
  const jac = jaccard(a, b);
  const short =
    a.plain.length < SHORT_PLAIN_LIMIT && b.plain.length < SHORT_PLAIN_LIMIT;
  if (short) return jac;
  return Math.max(jac, charOverlap(a, b));
};

/** 配对阈值：短文本抬高，整段替换走 remove+add、同段小改才 modified */
const pairingThreshold = (a: ParsedBlock, b: ParsedBlock): number => {
  const short =
    a.plain.length < SHORT_PLAIN_LIMIT && b.plain.length < SHORT_PLAIN_LIMIT;
  return short ? SHORT_SIM_THRESHOLD : SIM_THRESHOLD;
};

/**
 * Intl.Segmenter 模块级单例（惰性创建）：构造要加载词典、很重，
 * 而 tokenize 在相似度 / 词级 diff 里被调用成千上万次——旧实现每次都 new，是对齐慢的主因之一。
 * null = 本环境不支持（走 tokenize 的正则回退）。
 */
let wordSegmenter: Intl.Segmenter | null | undefined;
const getWordSegmenter = (): Intl.Segmenter | null => {
  if (wordSegmenter !== undefined) return wordSegmenter;
  try {
    wordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
  } catch {
    wordSegmenter = null;
  }
  return wordSegmenter;
};

/** 中英混合分词：优先 Intl.Segmenter(zh word)，退回空白 / 字符切 */
const tokenize = (text: string): string[] => {
  if (!text) return [];
  try {
    const seg = getWordSegmenter();
    // 极老环境无 Segmenter：直接走下面 catch 的正则回退
    if (!seg) throw new Error("Intl.Segmenter unavailable");
    const out: string[] = [];
    for (const { segment, isWordLike } of seg.segment(text)) {
      // 空白单独保留，避免 diff 把空格吞掉导致 md 粘连
      if (segment.length === 0) continue;
      if (isWordLike || /^\s+$/.test(segment) || segment.trim() === "") {
        out.push(segment);
      } else {
        // 标点等：逐字符，细粒度对齐更好看
        for (const ch of segment) out.push(ch);
      }
    }
    return out.length > 0 ? out : [text];
  } catch {
    // 极老环境无 Segmenter：空白切 + 连续 CJK 单字
    return text.match(/\s+|[\u4e00-\u9fff]|[^\s\u4e00-\u9fff]+/g) ?? [text];
  }
};

// 长文本：短标题「方案规划 / 方案修订」靠 charOverlap≈0.5 仍可内联
const SIM_THRESHOLD = 0.28;
/** 短文本强制 remove+add 下限（词 Jaccard < 此值视为整段替换） */
const SHORT_SIM_THRESHOLD = 0.45;
/** old+new 合计超此长度 → 跳过词级内联，避免同步 diff 卡主线程 */
const DEGRADE_CHAR_LIMIT = 200_000;

/**
 * 词级 diff 单次的编辑距离上限（新增 + 删除的 token 数，jsdiff 的 maxEditLength）。
 * Myers 是 O(N·D)：整段改写时 D≈N，无上限实测 2000 词 0.9s / 6000 词 8s / 12000 词 45s；
 * 2000 时单次最坏 ≈ 0.25s。超限 = 这块改得太碎、词级标注也看不过来，退回按块标记。
 */
const DIFF_MAX_EDIT_LENGTH = 2_000;
/**
 * 一次 buildRevisionView 内所有词级 diff 的累计预算，单位 = 编辑距离²（Myers 的耗时量级）。
 * 约等于两次吃满单次上限（≈0.5s）：许多超长段落各自都「刚好超限」时，总耗时不会按段数线性叠加；
 * 预算花光后，后续只有编辑距离很小的 diff 还能做（上限随剩余预算开方收紧）。
 */
const DIFF_TOTAL_WORK_BUDGET = 8_000_000;
/**
 * 块级指纹 LCS 的编辑距离上限（实测 2000 ≈ 0.25s、3000 ≈ 0.55s；D>2000 = 上千个块被改，
 * 超限改用「整段按顺序贪心配对」，对这种几乎重写的文档足够）
 */
const ALIGN_FP_MAX_EDIT_LENGTH = 2_000;

interface DiffBudget {
  /** 剩余预算（编辑距离²） */
  work: number;
  /** 是否有 diff 因超限 / 预算耗尽被放弃——给 stats.degraded 用 */
  exceeded: boolean;
}

const createDiffBudget = (): DiffBudget => ({
  work: DIFF_TOTAL_WORK_BUDGET,
  exceeded: false,
});

type DiffParts<T> = Array<{ value: T[]; added?: boolean; removed?: boolean }>;

/**
 * 带单次上限 + 累计预算的 diffArrays；超限返回 null（调用方回退成按块处理）。
 * 实际花销按编辑距离²扣；放弃的 diff 也扣满它的上限²（探索到上限同样花了那么多时间）。
 */
const budgetedDiffArrays = <T>(
  a: T[],
  b: T[],
  budget: DiffBudget,
): DiffParts<T> | null => {
  const cap = Math.min(DIFF_MAX_EDIT_LENGTH, Math.floor(Math.sqrt(budget.work)));
  if (cap < 1) {
    budget.exceeded = true;
    return null;
  }
  const parts = diffArrays(a, b, { maxEditLength: cap }) as
    | DiffParts<T>
    | undefined;
  if (!parts) {
    budget.work -= cap * cap;
    budget.exceeded = true;
    return null;
  }
  let edits = 0;
  for (const p of parts) if (p.added || p.removed) edits += p.value.length;
  budget.work -= edits * edits;
  return parts;
};

type AlignOp =
  | { kind: "equal"; oi: number; ni: number }
  | { kind: "modified"; oi: number; ni: number }
  | { kind: "removed"; oi: number }
  | { kind: "added"; ni: number };

/**
 * 相似度 DP 允许的最大格子数（裁掉公共前后缀后的 m'×n'）。
 * 每格最坏要算一次块相似度，超过就改用指纹 LCS（Myers，O(ND)、不算相似度矩阵）。
 * 400×400 的「整体改写」实测亚秒级；更大的矩阵 DP 本身（内存 + 回溯）也会开始拖主线程。
 */
const ALIGN_DP_CELL_LIMIT = 160_000;

/**
 * 相似度 DP：最长公共子序列，相等指纹优先；相似度 ≥ 阈值视为可配对（modified）。
 * 得分：equal=3 / similar=1 / skip=0，保证「真相等」优先于「勉强相似」。
 * 入参是已裁掉公共前后缀的中间段，返回的下标是段内局部下标、且尚未做相邻配对收敛。
 */
const alignByDp = (oldB: ParsedBlock[], newB: ParsedBlock[]): AlignOp[] => {
  const m = oldB.length;
  const n = newB.length;
  const score: number[][] = Array.from({ length: m + 1 }, () =>
    Array<number>(n + 1).fill(0),
  );
  const pairKind: ("eq" | "sim" | null)[][] = Array.from(
    { length: m + 1 },
    () => Array<"eq" | "sim" | null>(n + 1).fill(null),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const o = oldB[i - 1]!;
      const nw = newB[j - 1]!;
      let diag = score[i - 1]![j - 1]!;
      let kind: "eq" | "sim" | null = null;
      if (o.fingerprint === nw.fingerprint) {
        diag += 3;
        kind = "eq";
      } else if (blockSimilarity(o, nw) >= pairingThreshold(o, nw)) {
        diag += 1;
        kind = "sim";
      }
      const up = score[i - 1]![j]!;
      const left = score[i]![j - 1]!;
      if (kind && diag >= up && diag >= left) {
        score[i]![j] = diag;
        pairKind[i]![j] = kind;
      } else if (up >= left) {
        score[i]![j] = up;
        pairKind[i]![j] = null;
      } else {
        score[i]![j] = left;
        pairKind[i]![j] = null;
      }
    }
  }

  const ops: AlignOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && pairKind[i]![j]) {
      const k = pairKind[i]![j]!;
      if (k === "eq") ops.push({ kind: "equal", oi: i - 1, ni: j - 1 });
      else ops.push({ kind: "modified", oi: i - 1, ni: j - 1 });
      i -= 1;
      j -= 1;
      continue;
    }
    // 回溯：优先吃掉得分更高的一侧；平分时先删旧（保持「删→增」邻近，利于阅读）
    if (i > 0 && (j === 0 || score[i - 1]![j]! >= score[i]![j - 1]!)) {
      ops.push({ kind: "removed", oi: i - 1 });
      i -= 1;
    } else if (j > 0) {
      ops.push({ kind: "added", ni: j - 1 });
      j -= 1;
    } else {
      break;
    }
  }
  ops.reverse();
  return ops;
};

/**
 * 指纹 LCS 对齐（大文档 / 大矩阵用）：只比指纹，相等块 equal；
 * 两个相等锚点之间的「删一串 + 增一串」按顺序贪心配对（同类型且相似度够 → modified），其余照常 removed / added。
 * 复杂度 O(ND) + 每段最多 O(删+增) 次相似度，不会二次方。
 * D 本身也设了上限（ALIGN_FP_MAX_EDIT_LENGTH）：几乎整篇重写时 D≈m+n，无上限的 Myers 仍是二次方
 * （6000 块实测 5s、8000 块 8s）。超限就不找锚点了——整段当成一整串「删 + 增」按顺序贪心配对。
 */
const alignByFingerprint = (
  oldB: ParsedBlock[],
  newB: ParsedBlock[],
): AlignOp[] => {
  const parts = diffArrays(
    oldB.map((b) => b.fingerprint),
    newB.map((b) => b.fingerprint),
    { maxEditLength: ALIGN_FP_MAX_EDIT_LENGTH },
  ) as DiffParts<string> | undefined;
  const ops: AlignOp[] = [];
  let removedRun: number[] = [];
  let addedRun: number[] = [];
  const flushRun = () => {
    let a = 0;
    let b = 0;
    while (a < removedRun.length && b < addedRun.length) {
      const ob = oldB[removedRun[a]!]!;
      const nb = newB[addedRun[b]!]!;
      if (blockSimilarity(ob, nb) >= pairingThreshold(ob, nb)) {
        ops.push({ kind: "modified", oi: removedRun[a]!, ni: addedRun[b]! });
        a += 1;
        b += 1;
      } else {
        ops.push({ kind: "removed", oi: removedRun[a]! });
        a += 1;
      }
    }
    for (; a < removedRun.length; a++) {
      ops.push({ kind: "removed", oi: removedRun[a]! });
    }
    for (; b < addedRun.length; b++) {
      ops.push({ kind: "added", ni: addedRun[b]! });
    }
    removedRun = [];
    addedRun = [];
  };
  if (!parts) {
    // 编辑距离超限：不找相等锚点，整段当一串「删 + 增」按顺序贪心配对（线性）
    for (let k = 0; k < oldB.length; k++) removedRun.push(k);
    for (let k = 0; k < newB.length; k++) addedRun.push(k);
    flushRun();
    return ops;
  }
  let oi = 0;
  let ni = 0;
  for (const p of parts) {
    const len = p.value.length;
    if (p.added) {
      for (let k = 0; k < len; k++) addedRun.push(ni++);
    } else if (p.removed) {
      for (let k = 0; k < len; k++) removedRun.push(oi++);
    } else {
      flushRun();
      for (let k = 0; k < len; k++) ops.push({ kind: "equal", oi: oi++, ni: ni++ });
    }
  }
  flushRun();
  return ops;
};

const shiftOp = (op: AlignOp, d: number): AlignOp => {
  if (op.kind === "equal" || op.kind === "modified") {
    return { ...op, oi: op.oi + d, ni: op.ni + d };
  }
  return op.kind === "removed"
    ? { ...op, oi: op.oi + d }
    : { ...op, ni: op.ni + d };
};

/**
 * 块级对齐入口：
 * 1. 先按指纹裁掉公共前缀 / 后缀（直接 equal，不进 DP）——「300 段稿子改几处」只剩几块参与对齐
 * 2. 中间段：fast（文档过大已降级）或 m'×n' 超 ALIGN_DP_CELL_LIMIT → 指纹 LCS；否则相似度 DP
 * 3. 相邻 removed→added 且同类型可配对 → 收成 modified
 *    （DP 在「删旧+增新」得分持平时可能拆开，短文档尤其常见）
 */
const alignBlocks = (
  oldB: ParsedBlock[],
  newB: ParsedBlock[],
  fast: boolean,
): AlignOp[] => {
  const m = oldB.length;
  const n = newB.length;
  let head = 0;
  while (
    head < m &&
    head < n &&
    oldB[head]!.fingerprint === newB[head]!.fingerprint
  ) {
    head += 1;
  }
  let oEnd = m;
  let nEnd = n;
  while (
    oEnd > head &&
    nEnd > head &&
    oldB[oEnd - 1]!.fingerprint === newB[nEnd - 1]!.fingerprint
  ) {
    oEnd -= 1;
    nEnd -= 1;
  }

  const ops: AlignOp[] = [];
  for (let k = 0; k < head; k++) ops.push({ kind: "equal", oi: k, ni: k });

  const midOld = oldB.slice(head, oEnd);
  const midNew = newB.slice(head, nEnd);
  if (midOld.length === 0) {
    for (let k = head; k < nEnd; k++) ops.push({ kind: "added", ni: k });
  } else if (midNew.length === 0) {
    for (let k = head; k < oEnd; k++) ops.push({ kind: "removed", oi: k });
  } else {
    const mid =
      fast || midOld.length * midNew.length > ALIGN_DP_CELL_LIMIT
        ? alignByFingerprint(midOld, midNew)
        : alignByDp(midOld, midNew);
    for (const op of mid) ops.push(shiftOp(op, head));
  }

  for (let k = 0; k < m - oEnd; k++) {
    ops.push({ kind: "equal", oi: oEnd + k, ni: nEnd + k });
  }

  const collapsed: AlignOp[] = [];
  for (let k = 0; k < ops.length; k++) {
    const cur = ops[k]!;
    const nxt = ops[k + 1];
    if (cur.kind === "removed" && nxt?.kind === "added") {
      const ob = oldB[cur.oi]!;
      const nb = newB[nxt.ni]!;
      if (blockSimilarity(ob, nb) >= pairingThreshold(ob, nb)) {
        collapsed.push({ kind: "modified", oi: cur.oi, ni: nxt.ni });
        k += 1;
        continue;
      }
    }
    if (cur.kind === "added" && nxt?.kind === "removed") {
      const ob = oldB[nxt.oi]!;
      const nb = newB[cur.ni]!;
      if (blockSimilarity(ob, nb) >= pairingThreshold(ob, nb)) {
        collapsed.push({ kind: "modified", oi: nxt.oi, ni: cur.ni });
        k += 1;
        continue;
      }
    }
    collapsed.push(cur);
  }
  return collapsed;
};

/** 词数（去空白 token）——放弃词级 diff 时按「整块新 / 旧」估 +/− */
const wordCount = (s: string): number =>
  tokenize(s).filter((t) => t.trim().length > 0).length;

/** 词级 diff → 带哨兵的合并串 + 增减计数；超出编辑距离上限 / 预算（见 budgetedDiffArrays）返回 null */
const mergeWordsWithSentinels = (
  oldText: string,
  newText: string,
  budget: DiffBudget,
): { merged: string; ins: number; del: number } | null => {
  const oldTok = tokenize(oldText);
  const newTok = tokenize(newText);
  const parts = budgetedDiffArrays(oldTok, newTok, budget);
  if (!parts) return null;
  let merged = "";
  let ins = 0;
  let del = 0;
  for (const p of parts) {
    const chunk = p.value.join("");
    if (p.added) {
      merged += `${INS_OPEN}${chunk}${INS_CLOSE}`;
      ins += p.value.filter((t) => t.trim().length > 0).length;
    } else if (p.removed) {
      merged += `${DEL_OPEN}${chunk}${DEL_CLOSE}`;
      del += p.value.filter((t) => t.trim().length > 0).length;
    } else {
      merged += chunk;
    }
  }
  return { merged, ins, del };
};

/**
 * 对 inlineable 块：在「纯文本」上做词级 diff，再尽量嵌回新版 md 源。
 * 策略：直接对新旧 **source** 做词级 diff（保留链接 / 加粗语法），再校验合并串重新解析后结构仍稳：
 * - inline：词级哨兵安全，用合并串
 * - block：不适合词级 → 按块标 modified、出新版原文。包括：文字没变只改了格式 / 结构；
 *   嵌套的围栏代码等被哨兵碰到；哨兵没能成对落进同一个 text 节点（整个列表项 / 引用段落的新增、跨加粗边界…）；
 *   词级 diff 超出编辑距离上限 / 预算
 * - replace：块类型 / 层级被哨兵弄变了，或哨兵落进渲染端消费不了的字段（link.title / image.alt·title /
 *   自动链接 url…）→ 旧块 removed + 新块 added，避免哨兵拆坏语法或泄漏
 */
const mergeInlineableBlock = (
  oldB: ParsedBlock,
  newB: ParsedBlock,
  budget: DiffBudget,
  defs: DefContext,
):
  | { kind: "inline"; md: string; ins: number; del: number }
  | { kind: "replace" }
  | { kind: "block" } => {
  // 文字没变、只有结构 / 行内格式变了（加粗、链接目标、嵌套深度、标题层级…）：
  // 源码级词 diff 只会把哨兵塞进语法字符（`**` 两侧、行首缩进、`#` 之间），渲染反而错位，
  // 且词级本来就没有可标的增删 → 直接按块标 modified（渲染新版原文，旧版原文在角标里）
  if (oldB.plain === newB.plain) return { kind: "block" };
  // 优先 source 级词 diff——链接 / 加粗未改时语法完整保留
  const srcMerge = mergeWordsWithSentinels(oldB.source, newB.source, budget);
  // 改得太碎（超编辑距离上限）或累计预算已花光：不做词级，退回按块标记
  if (!srcMerge) return { kind: "block" };
  // 粗检：哨兵是否打断明显的 md 结构（落在未闭合的 ` 或 ]( 中间很难静态判定）
  // 用「去掉哨兵后能否再 parse 成同类型单块」做验收
  const stripped = srcMerge.merged
    .replaceAll(INS_OPEN, "")
    .replaceAll(INS_CLOSE, "")
    .replaceAll(DEL_OPEN, "")
    .replaceAll(DEL_CLOSE, "");
  const reparsed = parseBlocksWithDefs(srcMerge.merged, defs);
  const strippedBlocks = parseBlocksWithDefs(stripped, defs);
  // 必须严格单块：允许多块会让 outIndex +1 与渲染顶层块数错位。
  // 还要校验「带哨兵的合并串」重新解析后的首块仍是新版那种块（类型 / 标题层级 / 列表有序性）：
  // 只看去哨兵版的类型不够——`# 标题`→`## 标题` 合并成 `#<ins>#</ins> 标题`，
  // 哨兵夹在两个 # 之间，实际解析成带字面 `##` 的普通段落。
  const structureOk =
    strippedBlocks.length === 1 &&
    strippedBlocks[0]!.type === newB.type &&
    reparsed.length === 1 &&
    sameBlockShape(reparsed[0]!.node, newB.node);

  // 结构不稳（含哨兵拆成多块 / 块类型变了）→ 整块替换，保证 index 恒对齐
  if (!structureOk) return { kind: "replace" };

  // 围栏代码 / html / 表格等不能掺哨兵的节点（含嵌在 list / blockquote 里的）必须原样保留：
  // 词级 diff 碰到它们（哨兵落进围栏内、或贴着围栏线把围栏拆坏）→ 该块整体按块标记，
  // 否则哨兵会泄漏到渲染结果和用户复制出去的命令里
  if (
    protectedSignature(reparsed[0]!.node) !== protectedSignature(newB.node)
  ) {
    return { kind: "block" };
  }

  // 哨兵落点验收（按 reparsed——渲染端看到的就是这棵树）：
  // - 落进渲染端消费不了的字段（link.title / image.alt·title / 自动链接 url…）：擦会改坏数据、不擦会泄漏
  //   → 整块替换，两块各自保持完整
  // - 没成对落在同一个 text / inlineCode 节点（整个列表项 / 引用段落的新增·删除、跨加粗边界）：
  //   渲染端会把孤儿哨兵静默剥掉，用户看到的是没有任何 ins/del 样式的正文 → 按块标 modified
  const problem = inspectSentinels(reparsed[0]!.node);
  if (problem === "opaque") return { kind: "replace" };
  if (problem === "unpaired") return { kind: "block" };

  // 行内结构复验：哨兵是私有区字符（既非空白 / 标点也非 CJK），会改变强调 / 删除线边界的判定——
  // `”**内容` 里闭合 `**` 右侧原本是 CJK 字符（cjk-friendly 放宽、成强调），插了哨兵（`”**\uE000新\uE001内容`）后
  // 右侧变成「其他字符」，新版里正常的加粗在合并视图里变成字面 `**`（反过来，新版里字面的 `**` 也可能被哨兵「救活」）。
  // 渲染端看到的是 parse(合并串)：把它里面被删除片段与哨兵归约掉，节点类型序列必须与 parse(新版块) 一致，
  // 不一致 → 按块标 modified（出新版原文，与「哨兵不成对」同一条回退路径）。
  // 复用已有的 reparsed / newB.node，不新增 parse；只是 O(节点数) 的树遍历，不引入二次方。
  if (
    inlineShape(reparsed[0]!.node, true) !== inlineShape(newB.node, false)
  ) {
    return { kind: "block" };
  }

  return {
    kind: "inline",
    md: srcMerge.merged,
    ins: srcMerge.ins,
    del: srcMerge.del,
  };
};

/** 一段文本里的哨兵是否「开…闭」同类成对、不嵌套、无孤儿——与 splitTextBySentinels 的消费规则一致 */
const sentinelsPaired = (value: string): boolean => {
  let expectClose: string | null = null;
  for (const ch of value) {
    if (ch === INS_OPEN || ch === DEL_OPEN) {
      if (expectClose !== null) return false;
      expectClose = ch === INS_OPEN ? INS_CLOSE : DEL_CLOSE;
    } else if (ch === INS_CLOSE || ch === DEL_CLOSE) {
      if (expectClose !== ch) return false;
      expectClose = null;
    }
  }
  return expectClose === null;
};

/** 渲染端不会消费哨兵的字符串字段（text / inlineCode 的 value 之外） */
const OPAQUE_STRING_FIELDS = [
  "url",
  "title",
  "alt",
  "lang",
  "meta",
  "identifier",
  "label",
] as const;

/**
 * 节点自身（不含子树）是否带「消费不了」的哨兵：
 * 非 text / inlineCode 节点的 value（code / html / math…），或 url / title / alt / lang / meta 等字段。
 */
const hasOpaqueSentinel = (node: MdNode): boolean => {
  if (
    node.type !== "text" &&
    node.type !== "inlineCode" &&
    typeof node.value === "string" &&
    hasSentinel(node.value)
  ) {
    return true;
  }
  const rec = node as unknown as Record<string, unknown>;
  return OPAQUE_STRING_FIELDS.some((key) => {
    const v = rec[key];
    return typeof v === "string" && hasSentinel(v);
  });
};

/**
 * 检查合并串重新解析出的块里哨兵的落点：
 * - opaque：落进 hasOpaqueSentinel 描述的字段（优先级最高）
 * - unpaired：某个 text / inlineCode 节点里的哨兵没有自己成对
 * - none：全部成对地落在 text / inlineCode 里（插件能干净消费）
 */
const inspectSentinels = (root: MdNode): "none" | "unpaired" | "opaque" => {
  let unpaired = false;
  const walk = (node: MdNode): boolean => {
    if (hasOpaqueSentinel(node)) return true;
    if (
      (node.type === "text" || node.type === "inlineCode") &&
      typeof node.value === "string" &&
      hasSentinel(node.value) &&
      !sentinelsPaired(node.value)
    ) {
      unpaired = true;
    }
    return (node.children ?? []).some(walk);
  };
  if (walk(root)) return "opaque";
  return unpaired ? "unpaired" : "none";
};

/** 合并串里「被删除片段」整段（含开闭哨兵）：渲染成 <del>，不属于用户应看到的新版文本 */
const DEL_SPAN_RE = new RegExp(`${DEL_OPEN}[^${DEL_CLOSE}]*${DEL_CLOSE}`, "g");

/**
 * 节点子树的「结构形状」：只保留节点类型序列（strong / emphasis / delete / link / inlineCode / text / listItem…），
 * 忽略文本内容；用来比较「哨兵合并串解析出的结构」与「新版解析出的结构」。
 * - merged = true：节点里的文本先归约成「用户看到的新版文本」（去掉被删除片段与所有哨兵码位）；
 *   merged = false：新版解析树，文本原样；两边走同一套规则，对称。
 * - 归约后为空的 text / inlineCode 叶子丢弃（例如两个链接之间一段被整体删除的文字，独占一个 text 节点）；
 * - 容器节点（strong / link / listItem…）不做「归约后为空就丢弃」的特殊处理：真出现这种情况，两边形状必然不同 →
 *   保守回退成整块（哨兵成对落在同一个 text 里时，容器不可能被归约空，基本不可达）。
 * 哨兵落点（成对 / 不透明字段）已由 inspectSentinels 先验过，这里不再重复判定。
 */
const inlineShape = (root: MdNode, merged: boolean): string => {
  const shape = (node: MdNode): string => {
    if (node.type === "text" || node.type === "inlineCode") {
      const raw = typeof node.value === "string" ? node.value : "";
      const visible = merged
        ? raw.replace(DEL_SPAN_RE, "").replace(SENTINEL_RE, "")
        : raw;
      if (visible === "") return "";
      return node.type === "text" ? "t" : "c";
    }
    const kids = node.children;
    if (!kids) return node.type;
    const parts: string[] = [];
    for (const kid of kids) {
      const s = shape(kid);
      if (s !== "") parts.push(s);
    }
    return `${node.type}(${parts.join(",")})`;
  };
  return shape(root);
};

/** 块「形状」是否一致：类型 + 标题层级 + 列表有序性（词级合并后重新解析的校验用） */
const sameBlockShape = (a: MdNode, b: MdNode): boolean =>
  a.type === b.type &&
  (a.depth ?? null) === (b.depth ?? null) &&
  (a.ordered ?? null) === (b.ordered ?? null);

/**
 * 子树里所有「不能掺哨兵」节点（isComplexBlock：code / table / html / math…，含嵌套）
 * 的结构签名按文档序拼接。词级合并串重新解析后与新版逐字相等，才说明这些节点没被哨兵碰过。
 */
const protectedSignature = (root: MdNode): string => {
  const acc: string[] = [];
  const walk = (node: MdNode) => {
    if (isComplexBlock(node)) {
      acc.push(nodeSignature(node));
      return;
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(root);
  return acc.join("\x02");
};

/**
 * 按块标 modified（出新版原文、不插哨兵）时的 +/− 口径：
 * 降级 = 整块改动计 1；否则按纯文本词级 diff 计；文字没变（只有格式 / 结构 / lang 变）词级为 0，
 * 也按块计 1——否则工具栏显示 +0 −0 而块上已有 modified 标记。
 * 词级 diff 超限 / 预算花光：改得很碎，按整块新 / 旧的词数估（与整块替换的计法一致）。
 */
const blockModifiedStats = (
  ob: ParsedBlock,
  nb: ParsedBlock,
  degraded: boolean,
  budget: DiffBudget,
): { ins: number; del: number } => {
  if (degraded) return { ins: 1, del: 1 };
  const w = mergeWordsWithSentinels(ob.plain, nb.plain, budget);
  if (!w) {
    return {
      ins: Math.max(wordCount(nb.plain), 1),
      del: Math.max(wordCount(ob.plain), 1),
    };
  }
  if (w.ins === 0 && w.del === 0) return { ins: 1, del: 1 };
  return { ins: w.ins, del: w.del };
};

/**
 * 构建修订视图（对外入口）：核心实现 + 最终复验兜底（见 guardRevisionView）。
 *
 * 两道前置 / 后置保护，任何一道触发都降级为「无修订标记的纯渲染」（渲染新版全文，leakFallback = true）：
 * 1. 原文 / 新版里本来就含字面的哨兵码位（U+E000–E003，私有区；图标字体 / 特殊符号文档里真实存在）：
 *    哨兵是带内信号，原文里的同码位字符分不清是谁写的——会被误当成成对哨兵渲染成假的 ins/del，
 *    或让 guard 复验误报。不是低成本能「转义」的（合并串的任何位置都会被扫描），入口处直接降级，不跑一遍逐块再让 guard 兜底；
 * 2. 核心实现 / 最终复验自身抛错（解析器对极端输入崩溃等）：不能让修订视图的异常冒到 React 渲染里把整页打白屏。
 */
export const buildRevisionView = (oldMd: string, newMd: string): RevisionView => {
  if (hasSentinel(oldMd) || hasSentinel(newMd)) {
    warnLeakFallbackOnce("原文含与哨兵同码位的私有区字符（U+E000–E003）");
    return plainFallbackView(newMd);
  }
  try {
    return guardRevisionView(buildRevisionViewCore(oldMd, newMd), newMd);
  } catch (err) {
    warnLeakFallbackOnce("构建修订视图时抛错", err);
    return plainFallbackView(newMd);
  }
};

/** 构建修订视图（核心实现，不含最终复验） */
const buildRevisionViewCore = (oldMd: string, newMd: string): RevisionView => {
  // 超大文档：跳过词级内联，只做块级 added/removed/modified，避免主线程卡顿。
  // 必须在对齐之前判定——对齐本身（相似度 DP）才是最贵的一步，降级后改走指纹 LCS
  const degraded = oldMd.length + newMd.length > DEGRADE_CHAR_LIMIT;
  // 词级 diff 的累计预算（整次构建共用）；用尽 / 超限的块按块标记，并置 stats.degraded
  const budget = createDiffBudget();

  const oldBlocks = parseBlocks(oldMd);
  const newBlocks = parseBlocks(newMd);
  const ops = alignBlocks(oldBlocks, newBlocks, degraded);
  const defs = buildDefContext(oldBlocks, newBlocks);

  const mergedParts: string[] = [];
  const blockMarks: BlockMark[] = [];
  let statsIns = 0;
  let statsDel = 0;
  let outIndex = 0;
  /** 上一块是否 list——相邻 list 用 \n\n 拼接会被 CommonMark 合成 1 块 */
  let lastWasList = false;

  /**
   * 推入一块合并源。相邻 list 之间插 HTML 注释分隔（remark 解析为 html 顶层块、
   * Streamdown 不显示注释），保证 blockMarks.index 与渲染顶层块序一致。
   */
  const pushPart = (md: string, blockType: string) => {
    const isList = blockType === "list";
    if (mergedParts.length > 0) {
      if (lastWasList && isList) {
        mergedParts.push("\n\n<!--fe-ai-flow-rev-split-->\n\n");
        outIndex += 1;
      } else {
        mergedParts.push("\n\n");
      }
    }
    mergedParts.push(md);
    outIndex += 1;
    lastWasList = isList;
  };

  /** 整块替换：旧块 removed + 新块 added（index 各占一格） */
  const pushReplace = (ob: ParsedBlock, nb: ParsedBlock) => {
    pushPart(ob.source, ob.type);
    blockMarks.push({
      index: outIndex - 1,
      status: "removed",
      oldSource: ob.source,
    });
    const delWords = tokenize(ob.plain).filter((t) => t.trim().length > 0);
    statsDel += Math.max(delWords.length, 1);

    pushPart(nb.source, nb.type);
    blockMarks.push({ index: outIndex - 1, status: "added" });
    const insWords = tokenize(nb.plain).filter((t) => t.trim().length > 0);
    statsIns += Math.max(insWords.length, 1);
  };

  for (const op of ops) {
    if (op.kind === "equal") {
      const b = newBlocks[op.ni]!;
      pushPart(b.source, b.type);
      continue;
    }
    if (op.kind === "added") {
      const b = newBlocks[op.ni]!;
      pushPart(b.source, b.type);
      blockMarks.push({ index: outIndex - 1, status: "added" });
      // 整块新增：按词计一次「大块」增量，避免 stats 全 0
      const words = tokenize(b.plain).filter((t) => t.trim().length > 0);
      statsIns += Math.max(words.length, 1);
      continue;
    }
    if (op.kind === "removed") {
      const b = oldBlocks[op.oi]!;
      pushPart(b.source, b.type);
      blockMarks.push({
        index: outIndex - 1,
        status: "removed",
        oldSource: b.source,
      });
      const words = tokenize(b.plain).filter((t) => t.trim().length > 0);
      statsDel += Math.max(words.length, 1);
      continue;
    }
    // modified
    const ob = oldBlocks[op.oi]!;
    const nb = newBlocks[op.ni]!;
    const merged =
      degraded || !ob.inlineable || !nb.inlineable
        ? ({ kind: "block" } as const)
        : mergeInlineableBlock(ob, nb, budget, defs);
    if (merged.kind === "block") {
      // 降级 / 复杂块 / 纯结构改动 / 嵌套代码被碰到 / 哨兵没成对 / 词级超限：
      // 出新版原文 + 整块 modified 标记（不做词级哨兵）
      pushPart(nb.source, nb.type);
      blockMarks.push({
        index: outIndex - 1,
        status: "modified",
        oldSource: ob.source,
      });
      const s = blockModifiedStats(ob, nb, degraded, budget);
      statsIns += s.ins;
      statsDel += s.del;
      continue;
    }
    if (merged.kind === "replace") {
      pushReplace(ob, nb);
      continue;
    }
    pushPart(merged.md, nb.type);
    // 词级内联成功也要打 modified——否则 UI 角标 / 左边条漏标真修订
    blockMarks.push({
      index: outIndex - 1,
      status: "modified",
      oldSource: ob.source,
    });
    statsIns += merged.ins;
    statsDel += merged.del;
  }

  const mergedMd = mergedParts.join("");
  // 硬校验：解析顶层块数须与 outIndex 一致（注释分隔后应恒成立；失败则降级 list remove+add）
  if (parseBlocks(mergedMd).length !== outIndex) {
    return buildRevisionViewWithListCollapse(
      oldBlocks,
      newBlocks,
      ops,
      degraded,
      budget,
      defs,
    );
  }

  return {
    mergedMd,
    blockMarks,
    stats: {
      ins: statsIns,
      del: statsDel,
      ...(degraded || budget.exceeded ? { degraded: true } : {}),
    },
  };
};

/**
 * 硬校验失败时的兜底：相邻 list 的 remove+add 合成单个 modified（不再并排输出两段 list）。
 */
const buildRevisionViewWithListCollapse = (
  oldBlocks: ParsedBlock[],
  newBlocks: ParsedBlock[],
  ops: AlignOp[],
  degraded: boolean,
  budget: DiffBudget,
  defs: DefContext,
): RevisionView => {
  const mergedParts: string[] = [];
  const blockMarks: BlockMark[] = [];
  let statsIns = 0;
  let statsDel = 0;
  let outIndex = 0;

  const pushPart = (md: string) => {
    if (mergedParts.length > 0) mergedParts.push("\n\n");
    mergedParts.push(md);
    outIndex += 1;
  };

  const pushListModified = (ob: ParsedBlock, nb: ParsedBlock) => {
    pushPart(nb.source);
    blockMarks.push({
      index: outIndex - 1,
      status: "modified",
      oldSource: ob.source,
    });
    const w = mergeWordsWithSentinels(ob.plain, nb.plain, budget);
    statsIns += Math.max(w ? w.ins : wordCount(nb.plain), 1);
    statsDel += Math.max(w ? w.del : wordCount(ob.plain), 1);
  };

  for (let opIdx = 0; opIdx < ops.length; opIdx++) {
    const op = ops[opIdx]!;
    if (op.kind === "equal") {
      pushPart(newBlocks[op.ni]!.source);
      continue;
    }
    if (op.kind === "added") {
      const b = newBlocks[op.ni]!;
      pushPart(b.source);
      blockMarks.push({ index: outIndex - 1, status: "added" });
      const words = tokenize(b.plain).filter((t) => t.trim().length > 0);
      statsIns += Math.max(words.length, 1);
      continue;
    }
    if (op.kind === "removed") {
      const b = oldBlocks[op.oi]!;
      const nxt = ops[opIdx + 1];
      if (nxt?.kind === "added") {
        const nb = newBlocks[nxt.ni]!;
        if (b.type === "list" && nb.type === "list") {
          pushListModified(b, nb);
          opIdx += 1;
          continue;
        }
      }
      pushPart(b.source);
      blockMarks.push({
        index: outIndex - 1,
        status: "removed",
        oldSource: b.source,
      });
      const words = tokenize(b.plain).filter((t) => t.trim().length > 0);
      statsDel += Math.max(words.length, 1);
      continue;
    }
    const ob = oldBlocks[op.oi]!;
    const nb = newBlocks[op.ni]!;
    if (ob.type === "list" && nb.type === "list") {
      pushListModified(ob, nb);
      continue;
    }
    const merged =
      degraded || !ob.inlineable || !nb.inlineable
        ? ({ kind: "block" } as const)
        : mergeInlineableBlock(ob, nb, budget, defs);
    if (merged.kind === "block") {
      pushPart(nb.source);
      blockMarks.push({
        index: outIndex - 1,
        status: "modified",
        oldSource: ob.source,
      });
      const s = blockModifiedStats(ob, nb, degraded, budget);
      statsIns += s.ins;
      statsDel += s.del;
      continue;
    }
    if (merged.kind === "replace") {
      if (ob.type === "list" && nb.type === "list") {
        pushListModified(ob, nb);
        continue;
      }
      pushPart(ob.source);
      blockMarks.push({
        index: outIndex - 1,
        status: "removed",
        oldSource: ob.source,
      });
      statsDel += Math.max(
        tokenize(ob.plain).filter((t) => t.trim().length > 0).length,
        1,
      );
      pushPart(nb.source);
      blockMarks.push({ index: outIndex - 1, status: "added" });
      statsIns += Math.max(
        tokenize(nb.plain).filter((t) => t.trim().length > 0).length,
        1,
      );
      continue;
    }
    pushPart(merged.md);
    blockMarks.push({
      index: outIndex - 1,
      status: "modified",
      oldSource: ob.source,
    });
    statsIns += merged.ins;
    statsDel += merged.del;
  }

  return {
    mergedMd: mergedParts.join(""),
    blockMarks,
    stats: {
      ins: statsIns,
      del: statsDel,
      ...(degraded || budget.exceeded ? { degraded: true } : {}),
    },
  };
};

/** 兜底触发的 console.warn 只在页面生命周期内发一次（所有触发原因共用一个标志），避免每次渲染刷日志 */
let leakFallbackWarned = false;

const warnLeakFallbackOnce = (reason: string, err?: unknown): void => {
  if (leakFallbackWarned) return;
  leakFallbackWarned = true;
  const msg = `[md-revision] ${reason}，修订视图已降级为无标记的纯渲染`;
  if (err === undefined) console.warn(msg);
  else console.warn(msg, err);
};

/** 「无修订标记的纯渲染」：渲染新版全文，没有任何标记 / 哨兵；UI 据 leakFallback 提示 */
const plainFallbackView = (newMd: string): RevisionView => ({
  mergedMd: newMd,
  blockMarks: [],
  stats: { ins: 0, del: 0, leakFallback: true },
});

/**
 * 最终复验（便宜）：合并 md 里每个哨兵都必须成对落在 text / inlineCode 里、没落进插件消费不了的字段。
 * 用与渲染侧同口径的 parser（revision-syntax-plugins.ts）整篇解析一次；
 * 合并串里根本没有哨兵（块级降级 / 纯块级标记）时一个字符串扫描就返回，不解析。
 * 不通过 = 渲染端会静默吞掉孤儿哨兵（丢样式）或把哨兵泄漏到页面（KaTeX 源码 / url / title 里）。
 */
export const auditRevisionMergedMd = (mergedMd: string): boolean => {
  if (!hasSentinel(mergedMd)) return true;
  const tree = markdownParser.parse(mergedMd) as unknown as MdNode;
  return inspectSentinels(tree) === "none";
};

/**
 * 运行时最后一道兜底：复验不过（或复验自身抛错）→ 整份降级为「无修订标记的纯渲染」
 * （渲染新版全文、不带任何标记 / 哨兵），并 console.warn 一次（模块级标志，之后静默）。
 * 通过则原样返回（同一个对象，零拷贝）。
 */
export const guardRevisionView = (
  view: RevisionView,
  newMd: string,
): RevisionView => {
  try {
    if (auditRevisionMergedMd(view.mergedMd)) return view;
  } catch (err) {
    warnLeakFallbackOnce("最终复验自身抛错", err);
    return plainFallbackView(newMd);
  }
  warnLeakFallbackOnce("合并 md 里发现哨兵残留 / 不成对");
  return plainFallbackView(newMd);
};

// ---------- remark 插件：哨兵 → ins/del ----------

interface PhrasingParent {
  type: string;
  children: MdNode[];
}

const hasSentinel = (s: string): boolean =>
  s.includes(INS_OPEN) ||
  s.includes(INS_CLOSE) ||
  s.includes(DEL_OPEN) ||
  s.includes(DEL_CLOSE);

/** 把单段 text 按成对哨兵切成 text / ins / del 节点 */
const splitTextBySentinels = (value: string): MdNode[] => {
  if (!hasSentinel(value)) return [{ type: "text", value }];

  const out: MdNode[] = [];
  let i = 0;
  let mode: "normal" | "ins" | "del" | null = null;
  let buf = "";

  const flush = () => {
    if (!buf) return;
    if (mode === "ins") {
      out.push({
        type: "text",
        value: buf,
        data: { hName: "ins" },
      });
    } else if (mode === "del") {
      out.push({
        type: "text",
        value: buf,
        data: { hName: "del" },
      });
    } else {
      out.push({ type: "text", value: buf });
    }
    buf = "";
  };

  while (i < value.length) {
    const ch = value[i]!;
    if (ch === INS_OPEN) {
      if (mode !== null) {
        // 嵌套 / 错序：当普通字符吞掉，后续 orphan 清理
        buf += ch;
        i += 1;
        continue;
      }
      flush();
      mode = "ins";
      i += 1;
      continue;
    }
    if (ch === DEL_OPEN) {
      if (mode !== null) {
        buf += ch;
        i += 1;
        continue;
      }
      flush();
      mode = "del";
      i += 1;
      continue;
    }
    if (ch === INS_CLOSE) {
      if (mode === "ins") {
        flush();
        mode = null;
      } else {
        buf += ch;
      }
      i += 1;
      continue;
    }
    if (ch === DEL_CLOSE) {
      if (mode === "del") {
        flush();
        mode = null;
      } else {
        buf += ch;
      }
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  // 未闭合：把残余当普通文本，并剥掉残留哨兵字符
  if (mode !== null) {
    const raw = buf.replace(SENTINEL_RE, "");
    mode = null;
    buf = raw;
  }
  flush();
  // 再清一次节点里可能残留的孤儿哨兵
  return out.map((n) =>
    n.type === "text" && n.value && hasSentinel(n.value)
      ? { ...n, value: n.value.replace(SENTINEL_RE, "") }
      : n,
  );
};

/**
 * 提升带 data.hName 的 text 为独立 phrasing 节点：
 * 用已知类型 emphasis 承载、靠 data.hName 输出真实 <ins>/<del>
 * （自定义 type 可能被 mdast→hast 丢弃）。
 */
const promoteRevisionNodes = (nodes: MdNode[]): MdNode[] =>
  nodes.map((n) => {
    if (n.type === "text" && (n.data?.hName === "ins" || n.data?.hName === "del")) {
      const kind = n.data.hName;
      return {
        type: "emphasis",
        data: {
          hName: kind,
          hProperties: {
            "data-revision-hit": kind,
          },
        },
        children: [{ type: "text", value: n.value ?? "" }],
      };
    }
    return n;
  });

/** 从任意字符串剥哨兵（防泄漏） */
export const stripRevisionSentinels = (s: string): string =>
  s.replace(SENTINEL_RE, "");

/**
 * 深度遍历：处理 text；对 link/image/inlineCode 等——若 value/子树含哨兵且无法干净拆分，
 * 整节点摊成 plain text 修订节点（边界降级）。
 */
const rewriteChildren = (parent: PhrasingParent): void => {
  const children = parent.children;
  if (!children) return;
  const next: MdNode[] = [];
  for (const child of children) {
    if (child.children) {
      rewriteChildren(child as PhrasingParent);
    }

    if (child.type === "text" && child.value && hasSentinel(child.value)) {
      next.push(...promoteRevisionNodes(splitTextBySentinels(child.value)));
      continue;
    }

    // inlineCode：value 直接含哨兵 → 摊成修订 text（围栏内词级本不该出现，兜底）
    if (child.type === "inlineCode" && child.value && hasSentinel(child.value)) {
      next.push(
        ...promoteRevisionNodes(splitTextBySentinels(child.value)),
      );
      continue;
    }

    // link / image：url 或子文本含未消费哨兵 → 摊成纯文本，避免坏链
    if (
      (child.type === "link" || child.type === "image") &&
      ((child.url && hasSentinel(child.url)) ||
        (child.alt && hasSentinel(child.alt)) ||
        subtreeHasRawSentinel(child))
    ) {
      const plain = stripRevisionSentinels(toString(child as never));
      // 尽量保留可见文本上的修订：用子树 toString 已丢哨兵语义，只能出干净文本
      next.push({ type: "text", value: plain });
      continue;
    }

    // 子树走完仍有字面哨兵残留在 text 里（跨节点未配对）→ 摊平父级该 child
    if (subtreeHasRawSentinel(child)) {
      const flat = stripRevisionSentinels(toString(child as never));
      next.push({ type: "text", value: flat });
      continue;
    }

    next.push(child);
  }
  parent.children = next;
};

const subtreeHasRawSentinel = (node: MdNode): boolean => {
  if (node.type === "text" && node.value && hasSentinel(node.value)) return true;
  if (node.type === "inlineCode" && node.value && hasSentinel(node.value))
    return true;
  if (node.url && hasSentinel(node.url)) return true;
  if (node.alt && hasSentinel(node.alt)) return true;
  // 已提升的修订节点（emphasis + hName=ins|del）不算泄漏
  if (
    (node.type === "ins" || node.type === "del") ||
    node.data?.hName === "ins" ||
    node.data?.hName === "del"
  ) {
    return false;
  }
  return (node.children ?? []).some(subtreeHasRawSentinel);
};

/**
 * remark 插件：消费合并 md 里的 PUA 哨兵 → hast 友好的 ins/del 节点。
 * 保证渲染前输出树不再含哨兵字面量。
 */
export const remarkSentinelToRevision = () => (tree: MdNode) => {
  if (tree.children) rewriteChildren(tree as PhrasingParent);
  // 顶层兜底：任何残留哨兵再扫一遍 text
  const scrub = (node: MdNode) => {
    if (node.type === "text" && node.value && hasSentinel(node.value)) {
      node.value = stripRevisionSentinels(node.value);
    }
    if (node.type === "inlineCode" && node.value && hasSentinel(node.value)) {
      node.value = stripRevisionSentinels(node.value);
    }
    if (node.url && hasSentinel(node.url)) {
      node.url = stripRevisionSentinels(node.url);
    }
    node.children?.forEach(scrub);
  };
  scrub(tree);
};

/**
 * 测试 / UI 辅助：树上是否还残留哨兵字面量。
 * 除 text / inlineCode 外也看插件消费不了的字段（code / html 等的 value、link.title、image.alt·title、lang / meta…）——
 * 这些地方的哨兵不会被 remarkSentinelToRevision 处理，只会原样漏到渲染结果 / 用户复制的内容里。
 */
export const treeHasSentinelLeak = (tree: MdNode): boolean => {
  if (tree.type === "text" && tree.value && hasSentinel(tree.value)) return true;
  if (tree.type === "inlineCode" && tree.value && hasSentinel(tree.value))
    return true;
  if (hasOpaqueSentinel(tree)) return true;
  return (tree.children ?? []).some(treeHasSentinelLeak);
};

/** 收集 hast 名 / 修订节点文本 */
export const collectRevisionNodes = (
  tree: MdNode,
  acc: Array<{ kind: "ins" | "del"; text: string }> = [],
): Array<{ kind: "ins" | "del"; text: string }> => {
  const h = tree.data?.hName;
  if (tree.type === "ins" || h === "ins") {
    acc.push({ kind: "ins", text: toString(tree as never) });
    return acc;
  }
  if (tree.type === "del" || h === "del") {
    acc.push({ kind: "del", text: toString(tree as never) });
    return acc;
  }
  tree.children?.forEach((c) => collectRevisionNodes(c, acc));
  return acc;
};

/** 测试辅助：parse + 插件 */
export const parseMergedWithRevisionPlugin = (md: string): MdNode => {
  const processor = unified()
    .use(remarkParse)
    .use(REVISION_PARSE_REMARK_PLUGINS)
    .use(remarkSentinelToRevision);
  return processor.runSync(processor.parse(md)) as unknown as MdNode;
};
