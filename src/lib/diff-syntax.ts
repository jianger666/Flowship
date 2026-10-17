/**
 * diff 语法高亮：纯逻辑层（无 React、无 Shiki 运行时依赖，只吃类型）。
 *
 * 为什么不是「每行单独高亮」：
 *   单行没有上下文，多行注释 / 模板字符串 / 三引号字符串中间的行会被染错。
 *   所以按 hunk 把行拼回「旧侧」「新侧」两份连续源码、各高亮一次，再按行号拆回去：
 *   - 删除行取旧侧的颜色（它在新文件里已经不存在）；
 *   - 新增行、上下文行取新侧的颜色。
 *   hunk 之间互相不传状态——中间被 `⋯` 隔开，hunk 里的上下文行会让文法状态重新对齐，
 *   Codex TUI 的 diff 渲染也是同样的取舍。
 *
 * 颜色来自 Shiki 双主题（github-light / github-dark，与聊天里的代码块同一套），
 * 渲染端用 CSS 变量 + `dark:` 变体切换主题，所以这里同时保留亮 / 暗两个色值。
 */

import { extToShikiLang } from "@/lib/local-file-kind";
import type { DiffViewLine } from "@/lib/tool-display";

/** 一小段同色文字 */
export type DiffSyntaxToken = {
  content: string;
  /** 浅色主题色值（`#rrggbb`）；缺省 = 继承 */
  light?: string;
  /** 深色主题色值 */
  dark?: string;
  italic?: boolean;
  bold?: boolean;
};

/** 一份连续源码（某个 hunk 的旧侧或新侧）及其与 diff 行的对应关系 */
export type DiffSegment = {
  side: "old" | "new";
  /** 喂给高亮器的源码：行间 `\n`，无尾随换行、行尾 `\r` 已去掉 */
  code: string;
  /** code 的第 i 行 ↔ lines 数组下标 */
  lineIndexes: number[];
};

/** 高亮器返回的 token（只声明用到的字段；形状与 Shiki ThemedToken 兼容） */
export type RawHighlightToken = {
  content: string;
  color?: string;
  fontStyle?: number;
  htmlStyle?: Record<string, string>;
};

/**
 * diff 太大就不上色：高亮要把整段源码分词，超大 diff 会卡主线程，上色不值得。
 *
 * 行数上限 2000（原 5000）：门槛不只管分词成本、还管 DOM 成本——changes 面板整段渲染（`max-h-none`），
 * 上色后每行是多个带内联样式的 `span`，5000 行能到几万个节点；2000 行以内（约 2 万节点量级）才不明显卡。
 * 超过的 diff 仍然正常显示，只是退回整行红绿色。
 */
export const DIFF_SYNTAX_MAX_CHARS = 200_000;
export const DIFF_SYNTAX_MAX_LINES = 2000;

/** 与 Shiki FontStyle 位掩码一致 */
const FONT_ITALIC = 1;
const FONT_BOLD = 2;

/**
 * 路径 → Shiki 语言 id（没扩展名的取文件名，如 `Dockerfile`）。
 * 只做字符串映射；这个语言高亮器认不认由调用方用 `supportsLanguage` 判断。
 */
export const diffLanguageFromPath = (
  path: string | null | undefined,
): string | null => {
  if (!path) return null;
  const base = path.split(/[\\/]/).pop() ?? "";
  if (!base) return null;
  const dot = base.lastIndexOf(".");
  const ext = (dot >= 0 ? base.slice(dot + 1) : base).toLowerCase();
  if (!ext) return null;
  return extToShikiLang(ext);
};

/** 这份 diff 值不值得上色（按总字符数 / 行数设上限） */
export const shouldHighlightDiff = (lines: DiffViewLine[]): boolean => {
  if (lines.length === 0 || lines.length > DIFF_SYNTAX_MAX_LINES) return false;
  let chars = 0;
  for (const l of lines) {
    chars += l.text.length;
    if (chars > DIFF_SYNTAX_MAX_CHARS) return false;
  }
  return true;
};

const sourceLineOf = (line: DiffViewLine): string =>
  line.text.replace(/\r$/, "");

/**
 * 是不是 unified diff 的 `\ No newline at end of file` 标记行（git 会按 locale 本地化文案，
 * 所以认「反斜杠 + 空格」开头而不是英文原文）。
 *
 * `parseUnifiedDiff` 把它当 context 行返回，text 保留原样（含 `\`）、行号缺省。
 * 它不是源码：塞进旧 / 新侧会夹在 del 与 add 之间污染相邻行的着色。
 * 光看「context 且没行号」不够——缺 `@@` 头（截断 / 无 hunk）的 diff 里真正的上下文行也没行号，
 * 所以再加上「文字以 `\ ` 开头」才算。
 */
const isNoNewlineMarker = (line: DiffViewLine): boolean =>
  line.kind === "context" &&
  line.oldLine === undefined &&
  line.newLine === undefined &&
  line.text.startsWith("\\ ");

/**
 * 把 diff 行按 hunk 拆成待高亮的源码段。
 * - 旧侧 = 上下文 + 删除；新侧 = 上下文 + 新增；
 * - 没有删除行的 hunk 不出旧侧（用不上）；没有新增 / 上下文行的 hunk 不出新侧；
 * - `\ No newline at end of file` 标记行不是源码，两侧都不收（见 {@link isNoNewlineMarker}）。
 */
