/**
 * diff 里选中几行 → 「引用到对话」要塞进输入框的 markdown 片段（纯函数）。
 *
 * 选区按「单侧行号」描述：点旧文件那列行号 = 旧侧（改动前）、点新文件那列 = 新侧（改动后），
 * Shift 再点同一列另一行 = 扩成范围。取的是该侧真实存在的行——
 * 旧侧 = 删除 + 上下文、新侧 = 新增 + 上下文——所以引用出去的是干净的源码、不带 +/- 前缀。
 */

import type { DiffRow } from "@/lib/diff/model";
import type { DiffViewLine } from "@/lib/tool-display";

/** 一次最多引用的行数 / 字符数：超出截断并注明，避免一次把整个大文件塞进输入框 */
export const MAX_QUOTE_LINES = 200;
export const MAX_QUOTE_CHARS = 12_000;

export interface LineSelection {
  side: "old" | "new";
  /** 起止行号（含），from ≤ to */
  from: number;
  to: number;
}

/** 两个端点（顺序不限）→ 规整的选区 */
export const makeSelection = (
  side: "old" | "new",
  a: number,
  b: number,
): LineSelection => ({ side, from: Math.min(a, b), to: Math.max(a, b) });

/** 这一行是否落在选区内（旧侧看 oldLine、新侧看 newLine；该侧没有行号的行不算） */
export const lineInSelection = (
  line: DiffViewLine,
  sel: LineSelection | null,
): boolean => {
  if (!sel) return false;
  const n = sel.side === "old" ? line.oldLine : line.newLine;
  return n !== undefined && n >= sel.from && n <= sel.to;
};

/** 选区内的行（按文件顺序）；gap / 无结尾换行标记不算 */
export const selectionLines = (
  rows: readonly DiffRow[],
  sel: LineSelection,
): DiffViewLine[] => {
  const out: DiffViewLine[] = [];
  for (const r of rows) {
    if (r.type === "line" && r.line.kind !== "hunk" && lineInSelection(r.line, sel)) {
      out.push(r.line);
    }
  }
  return out;
};

/** 「L12」或「L12–L18」 */
export const describeSelection = (sel: LineSelection): string =>
  sel.from === sel.to ? `L${sel.from}` : `L${sel.from}–L${sel.to}`;

/** 围栏 / 行内代码要比内容里最长的连续反引号再多一个，否则内容里的 ``` 会提前关掉围栏 */
const longestBacktickRun = (text: string): number => {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return longest;
};

const inlineCode = (text: string): string => {
  const ticks = "`".repeat(longestBacktickRun(text) + 1);
  // 内容以反引号开头 / 结尾时 markdown 要求两侧各补一个空格
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
};

/**
 * 拼出引用片段：一行位置说明 + 一个代码块。
 * @param language 围栏语言（Shiki 语言 id，如 typescript）；不认识就别传
 */
export const formatSelectionQuote = (args: {
  path: string;
  sel: LineSelection;
  lines: readonly DiffViewLine[];
  language?: string | null;
}): string => {
  const { path, sel, lines, language } = args;
  let clipped = lines.length > MAX_QUOTE_LINES;
  let body = lines
    .slice(0, MAX_QUOTE_LINES)
    .map((l) => l.text.replace(/\r$/, ""))
    .join("\n");
  if (body.length > MAX_QUOTE_CHARS) {
    body = body.slice(0, MAX_QUOTE_CHARS);
    clipped = true;
  }
  const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
  const where = `${describeSelection(sel)}（${sel.side === "old" ? "改动前" : "改动后"}）`;
  return [
    `${inlineCode(path)} ${where}${clipped ? "，内容较长已截断" : ""}：`,
    "",
    `${fence}${language ?? ""}`,
    body,
    fence,
    "",
  ].join("\n");
};
