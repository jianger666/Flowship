/**
 * 团队库上传 / 镜像推送前的敏感信息扫描（纯函数）
 *
 * 命中返回脱敏片段（前 3 字符 + ***），绝不回传完整原值。
 * force 闸门：误报时由调用方带 force 跳过阻断。
 */

/** 单条命中（脱敏后、可安全回传 API / UI） */
export type SecretScanHit = {
  /** 相对仓库根的路径 */
  file: string;
  /** 1-based 行号；整文件级命中（如 PRIVATE KEY）也标起始行 */
  line: number;
  /** 命中类型（稳定英文枚举，便于单测 / 前端分支） */
  kind:
    | "credential-key"
    | "private-key"
    | "connection-string"
    | "pgpass"
    | "high-entropy"
    /** 值形态命中常见平台令牌：sk- / ghp_ / glpat- / xox*- / AKIA / Bearer */
    | "known-token";
  /** 脱敏后的上下文片段（含键名提示，不含完整密文） */
  snippet: string;
};

/** 待扫描文件（调用方已跳过二进制 / 已解码为文本） */
export type SecretScanFile = {
  path: string;
  content: string;
};

/** 值脱敏：前 3 字符 + ***（短于 3 则全 ***） */
export const redactSecretValue = (raw: string): string => {
  const s = raw.trim();
  if (s.length === 0) return "***";
  if (s.length <= 3) return "***";
  return `${s.slice(0, 3)}***`;
};

/**
 * 粗判二进制：含 NUL，或非打印字节占比过高。
 * 调用方也可在读盘时用 Buffer 先判；此处兜底纯字符串输入。
 */
export const isProbablyBinaryText = (content: string): boolean => {
  if (content.includes("\0")) return true;
  if (content.length === 0) return false;
  const sample = content.slice(0, 8192);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    // 允许常见空白；其余 < 32 或 DEL 计为非打印
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.1;
};

/**
 * 明显占位符 / 空值 → 不当作真秘密（避免模板 skill 误报）
 * 例：【填写】、<password>、your-api-key、xxx、***、$ENV
 */
export const isPlaceholderSecretValue = (raw: string): boolean => {
  const v = raw.trim();
  if (!v) return true;
  // 去成对引号再判
  const unquoted =
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
      ? v.slice(1, -1).trim()
      : v;
  if (!unquoted) return true;

  const lower = unquoted.toLowerCase();
  if (
    lower === "xxx" ||
    lower === "xxxx" ||
    lower === "todo" ||
    lower === "fixme" ||
    lower === "changeme" ||
    lower === "placeholder" ||
    lower === "example" ||
    lower === "password" ||
    lower === "secret" ||
    lower === "token" ||
    lower === "null" ||
    lower === "undefined" ||
    lower === "none" ||
    lower === "n/a" ||
    lower === "na"
  ) {
    return true;
  }
  // 全 * / • / x 占位
  if (/^[\s*•xX·]+$/.test(unquoted)) return true;
  // 【填写】/【必填】等中文占位
  if (/^【[^】]*】$/.test(unquoted)) return true;
  // <xxx> / <your-password>
  if (/^<[^<>]+>$/.test(unquoted)) return true;
  // your- / your_ 前缀模板
  if (/^your[-_]/i.test(unquoted)) return true;
  // 环境变量引用
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(unquoted)) return true;
  // process.env.FOO
  if (/^process\.env\.[A-Za-z_][A-Za-z0-9_]*$/.test(unquoted)) return true;
  // 模板插值：{{ secrets.TOKEN }} / ${{ secrets.TOKEN }}（CI / helm 模板）
  if (/^\$?\{\{[^{}]*\}\}$/.test(unquoted)) return true;
  return false;
};

/**
 * 「小写单词 + 分隔符」的标识符串：只含 a-z 与 `-` / `_` / `.`，至少有一个分隔符、首尾和相邻位置都不是分隔符
 * （`chat-history-recovery`、`context-docs-handler`、`my_awesome_module_name`、`com.example.service.name`）。
 * 手写循环而不是 `^[a-z]+(?:[-_.][a-z]+)+$`：后者对几 MB 的 `a-a-a-…` 会把回溯栈压爆（见 KNOWN_TOKEN_RULES 注释）。
 */
const isLowercaseSlug = (s: string): boolean => {
  let sawSeparator = false;
  // 开头当作「上一个是分隔符」：首字符必须是字母
  let prevSeparator = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) {
      prevSeparator = false;
    } else if (c === 45 || c === 95 || c === 46) {
      // `-` / `_` / `.`
      if (prevSeparator) return false;
      sawSeparator = true;
      prevSeparator = true;
    } else {
      return false;
    }
  }
  return sawSeparator && !prevSeparator;
};

/**
 * 高熵长串：≥20、至少两类字符、字符多样性够；排除纯重复。
 *
 * 小写 slug 豁免：只由小写字母和分隔符组成的词串不当高熵——否则每个 skill 的 frontmatter
 * `name: <≥20 字符的 kebab 名>` 都会被当密钥拦住（仓库自带 7 个 skill 里 2 个中招：`name: chat-history-recovery`
 * 是「小写 + 横杠」两类字符、多样性也够）。真随机令牌几乎必含大写或数字（且 sk- / ghp_ / glpat- 等已有值形态规则兜底），
 * 键名敏感的写法（`password: correct-horse-battery-staple`）走 credential-key 规则、不受这条影响；
 * 含数字 / 大写的串（`skill-creator-v2-final`、`aB3dE5…`、十六进制）照旧命中。
 */
