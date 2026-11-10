/**
 * 增强包 E2 · A1 登录态（契约 §15.2 S2）的纯逻辑：值脱敏、cookie / storage 条目规整、导入导出文件的 schema 校验与净化、
 * 文件名净化、落盘 / 读盘（fs 可注入，便于用临时目录单测权限与符号链接）。
 *
 * 为什么单独成模块：`ops/storage.mjs` 只管参数校验与 CDP / session.cookies 编排；凡是「判定 / 净化 / 限额」都在这里，
 * 这样「恶意导入文件」「路径穿越」「符号链接」「Flowship origin」这类安全用例可以不起 Electron 直接单测。
 *
 * 安全口径（红线 §15.3 的 1 / 4 / 7 / 8）：
 *  - 默认只给「名字与属性 + 脱敏值」，明文由 `storageAccess` 开关控制（开关在 ops 里判，这里只提供 `actionNeedsAccess`）；
 *  - 导入 / 导出文件只在 `<userData>/data/tasks/<taskId>/browser-state/` 下，文件名只能是 `[A-Za-z0-9._-]`，AI 给的任何字符串都不会成为路径；
 *  - 写盘 0600 / 目录 0700、先写临时文件再 rename（rename 不跟随目标处的符号链接）、条数 / 体积有上限、旧文件自动清理；
 *  - 读盘用 `O_NOFOLLOW` 打开并 fstat 校验（目标是符号链接 / 非普通文件 / 超限一律拒绝）；
 *  - 文件里每条 cookie 的 URL 过 `checkUrl`（Flowship origin / 非 http(s) 一律拒绝），整个文件任何一条不合格就整体拒绝（不做部分导入）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";

// ───────────────────────── 常量 ─────────────────────────

export const STORAGE_ACTIONS = Object.freeze([
  "cookies_list",
  "cookies_get",
  "cookies_set",
  "cookies_delete",
  "cookies_clear",
  "storage_list",
  "storage_get",
  "storage_set",
  "storage_remove",
  "storage_clear",
  "idb_list",
  "export_state",
  "import_state",
  "clear_site",
]);

/** 无论如何都要 `storageAccess` 的动作（写 / 删 / 清 / 导入 / 导出）；它们同时是「动作类」，走 session.runAction */
export const STORAGE_WRITE_ACTIONS = Object.freeze([
  "cookies_set",
  "cookies_delete",
  "cookies_clear",
  "storage_set",
  "storage_remove",
  "storage_clear",
  "export_state",
  "import_state",
  "clear_site",
]);

/** 带 `reveal:true` 才返回明文的读动作（明文也要 `storageAccess`） */
export const STORAGE_REVEAL_ACTIONS = Object.freeze(["cookies_list", "cookies_get", "storage_list", "storage_get"]);

export const STORAGE_AREAS = Object.freeze(["local", "session"]);
export const COOKIE_SAME_SITE = Object.freeze(["lax", "strict", "none", "unspecified"]);

export const STATE_DIR_NAME = "browser-state";
/** 列表最多返回多少条（其余只给总数） */
export const MAX_LIST_ENTRIES = 200;
/** 明文值单条上限（超出截断并标注，防止一个巨大的 localStorage 值撑爆上下文） */
export const MAX_REVEAL_VALUE_CHARS = 2000;
export const MAX_COOKIE_NAME_CHARS = 256;
export const MAX_COOKIE_VALUE_CHARS = 4096;
export const MAX_COOKIE_DOMAIN_CHARS = 253;
export const MAX_COOKIE_PATH_CHARS = 1024;
export const MAX_STORAGE_KEY_CHARS = 1000;
/** AI 写 storage 的值上限（localStorage 本身有 ~5MB 配额，这里不让一次调用塞太多） */
export const MAX_STORAGE_VALUE_CHARS = 100_000;
/** 导入 / 导出文件：条数与体积上限 */
export const MAX_STATE_COOKIES = 3000;
export const MAX_STATE_ORIGINS = 20;
export const MAX_STATE_ITEMS_PER_ORIGIN = 1000;
export const MAX_STATE_BYTES = 4 * 1024 * 1024;
/** browser-state 目录里最多留几个文件、最长留多久（导出的是明文凭据：不能无限堆积） */
export const STATE_KEEP_FILES = 30;
export const STATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const STATE_FILE_BASE_MAX = 60;
export const STATE_FILE_VERSION = 1;

