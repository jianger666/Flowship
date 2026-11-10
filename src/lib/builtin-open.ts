/**
 * 「HTML 和网页链接默认用内置浏览器打开」的决策与流程（纯 TS、不碰 React / DOM / window，依赖全部注入，node 里可测）。
 *
 * 入口：聊天 / 产物区的 http(s) 链接（`MarkdownLink`）、本地 `.html` / `.htm` 路径（`LocalFileLink`）。
 * 默认走当前任务的内置浏览器（新标签）；以下情况**自动回退系统浏览器**：
 * - 设置里选了「系统浏览器」；
 * - 不在 Electron 桌面端（`dev:web` / 网页版没有 `window.__browser`），或壳太旧没有 `newTab`（本地 HTML 还要 `serveLocalHtml`）；
 * - 当前页面没有任务上下文（设置页 / 首页 / 任务列表…，没有任务就没有「当前任务的内置浏览器」）；
 * - 登录 / 授权类链接（OAuth / SSO / SAML / CAS…）：内置浏览器是独立档案，没有用户在系统浏览器里的登录态和密码管理器；
 *   MCP OAuth 与飞书授权本来就走各自的系统浏览器通道（`use-mcp-oauth` / server 侧 open），不经过这里；这里只兜 AI 在聊天里贴出来的授权链接；
 *   **本机 / 局域网主机（localhost、127/8、RFC1918…）不算**：`localhost:3000/login` 这类自己项目的开发页就该在内置浏览器里调试（R7-11）；
 * - 指向 Flowship 自己的地址（内置浏览器的 URL 策略本来就会拒，渲染端先判，免得点了没反应）；
 * - 本地 HTML 带行号（`x.html:12` = 源码定位，走 IDE，调用方不会走到这里）；
 * - 本地 HTML 登记失败（敏感文件 / 超大 / 不存在…）：回退到原来的「系统默认应用打开」。
 */

import type { LinkOpenMode } from "@/lib/types";

export type { LinkOpenMode };

// ───────────────────────── 设置值 ─────────────────────────

/** 默认内置（用户拍板：HTML 和网页链接默认用内置浏览器打开） */
export const DEFAULT_LINK_OPEN_MODE: LinkOpenMode = "builtin";

export const LINK_OPEN_MODES: readonly LinkOpenMode[] = ["builtin", "system"];

/** 只认显式 "system"；其余（缺省 / 脏值）一律默认内置 */
export const normalizeLinkOpenMode = (v: unknown): LinkOpenMode => (v === "system" ? "system" : DEFAULT_LINK_OPEN_MODE);

export const LINK_OPEN_MODE_LABEL: Record<LinkOpenMode, string> = {
  builtin: "内置浏览器",
  system: "系统浏览器",
};

// ───────────────────────── 登录 / 授权链接判定 ─────────────────────────

/** 主机名第一段是这些 = 身份服务（sso.corp.com / login.corp.com / passport.feishu.cn …） */
const AUTH_HOST_FIRST_LABELS = new Set([
  "sso",
  "login",
  "signin",
  "passport",
  "auth",
  "oauth",
  "idp",
  "cas",
  "accounts",
  "adfs",
  "authn",
]);

/** 已知身份域（精确或其子域） */
const AUTH_HOST_SUFFIXES = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
  "auth0.com",
  "okta.com",
  "oktapreview.com",
  "onelogin.com",
  "b2clogin.com",
  "amazoncognito.com",
  "accounts.feishu.cn",
  "passport.feishu.cn",
  "accounts.larksuite.com",
];

/** 路径**第一段**是这些 = 登录 / 授权入口（`/login`、`/oauth/authorize`、`/sso/…`、`/cas/login`…） */
const AUTH_FIRST_SEGMENTS = new Set([
  "login",
  "logon",
  "signin",
  "sign-in",
  "sign_in",
  "accounts",
  "auth",
  "oauth",
  "oauth2",
  "sso",
  "saml",
  "saml2",
  "cas",
  "authorize",
  "authorization",
  "authenticate",
  "authen",
  "openid",
  "openid-connect",
  "passport",
  "idp",
  "adfs",
]);