export const looksHighEntropySecret = (raw: string): boolean => {
  const s = raw.trim().replace(/^['"]|['"]$/g, "");
  if (s.length < 20) return false;
  if (isPlaceholderSecretValue(s)) return false;
  if (isLowercaseSlug(s)) return false;
  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasDigit = /\d/.test(s);
  const hasSpecial = /[^a-zA-Z0-9]/.test(s);
  const classes = [hasLower, hasUpper, hasDigit, hasSpecial].filter(
    Boolean,
  ).length;
  if (classes < 2) return false;
  const unique = new Set(s).size;
  if (unique < Math.min(8, Math.floor(s.length * 0.35))) return false;
  return true;
};

/** 行左侧是否像 hash / commit 语境（高熵规则豁免） */
const isHashContextKey = (left: string): boolean =>
  /(?:^|[\s"'`{,.(])(?:sha(?:-?1|-?256|-?512)?|md5|commit(?:[_-]?hash)?|checksum|hash|etag)\s*$/i.test(
    left.trimEnd(),
  );

/**
 * 键值对扫描（`key: value` / `key=value` / `"key": "value"` / `'key' => 'v'`）。
 * - **逐对**匹配（g 标志）：一行里多个键（`{"name":"x","apiKey":"sk-…","id":1}`）逐个判，
 *   不再只看行首第一个键；值被整体消费，字符串内容里的 `a: b` 不会被当成新的键。
 * - 键名允许点路径（`db.password`）、两侧可带引号；`==` 比较不算赋值。
 * - 值：引号串（含转义、容忍未闭合）、`{{ … }}` / `${{ … }}` 模板插值整体、
 *   **结构起始括号**（见下）、或到空白 / `,` / `;` / `}` 为止。
 * - 结构起始括号（N8-03）：值位置的 `{`（后面紧跟「键 + 冒号 / 等号」）或 `[`（后面紧跟 `{` / `[`）
 *   **只消费括号本身**、让扫描继续进到括号里面。否则兜底分支 `[^\s,;}]*` 会把
 *   `{"accessToken":"…"` 整个吞成外层键 `config` 的值——嵌套 JSON / `config: {password: x}`
 *   里的内层敏感键漏报（相对 HEAD 的回归），同时 `{"secrets":{"enabled":true}}` 这类
 *   「敏感词键名下挂对象」被当成取值 `{"e…` 误报。字面量数组（`["abc…"]`）与 `[REDACTED]`
 *   不满足前瞻条件、仍走兜底分支按整体值判。
 * - 敏感度继承（M2-01）：上一条「只消费括号」会让外层键的敏感度丢掉——`{"password":{"value":"…"}}`
 *   里内层键 `value` 自己不敏感、外层 `password` 只剩一个 `{`，整体漏报。所以另用一个按文件的
 *   括号栈（见 `collectLinePairs`）记下「这一层括号属于哪个敏感键」，紧邻的子键值对 / 数组里的
 *   字符串字面量继承该敏感度，括号闭合即失效。
 *
 * 正则写法上的三个取舍（都是真实执行实测出来的，见 tests/team-library-secret-scan-perf.test.ts / -forms.test.ts）：
 * - **引号串用「展开的循环」** `"[^"\\]*(?:\\.[^"\\]*)*"?`，不用 `"(?:[^"\\]|\\.)*"?`：二者匹配的串完全一样，
 *   但后者每个字符迭代一次、每次往 V8 回溯栈压一项，单个字符串值到 ~10MB 就抛 `RangeError: Maximum call stack
 *   size exceeded`（异常一路冒出推送流程、force 也救不了）；展开后每个**转义序列**才迭代一次。
 * - **`{{ … }}` 内容限 512 字符**：`[^}]*` 无上界时，`a:{{ a:{{ …` 这种全行没有 `}` 的输入每个键起点都向后扫到行尾，
 *   二次方（16 万字符 7.5 秒）。真实模板插值远短于 512；更长的不再整体当模板，落到兜底分支按普通值判。
 * - **无引号取值遇到「`&` / `?` + 键名 + `=`」就停**（URL 查询串 / 表单体 / JDBC URL：`?user=root&password=x`）：
 *   以前兜底分支 `[^\s,;}]*` 不拦 `&`，`user` 的值被吃成 `root&password=x`，后面的 `password` 整个漏报。
 *   只在 `&` 后面确实跟着「键名 + `=`」时才切开：`password=12&abc`（`&` 后不是键值对）仍是一个整体取值，
 *   不会被拆成「`12` → 两位纯数字 → 被当开关豁免」而放过真实口令（见 -literal.test.ts 头注释里的顾虑）。
 *   `?` 同理（F2-03）：`https://x/p?token=…` 里 `https:` 的值会被吃成 `//x/p?token=…`，**首个**查询参数整个漏报
 *   （`&` 之后的参数早就能报）。`?` 与 `&` 一样只在后面跟「键名 + `=`」时才切，`password=12?abc` 仍是整体取值。
 *   起始段与每一段的字符类都排除 `&` / `?`、每次循环必须由 `&` / `?` 起头，所以分段唯一、整体线性（见 -embedded.test.ts 的 perf 用例）。
 */
const KEY_VALUE_PAIR_RE =
  /(?<![A-Za-z0-9_.-])(["'`]?)([A-Za-z_][A-Za-z0-9_.-]*)\1\s*(=>|:=|[:=])(?!=)\s*("[^"\\]*(?:\\.[^"\\]*)*"?|'[^'\\]*(?:\\.[^'\\]*)*'?|`[^`]*`?|\$?\{\{[^}]{0,512}\}\}|\{(?=\s*["'`]?[A-Za-z_][A-Za-z0-9_.-]*["'`]?\s*(?:=>|:=|[:=]))|\[(?=\s*[{[])|[^\s,;}&?]*(?:[&?](?![A-Za-z_][A-Za-z0-9_.-]*=)[^\s,;}&?]*)*)/g;

/**
 * 去掉尾部连续的 ASCII 数字（语义等同 `w.replace(/\d+$/, "")`）。
 * 为什么不用那条正则：无锚点起点的 `\d+$` 对「长数字串 + 末尾字母」（`a111…1b`）每个数字起点都吃到数字串尾、
 * 再因 `$` 失败回退，是二次方——键名正则允许任意长标识符，8 万字符的键名实测要 9 秒（事件循环整段被卡死）。
 * 从尾往前数一遍就是线性的。
 */
const stripTrailingDigits = (w: string): string => {
  let end = w.length;
  while (end > 0) {
    const c = w.charCodeAt(end - 1);
    if (c < 48 || c > 57) break;
    end--;
  }
  return end === w.length ? w : w.slice(0, end);
};

/**
 * 键名拆词：camelCase / PascalCase / snake / kebab / 大写下划线 / 点路径 / 缩写（APIKey）都拆成小写词
 *
 * 大写缩写拆分写成 `([A-Z])(?=[A-Z][a-z])`（在「大写后面紧跟 大写+小写」处补空格），而不是
 * `([A-Z]+)([A-Z][a-z])`：后者对一长串大写字母（`AAAA…=x`）每个起点都吃到串尾再逐个回退，是二次方
 *（16 万字符 38 秒）。两种写法切出来的位置一致（`APIKey` → `API Key`、`ABCDe` → `ABC De`），前瞻版是线性的。
 */
export const splitKeyWords = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    // 去尾部序号（token2 / password1）与复数（tokens / secrets / credentials）
    .map((w) => stripTrailingDigits(w.toLowerCase()).replace(/(?<=[^s]{2})s$/, ""))
    .filter(Boolean);

/** 单词即强敏感（整词匹配，tokenizer / author / secretary 不会命中） */
const STRONG_KEY_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "apikey",
]);
/** 弱敏感：auth / authorization / credential——值必须像真口令才报（`auth: basic` 不报） */
const WEAK_KEY_WORDS: ReadonlySet<string> = new Set([
  "auth",
  "authorization",
  "credential",
]);
/** `<前缀>_key` 组合：api_key / private_key / access_key … */
const KEY_PREFIX_WORDS: ReadonlySet<string> = new Set([
  "api",
  "private",
  "access",
  "signing",
  "encryption",
  "master",
]);
/** 键名以这些词收尾 = 指向路径 / 名称 / 配置项而非密文本身（`token_file` / `passwordUrl`） */
const BENIGN_KEY_SUFFIX_WORDS: ReadonlySet<string> = new Set([
  "path",
  "file",
  "filename",
  "dir",
  "url",
  "uri",
  "name",
  "type",
  "count",
  "length",
  "size",
  "format",
  "header",
  "env",
  "var",
  "label",
  "field",
  "endpoint",
  "ttl",
  "expires",
  "expiry",
  "timeout",
  "limit",
  "mode",
  "enabled",
  "required",
  "prefix",
]);

type KeySensitivity = "strong" | "token" | "weak" | null;

/**
 * 键名敏感度（按词判断，不是子串）：
 * - strong：password / passwd / pwd / secret / apikey / api_key / private_key / access_key … 任一
 * - token：只有 token 词（`max_tokens: 4096` 这类计数配置会被后续豁免）
 * - weak：auth / authorization / credential（值要像口令才报）
 */
export const classifyCredentialKey = (key: string): KeySensitivity => {
  const words = splitKeyWords(key);
  if (words.length === 0) return null;
  if (words.length > 1 && BENIGN_KEY_SUFFIX_WORDS.has(words[words.length - 1]!)) {
    return null;
  }
  let hasToken = false;
  let hasWeak = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (STRONG_KEY_WORDS.has(w)) return "strong";
    if (w === "key" && i > 0 && KEY_PREFIX_WORDS.has(words[i - 1]!)) {
      return "strong";
    }
    if (w === "token") hasToken = true;
    if (WEAK_KEY_WORDS.has(w)) hasWeak = true;
  }
  if (hasToken) return "token";
  return hasWeak ? "weak" : null;
};

/**
 * token 类键名对应纯数字 / 布尔值多半是计数配置（`max_tokens: 4096`、`maxTokens=12`、`tokens: true`），
 * 不是密文。password / secret / api_key 类不豁免（`password=12345678` 仍是口令）。
 *
 * 数字允许 `_` 分组（`maxTokens: 8_192`、`128_000`）：TS / Python / Rust 的数字字面量都能这么写，
 * LLM 配置里很常见；只认「数字 + (`_`数字)*」——`_` 不能开头 / 结尾 / 连续，夹进字母（`8_192abcd`）更不算，
 * 这样不会把形如 `_8192abcd` 的真实取值放过。
 */
const isNonSecretTokenConfig = (
  sensitivity: KeySensitivity,
  value: string,
): boolean =>
  sensitivity === "token" &&
  /^(?:\d+(?:_\d+)*(?:\.\d+)?|true|false)$/i.test(value.replace(/^['"`]|['"`]$/g, ""));

/** 弱敏感键（auth / credential）：值至少 8 位、同时含字母和数字、无空白才像口令 */
const looksLikeWeakKeySecret = (value: string): boolean => {
  const v = value.replace(/^['"`]|['"`]$/g, "");
  return v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v) && !/\s/.test(v);
};

/**
 * 结构性取值不是密文：JSON 嵌套 `"secrets": {` / `"tokens": [`，或 schema / 类型标注里的
 * `"password": "string"`、`token: string;`。键名放宽收尾引号后 JSON 行会大量走到这里。
 */
const isStructuralValue = (value: string): boolean => {
  const v = value.replace(/^['"`]|['"`]$/g, "").trim();
  if (/^[{[(]+[}\])]*$/.test(v)) return true;
  return /^(?:string|number|boolean|integer|object|array|any|unknown)$/i.test(v);
};

/**
 * 开关 / 空值字面量：true/false 与 YAML 的 yes/no/on/off、各语言的 null/nil/undefined，
 * 外加两种「同语义的另一种写法」：YAML 的 `~`（null）、压缩 JS 的 `!0` / `!1`（true / false）——
 * 压缩产物和 YAML 里 `requirePassword: ~` / `requirePassword:!1` 与 `false` 是同一类开关，不补会照样误报。
 * 只认整体相等：`~/.secrets`、`!1nvalid` 这类以它们开头的真实取值不受影响。
 */
const NON_SECRET_LITERAL_RE =
  /^(?:true|false|yes|no|on|off|null|nil|undefined|~|!{1,2}[01])$/i;

/**
 * 去掉尾部连续的 `)` / `]`（语义等同 `v.replace(/[)\]]+$/, "")`）。
 * 为什么不用那条正则：无锚点起点的 `X+$` 对「长右括号串 + 末尾别的字符」（`password: )))…)x`）
 * 每个起点都吃到串尾再因 `$` 失败回退，是二次方（16 万字符实测 42 秒）；从尾往前数一遍是线性的。
 */
const stripTrailingClosers = (v: string): string => {
  let end = v.length;
  while (end > 0) {
    const c = v.charCodeAt(end - 1);
    if (c !== 41 /* ) */ && c !== 93 /* ] */) break;
    end--;
  }
  return end === v.length ? v : v.slice(0, end);
};

/**
 * 开关 / 空值型取值不是密文（M2-10）。
 * 为什么要单独一条：`isNonSecretTokenConfig` 的「数字 / 布尔」豁免刻意只给 token 类键名
 * （`password=12345678` 必须仍是口令），于是 `requirePassword: false` 这类「键名含 password、
 * 值是开关」的写法（YAML 无引号 / JSON / 带引号 "false"）全被当成口令 `fal***` 误报。
 * 这里只做**整体相等**判断（去引号 / 空白后）：`false123`、`truePassw0rd`、`yesterday99`
 * 这类「以布尔词开头但不是布尔」的真实口令不受影响。
 * 「纯数字开关」只认 1~2 位（0/1 开关、个位数计数）：3 位以上的纯数字仍可能是 PIN / 弱口令，照报。
 */
const isNonSecretLiteralValue = (value: string): boolean => {
  const quoted = /^["'`]/.test(value);
  let v = value.replace(/^['"`]|['"`]$/g, "").trim();
  // 无引号取值是「到空白 / , ; } 为止」，会带上调用语法的右括号：`login(requirePassword=False)` 的值是 `False)`
  if (!quoted) v = stripTrailingClosers(v);
  return v === "" || NON_SECRET_LITERAL_RE.test(v) || /^\d{1,2}$/.test(v);
};

type SensitiveLevel = Exclude<KeySensitivity, null>;

/** 一层括号从父键继承来的敏感度（`parentKey` 用来在 snippet 里写成 `父键.子键=`） */
type InheritedSensitivity = {
  sensitivity: SensitiveLevel;
  parentKey: string;
};

/**
 * 子键名本身是元数据（路径 / 名称 / 开关 / 身份 / 说明）时不继承父键的敏感度：
 * 基础集合复用「键名以这些词收尾 = 不是密文本身」的 `BENIGN_KEY_SUFFIX_WORDS`，
 * 但那条规则只对多词键名生效（`token_file`），继承场景里 `{"password":{"file":…}}` 的子键常常是单词，
 * 所以这里单词也判；再补身份 / 说明类（`username`、`description` …）。
 * 刻意**不**含 `value` / `data` / `key` / `secret` / `content` 这些「密文本体」常用名。
 * 注意比较的是 `splitKeyWords` 归一后的词形（去复数 `s`、去尾序号）。
 */
const INHERIT_EXEMPT_KEY_WORDS: ReadonlySet<string> = new Set([
  "user",
  "username",
  "login",
  "email",
  "id",
  "host",
  "hostname",
  "port",
  "region",
  "version",
  "scope",
  "algorithm",
  "kind",
  "description",
  "note",
  "comment",
  "hint",
  "policy",
  "provider",
  "scheme",
  "realm",
  "issuer",
  "audience",
  "title",
  "message",
]);

const lastKeyWord = (key: string): string => {
  const words = splitKeyWords(key);
  return words[words.length - 1] ?? "";
};

const isInheritExemptKey = (key: string): boolean => {
  const last = lastKeyWord(key);
  return BENIGN_KEY_SUFFIX_WORDS.has(last) || INHERIT_EXEMPT_KEY_WORDS.has(last);
};

/**
 * 继承只给「语义上像凭据本体」的子键（H4-03）：键名最后一个词（`splitKeyWords` 归一后）在这个白名单里才继承父键的敏感度。
 * 为什么不能只靠上面的「元数据黑名单」：`secrets:` 换行 `backend: "aws-secrets-manager"`（YAML 缩进继承，括号版同理）
 * 的子键 `backend` 不在黑名单里，strong 父键 + 引号值 ≥ 6 位无空白就被当口令；类似的配置性子键
 * （backend / engine / driver / store / source / method / mechanism / manager …）取值都是产品名 / 引擎名，名单补不完，所以改成白名单。
 * 白名单取「密文本体」常用名：value / data / content（k8s `stringData`）/ key（`ssh_key`）/ pass · pw · pwd · passwd（`db_pass`、`cache_pw`）/
 * cred · credential / auth / bearer · jwt / plaintext 等；取末词是因为英文复合名的核心名词在最后（`db_pass`、`encrypted_data`，
 * 而 `secret_manager` / `key_name` / `token_file` 的末词是 manager / name / file，不是密文）。
 * 子键自己敏感（`password:` / `client_secret:` …）不走继承、照旧直接命中；元数据黑名单仍先挡一道，将来扩白名单也不会退化。
 * 取舍：「名字 → 密文」映射（`secrets:` 下 `smtp: <口令>`）的子键名不是凭据词，不再靠继承命中（见 tests/team-library-secret-scan-inherit-keys.test.ts 的「已知残留」）。
 * 只管子键名；数组字面量继承（`"secrets": ["…"]` → `secrets[]`）没有子键名，不受影响。
 */
const INHERIT_CREDENTIAL_CHILD_WORDS: ReadonlySet<string> = new Set([
  "value",
  "data",
  "content",
  "key",
  "secret",
  "token",
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "pass",
  "pw",
  "credential",
  "cred",
  "auth",
  "apikey",
  "bearer",
  "jwt",
  "plaintext",
]);

const isInheritableChildKey = (key: string): boolean =>
  !isInheritExemptKey(key) && INHERIT_CREDENTIAL_CHILD_WORDS.has(lastKeyWord(key));

/** 引用型键名（`secretRef` / `secretKeyRef`）：值是「指向密文的名字」，子对象是 name / key 引用，不是密文 */
const isReferenceKey = (key: string): boolean => {
  const last = lastKeyWord(key);
  return last === "ref" || last === "reference";
};

/** 键名作为父键能给子值带来的敏感度；自己不敏感 / 是引用型 → 不继承 */
const inheritanceOfKey = (
  key: string,
  own: KeySensitivity,
): InheritedSensitivity | null =>
  own && !isReferenceKey(key) ? { sensitivity: own, parentKey: key } : null;

/**
 * 这个「键 + 裸开括号」匹配能不能当继承的父键。引号键（JSON / py dict / PHP 数组）一律可以；
 * 无引号键有两类代码写法会把括号误当成「敏感键的值」，实测（仓库自扫）都出过误报：
 * - 操作符是 `=>` 的无引号键：TS / JS 箭头函数 `(…): UseApiKeyInfoResult => {` 的返回类型名含 api / key，
 *   整个函数体都被当成它的子值；PHP / Ruby 的 `'k' => [` 键都带引号，不受影响；
 * - PascalCase 无引号键（`type ApiKeyInfo = {`、`class SecretStore {`）：类型 / 类 / 组件名，
 *   花括号里是成员声明不是密文。camelCase / snake / 全大写的无引号键照常继承。
 */
const canInheritFrom = (m: RegExpMatchArray): boolean =>
  m[1] !== "" || (m[3] !== "=>" && !/^[A-Z][a-z]/.test(m[2]!));

/**
 * 继承来的子值额外要像口令才报（子键名本身不敏感，只凭「父键敏感」，证据弱于直接命中）：
 * - 太短（< 6）/ 带空白（说明文字）/ 无引号的纯数字（计数、版本、限额）不报；
 * - 无引号的值只可能是 YAML / env 写法、变量名或代码表达式，要求「≥8 位、字母 + 数字」
 *   且不含括号 / 尖括号（`content: fullCode.slice(0, 260)`、`value: secretValue` 这类表达式 / 标识符不报）；
 * - token 类 / weak 类父键的引号值也要「字母 + 数字」，并排除 `#` 开头：
 *   `"tokens": {"primary": "#1890ff"}` 这类设计 token（颜色 / 尺寸）满地都是，不能当令牌。
 *   password / secret / api_key 类（strong）父键的引号值不加这条，`{"password":{"value":"纯字母口令"}}` 仍命中。
 */
const looksLikeInheritedSecret = (
  sensitivity: SensitiveLevel,
  value: string,
): boolean => {
  const quoted = /^["'`]/.test(value);
  const v = value.replace(/^['"`]|['"`]$/g, "");
  if (v.length < 6 || /\s/.test(v)) return false;
  if (!quoted && /^\d+(?:\.\d+)?$/.test(v)) return false;
  if (!quoted && /[()<>[\]{}]/.test(v)) return false;
  if ((!quoted || sensitivity !== "strong") && !looksLikeWeakKeySecret(value)) {
    return false;
  }
  return sensitivity === "strong" || !v.startsWith("#");
};

/**
 * 一个键值对 / 数组字面量候选：已判定「有敏感度」（自己敏感或继承），还没过值过滤。
 * `label` 就是 snippet 前缀（`password=` / `password.value=` / `passwords[]=`）。
 */
type SensitivePair = {
  label: string;
  sensitivity: SensitiveLevel;
  rawValue: string;
  viaInherit: boolean;
};

/**
 * 去掉无引号取值尾部连续的包裹字符 `" ' ` ) ]`（线性：从尾往前数一遍，理由同 `stripTrailingClosers`，不用 `X+$` 正则）。
 * 为什么：无引号取值的字符类只排除空白 / `,;}&?`，会把包住 URL 的**闭合引号 / 右括号**一起吞进值里——
 * `curl "https://x/p?api_key=$API_KEY"` 的值是 `$API_KEY"`，`[文档](https://x/p?token=$TOKEN)` 的值是 `$TOKEN)`。
 * `isPlaceholderSecretValue` 只剥成对引号，认不出落单的包裹字符，示例 URL 里的占位符就成了误报
 * （F2-03 让 `?` 切段之后，URL 首个查询参数也走到这条路径，误报面随之变大）。
 * 只给占位符判断用：真正的口令仍按原值判断与脱敏，不会因为尾部带引号 / 括号而被放过。
 */
const stripTrailingWrappers = (v: string): string => {
  let end = v.length;
  while (end > 0) {
    const c = v.charCodeAt(end - 1);
    if (c !== 34 /* " */ && c !== 39 /* ' */ && c !== 96 /* ` */ && c !== 41 /* ) */ && c !== 93 /* ] */) break;
    end--;
  }
  return end === v.length ? v : v.slice(0, end);
};

/**
 * 值过滤（占位符 / 环境变量引用 / 模板插值 / 结构值 / 开关 / token 计数 / weak 不像口令 /
 * 继承值不像口令）：通过返回去引号后的明文片段（调用方只拿去脱敏），被过滤返回 null。
 * 自己敏感的键与继承来的子值走同一套，继承值只是再加最后一条。
 */
const secretPartOf = (pair: SensitivePair): string | null => {
  const raw = pair.rawValue;
  // 引号串去引号；无引号值去尾部 , ;
  const quoted = /^["'`]/.test(raw);
  const value = quoted ? raw : raw.replace(/[,;]+$/, "");
  if (
    isPlaceholderSecretValue(quoted ? value : stripTrailingWrappers(value)) ||
    isStructuralValue(value) ||
    isNonSecretLiteralValue(value) ||
    isNonSecretTokenConfig(pair.sensitivity, value) ||
    (pair.sensitivity === "weak" && !looksLikeWeakKeySecret(value)) ||
    (pair.viaInherit && !looksLikeInheritedSecret(pair.sensitivity, value))
  ) {
    return null;
  }
  return value.replace(/^['"`]|['"`]$/g, "");
};

/**
 * 括号栈的一帧。只记 `{` / `[`：`(` 不参与（函数调用的括号里没有结构继承语义）。
 * `inherit` 非空 = 这层括号是某个敏感键的值，紧邻的子值继承它。
 */
type BracketFrame = { open: "{" | "["; inherit: InheritedSensitivity | null };

/** 按文件的括号跟踪状态（跨行延续；每个文件新建一份，文件之间互不影响） */
type BracketState = {
  stack: BracketFrame[];
  /** 上一个「非空白、非字符串内部」的字符（跨行延续）：判断字符串是不是数组的元素位置（`[` / `,` 之后） */
  prevSig: string;
  /** 括号过深（多半是非结构化文本里的乱括号）后放弃跟踪，只保留无继承的逐对扫描 */
  disabled: boolean;
  /** YAML 缩进父子关系的栈（括号栈为空时才维护，见 `trackYamlIndent`） */
  yaml: YamlFrame[];
};

/** 括号栈上限：真实配置嵌套远小于此；超过视为非结构化文本，停止跟踪避免无界增长 */
const MAX_BRACKET_DEPTH = 64;

const createBracketState = (): BracketState => ({
  stack: [],
  prevSig: "",
  disabled: false,
  yaml: [],
});

/** YAML 缩进栈的一帧：`indent` 是父键行里「键」起点的列（列表项 `- ` 算进去），`inherit` 同括号帧 */
type YamlFrame = { indent: number; inherit: InheritedSensitivity | null };

/**
 * 「只有键、没有值」的行 = YAML 父键行：`password:` / `"password": # 生产库`。
 * 键必须在行首（调用方先剥掉缩进与 `- `）：`case SECRET:`、`class Secrets:`、`x ? a : b` 这类行里的冒号不算；
 * 行尾带值（含 `|` / `>` / `&anchor`）的不是父键。`^` 锚定、键名字符类之后只回退一次，整体线性。
 */
const YAML_PARENT_KEY_RE = /^(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1[ \t]*:[ \t]*(?:#.*)?$/;

/**
 * YAML 缩进继承（F2-03）：与括号栈同一语义，只是父子关系由缩进表达——
 * `password:` 换行 `  value: …` 里 `value` 自己不敏感，要像 `{"password":{"value":"…"}}` 一样继承父键的敏感度。
 * 维护规则（逐行调用一次，注释 / 空行由调用方跳过、不动栈）：
 * - 先弹出缩进 ≥ 本行键缩进的帧（同级兄弟 / 回退到上层），栈顶就是本行的直接父键；
 * - 本行若是父键行（见 `YAML_PARENT_KEY_RE`）再压一帧，**不敏感的父键也压**（inherit = null）：
 *   这样 `secrets:` → `meta:` → `owner:` 的孙子层看到的栈顶是 `meta`、不继承，与括号版「只继承紧邻下一层」同口径；
 * - 返回的 `inherit` 只给「行首的那个键」用（`keyStart` 就是它的列）：一行里后面的 `k: v` 多半是值里的文字；
 * - tab 缩进不是合法 YAML（多半是 Makefile / Go / 带 tab 的代码）：不参与，并清掉残留帧，免得下一行误继承；
 * - 栈深封顶同括号栈，超过就清空（失去继承、不报错）。
 * 复杂度：每行弹栈摊还 O(1)、一次锚定正则，整文件线性。
 */
const trackYamlIndent = (
  line: string,
  st: BracketState,
): { inherit: InheritedSensitivity | null; keyStart: number } | null => {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  if (line.charCodeAt(i) === 9) {
    st.yaml.length = 0;
    return null;
  }
  let keyStart = i;
  if (line.charCodeAt(i) === 45 /* - */ && line.charCodeAt(i + 1) === 32) {
    keyStart = i + 2;
    while (line.charCodeAt(keyStart) === 32) keyStart++;
  }
  while (st.yaml.length > 0 && st.yaml[st.yaml.length - 1]!.indent >= keyStart) st.yaml.pop();
  const inherit = st.yaml[st.yaml.length - 1]?.inherit ?? null;
  const m = YAML_PARENT_KEY_RE.exec(keyStart === 0 ? line : line.slice(keyStart));
  if (m) {
    const key = m[2]!;
    st.yaml.push({ indent: keyStart, inherit: inheritanceOfKey(key, classifyCredentialKey(key)) });
    if (st.yaml.length > MAX_BRACKET_DEPTH) st.yaml.length = 0;
  }
  return { inherit, keyStart };
};

/** 整体被吞的引号载荷最多下钻几层：外层引号串 → 里面的 JSON 字段（再是一层转义串）→ 再下一层；更深的不追，防止放大 */
const MAX_EMBEDDED_DEPTH = 2;

/**
 * 引号串去掉两端引号并还原一层转义（只还原 `\"` / `\'` / `\\`，其余转义原样留着，对键名 / 值的判断没有影响）。
 * 末尾那个引号要确认是闭合引号：`"abc\"`（未闭合，容忍）末尾的 `"` 是被转义的，不能剥。
 */
const unwrapQuoted = (raw: string): string => {
  const q = raw[0]!;
  let end = raw.length;
  if (end > 1 && raw[end - 1] === q) {
    let backslashes = 0;
    for (let j = end - 2; j > 0 && raw[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) end--;
  }
  return raw.slice(1, end).replace(/\\(["'\\])/g, "$1");
};

/**
 * 引号串里装的是不是「结构化载荷」：JSON 对象（`{` 后紧跟键）/ 嵌套数组 / 带查询参数的 URL。
 * 只有这三种才下钻——普通说明文字里的 `token: x` 仍按「字符串里的 `a: b` 不当键」处理（防误报，见 KEY_VALUE_PAIR_RE 注释）。
 * 带 `^` 锚的判断只看开头；URL 的查询参数判断无锚点，但起点只可能是 `?` / `&`、键名字符类不含它们，各起点互不重叠，线性。
 */
const looksLikeEmbeddedPayload = (s: string): boolean => {
  const t = s.trimStart();
  if (t.startsWith("{")) return /^\{\s*["'`]?[A-Za-z_]/.test(t);
  if (t.startsWith("[")) return /^\[\s*[{[]/.test(t);
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(t) && /[?&][A-Za-z_][A-Za-z0-9_.-]*=/.test(t);
};

/**
 * 一行里的「有敏感度的键值对 / 数组字符串字面量」（按出现顺序），并维护跨行的括号栈。
 *
 * 为什么要自己走一遍字符而不是只靠 `KEY_VALUE_PAIR_RE`：继承需要知道「当前处在哪层括号里」，
 * 多行 JSON（`"password": {` 换行 `"value": "…"`）还要跨行记住外层键。做法是单趟字符扫描：
 * - 字符串（`"` / `'`）里的括号与转义引号（`\"`）不算结构；字符串状态按行重置（JSON 字符串不跨行，
 *   也避免行内一个落单的引号把整个文件的括号全吞掉）。`'` 前面紧挨字母 / 数字的是英文撇号
 *   （`don't`），不当字符串起点；反引号不当字符串（markdown 行内代码里的 JSON 也要能跟踪）。
 * - 正则匹配（独立于扫描、按 index 升序且不重叠）在扫描走到它的起点时，读当时的栈顶继承；
 *   值恰好是裸开括号（`"password": {` / `"secrets": [`，含行尾落单的括号）时，登记该括号位置
 *   要继承的敏感度，扫描走到那个括号时压栈。
 * - 继承只给「紧邻的下一层」：对象帧只继承自己的父键；数组帧对继承透明（`[ {…} ]` / `[[…]]`
 *   的元素算紧邻子值）；孙子层不继承——`"secrets": {"meta": {"owner": …}}` 这类敏感词键名下挂大对象的
 *   写法不会因此误报爆炸（孙子键自己敏感仍照常命中）。
 * - 闭括号在栈里从顶往下找最近的同类开括号并整段弹出（错配时自愈）；找不到的孤立闭括号忽略。
 * - YAML 缩进继承（F2-03）：括号栈为空的行额外走 `trackYamlIndent`，把「`password:` 换行缩进的子键」也当紧邻子值；
 *   只给行首的键、括号里的行不参与（括号内缩进只是排版）。
 * - 整体被吞的引号载荷（F2-04）：外层键的引号串值是 JSON / 带查询参数的 URL 时，还原转义后下钻再扫一遍
 *   （`payload: "{\"password\":\"…\"}"`），内部用全新的括号状态；最多 `MAX_EMBEDDED_DEPTH` 层，每层的串是上一层的子串，
 *   所以总开销是行长的常数倍。
 * 复杂度：每个字符常数次操作、每个括号最多入栈 / 出栈一次，整文件线性；深度封顶 `MAX_BRACKET_DEPTH`。
 */
const collectLinePairs = (line: string, st: BracketState, depth = 0): SensitivePair[] => {
  const out: SensitivePair[] = [];
  const matches = [...line.matchAll(KEY_VALUE_PAIR_RE)];
  const yamlLine =
    depth === 0 && st.stack.length === 0 && !st.disabled ? trackYamlIndent(line, st) : null;
  const owns = matches.map((m) => classifyCredentialKey(m[2]!));
  // 值是裸开括号的位置 → 该括号帧要继承的敏感度（null = 普通括号）
  let openers: Map<number, InheritedSensitivity | null> | null = null;
  for (let k = 0; k < matches.length; k++) {
    const m = matches[k]!;
    const v = m[4]!;
    if (v !== "{" && v !== "[") continue;
    (openers ??= new Map()).set(
      m.index! + m[0].length - v.length,
      canInheritFrom(m) ? inheritanceOfKey(m[2]!, owns[k]!) : null,
    );
  }

  const top = (): BracketFrame | undefined => st.stack[st.stack.length - 1];
  const emitMatch = (k: number, inherited: InheritedSensitivity | null): void => {
    const m = matches[k]!;
    const key = m[2]!;
    const rawValue = m[4]!.trim();
    if (!rawValue) return;
    const own = owns[k]!;
    if (own) {
      out.push({ label: `${key}=`, sensitivity: own, rawValue, viaInherit: false });
    } else if (inherited && isInheritableChildKey(key)) {
      out.push({
        label: `${inherited.parentKey}.${key}=`,
        sensitivity: inherited.sensitivity,
        rawValue,
        viaInherit: true,
      });
    }
    // 整体被吞的引号载荷：外层键不管敏不敏感，里面的结构化内容都要再看一遍（用循环 push：命中很多时展开参数会爆栈）
    if (depth < MAX_EMBEDDED_DEPTH && (rawValue[0] === '"' || rawValue[0] === "'")) {
      const inner = unwrapQuoted(rawValue);
      if (looksLikeEmbeddedPayload(inner)) {
        for (const p of collectLinePairs(inner, createBracketState(), depth + 1)) out.push(p);
      }
    }
  };
  /** 本匹配可继承的敏感度：括号栈顶优先；括号栈为空时，行首的那个键用 YAML 缩进父键 */
  const inheritFor = (k: number): InheritedSensitivity | null =>
    top()?.inherit ??
    (yamlLine !== null && matches[k]!.index === yamlLine.keyStart ? yamlLine.inherit : null);

  let mi = 0;
  let quote = "";
  /** 处在 `'{…}'` 这类单引号包裹的 JSON 片段里（见下面 `'` 分支） */
  let wrapped = false;
  /** 当前字符串若是「继承数组里的元素字面量」，记它的起点；否则 -1 */
  let literalFrom = -1;
  for (let i = 0; i < line.length && !st.disabled; i++) {
    while (mi < matches.length && matches[mi]!.index! <= i) {
      // 匹配起点落在字符串内部（正文里的 `a: b`）时不继承，只按自己的键名判
      emitMatch(mi, quote ? null : inheritFor(mi));
      mi++;
    }
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") {
        i++; // 转义：下一个字符（可能是引号 / 括号）不参与结构判断
      } else if (ch === quote) {
        if (literalFrom >= 0) {
          const inh = top()?.inherit;
          if (inh) {
            out.push({
              label: `${inh.parentKey}[]=`,
              sensitivity: inh.sensitivity,
              rawValue: line.slice(literalFrom, i + 1),
              viaInherit: true,
            });
          }
          literalFrom = -1;
        }
        quote = "";
        st.prevSig = ch;
      }
      continue;
    }
    if (ch === " " || ch === "\t") continue;
    if (ch === "'") {
      if (wrapped) {
        // 收尾的包裹引号
        wrapped = false;
        st.prevSig = ch;
        continue;
      }
      // 英文撇号（don't）不是字符串起点
      if (/[A-Za-z0-9]/.test(line[i - 1] ?? "")) continue;
      // `'{…}'` / `'[…]'`：shell `curl -d '{"password":{…}}'`、JS 里的 JSON 字符串。引号只是包裹，
      // 里面是 JSON 结构（自带 `"` 字符串）——当字符串吞掉会让整段嵌套结构的继承失效
      if (line[i + 1] === "{" || line[i + 1] === "[") {
        wrapped = true;
        st.prevSig = ch;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      const t = top();
      if (t?.open === "[" && t.inherit && (st.prevSig === "[" || st.prevSig === ",")) {
        literalFrom = i;
      }
      continue;
    }
    if (ch === "{" || ch === "[") {
      const parent = top();
      const declared = openers?.get(i);
      const inherit =
        declared !== undefined
          ? declared
          : parent?.open === "["
            ? parent.inherit
            : null;
      st.stack.push({ open: ch, inherit });
      if (st.stack.length > MAX_BRACKET_DEPTH) {
        st.disabled = true;
        st.stack.length = 0;
      }
    } else if (ch === "}" || ch === "]") {
      const want = ch === "}" ? "{" : "[";
      let k = st.stack.length - 1;
      while (k >= 0 && st.stack[k]!.open !== want) k--;
      if (k >= 0) st.stack.length = k;
    }
    st.prevSig = ch;
  }
  // 扫描提前结束（括号过深放弃跟踪）或匹配在行尾之后无字符可触发：剩下的按「无继承」补发
  while (mi < matches.length) {
    emitMatch(mi, null);
    mi++;
  }
  return out;
};

/**
 * 常见平台令牌的「值形态」（不依赖键名）：
 * OpenAI/Anthropic sk-、GitHub ghp_/gho_/ghu_/ghs_/ghr_/github_pat_、GitLab glpat-、
 * Slack xox*-、AWS AKIA…、HTTP `Bearer <token>`。
 * 前缀前不能紧挨字母数字（`task-xxx` 里的 `sk-` 不算）；sk- / glpat- / Bearer 另要求含数字且含字母，
 * 挡住 `sk-my-long-kebab-name` 这类 slug；gh*_ / xox / AKIA 前缀本身足够特异、只排占位符。
 *
 * 「至少 N 个」一律写成 `{N}X*` 而不是 `{N,}`：二者匹配的串完全一样，但带下界的计数量词整段按字符迭代、
 * 每次往 V8 回溯栈压一项，单个 token 到 ~8MB 就抛 `RangeError: Maximum call stack size exceeded`
 *（一路冒出推送流程、force 也救不了）；`{N}` 之后的 `X*` 是单字符类的贪婪循环，不占回溯栈。
 */
const KNOWN_TOKEN_RULES: ReadonlyArray<{
  label: string;
  re: RegExp;
  /** 需要同时含数字和字母才算（防 slug 误报） */
  needDigitAndLetter: boolean;
}> = [
  {
    label: "令牌(sk-) ",
    re: /(?<![A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*)/,
    needDigitAndLetter: true,
  },
  {
    label: "令牌(ghp_) ",
    re: /(?<![A-Za-z0-9_])(gh[pousr]_[A-Za-z0-9]{30}[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]{40}[A-Za-z0-9_]*)/,
    needDigitAndLetter: false,
  },
  {
    label: "令牌(glpat-) ",
    re: /(?<![A-Za-z0-9_-])(glpat-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*)/,
    needDigitAndLetter: true,
  },
  {
    label: "令牌(xox) ",
    re: /(?<![A-Za-z0-9_-])(xox[abeoprs]-[A-Za-z0-9-]{10}[A-Za-z0-9-]*)/,
    needDigitAndLetter: true,
  },
  {
    label: "令牌(AKIA) ",
    re: /(?<![A-Za-z0-9])((?:AKIA|ASIA)[0-9A-Z]{16})(?![A-Za-z0-9])/,
    needDigitAndLetter: false,
  },
  {
    label: "令牌(Bearer) ",
    re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20}[A-Za-z0-9._~+/=-]*)/i,
    needDigitAndLetter: true,
  },
];

/** 一行里命中的已知形态令牌（原值，调用方只拿去脱敏）；每条规则最多取首个 */
const findKnownTokens = (line: string): Array<{ label: string; value: string }> => {
  const out: Array<{ label: string; value: string }> = [];
  for (const rule of KNOWN_TOKEN_RULES) {
    const m = rule.re.exec(line);
    if (!m) continue;
    const value = m[1]!;
    if (isPlaceholderSecretValue(value)) continue;
    // 去掉前缀后全是 x / * / 点横线 = 文档里的占位示例（ghp_xxxxxxxx…）
    const body = value.replace(
      /^(?:github_pat_|gh[pousr]_|glpat-|xox[a-z]-|sk-|AKIA|ASIA|Bearer\s+)/i,
      "",
    );
    if (/^[xX*•._-]+$/.test(body)) continue;
    if (rule.needDigitAndLetter && !(/\d/.test(value) && /[A-Za-z]/.test(value))) {
      continue;
    }
    out.push({ label: rule.label, value });
  }
  return out;
};

/**
 * BEGIN PRIVATE KEY 块。类型名可以是多个词、可含数字，结尾可带 ` BLOCK`：
 * `RSA` / `EC` / `OPENSSH` / `ENCRYPTED` / `SSH2 ENCRYPTED` / `PGP … KEY BLOCK`（GPG 私钥导出就是这一种，
 * 以前只认「最多一个纯字母词 + 以 KEY 直接收尾」，`-----BEGIN PGP PRIVATE KEY BLOCK-----` 整段漏报）。
 */
const PRIVATE_KEY_RE = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----/;

/**
 * 带账号密码的连接串：`<scheme>://[user]:pass@host`。
 * scheme 不再枚举（以前只认 postgres / mysql / mongodb / redis / amqp / http(s)，`rediss://`（TLS Redis，
 * Upstash / ElastiCache 的标配写法）、`amqps://`、`sftp://`、`ssh://`、`smtp(s)://`、`mssql://`、`ldap://` 全漏报）；
 * 带 `user:pass@` 的 authority 本身就是凭据，与 scheme 无关。user 允许为空（`redis://:pass@host` 是 Redis 的标准写法）。
 * 左侧的负向后顾保证只从「标识符串起点」尝试：scheme 用的是 `[A-Za-z][A-Za-z0-9+.-]*` 这种宽字符类，
 * 不加它的话一长串字母（几 MB 的 base64 / 压缩代码）每个位置都吃到串尾再失败，是二次方。
 * `jdbc:postgresql://…` 的起点落在 `postgresql`（前一字符 `:` 不在后顾字符类里），`git+https://…` 的 scheme 含 `+`。
 */
const CONN_STRING_RE =
  /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/\s:@]*):([^/\s@]+)@/;

/** .pgpass：host:port:db:user:pass（host/port 可为 *） */
const PGPASS_RE = /^([^:\s]+):(\*|\d+):([^:]*):([^:]*):(.+)$/;

/**
 * `key = longvalue` / `key: longvalue` 里抽高熵值（`{20}X*` 而非 `{20,}`：理由见 KNOWN_TOKEN_RULES 注释）。
 *
 * 命中条件（tests/team-library-secret-scan-inherit-keys.test.ts 的 `L4-07` 组逐条实测）：某个 `:` / `=` 之后（容忍空白与一个引号）
 * **连续 ≥ 20 个字符都在 `[A-Za-z0-9+/=_.~-]` 里**；取到的值 = 这一段字符集内字符的最长连续串（遇到第一个字符集之外的字符就停），
 * 再交给 `looksHighEntropySecret`。所以不是「≥ 20 位就命中」：口令开头 20 位里出现 `!` `@` `#` `$` `%` `&` `*` 空格 … 就整条无命中
 * （23 位 `Zx9fQ2m!K7pLw1234AbCdEf` 无命中；20 位全在字符集内命中、19 位不命中）。口令内部若含 `=` / `:`，则从那个符号之后重新起算
 * （它之后连续 ≥ 20 个字符集内字符仍命中，命中的是那一段）。这是已知残余——含特殊符号的口令可能漏报。
 */
const HIGH_ENTROPY_ASSIGN_RE =
  /([:=])\s*['"]?([A-Za-z0-9+/=_\-.~]{20}[A-Za-z0-9+/=_\-.~]*)['"]?/;

const pushHit = (
  hits: SecretScanHit[],
  file: string,
  line: number,
  kind: SecretScanHit["kind"],
  label: string,
  secretPart: string,
): void => {
  hits.push({
    file,
    line,
    kind,
    snippet: `${label}${redactSecretValue(secretPart)}`,
  });
};

/**
 * 扫描待上传文本文件列表，返回命中清单（已脱敏）。
 * 二进制内容应在调用前剔除；此处再兜底跳过。
 */
export const scanSensitiveFiles = (
  files: readonly SecretScanFile[],
): SecretScanHit[] => {
  const hits: SecretScanHit[] = [];

  for (const file of files) {
    if (isProbablyBinaryText(file.content)) continue;
    const lines = file.content.split(/\r?\n/);
    // 括号栈按文件新建：一个文件里没闭合的 `password: {` 不能影响下一个文件
    const brackets = createBracketState();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
        // 注释行仍扫 PRIVATE KEY / 连接串（有人把密钥贴进注释）
        if (PRIVATE_KEY_RE.test(line)) {
          pushHit(hits, file.path, lineNo, "private-key", "PRIVATE KEY ", "BEGIN");
        }
        const connInComment = CONN_STRING_RE.exec(line);
        if (connInComment && !isPlaceholderSecretValue(connInComment[2]!)) {
          pushHit(
            hits,
            file.path,
            lineNo,
            "connection-string",
            "连接串口令 ",
            connInComment[2]!,
          );
        }
        // 注释里贴的平台令牌同样要拦（sk- / ghp_ / glpat- / Bearer …）
        for (const t of findKnownTokens(line)) {
          pushHit(hits, file.path, lineNo, "known-token", t.label, t.value);
        }
        continue;
      }

      // 1) PRIVATE KEY
      if (PRIVATE_KEY_RE.test(line)) {
        pushHit(hits, file.path, lineNo, "private-key", "PRIVATE KEY ", "BEGIN");
      }

      // 2) 连接串 user:pass@
      const conn = CONN_STRING_RE.exec(line);
      if (conn && !isPlaceholderSecretValue(conn[2]!)) {
        pushHit(
          hits,
          file.path,
          lineNo,
          "connection-string",
          "连接串口令 ",
          conn[2]!,
        );
      }

      // 3) .pgpass 五行冒号（整行）
      const pg = PGPASS_RE.exec(trimmed);
      if (pg && !isPlaceholderSecretValue(pg[5]!)) {
        // 排除明显非 pgpass 的 URL / 普通路径（要求 port 为数字或 *）
        pushHit(
          hits,
          file.path,
          lineNo,
          "pgpass",
          "pgpass 口令 ",
          pg[5]!,
        );
      }

      // 4) 敏感键名 = 非占位值（逐个键值对；一行多键 / camelCase 键名都认）
      //    含敏感键下挂对象 / 数组时子值继承敏感度（M2-01，括号栈跨行延续）
      //    「本行是否已有 credential-key / high-entropy 命中」用行内标志，不再对整个 hits 数组
      //    `some` 全扫——命中很多的大文件上那样是 O(行数 × 命中数) 的二次方
      let credentialHitOnLine = false;
      for (const pair of collectLinePairs(line, brackets)) {
        const secret = secretPartOf(pair);
        if (secret === null) continue;
        credentialHitOnLine = true;
        pushHit(hits, file.path, lineNo, "credential-key", pair.label, secret);
      }

      // 5) 高熵赋值（排除 hash/commit 语境）
      let entropyHitOnLine = false;
      const assign = HIGH_ENTROPY_ASSIGN_RE.exec(line);
      if (assign) {
        const left = line.slice(0, assign.index);
        const val = assign[2]!;
        if (!isHashContextKey(left) && looksHighEntropySecret(val)) {
          // 已被 credential-key 覆盖的同行不再重复报高熵
          if (!credentialHitOnLine) {
            entropyHitOnLine = true;
            pushHit(
              hits,
              file.path,
              lineNo,
              "high-entropy",
              "高熵值 ",
              val,
            );
          }
        }
      }

      // 6) 值形态命中平台令牌（sk- / ghp_ / glpat- / xox*- / AKIA / Bearer；不依赖键名）
      //    同行已被 credential-key / high-entropy 覆盖就不重复报
      if (!credentialHitOnLine && !entropyHitOnLine) {
        for (const t of findKnownTokens(line)) {
          pushHit(hits, file.path, lineNo, "known-token", t.label, t.value);
        }
      }
    }
  }

  return hits;
};

/**
 * 闸门：有命中且未 force → 阻断；force 或无命中 → 放行。
 * 纯函数，便于单测「强制上传」出口。
 */
export const gateSensitiveUpload = (
  hits: readonly SecretScanHit[],
  force: boolean,
): { blocked: false } | { blocked: true; hits: SecretScanHit[] } => {
  if (force || hits.length === 0) return { blocked: false };
  return { blocked: true, hits: [...hits] };
};

/** 一行提示（UI / API error 字段） */
export const formatSensitiveScanError = (hits: readonly SecretScanHit[]): string =>
  `发现 ${hits.length} 处疑似敏感信息，已阻断上传`;