// 刻意匹配 C0 / DEL 控制字符
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const FORMAT_CHARS_RE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\u{E0000}-\u{E007F}\u2028\u2029]/gu;

// ───────────────────────── 开关归类 ─────────────────────────

/** 这次调用是否需要 `storageAccess`：写 / 删 / 清 / 导入导出，或读类动作带 reveal（要明文） */
export const actionNeedsAccess = (action, reveal) =>
  STORAGE_WRITE_ACTIONS.includes(action) || (reveal === true && STORAGE_REVEAL_ACTIONS.includes(action));

/** 动作类（走 runAction：串行 / 接管拒绝 / AI 归因 / 写活动日志） */
export const isWriteAction = (action) => STORAGE_WRITE_ACTIONS.includes(action);

// ───────────────────────── 值脱敏 ─────────────────────────

/** 展示用的短文本：剥格式 / 控制字符（页面可控文字不能借前缀藏东西） */
const cleanShown = (s) => String(s).replace(FORMAT_CHARS_RE, "·");

/**
 * 值脱敏：只给「长度 + 前 4 位」（契约 A1）。
 * 取舍（比契约更保守一点）：长度 ≤ 8 的值整个都藏起来、只给长度——前 4 位就占了一半以上，等于没脱敏（PIN / 短验证码 / 短 token）。
 * 长度按码点计（`Array.from`），不劈代理对。
 * @param {unknown} value
 */
export const maskValue = (value) => {
  const chars = Array.from(String(value ?? ""));
  const n = chars.length;
  if (n === 0) return "[空]";
  if (n <= 8) return `[${n} 字符]`;
  return `[${n} 字符，前 4 位「${cleanShown(chars.slice(0, 4).join(""))}」…]`;
};

/** 明文值：超长截断并带标记（返回 { value, truncated }） */
export const revealValue = (value, max = MAX_REVEAL_VALUE_CHARS) => {
  const s = String(value ?? "");
  return s.length > max ? { value: `${s.slice(0, max)}…`, truncated: true } : { value: s, truncated: false };
};

/** 名字类字段（cookie 名 / storage key / 域名）展示前的清洗：折叠控制字符、限长 */
export const cleanName = (value, max = 200) => {
  const s = cleanShown(String(value ?? "")).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

// ───────────────────────── cookie 规整 ─────────────────────────

const SAME_SITE_OUT = { lax: "lax", strict: "strict", no_restriction: "none", none: "none", unspecified: "unspecified" };
const SAME_SITE_TO_ELECTRON = { lax: "lax", strict: "strict", none: "no_restriction", unspecified: "unspecified" };

/** 任意写法的 SameSite → "lax" | "strict" | "none" | "unspecified"；认不出返回 undefined */
export const normalizeSameSite = (v) => {
  if (v === undefined || v === null || v === "") return "unspecified";
  const k = String(v).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SAME_SITE_OUT, k) ? SAME_SITE_OUT[k] : undefined;
};

/** 域名的主机部分（去前导点、转小写）；非法字符返回 null。DNS 名 / IPv4 / 带方括号的 IPv6 */
export const normalizeCookieHost = (raw) => {
  if (typeof raw !== "string") return null;
  const h = raw.trim().toLowerCase().replace(/^\.+/, "");
  if (h === "" || h.length > MAX_COOKIE_DOMAIN_CHARS) return null;
  if (/^\[[0-9a-f:.]+\]$/.test(h)) return h;
  // Chromium 的 cookie 域里 IPv6 是不带方括号的（`::1`）：统一成带括号的 URL 形态，方便拼 URL
  if (h.includes(":") && /^[0-9a-f:.]+$/.test(h)) return `[${h}]`;
  // DNS / IPv4：字母数字、连字符、下划线、点；不许连续的点、不许首尾的点 / 连字符（下划线主机名真实存在，如 my_app.local）
  if (!/^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/.test(h) || h.includes("..")) return null;
  return h;
};

