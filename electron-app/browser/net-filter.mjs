/**
 * 增强包 E2 · B1 网络列表过滤（契约 §15.2 S3）——纯逻辑，无 electron / CDP 依赖，可直接单测。
 *
 * `browser_network` 的新过滤参数：`type` / `status`（`404` | `4xx` | `failed`）/ `method` / `url_regex` / `failed_only` / `since_id` / `limit`，
 * 与旧的 `filter`（all | failed | xhr）按 AND 叠加。
 *
 * # url_regex 的 ReDoS 防护（两层，实测都有效）
 *  1. **静态校验**（{@link validateUrlRegexSource}）：长度 ≤100；拒绝回溯引用（`\1` `\k<n>`）、环视（`(?=` `(?!` `(?<=` `(?<!`）与命名组；
 *     拒绝「带量词的分组里又有量词 / 竖线」（`(a+)+$`、`(a|aa)+$` 这类指数级回溯的根源）；整条表达式最多 3 个无上界量词（`*` `+` `{n,}`），
 *     把 `a*a*a*a*b` 这类多项式回溯也压在 O(n³)；
 *  2. **vm 带 timeout 的批量执行**（{@link runRegexBatch}）：静态校验拦不住的（例如 3 个 `.*` 配 2 万字符的病态输入）由 V8 的 watchdog 打断
 *     （Node 22 实测 `(a+)+$` / `a*a*a*b` / `(a|aa)+$` 对 2 万字符都在 200ms 处被中断，isolate 不受影响），超时就报错而不是卡住主进程。
 *     整批一次 vm 调用（不是每条一次），watchdog 线程的开销摊薄。
 *
 * 另一个口径：正则匹配的是**脱敏后**的 URL（`redactUrlSecrets`）——否则 `url_regex:"token=a.*"` 就成了逐字符猜 query 里密钥的「正则预言机」。
 */
import vm from "node:vm";

export class NetFilterError extends Error {}

export const URL_REGEX_MAX_CHARS = 100;
export const URL_REGEX_MAX_UNBOUNDED = 3;
export const URL_REGEX_TIMEOUT_MS = 250;

/** CDP `Network.ResourceType` 的全集（大小写不敏感匹配 + 常见简称） */
export const NETWORK_TYPES = Object.freeze([
  "Document",
  "Stylesheet",
  "Image",
  "Media",
  "Font",
  "Script",
  "TextTrack",
  "XHR",
  "Fetch",
  "Prefetch",
  "EventSource",
  "WebSocket",
  "Manifest",
  "SignedExchange",
  "Ping",
  "CSPViolationReport",
  "Preflight",
  "Other",
]);
const TYPE_BY_LOWER = new Map(NETWORK_TYPES.map((t) => [t.toLowerCase(), t]));
const TYPE_ALIASES = Object.freeze({ ws: "WebSocket", wss: "WebSocket", sse: "EventSource", doc: "Document", js: "Script", css: "Stylesheet", img: "Image" });

/**
 * `type` 参数：单个或逗号分隔的多个（`xhr,fetch`），大小写不敏感，认常见简称（ws / sse / js / css / img / doc）。
 * @param {string} raw
 * @returns {string[]}
 */
export const parseTypeFilter = (raw) => {
  const parts = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new NetFilterError("type 不能为空");
  if (parts.length > 6) throw new NetFilterError("type 最多 6 个（逗号分隔）");
  const out = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    const t = TYPE_BY_LOWER.get(k) ?? TYPE_ALIASES[k];
    if (!t) throw new NetFilterError(`type 不认识「${p.slice(0, 30)}」：可选 ${NETWORK_TYPES.join(" / ")}（也认 ws / sse / js / css / img / doc）`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
};

/**
 * `status` 参数：`404`（精确）| `4xx`（一类）| `failed`（网络层失败：被拦截 / 连接失败 / DNS 失败等没拿到响应的请求，不含 4xx / 5xx）。
 * @param {unknown} raw
 * @returns {{ kind: "exact", code: number } | { kind: "class", digit: number } | { kind: "failed" }}
 */
export const parseStatusFilter = (raw) => {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "failed") return { kind: "failed" };
  if (/^[1-5]\d\d$/.test(s)) return { kind: "exact", code: Number(s) };
  const m = /^([1-5])xx$/.exec(s);
  if (m) return { kind: "class", digit: Number(m[1]) };
  throw new NetFilterError(`status 只能是 404 这样的状态码、4xx 这样的一类、或 failed（网络层失败），收到「${s.slice(0, 20)}」`);
};

