/**
 * 需求群答疑「回复协议」：答疑 agent 的最终回复 → 群里到底发什么。
 *
 * 为什么有这层：旧设计「答案无条件真 @ 回提问人」让本机机器人与对端机器人互 @ 成环
 *（2026-10-14 对接「安若流年」时 9 轮）。现在改成**由 agent 按提示词自己判断「回不回 / @ 谁」**，
 * 系统只负责把它的决定忠实落地：
 * - `parseGroupReply`：纯函数、绝不抛错，把 agent 的原话解析成 `ParsedGroupReply`（协议四条见 group-contract 头注释）；
 * - `buildGroupReplyRules`：产出写给 agent 看的规矩文本（拼进 prompt 由别处负责）。
 *
 * 只依赖 `group-contract`（类型与常量）+ `group-shared.mentionTag`（@ 标签的唯一出口）。
 */

import {
  GROUP_NEEDS_OWNER_CLOSERS,
  GROUP_NEEDS_OWNER_HEAD_RE,
  GROUP_NO_REPLY_TOKEN,
  GROUP_OWNER_ALIASES,
  type GroupMember,
  type GroupMention,
  type ParsedGroupReply,
} from "./group-contract";
import { mentionTag } from "./group-shared";

export interface ParseGroupReplyCtx {
  /** 群成员清单（真 @ 只认这里的展示名） */
  members: GroupMember[];
  /** 任务属主；`@宿主` / 「需属主确认」都 @ 他。没有就保持原样 / 降级成纯文本 */
  owner?: { openId: string; name: string };
  requester: { openId: string; name: string; isBot: boolean };
  /** 本机机器人自己的 open_id：绝不 @ 自己 */
  selfOpenId?: string;
}

/** 「需属主确认」说明的长度上限（群消息里一行话，不是长文） */
const NEEDS_OWNER_MAX = 200;

const silent = (): ParsedGroupReply => ({
  kind: "silent",
  text: "",
  mentions: [],
  unresolvedAts: [],
});

// ----------------- NO_REPLY 识别 -----------------

/** 成对的包裹引号 / 反引号（首尾必须配对才剥） */
const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "“": "”",
  "‘": "’",
  "「": "」",
  "『": "』",
};

/**
 * 整段被一对 ``` 围栏包住（以 ``` 开头、以 ``` 结尾、总长 ≥ 6）时返回围栏里的内容，否则 null。
 *
 * 为什么不用正则 `/^```[^\n]*\n?([\s\S]*?)\n?```$/`：它对「以 ``` 开头、首行超长且没有闭合」的输入是二次方
 *（`[^\n]*` 要逐字符回退，每退一步 `[\s\S]*?` 又扫一遍到文末；实测首行 4 万字符 ≈ 450ms，且按平方增长）。
 * 这里闭合 ``` 必然是整段最后三个字符，围栏内容的边界直接算出来，一遍 `indexOf` + 切片，线性。
 *
 * 语义与旧正则一致（有逐例对拍测试）：围栏头那一行（info string，如 ```text）整行丢掉，
 * 围栏内容去掉紧贴闭合围栏的一个换行。唯一有意的差异是「围栏之间没有换行」的单行写法 ```x```：
 * 旧正则把 x 当成 info string、内容算 ""（于是 ```NO_REPLY``` 不被认作哨兵、原样发群），
 * 这里按 CommonMark 的行内代码语义返回 x。
 */
export const unwrapCodeFence = (s: string): string | null => {
  if (s.length < 6 || !s.startsWith("```") || !s.endsWith("```")) return null;
  const inner = s.slice(3, s.length - 3);
  const nl = inner.indexOf("\n");
  if (nl < 0) return inner;
  const rest = inner.slice(nl + 1);
  return rest.endsWith("\n") ? rest.slice(0, -1) : rest;
};

/**
 * 去掉末尾连续的句号 / 感叹号。
 * 为什么不用 `/[。.！!]+$/`：它没有锚定起点，遇到一长串 `。` 时每个起点都要扫到串尾再失败，
 * 二次型（实测 5 万字符的标点串要十几秒，同步卡死事件循环）；从尾部倒着数一遍就是线性。
 */
const TRAILING_PUNCT = "。.！!";
const trimTrailingPunct = (s: string): string => {
  let end = s.length;
  while (end > 0 && TRAILING_PUNCT.includes(s[end - 1])) end--;
  return end === s.length ? s : s.slice(0, end);
};

/** markdown 强调符（首尾必须配对才剥）；长的在前，免得 `**x**` 被当成两层 `*` */
const EMPHASIS_MARKS = ["**", "__", "~~", "*", "_"] as const;

/** 剥掉首尾空白 / 代码围栏 / 成对引号 / markdown 强调 / 末尾标点，反复直到稳定（模型常常多层包裹：`"NO_REPLY。"`、`**NO_REPLY**`） */
const unwrapSentinelShell = (s: string): string => {
  let cur = s.trim();
  for (let i = 0; i < 10; i++) {
    const prev = cur;
    const fence = unwrapCodeFence(cur);
    if (fence !== null) cur = fence.trim();
    cur = trimTrailingPunct(cur).trim();
    if (cur.length >= 2 && QUOTE_PAIRS[cur[0]] === cur[cur.length - 1]) {
      cur = cur.slice(1, -1).trim();
    }
    for (const m of EMPHASIS_MARKS) {
      if (cur.length > m.length * 2 && cur.startsWith(m) && cur.endsWith(m)) {
        cur = cur.slice(m.length, -m.length).trim();
        break;
      }
    }
    if (cur === prev) break;
  }
  return cur;
};

/**
 * 判哨兵前的归一：NFKC（全角 `ＮＯ＿ＲＥＰＬＹ` → `NO_REPLY`、全角引号 / 反引号 / 括号 / 冒号 → 半角）
 * + 去掉格式控制字符（`\p{Cf}`：ZWSP / ZWNJ / ZWJ / WORD JOINER / BOM / 软连字符 / bidi 控制……，
 * `trim()` 不认它们）。**只用于判定**——不是哨兵时发群的永远是原文，不是归一化后的文本。
 */
const FORMAT_CHARS_RE = /\p{Cf}+/gu;
const foldForSentinel = (s: string): string =>
  s.normalize("NFKC").replace(FORMAT_CHARS_RE, "");

/** 入参必须已经 fold 过 */
const isFoldedSentinel = (folded: string): boolean =>
  unwrapSentinelShell(folded).toUpperCase() === GROUP_NO_REPLY_TOKEN;

const isSentinel = (s: string): boolean => isFoldedSentinel(foldForSentinel(s));

/**
 * 哨兵词后面直接跟说明的一行：`NO_REPLY（对方只是确认）` / `NO_REPLY：…` / `**NO_REPLY** - …`。
 * 模型常在哨兵后顺手补一句自我解释，原样发群等于把内部判断念给外部同事听。
 * 只认「哨兵词 + 括号 / 冒号 / 破折号 / 逗号」开头；`NO_REPLY 是哨兵词`、`NO_REPLY_FOO` 这类
 * 正常行文不算（哨兵词后必须紧跟说明起始符，不能只是空格 + 别的字）。
 *
 * 拆成两步而不是一条大正则，是因为判「整行被包住」要同时用到哨兵词之前的包裹符号（前缀）和它之后的全部内容：
 * - HEAD：group1 = 哨兵词之前的包裹符号串，group2 = 哨兵词之后到行尾的全部内容；
 * - NOTE_START：group1 = 说明起始符，group2 = 起始符之后到行尾的内容（起始符之前允许夹收尾的包裹符号 / 空白）。
 * 两条都锚在行首、中间只有一个 `X*`，失败时只回退一遍，线性。
 */