/**
 * cookie 域名的「应用自身」判定。**对 loopback 域名实际不生效**（R6-13 如实记录，别再以为它能排除 localhost）：
 * cookie 不带端口，这里把域名拼成无端口的 http(s) URL 交给 isAppUrl；真实的 isAppUrl（app-origin.mjs `createIsAppUrl`）对回环主机按「端口」判——
 * 无端口 URL 落到默认端口 80 / 443，既不是 Flowship 的端口也不在已知端口表里 → `localhost` / `.localhost` / `127.0.0.1` / `[::1]` / `foo.localhost` 全部返回 false。
 * 这是有意的取舍：不能整体排除回环域，否则用户调不了自己项目 `localhost:3000` 的 cookie（app-origin.mjs 头注释要求放行）。
 * 它真正兜底的只有：域名不合法 / isAppUrl 抛错（一律当「不能碰」）、以及按主机名判定的 isAppUrl 实现（测试里的假主机名）。
 * Flowship 自己的 cookie 进不了这个分区靠的是别处：URL 策略（checkUrl + isAppUrl 按端口）拒绝带 Flowship 端口的 URL，`cookies_set` / `import_state` 带的 URL 同样过 checkUrl。
 */
export const isAppCookieDomain = (domain, isAppUrl) => {
  if (typeof isAppUrl !== "function") return false;
  const host = normalizeCookieHost(String(domain ?? ""));
  if (host === null) return true; // 域名都不合法的条目一律当「不能碰」，不让它混过
  try {
    return isAppUrl(`http://${host}/`) === true || isAppUrl(`https://${host}/`) === true;
  } catch {
    return true;
  }
};

/** cookie → 能让 `session.cookies.remove(url, name)` 匹配到它的 URL（secure 的必须用 https） */
export const cookieUrlOf = (c) => {
  const host = normalizeCookieHost(String(c?.domain ?? "")) ?? "invalid.invalid";
  const path = typeof c?.path === "string" && c.path.startsWith("/") ? c.path : "/";
  return `${c?.secure === true ? "https" : "http"}://${host}${path}`;
};

const byteLen = (s) => Buffer.byteLength(String(s), "utf8");

/**
 * Electron cookie → 内部条目（带明文 value；对外输出请走 {@link describeCookie}，它负责脱敏）。
 * @param {any} c
 */
export const normalizeCookie = (c) => {
  const name = String(c?.name ?? "");
  const value = String(c?.value ?? "");
  const exp = typeof c?.expirationDate === "number" && Number.isFinite(c.expirationDate) && c.expirationDate > 0 ? c.expirationDate : undefined;
  return {
    name,
    value,
    domain: String(c?.domain ?? ""),
    path: typeof c?.path === "string" && c.path !== "" ? c.path : "/",
    secure: c?.secure === true,
    httpOnly: c?.httpOnly === true,
    sameSite: normalizeSameSite(c?.sameSite) ?? "unspecified",
    session: c?.session === true || exp === undefined,
    ...(exp !== undefined ? { expires: exp } : {}),
    hostOnly: c?.hostOnly === true || !String(c?.domain ?? "").startsWith("."),
    size: byteLen(name) + byteLen(value),
  };
};

/**
 * 对外输出的 cookie：名字 + 属性；值默认只给脱敏提示，`reveal` 才给明文（调用方已确认 storageAccess）。
 * @param {ReturnType<typeof normalizeCookie>} c
 * @param {{ reveal?: boolean }} [opts]
 */
export const describeCookie = (c, { reveal = false } = {}) => {
  const base = {
    name: cleanName(c.name),
    domain: cleanName(c.domain),
    path: cleanName(c.path, 300),
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    session: c.session,
    ...(c.expires !== undefined ? { expires: Math.round(c.expires) } : {}),
    hostOnly: c.hostOnly,
    size: c.size,
  };
  if (!reveal) return { ...base, valueHint: maskValue(c.value) };
  const r = revealValue(c.value);
  return { ...base, value: r.value, ...(r.truncated ? { valueTruncated: true } : {}) };
};

