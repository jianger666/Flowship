/**
 * V2：网络请求详情的纯逻辑（契约 §14.1 `network_detail`）。无 electron / CDP 依赖，可直接单测。
 *
 * - 头部脱敏（R1-26 起改为「包含式」）：头名里**包含** auth / token / secret / key / signature / session / cookie /
 *   password / passwd / credential / csrf / xsrf / jwt / bearer 的头，值一律 `[已隐藏]`（authorization / cookie / set-cookie /
 *   proxy-authorization / x-api-key / x-auth-token / x-auth-key / ocp-apim-subscription-key / x-hub-signature …都在内）——宁可多藏，少漏；
 *   R2-04：再按「词」查一份与 query 键名共用的词表（pass / pwd / otp / pin / sid / sig / ticket …）加上头独有的 bypass
 *   （`x-vercel-protection-bypass`、`x-otp`）；h2 伪头（`:authority` / `:path` …，以 `:` 开头）不是秘密，不因含 auth 被误藏；
 *   只有少数「名字带 auth / credential 但值不是秘密」的头（www-authenticate、access-control-allow-credentials）豁免——
 *   其中 `www-authenticate: Negotiate <token>` 这类质询里带 token68 的，token 仍然隐藏（只豁免纯 scheme / 只有 auth-param 的）；
 * - URL 脱敏：url / Location / Referer / Link 等**任何头值与 URL** 里的查询串、`;` 矩阵参数、`#fragment` 里敏感键名的值，
 *   以及 `user:pass@` 形式的 userinfo，都换成 `[已隐藏]`（见 {@link redactUrlSecrets}）；
 * - 只给文本类 mime 的 body（json / text / xml / javascript / x-www-form-urlencoded），其它给 bodyUnavailableReason；
 * - 详情暂存表：id → { requestId, sessionId, 请求头 / 响应头 / mime / postData }，上限 200，插入序淘汰（与环形缓冲同步，
 *   环上限 500 > 200，所以详情总是先于列表条目被淘汰）。
 */

export const REDACTED = "[已隐藏]";
export const NET_DETAIL_MAX = 200;
export const NET_BODY_MAX = 20_000;
export const NET_HEADER_VALUE_MAX = 2000;
export const NET_HEADER_COUNT_MAX = 100;

/**
 * 头名「包含」这些子串就整条隐藏（R1-26：原先是 6 个固定名 + token / secret / api-key / password，漏了 x-auth-key、
 * ocp-apim-subscription-key、*signature*、*session* 等）。`key` 会连带藏掉 sec-websocket-key、`auth` 会连带藏掉
 * www-authenticate（后者在 {@link SAFE_HEADERS} 里豁免）——这是有意的：多藏一个头的代价远小于漏一个密钥。
 */
const SENSITIVE_NAME_RE = /auth|token|secret|key|signature|session|cookie|password|passwd|credential|csrf|xsrf|jwt|bearer/i;

/** 名字撞了上面的子串、但值不是秘密的头（小写比较）：服务端的认证质询、CORS 的布尔开关。值里若带 URL 仍照样脱敏 */
const SAFE_HEADERS = new Set(["www-authenticate", "proxy-authenticate", "access-control-allow-credentials"]);

/**
 * 头名是否敏感（大小写不敏感）：包含式子串匹配（见 {@link SENSITIVE_NAME_RE}）+ 与 query 键名共用的「词」表（{@link SECRET_WORDS}）
 * + 头独有的 {@link HEADER_ONLY_WORDS}。h2 伪头（以 `:` 开头）不是用户可设的头、值也不是秘密（`:authority` 是主机名），直接放行。
 */
export const isSensitiveHeader = (name) => {
  const n = String(name ?? "").toLowerCase();
  if (n.startsWith(":")) return false;
  if (SAFE_HEADERS.has(n)) return false;
  if (SENSITIVE_NAME_RE.test(n)) return true;
  return splitKeyWords(n).some((w) => SECRET_WORDS.has(w) || HEADER_ONLY_WORDS.has(w));
};