export const buildDiffSegments = (lines: DiffViewLine[]): DiffSegment[] => {
  const segments: DiffSegment[] = [];

  const flush = (start: number, end: number) => {
    const oldIdx: number[] = [];
    const newIdx: number[] = [];
    let hasDel = false;
    let hasNewSide = false;
    for (let i = start; i < end; i++) {
      const kind = lines[i].kind;
      if (kind === "hunk") continue;
      // 不进任何一侧源码：它在 assemble 后保持 null，渲染端退回无语法色
      if (isNoNewlineMarker(lines[i])) continue;
      if (kind === "del") {
        oldIdx.push(i);
        hasDel = true;
      } else {
        newIdx.push(i);
        hasNewSide = true;
        if (kind === "context") oldIdx.push(i);
      }
    }
    if (hasDel) {
      segments.push({
        side: "old",
        code: oldIdx.map((i) => sourceLineOf(lines[i])).join("\n"),
        lineIndexes: oldIdx,
      });
    }
    if (hasNewSide) {
      segments.push({
        side: "new",
        code: newIdx.map((i) => sourceLineOf(lines[i])).join("\n"),
        lineIndexes: newIdx,
      });
    }
  };

  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i === lines.length || lines[i].kind === "hunk") {
      flush(start, i);
      start = i + 1;
    }
  }
  return segments;
};

/** 53 位字符串哈希（cyrb53）→ 十六进制；只用来给源码打指纹，不是安全用途 */
const fingerprintOf = (str: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};

/**
 * 喂给上游高亮器（`@streamdown/code`）的源码：真源码 + 换行 + 一行内容指纹。
 *
 * 为什么要加：上游结果缓存键只有「语言 + 主题 + 总长度 + 首尾各 100 字符」。
 * 一个 hunk 改动前后长度相同、改动落在中间（`10`→`20`、`p-2`→`p-4`、`===`→`!==`……超过约 200 字符就中）时，
 * 旧侧与新侧撞同一个键：并发请求时第二个回调收到的是第一份源码的 token，顺序请求时第二个同步命中缓存、
 * 拿到的也是第一份——normalizeHighlightResult 核对不过，该侧整侧变 null（删除行有色、新增 / 上下文行没色）。
 *
 * 为什么是「指纹行」：指纹落在「末尾 100 字符」窗口里，内容不同 → 键不同；
 * 追加在末尾，TextMate 分词只向前走，不影响前面各行的颜色。
 * 只补若干 `\n` 凑长度（按哈希取模）不够：两侧补得一样多时（1/N）仍然同长度撞键。
 * 结果要经 {@link normalizeUpstreamResult} 才能用（它会丢掉指纹行）。
 */
export const toUpstreamCode = (code: string): string =>
  `${code}\n${fingerprintOf(code)}`;

/**
 * {@link toUpstreamCode} 的逆：丢掉指纹行的 token，再走 {@link normalizeHighlightResult} 核对。
 * 只取前 N 行（N = 真源码行数）；行数不够 / 文字对不上一律 null。
 */
export const normalizeUpstreamResult = (
  code: string,
  tokens: RawHighlightToken[][],
): DiffSyntaxToken[][] | null =>
  normalizeHighlightResult(code, tokens.slice(0, code.split("\n").length));

/**
 * 把高亮器的结果规整成 DiffSyntaxToken[][]，并核对「渲染出的文字 == 源码」。
 *
 * 为什么要核对：上游高亮器的结果缓存键只看「长度 + 首尾各 100 字符」，
 * 一个 >200 字符的 hunk 里把某个名字改成同样长度的另一个名字，新旧两侧就会撞同一个键，
 * 拿回来的是另一份源码的 token——我们是按 token.content 渲染的，不核对就会把旧文字显示在新行上。
 * 对不上（或行数不对）一律返回 null，调用方退回无语法色的原样显示。
 * 同长度新旧两侧撞键的根治在 {@link toUpstreamCode}（喂上游前打指纹），这里的核对是兜底，不再是常态路径。
 */
export const normalizeHighlightResult = (
  code: string,
  tokens: RawHighlightToken[][],
): DiffSyntaxToken[][] | null => {
  const srcLines = code.split("\n");
  if (tokens.length !== srcLines.length) return null;
  const out: DiffSyntaxToken[][] = [];
  for (let i = 0; i < srcLines.length; i++) {
    const row: DiffSyntaxToken[] = [];
    let text = "";
    for (const t of tokens[i]) {
      text += t.content;
      const light = t.htmlStyle?.color ?? t.color;
      const dark = t.htmlStyle?.["--shiki-dark"];
      const fs = t.fontStyle ?? 0;
      row.push({
        content: t.content,
        ...(light ? { light } : {}),
        ...(dark ? { dark } : {}),
        ...(fs & FONT_ITALIC ? { italic: true } : {}),
        ...(fs & FONT_BOLD ? { bold: true } : {}),
      });
    }
    if (text !== srcLines[i]) return null;
    out.push(row);
  }
  return out;
};

/**
 * 把各段的高亮结果按行号铺回 diff 行。
 * 返回与 lines 等长的数组：有颜色的行是 token 列表，没有（hunk 分隔 / 该段还没出结果 / 核对失败）是 null。
 * lookup 返回 null = 这段没有可用结果。
 */
export const assembleDiffLineTokens = (
  lines: DiffViewLine[],
  segments: DiffSegment[],
  lookup: (segment: DiffSegment) => DiffSyntaxToken[][] | null,
): (DiffSyntaxToken[] | null)[] => {
  const out: (DiffSyntaxToken[] | null)[] = lines.map(() => null);
  for (const seg of segments) {
    const tokens = lookup(seg);
    if (!tokens) continue;
    seg.lineIndexes.forEach((lineIdx, j) => {
      const kind = lines[lineIdx].kind;
      // 旧侧只负责删除行；上下文 / 新增行一律以新侧为准
      const owned = seg.side === "old" ? kind === "del" : kind !== "del";
      if (owned) out[lineIdx] = tokens[j] ?? null;
    });
  }
  return out;
};
