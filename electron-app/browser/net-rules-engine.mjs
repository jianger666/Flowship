/**
 * 增强包 E2 · A5 网络规则引擎（契约 §15.2 S3）——纯逻辑，无 electron / CDP 依赖，可直接单测。
 *
 * 分工：
 *  - 本文件：规则的校验 / 规整（pattern、头、mock、delay、fail 原因）、规则仓库（每 tab ≤20 条）、
 *    「一个 URL 命中哪些规则 → 怎么处理」的决策（{@link decideForRequest}）、
 *    以及 `Fetch.requestPaused` 的**恰好一次**处理器（{@link createPauseController}，CDP 通过 `send` 注入，所以能用假 CDP 驱动测试）；
 *  - `ops/net-rules.mjs`：把它们接到 tab / session（`Fetch.enable` 的开关、会话钩子重放、用户接管暂停、状态、活动日志、op 入口）。
 *
 * # pattern 语义
 * 匹配**整个 URL**（不含 #fragment），`*` = 任意个字符（含 `/` 与 `?`），其余字符按字面（`?` 不是通配符）。
 * 必须以 `http://` / `https://` 或 `*` 开头——别的写法（`example.com/api`、`/api/x`）永远匹配不上任何 URL，静默失效比报错更糟，所以直接拒绝并给出改法。
 * 不用正则：glob 转正则后 `*a*a*a*a*b` 对长 URL 是多项式级回溯，换成带「最后一个 * 回溯点」的迭代匹配（{@link globMatch}，O(|p|·|t|)，不依赖正则引擎）。
 *
 * # 红线（契约 §15.3）
 *  - Flowship 自身 origin（`isAppUrl`）永不拦截 / mock / 注入头——命中也只 `continueRequest`；
 *  - `set_headers` 的值只存在于规则对象里，{@link describeRule}（list / 活动日志 / 状态）一律只给头名；
 *  - 禁止改的头见 {@link FORBIDDEN_REQUEST_HEADERS}：除了 HTTP 层的帧 / 连接类头，还有 `Cookie`（改 Cookie 等于绕过 browserStorageAccess 开关去写登录态）；
 *    mock 的响应头是**白名单**（R6-32，见 {@link ALLOWED_RESPONSE_HEADERS}）：`Set-Cookie` / `Clear-Site-Data` 等任何不在名单里的头都被拒（mock 不能成为写 / 清 cookie 与存储的通道）。
 */

export class NetRuleError extends Error {}

export const MAX_RULES_PER_TAB = 20;
export const MAX_PATTERN_CHARS = 500;
export const MAX_MOCK_BODY_BYTES = 1024 * 1024;
export const MAX_DELAY_MS = 30_000;
export const MAX_RULE_HEADERS = 20;
export const MAX_HEADER_NAME_CHARS = 100;
export const MAX_HEADER_VALUE_CHARS = 2000;
/** 匹配时只看 URL 的前这么多字符：Chrome 允许 2MB 的 URL，不能让一个超长 URL 把主进程拖住 */
export const MAX_MATCH_URL_CHARS = 16_384;

/** 会新增规则的动作（`list` / `clear` 不是规则） */
export const RULE_KINDS = Object.freeze(["block", "set_headers", "mock", "fail", "delay"]);
export const RULE_ACTIONS = Object.freeze([...RULE_KINDS, "list", "clear"]);

/** `fail` 的失败原因：CDP `Network.ErrorReason` 的子集（去掉对页面行为没有区别、或容易误导的那几个） */
export const FAIL_REASONS = Object.freeze([
  "Failed",
  "Aborted",
  "TimedOut",
  "AccessDenied",
  "ConnectionClosed",
  "ConnectionReset",
  "ConnectionRefused",
  "ConnectionFailed",
  "NameNotResolved",
  "InternetDisconnected",
  "AddressUnreachable",
  "BlockedByClient",
]);

/**
 * 请求头禁改清单（小写）：
 *  · HTTP 帧 / 连接类：host / content-length / transfer-encoding / connection / keep-alive / upgrade / te / trailer / expect / proxy-connection
 *    ——改了会让请求变成非法报文或被代理 / 服务器拒收，页面行为不可预期；
 *  · 浏览器托管类：`proxy-*` / `sec-*`（规范里的 forbidden header name，页面脚本本来就不能设）；
 *  · cookie / cookie2：登录态写入有专门的闸门（browserStorageAccess），不能经 set_headers 绕过。
 * 刻意**允许**：Authorization（调试 API 时的常见需求，值在所有输出里脱敏）、Origin / Referer / User-Agent / Accept-*（CORS / 内容协商调试）。
 */