/** 豁免头里的「质询」类：值是 `scheme [token68 | auth-param, …]`，只有带 token68 的才需要藏那段 token（见 {@link CHALLENGE_TOKEN_RE}） */
const CHALLENGE_HEADERS = new Set(["www-authenticate", "proxy-authenticate"]);
/**
 * 质询里的 token68：`Negotiate oYIB…==`（SPNEGO / NTLM 的握手 token 是实打实的凭据材料）。
 * token68 = 一整段 base64url 字符 + 可选 `=` 补位，且后面直接是逗号或结尾；`realm="api"` / `realm=proxy` / `error="x"`
 * 这类 auth-param 的 `=` 后面还有值，所以不会匹配。纯 scheme（`Negotiate`、`Basic realm=…`）原样保留。
 */
const CHALLENGE_TOKEN_RE = /((?:^|,)\s*[A-Za-z][A-Za-z0-9._~+/-]*[ \t]+)[A-Za-z0-9._~+/-]+=*(?=\s*(?:,|$))/g;

// ───────────────────────── URL / 头值里的敏感查询参数（R1-26） ─────────────────────────

/**
 * 「作为一个词」出现就敏感的词表——**头名与查询参数名共用这一份**（R2-04：此前头名只有子串正则，没有 pass / pwd / otp / pin，
 * 与 query 的口径不一致）。按词匹配而不是按子串，是为了不误伤 keyword / author / design / passenger / bypass / compass
 * （它们各自是一个词，不在表里）。词由非字母数字分隔、驼峰边界切出：`accessToken` → access + token，`X-Amz-Signature` → x + amz + signature。
 */
const SECRET_WORDS = new Set([
  "key", "sig", "sid", "sign", "token", "secret", "password", "passwd", "pwd", "pass", "passcode", "pin", "pincode", "auth", "authorization",
  "session", "sessionid", "sessid", "jsessionid", "phpsessid", "signature", "cookie", "credential", "credentials", "jwt", "bearer",
  "otp", "hotp", "totp", "ticket", "csrf", "xsrf", "apikey", "accesskey", "secretkey", "privatekey", "assertion", "samlresponse", "samlrequest",
  // R3-03 ②：口令的常见缩写（`pw=` / `user_pw` / `psw` / `pswd`）；整词匹配，不误伤 pwa / pws 这类
  "pw", "psw", "pswd",
]);
/** 只对 query 参数名成立：OAuth 回调的 `code`。头名 / JSON 键里的 code 多是状态码（`x-error-code`、`{"code":200}`），不当敏感 */
const QUERY_ONLY_WORDS = new Set(["code"]);
/** 只对头名成立：`x-vercel-protection-bypass` 这类「绕过保护」的共享密钥头；query 里的 `bypass=1` 多是开关 */
const HEADER_ONLY_WORDS = new Set(["bypass"]);
/** 参数名里（去掉分隔符后）含这些较长的片段就敏感（accesstoken / x-amz-security-token / mysecretvalue 这类拼在一起的写法） */
const QUERY_KEY_FRAGMENT_RE = /token|secret|password|passwd|signature|session|cookie|credential|apikey|jwt/;

const splitKeyWords = (key) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const decodeKey = (rawKey) => {
  const key = String(rawKey ?? "");
  try {
    return decodeURIComponent(key);
  } catch {
    return key; // 非法转义：按原样判断
  }
};

/** 键名是否像凭据（片段 + 共用词表；不含 query 独有的 code）。JSON 键、嵌套值里的 `:` 分隔键用它 */
const isSecretKeyName = (rawKey) => {
  const key = decodeKey(rawKey);
  if (QUERY_KEY_FRAGMENT_RE.test(key.toLowerCase().replace(/[^a-z0-9]+/g, ""))) return true;
  return splitKeyWords(key).some((w) => SECRET_WORDS.has(w));
};

