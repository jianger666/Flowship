/**
 * 「读源码做断言」的接线测试用的小工具（第三轮评审 P1-4：接线类 grep 测试普遍不剥注释、不断言条件结构）
 *
 * 为什么需要：
 * - 注释里照抄一遍被检查的那句代码，`toContain` / `toMatch` 照样过——真代码被删了也不红。所以读源码先剥注释。
 * - 只查 `toContain("deps.isGroupNonOwnerGuardEnabled()")`，把 `!(await deps.…)` 写成 `(await deps.…)` 也能过。
 *   所以关键条件要按「if 的条件项」逐项对账（含取反），见 {@link enclosingIfConditions}。
 *
 * 实现：一遍扫描把每个字符分成 代码 / 注释 / 字面量内容（字符串、正则、模板文本），
 * 所以字符串里的 `//`（URL）、正则里的 `/` + `*`、模板文本里的 `//` 都不会被误判成注释，模板 `${…}` 里的注释照常被剥掉。
 * 不是完整的 JS 解析器：除号 / 正则靠「前一个有意义的字符」判断（够读本仓的 .ts / .mjs / .js）；
 * **不要拿它读 .tsx 里的 JSX 文本**（JSX 文本里的 `//` 会被当成注释）。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

// 分类数组里 0 = 代码（Uint8Array 的默认值，不用单独写出来）、1 = 注释、2 = 字面量内容
const COMMENT = 1;
/** 字符串 / 正则 / 模板文本的「内容」（引号、斜杠、反引号这些定界符本身算代码） */
const LITERAL = 2;

/** 这些关键字后面的 `/` 是正则的开头，不是除号 */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const classify = (src: string): Uint8Array => {
  const n = src.length;
  const kind = new Uint8Array(n);
  /** 模板字符串里 `${` 之后的花括号深度栈：栈空 = 不在任何 `${}` 里 */
  const tplDepth: number[] = [];
  let inTemplate = false;
  /** 上一个有意义字符（非空白、非注释）；标识符 / 数字记成 "a" */
  let prevSig = "";
  let prevWord = "";
  let i = 0;

  const regexAllowed = (): boolean => {
    if (prevSig === "") return true;
    if (prevSig === "a") return REGEX_AFTER_WORD.has(prevWord);
    return !")]}".includes(prevSig) && prevSig !== "`" && prevSig !== '"' && prevSig !== "'";
  };

  while (i < n) {
    const ch = src[i]!;
    if (inTemplate) {
      if (ch === "\\") {
        kind[i] = LITERAL;
        if (i + 1 < n) kind[i + 1] = LITERAL;
        i += 2;
        continue;
      }
      if (ch === "`") {
        inTemplate = false;
        prevSig = "`";
        i++;
        continue;
      }
      if (ch === "$" && src[i + 1] === "{") {
        tplDepth.push(0);
        inTemplate = false;
        prevSig = "{";
        prevWord = "";
        i += 2;
        continue;
      }
      kind[i] = LITERAL;
      i++;
      continue;
    }

    const nx = src[i + 1];
    if (ch === "/" && nx === "/") {
      while (i < n && src[i] !== "\n") kind[i++] = COMMENT;
      continue;
    }
    if (ch === "/" && nx === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) kind[k] = COMMENT;
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let k = i + 1;
      while (k < n && src[k] !== ch && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      for (let m = i + 1; m < Math.min(k, n); m++) kind[m] = LITERAL;
      i = k + 1;
      prevSig = ch;
      prevWord = "";
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      i++;
      continue;
    }
    if (ch === "{") {
      if (tplDepth.length > 0) tplDepth[tplDepth.length - 1]!++;
      prevSig = "{";
      prevWord = "";
      i++;
      continue;
    }
    if (ch === "}") {
      if (tplDepth.length > 0) {
        if (tplDepth[tplDepth.length - 1] === 0) {
          tplDepth.pop();
          inTemplate = true;
          i++;
          continue;
        }
        tplDepth[tplDepth.length - 1]!--;
      }
      prevSig = "}";
      prevWord = "";
      i++;
      continue;
    }
    if (ch === "/") {
      if (regexAllowed()) {
        let k = i + 1;
        let inClass = false;
        let closed = false;
        while (k < n && src[k] !== "\n") {
          const c = src[k]!;
          if (c === "\\") {
            k += 2;
            continue;
          }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) {
            closed = true;
            break;
          }
          k++;
        }
        if (closed) {
          for (let m = i + 1; m < k; m++) kind[m] = LITERAL;
          i = k + 1;
          while (i < n && /[a-z]/i.test(src[i]!)) i++;
          prevSig = "a";
          prevWord = "";
          continue;
        }
      }
      prevSig = "/";
      prevWord = "";
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let k = i;
      while (k < n && /[\w$]/.test(src[k]!)) k++;
      prevWord = src.slice(i, k);
      prevSig = "a";
      i = k;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let k = i;
      while (k < n && /[\w.]/.test(src[k]!)) k++;
      prevSig = "a";
      prevWord = "";
      i = k;
      continue;
    }
    prevSig = ch;
    prevWord = "";
    i++;
  }
  return kind;
};