/** web storage 条目的对外输出（同上：默认脱敏） */
export const describeStorageItem = (key, value, { reveal = false } = {}) => {
  const k = cleanName(key, 300);
  const size = String(value ?? "").length;
  if (!reveal) return { key: k, size, valueHint: maskValue(value) };
  const r = revealValue(value);
  return { key: k, size, value: r.value, ...(r.truncated ? { valueTruncated: true } : {}) };
};

// ───────────────────────── cookie 输入校验（cookies_set / 导入文件共用） ─────────────────────────

/**
 * 校验并规整一条要写入的 cookie。返回 `{ ok:true, cookie }` 或 `{ ok:false, reason }`（reason 是写给 AI / 用户看的话，不含值）。
 * - name：1–256 字符、无控制字符 / `=` / `;`；value：≤4096 字符、无控制字符 / `;`（`;` 会让浏览器把后半截当别的属性，值被截断）；
 * - domain（可选）：合法主机名，带前导点 = 域 cookie，不带 = 仅主机；path 以 `/` 开头；
 * - sameSite=none 必须 secure（浏览器会拒绝，提前说清楚）；expires 是 unix 秒（缺省 / ≤0 / null = 会话 cookie）。
 * @param {any} raw
 */
export const validateCookieInput = (raw) => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "cookie 条目必须是对象" };
  const name = raw.name;
  if (typeof name !== "string" || name === "" || name.length > MAX_COOKIE_NAME_CHARS) {
    return { ok: false, reason: `cookie 名必须是 1–${MAX_COOKIE_NAME_CHARS} 个字符的字符串` };
  }
  if (CONTROL_RE.test(name) || name.includes("=") || name.includes(";")) return { ok: false, reason: "cookie 名不能含控制字符、= 或 ;" };
  const value = raw.value === undefined || raw.value === null ? "" : raw.value;
  if (typeof value !== "string" || value.length > MAX_COOKIE_VALUE_CHARS) {
    return { ok: false, reason: `cookie 值必须是不超过 ${MAX_COOKIE_VALUE_CHARS} 个字符的字符串` };
  }
  if (CONTROL_RE.test(value) || value.includes(";")) return { ok: false, reason: "cookie 值不能含控制字符或 ;（会被浏览器截断）" };

  let domain;
  if (raw.domain !== undefined && raw.domain !== null && raw.domain !== "") {
    const host = normalizeCookieHost(raw.domain);
    if (host === null) return { ok: false, reason: "cookie 的 domain 不合法（只能是主机名，如 example.com 或 .example.com）" };
    domain = String(raw.domain).trim().startsWith(".") ? `.${host}` : host;
  }
  let path = "/";
  if (raw.path !== undefined && raw.path !== null && raw.path !== "") {
    if (typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.length > MAX_COOKIE_PATH_CHARS || CONTROL_RE.test(raw.path) || raw.path.includes(";")) {
      return { ok: false, reason: `cookie 的 path 必须以 / 开头、不超过 ${MAX_COOKIE_PATH_CHARS} 字符，且不含控制字符 / ;` };
    }
    path = raw.path;
  }
  const sameSite = normalizeSameSite(raw.sameSite);
  if (sameSite === undefined) return { ok: false, reason: "sameSite 只能是 lax / strict / none / unspecified" };
  const secure = raw.secure === true;
  if (sameSite === "none" && !secure) return { ok: false, reason: "sameSite=none 的 cookie 必须同时 secure=true（浏览器会拒绝）" };
  let expires;
  const e = raw.expires ?? raw.expirationDate;
  if (e !== undefined && e !== null) {
    if (typeof e !== "number" || !Number.isFinite(e)) return { ok: false, reason: "expires 必须是 unix 秒（数字）" };
    // 合理区间：1970 之后、2100 之前；≤0（含 Playwright 的 -1 = 会话 cookie）当会话 cookie
    if (e > 4_102_444_800) return { ok: false, reason: "expires 超出合理范围（晚于 2100 年）" };
    if (e > 0) expires = e;
  }
  return {
    ok: true,
    cookie: {
      name,
      value,
      ...(domain !== undefined ? { domain } : {}),
      path,
      secure,
      httpOnly: raw.httpOnly === true,
      sameSite,
      ...(expires !== undefined ? { expires } : {}),
    },
  };
};

