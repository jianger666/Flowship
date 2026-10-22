/**
 * 输入框 `/`、`@` 触发口径（纯函数、无 React；第二轮 review V5-06）
 *
 * 菜单触发（光标前「正在打 `/xxx` / `@xxx`」）与草稿解析（还原 skill token / 文件 pill）
 * 必须同一口径——否则选中后写回草稿、历史翻出、切任务恢复时，token 会变回纯文本，
 * 发送时 skillRefs 也跟着丢（触发认、解析不认 = 菜单选了个寂寞）。
 *
 * - `@`：任意位置触发。前一字符是 ASCII 字母数字 / `._%+-` → 邮箱前缀（user@host），不触发；
 *   前一字符是 `/` `\` → 路径中段（`x.com/@user`、`src/@types`），也不触发。
 * - `/`：只在行首、空白后、或 CJK / 全角标点后触发（`帮我看下/review`、`好的，/review`）。
 *   URL / 路径 / 分数里的 `/`（前一字符是 ASCII 字母数字、`.`、`:`、`/`、`~` 等）不触发。
 *
 * - `@` 词内的 `/` 是路径分隔符、不是 slash（`@src/组件/`；第三轮 review R6-02）：
 *   触发侧 matchSlashTrigger 与解析侧 parseSkillTokens 共用 {@link isInsideAtWord}。
 *
 * 已知取舍（写在这里、别当 bug）：
 * - 中文里的「是/否」「和/或」会触发 slash 候选（query=否）；菜单对「带 query 的候选」才弹
 *   （没有同名 / 包含该 query 的 skill 时 filtered 为空、菜单不开）；紧贴中文的空 query
 *   （刚打出 `前端/`）不弹——见 skill-token.matchSlashMenuTrigger（R6-06）。
 * - 只认 BMP 内的 CJK（扩展 B 以后的生僻字是代理对、不命中）。
 *
 * 三步一致由 tests/composer-trigger-roundtrip.test.ts 的随机语料性质锁住：
 * 触发判定 → 选中写回 → 再解析 必须还原同一个 token；解析出的 token 触发侧也认。
 */

/**
 * CJK 字符与全角标点（正则字符类内部写法，不带方括号）：
 * 破折号 / 弯引号 / 省略号、CJK 部首、CJK 符号标点（。、「」…）、日文假名、CJK 扩展 A、
 * 统一表意文字、兼容表意文字、谚文音节、全角形式（，：（）Ａ…）。
 */
export const CJK_CHAR_CLASS =
  "\\u2014\\u2018\\u2019\\u201c\\u201d\\u2026\\u2e80-\\u2fdf\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef";

/**
 * `/` 触发的合法前一字符类（字符类内部写法）：空白 + CJK / 全角标点。
 * 行首（无前一字符）由调用方用 `^` 单独表达。
 */
export const SLASH_PREFIX_CLASS = `\\s${CJK_CHAR_CLASS}`;

const CJK_CHAR_RE = new RegExp(`^[${CJK_CHAR_CLASS}]$`);
const WHITESPACE_RE = /^\s$/;
/** 邮箱本地部分常见字符：ASCII 字母数字 + `._%+-` */
const EMAIL_LOCAL_CHAR_RE = /^[A-Za-z0-9._%+-]$/;

/** `/` 能否触发：prev = `/` 前一字符（行首传空串） */
export const isSlashBoundaryChar = (prev: string): boolean =>
  prev === "" || WHITESPACE_RE.test(prev) || CJK_CHAR_RE.test(prev);

/** `@` 能否触发：prev = `@` 前一字符（行首传空串） */
export const isAtBoundaryChar = (prev: string): boolean => {
  if (prev === "") return true;
  if (EMAIL_LOCAL_CHAR_RE.test(prev)) return false;
  // 路径中段：x.com/@user、src/@types/node
  if (prev === "/" || prev === "\\") return false;
  return true;
};

export interface TriggerMatch {
  /** 触发字符（`@`）在 before 里的下标 */
  start: number;
  /** 触发字符之后到光标的过滤词（可空） */
  query: string;
}