const SENTINEL_HEAD_RE = new RegExp(
  `^([\\s*_~\`"'“‘「『]*)${GROUP_NO_REPLY_TOKEN}([\\s\\S]*)$`,
  "i",
);
const SENTINEL_NOTE_START_RE = /^[*_~`"'”’」』]*\s*([（(：:\-—–，,])([\s\S]*)$/;

/**
 * 「哨兵词之后到行尾只剩收尾」：只含空白 / markdown 强调符 / 引号 / 反引号 / 句末标点。
 * 标注型的括号说明、整行包裹的收尾符之后允许出现这些（`` `NO_REPLY`（对方只是确认）。 ``），出现别的字就是后面还有正文。
 */
const SHELL_TAIL_RE = /^[\s*_~`"'”’」』。.！!]*$/;

/**
 * 说明是不是「恰好一对括号」：`rest` 是说明起始括号 `(` **之后**的内容（NFKC 后全角括号已是半角）；
 * 从起始括号起做配对（嵌套的括号一并配上），第一次配平之后到行尾只剩收尾符号才算。
 *
 * 为什么不是「说明以 `)` 结尾」（K4-03）：`` `NO_REPLY`（先说明）接口是 /a/b（见文档） `` 以 `)` 结尾，
 * 却是「一个标注 + 一句真正的回复」，按标注静默会把真正的回复整条吞掉。括号没配平（缺右括号）也不算：
 * 保守地当作后面还有正文、照发。线性：单遍扫描、遇到第一次配平就停。
 */
const isParenNoteOnly = (rest: string): boolean => {
  let depth = 1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return SHELL_TAIL_RE.test(rest.slice(i + 1));
  }
  return false;
};

/**
 * 整行被一对引号 / 反引号包住（K4-02）：`` `NO_REPLY：对方只是确认` ``、`"NO_REPLY：…"`、`**`NO_REPLY：…`**`。
 * 判法：哨兵词之前的包裹符号里出现过的每一种引号 / 反引号，看它在哨兵词**之后第一次**出现的收尾符——
 * 收尾符之后只剩收尾符号，就说明这对引号包住了整行（后面没有正文），按「哨兵 + 说明」处理。
 *
 * 为什么是「第一次出现的收尾符」而不是「行尾也是反引号」：`` `NO_REPLY`，不过我还是答一下：接口是 `/a/b` ``
 * 行首行尾都是反引号，但行首那一对在 NO_REPLY 后面就闭合了（是在解释哨兵词），行尾的反引号是正文里的行内代码；
 * 按「行首与行尾配对」判会把这条真正的回复吞掉。代价（残余）：说明自己含同种引号（`` `NO_REPLY：用 `x` 表示` ``，
 * 或单引号 `'NO_REPLY：don't know'` 里的撇号）时，第一次出现的收尾符不在行尾，判为「后面还有正文」而照发——
 * 宁可多发一行带哨兵词的话，也不吞回复。
 * 每种引号至多判一次（至多 7 种），所以前缀再长也只是常数倍的线性。
 */
const isWholeLineWrapped = (prefix: string, after: string): boolean => {
  const tried = new Set<string>();
  for (const ch of prefix) {
    const closer = QUOTE_PAIRS[ch];
    if (closer === undefined || tried.has(ch)) continue;
    tried.add(ch);
    const at = after.indexOf(closer);
    if (at >= 0 && SHELL_TAIL_RE.test(after.slice(at + closer.length))) return true;
  }
  return false;
};

/**
 * 哨兵词被**反引号 / 引号**包住（markdown 强调不算）：哨兵词之前的那串「包裹符号」里有引号类字符。
 * 例：`` `NO_REPLY` ``、`"NO_REPLY"`、`**`NO_REPLY`**`；不算：`NO_REPLY`、`**NO_REPLY**`。
 * `X*Y` 里 Y ⊂ X 且整个锚在行首，只回退一遍，线性。
 */
const QUOTE_WRAPPED_RE = /^[\s*_~`"'“‘「『]*[`"'“‘「『]/;

interface SentinelLine {
  /** pure = 整行除包裹外就是哨兵词；led = 哨兵词后紧跟说明 */
  kind: "pure" | "led";
  /** 哨兵词被反引号 / 引号包住 */
  quoted: boolean;
  /**
   * led 且是「标注」而不是「后面还有正文」：
   * ① 说明只是一对括号、括号配平后恰好到行尾（`（对方只是确认）`，见 isParenNoteOnly），或
   * ② 整行被一对引号 / 反引号包住（`` `NO_REPLY：对方只是确认` ``，见 isWholeLineWrapped）。
   */
  noteOnly: boolean;
}

/** 这一行是不是哨兵行；不是返回 null */
const classifySentinelLine = (line: string): SentinelLine | null => {
  const folded = foldForSentinel(line).trim();
  const quoted = QUOTE_WRAPPED_RE.test(folded);
  if (isFoldedSentinel(folded)) return { kind: "pure", quoted, noteOnly: false };
  const head = SENTINEL_HEAD_RE.exec(folded);
  if (!head) return null;
  const led = SENTINEL_NOTE_START_RE.exec(head[2]);
  if (!led) return null;
  const noteOnly =
    (led[1] === "(" && isParenNoteOnly(led[2])) || isWholeLineWrapped(head[1], head[2]);
  return { kind: "led", quoted, noteOnly };
};

/**
 * 「被反引号 / 引号包住的哨兵词、后面还有正文」= 模型在**解释**哨兵词、不是在用它：
 * 例如 `` `NO_REPLY`，不过这条我还是答一下：… ``。只有 led 才可能是这种（pure 的「后面还有正文」
 * 指的是别的行，由调用方按「首行 / 夹在正文里」分别处理）；标注型（括号说明恰好到行尾 / 整行被包住）不算。
 */
const isExplainingSentinel = (c: SentinelLine): boolean =>
  c.kind === "led" && c.quoted && !c.noteOnly;

/**
 * 首个非空行是哨兵行 → 整段静默（`NO_REPLY\n对方只是在确认`、`**NO_REPLY**（对方只是确认）`）。
 * 被引号 / 反引号包住的不走这条捷径：整段只有它一行时调用方早已按「整段是哨兵」静默了，走到这里说明
 * 它后面还有别的正文（`` `NO_REPLY`\n一大段答复 ``）或同一行还有正文（`` `NO_REPLY`，不过我还是答一下：… ``），
 * 那是在解释哨兵词，正文要照发。例外：标注型仍是「哨兵 + 说明」——只带一对括号说明且括号之后到行尾没有正文
 *（`` `NO_REPLY`（对方只是确认） ``），或整行被一对引号 / 反引号包住（`` `NO_REPLY：对方只是确认` ``）。
 */
const silencesWholeReply = (c: SentinelLine | null): boolean =>
  c !== null && (!c.quoted || (c.kind === "led" && c.noteOnly));

/**
 * 夹在正文里的这一行要不要剔：哨兵行（含各种包裹的纯哨兵、带说明的）都剔，除非是在「解释哨兵词」。
 * 注意：这里只看「这一行本身」；它在不在**闭合的代码围栏**里（围栏里的是示例、不剔）由调用方判（parseInner，见 closedFenceLineSpans）。
 */
const dropsSentinelLine = (c: SentinelLine | null): boolean =>
  c !== null && !isExplainingSentinel(c);

// ----------------- 工具 -----------------

/** 空行（只含水平空白的行）：`\n` + 水平空白 + `\n`，匹配起点是前一个 `\n`；`\r\n\r\n` / 全角空格行也算 */
const BLANK_LINE_RE_SOURCE = "\\n[^\\S\\n]*\\n";

const INF = Number.POSITIVE_INFINITY;

/**
 * 说明含空行时，闭合符离起头最远多少字符还算这条标记的（K4-05③）。说明最终只留 NEEDS_OWNER_MAX 字，
 * 3 倍留足余量；再远的行尾 `]]` 当作后文无关的括号，不跨过去。同时它也给「跨空行找闭合」的扫描量封了顶。
 */
const NEEDS_OWNER_CROSS_BLANK_MAX = NEEDS_OWNER_MAX * 3;

// ----- 标记扫描用的折叠（NFKC + 去 Cf）与位置映射 -----

/** 折叠后的文本；`map` = 折叠后第 i 个字符对应的原文区间 [start[i], end[i])，恒等折叠（什么都没改）时为 null */
interface FoldedText {
  text: string;
  map: { start: number[]; end: number[] } | null;
}

/**
 * 标记判定用的折叠（K4-04）：NFKC + 去 `\p{Cf}`，与哨兵判定同口径（全角方括号 `［［…］］`、括号后夹零宽字符都认），
 * 同时记下折叠后每个字符回到原文的区间——**只用于判定**，剪掉的是原文里的位置、发群的永远是原文剔掉标记后的内容。
 *
 * 为什么逐码点折叠、而不是对整串 `normalize`：整串 NFKC 会把一个字符展开成多个（`…` → `...`、`㈱` → `(株)`、`ﬁ` → `fi`）、
 * 去 Cf 又会让长度缩短，折叠后的下标和原文下标对不上；逐码点折叠才能给每个折叠后的字符记下它来自原文的哪一段。
 * 逐码点与整串的差别只在跨码点的组合（`e` + 组合重音符），对括号 / 冒号 / 关键词（汉字）的判定没有影响。
 * 整串折叠后与原文相同（绝大多数回复）就不建映射：下标恒等。ASCII / 汉字的 NFKC 是恒等、也不含 Cf，直接跳过 normalize。
 */
const foldWithMap = (s: string): FoldedText => {
  if (foldForSentinel(s) === s) return { text: s, map: null };
  const start: number[] = [];
  const end: number[] = [];
  const pieces: string[] = [];
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i) as number;
    const len = cp > 0xffff ? 2 : 1;
    const ch = s.slice(i, i + len);
    const piece = cp < 0x80 || (cp >= 0x4e00 && cp <= 0x9fff) ? ch : foldForSentinel(ch);
    for (let k = 0; k < piece.length; k++) {
      start.push(i);
      end.push(i + len);
    }
    pieces.push(piece);
    i += len;
  }
  return { text: pieces.join(""), map: { start, end } };
};

