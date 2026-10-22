/**
 * skill slash token 纯解析（无 React）
 *
 * 菜单触发 / 气泡高亮 / Composer transform 共用字符集与最长前缀命中，
 * 避免 `[a-zA-Z0-9._-]` 与中文支持在多处漂移。
 */

import {
  isInsideAtWord,
  SLASH_PREFIX_CLASS,
  stepAtScan,
  type AtScanState,
  type TriggerMatch,
} from "./composer-trigger";

/**
 * skill 名允许的字符类（slash / token / 目录名同构）。
 * 含中文 `\u4e00-\u9fa5`；不要在别处再写一份 ASCII-only 字符集。
 */
export const SKILL_NAME_CHAR_CLASS = "a-zA-Z0-9\\u4e00-\\u9fa5._-";

/**
 * 光标前「正在打 slash」：`/` 前是行首 / 空白 / CJK·全角标点，后跟 /xxx（xxx 可空 = 刚打出 /）。
 * 前缀字符类单一来源 {@link SLASH_PREFIX_CLASS}（lib/composer-trigger.ts）：
 * URL / 路径里的 `/`（前一字符是 ASCII 字母数字、`.`、`:`、`/`、`~`）不触发。
 */
export const SLASH_RE = new RegExp(
  `(^|[${SLASH_PREFIX_CLASS}])/([${SKILL_NAME_CHAR_CLASS}]*)$`,
);

/**
 * 光标前「正在打 slash」→ `/` 下标 + 过滤词；不在打 slash 返回 null。
 *
 * `@` 词内的 `/` 是路径分隔符、不是 slash（第三轮 review R6-02）：`@src/组件/` 的「件」是 CJK，
 * 单看 SLASH_RE 是合法前缀，会同时弹出 slash 菜单、抢走 Enter / Tab 并把路径里的 `/` 换成 `/skill-name `。
 * 解析侧（parseSkillTokens）用同一个 {@link isInsideAtWord} 判定，触发与解析不再各管各的。
 */
export const matchSlashTrigger = (before: string): TriggerMatch | null => {
  const m = SLASH_RE.exec(before);
  if (!m) return null;
  if (isInsideAtWord(before)) return null;
  const query = m[2] ?? "";
  return { start: before.length - query.length - 1, query };
};

/**
 * 菜单用的触发判定：在 {@link matchSlashTrigger} 之上再收一道（第三轮 review R6-06）——
 * `/` 紧贴 CJK / 全角标点（而不是行首 / 空白）且 query 还是空的，不弹菜单：
 * 「前端/UI」「增/删/改」「是/否」这类中文行文刚打出 `/` 就展开前 8 个 skill，收尾 Enter 还会被菜单吞掉。
 * 触发判定本身（matchSlashTrigger）不变，所以「先试试/wr」「好的，/写」带了 query 照常弹；
 * 行首 / 空白后的 `/` 是发现 skill 的主入口，空 query 照旧展开。
 */
export const matchSlashMenuTrigger = (before: string): TriggerMatch | null => {
  const m = matchSlashTrigger(before);
  if (!m) return null;
  if (m.query === "" && m.start > 0 && !/\s/.test(before.charAt(m.start - 1))) {
    return null;
  }
  return m;
};

/**
 * 粗切候选：`/`（前面同 SLASH_RE：行首 / 空白 / CJK·全角标点）+ 一串合法名字符
 * （贪婪、不要求尾随空白）。触发与解析必须同口径——触发认、解析不认，
 * 选中后写回草稿 / 历史翻出就变回纯文本、skillRefs 丢失。
 * 真正认不认 token 交给 parseSkillTokens 的最长前缀命中——中文后常不打空格。
 */
export const SKILL_TOKEN_RE = new RegExp(
  `(^|[${SLASH_PREFIX_CLASS}])/([${SKILL_NAME_CHAR_CLASS}]+)`,
  "g",
);

/** 一次匹配：`/name` 在全文中的区间 */
export interface SkillTokenMatch {
  /** `/name` 起始下标（不含前导空白） */
  start: number;
  /** `/name` 结束下标（不含） */
  end: number;
  name: string;
}