/**
 * 结束一个 `@` 词的中文 / 全角「句读」**硬边界**（字符类内部写法）：`，。；！？、：`（第四轮 Q6-05 / N2-04，第五轮收窄）。
 * `@张三，请/review`、`看下@src/a.ts，然后…` 里「，」之后是新的一段话——不再整句算 @ 词内
 * （否则 slash 不弹、pill 吞掉整句）。
 * 只收这七个句读、不收汉字：`@src/组件/a.ts` 的中文目录名仍是路径的一部分。
 *
 * 第五轮收窄：括号 / 书名号 / 引号 / 破折号 / 省略号**不再**当硬边界——文件名里真有 `—`、`…`、`（）`、`《》` 时，
 * 硬边界会把 pill 截在半截（只是视觉，发送出去仍是纯文本 `@path`）。它们改为只在 token **尾部**剥离
 * （见 {@link AT_TAIL_STRIP_CHAR_CLASS}）：`（@src/a.ts）说` 的 pill 仍是 `src/a.ts`。
 * 第六轮：被包起来的 `@`（`（@src/a.ts）请/review`）在配对闭合符 `）` 处结束（{@link AT_WRAP_PAIRS}），之后的 `/review` 正常弹 slash——
 * 第五轮「`/` 算 @ 词内、slash 不弹」的取舍已撤销，触发侧与 pill 侧共用 {@link stepAtScan} 这一个判定。
 * 仍接受的取舍：没有开括号包着的 `@src/a.ts…/review`（省略号后紧贴 slash）整段算 @ 词。
 * 「被包起来」只认紧贴 `@` 前面的**全角 / CJK 开符**（`（【《「『“‘`）：ASCII 括号 `(@src/a.ts)/review` 不收口（`)` 不是硬边界，
 * `/review` 算在 @ 词内）；括号内的第二个 `@`（`（@a/b @c/d）/review` 里的 `@c/d`）前面是空格而不是开符，也不带闭合符（第八轮 P5-6，均为既有行为）。
 */
export const CJK_PUNCT_CHAR_CLASS =
  "\\u3001\\u3002\\uff0c\\uff1b\\uff01\\uff1f\\uff1a";
/**
 * 只在 `@path` token **尾部**剥掉的包裹 / 修饰标点（字符类内部写法）：全角括号、【】、《》、「」『』、弯引号、省略号、破折号。
 * 中间出现算文件名的一部分（见 {@link CJK_PUNCT_CHAR_CLASS} 的第五轮说明）。
 */
export const AT_TAIL_STRIP_CHAR_CLASS =
  "\\uff08\\uff09\\u3010\\u3011\\u300a\\u300b\\u300c-\\u300f\\u201c\\u201d\\u2018\\u2019\\u2026\\u2014";
const AT_TAIL_STRIP_RE = new RegExp(`^[${AT_TAIL_STRIP_CHAR_CLASS}]$`);
/**
 * 紧贴 `@` 前面的开括号 / 开引号 → 对应的闭合符：`（@src/a.ts）说`、`“@docs/x.md”`、`《@docs/设计.md》` 是「被包起来的 @」，
 * pill 在**第一个**配对闭合符处收口（否则闭合符后面紧跟汉字时它不在尾部、剥不掉，pill 会连 `）说` 一起吞）。
 * 前面没有开符的 `@src/《a》.ts`：书名号是文件名的一部分，原样保留（只剥真正落在 token 尾部的）。
 */
const AT_WRAP_PAIRS: Readonly<Record<string, string>> = {
  "（": "）",
  "【": "】",
  "《": "》",
  "「": "」",
  "『": "』",
  "“": "”",
  "‘": "’",
};
const CJK_PUNCT_RE = new RegExp(`^[${CJK_PUNCT_CHAR_CLASS}]$`);

/** `@` 词的边界字符：空白、`:`、中文句读硬边界 `，。；！？、：`（回溯词首 / 切 path 结尾共用，触发与解析同口径） */
export const isAtWordBreak = (ch: string): boolean =>
  ch === ":" || WHITESPACE_RE.test(ch) || CJK_PUNCT_RE.test(ch);
const isWordBreak = isAtWordBreak;

/** 当前正在进行的 `@` 词（起点下标 + 期待的配对闭合符）；null = 不在 @ 词内 */
export type AtScanState = { start: number; closer: string | null } | null;

/**
 * 「`@` 词在哪结束」的**唯一**判定（第六轮 P3-2）：触发（matchAtTrigger）、slash 互斥（isInsideAtWord）、
 * 解析侧线性扫描（skill-token.parseSkillTokens）、pill 切分（findAtFileTokens）全部步进同一个状态机，
 * 防「pill 收口了、触发没跟上」（`（@src/a.ts）请` 菜单重开、`（@src/a.ts）/review` slash 丢失）。
 *
 * 状态 = 当前正在进行的 `@` 词（起点下标 + 若 `@` 前紧贴开括号 / 开引号则为期待的配对闭合符），或 null（不在 @ 词内）。
 * - 在 @ 词内：遇空白 / `:` / 句读硬边界 `，。；！？、：`，或配对闭合符 → 词结束（闭合符本身不属于词）；其余字符都算词内。
 * - 不在 @ 词内：遇满足边界的 `@`（见 {@link isAtBoundaryChar}）→ 开始新词；别的字符不变。
 * 一个词里后面再出现的 `@` 不换起点（`@node_modules/@types/` 整串当过滤词）。
 *
 * @param state 步进前的状态
 * @param ch 当前字符
 * @param prev 当前字符的前一个字符（行首传 ""）
 * @param index 当前字符在整段文本里的下标（只在开始新词时用来记起点）
 */
