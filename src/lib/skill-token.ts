/**
 * skill slash token 纯解析（无 React）
 *
 * 菜单触发 / 气泡高亮 / Composer transform 共用字符集与最长前缀命中，
 * 避免 `[a-zA-Z0-9._-]` 与中文支持在多处漂移。
 */

/**
 * skill 名允许的字符类（slash / token / 目录名同构）。
 * 含中文 `\u4e00-\u9fa5`；不要在别处再写一份 ASCII-only 字符集。
 */
export const SKILL_NAME_CHAR_CLASS = "a-zA-Z0-9\\u4e00-\\u9fa5._-";

/** 光标前「正在打 slash」：行首或空白后的 /xxx（xxx 可空 = 刚打出 /） */
export const SLASH_RE = new RegExp(
  `(^|\\s)/([${SKILL_NAME_CHAR_CLASS}]*)$`,
);

/**
 * 粗切候选：行首/空白后的 `/` + 一串合法名字符（贪婪、不要求尾随空白）。
 * 真正认不认 token 交给 parseSkillTokens 的最长前缀命中——中文后常不打空格。
 */
export const SKILL_TOKEN_RE = new RegExp(
  `(^|\\s)/([${SKILL_NAME_CHAR_CLASS}]+)`,
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
  SKILL_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SKILL_TOKEN_RE.exec(text)) !== null) {
    const candidate = m[2];
    const name = matchLongestSkillName(candidate, knownNames);
    if (!name) continue;
    const leading = m[1] ?? "";
    const start = m.index + leading.length;
    const end = start + 1 + name.length; // `/` + name
    out.push({ start, end, name });
    // 候选比命中名长（中文紧贴正文）时拨回 token 末，避免跳过后面的 `/xxx`
    SKILL_TOKEN_RE.lastIndex = end;
  }
  return out;
};
