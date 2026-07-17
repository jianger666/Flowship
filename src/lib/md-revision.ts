/**
 * Markdown 修订视图（Word Track Changes 风格）纯函数层
 *
 * 流程：
 * 1. remark-parse 拆新旧两版为顶层块 → LCS + Jaccard 对齐
 * 2. 纯文本类块（paragraph / heading / list / blockquote / thematicBreak）词级 diff，
 *    用 PUA 哨兵嵌回合并 md；复杂块（code / table / math / html / mermaid）整块标记
 * 3. remarkSentinelToRevision 把文本里的哨兵切成 data.hName=ins|del 节点，
 *    Streamdown 渲染成 <ins>/<del>
 *
 * 边界策略（哨兵跨 inline 节点）：
 * - 只在 text 节点里消费成对哨兵；能拆则拆
 * - 孤儿开/闭标记或哨兵落在 link/image/inlineCode 的「不可拆」结构里 →
 *   该 phrasing 父节点整段降级为 plain text + 外层块标 modified（不泄漏哨兵字面量）
 */

import { diffArrays } from "diff";
import { toString } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";

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
  /** 指纹：类型 + 规范化纯文本 */
  fingerprint: string;
  /** 纯文本（对齐相似度用） */
  plain: string;
  /** 是否走词级内联（否 = 整块标记） */
  inlineable: boolean;
  node: MdNode;
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
 * 收集子树里 link/image 的 url（浅字段、O(节点数)）。
 * 审查发现：旧指纹只看 type+plain，`[x](a.com)` vs `[x](b.com)` 会静默判 equal。
 */
const collectLinkImageUrls = (node: MdNode, acc: string[] = []): string[] => {
  if (
    (node.type === "link" || node.type === "image") &&
    typeof node.url === "string"
  ) {
    acc.push(node.url);
  }
  for (const c of node.children ?? []) collectLinkImageUrls(c, acc);
  return acc;
};

/**
 * 块指纹：type + plain + 少量结构浅字段（heading.depth / list.ordered / link·image url）。
 * 只加这几项，避免把整棵 AST 序列化拖慢对齐 DP。
 */
const blockFingerprint = (node: MdNode, plain: string): string => {
  let fp = `${node.type}\0${plain}`;
  if (node.type === "heading" && typeof node.depth === "number") {
    fp += `\0d${node.depth}`;
  }
  if (node.type === "list") {
    fp += `\0o${node.ordered === true ? 1 : 0}`;
  }
  const urls = collectLinkImageUrls(node);
  if (urls.length > 0) {
    fp += `\0u${urls.join("\x01")}`;
  }
  return fp;
};

