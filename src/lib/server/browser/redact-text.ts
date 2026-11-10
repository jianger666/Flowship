/**
 * 网络请求 / 响应体 / 控制台输出里的凭据样式文本脱敏（契约 §14.2 `browser_network` 要点；R1-19 / R1-26 补强）。
 *
 * 主进程已经把敏感**头**换成 `[已隐藏]`；这里是 server 侧的第二道：请求体 / 响应体 / URL / console 文本里的
 * `Authorization: Bearer|Basic|Token xxx`、`token=xxx`、`"password":"xxx"`（含转义引号的 `\"password\":\"xxx\"`）、
 * JWT（三段 base64url）、裸密钥（`sk-` / `ghp_` / `xox` / `glpat-` / `AKIA` / `AIza`）、cookie 头、
 * `?code= / &key= / &sig= / &sid= / &session=` 这类 query 参数一律替换，再交给模型。
 * 取舍：宁可多藏——一个误伤的字段值对 AI 的排查几乎没影响，漏一个令牌却是实打实的泄露面；
 * 但常见的普通文字（`status_code=200`、`keyboard=us`、`token_type`、`tokenizer`、`monkey`、`Bearer of bad news`）不动。
 *
 * # 调用约定（调用方的责任）
 * **先脱敏、后截断**：先截断会把凭据劈成两段（JWT 前两段残留、`password=` 的值被切掉一半），残留的前半段匹配不上。
 *
 * # 复杂度
 * 没有二次方回溯（R1-19 / R2-04 逐项对抗输入验证过，见 tests/browser-v2-redact.test.ts 与 tests/browser-r2-redact.test.ts 的耗时用例）：
 *  · KEY_VALUE_RE 用 `(?<![\w.-])` 把起点限制在「键名 token 的开头」——旧版前缀 `(?:[\w.-]*?)` 没有锚点，
 *    每个起点都向后扫到串尾，遇到 2 万字符的 `[\w.-]` 连续串（长 hex / base64 / 路径）就是 O(L²)；
 *  · JWT_RE 的第一段（header）有上限且用「前瞻 + 反向引用」做成原子匹配：`"eyJabcde-".repeat(n)` 里每个 `eyJ` 都是合法起点，
 *    无上限时每个起点都扫到串尾再逐字回溯；现在每个起点最多扫 {@link JWT_HEADER_MAX} 个字符、且不回溯；
 *  · COOKIE_HEADER_RE 的前瞻 `(?=[^\s"';=]{1,256}=)` 有上限：`"cookie:".repeat(n)` 的每个起点不再扫到串尾；
 *  · USERINFO_RE 用 `(?<![a-z0-9+.-])` 限定起点在 scheme 词的开头。
 *
 * 纯函数、无依赖，可直接单测。
 */

export const REDACTED_TEXT = "[已隐藏]";