/** 仅供测试：直接断言折叠文本与位置映射的不变量（tests/group-reply-protocol-fold-fuzz-r8.test.ts），生产代码不要用 */
export const __foldWithMapForTest = foldWithMap;

// ----- 代码区间（围栏 / 行内代码）-----

/** 围栏起 / 止行：缩进至多 3 格 + 连续 ≥3 个反引号或波浪线；group1 = 围栏符号串，group2 = 其后的内容（info string） */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;

/** 一行里成对的行内代码（反引号串长度相同才配对，只在同一行内配对），区间追加进 `out`（起点 / 终点，终点不含） */
const collectInlineCodeSpans = (line: string, base: number, out: number[]): void => {
  const runs: number[] = []; // 平铺：[起点, 长度, 起点, 长度, …]
  for (let i = 0; i < line.length; ) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] === "`") j++;
    runs.push(i, j - i);
    i = j;
  }
  const count = runs.length / 2;
  if (count < 2) return;
  // 每一段反引号向后最近的「同长度」那一段：从右往左一遍扫出来，整行线性（不是对每一段再向后找）
  const next = new Array<number>(count).fill(-1);
  const lastOfLen = new Map<number, number>();
  for (let r = count - 1; r >= 0; r--) {
    const len = runs[2 * r + 1];
    next[r] = lastOfLen.get(len) ?? -1;
    lastOfLen.set(len, r);
  }
  for (let r = 0; r < count; ) {
    const m = next[r];
    if (m < 0) {
      r++;
      continue;
    }
    out.push(base + runs[2 * r], base + runs[2 * m] + runs[2 * m + 1]);
    r = m + 1;
  }
};

/**
 * 找出**闭合的**围栏：返回平铺的行号区间 [起行, 止行, 起行, 止行, …]（含起止两行，按行序、互不重叠）。
 *
 * 围栏起行：缩进至多 3 格 + 连续 ≥3 个反引号或波浪线（反引号围栏的 info string 里不能再有反引号：```x``` 是行内代码）；
 * 止行：同种符号、至少一样长、其后只有空白。**起行之后找不到止行的（未闭合）不算围栏**（第八轮 L4-05）：
 * 模型漏写收尾 ``` 时，它后面的内容是普通文字，不是代码——否则围栏后面真正的「需属主确认」会被当示例、原样发群且属主没被 @，
 * 与 `findCodeRanges` 注释里「判错宁可把示例当标记触发」的方向相反（第七轮曾把「未闭合 = 到文末都是代码」钉成规格）。
 * 这个判定被「代码区间」与「哨兵行剔除」两处共用（见 parseInner：围栏里的 NO_REPLY 行是示例、不剔），两处口径一致。
 *
 * 线性：先逐行一遍算出「第 i 行及之后每种符号最长的止行候选」（后缀最大值），再逐行一遍——起行是否闭合 O(1) 判定；
 * 闭合的围栏只扫一次到止行、扫过的行不再重扫。不用「向后找止行、找不到就回头重扫」：
 * 大量没收尾的起行（```a\n 重复 n 次）会变成二次型。
 */
const closedFenceLineSpans = (lines: readonly string[]): number[] => {
  const n = lines.length;
  const fm: Array<RegExpExecArray | null> = new Array(n);
  // sufTick[i] / sufTilde[i] = 第 i 行及之后「只含围栏符号」的止行候选里，反引号 / 波浪线串的最大长度（没有 = 0）
  const sufTick = new Array<number>(n + 1).fill(0);
  const sufTilde = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const f = FENCE_LINE_RE.exec(lines[i]);
    fm[i] = f;
    sufTick[i] = sufTick[i + 1];
    sufTilde[i] = sufTilde[i + 1];
    if (f && f[2].trim() === "") {
      if (f[1][0] === "`") sufTick[i] = Math.max(sufTick[i], f[1].length);
      else sufTilde[i] = Math.max(sufTilde[i], f[1].length);
    }
  }
  const spans: number[] = [];
  for (let i = 0; i < n; ) {
    const f = fm[i];
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      const ch = f[1][0];
      const len = f[1].length;
      const closable = (ch === "`" ? sufTick[i + 1] : sufTilde[i + 1]) >= len;
      if (closable) {
        let j = i + 1;
        for (; j < n; j++) {
          const g = fm[j];
          if (g && g[1][0] === ch && g[1].length >= len && g[2].trim() === "") break;
        }
        spans.push(i, j);
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return spans;
};

/** 仅供测试：与朴素的二次型预言对拍（tests/group-reply-protocol-fold-fuzz-r8.test.ts），生产代码不要用 */
export const __closedFenceLineSpansForTest = closedFenceLineSpans;

/** 每一行是不是在闭合的围栏里（含起止行）。线性 */
const closedFenceLineFlags = (lines: readonly string[]): boolean[] => {
  const flags = new Array<boolean>(lines.length).fill(false);
  const spans = closedFenceLineSpans(lines);
  for (let k = 0; k < spans.length; k += 2) {
    for (let i = spans[k]; i <= spans[k + 1]; i++) flags[i] = true;
  }
  return flags;
};

/**
 * 找出代码区间 [起点, 终点)（K4-05②）：**闭合的**围栏代码块（``` / ~~~，含起止行；未闭合的围栏不算，见 closedFenceLineSpans）
 * 与同一行内成对的行内代码。返回按起点排序、互不重叠的平铺数组 [s0, e0, s1, e1, …]，起点 / 终点都在传入文本的下标系里。
 *
 * 为什么只认「同一行内」的行内代码：落单的反引号（`it`s`）不能把后文整段「吞成代码」让真正的标记失效——
 * 判错的方向宁可是「把示例当成标记触发」（旧行为），也不是「真标记被当示例、属主没被 @」。
 * 未闭合围栏起行之后的行不在代码块里、照常按行识别行内代码（`好的\n```bash\n写法是 `[[需属主确认：x]]``：行内代码里的示例仍不触发）。
 * 围栏起始行的 info string 里不能有反引号（```x``` 是行内代码、不是围栏）。线性：逐行一遍。
 */
const findCodeRanges = (text: string): number[] => {
  const ranges: number[] = [];
  const lines = text.split("\n");
  const spans = closedFenceLineSpans(lines);
  let s = 0; // 指向 spans 里下一个还没进入的围栏
  let fenceStart = 0;
  let fenceLast = -1; // 当前所在围栏的止行行号；-1 = 不在围栏里
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const eol = pos + line.length;
    if (fenceLast < 0 && s < spans.length && spans[s] === i) {
      fenceStart = pos;
      fenceLast = spans[s + 1];
      s += 2;
    }
    if (fenceLast >= 0) {
      // 区间含止行
      if (i === fenceLast) {
        ranges.push(fenceStart, eol);
        fenceLast = -1;
      }
    } else if (line.includes("`")) {
      collectInlineCodeSpans(line, pos, ranges);
    }
    pos = eol + 1;
  }
  return ranges;
};

