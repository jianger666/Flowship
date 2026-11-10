/**
 * 网络负载（WebSocket / SSE 帧、HAR 里的请求 / 响应体）的文本脱敏——server 侧 `src/lib/server/browser/redact-text.ts`
 * （`redactSensitiveText`）的**主进程移植**。
 *
 * 为什么要有第二份：HAR 与 WS / SSE 帧是在主进程里落盘 / 暂存的，不能等到 server 出站时才脱敏（文件已经写出去了；帧要「先脱敏后截断」，
 * 否则 4KB 的截断点会把一个 JWT 劈成两半、残留的前半段匹配不上）。electron-app 是独立打包的目录，没法 import src/，所以规则各写一份，
 * 由 `tests/browser-redact-parity.test.ts` 用同一张向量表（`tests/helpers/browser-redact-vectors.ts`）喂两端、断言输出逐字相等、规则名清单一致，并（R6-39 ⑤）逐项比较两端导出的 `REDACT_PATTERNS`（全部正则 `source` / `flags`、词表、品牌表、上限常量）——**改任何一边的正则都要同步另一边，只改一端会变红**。
 *
 * 取舍与复杂度论证见 redact-text.ts 的头注释（键名起点 lookbehind 限定、JWT 第一段有上限、COOKIE 前瞻有上限、USERINFO 起点限定），这里只保留要点：
 * 宁可多藏；先脱敏、后截断；没有二次方回溯。纯函数、无依赖。
 */

export const REDACTED_TEXT = "[已隐藏]";

/** 规则名清单（按管线顺序）：parity 测试断言 mjs / ts 两端一致——加规则必须两边同时加、同时改这张表 */
export const REDACT_RULE_NAMES = Object.freeze([
  "pem-private-key",
  "jwt",
  "userinfo",
  "auth-header-quoted",
  "auth-header",
  "auth-scheme",
  "bare-secret",
  "card-number",
  "cookie-header",
  "query-code",
  "key-value",
]);

// PEM 私钥块（RSA / EC / OPENSSH / ENCRYPTED / PGP BLOCK）：从 BEGIN 到 END；没有 END（被截断 / 只贴了一半）就吃到文本结尾——宁可多藏。
// 头里的类型词有界（≤40），懒匹配 + 终止符 `$`（无 m 标志 = 串尾）：每个起点最多扫一次到尾，且匹配后从尾部继续，总量线性。公钥 / 证书不是凭据，不动。
const PEM_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g;

// 银行卡号：13–19 位数字，数字游程之间允许单个空格 / 连字符；必须过 Luhn，**并且**满足下面三条之一才脱敏：
//  ① 品牌 IIN 前缀 + 该品牌的合法长度（{@link CARD_BRANDS}：Visa / Mastercard / Amex / 银联 62·81 / Discover / JCB / Diners / Maestro / Mir / 工行农行 9558·9559）；
//  ② 紧挨着 `card / pan / credit / 卡号 / 银行卡 …` 这类关键词（{@link CARD_CONTEXT_RE}，前 40 字符内）：此时放宽回「任意 13–19 位 Luhn 通过」（冷门银行前缀也不漏）；
//  ③ 数字游程之间有分隔符时，分组必须像卡面（{@link cardGroupingOk}：4-4-4-4 / 4-4-4-4-3 / Amex 4-6-5 / Diners 4-6-4），`+86 138 1234 5678` 这类电话分组不当卡号。
// R6-41 ③：旧规则只有 Luhn，对 `+86 138 xxxx xxxx`、ISBN-13、16 位订单号、18 位身份证、17 位 JSON id、19 位雪花 id 各约 10% 误杀（2 万样本实测，见 tests/browser-r6-s5-redact.test.ts）；
// 加 IIN + 长度 + 分组后降到 0–3.1%（剩下的是真的「长得像卡号」：以 4 / 5 / 62 等开头的 16 位订单号碰巧 Luhn 通过，无法再靠格式区分），真卡号（Visa / MC / Amex / 银联 16–19 位，含空格 / 连字符分组）召回仍是 100%。
// 起点排除「紧跟在数字 / 小数点 / `数字-` 之后」：全数字 UUID 的中间段、`3.14159265358979323` 的小数部分、连字符分隔的长编号都不当卡号；
// 终点排除「后面紧跟数字 / `-数字`」。空格不排除——`4111 1111 1111 1111 12/25`（卡号后跟有效期）必须仍能命中。
// 13 位 Visa（已停发）与无分隔的 13 / 14 位数字（毫秒时间戳 / 14 位日期时间）不在品牌表里：只有在 ② 的关键词语境下才可能命中。
const CARD_RE = /(?<![\d.]|\d-)(?:\d[ -]?){12,18}\d(?!\d|-\d)/g;