/** 规则名清单（按管线顺序）：与主进程 `electron-app/browser/text-redact.mjs` 的 REDACT_RULE_NAMES 必须一致（tests/browser-redact-parity.test.ts 断言） */
export const REDACT_RULE_NAMES: readonly string[] = Object.freeze([
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
const CARD_BRANDS: ReadonlyArray<{ name: string; prefix: RegExp; lens: readonly number[] }> = [
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
const CARD_GROUPINGS: readonly string[] = ["4-6-5", "4-6-4"];

/** 卡号前 40 字符里出现这些词（且词与号码之间只隔 ≤ 24 个非数字字符）→ 视为卡号语境，放宽品牌前缀要求 */
const CARD_CONTEXT_RE = /(?:card|\bpan\b|credit|debit|\bcc[ _-]?(?:num|no)|cvv|cvc|卡号|卡號|银行卡|信用卡|储蓄卡|借记卡)[^\d]{0,24}$/i;

const cardBrandOk = (digits: string): boolean => CARD_BRANDS.some((b) => b.prefix.test(digits) && b.lens.includes(digits.length));

/** 游程长度是否像卡面分组：单个游程（无分隔）恒真 */
const cardGroupingOk = (runLens: number[]): boolean => {
  if (runLens.length === 1) return true;
  const last = runLens.length - 1;
  if (runLens.slice(0, last).every((n) => n === 4) && runLens[last] >= 1 && runLens[last] <= 4) return true;
  return CARD_GROUPINGS.includes(runLens.join("-"));
};

const luhnOk = (digits: string): boolean => {
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
 */
const findCardSpan = (m: string, loose = false): [number, number] | null => {
  const runs: Array<{ s: number; e: number; n: number }> = [];
  for (const r of m.matchAll(/\d+/g)) runs.push({ s: r.index ?? 0, e: (r.index ?? 0) + r[0].length, n: r[0].length });
  let best: { total: number; span: [number, number] } | null = null;
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

// JWT：header 与 payload 都是 base64url 的 JSON（以 eyJ 开头 = `{"`），第三段签名可为空（alg:none）。
// 段字符集里没有 `.`，所以「贪婪吃完这一段、紧接着必须是 `.`」与回溯等价——用 `(?=(…))\n` 做成原子匹配，省掉逐字回溯。
// 只给第一段设上限（header 真实长度几十到几百字符，带 x5c 证书链也就几 KB；超过 {@link JWT_HEADER_MAX} 当不是 JWT）：
// 失败的扫描只发生在第一段，后两段只有「第一段 + 点」都成立才会扫，且各自止于下一个 `.`，总量线性、不设上限（payload 可能很大，不能漏）。
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

// Authorization 头 / 键：方案词 + 凭据整体替换（保留方案词，便于排查「用的是哪种认证」）。
// Token / Digest 等方案不能像 Bearer 那样做「裸词」匹配（`Token expired` 是普通英文），所以必须挂在 authorization 键后面。
// 两种写法：
//  · 带引号的值（JSON / 转义 JSON：`"authorization":"Token abc"`、`\"authorization\":\"Token abc\"`）：凭据吃到闭合引号为止；
//  · 头的写法（`Authorization: Token abc`）：Bearer / Basic / Token / ApiKey 的凭据是一个不含空白 / 引号 / 逗号的整体，
//    Digest / Negotiate / NTLM 的值里有引号、空格和逗号，吃到行尾（紧贴行尾的闭合符 `'` `"` `)` 原样保留）。
//    不能一律吃到行尾：`curl -H 'authorization: bearer xxx' https://a.test` 后面的 URL 不该被连带吃掉。
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
/** KEY_VALUE_RE 拿到的值若只是方案词（`Authorization: Token abc` 里的 `Token`），说明后面的凭据交给上面的 AUTH_HEADER_RE 处理 */
const AUTH_SCHEME_ONLY_RE = new RegExp(`^(?:${AUTH_SCHEMES})$`, "i");

// 裸的 Bearer / Basic 凭据（没有 authorization 键，比如 `Proxy: Basic xxx`、`curl -H 'Foo: Bearer xxx'`）
// R6-41 ②：不再要求词首 `\b`——`xBearer abc…` / `\nBearer abc…`（转义换行紧贴）也脱敏；代价是 `torchbearer Gandalf…` 这类以 bearer / basic 结尾的普通词后跟 ≥6 位字母数字时会被误藏（宁可多藏）
const AUTH_SCHEME_RE = /(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{6,}/gi;

// 裸密钥：不靠键名，认前缀。`sk-` 要求至少一个数字（见回调），免得误伤 `sk-learn-is-a-python-library` 这类纯字母连字符串。
// R6-41 ②：长且独特的前缀（ghp_ / github_pat_ / glpat- / xox / AKIA / AIza）不再要求词首 `\b`，紧贴字母数字 / 下划线前缀的也脱敏；
// `sk-` 保留 `\b`：它只有 3 个字符，`task-` / `risk-` 的结尾（`task-1234-some-long-slug`）会被大面积误杀。
const BARE_SECRET_RES: Array<{ re: RegExp; needsDigit?: boolean }> = [
  // R6-41 验收补：JSON / 日志里转义换行紧贴（`…\nsk-proj-…`，`\n` 是反斜杠 + n 两个字符）时 `\b` 不成立 → 漏；词首条件放宽到「`\b` 或紧跟 `\n` `\r` `\t` 转义」（`\ntask-…` 的 sk 前面是 `a`，不受影响）
  { re: /(?:\b|(?<=\\[nrt]))sk-[A-Za-z0-9_-]{20,}/g, needsDigit: true }, // OpenAI / Anthropic（sk-proj-… / sk-ant-…）
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g }, // GitHub ghp_ / gho_ / ghu_ / ghs_ / ghr_
  { re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { re: /glpat-[A-Za-z0-9_-]{16,}/g }, // GitLab（Flowship 自己就在用 GitLab token）
  { re: /xox[abposr]-[A-Za-z0-9-]{10,}/g }, // Slack
  { re: /AKIA[0-9A-Z]{16}\b/g }, // AWS access key id
  { re: /AIza[0-9A-Za-z_-]{35}/g }, // Google API key
];

// cookie 头：`Cookie: sid=abc; theme=dark` 里整行都是凭据（逐个键值对扫会漏掉第二个起）。
// 只在「值是 name=value 的 cookie 写法」时吃到行尾；JSON 的 `"cookie":"…"` 走下面的 KEY_VALUE_RE。
// 前瞻里的 cookie 名有上限（真实名字几十字符）：无上限时 `"cookie:".repeat(n)` 的每个起点都要扫到串尾（R2-04）。
const COOKIE_HEADER_RE = /\b(cookie\b(?:\\?["'])?\s*:\s*)(?=[^\s"';=]{1,256}=)[^\r\n]+/gi;

// `scheme://user:pass@host` 的 userinfo（console 文本里常见的 `https://user:pw@host`、连接串）：整段隐藏，用户名位置也常放 token。
// userinfo 一直吃到 authority 里**最后一个** `@`（密码里本身含 `@` 时 `user:p@ss@host` 不会只吃到第一个 `@`）；
// 起点限定在 scheme 词的开头（lookbehind），长串字母不会让每个位置都重扫一遍。
const USERINFO_RE = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^/?#\s"'<>]+)@/gi;

// OAuth 回调的 `code`：只认 URL query / 表单体里的 `?code=` `&code=`（以及整串开头的 `code=`）。
// 不做成通用键名——`status_code=200` / `error code: 404` / `zipcode=1000` 是常见的普通调试信息。
const QUERY_CODE_RE = /((?:^|[?&])code=)([^\s&#"'\\]+)/gi;

// 键名：
//  · 通用词（任意前缀，允许结尾单个 s）：token / secret / password / api key / authorization / cookie / signature / csrf …
//  · 短词（必须整词，或以 `_` `-` `.` 分隔的后缀）：key / sid / sig / session / auth
//    —— 这样 `access_key` `x-auth-key` `ocp-apim-subscription-key` `sid=` `sig=` `session=` 命中，
//       而 `monkey` `hotkey` `keyboard` `turkey` `assignment` 不会。
// 之后跟 `=` 或 `:`，值是（可转义引号的）引号串，或一段非分隔字符。
// 不误伤 `token_type`（以 type 结尾）/ `tokenizer`（敏感词后还有字母）。
// 起点用 `(?<![\w.-])` 限制在键名 token 的开头，前缀因此不会被每个起点重复扫描（线性，见头注释）。
// R2-04：`passcode` / `jwt` 足够独特，按通用词；`pass` / `pin` / `otp`（及 hotp / totp）是短词，必须整词或 `_` `-` `.` 分隔的后缀——
// `pass=` / `user_pass:` / `"pin"` 命中，`bypass` / `compass` / `passenger` / `passport` / `spin` / `ping` / `hotpot` 不会。
// R3-03 ①：表单体 / Rails / Devise 的常见写法——`user[password]=` / `user%5Bpassword%5D=`（键名里带方括号或其编码）、
// `password_confirmation=` / `password2=` / `token_value=` / `new_password_again=`（敏感词后跟确认 / 序号 / 取值类后缀）。
// 后缀只认下面这几个「整词」，所以 `token_type` / `tokenizer` / `password_strength` 仍然不误伤；键名前缀与结尾括号只在「键名 token」内部
// （起点由 lookbehind 限定在 token 开头，前缀类含 `[` `]` `%`，所以整条 `user[password]` 是一个 token，不会从中间再起点，复杂度不变）。
const KEY_SUFFIX = String.raw`(?:[_.-]?(?:confirm(?:ation|ed)?|again|repeat|retype|new|old|current|value|\d{1,3}))?`;
// R4 复审 R3-03：敏感词后面还可以跟有界的子键 `[confirm]` / `[]` / `[0]`（`user[password][confirm]=` / `password[]=` / `password[confirm]=`）及其编码；
// 子键内容 ≤ 40 个字符且不含 `]` `=` `&` 空白，几种写法的首字符（`]` / `%5D` / `[` / `%5B`）互不相同，所以没有歧义回溯，复杂度不变。
const KEY_CLOSE = String.raw`(?:\]|%5D|\[[^\]=&\s]{0,40}\]|%5B[^%=&\s]{0,40}%5D)*`;
const KEY_CHARS = String.raw`[\w.%[\]-]`;
const GENERAL_WORDS =
  "token|secret|password|passwd|passcode|passphrase|pwd|jwt|api[_-]?key|apikey|authorization|credentials?|session[_-]?id|sess[_-]?id|aspsessionid[a-z]{0,16}|signature|cookie|csrf|xsrf";
// R4 复审 R3-03：`otp_code=` / `pin_code=`（验证码类短词后可接 `code`）；`pw` / `psw` / `pswd` 与主进程 net-detail 的整词表同口径。
// 只给 pin / otp / hotp / totp 加 `code` 后缀——`keyCode=13` / `status_code=200` / `zip_code` 是普通数据，不能连带命中。
// R6-41 验收补：`sess`（koa-session 的 `koa.sess` / `koa.sess.sig`、express 的 `express:sess`）与 debug-policy 的 isCredentialName 同口径；短词必须整词，`assess` / `assessment` / `sessions` 不受影响
const SHORT_WORDS = "key|sid|sig|session|sess|auth|pass|pw|psw|pswd|(?:pin|otp|hotp|totp)(?:[_.-]?code)?";
const KEY_NAME = String.raw`(?:${KEY_CHARS}*?(?:${GENERAL_WORDS})s?${KEY_SUFFIX}${KEY_CLOSE}|(?:${KEY_CHARS}*[_.\-[\]])?(?:${SHORT_WORDS})${KEY_CLOSE})`;
// 值：转义 JSON 串 \"…\" ｜ 双引号串（支持 \" 转义）｜ 单引号串 ｜ 已脱敏占位 ｜ 一段非分隔字符
const VALUE = String.raw`(\\"(?:[^"\\\r\n]|\\(?!"))*\\"|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|\[已隐藏\]|[^\s"'&,;}\]]+)`;
const KEY_VALUE_RE = new RegExp(String.raw`(?<!${KEY_CHARS})(\\?["']?)(${KEY_NAME})\1(\s*[:=]\s*)${VALUE}`, "gi");

const reSrc = (re: RegExp): { source: string; flags: string } => ({ source: re.source, flags: re.flags });

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

export interface RedactResult {
  text: string;
  /** 被替换的片段数（0 = 没动过） */
  count: number;
}

/** 脱敏并返回替换次数（便于测试 / 提示「已隐藏 N 处」） */
export const redactSensitiveTextCounted = (input: string): RedactResult => {
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
  text = text.replace(USERINFO_RE, (m, scheme: string, userinfo: string) => {
    if (userinfo === REDACTED_TEXT) return m; // 已经脱敏过：不重复计数（保证幂等）
    count += 1;
    return `${scheme}${REDACTED_TEXT}@`;
  });
  text = text.replace(AUTH_HEADER_QUOTED_RE, (m, head: string, scheme: string, cred: string) => {
    if (cred.trim() === REDACTED_TEXT) return m; // 已经脱敏过：不重复计数
    count += 1;
    return `${head}${scheme}${REDACTED_TEXT}`;
  });
  text = text.replace(
    AUTH_HEADER_RE,
    (m, head: string, scheme1?: string, cred1?: string, scheme2?: string, cred2?: string) => {
      const scheme = scheme1 ?? scheme2 ?? "";
      const cred = cred1 ?? cred2 ?? "";
      if (cred.trim() === REDACTED_TEXT) return m; // 已经脱敏过：不重复计数（保证幂等）
      const tail = scheme2 !== undefined ? (/['")]*$/.exec(cred)?.[0] ?? "") : "";
      count += 1;
      return `${head}${scheme}${REDACTED_TEXT}${tail}`;
    },
  );
  text = text.replace(AUTH_SCHEME_RE, (_m, scheme: string, space: string) => {
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
  text = text.replace(CARD_RE, (m: string, offset: number, whole: string) => {
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
  text = text.replace(COOKIE_HEADER_RE, (_m, head: string) => {
    count += 1;
    return `${head}${REDACTED_TEXT}`;
  });
  text = text.replace(QUERY_CODE_RE, (_m, head: string) => {
    count += 1;
    return `${head}${REDACTED_TEXT}`;
  });
  text = text.replace(KEY_VALUE_RE, (m, q1: string, key: string, sep: string, value: string) => {
    // `Authorization: Bearer [已隐藏]` 里的 value 只拿到 `Bearer`：上一步已经处理过，别再嵌套替换
    if (/^(?:bearer|basic)$/i.test(value)) return m;
    if (/authorization$/i.test(key) && AUTH_SCHEME_ONLY_RE.test(value)) return m;
    // 前面的步骤已经替换过的值（含 `"Token [已隐藏]"` 这种带方案词的）原样保留：不重复计数、保证幂等
    if (value.includes(REDACTED_TEXT)) return m;
    count += 1;
    const quote = value.startsWith('\\"') ? '\\"' : value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
    return `${q1}${key}${q1}${sep}${quote}${REDACTED_TEXT}${quote}`;
  });
  return { text, count };
};

export const redactSensitiveText = (input: string): string => redactSensitiveTextCounted(input).text;