/**
 * 扫出并剥掉 `body` 里所有「需属主确认」标记，每剥一个就把它的说明交给 `onMarker`；返回剥完的文本
 *（没有标记时 `found=false`、text 原样）。
 *
 * 标记 = 起头（`[[` / `【` + 关键词 + 冒号，写法变体见 group-contract 的 `GROUP_NEEDS_OWNER_HEAD_RE`）
 * + 说明 + 闭合符（按括号族配对：`]]` / `】`）。
 *
 * **判定在折叠文本上做、剪切在原文上做**（K4-04，见 foldWithMap）：起头 / 闭合符 / 空行都按 NFKC + 去 Cf 之后的文本判，
 * 全角 `［［需属主确认：…］］`、括号后夹零宽字符都认；剪掉的是映射回原文的区间（连同紧贴标记两侧的零宽字符），说明取原文，
 * 发群的永远是原文剔掉标记后的内容。
 *
 * 找闭合符的规则（各条互相自洽；`q` = 起头之后第一个闭合符）：
 * - **同一段里找**：段 = 以空行（只含空白的行）分隔。`q` 在下一个空行之前就是闭合标记候选（说明可跨行）；
 *   找不到（没有闭合符）就是**未闭合**标记——说明只取到行尾，后面的正文原样保留，说明末尾残留的 `]` / `】`
 *   （模型只漏了一个）不进说明。旧实现是「最后一个 `]]` 之前全跑惰性匹配」，会把隔着空行的无关 `]]` 当闭合、把中间整段正文吞进说明。
 * - **说明里的括号别提前截断**（K4-05①）：说明按 `[`（`【` 族按 `【`）与 `]` 配平。`q` 所在的连续 `]` 串里，从 `q` 起逐个往后挪，
 *   挪到说明配平为止（`看 a[0]]]` → 闭合符取最后两个 `]`，说明 = `看 a[0]`）；说明配平后串里多出来的 `]` 当笔误一并剔掉，
 *   正文不残留孤立括号。挪完仍没配平（`看 a[b[0]] 怎么取]]`：`]]` 其实是下标的收尾）→ 若这一行**行尾**有闭合符、
 *   `q` 到它之间没有别的标记起头、**且取它能让说明配平**（第八轮 L4-10），就取行尾那个（说明里保留 `]]`）；
 *   否则退回 `q`（第一个闭合符；`[[需属主确认：用 [ 表示]] 后面还有一句话 [[链接]]` 的行尾 `]]` 凑不平括号，
 *   取它会把后半句与后面的链接整句吞进说明）。残余：行尾恰好有一个能凑平的 `]]`（`用 [ 表示]] 然后 x]]`）仍会取行尾——
 *   这里「凑平」按「左括号数 ≤ 右括号数」判（与上面 `q` 串的配平口径一致，多一个 `]` 的笔误也算配平），该例左 1 右 2 因此算凑平。
 *   改成「恰好相等才取行尾」可以把这一例分出去（沙箱实测：只有钉着这条残余的用例会变，第七轮 K4-05 与第八轮其余用例全绿），
 *   本轮未采用：多一个 `]` 的写法（`看 a[0]] 的值]]`）会改取第一个闭合符、把 `的值]]` 留在正文，两种取法各有代价，留给后续取舍。
 *   说明已配平时一律取 `q`，不会因为同一行别处碰巧也有 `]]` 就把后文吞进说明。
 * - **说明里含空行**（K4-05③）：`q` 在下一个空行**之后**时，满足全部条件才算闭合：闭合符串之后到行尾只有空白（行尾）、
 *   离起头不超过 NEEDS_OWNER_CROSS_BLANK_MAX 字符、中间没有别的标记起头、说明配平。任何一条不满足 → 未闭合，后文原样保留
 *   （`后面的无关段落 a]] b` 的 `]]` 在行中间，所以不会被当闭合符）。残余：空行之后一段话恰好以 `]]` 结尾、又在近处，会被当作说明的延续。
 * - **代码里的标记不触发**（K4-05②）：起头落在**闭合的**围栏代码块 / 行内代码里的当示例，不算标记、原样保留（不留空围栏）。
 *   没收尾的围栏起头不算围栏（第八轮 L4-05，见 closedFenceLineSpans）：模型漏写收尾 ``` 时，后面真正的标记照常触发。
 *
 * 线性：旧代码注释写过的二次型来源是「每个起头都向后扫一遍找闭合符」。这里「from 之后第一个闭合符 / 第一个空行 / 下一个起头 /
 * 下一个换行」各缓存一份（from 单调不减，缓存的位置 ≥ from 就仍是答案；否则才从 from 重扫，而重扫区间与上一次互不重叠），
 * 大量没有闭合符的起头不会各扫一遍；每个标记消耗的区间不再被重扫。配平计数只扫「起头到闭合符」这段（被消耗掉的区间，
 * 跨空行时再封顶 NEEDS_OWNER_CROSS_BLANK_MAX）；行尾去空白按行缓存；代码区间懒计算、逐行一遍。
 */