/**
 * 路径**任一段**（完整相等）是这些 = 登录页 / 授权端点：
 * `/api/oauth2/authorize`、`/realms/x/protocol/openid-connect/auth`、`/users/sign_in`（GitLab）、`/accounts/page/login`（飞书）、
 * `/account/login`、`/user/login?redirect=…`。
 */
const AUTH_ANY_SEGMENTS = new Set(["authorize", "oauth2", "openid-connect", "saml2", "login", "logon", "signin", "sign-in", "sign_in", "sso"]);

/** 相邻两段 = 登录页（Rails / Devise 的 `/session/new`、`/sessions/new`） */
const AUTH_SEGMENT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["session", "new"],
  ["sessions", "new"],
];

/** query 里出现 = OAuth / SAML 请求（`?client_id=…&redirect_uri=…`、`?SAMLRequest=…`） */
const AUTH_QUERY_KEYS = new Set(["redirect_uri", "response_type", "client_id", "code_challenge", "samlrequest", "samlresponse", "relaystate", "login_hint"]);

const ipv4IsLocalOrPrivate = (a: number, b: number, c: number, d: number): boolean =>
  a === 127 || // 127.0.0.0/8 回环
  a === 10 || // 10.0.0.0/8
  (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
  (a === 192 && b === 168) || // 192.168.0.0/16
  (a === 0 && b === 0 && c === 0 && d === 0); // 0.0.0.0

/**
 * 本机 / 局域网主机——**只认 `new URL(...).hostname` 规范化之后的精确形态**（R7-11）：
 * `localhost` / `*.localhost`（含 FQDN 末尾的点）、`127.0.0.0/8`、`0.0.0.0`、RFC1918（`10/8`、`172.16/12`、`192.168/16`）字面量、
 * IPv6 `[::1]` / `[::]` 与 v4-mapped（`[::ffff:7f00:1]` = 127.0.0.1）。`127.1`、`2130706433`、`0x7f.1`、`0177.0.0.1` 在 `new URL` 里已经
 * 规范成 `127.0.0.1`，自然也算。
 *
 * ⚠ 不能用 `includes` / `startsWith` / `endsWith("localhost")` 这类子串判断：`localhost.evil.com`、`127.0.0.1.evil.com`、
 * `notlocalhost` 都不是本机（`localhost@evil.com` 的 hostname 是 `evil.com`，`new URL` 已经替我们挡掉）。
 */
export const isLocalOrPrivateHost = (hostname: string): boolean => {
  let h = hostname.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1); // `localhost.` 是同一个主机的 FQDN 写法
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    return a <= 255 && b <= 255 && c <= 255 && d <= 255 && ipv4IsLocalOrPrivate(a, b, c, d);
  }
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = h.slice(1, -1);
    if (v6 === "::1" || v6 === "::") return true;
    // v4-mapped：`new URL` 把 `::ffff:127.0.0.1` 规范成 `::ffff:7f00:1`（两个十六进制组）；点分写法也兜一下
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return ipv4IsLocalOrPrivate(hi >> 8, hi & 255, lo >> 8, lo & 255);
    }
    const dotted = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v6);
    if (dotted) {
      const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
      return a <= 255 && b <= 255 && c <= 255 && d <= 255 && ipv4IsLocalOrPrivate(a, b, c, d);
    }
  }
  return false;
};

/**
 * 登录 / 授权类链接（启发式）。**误判的代价只是「改走系统浏览器」（用户本来也能点开），漏判的代价是在没有登录态的内置浏览器里卡住**，
 * 所以宁可多判：主机名第一段 / 已知身份域 / 路径第一段 / 授权端点路径 / OAuth·SAML 的 query 参数，命中任一即算。
 * 普通文档页（`/docs/oauth-guide`、`docs.github.com/en/authentication`）不会命中：路径段要**完整相等**，且多数只看第一段。
 *
 * **本机 / 局域网主机整体豁免**（R7-11）：`localhost:3000/login`、`127.0.0.1:5173/auth/callback?code=…`、`192.168.1.10:3000/signin`
 * 是 AI 调试 web 应用最常碰的页面（登录页、OAuth 回调），内置浏览器本来就是为「写代码时本地直接调试」做的——它们从来不是
 * 「要去系统浏览器、借用户登录态」的页面。只看 `new URL` 解析出的 hostname，伪装（`localhost.evil.com`、`evil.com/?next=http://localhost/login`）不豁免。
 */