export const stepAtScan = (state: AtScanState, ch: string, prev: string, index: number): AtScanState => {
  if (state) {
    if (isAtWordBreak(ch) || (state.closer !== null && ch === state.closer)) return null;
    return state;
  }
  if (ch === "@" && isAtBoundaryChar(prev)) {
    return { start: index, closer: AT_WRAP_PAIRS[prev] ?? null };
  }
  return null;
};

/**
 * 光标前「正在打 `@xxx`」：`before` = 草稿开头到光标的纯文本。
 *
 * 只看光标所在的「词」：向前回溯到最近的空白 / `:` / 句读硬边界（这些字符在任何状态下都会重置 @ 状态，
 * 所以从它之后以「不在 @ 词内」起步与从头扫等价；`@src/a.ts:10` 的行号区间收尾不再弹菜单），
 * 再用 {@link stepAtScan} 正扫到光标：光标处仍在 @ 词内才触发，query = `@` 之后到光标。
 * 配对闭合符之后（`（@src/a.ts）请`）已不在词内 → 不触发。query 可含 `@`（`@node_modules/@types/`）。
 */
export const matchAtTrigger = (before: string): TriggerMatch | null => {
  let wordStart = before.length;
  while (wordStart > 0 && !isWordBreak(before.charAt(wordStart - 1))) {
    wordStart -= 1;
  }
  let state: AtScanState = null;
  for (let i = wordStart; i < before.length; i += 1) {
    state = stepAtScan(state, before.charAt(i), i > 0 ? before.charAt(i - 1) : "", i);
  }
  return state ? { start: state.start, query: before.slice(state.start + 1) } : null;
};

/**
 * 光标前（`before`）这个「词」里是不是已经有一个 `@` 触发——有就说明这里在打 `@路径`，
 * 词内的 `/` 是路径分隔符、不是 slash 触发（第三轮 review R6-02：`@src/组件/` 里「件」是 CJK，
 * 曾被当成 slash 的合法前缀，弹出 skill 菜单、Enter / Tab 把路径里的 `/` 换成 `/skill-name `）。
 *
 * 与 {@link matchAtTrigger} 完全同一个判定（邮箱前缀 / 路径中段的 `@` 不算），
 * 触发侧（matchSlashTrigger）与解析侧（parseSkillTokens）共用，防两边口径再漂。
 */
export const isInsideAtWord = (before: string): boolean =>
  matchAtTrigger(before) !== null;

export interface AtFileTokenMatch {
  /** `@` 的下标 */
  start: number;
  /** 结束下标（不含）；停在空白或 `:行号` 前 */
  end: number;
  path: string;
}

/**
 * 从一行纯文本切出 `@rel/path`（草稿写回 / 历史翻出时靠形态还原 pill，不要求「已知文件清单」）。
 * 与 {@link matchAtTrigger} 同一边界口径；词内第一个 `@` 不满足边界时继续试后面的，不整串放弃。
 */
export const findAtFileTokens = (line: string): AtFileTokenMatch[] => {
  const out: AtFileTokenMatch[] = [];
  let state: AtScanState = null;
  // 词在 i 处结束（或到行尾）时收一个 token；与 matchAtTrigger / parseSkillTokens 步进同一个状态机（stepAtScan）
  const flush = (open: { start: number }, end: number): void => {
    let keep = end;
    // 尾部剥掉包裹 / 修饰标点（`@a.ts）`、`@docs/x.md…`）：线性从尾往前数一遍
    while (keep > open.start + 1 && AT_TAIL_STRIP_RE.test(line.charAt(keep - 1))) keep -= 1;
    const filePath = line.slice(open.start + 1, keep);
    // 排除裸 `@word`（无 `/` 也无 `.`）——降低误伤普通 @ 提及
    if (!filePath.includes("/") && !filePath.includes(".")) return;
    out.push({ start: open.start, end: keep, path: filePath });
  };
  for (let i = 0; i < line.length; i += 1) {
    const next = stepAtScan(state, line.charAt(i), i > 0 ? line.charAt(i - 1) : "", i);
    if (state && next === null) flush(state, i);
    state = next;
  }
  if (state) flush(state, line.length);
  return out;
};