/** 查询参数名是否敏感（先 percent-decode，再词表 + 片段两路判断；比 {@link isSecretKeyName} 多一个 OAuth 的 `code`） */
export const isSensitiveQueryKey = (rawKey) => {
  const key = decodeKey(rawKey);
  if (isSecretKeyName(key)) return true;
  return splitKeyWords(key).some((w) => QUERY_ONLY_WORDS.has(w));
};

/** 值本身长得像凭据（不管参数名叫什么）：JWT、几种常见的带前缀密钥 */
const SECRET_VALUE_RE = /^(?:eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*|(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA)[\w-]{10,})$/;

/**
 * `scheme://user:pass@host` 里的 userinfo（整段隐藏：用户名位置也常被拿来放 token）。
 * R2-04：userinfo 吃到 authority 里**最后一个** `@`（密码里本身含 `@`，`user:p@ss@host` 旧版只吃到第一个、`ss` 残留）；
 * 起点用 `(?<![a-z0-9+.-])` 限定在 scheme 词的开头——否则对「没有 `://` 的长字母串」每个位置都向后扫一遍，是 O(n²)。
 */
const USERINFO_RE = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/?#\s"'<>]+@/gi;

/**
 * query 值里嵌套的键值对（R2-04）：`?data={"token":"x"}`（Chrome 上报时是 `{%22token%22:%22x%22}`）、
 * `?redirect_uri=https%3A%2F%2Fa%2Fcb%3Fcode%3Dxyz`（值本身是个带凭据的 URL）。URL 解码（至多两层）后找「键 + `:`/`=`」，
 * `=` 分隔的按 query 键名判断（含 code），`:` 分隔的按 JSON 键名判断（不含 code，免得 `{"code":200}` 被整段藏掉）；
 * 命中就整个值隐藏（不尝试在编码串里局部替换）。起点用 lookbehind 限定在键名开头、键名限长，线性。
 */
