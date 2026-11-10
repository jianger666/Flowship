/**
 * 内嵌浏览器的 URL 策略（契约 §7）：纯函数、不 import electron，可直接单测。
 *
 * 为什么只拦「应用自身」而不是白名单：产品决策是 AI 可访问全部网址（对标 Playwright），
 * 真正要保护的只有 Flowship 自己的 origin（页面里的任何脚本一旦能打到本机 server，
 * 就能借 AI 浏览器触发有副作用的本机接口）和一批能碰本地文件 / 浏览器内部页的协议。
 *
 * 判定统一「先 `new URL` 解析、再按解析结果比对」，不做字符串前缀匹配：
 * `http://127.0.0.1:8876@evil/` 的真实 host 是 evil（不是应用），`http://evil@127.0.0.1:8876/` 的真实 host
 * 才是应用——前缀匹配会把这两种方向都判反（external-url.mjs 的同类单测里踩过）。
 */

import { isLoopbackHostname } from "./app-origin.mjs";

/** 地址栏里「裸词」当搜索处理时的前缀（契约 §5） */
export const SEARCH_URL_PREFIX = "https://www.bing.com/search?q=";

// 只放行这两种协议；`about:blank` 另外按「恰为」判断
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// 过长的 URL 多半是构造出来的（data 拼接 / 注入），浏览器本身也限制在 2MB 级；这里取个对人类完全够用的上限
const MAX_URL_LENGTH = 8192;

/** 应用常用的回环写法：补协议时对这些 host 默认走 http（本地 dev server 基本都没有 TLS） */
const isLoopbackLikeHost = (host) => {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(h) ||
    h === "0.0.0.0"
  );
};