/** @param {string} raw */
export const parseMethodFilter = (raw) => {
  const parts = String(raw)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 6) throw new NetFilterError("method 需要 1–6 个 HTTP 方法（逗号分隔），如 POST 或 POST,PUT");
  for (const p of parts) if (!/^[A-Z]{1,15}$/.test(p)) throw new NetFilterError(`method 不合法：「${p.slice(0, 20)}」`);
  return [...new Set(parts)];
};

// ───────────────────────── url_regex ─────────────────────────

/** 读 src[j] 处的量词；不是量词（含非法的 `{` 字面量）返回 null */
const readQuantifier = (src, j) => {
  const c = src[j];
  if (c === "*" || c === "+") return { len: 1, unbounded: true, multi: true };
  if (c === "?") return { len: 1, unbounded: false, multi: false };
  if (c === "{") {
    const m = /^\{(\d{1,5})(?:(,)(\d{0,5}))?\}/.exec(src.slice(j, j + 14));
    if (!m) return null;
    const unbounded = m[2] === "," && m[3] === "";
    const multi = unbounded || (m[2] === "," ? Number(m[3]) > 1 : Number(m[1]) > 1);
    return { len: m[0].length, unbounded, multi };
  }
  return null;
};

/**
 * url_regex 的静态校验（见文件头）。非法抛 {@link NetFilterError}，文案告诉模型怎么改。
 * 不做语法正确性检查（交给 `new RegExp`）：这里只拒绝「危险结构」。
 * @param {unknown} src
 */
export const validateUrlRegexSource = (src) => {
  if (typeof src !== "string" || src === "") throw new NetFilterError("url_regex 不能为空");
  if (src.length > URL_REGEX_MAX_CHARS) throw new NetFilterError(`url_regex 过长（上限 ${URL_REGEX_MAX_CHARS} 字符）`);
  const stack = [];
  let top = { hasQuant: false, hasAlt: false };
  let unbounded = 0;
  let i = 0;
  const afterAtom = () => {
    const q = readQuantifier(src, i);
    if (!q) return null;
    i += q.len;
    if (src[i] === "?") i += 1; // 惰性量词的后缀
    top.hasQuant = true;
    if (q.unbounded) unbounded += 1;
    return q;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      if (n === undefined) throw new NetFilterError("url_regex 不能以反斜杠结尾");
      if (/[1-9]/.test(n) || n === "k") throw new NetFilterError("url_regex 不支持回溯引用（\\1 / \\k<名>）");
      i += 2;
      afterAtom();
    } else if (c === "[") {
      let j = i + 1;
      if (src[j] === "^") j += 1;
      while (j < src.length && src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
      i = Math.min(j + 1, src.length);
      afterAtom();
    } else if (c === "(") {
      if (src[i + 1] === "?") {
        if (!src.startsWith("(?:", i)) throw new NetFilterError("url_regex 不支持环视 / 命名组（只允许普通分组和 (?:…) 非捕获分组）");
        i += 3;
      } else {
        i += 1;
      }
      stack.push(top);
      top = { hasQuant: false, hasAlt: false };
    } else if (c === ")") {
      const group = top;
      const parent = stack.pop();
      if (!parent) throw new NetFilterError("url_regex 括号不匹配");
      top = parent;
      i += 1;
      const q = afterAtom();
      // 带「重复多次」量词的分组，里面又有量词 / 竖线 → 指数级回溯的根源，直接拒绝
      if (q?.multi && (group.hasQuant || group.hasAlt)) {
        throw new NetFilterError("url_regex 不允许「带量词的分组里再有量词或 |」（如 (a+)+ 或 (a|b)+，会导致灾难性回溯）；请改写成不嵌套的形式");
      }
      if (group.hasQuant) top.hasQuant = true;
      if (group.hasAlt) top.hasAlt = true;
    } else if (c === "|") {
      top.hasAlt = true;
      i += 1;
    } else {
      i += 1;
      afterAtom();
    }
  }
  if (stack.length > 0) throw new NetFilterError("url_regex 括号不匹配");
  if (unbounded > URL_REGEX_MAX_UNBOUNDED) {
    throw new NetFilterError(`url_regex 太复杂：最多 ${URL_REGEX_MAX_UNBOUNDED} 个 * / + / {n,} 量词（当前 ${unbounded} 个）；改用 pattern 更具体的子串`);
  }
};