export const stripNeedsOwnerMarkers = (
  body: string,
  onMarker: (explain: string) => void,
): { text: string; found: boolean } => {
  const fo = foldWithMap(body);
  const F = fo.text;
  const map = fo.map;
  // 折叠后第 i 个字符在原文里的起点 / 折叠后前 i 个字符在原文里的终点；
  // 用「下一个字符的起点 / 上一个字符的终点」做剪切边界，紧贴标记的零宽字符（折叠时被删掉的 Cf）因此一并剪掉
  const origFrom = (i: number): number => (!map ? i : i >= F.length ? body.length : map.start[i]);
  const origTo = (i: number): number => (!map ? i : i <= 0 ? 0 : map.end[i - 1]);

  // 每次调用新建带 g 的实例：lastIndex 是实例状态，不能跨调用共享
  const head = new RegExp(GROUP_NEEDS_OWNER_HEAD_RE.source, "g");
  const headProbe = new RegExp(GROUP_NEEDS_OWNER_HEAD_RE.source, "g");
  const blank = new RegExp(BLANK_LINE_RE_SOURCE, "g");
  const cached = (find: (from: number) => number) => {
    let pos = -1;
    let base = -1;
    return (from: number): number => {
      // from 单调不减时缓存的答案仍对；万一倒退（不该发生）就重算，保证正确性而不是依赖调用顺序
      if (from < base || pos < from) {
        pos = find(from);
        base = from;
      }
      return pos;
    };
  };
  const nextBlank = cached((from) => {
    blank.lastIndex = from;
    const m = blank.exec(F);
    return m ? m.index : INF;
  });
  const indexOfNewline = (from: number): number => {
    const i = F.indexOf("\n", from);
    return i < 0 ? INF : i;
  };
  const nextNewline = cached(indexOfNewline); // 未闭合：说明取到行尾
  const nextLineEnd = cached(indexOfNewline); // 闭合符所在行的行尾（与上面调用点不同、各自单调）
  const nextHead = cached((from) => {
    headProbe.lastIndex = from;
    const m = headProbe.exec(F);
    return m ? m.index : INF;
  });
  const nextCloser = new Map<string, (from: number) => number>();
  for (const [open, close] of Object.entries(GROUP_NEEDS_OWNER_CLOSERS)) {
    nextCloser.set(
      open,
      cached((from) => {
        const i = F.indexOf(close, from);
        return i < 0 ? INF : i;
      }),
    );
  }

  // 去掉 [a, b) 末尾的空白与残留的 `]` / `】`；末尾没有这类括号就原样返回 b
  const trimCloseBracketsEnd = (a: number, b: number): number => {
    let e = b;
    while (e > a && /\s/.test(F[e - 1])) e--;
    let bare = e;
    while (bare > a && (F[bare - 1] === "]" || F[bare - 1] === "】")) bare--;
    return bare === e ? b : bare;
  };
  // 一行（行尾位置 lineEnd）去掉行尾水平空白后的终点；按行缓存——同一行有很多起头时不重复回扫
  let trimKey = -1;
  let trimVal = -1;
  const trimmedLineEnd = (lineEnd: number): number => {
    if (lineEnd !== trimKey) {
      let te = lineEnd;
      while (te > 0 && F[te - 1] !== "\n" && /\s/.test(F[te - 1])) te--;
      trimKey = lineEnd;
      trimVal = te;
    }
    return trimVal;
  };

  let codeRanges: number[] | undefined;
  let codeAt = 0;
  const inCode = (pos: number): boolean => {
    codeRanges ??= F.includes("`") || F.includes("~") ? findCodeRanges(F) : [];
    while (codeAt < codeRanges.length && codeRanges[codeAt + 1] <= pos) codeAt += 2;
    return codeAt < codeRanges.length && codeRanges[codeAt] <= pos;
  };

  interface CloseAt {
    /** 说明终点（不含） */
    explainEnd: number;
    /** 整个标记的终点（不含） */
    end: number;
  }

  /** 闭合标记的位置（折叠文本下标系）；找不到可接受的闭合符 → null（调用方按未闭合处理） */
  const locateClosed = (open: string, afterHead: number): CloseAt | null => {
    const closer = GROUP_NEEDS_OWNER_CLOSERS[open];
    const L = closer.length;
    const closeCh = closer[L - 1];
    const openCh = open[0];
    const q = nextCloser.get(open)?.(afterHead) ?? INF;
    if (q === INF) return null;
    const crossing = q > nextBlank(afterHead); // 第一个闭合符在下一个空行之后
    if (crossing && (q - afterHead > NEEDS_OWNER_CROSS_BLANK_MAX || nextHead(afterHead) < q)) {
      return null;
    }
    // q 所在的连续闭合字符串（`]]]` 里 q 是第一个 `]`）
    let runEnd = q;
    while (F[runEnd] === closeCh) runEnd++;
    // 说明 [afterHead, q) 的括号配平情况；从 q 起往后挪（挪过的闭合字符成了说明里的内部闭合符），挪到配平为止
    let opens = 0;
    let closes = 0;
    for (let i = afterHead; i < q; i++) {
      if (F[i] === openCh) opens++;
      else if (F[i] === closeCh) closes++;
    }
    const maxShift = runEnd - q - L;
    let shift = 0;
    while (opens > closes + shift && shift < maxShift) shift++;
    const balanced = opens <= closes + shift;
    if (crossing) {
      // 跨了空行：说明必须配平、闭合符串之后必须到行尾（否则是后文行中间的无关括号）
      if (!balanced) return null;
      const nl = nextLineEnd(runEnd);
      if (trimmedLineEnd(nl === INF ? F.length : nl) !== runEnd) return null;
    } else if (!balanced) {
      // 说明里还有没配平的 `[`：若这一行行尾有闭合符、之间没有别的起头、**且取它能让说明配平**，就取行尾那个
      //（`数组 a[b[0]] 怎么取]]`：前一个 `]]` 其实是下标的收尾）；凑不平就退回第一个闭合符 q（第八轮 L4-10）。
      // 不配平就取行尾会把后文整句吞进说明：`用 [ 表示]] 后面还有一句话 [[链接]]` 的行尾 `]]` 属于后面的链接。
      const nl = nextLineEnd(runEnd);
      const t = trimmedLineEnd(nl === INF ? F.length : nl) - L;
      if (t >= runEnd && F.startsWith(closer, t) && nextHead(runEnd) >= t) {
        // q 那一整串闭合字符都成了说明里的内容；再数 [runEnd, t)。这段里没有别的起头（上一行判过），
        // 取到就被消耗掉，取不到也不会与后面标记的扫描区间重叠（后面的起头都在 t 之后），整体仍是线性
        let o = opens;
        let c = closes + (runEnd - q);
        for (let i = runEnd; i < t; i++) {
          if (F[i] === openCh) o++;
          else if (F[i] === closeCh) c++;
        }
        if (o <= c) return { explainEnd: t, end: t + L };
      }
    }
    return { explainEnd: q + shift, end: runEnd };
  };

  /** 未闭合：说明只取到行尾（末尾残留的 `]` / `】` 不进说明） */
  const locateUnclosed = (afterHead: number): CloseAt => {
    const nl = nextNewline(afterHead);
    const eol = nl === INF ? F.length : nl;
    return { explainEnd: trimCloseBracketsEnd(afterHead, eol), end: eol };
  };

  const parts: string[] = [];
  let cursor = 0;
  let found = false;
  for (let m = head.exec(F); m; m = head.exec(F)) {
    if (inCode(m.index)) continue; // 代码里的示例不是标记
    const afterHead = m.index + m[0].length;
    const close = locateClosed(m[1], afterHead) ?? locateUnclosed(afterHead);
    const explainFrom = origFrom(afterHead);
    const explain = body.slice(explainFrom, Math.max(explainFrom, origTo(close.explainEnd)));
    const cutStart = Math.max(cursor, origTo(m.index));
    const cutEnd = Math.max(cutStart, origFrom(close.end));
    parts.push(body.slice(cursor, cutStart));
    cursor = cutEnd;
    found = true;
    onMarker(explain);
    head.lastIndex = close.end;
  }
  if (!found) return { text: body, found: false };
  parts.push(body.slice(cursor));
  return { text: parts.join(""), found: true };
};

/** 说明里的 at 开 / 闭标签（属性段限长，见 sanitizeExplain） */
const AT_OPEN_TAG_RE = /<at\b[^>]{0,200}>/gi;
const AT_CLOSE_TAG_RE = /<\/at\b[^>]{0,200}>/gi;

/** 手写的 at 标签：`<at user_id="ou_x">名字</at>`（属性引号容忍单 / 双） */
const AT_TAG_RE = /<at\s+user_id\s*=\s*["']([^"']*)["']\s*>([\s\S]*?)<\/at>/iy;

/**
 * 任何位置的 at 标签碎片（开标签 / 闭标签 / 属性写法变体 / 残缺无 `>`）：`<` 或 `</` 后接 `at`、
 * 且 `at` 后不是名字字符（`<atlas>` 之类不算）。
 *
 * `<` 与 `at`（以及 `/` 与 `at`）之间允许夹空白 / 零宽字符：飞书服务端解析有多宽松我们没法验证，
 * 宁可多把一个 `<` 显示成全角，也不留一个「可能被解析」的变体（`< at user_id=…>`、`<\u200bat …>`）。
 * 结构写成「`<` 空白* ( `/` 空白* )? at」而不是两段相邻的 `空白*`：相邻的同类量词在失败时
 * 会互相回溯，长空白串上是二次型。
 */
