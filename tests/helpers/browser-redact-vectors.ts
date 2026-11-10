/**
 * R6-08 / R6-14：文本脱敏的「输入 → 期望输出」向量表。
 * 同一张表同时喂主进程 `electron-app/browser/text-redact.mjs` 与 server `src/lib/server/browser/redact-text.ts`
 * （tests/browser-redact-parity.test.ts）：两端输出必须逐条相同、且都等于这里的 expected。
 * 新增 / 修改任何一边的规则，先在这里加正反例。
 */

export interface RedactVector {
  /** 覆盖的规则名（对应 REDACT_RULE_NAMES；"none" = 反例：什么都不该动） */
  rule: string;
  name: string;
  input: string;
  expected: string;
}

const H = "[已隐藏]";

export const REDACT_VECTORS: RedactVector[] = [
  // ── PEM 私钥块 ──
  { rule: "pem-private-key", name: "RSA 私钥整块", input: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nafter", expected: `${H}\nafter` },
  { rule: "pem-private-key", name: "无类型词的 PRIVATE KEY", input: "k=-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----", expected: `k=${H}` },
  { rule: "pem-private-key", name: "只有 BEGIN（被截断）→ 吃到文本结尾", input: "x -----BEGIN PRIVATE KEY-----\nMIIEvQ truncated", expected: `x ${H}` },
  { rule: "pem-private-key", name: "OPENSSH 私钥在 JSON 转义串里", input: '{"k":"-----BEGIN OPENSSH PRIVATE KEY-----\\nb3Blbn\\n-----END OPENSSH PRIVATE KEY-----\\n","n":1}', expected: `{"k":"${H}\\n","n":1}` },
  { rule: "pem-private-key", name: "PGP PRIVATE KEY BLOCK", input: "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdG\n-----END PGP PRIVATE KEY BLOCK-----", expected: H },
  { rule: "none", name: "公钥不是凭据", input: "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----", expected: "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----" },
  { rule: "none", name: "证书不是凭据", input: "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----", expected: "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----" },

  // ── 银行卡号（Luhn） ──
  { rule: "card-number", name: "Visa 16 位无分隔", input: "4111111111111111", expected: H },
  { rule: "card-number", name: "Visa 空格分隔 + 后跟有效期", input: "card 4111 1111 1111 1111 exp 12/25", expected: `card ${H} exp 12/25` },
  { rule: "card-number", name: "连字符分隔、句号结尾", input: "card 4111-1111-1111-1111.", expected: `card ${H}.` },
  { rule: "card-number", name: "Amex 15 位无分隔", input: "378282246310005", expected: H },
  { rule: "card-number", name: "Amex 4-6-5 分组", input: "3782 822463 10005", expected: H },
  { rule: "card-number", name: "卡号前面还粘着别的数字组（截出 Luhn 通过的区间）", input: "12 4111 1111 1111 1111", expected: `12 ${H}` },
  { rule: "card-number", name: "19 位卡号（Luhn 通过）", input: "6212345678901234569", expected: H },
  { rule: "none", name: "19 位但 Luhn 不通过", input: "6212345678901234563", expected: "6212345678901234563" },
  { rule: "card-number", name: "写在 JSON 里", input: '{"pan":"4111111111111111","n":1}', expected: `{"pan":"${H}","n":1}` },
  { rule: "none", name: "Luhn 不通过的 16 位", input: "4111 1111 1111 1112", expected: "4111 1111 1111 1112" },
  { rule: "none", name: "13 位毫秒时间戳（无分隔 13 位不脱敏）", input: "ts=1699999999999", expected: "ts=1699999999999" },
  { rule: "none", name: "13 位无分隔且 Luhn 通过（Visa 13 位测试卡）也不动", input: "n=4222222222222", expected: "n=4222222222222" },
  { rule: "none", name: "带字母的 UUID", input: "550e8400-e29b-41d4-a716-446655440000", expected: "550e8400-e29b-41d4-a716-446655440000" },
  { rule: "none", name: "全数字 UUID 样式（连字符分段）", input: "12345678-1234-1234-1234-123456789012", expected: "12345678-1234-1234-1234-123456789012" },
  { rule: "none", name: "浮点数小数部分", input: "pi 3.1415926535897932", expected: "pi 3.1415926535897932" },
  { rule: "none", name: "20 位以上长数字串", input: "id=41111111111111111111", expected: "id=41111111111111111111" },
  { rule: "none", name: "12 位数字", input: "no 411111111111", expected: "no 411111111111" },
  // R6-41 ③：品牌 IIN + 长度 + 卡面分组（Luhn 单独不再够）
  { rule: "card-number", name: "Mastercard 5555…（2 系之外）", input: "5555555555554444", expected: H },
  { rule: "card-number", name: "Mastercard 2 系下界 2221", input: "2221000000000009", expected: H },
  { rule: "card-number", name: "Mastercard 2 系上界 2720", input: "2720000000000005", expected: H },
  { rule: "none", name: "2721 不是 Mastercard（Luhn 通过也不动）", input: "2721000000000004", expected: "2721000000000004" },
  { rule: "none", name: "2220 不是 Mastercard", input: "2220000000000000", expected: "2220000000000000" },
  { rule: "card-number", name: "JCB 3528 下界", input: "3528000000000007", expected: H },
  { rule: "card-number", name: "JCB 3589 上界", input: "3589000000000003", expected: H },
  { rule: "none", name: "3527 / 3590 不是 JCB", input: "3527000000000008 3590000000000000", expected: "3527000000000008 3590000000000000" },
  { rule: "card-number", name: "银联 62 · 19 位连字符 4-4-4-4-3 分组", input: "卡 6222-0212-3456-7890-128", expected: `卡 ${H}` },
  { rule: "card-number", name: "Diners 14 位 4-6-4 分组", input: "3056 930902 5904", expected: H },
  { rule: "card-number", name: "Diners 14 位无分隔", input: "30569309025904", expected: H },
  { rule: "none", name: "Luhn 通过但没有品牌前缀的 16 位订单号（改前被误杀）", input: "order 1000000000000008", expected: "order 1000000000000008" },
  { rule: "none", name: "Luhn 通过但没有品牌前缀的 17 位 JSON id", input: '{"id":12345678901234569}', expected: '{"id":12345678901234569}' },
  { rule: "none", name: "+86 手机号（空格分组）", input: "+86 138 1234 5678", expected: "+86 138 1234 5678" },
  { rule: "none", name: "ISBN-13（连字符）", input: "ISBN 978-3-16-148410-0", expected: "ISBN 978-3-16-148410-0" },
  { rule: "none", name: "有品牌前缀 + Luhn，但分组不像卡面（4-2-4-4-2）", input: "4111 11 1111 1111 11", expected: "4111 11 1111 1111 11" },
  { rule: "card-number", name: "卡号语境放宽：冷门前缀（6012…）+「卡号」", input: "卡号：6012345678901234", expected: `卡号：${H}` },
  { rule: "card-number", name: "卡号语境放宽：JSON cardNumber", input: '{"cardNumber":"6012345678901234"}', expected: `{"cardNumber":"${H}"}` },
  { rule: "none", name: "没有语境、冷门前缀（6012…）不动", input: "6012345678901234", expected: "6012345678901234" },
  { rule: "none", name: "语境放宽也不放过 13 位无分隔（毫秒时间戳）", input: "card 1699999999996", expected: "card 1699999999996" },
  // R6-41 验收补（变异存活 → 补用例）：起点排除小数点 / 关键词词边界 / 冷门品牌
  { rule: "none", name: "小数部分即使有品牌前缀 + Luhn 也不当卡号（起点排除 `.`）", input: "v=0.4111111111111111", expected: "v=0.4111111111111111" },
  { rule: "none", name: "company / span 里的 pan 不是卡号关键词（\\bpan\\b 词边界）", input: "company 6012345678901234 span 6012345678901234", expected: "company 6012345678901234 span 6012345678901234" },
  { rule: "card-number", name: "关键词 PAN 独立成词 → 语境放宽", input: "PAN 6012345678901234", expected: `PAN ${H}` },
  { rule: "card-number", name: "Maestro 5018 · 16 位", input: "5018000000000009", expected: H },
  { rule: "card-number", name: "Maestro 6759 · 19 位", input: "6759000000000000005", expected: H },
  { rule: "card-number", name: "Mir 2200 · 16 位", input: "2200000000000004", expected: H },

  // ── JWT ──
  { rule: "jwt", name: "三段式 JWT", input: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def-123", expected: H },
  { rule: "jwt", name: "签名为空（alg:none）", input: "t eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0. end", expected: `t ${H} end` },
  { rule: "none", name: "只有两段不是 JWT", input: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0", expected: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0" },
  // R6-41 ②：紧贴字母 / 数字 / 下划线前缀的令牌（旧版 `\b` 在这些前缀之后不成立 → 漏）
  { rule: "jwt", name: "字母前缀 xeyJ…", input: "xeyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def-123", expected: `x${H}` },
  { rule: "jwt", name: "数字前缀 1eyJ…", input: "1eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def-123", expected: `1${H}` },
  { rule: "jwt", name: "下划线前缀 token_eyJ…", input: "t_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def-123", expected: `t_${H}` },
  { rule: "jwt", name: "卡号紧贴 JWT：一遍就两个都脱敏", input: "4111111111111111eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def-123", expected: `${H}${H}` },

  // ── 既有规则的回归（防止新规则改变既有行为） ──
  { rule: "userinfo", name: "URL userinfo", input: "https://user:pw@host.test/a", expected: `https://${H}@host.test/a` },
  { rule: "auth-header-quoted", name: "JSON 里的 authorization", input: '{"authorization":"Bearer abc.def"}', expected: `{"authorization":"Bearer ${H}"}` },
  { rule: "auth-header", name: "Authorization 头", input: "Authorization: Bearer abcdef123456", expected: `Authorization: Bearer ${H}` },
  { rule: "auth-scheme", name: "裸 Bearer", input: "Proxy: Basic dXNlcjpwYXNz", expected: `Proxy: Basic ${H}` },
  { rule: "auth-scheme", name: "字母前缀 xBearer（R6-41 ②）", input: "xBearer abcdef123456", expected: `xBearer ${H}` },
  { rule: "auth-scheme", name: "转义换行紧贴 \\nBearer（R6-41 ②）", input: "hdr\\nBearer abcdef123456", expected: `hdr\\nBearer ${H}` },
  { rule: "bare-secret", name: "GitHub token", input: "x ghp_abcdefghijklmnopqrstuvwxyz0123 y", expected: `x ${H} y` },
  { rule: "bare-secret", name: "下划线前缀 foo_ghp_…（R6-41 ②）", input: "foo_ghp_abcdefghijklmnopqrstuvwxyz0123", expected: `foo_${H}` },
  { rule: "bare-secret", name: "字母前缀 AKIA（R6-41 ②）", input: "keyAKIAIOSFODNN7EXAMPLE", expected: `key${H}` },
  { rule: "bare-secret", name: "字母前缀 xoxb-（R6-41 ②）", input: "dataxoxb-1234567890-abcdefghij", expected: `data${H}` },
  { rule: "bare-secret", name: "sk- 纯字母不误杀", input: "sk-learn-is-a-python-library-ok", expected: "sk-learn-is-a-python-library-ok" },
  { rule: "bare-secret", name: "task- 结尾的长 slug 不被 sk- 误杀（sk- 保留词首边界）", input: "/tasks/task-1234-some-long-slug-name-here", expected: "/tasks/task-1234-some-long-slug-name-here" },
  // R6-41 验收补：JSON / 日志里的转义换行（反斜杠 + n）紧贴 sk-
  { rule: "bare-secret", name: "转义换行 \\n 紧贴 sk-（JSON 文本里）", input: '{"m":"use this:\\nsk-proj-abcdefghij1234567890abcdef"}', expected: `{"m":"use this:\\n${H}"}` },
  { rule: "bare-secret", name: "转义换行 \\n 后的 task- slug 仍不误杀", input: "a\\ntask-1234-some-long-slug-name-here", expected: "a\\ntask-1234-some-long-slug-name-here" },
  { rule: "cookie-header", name: "Cookie 头整行", input: "Cookie: sid=abc; theme=dark", expected: `Cookie: ${H}` },
  { rule: "query-code", name: "OAuth code", input: "https://a.test/cb?code=abc123&state=x", expected: `https://a.test/cb?code=${H}&state=x` },
  { rule: "query-code", name: "status_code 不误杀", input: "status_code=200", expected: "status_code=200" },
  { rule: "key-value", name: "password=", input: "password=hunter2", expected: `password=${H}` },
  { rule: "key-value", name: "JSON password", input: '{"password":"hunter2","u":"a"}', expected: `{"password":"${H}","u":"a"}` },
  { rule: "key-value", name: "JSESSIONID（R6-41 ④）", input: "JSESSIONID=ABC123DEF456", expected: `JSESSIONID=${H}` },
  { rule: "key-value", name: "PHPSESSID（R6-41 ④）", input: "PHPSESSID=abc123def", expected: `PHPSESSID=${H}` },
  { rule: "key-value", name: "connect.sid（R6-41 ④）", input: "connect.sid=s%3Aabc.def", expected: `connect.sid=${H}` },
  { rule: "key-value", name: "ASP.NET_SessionId（R6-41 ④）", input: "ASP.NET_SessionId=abc123", expected: `ASP.NET_SessionId=${H}` },
  { rule: "key-value", name: "ASPSESSIONID<随机后缀>（R6-41 ④）", input: "ASPSESSIONIDAQSTRDCT=abcdef", expected: `ASPSESSIONIDAQSTRDCT=${H}` },
  { rule: "key-value", name: "JSON 里的 JSESSIONID", input: '{"JSESSIONID":"ABC123"}', expected: `{"JSESSIONID":"${H}"}` },
  // R6-41 验收补：koa-session / express-session 的 `sess` 名（与 isCredentialName 同口径）
  { rule: "key-value", name: "koa.sess（R6-41 ④ 验收补）", input: "koa.sess=eyJ1aWQiOjF9", expected: `koa.sess=${H}` },
  { rule: "key-value", name: "express:sess（R6-41 ④ 验收补）", input: "express:sess=abc123", expected: `express:sess=${H}` },
  { rule: "key-value", name: "assess= 不误杀（sess 必须整词）", input: "assess=done", expected: "assess=done" },
  // R6-41 验收补：紧贴前缀的 JWT（header ≤ 256 走「紧贴」档；词首的 header 上限仍是 2048）
  { rule: "jwt", name: "紧贴前缀 + 200 字符 header", input: `x${"eyJ" + "a".repeat(197)}.eyJzdWIiOiIxMjM0In0.sig_ab`, expected: `x${H}` },
  { rule: "jwt", name: "词首 + 1000 字符 header（2048 档）", input: `t ${"eyJ" + "a".repeat(997)}.eyJzdWIiOiIxMjM0In0.sig_ab`, expected: `t ${H}` },
  { rule: "key-value", name: "token_type 不误杀", input: "token_type=bearer", expected: "token_type=bearer" },
  { rule: "key-value", name: "keyboard / monkey 不误杀", input: "keyboard=us monkey=1", expected: "keyboard=us monkey=1" },

  // ── 幂等 ──
  { rule: "none", name: "已脱敏文本再脱敏不变", input: `password=${H} card ${H}`, expected: `password=${H} card ${H}` },
];

/** 随机拼接用的片段（parity 随机测试：两端对任意拼接输出必须逐字相同） */
export const REDACT_FRAGMENTS: string[] = [
  ...REDACT_VECTORS.map((v) => v.input),
  " ",
  "\n",
  "=",
  ":",
  "-",
  "&",
  '"',
  "12/25",
  "1699999999999",
  "4111 1111 1111 1111",
  "5555555555554444",
  "6012345678901234",
  "卡号：",
  "card ",
  "xBearer ",
  "eyJ",
  "-----BEGIN PRIVATE KEY-----",
  "-----END PRIVATE KEY-----",
  "Bearer ",
  "token=",
];