/** 规整后的 cookie → `session.cookies.set` 的参数（url 另给） */
export const toElectronCookie = (cookie, url) => ({
  url,
  name: cookie.name,
  value: cookie.value,
  ...(cookie.domain !== undefined ? { domain: cookie.domain } : {}),
  path: cookie.path,
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  sameSite: SAME_SITE_TO_ELECTRON[cookie.sameSite] ?? "unspecified",
  ...(cookie.expires !== undefined ? { expirationDate: cookie.expires } : {}),
});

/** 校验后的 cookie 要写到的 URL：由 domain / path / secure 推导，没给 domain 就用调用方给的 baseUrl（当前页面或 AI 指定的 url） */
export const cookieWriteUrl = (cookie, baseUrl) => {
  if (cookie.domain === undefined) return baseUrl;
  const host = normalizeCookieHost(cookie.domain) ?? "invalid.invalid";
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`;
};

/** domain 必须能「域匹配」URL 的主机（RFC 6265 §5.1.3）：example.com 匹配 example.com 与 *.example.com */
export const domainMatchesHost = (domain, urlHost) => {
  const d = normalizeCookieHost(domain);
  const h = String(urlHost ?? "").toLowerCase().replace(/\.$/, "");
  if (d === null || h === "") return false;
  return h === d || h.endsWith(`.${d}`);
};

// ───────────────────────── 导入 / 导出文件 ─────────────────────────

/**
 * 组装导出文件内容（明文！调用方必须已确认 storageAccess）。
 * @param {{ cookies: Array<ReturnType<typeof normalizeCookie>>, origins?: Array<{ origin: string, localStorage: Array<{ name: string, value: string }> }>, now?: Date }} p
 */
export const buildStateFile = ({ cookies, origins = [], now = new Date() }) => ({
  version: STATE_FILE_VERSION,
  kind: "flowship-browser-state",
  exportedAt: now.toISOString(),
  cookies: cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    ...(c.expires !== undefined ? { expires: c.expires } : {}),
  })),
  origins: origins.map((o) => ({ origin: o.origin, localStorage: o.localStorage.map((i) => ({ name: i.name, value: i.value })) })),
});

/**
 * 解析并校验导入文件。**整体通过或整体拒绝**：任何一条 cookie 不合格（含指向 Flowship origin / 非 http(s)）都拒绝整个文件，
 * 不做部分导入——一个被篡改的文件不该有「导入了一半」的状态。
 *
 * @param {string} text
 * @param {{ checkUrl: (url: string) => { ok: boolean, reason?: string }, isAppUrl?: (url: string) => boolean, now?: () => number }} deps
 * @returns {{ ok: true, cookies: Array<{ cookie: any, url: string, expired: boolean }>, origins: Array<{ origin: string, items: Array<{ name: string, value: string }> }> } | { ok: false, reason: string }}
 */
export const parseStateFile = (text, deps) => {
  const now = deps.now ?? Date.now;
  if (typeof text !== "string") return { ok: false, reason: "文件内容不是文本" };
  if (byteLen(text) > MAX_STATE_BYTES) return { ok: false, reason: `文件超过 ${Math.round(MAX_STATE_BYTES / 1024 / 1024)}MB 上限` };
  let doc;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, reason: "文件不是合法的 JSON" };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, reason: "文件根节点必须是对象 { cookies, origins? }" };
  if (doc.version !== undefined && doc.version !== STATE_FILE_VERSION) return { ok: false, reason: `不支持的文件版本 ${String(doc.version).slice(0, 20)}（只支持 ${STATE_FILE_VERSION}）` };
  if (!Array.isArray(doc.cookies)) return { ok: false, reason: "文件里的 cookies 必须是数组" };
  if (doc.cookies.length > MAX_STATE_COOKIES) return { ok: false, reason: `cookie 条数超过上限 ${MAX_STATE_COOKIES}` };
  const originsRaw = doc.origins === undefined || doc.origins === null ? [] : doc.origins;
  if (!Array.isArray(originsRaw)) return { ok: false, reason: "文件里的 origins 必须是数组" };
  if (originsRaw.length > MAX_STATE_ORIGINS) return { ok: false, reason: `origins 条数超过上限 ${MAX_STATE_ORIGINS}` };

  const nowSec = now() / 1000;
  const cookies = [];
  for (let i = 0; i < doc.cookies.length; i += 1) {
    const raw = doc.cookies[i];
    const v = validateCookieInput(raw);
    if (!v.ok) return { ok: false, reason: `第 ${i + 1} 条 cookie 不合格：${v.reason}` };
    const cookie = v.cookie;
    // 域名必填：没有 domain 就不知道写给谁（导出文件一定带 domain）；允许另给 url（须与 domain 域匹配）
    let url;
    if (raw.url !== undefined && raw.url !== null && raw.url !== "") {
      if (typeof raw.url !== "string" || raw.url.length > 2048) return { ok: false, reason: `第 ${i + 1} 条 cookie 的 url 不合法` };
      url = raw.url;
    }
    if (cookie.domain === undefined && url === undefined) return { ok: false, reason: `第 ${i + 1} 条 cookie 缺少 domain（或 url）` };
    if (cookie.domain !== undefined && isAppCookieDomain(cookie.domain, deps.isAppUrl)) {
      return { ok: false, reason: `第 ${i + 1} 条 cookie 的域名指向 Flowship 应用自身，整个文件被拒绝` };
    }
    const writeUrl = cookieWriteUrl(cookie, url);
    const verdict = deps.checkUrl(writeUrl);
    if (!verdict.ok) return { ok: false, reason: `第 ${i + 1} 条 cookie 的目标地址被拒绝（${String(verdict.reason ?? "不允许").slice(0, 80)}），整个文件被拒绝` };
    // R6-13：文件里单独给的 url（有 domain 时它只用来做域匹配）也要过 URL 策略——Flowship 的排除靠「端口」，而 cookie 域没有端口，
    // 所以带 Flowship 端口的 url（http://localhost:8876/…）必须在这里被拒，不能因为 domain 是个无端口的 `localhost` 就混过去
    if (url !== undefined) {
      const urlVerdict = deps.checkUrl(url);
      if (!urlVerdict.ok) return { ok: false, reason: `第 ${i + 1} 条 cookie 的 url 被拒绝（${String(urlVerdict.reason ?? "不允许").slice(0, 80)}），整个文件被拒绝` };
    }
    if (cookie.domain !== undefined && url !== undefined) {
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        return { ok: false, reason: `第 ${i + 1} 条 cookie 的 url 无法解析` };
      }
      if (!domainMatchesHost(cookie.domain, host)) return { ok: false, reason: `第 ${i + 1} 条 cookie 的 url 与 domain 不匹配` };
    }
    cookies.push({ cookie, url: writeUrl, expired: cookie.expires !== undefined && cookie.expires <= nowSec });
  }

  const origins = [];
  for (let i = 0; i < originsRaw.length; i += 1) {
    const o = originsRaw[i];
    if (o === null || typeof o !== "object" || typeof o.origin !== "string") return { ok: false, reason: `第 ${i + 1} 个 origin 不合格（缺少 origin 字符串）` };
    let parsed;
    try {
      parsed = new URL(o.origin);
    } catch {
      return { ok: false, reason: `第 ${i + 1} 个 origin 无法解析` };
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== o.origin) {
      return { ok: false, reason: `第 ${i + 1} 个 origin 必须是规范的 http(s) origin（形如 https://example.com）` };
    }
    const verdict = deps.checkUrl(`${parsed.origin}/`);
    if (!verdict.ok) return { ok: false, reason: `第 ${i + 1} 个 origin 被拒绝（${String(verdict.reason ?? "不允许").slice(0, 80)}），整个文件被拒绝` };
    const list = o.localStorage === undefined || o.localStorage === null ? [] : o.localStorage;
    if (!Array.isArray(list) || list.length > MAX_STATE_ITEMS_PER_ORIGIN) {
      return { ok: false, reason: `第 ${i + 1} 个 origin 的 localStorage 必须是数组且不超过 ${MAX_STATE_ITEMS_PER_ORIGIN} 条` };
    }
    const items = [];
    for (const it of list) {
      if (it === null || typeof it !== "object" || typeof it.name !== "string" || typeof it.value !== "string") {
        return { ok: false, reason: `第 ${i + 1} 个 origin 的 localStorage 条目必须是 { name: string, value: string }` };
      }
      if (it.name.length > MAX_STORAGE_KEY_CHARS) return { ok: false, reason: `第 ${i + 1} 个 origin 的 localStorage 键名过长` };
      items.push({ name: it.name, value: it.value });
    }
    origins.push({ origin: parsed.origin, items });
  }
  return { ok: true, cookies, origins };
};