const NESTED_KEY_RE = /(?<![\w.[\]-])["']?([\w.[\]-]{1,100})["']?\s*([:=])/g;
const NESTED_SCAN_MAX = 4096;
const valueHasNestedSecret = (value) => {
  if (value.length < 4 || !/[:=]|%(?:25){0,2}3[ad]/i.test(value)) return false; // 连（至多两层）编码形态的分隔符都没有 → 不可能嵌着键值对
  let v = value.length > NESTED_SCAN_MAX ? value.slice(0, NESTED_SCAN_MAX).replace(/%[0-9a-f]?$/i, "") : value;
  for (let i = 0; i < 2; i += 1) {
    if (!/%[0-9a-f]{2}|\+/i.test(v)) break;
    try {
      v = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      break; // 非法转义：按已解出的部分判断
    }
  }
  for (const m of v.matchAll(NESTED_KEY_RE)) {
    if (m[2] === "=" ? isSensitiveQueryKey(m[1]) : isSecretKeyName(m[1])) return true;
  }
  return false;
};
/**
 * 一个「分隔符 + 键 = 值」：分隔符是 ? & # ;（查询串、fragment、`;jsessionid=` 矩阵参数都覆盖）。
 * 值不含 `?`，让「值里又嵌着一个 URL」（如 `Refresh: 0;url=https://a/b?token=1`）时，内层的 `?token=1` 不会被外层吞掉而漏脱敏。
 * 值里允许 `=`（base64 的 padding）。
 * R2-04：值里也允许引号——旧版值遇到 `"` / `'` 就停，`?token="abc"` 只把空值换成占位符、`"abc"` 原样留着，
 * `?data={"token":"x"}` 的值在 `{` 处就被截断，嵌套的键永远看不到。键名仍不含引号 / 空白，所以不会把
 * `rel="next"` 这类头参数当成键值对。
 */
const URL_PAIR_RE = /([?&#;])([^=&#;\s"'<>]{1,200})=([^&#;?\s<>]*)/g;

/**
 * 值以 JSON 起头（`{` / `[` 或其 percent 编码）的键值对（R3-03 ②）：`encodeURI(JSON.stringify(obj))` 不编码 `; ? & # =`，
 * URL_PAIR_RE 的值在第一个 `;` / `?` / `&` 处就被截断，后半段 `…%22token%22:%22SECRET%22}` 没有 `=`、永远看不到。
 * 这里单独把「JSON 起头的值」连同整个 token 尾部（到空白 / 尖括号为止）一次拿下来做嵌套扫描；命中就整体隐藏（连后面的参数一起——宁可多藏），
 * 没命中就原样不动、交给 URL_PAIR_RE 照常处理。贪婪吃到 token 尾，所以每个起点互不重叠、总量线性（嵌套扫描本身只看前 NESTED_SCAN_MAX 字符）。
 */
const JSONISH_PAIR_RE = /([?&#;])([^=&#;\s"'<>]{1,200})=((?:\{|\[|%7B|%5B)[^\s<>]*)/gi;
/** URL_PAIR_RE 的值会在这些字符处截断 */
const JSON_VALUE_BREAK_RE = /[&#;?]/;

/**
 * JSON 起头的值在分隔符之前「没闭合」吗（R4 复审 R3-03 ②）：括号没配平，或停在一个没收尾的字符串里。
 * 没闭合 = 那个分隔符是**秘密值本身**里的字符（`{"password":"ab;cd"}` 在 `;` 处被截断），不是参数分隔符，截断点之后的尾巴也是秘密的一部分。
 * 先 percent-decode（至多两层，与 {@link valueHasNestedSecret} 同口径）再扫；字符串里的转义引号与另一种引号不影响配对。线性。
 * @param {string} head  值里第一个分隔符之前的那一段
 */
const jsonHeadIsOpen = (head) => {
  let v = head;
  for (let i = 0; i < 2; i += 1) {
    if (!/%[0-9a-f]{2}/i.test(v)) break;
    try {
      v = decodeURIComponent(v);
    } catch {
      break; // 非法转义：按已解出的部分判断
    }
  }
  let depth = 0;
  let quote = "";
  for (let i = 0; i < v.length; i += 1) {
    const c = v[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") depth -= 1;
  }
  return quote !== "" || depth > 0;
};

/**
 * 脱敏文本里的 URL 敏感部分（纯函数，对任意字符串都安全：完整 URL、相对 Location、Link / Refresh 这类内嵌 URL 的头值都能处理）：
 *  - `user:pass@` 的 userinfo → `[已隐藏]@`；
 *  - 查询串 / `;` 矩阵参数 / fragment 里「敏感键名」或「值长得像凭据」的参数，值 → `[已隐藏]`（键名保留，让 AI 知道带了这个参数）。
 * **不处理路径里直接嵌的秘密**（如 `/webhook/<随机串>`）——无法与普通路径区分。
 * @param {unknown} input
 * @returns {string}
 */
export const redactUrlSecrets = (input) => {
  const s = typeof input === "string" ? input : String(input ?? "");
  if (s === "") return s;
  return s
    .replace(USERINFO_RE, `$1${REDACTED}@`)
    .replace(JSONISH_PAIR_RE, (m, delim, key, value) => {
      const head = value.split(JSON_VALUE_BREAK_RE, 1)[0];
      // 在第一个分隔符前就已经能判敏感的（键名敏感 / 截断的前半段里有凭据）：
      //  · JSON 在分隔符之前已闭合 → 分隔符是真的参数分隔，不动，交给下面的 URL_PAIR_RE 精确替换（保留后面的参数）；
      //  · 没闭合 → 秘密值本身含 `;` `?` `&`（`{"password":"ab;cd"}`），URL_PAIR_RE 会在那里截断、尾巴泄漏：整个 token 尾部全藏（宁可多藏）。
      // 非 JSON 的 `?password=ab;cd` 把 `;` 当 query 分隔符是老式写法的合理解读，仍按分隔符处理（不在这里管）。
      if (isSensitiveQueryKey(key) || valueHasNestedSecret(head)) return head.length < value.length && jsonHeadIsOpen(head) ? `${delim}${key}=${REDACTED}` : m;
      return valueHasNestedSecret(value) ? `${delim}${key}=${REDACTED}` : m;
    })
    .replace(URL_PAIR_RE, (m, delim, key, value) =>
      isSensitiveQueryKey(key) || SECRET_VALUE_RE.test(value) || valueHasNestedSecret(value) ? `${delim}${key}=${REDACTED}` : m,
    );
};

/**
 * 暂存用：限条数、限长度，值统一成字符串。**不脱敏**（脱敏在输出时做，见 {@link redactHeaders}）：
 * 暂存表只活在主进程内存里，输出才是外泄面，且输出时统一脱敏更不容易漏。
 * @param {unknown} headers
 * @returns {Record<string, string>}
 */
export const stashHeaders = (headers) => {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  let n = 0;
  for (const [k, v] of Object.entries(headers)) {
    if (n >= NET_HEADER_COUNT_MAX) break;
    const s = String(v ?? "");
    out[String(k)] = s.length > NET_HEADER_VALUE_MAX ? `${s.slice(0, NET_HEADER_VALUE_MAX)}…` : s;
    n += 1;
  }
  return out;
};

/**
 * 输出用：敏感头的值换成 `[已隐藏]`（头名保留，让 AI 知道「带了这个头」）；
 * 其余头的值照样过一遍 {@link redactUrlSecrets}（Location / Referer / Link / Refresh / Origin … 里的 URL 常带 `?code=` / `?token=`）。
 * @param {unknown} headers
 * @returns {Record<string, string>}
 */
export const redactHeaders = (headers) => {
  const out = {};
  for (const [k, v] of Object.entries(headers && typeof headers === "object" ? headers : {})) {
    if (isSensitiveHeader(k)) {
      out[k] = REDACTED;
      continue;
    }
    let value = typeof v === "string" ? v : String(v ?? "");
    // 豁免的质询头：scheme / auth-param 保持可见，带 token68 的（`Negotiate oYIB…`）只藏 token（R2-04）
    if (CHALLENGE_HEADERS.has(String(k).toLowerCase())) value = value.replace(CHALLENGE_TOKEN_RE, `$1${REDACTED}`);
    out[k] = redactUrlSecrets(value);
  }
  return out;
};

/** 文本类 mime（可以安全地当字符串给 AI）。参数部分（; charset=…）忽略 */
export const isTextMime = (mime) => {
  const m = String(mime ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!m) return false;
  if (m.startsWith("text/")) return true;
  if (m.endsWith("+json") || m.endsWith("+xml")) return true;
  return [
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-javascript",
    "application/ecmascript",
    "application/x-www-form-urlencoded",
    "application/graphql",
    "application/x-ndjson",
  ].includes(m);
};

/** 截断到 max 字符；返回 { text, truncated } */
export const clipBody = (text, max = NET_BODY_MAX) => {
  const s = String(text ?? "");
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
};

/** Network.getResponseBody 的返回 → 文本（base64 的文本类 mime 按 utf8 解码）；解不出来返回 null */
export const decodeBody = ({ body, base64Encoded }) => {
  const raw = String(body ?? "");
  if (base64Encoded !== true) return raw;
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return null;
  }
};

/**
 * 详情暂存表：Map 的插入序天然就是 id 的递增序，超过 max 删最旧的。
 * @param {number} [max]
 */
export const createNetworkDetailStore = (max = NET_DETAIL_MAX) => {
  const map = new Map();
  return {
    add(id, detail) {
      map.set(id, detail);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    size: () => map.size,
    ids: () => [...map.keys()],
    clear: () => map.clear(),
  };
};

/**
 * 组装 network_detail 的结果（纯函数）。
 * @param {{ entry: object, detail: object, includeBody: boolean,
 *           response?: { ok: boolean, body?: string, base64Encoded?: boolean, reason?: string },
 *           requestPostData?: string }} p
 * @returns {Record<string, any>}
 */
export const assembleNetworkDetail = ({ entry, detail, includeBody, response, requestPostData }) => {
  const out = {
    id: entry.id,
    method: entry.method,
    url: typeof entry.url === "string" ? redactUrlSecrets(entry.url) : entry.url,
    status: entry.status ?? null,
    type: entry.type,
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.failed ? { failed: true } : {}),
    ...(entry.errorText ? { errorText: entry.errorText } : {}),
    // E2·S3：发起者栈（URL 采集时已脱敏，这里幂等地再过一遍）/ 缓存命中 / 服务工作线程 / 被网络规则处理的标记
    ...(entry.initiator ? { initiator: { type: entry.initiator.type, stack: entry.initiator.stack.map((s) => redactUrlSecrets(s)) } } : {}),
    ...(entry.cache ? { cache: entry.cache } : {}),
    ...(entry.fromServiceWorker ? { fromServiceWorker: true } : {}),
    ...(entry.ruled ? { ruled: entry.ruled } : {}),
    ...(detail?.mimeType ? { mimeType: detail.mimeType } : {}),
    requestHeaders: redactHeaders(detail?.requestHeaders),
    responseHeaders: redactHeaders(detail?.responseHeaders),
  };
  if (!includeBody) return out;

  // 请求体：本身就在暂存里（requestWillBeSent 带的 postData），再被动补一次
  const post = typeof requestPostData === "string" ? requestPostData : detail?.postData;
  if (typeof post === "string" && post !== "") {
    const c = clipBody(post);
    out.requestBody = c.text;
    if (c.truncated) out.bodyTruncated = true;
  }

  // 响应体：只给文本类 mime
  if (!response || response.ok !== true) {
    out.bodyUnavailableReason = response?.reason || "响应体不可用";
  } else if (!isTextMime(detail?.mimeType)) {
    out.bodyUnavailableReason = `响应是二进制或非文本类型（${detail?.mimeType || "未知 mime"}），不提供 body`;
  } else {
    const text = decodeBody(response);
    if (text === null) {
      out.bodyUnavailableReason = "响应体解码失败";
    } else {
      const c = clipBody(text);
      out.responseBody = c.text;
      if (c.truncated) out.bodyTruncated = true;
    }
  }
  return out;
};

// ───────────────────────── 资源计时补录（CDP 事件投递有竞态时的兜底） ─────────────────────────
//
// 为什么需要：导航提交后渲染进程里的 Network 代理比页面解析晚启用（实测约 8ms），解析最早发出的 img / css / js
// 请求可能连 requestWillBeSent / responseReceived 都收不到（只剩没有 URL 的浏览器侧 ExtraInfo / loadingFinished），
// CDP 事件本身补不出这些记录。页面自己的 Resource Timing 不依赖事件投递，能给出 URL / 类型 / 状态 / 耗时，
// 在 network op 读取前按需补进环形缓冲。

/** 页内查询表达式：在隔离世界里 Runtime.evaluate（returnByValue）。只回最近 300 条、每条只带必要字段 */
export const RESOURCE_TIMING_EXPRESSION = `(() => {
  try {
    const origin = performance.timeOrigin;
    const rows = performance.getEntriesByType("resource").slice(-300).map((e) => ({
      u: String(e.name).slice(0, 400),
      i: String(e.initiatorType || ""),
      s: Number(e.responseStatus) || 0,
      t: Math.round(origin + e.startTime),
      d: Math.round(e.duration) || 0,
    }));
    return { origin: Math.round(origin), rows };
  } catch (e) {
    return { origin: 0, rows: [] };
  }
})()`;

const EXT_TYPE = [
  [/\.css$/i, "Stylesheet"],
  [/\.(m?js|cjs)$/i, "Script"],
  [/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i, "Image"],
  [/\.(woff2?|ttf|otf|eot)$/i, "Font"],
  [/\.(mp4|webm|ogg|mp3|wav|m4a|aac|flac)$/i, "Media"],
];
const INITIATOR_TYPE = {
  img: "Image",
  image: "Image",
  script: "Script",
  fetch: "Fetch",
  xmlhttprequest: "XHR",
  iframe: "Document",
  frame: "Document",
  audio: "Media",
  video: "Media",
  track: "Media",
  beacon: "Ping",
};

/**
 * Resource Timing 的 initiatorType → 与 CDP 一致的资源类型。
 * link / css / other 这几类 initiatorType 太笼统（字体和背景图的发起者也是 css），先按扩展名推断，推断不出记 Other。
 * @param {string} initiator
 * @param {string} url
 */
export const resourceTypeOf = (initiator, url) => {
  const direct = INITIATOR_TYPE[String(initiator || "").toLowerCase()];
  if (direct) return direct;
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* 非法 URL：只能记 Other */
  }
  for (const [re, type] of EXT_TYPE) if (re.test(pathname)) return type;
  return "Other";
};

/**
 * 从资源计时里挑出「CDP 没记到」的那些（纯函数）。
 * - 只认 http(s)；since 之前开始的不要（用户 / AI clear 过之后不该又冒出旧记录）；
 * - 同一 URL 在当前文档里环里已有几条，就认为计时里有几条已被记过，多出来的才算漏记；
 *   漏记的取时间最早的那几行（根因是代理启用晚，丢的天然是最早发出的请求）；
 * - seen 是调用方持有的去重集合（环形缓冲淘汰后不会把旧的重新补一遍）；本函数会把挑中的行写进去。
 * @param {{ rows: Array<{u:string,i:string,s:number,t:number,d:number}>, origin: number,
 *           existing: Array<{url:string, ts:number}>, since?: number, seen: Set<string>, seenMax?: number }} p
 * @returns {Array<{ ts:number, method:'GET', url:string, status:number|null, type:string, durationMs:number }>}
 */
export const missedResourceEntries = ({ rows, origin, existing, since = 0, seen, seenMax = 2000 }) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const docStart = (Number.isFinite(origin) ? origin : 0) - 50;
  const have = new Map();
  for (const e of existing ?? []) {
    if (typeof e?.url !== "string" || !(e.ts >= docStart)) continue;
    have.set(e.url, (have.get(e.url) ?? 0) + 1);
  }
  const groups = new Map();
  for (const r of rows) {
    if (!r || typeof r.u !== "string" || !/^https?:/i.test(r.u)) continue;
    if (!(r.t >= since)) continue;
    const g = groups.get(r.u);
    if (g) g.push(r);
    else groups.set(r.u, [r]);
  }
  const out = [];
  for (const [url, list] of groups) {
    list.sort((a, b) => a.t - b.t);
    const missing = list.length - (have.get(url) ?? 0);
    if (missing <= 0) continue;
    let taken = 0;
    for (const r of list) {
      if (taken >= missing) break;
      const key = `${origin}|${url}|${r.t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      taken++;
      out.push({
        ts: r.t,
        method: "GET",
        url,
        status: r.s > 0 ? r.s : null,
        type: resourceTypeOf(r.i, url),
        durationMs: Math.max(0, r.d | 0),
      });
    }
  }
  while (seen.size > seenMax) seen.delete(seen.values().next().value);
  return out.sort((a, b) => a.ts - b.ts);
};