const parseBlocks = (md: string): ParsedBlock[] => {
  const tree = unified().use(remarkParse).parse(md) as unknown as MdNode;
  const children = tree.children ?? [];
  return children.map((node) => {
    const start = node.position?.start?.offset ?? 0;
    const end = node.position?.end?.offset ?? start;
    const source = md.slice(start, end);
    const plain = normalizePlain(toString(node as never));
    const fingerprint = blockFingerprint(node, plain);
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

/** 词集合 Jaccard；空对空视为 1 */
const jaccard = (a: string, b: string): number => {
  if (a === b) return 1;
  const wa = tokenize(a).filter((t) => t.trim().length > 0);
  const wb = tokenize(b).filter((t) => t.trim().length > 0);
  if (wa.length === 0 && wb.length === 0) return 1;
  if (wa.length === 0 || wb.length === 0) return 0;
  const sa = new Set(wa);
  const sb = new Set(wb);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
};

/** 字符多重集合重合率——短中文标题词少时 Jaccard 易掉到阈值下 */
const charOverlap = (a: string, b: string): number => {
  const ca = [...a.replace(/\s+/g, "")];
  const cb = [...b.replace(/\s+/g, "")];
  if (ca.length === 0 && cb.length === 0) return 1;
  if (ca.length === 0 || cb.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of ca) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let inter = 0;
  for (const ch of cb) {
    const n = freq.get(ch) ?? 0;
    if (n > 0) {
      inter += 1;
      freq.set(ch, n - 1);
    }
  }
  return (2 * inter) / (ca.length + cb.length);
};

/** 短纯文本：禁用 charOverlap（汉字重合易把整段替换误判成 modified） */
const SHORT_PLAIN_LIMIT = 30;

/** 同类型块相似度：长文本取 Jaccard / charOverlap 较高者；短文本只用词 Jaccard */
const blockSimilarity = (a: ParsedBlock, b: ParsedBlock): number => {
  if (a.fingerprint === b.fingerprint) return 1;
  if (a.type !== b.type) return 0;
  const jac = jaccard(a.plain, b.plain);
  const short =
    a.plain.length < SHORT_PLAIN_LIMIT && b.plain.length < SHORT_PLAIN_LIMIT;
  if (short) return jac;
  return Math.max(jac, charOverlap(a.plain, b.plain));
};

/** 配对阈值：短文本抬高，整段替换走 remove+add、同段小改才 modified */
const pairingThreshold = (a: ParsedBlock, b: ParsedBlock): number => {
  const short =
    a.plain.length < SHORT_PLAIN_LIMIT && b.plain.length < SHORT_PLAIN_LIMIT;
  return short ? SHORT_SIM_THRESHOLD : SIM_THRESHOLD;
};

/** 中英混合分词：优先 Intl.Segmenter(zh word)，退回空白 / 字符切 */
const tokenize = (text: string): string[] => {
  if (!text) return [];
  try {
    const seg = new Intl.Segmenter("zh", { granularity: "word" });
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

type AlignOp =
  | { kind: "equal"; oi: number; ni: number }
  | { kind: "modified"; oi: number; ni: number }
  | { kind: "removed"; oi: number }
  | { kind: "added"; ni: number };

/**
 * 块级对齐：DP 最长公共子序列，相等指纹优先；相似度 ≥ 阈值视为可配对（modified）。
 * 得分：equal=3 / similar=1 / skip=0，保证「真相等」优先于「勉强相似」。
 */
const alignBlocks = (oldB: ParsedBlock[], newB: ParsedBlock[]): AlignOp[] => {
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

  // 后处理：相邻 removed→added 且同类型可配对 → 收成 modified
  // （DP 在「删旧+增新」得分持平时可能拆开，短文档尤其常见）
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

/** 词级 diff → 带哨兵的合并串 + 增减计数 */
const mergeWordsWithSentinels = (
  oldText: string,
  newText: string,
): { merged: string; ins: number; del: number } => {
  const oldTok = tokenize(oldText);
  const newTok = tokenize(newText);
  const parts = diffArrays(oldTok, newTok);
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
 * 策略：若新旧源去空白后仅文本变化、结构标记（# * ` []() 等）位置稳定，
 * 直接对新旧 **source** 做词级 diff（保留链接 / 加粗语法）；
 * 否则退回「整段 plain 合并成一段 paragraph」，避免哨兵拆坏语法。
 */
const mergeInlineableBlock = (
  oldB: ParsedBlock,
  newB: ParsedBlock,
):
  | { kind: "inline"; md: string; ins: number; del: number }
  | { kind: "replace" } => {
  // 优先 source 级词 diff——链接 / 加粗未改时语法完整保留
  const srcMerge = mergeWordsWithSentinels(oldB.source, newB.source);
  // 粗检：哨兵是否打断明显的 md 结构（落在未闭合的 ` 或 ]( 中间很难静态判定）
  // 用「去掉哨兵后能否再 parse 成同类型单块」做验收
  const stripped = srcMerge.merged
    .replaceAll(INS_OPEN, "")
    .replaceAll(INS_CLOSE, "")
    .replaceAll(DEL_OPEN, "")
    .replaceAll(DEL_CLOSE, "");
  const reparsed = parseBlocks(srcMerge.merged);
  const strippedBlocks = parseBlocks(stripped);
  // 必须严格单块：允许多块会让 outIndex +1 与渲染顶层块数错位
  const structureOk =
    strippedBlocks.length === 1 &&
    strippedBlocks[0]!.type === newB.type &&
    reparsed.length === 1;

  if (structureOk) {
    return {
      kind: "inline",
      md: srcMerge.merged,
      ins: srcMerge.ins,
      del: srcMerge.del,
    };
  }

  // 结构不稳（含哨兵拆成多块）→ 整块替换，保证 index 恒对齐
  return { kind: "replace" };
};

/** 构建修订视图 */
export const buildRevisionView = (oldMd: string, newMd: string): RevisionView => {
  const oldBlocks = parseBlocks(oldMd);
  const newBlocks = parseBlocks(newMd);
  const ops = alignBlocks(oldBlocks, newBlocks);

  // 超大文档：跳过词级内联，只做块级 added/removed/modified，避免主线程卡顿
  const degraded = oldMd.length + newMd.length > DEGRADE_CHAR_LIMIT;

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
    if (degraded || !ob.inlineable || !nb.inlineable) {
      // 降级 / 复杂块：出新版原文 + 整块 modified 标记（不做词级哨兵）
      pushPart(nb.source, nb.type);
      blockMarks.push({
        index: outIndex - 1,
        status: "modified",
        oldSource: ob.source,
      });
      if (degraded) {
        // 块级口径：整块改动计 1
        statsIns += 1;
        statsDel += 1;
      } else {
        const w = mergeWordsWithSentinels(ob.plain, nb.plain);
        statsIns += w.ins;
        statsDel += w.del;
      }
      continue;
    }

    const merged = mergeInlineableBlock(ob, nb);
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
    return buildRevisionViewWithListCollapse(oldBlocks, newBlocks, ops, degraded);
  }

  return {
    mergedMd,
    blockMarks,
    stats: {
      ins: statsIns,
      del: statsDel,
      ...(degraded ? { degraded: true } : {}),
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
    const w = mergeWordsWithSentinels(ob.plain, nb.plain);
    statsIns += Math.max(w.ins, 1);
    statsDel += Math.max(w.del, 1);
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
    if (degraded || !ob.inlineable || !nb.inlineable) {
      pushPart(nb.source);
      blockMarks.push({
        index: outIndex - 1,
        status: "modified",
        oldSource: ob.source,
      });
      if (degraded) {
        statsIns += 1;
        statsDel += 1;
      } else {
        const w = mergeWordsWithSentinels(ob.plain, nb.plain);
        statsIns += w.ins;
        statsDel += w.del;
      }
      continue;
    }
    const merged = mergeInlineableBlock(ob, nb);
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
      ...(degraded ? { degraded: true } : {}),
    },
  };
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

/** 测试 / UI 辅助：树上是否还残留哨兵字面量 */
export const treeHasSentinelLeak = (tree: MdNode): boolean => {
  if (tree.type === "text" && tree.value && hasSentinel(tree.value)) return true;
  if (tree.type === "inlineCode" && tree.value && hasSentinel(tree.value))
    return true;
  if (tree.url && hasSentinel(tree.url)) return true;
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
  const processor = unified().use(remarkParse).use(remarkSentinelToRevision);
  return processor.runSync(processor.parse(md)) as unknown as MdNode;
};