// ───────────────────────── 文件名净化 / 目录 ─────────────────────────

const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 导出文件名「主体」净化（宽松：总能得到一个能用的名字）。
 * 规则：取最后一个路径分隔符之后的部分（`../../x` 只剩 `x`）、去掉 `.json` 后缀、只留 `[A-Za-z0-9._-]`（其余换成 `_`）、
 * 去掉首尾的 `.` `-` `_`、≤60 字符、Windows 保留名加前缀；空 → 返回空串（调用方回落到「state-<时间戳>」）。
 */
export const sanitizeStateName = (raw) => {
  let s = String(raw ?? "").trim();
  s = s.slice(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1);
  // R6-26：只去一个 `.json` 会让 `x.json.json` / `a.json_.json`（去尾部 `_` 后又露出 `.json`）导出成一个
  // import_state 的严格校验不收的文件名（明文凭据的文件要等 14 天清理才消失）。
  // 所以「去后缀 → 净化 → 去首尾」整体迭代到不动点，保证返回的主体永远不以 `.json` 结尾，
  // 即 `strictStateName(sanitizeStateName(x) + ".json")` 恒通过。
  for (let i = 0; i < 8; i += 1) {
    const before = s;
    s = s.replace(/(?:\.json)+$/i, "");
    s = s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, ".").replace(/_{2,}/g, "_");
    s = s.replace(/^[._-]+/, "").replace(/[._-]+$/, "");
    if (s.length > STATE_FILE_BASE_MAX) s = s.slice(0, STATE_FILE_BASE_MAX).replace(/[._-]+$/, "");
    if (s === before) break;
  }
  if (/\.json$/i.test(s)) return "";
  if (WINDOWS_RESERVED_RE.test(s)) s = `_${s}`;
  return s;
};