/** 剥掉注释（行注释 / 块注释）。长度不变：注释字符换成空格（换行保留），所以下标、行号与原文一一对应 */
export const stripComments = (src: string): string => {
  const kind = classify(src);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    out += kind[i] === COMMENT && c !== "\n" ? " " : c;
  }
  return out;
};

/**
 * 在 {@link stripComments} 之后再把字符串 / 正则 / 模板文本的内容换成 `_`（定界符保留；`${}` 里的代码保留）。
 * 长度不变。只用来做括号配平、按顶层运算符切分——字符串里的括号 / `&&` 不会干扰。
 */
export const maskLiterals = (src: string): string => {
  const kind = classify(src);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\n") out += c;
    else if (kind[i] === COMMENT) out += " ";
    else if (kind[i] === LITERAL) out += "_";
    else out += c;
  }
  return out;
};

/** 读仓库里的源文件并剥掉注释（路径相对仓库根） */
export const readSource = (rel: string): string => stripComments(fs.readFileSync(path.join(ROOT, rel), "utf-8"));

/** 从 `openIdx`（`(` / `[` / `{`）起配平同一种括号，返回配对的闭括号下标；配不上返回 -1。传入的必须是 {@link maskLiterals} 的结果 */
const matchClose = (masked: string, openIdx: number): number => {
  const open = masked[openIdx]!;
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
};

/** 按顶层（括号深度 0）的 `sep` 切开 `text`（`masked` 是同长的遮罩版），每段把连续空白压成一个空格 */
const splitTopLevel = (text: string, masked: string, sep: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && masked.startsWith(sep, i)) {
      parts.push(text.slice(from, i));
      from = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.length > 0);
};

/**
 * 找到 `needle` 第一次出现的位置，返回**把它圈在代码块里的最内层 `if (…) { … }`** 的条件，按顶层 `&&` 切成条件项（空白归一）。
 *
 * 用法：把「某个动作只在这些条件同时成立时才会发生」钉成**结构**，而不是几个子串——
 * 条件项被删 / 取反（`!x` → `x`）/ 被换成别的，对账的数组就对不上。
 *
 * - `needle` 出现在某个 `if` 的**条件里**（如 `if (boot && (await wake(...)))`）不算「圈在块里」，继续往外找。
 * - 传入的 `src` 应该已经剥过注释（{@link readSource} / {@link stripComments}）。
 * - 找不到 `needle` / 没有包着它的块 if：直接抛错（测试红，信息里带着线索），不会静默返回空数组。
 */
export const enclosingIfConditions = (src: string, needle: string): string[] => {
  const at = src.indexOf(needle);
  if (at < 0) throw new Error(`enclosingIfConditions：源码里找不到 ${JSON.stringify(needle)}`);
  const masked = maskLiterals(src);
  const ifs = [...masked.matchAll(/\bif\s*\(/g)].filter((m) => m.index! < at);
  for (let k = ifs.length - 1; k >= 0; k--) {
    const m = ifs[k]!;
    const open = m.index! + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close < 0 || close > at) continue; // needle 在这个 if 的条件里（或括号没配上）
    let b = close + 1;
    while (b < masked.length && /\s/.test(masked[b]!)) b++;
    if (masked[b] !== "{") continue; // 单语句 if：没有块可言
    const end = matchClose(masked, b);
    if (end < at) continue; // needle 在这个 if 块的后面
    return splitTopLevel(src.slice(open + 1, close), masked.slice(open + 1, close), "&&");
  }
  throw new Error(`enclosingIfConditions：${JSON.stringify(needle)} 没有被任何块 if 包着`);
};

/**
 * 取 `head` 之后第一个 `{ … }` 块的源码（含花括号）。典型：`blockAfter(src, "} finally")` / `blockAfter(src, "const consumeChatRun = async (")`。
 * `head` 找不到 / 后面没有配得上的花括号：抛错。
 */
export const blockAfter = (src: string, head: string): string => {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`blockAfter：源码里找不到 ${JSON.stringify(head)}`);
  const masked = maskLiterals(src);
  const open = masked.indexOf("{", at + head.length - (head.endsWith("{") ? 1 : 0));
  if (open < 0) throw new Error(`blockAfter：${JSON.stringify(head)} 之后没有花括号`);
  const close = matchClose(masked, open);
  if (close < 0) throw new Error(`blockAfter：${JSON.stringify(head)} 之后的花括号没有配上`);
  return src.slice(open, close + 1);
};