export const FORBIDDEN_REQUEST_HEADERS = Object.freeze(
  new Set(["host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "expect", "proxy-connection", "cookie", "cookie2"]),
);
const FORBIDDEN_REQUEST_PREFIXES = Object.freeze(["proxy-", "sec-"]);

/**
 * mock 响应头**白名单**（R6-32，小写）。以前是只禁 9 个头的黑名单：`Clear-Site-Data`（清目标站 cookie / 存储，绕过 storageAccess）、
 * `Strict-Transport-Security`（污染 HSTS 持久状态）、`Refresh` / `Link` / `Content-Security-Policy*` / `Service-Worker-Allowed` / `Content-Disposition` /
 * `Location` / `Alt-Svc` / `Accept-CH` / `Cross-Origin-*` 等全部放行，漏一个就是一条绕过。现在改成「只放行已知无副作用的」：
 *  · 缓存 / 内容协商：Cache-Control / ETag / Last-Modified / Expires / Vary / Content-Language；
 *  · CORS：`Access-Control-*`（前缀）；自定义调试头：`X-*`（前缀；`X-Content-Type-Options` 由 {@link buildFulfillParams} 对免审批类型强制 nosniff）；
 *  · `Content-Type`：只是 `buildRuleDef` 的入口（并入 contentType 后立刻从 headers 里剔除，见 buildRuleDef / buildFulfillParams 的两道剔除）。
 * 其余（含 Set-Cookie / Content-Length / Content-Encoding / Transfer-Encoding / Connection 这些原有禁项）一律拒绝，报错文案见 {@link normalizeRuleHeaders}。
 */
// 导出冻结数组而不是 Object.freeze(Set)：冻结 Set 对象并不能阻止 .add()，数组冻结后元素真的改不了；判定用模块私有的 Set
export const ALLOWED_RESPONSE_HEADERS = Object.freeze(["content-type", "cache-control", "etag", "last-modified", "expires", "vary", "content-language"]);
const ALLOWED_RESPONSE_HEADER_SET = new Set(ALLOWED_RESPONSE_HEADERS);
export const ALLOWED_RESPONSE_HEADER_PREFIXES = Object.freeze(["access-control-", "x-"]);

export const isForbiddenRequestHeader = (name) => {
  const n = String(name ?? "").trim().toLowerCase();
  return FORBIDDEN_REQUEST_HEADERS.has(n) || FORBIDDEN_REQUEST_PREFIXES.some((p) => n.startsWith(p));
};
export const isAllowedResponseHeader = (name) => {
  const n = String(name ?? "").trim().toLowerCase();
  return ALLOWED_RESPONSE_HEADER_SET.has(n) || ALLOWED_RESPONSE_HEADER_PREFIXES.some((p) => n.startsWith(p));
};
/** 保留旧函数名（语义 = 不在白名单里）：既有调用点 / 测试不用改 */
export const isForbiddenResponseHeader = (name) => !isAllowedResponseHeader(name);

// ───────────────────────── pattern ─────────────────────────

const PATTERN_HINT = "pattern 必须匹配整个 URL：以 http:// 或 https:// 开头，或以 * 开头（如 `*/api/users*`、`https://api.example.com/*`），`*` 匹配任意字符";

/**
 * 校验并规整 pattern：返回规整后的字符串（scheme + host 小写、连续的 `*` 合并）。非法抛 {@link NetRuleError}（文案模型能自修复）。
 * @param {unknown} raw
 */
export const normalizePattern = (raw) => {
  if (typeof raw !== "string" || raw === "") throw new NetRuleError(`缺少 pattern。${PATTERN_HINT}`);
  if (raw.length > MAX_PATTERN_CHARS) throw new NetRuleError(`pattern 过长（上限 ${MAX_PATTERN_CHARS} 字符）`);
  // 空白与控制字符：URL 里本来就不会有（空格要写成 %20），放行的话「末尾多了个空格」会让规则永远匹配不上
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) throw new NetRuleError("pattern 不能含空格 / 换行 / 控制字符（URL 里的空格要写成 %20；检查一下首尾是否多了空白）");
  if (raw.includes("\\")) throw new NetRuleError("pattern 不能含反斜杠（\\）；通配只用 *，其它字符按字面匹配");
  if (raw.includes("#")) throw new NetRuleError("pattern 不要带 #fragment（请求的 URL 里不含 fragment）");
  if (/^wss?:\/\//i.test(raw)) throw new NetRuleError("网络规则拦不了 WebSocket 握手（浏览器限制）；WebSocket 请用 browser_network 的 type=WebSocket 观察帧");
  const m = /^(https?:\/\/)([^/?]*)/i.exec(raw);
  if (!m && !raw.startsWith("*")) throw new NetRuleError(PATTERN_HINT);
  let out = raw.replace(/\*{2,}/g, "*");
  if (m) {
    // 请求 URL 的 scheme / host 恒为小写（Chrome 规范化过）：模型写成大写也要能命中；path / query 区分大小写，不动
    const head = `${m[1]}${m[2]}`.toLowerCase();
    out = `${head}${raw.slice(m[0].length)}`.replace(/\*{2,}/g, "*");
  }
  return out;
};

/**
 * `*`-only glob 匹配（无正则、无递归）：只在最后一个 `*` 处回溯，最坏 O(|p|·|t|)。
 * 对 `*a*a*a*a*b` 这种在正则里会多项式回溯的写法同样是线性级别。
 * @param {string} pattern
 * @param {string} text
 */
export const globMatch = (pattern, text) => {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = t;
      p += 1;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
};

/** 规则 pattern → CDP `Fetch.enable` 的 urlPattern：CDP 里 `?` 是单字符通配、反斜杠是转义，而我们的 `?` 是字面量 */
export const toCdpUrlPattern = (pattern) => pattern.replace(/\?/g, "\\?");

// ───────────────────────── 头 ─────────────────────────

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * 头参数宽松解析：`[{name, value}, …]` / `{ "X-A": "1" }` / 它们的 JSON 字符串，都收。
 * 校验：条数、头名是 token、值不含 CR / LF / NUL 等控制字符（头注入）且只含 Latin-1、长度上限、禁改清单；同名（大小写不敏感）后者覆盖前者。
 * @param {unknown} raw
 * @param {{ kind: "request" | "response", what?: string }} opts
 * @returns {Array<{ name: string, value: string }>}
 */
export const normalizeRuleHeaders = (raw, { kind, what = "headers" }) => {
  let v = raw;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") throw new NetRuleError(`${what} 不能为空`);
    try {
      v = JSON.parse(t);
    } catch {
      throw new NetRuleError(`${what} 必须是 [{name, value}] 数组或 {头名: 值} 对象`);
    }
  }
  let pairs;
  if (Array.isArray(v)) {
    pairs = v.map((it, i) => {
      if (!it || typeof it !== "object" || Array.isArray(it)) throw new NetRuleError(`${what}[${i}] 必须是 {name, value} 对象`);
      return [it.name, it.value];
    });
  } else if (v && typeof v === "object") {
    pairs = Object.entries(v);
  } else {
    throw new NetRuleError(`${what} 必须是 [{name, value}] 数组或 {头名: 值} 对象`);
  }
  if (pairs.length === 0) throw new NetRuleError(`${what} 至少要有一个头`);
  if (pairs.length > MAX_RULE_HEADERS) throw new NetRuleError(`${what} 最多 ${MAX_RULE_HEADERS} 个头`);
  const forbidden = kind === "request" ? isForbiddenRequestHeader : isForbiddenResponseHeader;
  const byLower = new Map();
  for (const [rawName, rawValue] of pairs) {
    if (typeof rawName !== "string" || rawName.length === 0 || rawName.length > MAX_HEADER_NAME_CHARS || !HEADER_NAME_RE.test(rawName)) {
      throw new NetRuleError(`头名「${String(rawName).slice(0, 40)}」不合法（只能是字母 / 数字 / 连字符等 token 字符，≤${MAX_HEADER_NAME_CHARS} 字符）`);
    }
    if (forbidden(rawName)) {
      throw new NetRuleError(
        kind === "request"
          ? `不允许改请求头 ${rawName}（HTTP 帧 / 连接类、Proxy-* / Sec-*、Cookie 都禁止；Cookie 请用 browser_storage）`
          : `不允许在 mock 里设置响应头 ${rawName}：mock 只放行 Cache-Control / ETag / Last-Modified / Expires / Vary / Content-Language / Access-Control-* / X-* 这几类响应头` +
            "（Content-Type 请用 content_type 参数；Content-Length / Content-Encoding 由系统按 body 生成；Set-Cookie / Clear-Site-Data / Content-Security-Policy / Strict-Transport-Security / Location / Refresh 等会改变浏览器状态或页面行为的头一律禁止）",
      );
    }
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") {
      throw new NetRuleError(`头 ${rawName} 的值必须是字符串`);
    }
    const value = String(rawValue);
    if (value.length > MAX_HEADER_VALUE_CHARS) throw new NetRuleError(`头 ${rawName} 的值过长（上限 ${MAX_HEADER_VALUE_CHARS} 字符）`);
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) throw new NetRuleError(`头 ${rawName} 的值不能含换行 / 控制字符`);
    if (/[^\u0000-\u00ff]/.test(value)) throw new NetRuleError(`头 ${rawName} 的值只能是 ASCII / Latin-1 字符（中文等请先 percent 编码）`);
    byLower.set(rawName.toLowerCase(), { name: rawName, value });
  }
  return [...byLower.values()];
};