/**
 * 导入时的文件名校验（严格：不净化，只接受「导出时返回的名字」原样传回）：
 * 去掉一个 `.json` 后缀后必须已经是净化后的形态，否则拒绝——避免 `../../etc/passwd` 被悄悄改写成别的文件。
 * @returns {{ ok: true, base: string } | { ok: false, reason: string }}
 */
export const strictStateName = (raw) => {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "缺少 file（导出时返回的文件名）" };
  const trimmed = raw.trim().replace(/\.json$/i, "");
  const clean = sanitizeStateName(trimmed);
  if (clean === "" || clean !== trimmed) {
    return { ok: false, reason: "file 只能是导出时返回的文件名（字母 / 数字 / . _ - ，不含路径）" };
  }
  return { ok: true, base: clean };
};

/** 默认文件名主体：`state-YYYYMMDD-HHmmss` */
export const defaultStateName = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `state-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;

/**
 * 任务的 browser-state 目录：`<userData>/data/tasks/<taskId>/browser-state`。
 * 与 server 的 `dataRoot()/tasks/<taskId>`（桌面端 FLOWSHIP_DATA_DIR = `<userData>/data`）同一位置，口径同 ops/env.mjs 的 `taskDataAllowDirs`；
 * taskId 不是安全字符（含 `..` / 分隔符）→ null，绝不拼路径。
 */
export const stateDirFor = (userData, taskId) => {
  if (typeof userData !== "string" || userData === "" || !TASK_ID_RE.test(String(taskId ?? ""))) return null;
  return nodePath.join(userData, "data", "tasks", String(taskId), STATE_DIR_NAME);
};

// ───────────────────────── 落盘 / 读盘（fs 可注入） ─────────────────────────

const unixMode = () => process.platform !== "win32";

/** 确保目录存在、是真目录（不是符号链接）、权限 0700 */
const ensureStateDir = (fs, dir) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("browser-state 不是普通目录（符号链接或文件），拒绝使用");
  if (unixMode()) fs.chmodSync(dir, 0o700);
};

/**
 * 清理旧的导出文件：只动目录里的普通 `.json` 文件；超过 keep 个（保留最新的）或比 maxAgeMs 旧的删掉。返回删除个数。
 * 导出的是明文凭据，堆积下去既占盘也扩大泄露面。
 */
export const pruneStateDir = ({ fs = nodeFs, dir, keep = STATE_KEEP_FILES, maxAgeMs = STATE_MAX_AGE_MS, now = Date.now() }) => {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const files = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const st = fs.lstatSync(nodePath.join(dir, n));
      if (st.isFile()) files.push({ n, t: st.mtimeMs });
    } catch {
      /* 刚被别人删了 */
    }
  }
  files.sort((a, b) => b.t - a.t);
  let removed = 0;
  files.forEach((f, i) => {
    if (i < keep && now - f.t <= maxAgeMs) return;
    try {
      fs.unlinkSync(nodePath.join(dir, f.n));
      removed += 1;
    } catch {
      /* 删不掉就留着，下次再说 */
    }
  });
  return removed;
};

/**
 * 写导出文件：临时文件（0600、`wx`）→ rename 到 `<dir>/<base>.json`。
 * rename 替换的是目录项本身，不会跟随目标处的符号链接去写别处；目标是目录则失败。返回 { file, bytes }。
 */
export const writeStateFile = ({ fs = nodeFs, dir, base, text, now = Date.now() }) => {
  const bytes = byteLen(text);
  if (bytes > MAX_STATE_BYTES) throw new Error(`导出内容 ${Math.round(bytes / 1024)}KB 超过 ${Math.round(MAX_STATE_BYTES / 1024 / 1024)}MB 上限（cookie / localStorage 太多），请缩小范围（去掉 all 或只导出当前站点）`);
  ensureStateDir(fs, dir);
  pruneStateDir({ fs, dir, now });
  const file = `${base}.json`;
  const finalPath = nodePath.join(dir, file);
  let existing = null;
  try {
    existing = fs.lstatSync(finalPath);
  } catch {
    existing = null;
  }
  if (existing?.isDirectory()) throw new Error("目标文件名被一个目录占用");
  const tmp = nodePath.join(dir, `.${base}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    if (unixMode()) fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, finalPath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清不掉就留给 prune */
    }
    throw err;
  }
  return { file, bytes };
};