/**
 * 编译 url_regex（先静态校验、再 `new RegExp(src, "i")`）。
 * @param {unknown} src
 * @returns {RegExp}
 */
export const compileUrlRegex = (src) => {
  validateUrlRegexSource(src);
  try {
    return new RegExp(src, "i");
  } catch (err) {
    throw new NetFilterError(`url_regex 不是合法的正则：${String(err?.message ?? err).replace(/^Invalid regular expression:\s*/i, "").slice(0, 100)}`);
  }
};

/** 共享的 vm 上下文：同步使用、不跨 tick 持有，所以单例安全；超时中断之后仍可用（实测） */
let sharedCtx = null;

/**
 * 在 vm 里带 timeout 地对一批字符串跑 `re.test`（整批一次 watchdog）。超时抛 {@link NetFilterError}。
 * @param {RegExp} re
 * @param {string[]} urls
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {boolean[]}
 */
export const runRegexBatch = (re, urls, { timeoutMs = URL_REGEX_TIMEOUT_MS } = {}) => {
  if (urls.length === 0) return [];
  if (!sharedCtx) sharedCtx = vm.createContext({ re: null, urls: null, out: null });
  sharedCtx.re = re;
  sharedCtx.urls = urls;
  sharedCtx.out = null;
  try {
    vm.runInContext("out = urls.map(function (u) { re.lastIndex = 0; return re.test(u); })", sharedCtx, { timeout: timeoutMs });
    return Array.from(sharedCtx.out, Boolean);
  } catch (err) {
    if (err?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new NetFilterError(`url_regex 匹配超时（>${timeoutMs}ms，正则过于复杂）：请简化或改用更具体的子串`);
    }
    throw new NetFilterError(`url_regex 执行失败：${String(err?.message ?? err).slice(0, 100)}`);
  } finally {
    sharedCtx.re = null;
    sharedCtx.urls = null;
    sharedCtx.out = null;
  }
};

// ───────────────────────── 参数规整 / 选择 ─────────────────────────

const wrap = (h, fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof NetFilterError) throw h.bad(err.message);
    throw err;
  }
};

/**
 * `network` op 的参数规整（index.mjs normalize 调；`h` 是 OP_HELPERS）。旧参数 filter / limit / clear 行为不变；新参数全部可选。
 * 返回值里 `urlRegex` 只是通过校验的**源串**（真正的编译在 {@link selectNetworkEntries}，每次调用编一次）。
 * @param {Record<string, unknown>} args
 * @param {any} h
 */