// ───────────────────────── 规则定义 ─────────────────────────

const MOCK_CONTENT_TYPE_RE = /^[A-Za-z0-9][\w.+-]{0,60}\/[A-Za-z0-9][\w.+-]{0,80}(?:\s*;\s*[\w-]{1,30}=(?:[\w.+-]{1,60}|"[^"\r\n]{0,60}"))*$/;

/**
 * 没给 Content-Type 时按 body 开头嗅探：JSON → json；`<` 开头的标记（html / svg / xml / 任意标签）→ 可渲染类型；其余 → text/plain。
 * 为什么标记类一律往「可执行」靠：嗅探结果就是实际发出去的 Content-Type，html / svg 能在目标站 origin 里执行脚本（R6-01），
 * 与「写了 text/html」没有区别，必须同样走 evaluate 审批；宁可把 `<b>x</b>` 这种无害文本也算 html，也不能让 body 像 html 的无类型 mock 漏过去。
 * 模型想要纯文本又不想弹审批就显式写 content_type: text/plain。
 */
export const sniffContentType = (body) => {
  const t = String(body ?? "").trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return "application/json; charset=utf-8";
  const head = t.slice(0, 64).toLowerCase();
  if (head.startsWith("<svg")) return "image/svg+xml";
  if (head.startsWith("<?xml")) return "application/xml; charset=utf-8";
  if (/^<(?:!|[a-z])/.test(head)) return "text/html; charset=utf-8";
  return "text/plain; charset=utf-8";
};

/**
 * 免审批的 mock 内容类型**白名单**（R6-32；R6-01 的黑名单版漏判 `multipart/x-mixed-replace` / `message/rfc822` / `multipart/related` / `application/pdf` 等就会回到 R6-01）：
 * `application/json`、`text/plain`、`text/csv`、位图（png / jpeg / gif / webp / avif / bmp / x-icon）、`application/octet-stream`、`font/*`。
 * 其余一律走审批（含 html / js / svg / xml / css / wasm / pdf / multipart/* / message/* / 任何 `+xml`、空值与不可解析的值——fail-closed）。
 * 为什么 `font/*` 的子类型不收 `+`：Chrome 把任何 `*+xml` 当 XML 文档渲染，`font/x+xml` 不能借 font 前缀免审批。
 */
const APPROVAL_FREE_CONTENT_TYPES = new Set([
  "application/json",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "application/octet-stream",
]);
const APPROVAL_FREE_FONT_RE = /^font\/[a-z0-9][a-z0-9.-]{0,40}$/;

/**
 * 这个有效 Content-Type 是否免审批（白名单，见 {@link APPROVAL_FREE_CONTENT_TYPES}）。
 * 判定按**有效**类型（显式 content_type > headers 里大小写不敏感的 Content-Type > 嗅探默认值）；空 / 不可解析 → 不免审批。
 * @param {unknown} contentType
 */
export const isApprovalFreeContentType = (contentType) => {
  const base = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (base === "") return false;
  return APPROVAL_FREE_CONTENT_TYPES.has(base) || APPROVAL_FREE_FONT_RE.test(base);
};

/**
 * 「可执行 / 可渲染」内容类型（R6-01 的旧名，R6-32 起语义 = **不在免审批白名单里**）：这些类型的 mock ≈ 在目标站 origin 里执行脚本
 * （读 cookie / storage、带页面自身凭据发请求），与 browser_evaluate 等价，所以创建这类 mock 规则必须过 evaluate 审批。
 * 保留函数名只为兼容既有调用点 / 测试；新代码直接用 {@link isApprovalFreeContentType}。
 * @param {unknown} contentType
 */
export const isExecutableContentType = (contentType) => !isApprovalFreeContentType(contentType);

/** 这条（已规整的）规则是否需要 evaluate 审批：只有 mock 且有效 Content-Type 不在免审批白名单里。set_headers 只改请求头（Fetch 请求阶段），改不了响应类型，不在此列 */
export const ruleNeedsEvaluateApproval = (def) => def?.action === "mock" && !isApprovalFreeContentType(def.mock?.contentType);

/**
 * mock body 的风险统计（审批卡用，R6-32）：整个 body 的大小、`<script` 个数、`on*=` 事件属性个数。
 * 为什么统计整个 body 而不是只看预览：脚本可以藏在预览之后，计数是「预览之外还有什么」的唯一提示。
 * 两个正则都是线性的（无嵌套量词）；body ≤ 1MB（MAX_MOCK_BODY_BYTES）。
 * @param {unknown} body
 * @returns {{ bytes: number, scripts: number, handlers: number }}
 */
export const mockBodyStats = (body) => {
  const s = typeof body === "string" ? body : "";
  return {
    bytes: Buffer.byteLength(s, "utf8"),
    scripts: (s.match(/<script/gi) ?? []).length,
    handlers: (s.match(/[\s"'/]on[a-z]{3,20}\s*=/gi) ?? []).length,
  };
};

const optionalInt = (v, what, min, max) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new NetRuleError(`${what} 必须是整数（${min}–${max}）`);
  if (n < min || n > max) throw new NetRuleError(`${what} 必须在 ${min}–${max} 之间，收到 ${n}`);
  return n;
};

const absent = (v) => v === undefined || v === null;

/** 各 action 允许出现的参数（其余出现就报错：模型把 headers 塞给 block 通常是想错了 action） */
const ALLOWED_PARAMS = {
  block: ["pattern"],
  set_headers: ["pattern", "headers"],
  mock: ["pattern", "status", "headers", "body", "contentType"],
  fail: ["pattern", "errorReason"],
  delay: ["pattern", "delayMs"],
};

/**
 * 把一次「添加规则」的参数校验 / 规整成规则定义（还没有 id）。非法抛 {@link NetRuleError}。
 * 参数用 camelCase（主进程 op 约定；server 工具负责 snake_case → camelCase）。
 * @param {{ action: string, pattern?: unknown, headers?: unknown, status?: unknown, body?: unknown, contentType?: unknown, errorReason?: unknown, delayMs?: unknown }} p
 */
export const buildRuleDef = (p) => {
  const action = p?.action;
  if (!RULE_KINDS.includes(action)) throw new NetRuleError(`action 只能是 ${RULE_ACTIONS.join(" / ")}`);
  for (const k of Object.keys(p)) {
    if (k === "action" || k === "tabId" || absent(p[k])) continue;
    if (!ALLOWED_PARAMS[action].includes(k)) {
      throw new NetRuleError(`action=${action} 不接受参数 ${k}（它只用 ${ALLOWED_PARAMS[action].join(" / ")}）。想用 ${k} 请换对应的 action`);
    }
  }
  const def = { action, pattern: normalizePattern(p.pattern) };
  if (action === "set_headers") {
    if (absent(p.headers)) throw new NetRuleError("set_headers 需要 headers：[{name, value}] 或 {头名: 值}");
    def.headers = normalizeRuleHeaders(p.headers, { kind: "request" });
  } else if (action === "mock") {
    const status = absent(p.status) ? 200 : optionalInt(p.status, "status", 200, 599);
    const bodyRaw = absent(p.body) ? "" : p.body;
    if (typeof bodyRaw !== "string") throw new NetRuleError("body 必须是字符串（JSON 请先序列化成字符串）");
    if (Buffer.byteLength(bodyRaw, "utf8") > MAX_MOCK_BODY_BYTES) throw new NetRuleError(`mock 的 body 超过 ${MAX_MOCK_BODY_BYTES / 1024 / 1024}MB 上限`);
    let headers = absent(p.headers) ? [] : normalizeRuleHeaders(p.headers, { kind: "response" });
    let contentType;
    if (!absent(p.contentType)) {
      if (typeof p.contentType !== "string" || p.contentType.length > 140 || !MOCK_CONTENT_TYPE_RE.test(p.contentType)) {
        throw new NetRuleError("content_type 不合法（形如 application/json 或 text/html; charset=utf-8）");
      }
      contentType = p.contentType;
    }
    const ctHeader = headers.find((h) => h.name.toLowerCase() === "content-type");
    if (ctHeader && !contentType) {
      // headers 里的 Content-Type 同样过 content_type 的形状校验：逗号拼多个类型 / 带怪字符的值，浏览器怎么解析因实现而异，
      // 没法可靠判断它是不是可执行类型（R6-01），直接拒
      if (ctHeader.value.length > 140 || !MOCK_CONTENT_TYPE_RE.test(ctHeader.value)) {
        throw new NetRuleError("headers 里的 Content-Type 不合法（形如 application/json 或 text/html; charset=utf-8）");
      }
      contentType = ctHeader.value;
    }
    headers = headers.filter((h) => h.name.toLowerCase() !== "content-type");
    def.mock = { status, headers, body: bodyRaw, contentType: contentType ?? sniffContentType(bodyRaw) };
  } else if (action === "fail") {
    const reason = absent(p.errorReason) ? "Failed" : p.errorReason;
    if (typeof reason !== "string" || !FAIL_REASONS.includes(reason)) throw new NetRuleError(`error_reason 只能是 ${FAIL_REASONS.join(" / ")}`);
    def.errorReason = reason;
  } else if (action === "delay") {
    if (absent(p.delayMs)) throw new NetRuleError(`delay 需要 delay_ms（1–${MAX_DELAY_MS} 毫秒）`);
    def.delayMs = optionalInt(p.delayMs, "delay_ms", 1, MAX_DELAY_MS);
  }
  return def;
};

/**
 * 规则对外的描述（list / 活动日志 / 状态 / 工具结果共用）：**只给头名，绝不含头的值**；mock 不含 body，只给大小。
 * pattern 原样返回——调用方（ops 层）输出前再过 redactUrlSecrets。
 */
export const describeRule = (rule) => {
  const out = { id: rule.id, action: rule.action, pattern: rule.pattern, hits: rule.hits ?? 0 };
  if (rule.headers) out.headerNames = rule.headers.map((h) => h.name);
  if (rule.mock) {
    out.status = rule.mock.status;
    out.contentType = rule.mock.contentType;
    out.bodyBytes = Buffer.byteLength(rule.mock.body, "utf8");
    if (rule.mock.headers.length > 0) out.headerNames = rule.mock.headers.map((h) => h.name);
  }
  if (rule.errorReason) out.errorReason = rule.errorReason;
  if (rule.delayMs) out.delayMs = rule.delayMs;
  return out;
};

// ───────────────────────── 规则仓库 ─────────────────────────

/** 每 tab 一个：id 单调递增（`r1` `r2` …，clear 后不回绕，避免模型拿旧 id 误删新规则） */
export const createRuleStore = ({ max = MAX_RULES_PER_TAB, now = Date.now } = {}) => {
  let seq = 0;
  /** @type {Array<any>} */
  let rules = [];
  return {
    add(def) {
      if (rules.length >= max) {
        throw new NetRuleError(`这个标签页已有 ${rules.length} 条规则（上限 ${max}）：请先 browser_network_rules {action:"clear", rule_id} 删掉不用的，或 clear 全部`);
      }
      const rule = {
        ...def,
        id: `r${++seq}`,
        hits: 0,
        createdAt: now(),
        // 匹配器闭包：规则对象本身可序列化性不重要，但 describeRule 不会把它带出去
        test: (url) => globMatch(def.pattern, url),
      };
      rules.push(rule);
      return rule;
    },
    remove(id) {
      const i = rules.findIndex((r) => r.id === id);
      if (i < 0) return false;
      rules.splice(i, 1);
      return true;
    },
    clear() {
      const n = rules.length;
      rules = [];
      return n;
    },
    get: (id) => rules.find((r) => r.id === id),
    rules: () => rules.slice(),
    list: () => rules.map(describeRule),
    count: () => rules.length,
    /** `Fetch.enable` 的 patterns：每条规则一个（同 pattern 去重），只在请求阶段拦 */
    cdpPatterns: () => [...new Set(rules.map((r) => toCdpUrlPattern(r.pattern)))].map((urlPattern) => ({ urlPattern, requestStage: "Request" })),
  };
};

// ───────────────────────── 决策 ─────────────────────────

/** 把头合并成 `Fetch.continueRequest` 要的完整数组（该命令的 `headers` 是**整体替换**）：同名（大小写不敏感）以规则为准 */
export const mergeRequestHeaders = (original, extra) => {
  const over = new Set(extra.map((h) => h.name.toLowerCase()));
  const out = [];
  for (const [name, value] of Object.entries(original && typeof original === "object" ? original : {})) {
    if (over.has(name.toLowerCase())) continue;
    out.push({ name, value: String(value ?? "") });
  }
  for (const h of extra) out.push({ name: h.name, value: h.value });
  return out;
};

/**
 * 一个请求命中规则后的处理决定。
 * 优先级：先创建的「终结类」规则（block / fail / mock）赢；delay 取命中规则里最长的、与任何结果叠加；set_headers 全部命中的合并（后创建的覆盖同名）。
 * @param {Array<any>} rules
 * @param {{ url?: string, method?: string, headers?: Record<string,string> }} request
 * @param {{ isAppUrl?: (url: string) => boolean }} [opts]
 * @returns {{ verdict: "continue" | "fail" | "fulfill", untouched: boolean, delayMs: number, extraHeaders: Array<{name:string,value:string}>, errorReason?: string, mock?: object, matched: string[], ruled: string | null, decisiveRuleId?: string }}
 */
export const decideForRequest = (rules, request, { isAppUrl } = {}) => {
  const none = { verdict: "continue", untouched: true, delayMs: 0, extraHeaders: [], matched: [], ruled: null };
  const url = String(request?.url ?? "");
  // 红线：Flowship 自身 origin 永不处理；非 http(s)（理论上到不了这里）也不碰
  if (!/^https?:\/\//i.test(url)) return none;
  try {
    if (isAppUrl?.(url)) return none;
  } catch {
    return none; // 判不了就放行：宁可规则不生效，也不能误伤 Flowship 自己
  }
  const subject = url.length > MAX_MATCH_URL_CHARS ? url.slice(0, MAX_MATCH_URL_CHARS) : url;
  const matched = rules.filter((r) => r.test(subject));
  if (matched.length === 0) return none;
  const terminal = matched.find((r) => r.action === "block" || r.action === "fail" || r.action === "mock");
  const delayMs = matched.reduce((m, r) => (r.action === "delay" ? Math.max(m, r.delayMs ?? 0) : m), 0);
  const extra = [];
  for (const r of matched) if (r.action === "set_headers") extra.push(...r.headers);
  const extraHeaders = normalizeMerge(extra);
  const base = { delayMs, extraHeaders, matched: matched.map((r) => r.id), untouched: false };
  if (terminal?.action === "block") return { ...base, verdict: "fail", errorReason: "BlockedByClient", ruled: "block", decisiveRuleId: terminal.id };
  if (terminal?.action === "fail") return { ...base, verdict: "fail", errorReason: terminal.errorReason ?? "Failed", ruled: "fail", decisiveRuleId: terminal.id };
  if (terminal?.action === "mock") return { ...base, verdict: "fulfill", mock: terminal.mock, ruled: "mock", decisiveRuleId: terminal.id };
  return {
    ...base,
    verdict: "continue",
    ruled: delayMs > 0 ? "delay" : extraHeaders.length > 0 ? "headers" : null,
    decisiveRuleId: matched.find((r) => (delayMs > 0 ? r.action === "delay" : r.action === "set_headers"))?.id,
  };
};

const normalizeMerge = (list) => {
  const m = new Map();
  for (const h of list) m.set(h.name.toLowerCase(), h);
  return [...m.values()];
};

const headerValue = (headers, name) => {
  const hit = Object.entries(headers && typeof headers === "object" ? headers : {}).find(([k]) => k.toLowerCase() === name);
  return typeof hit?.[1] === "string" ? hit[1] : undefined;
};

/** CORS 预检请求：OPTIONS + `Access-Control-Request-Method`（命中 mock 规则时由系统代答，否则页面的 fetch 会死在预检上） */
export const isCorsPreflight = (request) =>
  String(request?.method ?? "").toUpperCase() === "OPTIONS" && headerValue(request?.headers, "access-control-request-method") !== undefined;

/**
 * mock → `Fetch.fulfillRequest` 的参数；请求带 Origin 且 mock 没写 ACAO 时回显它（否则跨域 fetch 会被 CORS 拦掉，模型会以为 mock 没生效）。
 * CORS 预检（OPTIONS + Access-Control-Request-Method）命中 mock 规则时回 204 + 放行头（与 Playwright 的 route.fulfill 同样处理），不返回 mock 的 body。
 */
export const buildFulfillParams = (mock, request, requestId) => {
  const origin = headerValue(request?.headers, "origin");
  if (isCorsPreflight(request)) {
    const reqHeaders = headerValue(request.headers, "access-control-request-headers");
    const safe = (v, max) => (typeof v === "string" && !/[\u0000-\u001f\u007f]/.test(v) ? v.slice(0, max) : undefined);
    const h = [
      { name: "Access-Control-Allow-Origin", value: safe(origin, 200) ?? "*" },
      { name: "Access-Control-Allow-Methods", value: safe(headerValue(request.headers, "access-control-request-method"), 40) ?? "GET" },
      { name: "Access-Control-Max-Age", value: "600" },
      { name: "Vary", value: "Origin" },
    ];
    if (safe(reqHeaders, 500)) h.push({ name: "Access-Control-Allow-Headers", value: safe(reqHeaders, 500) });
    if (safe(origin, 200)) h.push({ name: "Access-Control-Allow-Credentials", value: "true" });
    return { requestId, responseCode: 204, responseHeaders: h, body: "" };
  }
  // R6-39④：规则里的 Content-Type 头在 buildRuleDef 里已并入 contentType 并剔除；这里**再剔一次**作纵深——响应里恰好只有一个 Content-Type（系统生成的那个），
  // 不能因为 mock 对象来路不同（别的调用点 / 旧规则 / 将来的改动）让「json + 第二个 text/html 头」漏出去：两个同名头浏览器取哪个因实现而异，
  // 取到后者就等于绕过了「html 要审批」的闸门
  let headers = [{ name: "Content-Type", value: mock.contentType }, ...mock.headers.filter((h) => String(h?.name ?? "").trim().toLowerCase() !== "content-type")];
  if (isApprovalFreeContentType(mock.contentType)) {
    // 免审批类型的 mock 一律强制 nosniff（R6-01）：Chrome 对 <script src> / Worker 只在 nosniff 下才按 MIME 拦——
    // 否则 `text/plain` / `application/json` 的 mock 仍能被当脚本跑，等于绕过了「可执行类型要审批」的闸门
    headers = headers.filter((h) => h.name.toLowerCase() !== "x-content-type-options");
    headers.push({ name: "X-Content-Type-Options", value: "nosniff" });
  } else {
    // 需要审批的类型（已获批准）：强制 Cache-Control: no-store、去掉模型写的 Cache-Control / Expires（R6-32 放行了这两个头）——
    // 带 max-age 的可执行 mock 若被浏览器缓存，撤销批准 / 清除规则后页面仍可能继续拿到缓存里的脚本，R6-31 的撤销就名存实亡
    headers = headers.filter((h) => !["cache-control", "expires"].includes(h.name.toLowerCase()));
    headers.push({ name: "Cache-Control", value: "no-store" });
  }
  const hasAcao = headers.some((h) => h.name.toLowerCase() === "access-control-allow-origin");
  if (!hasAcao && typeof origin === "string" && /^https?:\/\/[^\s]{1,200}$/i.test(origin)) {
    headers.push({ name: "Access-Control-Allow-Origin", value: origin }, { name: "Access-Control-Allow-Credentials", value: "true" }, { name: "Vary", value: "Origin" });
  }
  return {
    requestId,
    responseCode: mock.status,
    responseHeaders: headers,
    body: Buffer.from(mock.body, "utf8").toString("base64"),
  };
};

// ───────────────────────── Fetch.requestPaused 处理器（恰好一次 + 兜底） ─────────────────────────

/** 兜底超时：任何 requestPaused 在「决策 + 延迟」之后再多等这么久还没处理完，就无条件放行 */
export const PAUSE_SAFETY_SLACK_MS = 8000;
/** 同时挂着等延迟的请求数上限：超过就不再延迟（立即放行），免得页面疯狂发请求时堆出海量定时器 */
export const MAX_DELAYED_PENDING = 100;

/**
 * 创建 `Fetch.requestPaused` 处理器。
 *
 * 不变量（单测用假 CDP 逐条验证）：
 *  1. 每个被暂停的请求**恰好被处理一次**（continue / fail / fulfill 三选一）：`done` 在第一个 await 之前同步置位，之后任何路径（正常流程 / 兜底超时 /
 *     flush / 重复事件）都直接放弃；
 *  2. 任何异常（决策抛错、failRequest / fulfillRequest 被浏览器拒绝）退回 `continueRequest`——请求永不挂起；
 *  3. 兜底超时：决策完成后按「延迟 + {@link PAUSE_SAFETY_SLACK_MS}」重新计时，到点无条件放行（`continueRequest` 本身失败就只能算了：请求多半已经死了）；
 *  4. 规则暂停（用户接管）/ 规则已清空 / dispose 之后到达的事件一律原样放行；`flush()` 把已挂起的（含正在等延迟的）立刻放行。
 *
 * @param {{
 *   send: (method: string, params: object, sessionId: string | null) => Promise<unknown>,
 *   getRules: () => Array<any>,
 *   isPaused: () => boolean,
 *   isAppUrl?: (url: string) => boolean,
 *   onRuled?: (info: { sessionId: string | null, networkId?: string, ruled: string, ruleId?: string }) => void,
 *   ruleAllowed?: (rule: any) => boolean,
 *   onRuleRefused?: (rule: any) => void,
 *   log?: (msg: string) => void,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} deps
 *   `ruleAllowed`（R6-31，可选）：规则**当下**是否仍被允许生效——需要 evaluate 审批的 mock 在批准被撤销 / 总闸被关之后返回 false。
 *   两道判定：① 命中决策前，不被允许的规则当作不存在（原请求放行 / 由别的规则处理）；② 真正 `fulfillRequest` 之前（延迟等待期间批准可能被撤销）对决定性的
 *   那条 mock 再判一次，规则已被清掉或不再被允许 → 不 fulfill、按「没有这条 mock」继续。判定函数抛错一律按「不允许」。`onRuleRefused(rule)`：命中了但被拒绝的规则（调用方据此写日志）。
 */
export const createPauseController = (deps) => {
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;
  const log = deps.log ?? (() => {});
  const pending = new Map();
  let delayedPending = 0;
  let disposed = false;

  const allowed = (rule) => {
    if (typeof deps.ruleAllowed !== "function") return true;
    try {
      return deps.ruleAllowed(rule) === true;
    } catch (err) {
      log(`[net-rules] 规则 ${rule?.id} 的生效判定出错，按不允许处理：${String(err?.message ?? err).slice(0, 120)}`);
      return false;
    }
  };
  const refused = (rule) => {
    try {
      deps.onRuleRefused?.(rule);
    } catch {
      /* 日志是旁路 */
    }
  };

  const finishEntry = (entry) => {
    entry.done = true;
    pending.delete(entry.key);
    if (entry.safety) clearT(entry.safety);
    if (entry.delayTimer) clearT(entry.delayTimer);
    if (entry.delaying) {
      entry.delaying = false;
      delayedPending = Math.max(0, delayedPending - 1);
    }
    entry.delayResolve?.();
  };

  /** 唯一的出口：done 同步置位 → 发命令；失败（非 continue）退回 continue */
  const settle = async (entry, command, params) => {
    if (entry.done) return;
    finishEntry(entry);
    try {
      await deps.send(command, params, entry.sessionId);
    } catch (err) {
      log(`[net-rules] ${command} 失败：${String(err?.message ?? err).slice(0, 120)}`);
      if (command !== "Fetch.continueRequest") {
        try {
          await deps.send("Fetch.continueRequest", { requestId: entry.requestId }, entry.sessionId);
        } catch {
          /* 请求多半已经没了（页面导航 / tab 关闭），无事可做 */
        }
      }
    }
  };
  const continuePlain = (entry) => settle(entry, "Fetch.continueRequest", { requestId: entry.requestId });

  const arm = (entry, ms) => {
    if (entry.safety) clearT(entry.safety);
    entry.safety = setT(() => {
      log(`[net-rules] 请求 ${entry.requestId} 处理超时，已兜底放行`);
      void continuePlain(entry);
    }, ms);
    entry.safety?.unref?.();
  };

  const wait = (entry, ms) =>
    new Promise((resolve) => {
      entry.delayResolve = resolve;
      entry.delayTimer = setT(resolve, ms);
      entry.delayTimer?.unref?.();
    });

  const flush = async () => {
    const all = [...pending.values()];
    await Promise.all(all.map((e) => continuePlain(e)));
  };

  return {
    /** 处理一条 `Fetch.requestPaused`（params 是 CDP 事件载荷；不 throw，不返回有意义的值） */
    async onPaused(params, sessionId = null) {
      const requestId = params?.requestId;
      if (typeof requestId !== "string" || requestId === "") return;
      // 响应阶段的暂停（别的模块用 Fetch 拦响应时才会有）不是我们的：我们只拦请求阶段，碰了反而会抢走别人的请求
      if (params.responseStatusCode !== undefined || params.responseErrorReason !== undefined) return;
      const key = `${sessionId ?? "main"}:${requestId}`;
      if (pending.has(key)) return; // 重复事件：已经在处理，不二次处理
      const entry = { key, requestId, sessionId: sessionId ?? null, done: false, safety: null, delayTimer: null, delayResolve: null, delaying: false };
      pending.set(key, entry);
      arm(entry, PAUSE_SAFETY_SLACK_MS);
      try {
        if (disposed || deps.isPaused()) return await continuePlain(entry);
        const request = params.request ?? {};
        // R6-31 第一道：不再被允许生效的规则（批准已撤销 / 总闸已关的可执行 mock）当作不存在——原请求放行或交给别的规则
        const allRules = deps.getRules();
        const liveRules = typeof deps.ruleAllowed === "function" ? allRules.filter(allowed) : allRules;
        if (liveRules.length !== allRules.length) {
          const url = String(request.url ?? "").slice(0, MAX_MATCH_URL_CHARS);
          let appUrl = false;
          try {
            appUrl = deps.isAppUrl?.(url) === true;
          } catch {
            appUrl = true;
          }
          if (/^https?:\/\//i.test(url) && !appUrl) {
            for (const r of allRules) {
              if (liveRules.includes(r)) continue;
              let hit = false;
              try {
                hit = r.test(url) === true;
              } catch {
                hit = false;
              }
              if (hit) refused(r);
            }
          }
        }
        const d = decideForRequest(liveRules, request, { isAppUrl: deps.isAppUrl });
        if (d.untouched) return await continuePlain(entry);
        // 命中的请求带上标记：network 列表里据此显示 `ruled`（Network.requestId 在 params.networkId）
        if (d.ruled) {
          try {
            deps.onRuled?.({ sessionId: sessionId ?? null, networkId: typeof params.networkId === "string" ? params.networkId : undefined, ruled: d.ruled, ruleId: d.decisiveRuleId });
          } catch {
            /* 标记是旁路 */
          }
        }
        for (const r of deps.getRules()) if (d.matched.includes(r.id)) r.hits = (r.hits ?? 0) + 1;
        if (d.delayMs > 0 && delayedPending < MAX_DELAYED_PENDING) {
          arm(entry, d.delayMs + PAUSE_SAFETY_SLACK_MS);
          entry.delaying = true;
          delayedPending += 1;
          await wait(entry, d.delayMs);
          if (entry.done) return; // 期间被 flush / 兜底超时处理掉了
          entry.delaying = false;
          delayedPending = Math.max(0, delayedPending - 1);
          // 等待期间用户接管了 / 规则被清空了：不再改写
          if (disposed || deps.isPaused()) return await continuePlain(entry);
        }
        if (d.verdict === "fail") return await settle(entry, "Fetch.failRequest", { requestId, errorReason: d.errorReason });
        if (d.verdict === "fulfill") {
          // R6-31 第二道：fulfill 前再按「当下」重判一次——延迟等待期间批准可能被撤销、规则可能已被清掉。
          // 决定性的 mock 规则已不在 / 不再被允许 → 不 fulfill，当作没有这条 mock 继续（set_headers 仍生效，其余原样放行）
          const live = deps.getRules().find((r) => r.id === d.decisiveRuleId);
          if (live && allowed(live)) return await settle(entry, "Fetch.fulfillRequest", buildFulfillParams(d.mock, request, requestId));
          if (live) refused(live);
        }
        if (d.extraHeaders.length > 0) {
          return await settle(entry, "Fetch.continueRequest", { requestId, headers: mergeRequestHeaders(request.headers, d.extraHeaders) });
        }
        return await continuePlain(entry);
      } catch (err) {
        log(`[net-rules] 处理请求出错，已放行：${String(err?.message ?? err).slice(0, 120)}`);
        await continuePlain(entry);
      }
    },
    /** 把所有挂起的请求（含等延迟的）立刻放行：规则暂停 / 清空 / 会话结束前调用 */
    flush,
    pendingCount: () => pending.size,
    dispose() {
      disposed = true;
      void flush();
    },
  };
};