/**
 * 读导入文件：只读 `<dir>/<base>.json`；符号链接 / 非普通文件 / 超限一律拒绝（抛 Error，message 写给 AI 看）。
 * 用 O_NOFOLLOW 打开 + fstat（不是 lstat 之后再 open：避免检查与使用之间被换成符号链接）。
 */
export const readStateFile = ({ fs = nodeFs, dir, base }) => {
  let dst;
  try {
    dst = fs.lstatSync(dir);
  } catch {
    throw new Error("还没有导出过登录状态（browser-state 目录不存在）。先用 export_state 导出一份");
  }
  if (dst.isSymbolicLink() || !dst.isDirectory()) throw new Error("browser-state 不是普通目录，拒绝读取");
  const filePath = nodePath.join(dir, `${base}.json`);
  const noFollow = typeof fs.constants?.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (err) {
    if (err?.code === "ENOENT") throw new Error(`找不到导出文件 ${base}.json（只能导入 export_state 导出到任务目录里的文件）`);
    if (err?.code === "ELOOP") throw new Error("导出文件是符号链接，拒绝读取");
    throw new Error(`无法读取导出文件：${String(err?.code ?? err?.message ?? err).slice(0, 60)}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("导出文件不是普通文件，拒绝读取");
    if (st.size > MAX_STATE_BYTES) throw new Error(`导出文件超过 ${Math.round(MAX_STATE_BYTES / 1024 / 1024)}MB 上限，拒绝读取`);
    const buf = Buffer.alloc(Math.min(st.size, MAX_STATE_BYTES) + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_STATE_BYTES) throw new Error(`导出文件超过 ${Math.round(MAX_STATE_BYTES / 1024 / 1024)}MB 上限，拒绝读取`);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
};