/** 协议名的外观判定：`scheme:` 开头。注意 `localhost:3000` 也长这样，调用方要先排除 host:port */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// `host:port` / `a.b.c:8080/path`：端口是纯数字，这种不是协议
const HOST_PORT = /^(?:\[[0-9a-f:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*):\d{1,5}(?:[/?#]|$)/i;

/**
 * 判定一个 URL 是否允许作为「主 frame 导航目标」。
 *
 * @param {unknown} url
 * @param {{ isAppUrl?: (url: string) => boolean }} [opts] isAppUrl：本应用 origin（含回环别名）判定，由壳注入
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export const checkUrl = (url, { isAppUrl } = {}) => {
  if (typeof url !== "string") return { ok: false, reason: "URL 必须是字符串" };
  const raw = url.trim();
  if (raw === "") return { ok: false, reason: "URL 为空" };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: "URL 过长" };
  if (raw.toLowerCase() === "about:blank") return { ok: true, url: "about:blank" };

  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: `URL 无法解析：${raw.slice(0, 80)}` };
  }
  // 解析后的 protocol 才算数：`java\nscript:` 这类被 WHATWG 剥掉换行后的伪装在这里现形
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    return { ok: false, reason: `不允许访问 ${u.protocol} 协议（仅支持 http / https）` };
  }
  if (!u.hostname) return { ok: false, reason: "URL 缺少主机名" };
  // 用解析后规整的 href 判定与返回：调用方拿它去 loadURL，判定与实际导航的串就是同一个
  if (typeof isAppUrl === "function" && isAppUrl(u.href)) {
    return { ok: false, reason: "不能在内置浏览器里访问 Flowship 应用自身的地址" };
  }
  return { ok: true, url: u.href };
};

/**
 * AI 的 navigate 入参规整：无协议的补 `https://`（回环 / 本机 host 补 `http://`，本地 dev server 没有 TLS）。
 * 只做补协议，放不放行仍由 checkUrl 说了算。
 *
 * @param {unknown} input
 * @returns {string}
 */
export const normalizeAiUrl = (input) => {
  if (typeof input !== "string") return "";
  const raw = input.trim();
  if (raw === "") return "";
  if (HOST_PORT.test(raw)) return `${preferredScheme(raw)}${raw}`;
  if (HAS_SCHEME.test(raw)) return raw;
  // `//example.com/x`（协议相对）
  if (raw.startsWith("//")) return `https:${raw}`;
  return `${preferredScheme(raw)}${raw}`;
};

const preferredScheme = (raw) => {
  const host = raw.replace(/^\/\//, "").split(/[/?#:]/)[0] ?? "";
  // `[::1]:3000` 的 split 会把方括号内切碎，单独处理
  const bracket = /^\[[^\]]+\]/.exec(raw);
  return isLoopbackLikeHost(bracket ? bracket[0] : host) ? "http://" : "https://";
};

/**
 * 地址栏输入（用户路径）：像网址的当网址（补协议），其余当搜索词。
 * 「像网址」= 有协议（含 file: / javascript: 这类要被策略拒绝的，不能悄悄变成搜索）、host:port、
 * 或不含空白且带点的词（`example.com/a`）、或 localhost。
 *
 * @param {unknown} input
 * @param {{ isAppUrl?: (url: string) => boolean }} [opts]
 * @returns {{ ok: true, url: string, kind: "url" | "search" } | { ok: false, reason: string }}
 */
export const resolveUserInput = (input, opts = {}) => {
  if (typeof input !== "string") return { ok: false, reason: "地址为空" };
  const raw = input.trim();
  if (raw === "") return { ok: false, reason: "地址为空" };

  const looksLikeUrl =
    HOST_PORT.test(raw) ||
    (HAS_SCHEME.test(raw) && !/\s/.test(raw)) ||
    raw.startsWith("//") ||
    (!/\s/.test(raw) && (/^localhost(?:[/?#]|$)/i.test(raw) || /^[^\s/?#]+\.[^\s/?#]+/.test(raw)));

  if (looksLikeUrl) {
    const checked = checkUrl(normalizeAiUrl(raw), opts);
    return checked.ok ? { ok: true, url: checked.url, kind: "url" } : checked;
  }
  // 搜索词里可能夹着应用地址（"http://127.0.0.1:8876 怎么用"）：搜索 URL 本身是 bing，不会命中；照样过一遍策略保持出口唯一
  const searchUrl = `${SEARCH_URL_PREFIX}${encodeURIComponent(raw)}`;
  const checked = checkUrl(searchUrl, opts);
  return checked.ok ? { ok: true, url: checked.url, kind: "search" } : checked;
};

// ───────────────────────── favicon 白名单（评审 R1-06） ─────────────────────────
//
// favicon 的 URL 由页面决定，渲染进程会把它直接放进 <img src>（应用 origin 下、带应用的 cookie / 网络身份）。
// 放行 http 或任意主机，页面就能让「应用窗口」去 GET 本机 / 内网的任意地址（如 http://127.0.0.1:<端口>/api/…，
// 一个有副作用的 GET 就是一次 CSRF），所以这里比导航策略严得多：只认公网 https 主机，或小尺寸位图 data URL。
// 丢掉的 favicon 只是标签页少个小图标，没有任何功能损失。

/** data: 只放行位图（不收 svg：svg 可以内嵌脚本 / 外链资源） */
const FAVICON_DATA_RE = /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)[;,]/i;
const FAVICON_MAX_LENGTH = 16_000;

/**
 * 主机名是否「不是公网」：回环 / 私网 / 链路本地 / CGNAT / 单标签名（内网短名）/ .local .internal .lan 等。
 * 入参是 `URL.hostname`（WHATWG 已把 127.1 / 0x7f.1 / 十进制整数等规整成点分十进制；IPv6 保留方括号）。
 * @param {string} hostname
 */
export const isNonPublicHostname = (hostname) => {
  const h = String(hostname ?? "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (h === "") return true;
  if (isLoopbackHostname(h)) return true;
  if (h.startsWith("[")) {
    // IPv6：回环 / 未指定已在上面；唯一本地 fc00::/7、链路本地 fe80::/10、IPv4 映射 / 兼容地址一律不当公网（保守）
    return /^\[(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::ffff:|::)/.test(h) || !/^\[[0-9a-f:]+\]$/.test(h) || /^\[(?:0{0,4}:){2,}/.test(h);
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      a >= 224 // 组播 / 保留
    );
  }
  if (!h.includes(".")) return true; // 单标签：内网短名（router / intranet / nas）
  return /\.(?:local|localhost|internal|lan|home|corp|intranet|private)$/.test(h);
};

/**
 * 页面给的 favicon URL 能不能交给渲染进程去加载。
 * @param {unknown} url
 * @param {{ isAppUrl?: (url: string) => boolean }} [opts]
 */
export const isSafeFaviconUrl = (url, { isAppUrl } = {}) => {
  if (typeof url !== "string" || url.length === 0 || url.length > FAVICON_MAX_LENGTH) return false;
  if (/^data:/i.test(url)) return FAVICON_DATA_RE.test(url);
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (isNonPublicHostname(u.hostname)) return false;
  if (typeof isAppUrl === "function" && isAppUrl(u.href)) return false;
  return true;
};