/** 卡品牌：IIN 前缀（对「纯数字串」从头匹配）+ 允许的号码长度。改这张表 = 改召回 / 误杀的平衡，两端必须同步（REDACT_PATTERNS 导出、parity 测试逐项比较） */
const CARD_BRANDS = [
  { name: "visa", prefix: /^4/, lens: [16, 19] },
  { name: "mastercard", prefix: /^(?:5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/, lens: [16] },
  { name: "amex", prefix: /^3[47]/, lens: [15] },
  { name: "discover", prefix: /^(?:6011|64[4-9]|65)/, lens: [16, 17, 18, 19] },
  { name: "unionpay", prefix: /^(?:62|81)/, lens: [16, 17, 18, 19] },
  { name: "jcb", prefix: /^35(?:2[89]|[3-8]\d)/, lens: [16, 17, 18, 19] },
  { name: "diners", prefix: /^(?:30[0-5]|3095|3[689])/, lens: [14, 16, 17, 18, 19] },
  { name: "maestro", prefix: /^(?:5018|5020|5038|5893|6304|6759|676[1-3])/, lens: [16, 17, 18, 19] },
  { name: "mir", prefix: /^220[0-4]/, lens: [16] },
  { name: "cn-bank", prefix: /^955[89]/, lens: [19] },
];

/** 卡面分组（数字游程长度，用 `-` 连起来）：除「全 4 位 + 末组 1–4 位」之外只认这两种 */
const CARD_GROUPINGS = ["4-6-5", "4-6-4"];

/** 卡号前 40 字符里出现这些词（且词与号码之间只隔 ≤ 24 个非数字字符）→ 视为卡号语境，放宽品牌前缀要求 */
const CARD_CONTEXT_RE = /(?:card|\bpan\b|credit|debit|\bcc[ _-]?(?:num|no)|cvv|cvc|卡号|卡號|银行卡|信用卡|储蓄卡|借记卡)[^\d]{0,24}$/i;

const cardBrandOk = (digits) => CARD_BRANDS.some((b) => b.prefix.test(digits) && b.lens.includes(digits.length));

/** 游程长度是否像卡面分组：单个游程（无分隔）恒真 */
const cardGroupingOk = (runLens) => {
  if (runLens.length === 1) return true;
  const last = runLens.length - 1;
  if (runLens.slice(0, last).every((n) => n === 4) && runLens[last] >= 1 && runLens[last] <= 4) return true;
  return CARD_GROUPINGS.includes(runLens.join("-"));
};

const luhnOk = (digits) => {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};

/**
 * 在一个候选里找「由整段数字游程组成」且 Luhn 通过的最长卡号区间（卡号后面常跟 `12/25` 这类有效期，整段候选 Luhn 过不了，要能截出前缀 / 后缀）。
 * 返回 [起, 止) 下标或 null。候选最长 ~37 字符，枚举量是常数。
 * `loose`（卡号语境，见 CARD_CONTEXT_RE）：不要求品牌前缀，回到「13–19 位 Luhn 通过（无分隔的至少 15 位）」。
 * @param {string} m
 * @param {boolean} [loose]
 * @returns {[number, number] | null}
 */
const findCardSpan = (m, loose = false) => {
  const runs = [];
  for (const r of m.matchAll(/\d+/g)) runs.push({ s: r.index, e: r.index + r[0].length, n: r[0].length });
  let best = null;
  for (let a = 0; a < runs.length; a++) {
    let total = 0;
    for (let b = a; b < runs.length; b++) {
      total += runs[b].n;
      if (total > 19) break;
      if (total < 13) continue;
      const digits = m.slice(runs[a].s, runs[b].e).replace(/\D/g, "");
      if (!luhnOk(digits)) continue;
      if (!cardGroupingOk(runs.slice(a, b + 1).map((x) => x.n))) continue;
      if (!cardBrandOk(digits) && !(loose && (a !== b || total >= 15))) continue;
      if (!best || total > best.total) best = { total, span: [runs[a].s, runs[b].e] };
    }
  }
  return best ? best.span : null;
};

const JWT_HEADER_MAX = 2048;
// R6-41 ②：起点不再要求 `\b`——`xeyJ…` / `1eyJ…` / 紧贴在卡号或字段名后面的 JWT 也要脱敏（旧版 `\beyJ` 在字母 / 数字 / 下划线之后不成立，一遍漏掉、
// 被前面的规则替换出占位符后第二遍才成立）。每个 `eyJ` 都是起点的代价：每个起点至多扫 {@link JWT_HEADER_MAX} 个字符且不回溯，仍线性（`eyJ`×N 的对抗输入有耗时用例）。
// R6-41 验收补：「每个 eyJ 都是起点 × 每个起点扫 2048」对 `eyJ`×10 万（30 万字符）的对抗输入实测 ≈ 1.6s（> 1s）。所以拆成两档：
// 词首（`(?<![A-Za-z0-9_])` = 旧 `\b`，每段游程至多一个）沿用 2048 上限；紧贴字母 / 数字 / 下划线前缀的起点只认 ≤ {@link JWT_GLUED_HEADER_MAX} 的 header（真实 header 通常 < 200 字符），
// 对抗输入每个起点的扫描量降 8 倍（≈ 0.2s）。代价：紧贴前缀 + 超长（> 256）header 的 JWT 仍会漏（改前紧贴前缀的一律漏，没有退步）。
const JWT_GLUED_HEADER_MAX = 256;
const JWT_RE = new RegExp(
  String.raw`(?:(?<![A-Za-z0-9_])eyJ(?=([A-Za-z0-9_-]{5,${JWT_HEADER_MAX}}))\1|eyJ(?=([A-Za-z0-9_-]{5,${JWT_GLUED_HEADER_MAX}}))\2)\.(?=([A-Za-z0-9_-]{5,}))\3\.[A-Za-z0-9_-]*`,
  "g",
);

const AUTH_TOKEN_SCHEMES = "bearer|basic|token|apikey|api-key";
const AUTH_LINE_SCHEMES = "digest|negotiate|ntlm";
const AUTH_SCHEMES = `${AUTH_TOKEN_SCHEMES}|${AUTH_LINE_SCHEMES}`;
const AUTH_HEADER_QUOTED_RE = new RegExp(
  String.raw`(\bauthorization\b(?:\\?["'])?\s*[:=]\s*\\?["'])((?:${AUTH_SCHEMES})\s+)([^\r\n"'\\]+)`,
  "gi",
);
const AUTH_HEADER_RE = new RegExp(
  String.raw`(\bauthorization\b(?:\\?["'])?\s*[:=]\s*)(?!\\?["'])(?:((?:${AUTH_TOKEN_SCHEMES})\s+)([^\s"'\\,;]+)|((?:${AUTH_LINE_SCHEMES})\s+)([^\r\n]+))`,
  "gi",
);
const AUTH_SCHEME_ONLY_RE = new RegExp(`^(?:${AUTH_SCHEMES})$`, "i");
// R6-41 ②：不再要求词首 `\b`——`xBearer abc…` / `\nBearer abc…`（转义换行紧贴）也脱敏；代价是 `torchbearer Gandalf…` 这类以 bearer / basic 结尾的普通词后跟 ≥6 位字母数字时会被误藏（宁可多藏）
const AUTH_SCHEME_RE = /(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{6,}/gi;

// 裸密钥：认前缀。R6-41 ②：长且独特的前缀（ghp_ / github_pat_ / glpat- / xox / AKIA / AIza）不再要求词首 `\b`，紧贴字母数字 / 下划线前缀的也脱敏；
// `sk-` 保留 `\b`：它只有 3 个字符，`task-` / `risk-` 的结尾（`task-1234-some-long-slug`）会被大面积误杀。
const BARE_SECRET_RES = [
  // R6-41 验收补：JSON / 日志里转义换行紧贴（`…\nsk-proj-…`，`\n` 是反斜杠 + n 两个字符）时 `\b` 不成立 → 漏；词首条件放宽到「`\b` 或紧跟 `\n` `\r` `\t` 转义」（`\ntask-…` 的 sk 前面是 `a`，不受影响）
  { re: /(?:\b|(?<=\\[nrt]))sk-[A-Za-z0-9_-]{20,}/g, needsDigit: true },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { re: /glpat-[A-Za-z0-9_-]{16,}/g },
  { re: /xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { re: /AKIA[0-9A-Z]{16}\b/g },
  { re: /AIza[0-9A-Za-z_-]{35}/g },
];

const COOKIE_HEADER_RE = /\b(cookie\b(?:\\?["'])?\s*:\s*)(?=[^\s"';=]{1,256}=)[^\r\n]+/gi;
const USERINFO_RE = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^/?#\s"'<>]+)@/gi;
const QUERY_CODE_RE = /((?:^|[?&])code=)([^\s&#"'\\]+)/gi;

const KEY_SUFFIX = String.raw`(?:[_.-]?(?:confirm(?:ation|ed)?|again|repeat|retype|new|old|current|value|\d{1,3}))?`;
const KEY_CLOSE = String.raw`(?:\]|%5D|\[[^\]=&\s]{0,40}\]|%5B[^%=&\s]{0,40}%5D)*`;
const KEY_CHARS = String.raw`[\w.%[\]-]`;
const GENERAL_WORDS =
  "token|secret|password|passwd|passcode|passphrase|pwd|jwt|api[_-]?key|apikey|authorization|credentials?|session[_-]?id|sess[_-]?id|aspsessionid[a-z]{0,16}|signature|cookie|csrf|xsrf";
// R6-41 验收补：`sess`（koa-session 的 `koa.sess` / `koa.sess.sig`、express 的 `express:sess`）与 debug-policy 的 isCredentialName 同口径；短词必须整词，`assess` / `assessment` / `sessions` 不受影响
const SHORT_WORDS = "key|sid|sig|session|sess|auth|pass|pw|psw|pswd|(?:pin|otp|hotp|totp)(?:[_.-]?code)?";
const KEY_NAME = String.raw`(?:${KEY_CHARS}*?(?:${GENERAL_WORDS})s?${KEY_SUFFIX}${KEY_CLOSE}|(?:${KEY_CHARS}*[_.\-[\]])?(?:${SHORT_WORDS})${KEY_CLOSE})`;
const VALUE = String.raw`(\\"(?:[^"\\\r\n]|\\(?!"))*\\"|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|\[已隐藏\]|[^\s"'&,;}\]]+)`;
const KEY_VALUE_RE = new RegExp(String.raw`(?<!${KEY_CHARS})(\\?["']?)(${KEY_NAME})\1(\s*[:=]\s*)${VALUE}`, "gi");

const reSrc = (re) => ({ source: re.source, flags: re.flags });

/**
 * 管线实际使用的全部正则源码 / 词表 / 常量（R6-39 ⑤）：**由管线自己的常量派生**，不是另抄一份，所以不会与实际规则脱节。
 * tests/browser-redact-parity.test.ts 逐项比较 mjs / ts 两端——只改一端的词表（如 SHORT_WORDS 去掉 `sig`）、前瞻上限（cookie 256→2）、品牌表、卡号分组都会变红，
 * 不再只靠「向量表 + 随机拼接」的行为样本（那种样本对没覆盖到的词 / 上限是盲的）。
 */
export const REDACT_PATTERNS = Object.freeze({
  PEM_RE: reSrc(PEM_RE),
  CARD_RE: reSrc(CARD_RE),
  CARD_BRANDS: CARD_BRANDS.map((b) => ({ name: b.name, prefix: b.prefix.source, lens: [...b.lens] })),
  CARD_GROUPINGS: [...CARD_GROUPINGS],
  CARD_CONTEXT_RE: reSrc(CARD_CONTEXT_RE),
  JWT_HEADER_MAX,
  JWT_RE: reSrc(JWT_RE),
  AUTH_TOKEN_SCHEMES,
  AUTH_LINE_SCHEMES,
  AUTH_HEADER_QUOTED_RE: reSrc(AUTH_HEADER_QUOTED_RE),
  AUTH_HEADER_RE: reSrc(AUTH_HEADER_RE),
  AUTH_SCHEME_ONLY_RE: reSrc(AUTH_SCHEME_ONLY_RE),
  AUTH_SCHEME_RE: reSrc(AUTH_SCHEME_RE),
  BARE_SECRET_RES: BARE_SECRET_RES.map(({ re, needsDigit }) => ({ ...reSrc(re), needsDigit: needsDigit === true })),
  COOKIE_HEADER_RE: reSrc(COOKIE_HEADER_RE),
  USERINFO_RE: reSrc(USERINFO_RE),
  QUERY_CODE_RE: reSrc(QUERY_CODE_RE),
  KEY_SUFFIX,
  KEY_CLOSE,
  KEY_CHARS,
  GENERAL_WORDS,
  SHORT_WORDS,
  KEY_NAME,
  VALUE,
  KEY_VALUE_RE: reSrc(KEY_VALUE_RE),
});

/**
 * 脱敏并返回替换次数。与 redact-text.ts 的 `redactSensitiveTextCounted` 逐步骤一致（顺序也一致：后面的步骤依赖前面步骤留下的占位符做幂等判断）。
 * @param {unknown} input
 * @returns {{ text: string, count: number }}
 */
export const redactSensitiveTextCounted = (input) => {
  let count = 0;
  let text = String(input ?? "");
  text = text.replace(PEM_RE, () => {
    count += 1;
    return REDACTED_TEXT;
  });
  text = text.replace(JWT_RE, () => {
    count += 1;
    return REDACTED_TEXT;
  });
  text = text.replace(USERINFO_RE, (m, scheme, userinfo) => {
    if (userinfo === REDACTED_TEXT) return m;
    count += 1;
    return `${scheme}${REDACTED_TEXT}@`;
  });
  text = text.replace(AUTH_HEADER_QUOTED_RE, (m, head, scheme, cred) => {
    if (cred.trim() === REDACTED_TEXT) return m;
    count += 1;
    return `${head}${scheme}${REDACTED_TEXT}`;
  });
  text = text.replace(AUTH_HEADER_RE, (m, head, scheme1, cred1, scheme2, cred2) => {
    const scheme = scheme1 ?? scheme2 ?? "";
    const cred = cred1 ?? cred2 ?? "";
    if (cred.trim() === REDACTED_TEXT) return m;
    const tail = scheme2 !== undefined ? (/['")]*$/.exec(cred)?.[0] ?? "") : "";
    count += 1;
    return `${head}${scheme}${REDACTED_TEXT}${tail}`;
  });
  text = text.replace(AUTH_SCHEME_RE, (_m, scheme, space) => {
    count += 1;
    return `${scheme}${space}${REDACTED_TEXT}`;
  });
  for (const { re, needsDigit } of BARE_SECRET_RES) {
    text = text.replace(re, (m) => {
      if (needsDigit && !/\d/.test(m)) return m;
      count += 1;
      return REDACTED_TEXT;
    });
  }
  // 卡号语境（CARD_CONTEXT_RE）看的是「已经替换过的输出」的末尾 40 字符，而不是原文：前一个卡号被打码成占位符之后，紧跟其后的候选的语境与「第二遍脱敏看到的文本」一致，
  // 否则同一段文字脱敏一遍与两遍的结果不同（幂等性被卡号语境打破）。每个候选只多拼接 ≤ 40 字符，仍线性。
  let prevEnd = 0;
  let tail = "";
  text = text.replace(CARD_RE, (m, offset, whole) => {
    tail = (tail + whole.slice(prevEnd, offset)).slice(-40);
    prevEnd = offset + m.length;
    const span = findCardSpan(m, CARD_CONTEXT_RE.test(tail));
    let out = m;
    if (span) {
      count += 1;
      out = `${m.slice(0, span[0])}${REDACTED_TEXT}${m.slice(span[1])}`;
    }
    tail = (tail + out).slice(-40);
    return out;
  });
  text = text.replace(COOKIE_HEADER_RE, (_m, head) => {
    count += 1;
    return `${head}${REDACTED_TEXT}`;
  });
  text = text.replace(QUERY_CODE_RE, (_m, head) => {
    count += 1;
    return `${head}${REDACTED_TEXT}`;
  });
  text = text.replace(KEY_VALUE_RE, (m, q1, key, sep, value) => {
    if (/^(?:bearer|basic)$/i.test(value)) return m;
    if (/authorization$/i.test(key) && AUTH_SCHEME_ONLY_RE.test(value)) return m;
    if (value.includes(REDACTED_TEXT)) return m;
    count += 1;
    const quote = value.startsWith('\\"') ? '\\"' : value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
    return `${q1}${key}${q1}${sep}${quote}${REDACTED_TEXT}${quote}`;
  });
  return { text, count };
};

export const redactSensitiveText = (input) => redactSensitiveTextCounted(input).text;

/** 脱敏前先截的窗口：正则管线是线性的，但对每个高频帧都扫一遍整串没必要；窗口比最终保留长度大得多，截断点附近的凭据仍能在窗口内被完整匹配 */
export const REDACT_WINDOW_CHARS = 16_384;

/**
 * 「先脱敏、后截断」：先取至多 {@link REDACT_WINDOW_CHARS} 字符脱敏，再截到 maxChars。
 * 窗口末尾若恰好落在一个凭据中间，那段残留在窗口之外的部分根本不会被保留（最终长度 ≤ maxChars ≪ 窗口），不构成泄露。
 * @param {unknown} input
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean, originalLength: number }}
 */
export const redactAndClip = (input, maxChars) => {
  const raw = String(input ?? "");
  const win = raw.length > REDACT_WINDOW_CHARS ? raw.slice(0, REDACT_WINDOW_CHARS) : raw;
  const red = redactSensitiveText(win);
  if (red.length > maxChars) return { text: red.slice(0, maxChars), truncated: true, originalLength: raw.length };
  return { text: red, truncated: raw.length > win.length, originalLength: raw.length };
};