/**
 * 候选串（正则贪婪切出）→ knownNames 最长前缀命中。
 * 例：已知「写代码」、候选「写代码帮我改下」→「写代码」；无前缀 → null。
 * 打到一半的「写」对不上「写代码」（方向是 candidate.startsWith(name)）→ null。
 */
export const matchLongestSkillName = (
  candidate: string,
  knownNames: Set<string> | ReadonlySet<string>,
): string | null => {
  let best: string | null = null;
  for (const name of knownNames) {
    if (candidate === name || candidate.startsWith(name)) {
      if (!best || name.length > best.length) best = name;
    }
  }
  return best;
};

/**
 * 从草稿解析命中已知 skill 的内联 token。
 * 流程：SKILL_TOKEN_RE 粗切 → matchLongestSkillName 收窄 → 只消费 `/`+命中名；
 * 余下正文留给后续（lastIndex 拨到 token 末尾）。
 */
export const parseSkillTokens = (
  text: string,
  knownNames: Set<string> | ReadonlySet<string>,
): SkillTokenMatch[] => {
  const out: SkillTokenMatch[] = [];
  // 没有已知 skill / 文本里没有 `/`：不可能有 token，别白跑正则（手打热路径每键整节点重算，N2-03）
  if (knownNames.size === 0 || !text.includes("/")) return out;
  // 「`/` 落在 @ 词内」线性判定（第四轮 Q6-17 / N2-03）：候选 start 严格递增（见下方 lastIndex 回拨），
  // 所以单次扫描维护「当前词里是否已有触发 @」即可，不必对每个候选重切 `text.slice(0, start)` 再回溯到词首
  // （中文长段没有半角空白，每次都回溯到行首 = O(n²)：75000 字 1.7s）。
  // 与 isInsideAtWord(text.slice(0, start)) 逐项等价——由 tests/skill-token-linear.test.ts 的「旧实现原样复制 + 随机语料」对拍锁住。
  let scanned = 0;
  // 与触发侧共用同一个步进状态机（composer-trigger.stepAtScan，第六轮 P3-2：含配对闭合符收口）
  let atState: AtScanState = null;
  const insideAtWord = (start: number): boolean => {
    if (start < scanned) {
      scanned = 0;
      atState = null;
    }
    for (; scanned < start; scanned += 1) {
      atState = stepAtScan(
        atState,
        text.charAt(scanned),
        scanned > 0 ? text.charAt(scanned - 1) : "",
        scanned,
      );
    }
    return atState !== null;
  };
  SKILL_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SKILL_TOKEN_RE.exec(text)) !== null) {
    const candidate = m[2];
    const leading = m[1] ?? "";
    const start = m.index + leading.length;
    // 未命中（候选不是已知 skill，或 `/` 落在 `@路径` 词内）也要回拨：正则已经把候选吞到末字，
    // 而前缀字符类含 CJK——候选以中文收尾（`他/她/plan` 里的「她」）时，紧贴着的下一个 `/plan`
    // 需要这个末字当前缀。不回拨就会漏掉，触发侧却认（菜单选了个寂寞，第三轮 review R6-03）。
    // 回拨到候选末字（m.index + m[0].length - 1，恒 > m.index、不会死循环）：末字不是前缀字符时
    // 下一次匹配自然往后走，不会重复命中本候选。
    const name = insideAtWord(start)
      ? null
      : matchLongestSkillName(candidate, knownNames);
    if (!name) {
      SKILL_TOKEN_RE.lastIndex = m.index + m[0].length - 1;
      continue;
    }
    const end = start + 1 + name.length; // `/` + name
    out.push({ start, end, name });
    // 候选比命中名长（中文紧贴正文）时拨回 token 末，避免跳过后面的 `/xxx`。
    // 多拨回 1 位（end - 1，恒 > m.index）：前缀字符类含 CJK、会消费 `/` 前那一个字，
    // 命中名恰以中文收尾且紧贴下一个 `/x`（`/写/读`）时，这一位要留给下一次匹配当前缀；
    // 末字不是 CJK 时它匹配不上前缀、正则自然往后走，不会重复命中本 token。
    SKILL_TOKEN_RE.lastIndex = end - 1;
  }
  return out;
};
