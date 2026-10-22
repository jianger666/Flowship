/**
 * 本机请求判定（CR-01、纯函数、middleware / 测试共用）
 *
 * 背景：本 app 是单机桌面工具、API 无鉴权但带密钥读取 + shell 执行能力——
 * 除了服务端绑定 127.0.0.1（第一道闸）、再校验 Host / Origin 头（第二道闸、
 * 防 DNS rebinding：攻击者页面用自己的域名指向 127.0.0.1、Host 头会带攻击者域名）。
 *
 * 不依赖 node:*——middleware 跑在 edge-lite runtime、也方便 vitest 直测。
 */

// 允许的 loopback 主机名（IPv4 / IPv6 / localhost）
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Host 头形如 "127.0.0.1:8876" / "localhost:8876" / "[::1]:8876"——剥端口取主机名
const hostnameOf = (host: string): string => {
  const trimmed = host.trim().toLowerCase();
  // IPv6 字面量带方括号（[::1]:8876）——保留方括号形态整体比对
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end >= 0 ? trimmed.slice(0, end + 1) : trimmed;
  }
  const colon = trimmed.indexOf(":");
  return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
};

// Host 头拆 主机名（去方括号）+ 端口（无端口按 http 默认 80）
const hostPortOf = (host: string): { name: string; port: string } => {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    const name = end >= 0 ? trimmed.slice(1, end) : trimmed.slice(1);
    const rest = end >= 0 ? trimmed.slice(end + 1) : "";
    return { name, port: rest.startsWith(":") ? rest.slice(1) : "80" };
  }
  const colon = trimmed.indexOf(":");
  return colon >= 0
    ? { name: trimmed.slice(0, colon), port: trimmed.slice(colon + 1) }
    : { name: trimmed, port: "80" };
};

/** 浏览器强制设置、页面脚本改不掉的 Fetch Metadata 请求头（`Sec-Fetch-*`，都是可选的） */
export interface FetchMetadata {
  site?: string | null;
  mode?: string | null;
  dest?: string | null;
  /** 请求路径（不含 query）与方法：只用于「顶层导航例外」收窄到 OAuth 回调（第四轮 Q4-02）；不传 = 不享受例外 */
  path?: string | null;
  method?: string | null;
}

/** 唯一允许「跨站顶层导航」打进来的 API：外部授权页 302 回来的 MCP OAuth 回调 */
export const CROSS_SITE_NAVIGATE_ALLOWED_PATH = "/api/mcp-oauth/callback";

const isOAuthCallbackNavigation = (meta: FetchMetadata): boolean => {
  const path = (meta.path ?? "").trim().replace(/\/+$/, "");
  const method = (meta.method ?? "GET").trim().toUpperCase();
  return path === CROSS_SITE_NAVIGATE_ALLOWED_PATH && (method === "GET" || method === "HEAD");
};

/**
 * 是否是「别的站点的页面发来的」浏览器请求（第三轮 review V10-05；Fetch Metadata 的 `Sec-Fetch-Site`）。
 *
 * Origin 校验的洞：no-cors 的 GET 子资源（`<img>` / `<script>` / `<link>`）浏览器**不带 Origin 头**，
 * Host 又是合法 loopback，原有校验全部放行——本机另一个端口上的页面就能让用户的浏览器去打
 * `http://127.0.0.1:<端口>/api/...`。`Sec-Fetch-Site` 补上这一块：
 * - `same-origin`：本应用自己的页面（Electron 窗口 / `pnpm dev:web`）打自己的 API → 放行；
 * - `none`：用户手敲地址 / 书签 / Electron `loadURL` 的顶层导航 → 放行；
 * - `same-site`：同一站点的别的端口（端口不计入 site）的页面 → 拦；
 * - `cross-site`：别的域名的页面 → 拦；
 * - 没带该头（curl、Node fetch、hooks、飞书桥、测试、老浏览器）：不是浏览器里的跨站请求 → 照旧放行；
 * - 不认识的值：真实浏览器只会发上面四个值之一，不拦（不为未来的假想值冒误伤风险）。
 *
 * 例外（**只**对 OAuth 回调）：顶层导航（`Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document`）打
 * `GET /api/mcp-oauth/callback` 放行——外部授权页 302 回来，浏览器标的正是 `cross-site` + navigate + document。
 * 第四轮 Q4-02 前这个例外对全部 56 个 GET 路由生效（别的站点用 `window.open` / `<a>` 就能让用户浏览器
 * 顶层导航到 `/api/repo-branches?...` 触发 `git fetch --prune` 等副作用），现在收窄到回调路径；
 * 其它路径的跨站 / 同站顶层导航与 iframe / embed 一样拦。
 * 已知边界：用户在 AI 输出里点 `http://127.0.0.1:端口/api/...` 链接经系统浏览器打开时是 `Sec-Fetch-Site: none`，
 * 本闸拦不住——由 Electron 侧不对站内 `/api/` 链接 `openExternal` 来堵（main.js）。
 */
export const isBlockedCrossSiteFetch = (meta?: FetchMetadata | null): boolean => {
  const site = meta?.site?.trim().toLowerCase();
  if (site !== "cross-site" && site !== "same-site") return false;
  const mode = meta?.mode?.trim().toLowerCase();
  const dest = meta?.dest?.trim().toLowerCase();
  if (mode === "navigate" && dest === "document" && meta && isOAuthCallbackNavigation(meta)) {
    return false;
  }
  return true;
};

/**
 * 请求是否来自本机页面：
 * - Host 头缺失 / 非 loopback → 拒绝（HTTP/1.1 必带 Host、缺失即异常客户端）
 * - Origin 头存在时（fetch / XHR 必带）必须与 Host 同源（主机名 + 端口精确一致）——
 *   复审（11 轮）：只认 loopback 主机名不够，本机其它端口的 Web 服务（恶意本地页 /
 *   被投毒的文档站）能以 http://127.0.0.1:任意端口 为 Origin 打进来（本机跨端口
 *   CSRF：读密钥 / 改 previewCommand → RCE 链）。同源 fetch 的 Origin 恒等于页面
 *   自身 host，收紧不影响正常前端。
 *   "null" origin（沙箱 iframe 等）拒绝；顶层导航（如 OAuth callback GET）无 Origin、放行
 */
export const isAllowedLocalRequest = (
  host: string | null,
  origin: string | null,
  fetchMeta?: FetchMetadata,
): boolean => {
  if (!host || !LOOPBACK_HOSTS.has(hostnameOf(host))) return false;
  if (isBlockedCrossSiteFetch(fetchMeta)) return false;
  if (origin !== null && origin !== "") {
    if (origin === "null") return false;
    try {
      const url = new URL(origin);
      const originName = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      const originPort =
        url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
      const hostPart = hostPortOf(host);
      if (originName !== hostPart.name || originPort !== hostPart.port) {
        return false;
      }
    } catch {
      return false; // Origin 头格式非法、拒绝
    }
  }
  return true;
};