export const normalizeNetworkArgs = (args, h, { defaultLimit = 50 } = {}) => {
  const out = {
    filter: h.optEnum(args, "filter", ["all", "failed", "xhr"], "all"),
    limit: h.optNum(args, "limit", { min: 1, max: 500, dflt: defaultLimit }),
    clear: h.optBool(args, "clear", false),
  };
  const type = h.optStr(args, "type", 200);
  if (type !== undefined) out.types = wrap(h, () => parseTypeFilter(type));
  if (args.status !== undefined && args.status !== null && args.status !== "") out.status = wrap(h, () => parseStatusFilter(args.status));
  const method = h.optStr(args, "method", 100);
  if (method !== undefined) out.methods = wrap(h, () => parseMethodFilter(method));
  const urlRegex = h.optStr(args, "urlRegex", 1000);
  if (urlRegex !== undefined) {
    wrap(h, () => validateUrlRegexSource(urlRegex));
    wrap(h, () => compileUrlRegex(urlRegex)); // 语法错误尽早报
    out.urlRegex = urlRegex;
  }
  const failedOnly = h.optBool(args, "failedOnly", undefined);
  if (failedOnly === true) out.failedOnly = true;
  const sinceId = h.optNum(args, "sinceId", { min: 0, max: 2 ** 31, dflt: undefined });
  if (sinceId !== undefined) out.sinceId = sinceId;
  return out;
};

/** 网络层失败：loadingFailed 且非「被取消」（entry.failed 且带 errorText）；4xx / 5xx 不算 */
export const isNetworkLayerFailure = (e) => e?.failed === true && typeof e.errorText === "string" && e.errorText !== "";

const matchStatus = (e, s) => {
  if (s.kind === "failed") return isNetworkLayerFailure(e);
  if (typeof e.status !== "number") return false;
  return s.kind === "exact" ? e.status === s.code : Math.floor(e.status / 100) === s.digit;
};

/**
 * 按 query 选条目（纯函数；`redactUrl` 注入，url_regex 对脱敏后的 URL 匹配）。
 *  · 没有 since_id：取满足条件的**最近** limit 条（旧行为）；
 *  · 有 since_id：取 id 大于它的、满足条件的**最早** limit 条（可翻页），`hasMore` 说明后面还有；
 *  · `lastId`：下一次调用 since_id 该传的值——一页没取完时是本页最后一条的 id，取完时是环里最新的 id（不重复扫描已看过的非匹配条目）。
 * @param {Array<any>} entries 环形缓冲全部条目（id 升序）
 * @param {ReturnType<typeof normalizeNetworkArgs>} q
 * @param {{ redactUrl?: (u: string) => string }} [opts]
 * @returns {{ entries: any[], matched: number, hasMore: boolean, lastId: number }}
 */
export const selectNetworkEntries = (entries, q, { redactUrl = (u) => u } = {}) => {
  const filter = q.filter ?? "all";
  const limit = q.limit ?? 50;
  const types = q.types ? new Set(q.types) : null;
  const methods = q.methods ? new Set(q.methods) : null;
  let list = entries;
  if (q.sinceId !== undefined) list = list.filter((e) => typeof e.id === "number" && e.id > q.sinceId);
  list = list.filter((e) => {
    if (filter === "failed" && e.failed !== true) return false;
    if (filter === "xhr" && e.type !== "XHR" && e.type !== "Fetch") return false;
    if (q.failedOnly && e.failed !== true) return false;
    if (types && !types.has(e.type)) return false;
    if (methods && !methods.has(String(e.method ?? "").toUpperCase())) return false;
    if (q.status && !matchStatus(e, q.status)) return false;
    return true;
  });
  if (q.urlRegex) {
    const re = compileUrlRegex(q.urlRegex);
    const hit = runRegexBatch(
      re,
      list.map((e) => redactUrl(String(e.url ?? ""))),
    );
    list = list.filter((_, i) => hit[i]);
  }
  const matched = list.length;
  const latestId = entries.length > 0 ? (entries[entries.length - 1].id ?? 0) : (q.sinceId ?? 0);
  if (q.sinceId !== undefined) {
    const page = list.slice(0, limit);
    const hasMore = matched > limit;
    return { entries: page, matched, hasMore, lastId: hasMore ? page[page.length - 1].id : Math.max(latestId, q.sinceId) };
  }
  const page = list.slice(-limit);
  return { entries: page, matched, hasMore: false, lastId: latestId };
};