const AT_FRAGMENT_LT_RE = /<(?=[\s\p{Cf}]*(?:\/[\s\p{Cf}]*)?at(?![A-Za-z0-9_-]))/giu;

/**
 * 把 at 标签碎片里的 `<` 换成全角 `＜`——只换这一个字符、不删任何字，使它在飞书里只是普通文字。
 *
 * 为什么不是「删掉标签」：删除会让标签两侧的文字粘在一起，`<<at x>at user_id="all">` 删掉中间那段
 * 反而拼出一个完整的 at 标签（要不动点迭代才删得干净，且最坏二次型）。逐字替换不改变任何相邻关系，
 * 一遍扫描就保证输出里不再有 `<at` / `</at`，是「不可信 id 绝不出现在 text 里」这条硬承诺的最后一道闸。
 */
const neutralizeAtFragments = (s: string): string =>
  s.replace(AT_FRAGMENT_LT_RE, "＜");

/**
 * 本模块里**所有**真 @ 标签的唯一出口：名字理论上入口处已清洗过（group-shared.sanitizeGroupMemberName
 * 同样拆掉 `<>`），这里再洗一遍——可信的是 id，不是名字里的字；名字取自 agent 手写标签的 inner 时
 * 尤其如此（成员展示名为空的可信 id 会退回用 inner）。
 */
const safeMentionTag = (openId: string, name: string): string =>
  mentionTag(openId, name.replace(/[<>]/g, ""));