export const isAuthFlowUrl = (rawUrl: string): boolean => {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (isLocalOrPrivateHost(host)) return false;
  const labels = host.split(".");
  if (labels.length > 2 && AUTH_HOST_FIRST_LABELS.has(labels[0]!)) return true;
  if (AUTH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return true;
  const segments = u.pathname
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  if (segments.length > 0 && AUTH_FIRST_SEGMENTS.has(segments[0]!)) return true;
  if (segments.some((s) => AUTH_ANY_SEGMENTS.has(s))) return true;
  if (segments.some((s, i) => AUTH_SEGMENT_PAIRS.some(([a, b]) => s === a && segments[i + 1] === b))) return true;
  // 飞书开放平台授权：open.feishu.cn/open-apis/authen/v1/index?...
  if (segments.includes("open-apis") && segments.includes("authen")) return true;
  for (const key of u.searchParams.keys()) if (AUTH_QUERY_KEYS.has(key.toLowerCase())) return true;
  return false;
};

// ───────────────────────── 站内地址判定 ─────────────────────────

/** 当前页面的 location（只要主机名 + 端口） */
export interface AppLocation {
  hostname: string;
  port: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/**
 * 链接是不是指向 Flowship 自己（同端口 + 回环别名 / 同主机名）。主进程的 `isAppUrl` 更严（http / https 都按端口判），
 * 这里只是渲染端的预判：命中就别当「内置浏览器链接」处理——内置浏览器会拒，点了没反应。
 * 用户预览自己项目的 `localhost:3000` 端口不同，不命中（与主进程口径一致）。
 */
export const isSameAppOrigin = (rawUrl: string, app: AppLocation | null | undefined): boolean => {
  if (!app) return false;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const defaultPort = u.protocol === "https:" ? "443" : "80";
  const port = u.port || defaultPort;
  const appPort = app.port || (u.protocol === "https:" ? "443" : "80");
  if (port !== appPort) return false;
  const host = u.hostname.toLowerCase();
  const appHost = app.hostname.toLowerCase();
  return host === appHost || (LOOPBACK_HOSTS.has(host) && LOOPBACK_HOSTS.has(appHost));
};

// ───────────────────────── 决策 ─────────────────────────

/** 决策依据（调用方从 window / 设置 / 桥里读出来） */
export interface BuiltinOpenEnv {
  mode: LinkOpenMode;
  /** `window.__browser?.newTab` 存在（Electron 桌面端且壳不太旧） */
  bridgeReady: boolean;
  /** `window.__browser?.serveLocalHtml` 存在（本地 HTML 才需要） */
  serveLocalHtmlReady: boolean;
  /** 当前页面有任务上下文（有已注册的浏览器面板 opener） */
  hasTask: boolean;
  app: AppLocation | null;
  /**
   * 用户显式选了内置（右键「在内置浏览器打开」）：不再按「登录 / 授权链接」启发式悄悄回退系统——显式意图优先
   * （启发式只用于「默认左键」）。站内地址 / 没有任务 / 非桌面端这些**做不到**的情况仍回退。
   */
  explicit?: boolean;
}

/** 回退到系统浏览器的原因（日志 / 测试用） */
export type SystemFallbackReason =
  | "setting-system"
  | "no-electron"
  | "no-serve-local-html"
  | "no-task"
  | "auth-flow"
  | "app-origin"
  | "not-http";

export type OpenDecision = { kind: "builtin" } | { kind: "system"; reason: SystemFallbackReason };

const SYSTEM = (reason: SystemFallbackReason): OpenDecision => ({ kind: "system", reason });

/** http(s) 链接：先判设置与环境，再判链接本身 */
export const decideHttpOpen = (url: string, env: BuiltinOpenEnv): OpenDecision => {
  if (!/^https?:\/\//i.test(url)) return SYSTEM("not-http");
  if (env.mode === "system") return SYSTEM("setting-system");
  if (!env.bridgeReady) return SYSTEM("no-electron");
  if (!env.hasTask) return SYSTEM("no-task");
  if (isSameAppOrigin(url, env.app)) return SYSTEM("app-origin");
  if (!env.explicit && isAuthFlowUrl(url)) return SYSTEM("auth-flow");
  return { kind: "builtin" };
};

/** 本地 HTML（调用方保证：是 .html / .htm、没有行号） */
export const decideLocalHtmlOpen = (env: BuiltinOpenEnv): OpenDecision => {
  if (env.mode === "system") return SYSTEM("setting-system");
  if (!env.bridgeReady) return SYSTEM("no-electron");
  if (!env.serveLocalHtmlReady) return SYSTEM("no-serve-local-html");
  if (!env.hasTask) return SYSTEM("no-task");
  return { kind: "builtin" };
};

// ───────────────────────── 流程（依赖注入） ─────────────────────────

export type ServeLocalHtmlResult = { ok: true; url: string; scope: "dir" | "file" } | { ok: false; error: string };

export interface BuiltinOpenDeps {
  env: () => BuiltinOpenEnv;
  /** 在当前任务的内置浏览器里新标签打开；false = 没有页面接单 */
  openInBuiltin: (url: string) => boolean;
  serveLocalHtml: (absPath: string) => Promise<ServeLocalHtmlResult>;
  /** 原来的行为：交给系统默认应用 / 浏览器（本地路径） */
  openSystemPath: (absPath: string) => Promise<void>;
  /** 给用户一句提示（toast）；`info` = 中性说明，`error` = 失败 */
  notify: (kind: "info" | "error", message: string) => void;
}

/** 目录过宽时只放行这一个文件，同目录的相对资源不会加载——要告诉用户，不然页面样式缺了会以为是 bug */
export const SCOPE_FILE_NOTICE = "这个 HTML 所在的目录范围太大（家目录 / 桌面 / 下载 / 临时目录等），内置浏览器只加载这一个文件，同目录的样式、脚本和图片不会加载";

/**
 * 点 http(s) 链接。返回 "builtin" = 已交给内置浏览器（调用方要 preventDefault）；"system" = 调用方走默认行为（`<a target=_blank>` → 壳转系统浏览器）。
 */
export const openHttpLink = (url: string, deps: Pick<BuiltinOpenDeps, "env" | "openInBuiltin">): "builtin" | "system" => {
  const d = decideHttpOpen(url, deps.env());
  if (d.kind !== "builtin") return "system";
  // 决策时有任务、真发请求时没有（页面刚切走）：当作系统，别吞掉点击
  return deps.openInBuiltin(url) ? "builtin" : "system";
};

/**
 * 点本地 .html / .htm（无行号）。永远会打开点什么：内置不行就回退系统默认应用（原行为）。
 * 返回最终去了哪儿，给测试 / 调用方看。
 */
export const openLocalHtml = async (absPath: string, deps: BuiltinOpenDeps): Promise<"builtin" | "system"> => {
  const d = decideLocalHtmlOpen(deps.env());
  if (d.kind !== "builtin") {
    await deps.openSystemPath(absPath);
    return "system";
  }
  let served: ServeLocalHtmlResult;
  try {
    served = await deps.serveLocalHtml(absPath);
  } catch (err) {
    served = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!served.ok) {
    deps.notify("info", `内置浏览器打不开这个文件（${served.error}），已改用系统默认方式打开`);
    await deps.openSystemPath(absPath);
    return "system";
  }
  if (!deps.openInBuiltin(served.url)) {
    await deps.openSystemPath(absPath);
    return "system";
  }
  if (served.scope === "file") deps.notify("info", SCOPE_FILE_NOTICE);
  return "builtin";
};