/** 未识别 `@xxx` 里 xxx 的终止符：空白 + 中英文标点 */
const TOKEN_STOP_RE = /[\s,，.。!！?？:：;；、()（）[\]【】{}<>《》"'“”‘’`~@＠]/;

const isAsciiWord = (ch: string | undefined): boolean =>
  !!ch && /^[A-Za-z0-9_]$/.test(ch);

const isAt = (ch: string): boolean => ch === "@" || ch === "＠";

/** `@` 之后紧跟「域名形态」（至少一个点分隔的 ASCII 标签）：`Bob.com`、`mail.example.com.cn` */
const EMAIL_DOMAIN_RE = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/y;

/**
 * pos 处的 ASCII `@` 是不是邮箱里的 @：前一个字符是邮箱本地部分字符、后面紧跟域名形态。
 *
 * 为什么要在「命中成员名」之前判：成员叫 `Bob` 时，`zhang@Bob.com` 会被当成 @Bob 改写成
 * `zhang<at …>Bob</at>.com`——邮箱坏了、还多通知了一个人。只靠「前一个字符是字母数字」不够窄
 * （`hi@Bob 在吗` 没有点，更像是漏了空格的真 @），所以要求后面真的长得像域名。
 */
const isEmailAt = (text: string, pos: number): boolean => {
  if (text[pos] !== "@" || pos === 0) return false;
  if (!/[A-Za-z0-9._%+-]/.test(text[pos - 1])) return false;
  EMAIL_DOMAIN_RE.lastIndex = pos + 1;
  return EMAIL_DOMAIN_RE.test(text);
};

const normalizeSpaces = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * 去掉每个「后面还有换行」的行的行尾空格 / 制表符（等价于 `/[ \t]+\n/g → "\n"`）。
 * 不用那条正则：它没有锚定起点，正文里一长串空格 / 制表符没有紧跟换行时，每个起点都要扫完整串
 * 再失败，二次型；逐行从尾部倒着数就是线性。
 */
const stripLineTrailingBlanks = (s: string): string => {
  const lines = s.split("\n");
  for (let k = 0; k < lines.length - 1; k++) {
    const line = lines[k];
    let end = line.length;
    while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
    if (end !== line.length) lines[k] = line.slice(0, end);
  }
  return lines.join("\n");
};

/** 按码点截断；超长时最后一个字符换成省略号，总长不超过 max */
const clip = (s: string, max: number): string => {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return `${chars.slice(0, max - 1).join("")}…`;
};

/**
 * 说明里若混进手写 at 标签，压成纯文本 `@名字`——说明是补在正文末尾、不再走 @ 解析，
 * 不洗的话模型能借这行夹带任意 open_id。
 */
const sanitizeExplain = (s: string): string =>
  neutralizeAtFragments(
    // 开标签换成 `@`、闭标签删掉：等价于 `<at …>名字</at>` → `@名字`，但不再用「开标签 + 惰性匹配到 </at>」
    // 的写法——说明里一长串没有闭合的 `<at x>` 会让每个开标签都扫一遍到文末（二次型）。
    // 属性段限长 200：真实标签的属性远短于此，超长的当残缺碎片，交给 neutralizeAtFragments 拆掉
    s.replace(AT_OPEN_TAG_RE, "@").replace(AT_CLOSE_TAG_RE, ""),
  );

interface Target {
  /** 目标 open_id；空串 = 认得名字但没法落成真 @（别名 + 无属主） */
  openId: string;
  /** 真 @ 标签里展示的名字 */
  display: string;
}

interface Candidate extends Target {
  /** 正文里需要紧跟 @ 的字面名字 */
  match: string;
  /** true = `match` 是「prompt 里展示的清洗名」（与原名不同），不是成员的原始展示名 */
  alias?: boolean;
}

/** prompt 里单个名字的展示上限（与 group-answer-context 的 cleanName 同口径） */
const PROMPT_NAME_MAX = 40;

/**
 * 成员名字在 prompt「群里的人」清单里被展示成什么样（与 group-answer-context.cleanName 逐步一致）：
 * 压空白 / 去控制字符 → 拆掉 `[]<>` → 超过 40 个字符截成前 39 个 + 「…」。
 *
 * 为什么解析器要认它：prompt 要求 agent「名字必须与下面完全一致」地写 `@名字`，而清单里展示的
 * 是清洗后的名字；昵称 `[外包]李四` 在清单里是 `外包李四`，agent 照抄写 `@外包李四`，
 * 只认原名就会静默落成 unresolvedAts（对机器人提问人这个失败对方完全看不见）。
 * 对拍测试（tests/group-reply-protocol-r5.test.ts）用真实的 formatRosterSection 钉住两处口径别漂。
 */
const promptNameOf = (raw: string): string => {
  const s = raw
    .replace(/\s+/g, " ")
    .replace(/\p{C}/gu, "")
    .trim()
    .replace(/[[\]<>]/g, "")
    .trim();
  return s.length > PROMPT_NAME_MAX ? `${s.slice(0, PROMPT_NAME_MAX - 1)}…` : s;
};

/**
 * 解析 agent 的最终回复。纯函数、绝不抛错（内部任何异常都按 silent 处理——宁可群里没声音，
 * 也不发出一条没经过协议校验的原文，比如夹带伪造 open_id 的 at 标签）。
 */
export const parseGroupReply = (
  raw: string,
  ctx: ParseGroupReplyCtx,
): ParsedGroupReply => {
  try {
    return parseInner(typeof raw === "string" ? raw : "", ctx);
  } catch {
    return silent();
  }
};

const parseInner = (raw: string, ctx: ParseGroupReplyCtx): ParsedGroupReply => {
  const input = raw.trim();
  if (!input || isSentinel(input)) return silent();

  // 1) 单独成行的 NO_REPLY：模型手滑夹在正文里，剔掉这些行其余照发（不整条吞）
  const lines = input.split(/\r?\n/);
  // 首个非空行就是哨兵（`NO_REPLY\n对方只是在确认`）：它后面的字是对哨兵的自我解释，不是要发的答复——
  // 整段静默。选静默是保守取舍：原话仍会进群问答 tab 供审计，比把「对方只是在确认」发给对方强。
  // 例外：被反引号 / 引号包住的哨兵词后面还有正文，是在解释哨兵词、不是在用它（见 silencesWholeReply）
  const firstLine = lines.find((l) => l.trim() !== "");
  if (firstLine !== undefined && silencesWholeReply(classifySentinelLine(firstLine))) {
    return silent();
  }
  // 闭合围栏里的哨兵行是示例（格式说明 / 代码块），不剔（第八轮 L4-06：旧实现剔掉后留下空围栏）；
  // 围栏判定与代码区间共用 closedFenceLineSpans（未闭合的围栏起头不算围栏）。围栏分析懒做——绝大多数回复没有候选行。
  let fenced: boolean[] | undefined;
  const inClosedFence = (idx: number): boolean => {
    fenced ??= closedFenceLineFlags(lines.map((l) => foldForSentinel(l)));
    return fenced[idx];
  };
  let body = lines
    .filter((line, idx) => !dropsSentinelLine(classifySentinelLine(line)) || inClosedFence(idx))
    .join("\n");

  // 2) 「需属主确认」标记：取第一条非空说明，所有标记从正文剥掉（闭合 / 未闭合 / 括号与空白变体都在
  // stripNeedsOwnerMarkers 里；漏写闭合符的照样落地——否则标记原样发群、属主既没被 @ 也没有待办）
  let needsOwner: string | undefined;
  const takeMarker = (explain: string): void => {
    if (needsOwner === undefined) {
      const e = clip(normalizeSpaces(sanitizeExplain(explain)), NEEDS_OWNER_MAX);
      if (e) needsOwner = e;
    }
  };
  const marked = stripNeedsOwnerMarkers(body, takeMarker);
  body = marked.text;
  if (marked.found) {
    // 标记通常独占一行，剥掉后会留下空行 / 行尾空格
    body = stripLineTrailingBlanks(body).replace(/\n{3,}/g, "\n\n");
  }

  // 3) @ 解析
  const owner =
    ctx.owner && ctx.owner.openId.trim()
      ? { openId: ctx.owner.openId.trim(), name: ctx.owner.name ?? "" }
      : undefined;
  const selfOpenId = ctx.selfOpenId?.trim() || "";

  const nameOf = new Map<string, string>(); // openId → 展示名（可信来源）
  const candidates: Candidate[] = [];
  const addMember = (openId: string, name: string) => {
    const id = openId.trim();
    if (!id) return;
    const display = name.trim();
    if (!nameOf.get(id)) nameOf.set(id, display);
    if (display) {
      candidates.push({ match: display, openId: id, display });
      const shown = promptNameOf(display);
      if (shown && shown !== display) {
        candidates.push({ match: shown, openId: id, display, alias: true });
      }
    }
  };
  for (const m of ctx.members ?? []) addMember(m.openId, m.name ?? "");
  if (owner) addMember(owner.openId, owner.name);
  addMember(ctx.requester?.openId ?? "", ctx.requester?.name ?? "");
  if (selfOpenId && !nameOf.has(selfOpenId)) nameOf.set(selfOpenId, "");
  for (const alias of GROUP_OWNER_ALIASES) {
    candidates.push({
      match: alias,
      openId: owner?.openId ?? "",
      display: owner?.name?.trim() || nameOf.get(owner?.openId ?? "") || alias,
    });
  }

  const mentions: GroupMention[] = [];
  const seen = new Set<string>();
  const addMention = (openId: string, name: string) => {
    if (seen.has(openId)) return;
    seen.add(openId);
    mentions.push({ openId, name });
  };
  const unresolved: string[] = [];
  // 去重用 Set：`includes` 是线性表查找，几万个互不相同的 `@xxx` 会变成二次型
  const unresolvedSeen = new Set<string>();
  const addUnresolved = (name: string) => {
    if (name && !unresolvedSeen.has(name)) {
      unresolvedSeen.add(name);
      unresolved.push(name);
    }
  };

  /** 在 pos（@ 之后）处找最长匹配；同长度下指向不同 openId = 歧义 */
  const matchAt = (
    text: string,
    pos: number,
  ): { cand: Candidate; ambiguous: boolean } | null => {
    let bestLen = 0;
    let hits: Candidate[] = [];
    for (const c of candidates) {
      const len = c.match.length;
      if (len < bestLen || len === 0) continue;
      if (!text.startsWith(c.match, pos)) continue;
      // 纯 ASCII 名字加词边界：成员 `Bob` 不该吃掉 `@Bobby`
      const last = c.match[len - 1];
      if (isAsciiWord(last) && isAsciiWord(text[pos + len])) continue;
      if (len > bestLen) {
        bestLen = len;
        hits = [c];
      } else {
        hits.push(c);
      }
    }
    if (!hits.length) return null;
    // 同长度下「原名」命中优先于别人的「清洗名」命中：新增的清洗名别名不能把原来能唯一命中的
    // `@外包李四`（真有人就叫这个）变成歧义——歧义判定只在同一档里做，和加别名之前一致
    const primary = hits.filter((h) => !h.alias);
    if (primary.length) hits = primary;
    const ids = new Set(hits.map((h) => h.openId));
    // 同 openId 的多条命中（成员 + 属主重复登记）取信息更全的一条
    const cand = hits.find((h) => h.openId && h.display) ?? hits[0];
    return { cand, ambiguous: ids.size > 1 };
  };

  // 输出分两类：`out` 是「原文透传」的纯文本累加器；本函数自己用 mentionTag 拼出的可信标签走 emitTag。
  // 每遇到可信标签就把此前累加的纯文本整段过一遍 neutralizeAtFragments——必须按「相邻纯文本的整段」
  // 过，而不是逐片：片与片之间（被吞掉的标签两侧、self 标签的 inner 与后文）可能粘出新标签。
  const parts: string[] = [];
  let out = "";
  // AT_TAG_RE 里的 `[\s\S]*?<\/at>` 是惰性匹配：文本里没有 `</at>` 可配时，每个 `<at user_id=…>` 开头
  // 都要扫一遍到文末（二次型）。先记下最后一个 `</at>` 的位置——位置在它之后的 `<` 不可能配成完整标签，
  // 不必尝试（照旧走碎片拆除）；位置在它之前的开头一旦头部合法就必然匹配成功、匹配即消耗，总量线性
  let lastAtClose = -1;
  for (const m of body.matchAll(/<\/at>/gi)) lastAtClose = m.index ?? lastAtClose;
  const flushRaw = () => {
    if (out) parts.push(neutralizeAtFragments(out));
    out = "";
  };
  const emitTag = (openId: string, name: string) => {
    flushRaw();
    parts.push(safeMentionTag(openId, name));
  };
  for (let i = 0; i < body.length; ) {
    const ch = body[i];

    // 手写 at 标签：id 可信才保留，否则退化成纯文本（防伪造 / 防幻觉 id）
    if (ch === "<") {
      AT_TAG_RE.lastIndex = i;
      const tag = i < lastAtClose ? AT_TAG_RE.exec(body) : null;
      if (tag) {
        const id = tag[1].trim();
        // inner 取到第一个 `</at>` 为止，里面可能还嵌着别的 at 标签的开标签：先剥碎片，
        // 否则下面不论哪个分支把它原样拼出，后面的 `</at>` 逐字符拷出来就凑成一个未经校验的完整标签
        const inner = neutralizeAtFragments(tag[2]).trim();
        const trusted = nameOf.get(id);
        if (id && id === selfOpenId) {
          out += inner || nameOf.get(id) || "";
        } else if (id && trusted !== undefined) {
          const display = trusted || inner;
          emitTag(id, display);
          addMention(id, display.trim() || "你");
        } else {
          if (inner) {
            out += `@${inner}`;
            addUnresolved(inner);
          }
        }
        i += tag[0].length;
        continue;
      }
    }

    if (isAt(ch)) {
      if (isEmailAt(body, i)) {
        out += ch;
        i += 1;
        continue;
      }
      const hit = matchAt(body, i + 1);
      if (hit && hit.ambiguous) {
        addUnresolved(hit.cand.match);
        out += ch;
        i += 1;
        continue;
      }
      if (hit) {
        const { cand } = hit;
        if (!cand.openId) {
          // 认得是 `@宿主` 但本任务没有属主 → 保持原样
          addUnresolved(cand.match);
          out += ch;
          i += 1;
          continue;
        }
        if (cand.openId === selfOpenId) {
          out += cand.display; // 不许 @ 自己：只留文本
        } else {
          emitTag(cand.openId, cand.display);
          addMention(cand.openId, cand.display.trim() || "你");
        }
        i += 1 + cand.match.length;
        continue;
      }
      // 认不出：原样保留；邮箱 / 手机号里的 @（前一个字符是 ASCII 字母数字）不算「@ 某人」
      const prev = i > 0 ? body[i - 1] : "";
      if (!/[A-Za-z0-9._-]/.test(prev)) {
        let j = i + 1;
        while (j < body.length && !TOKEN_STOP_RE.test(body[j])) j++;
        addUnresolved(body.slice(i + 1, j));
      }
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }
  flushRaw();
  let text = parts.join("").trim();
  // 「正文有没有真 @」要在补属主确认行之前定：确认行里的 @ 是系统补的、不是 agent 写在正文里的，
  // 不能顶掉第 5 步对真人提问人的自动 @（prompt 对 agent 承诺过「正文里一个 @ 都没写时，系统会自动 @ 他」；
  // 反过来，正文里已经有真 @ 就不再补——prompt 同样写明了，想让提问人也收到提醒要自己 @，见 buildGroupReplyRules）
  const bodyMentioned = mentions.length > 0;

  // 4) 需属主确认：补一行；owner 已被正文 @ 过就不重复 @
  if (needsOwner) {
    let line: string;
    if (owner) {
      const already = seen.has(owner.openId);
      if (already) {
        line = `需要你确认：${needsOwner}`;
      } else {
        const display = owner.name.trim() || nameOf.get(owner.openId) || "";
        if (owner.openId !== selfOpenId) {
          addMention(owner.openId, display || "你");
          line = `${safeMentionTag(owner.openId, display)} 需要你确认：${needsOwner}`;
        } else {
          line = `需要属主确认：${needsOwner}`;
        }
      }
    } else {
      line = `需要属主确认：${needsOwner}`;
    }
    text = text ? `${text}\n${line}` : line;
  }

  if (!text) return silent();

  // 5) 契约第 4 条：一个真 @ 都没有 → 真人提问人补 @；机器人不补（有意防环）
  if (!bodyMentioned && ctx.requester && !ctx.requester.isBot) {
    const rid = ctx.requester.openId?.trim() || "";
    const rname = ctx.requester.name ?? "";
    // 提问人本身就是属主、且已被确认行 @ 过：不再给他补第二个
    if (!(rid && seen.has(rid))) {
      text = `${safeMentionTag(rid, rname)} ${text}`;
      if (rid && rid !== selfOpenId) {
        // 补在开头：mentions 顺序跟 text 里的出现顺序一致（确认行的属主 @ 在后）
        seen.add(rid);
        mentions.unshift({ openId: rid, name: rname.trim() || "你" });
      }
    }
  }

  return {
    kind: "send",
    text: text.trim(),
    mentions,
    unresolvedAts: unresolved,
    ...(needsOwner ? { needsOwner } : {}),
  };
};

// ----------------- 给 agent 看的规矩 -----------------

/**
 * 答疑 agent 的「回复守则」（中文行，由调用方拼进 prompt）。
 * 写成给聪明同事的工作守则、不是法条；哨兵 / 标记写法一律引用 group-contract 常量。
 */
export const buildGroupReplyRules = (opts: {
  requesterIsBot: boolean;
}): string[] => {
  const [ownerAlias] = GROUP_OWNER_ALIASES;
  const noReply = GROUP_NO_REPLY_TOKEN;
  const needsOwnerMark = "[[需属主确认：一句话说明要属主定什么]]";

  const lines: string[] = [
    "## 你的回复会原文发到群里",
    "- 你的**最终回复就是发到群里的原文**：只有最后一段（所有工具调用之后的那段文字）会被发出。中途别写「我先查一下……」之类旁白，查完再一次性给出自包含的最终答复。",
    "- 对方没看过你的过程，也看不到 Flowship，更不认识内部事件序号、act_ 编号、SDK 报错、事件流、日志路径——这些一律不要出现在回复里，也不要建议对方「去 Flowship 看」。",
    "",
    "## 要不要回",
    `- 对方只是确认 / 复述 / 汇报「收到」、系统提示（比如「这轮没跑成功」）、转述别人的话，并且没有问你任何问题 → 整段回复只写 \`${noReply}\`（原样，不加任何别的字）。`,
    "- 别为了礼貌回「收到」「好的」。" +
      (opts.requesterIsBot
        ? "这次提问方是机器人，尤其要克制——两个机器人互相客气会无限循环下去，对方没提实质问题就沉默。"
        : "尤其对机器人：两个机器人互相客气会无限循环，对方没提实质问题就沉默。"),
    "",
    "## @ 谁",
    opts.requesterIsBot
      ? "- 提问方是机器人。它问了实质问题时，**必须在正文里写 `@它的名字`**（名字与「群里的人」清单完全一致），否则它看不见你的回答；它没问实质问题就回 `" +
        noReply +
        "`。"
      : // 与 parseInner 第 5 步一致：「正文里已有真 @」= 认得出的名字 / @宿主 / id 可信的手写标签（mentions 非空，
        // 补属主确认行之前判，确认行里的 @ 不算）；有了就不再补提问人。改这句话时同步看 tests/group-reply-protocol-r6.test.ts
        "- 提问方是真人：正文里一个 @ 都没写时，系统会自动 @ 他。**只要正文里已经 @ 了别人**（名字与「群里的人」清单对得上，`@宿主` 也算），系统就不会再自动 @ 他——想让提问人也收到提醒，就自己在正文里写 `@他的名字`。",
    "- 想让别的人 / 机器人看见哪句话，就在那句话里写 `@名字`（同样要与「群里的人」清单完全一致）。",
    "- 直接写 `@名字` 就行，**不要手写 `<at ...>` 标签**：手写的标签只有 id 在群成员里才认，其余会被还原成纯文字；名字对不上清单的 `@xxx` 也只是普通文字、不算 @ 上了人。",
    `- \`@${ownerAlias}\` = 任务属主本人。`,
    "- 一条消息里只 @ 真正需要行动或需要看见的人，别顺手 @ 一圈。",
    "",
    "## 不替属主拍板",
    "- 接口契约取舍、口径、范围、上线 / 发布 / 部署这类需要属主决定的事，不要替他答应。先给对方一个明确的说法（比如「这个要宿主确认，已转告」），再另起一行**原样**写下面这行（不要包在反引号 / 代码块里——包在代码里的会被当成示例、不生效）：",
    // 示例行本身不能包反引号：解析器把行内代码 / 围栏里的标记当示例不触发，模型照抄带反引号的示例行就会失效
    `  ${needsOwnerMark}`,
    "  系统会把这行从群消息里去掉、@ 属主，并在属主的 Flowship 里提醒他。",
    "- 自己能凭产出文档 / 代码事实答的，照常答，别什么都推给属主。",
    "",
    "## 说话要有依据",
    "- 只陈述有依据的事实；查不到就说查不到 / 不确定，不要编。",
    "- 你是只读答疑身份，**没改过任何文件**——说「已改好」「已提交」之类之前先想清楚，别把没做过的事说成做了。",
    "",
    "## 风格",
    "- 直接讲结论，短句；必要时用 markdown 列表。不要复述对方的问题。",
    "- 不要自称「答疑 agent / 助手」，用第一人称，代表宿主团队的前端同学说话即可。",
  ];
  return lines;
};
