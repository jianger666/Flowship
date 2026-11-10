/**
 * 浏览器面板的展示文案 / 小判定（纯函数，可在 node 里测）
 *
 * 状态条画在 Flowship 自己的 UI 里（不在页面里），页面伪造不了；这里把「状态 → 文案」收成一处，
 * 面板只管渲染。所有文案中文，口径与契约 §11 一致。
 */

import { clipOneLine, stripFormatChars } from "@/lib/one-line";
import type {
  ActivityActor,
  ActivityEntry,
  BrowserState,
  TabInfo,
} from "@/lib/browser-bridge-types";

// stripFormatChars / clipOneLine 在 @/lib/one-line（R3-09：系统通知正文共用同一口径）；这里原样再导出，现有引用不变
export { clipOneLine, stripFormatChars };

/** 下载文件名的展示形态：剥格式 / 控制字符；剥完是空的就给占位名（只改展示，不影响传给主进程的 id） */
export const displayFileName = (name: string | null | undefined): string =>
  stripFormatChars(String(name ?? "")).trim() || "未命名文件";

/** tooltip 内容的长度上限（页面标题可达数 MB，不能整段塞进 tooltip）；R1-37 */
export const TOOLTIP_TEXT_MAX = 300;

/** 无痕标签页的说明（E2·A6）：tab 条徽章的 Tooltip 与读屏文案共用，口径与 browser_tabs 的工具描述一致 */
export const INCOGNITO_TAB_HINT = "无痕标签页：独立的内存档案，不共享登录态，关闭即销毁";

/** tab 的 Tooltip 文本：基础文本（标题 / 地址，已 clipOneLine）+ 无痕说明。非无痕原样返回 */
export const tabTooltipText = (base: string, incognito: boolean | undefined): string =>
  incognito === true ? (base ? `${base}（${INCOGNITO_TAB_HINT}）` : INCOGNITO_TAB_HINT) : base;

export type StatusBarModel =
  /** 还没有会话：不画状态条（空状态由面板自己的提示承担） */
  | { kind: "none" }
  /** 空闲；pendingNote 非空 = 用户已做了 AI 还没看到的操作 */
  | { kind: "idle"; text: string; pendingNote: string | null }
  | { kind: "ai"; text: string }
  | { kind: "user"; text: string }
  | { kind: "ask"; text: string; message: string };

/**
 * 状态条文案映射：
 *  - `AI 操作中：点击 按钮「登录」 [接管]`
 *  - `你正在操作 [交还给 AI]`
 *  - `AI 请你操作：{message} [完成] [放弃]`
 *  - 空闲
 * askRequest 优先于 controller：ask_user_to_act 挂起时主进程会把 controller 置为 user，
 * 但用户这时该看到的是「AI 在等你做某件事」，而不是普通的「你正在操作」。
 */
export const describeStatusBar = (state: BrowserState | null | undefined): StatusBarModel => {
  if (!state || !state.exists) return { kind: "none" };
  if (state.askRequest) {
    const message = clipOneLine(state.askRequest.message, 200);
    return { kind: "ask", text: `AI 请你操作：${message}`, message };
  }
  if (state.controller === "ai") {
    const label = state.aiLabel ? clipOneLine(state.aiLabel, 80) : "";
    return { kind: "ai", text: label ? `AI 操作中：${label}` : "AI 操作中" };
  }
  if (state.controller === "user") return { kind: "user", text: "你正在操作" };
  const n = state.pendingUserActivity;
  return {
    kind: "idle",
    text: "空闲",
    pendingNote: n > 0 ? `AI 还没看到你的 ${n} 步操作` : null,
  };
};

/** 活动日志里 AI / 用户 / 系统的展示名（图标与颜色在组件里按同一个 key 选） */
export const ACTIVITY_ACTOR_LABEL: Record<ActivityActor, string> = {
  ai: "AI",
  user: "你",
  system: "系统",
};

/** HH:mm:ss（本地时区）；非法时间戳返回空串 */
export const formatActivityTime = (ts: number): string => {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 时间线一行的摘要：压平空白；合并过的条目带上「×N」 */
export const describeActivity = (entry: ActivityEntry): string => {
  const base = clipOneLine(entry.summary, 160);
  return entry.count && entry.count > 1 ? `${base}（×${entry.count}）` : base;
};

/**
 * 时间线展示顺序：最新在上（recent 本身按时间正序、最多 20 条）。
 * 放最新在上是为了不用管滚动：新条目出现就在眼前，面板收窄时也不会把它挤到看不见的底部。
 */
export const orderActivityForDisplay = (recent: readonly ActivityEntry[]): ActivityEntry[] =>
  [...recent].sort((a, b) => b.id - a.id);

// ───────────────────────── favicon 白名单（R1-06 / R2-13） ─────────────────────────
//
// 这一段是主进程 `electron-app/browser/url-policy.mjs` 里 `isSafeFaviconUrl` / `isNonPublicHostname` 的**渲染端镜像**：
// 渲染端是打包进 Next 的代码，不能 import `electron-app/*.mjs`，只能手写一份纯函数；两份口径漂移就等于纵深防御名存实亡，
// 所以由 `tests/browser-favicon-parity.test.ts` 用同一张边界向量表同时喂两端、逐条断言结论一致（改这里要同步改主进程，反之亦然）。
// 两处**有意**比主进程更严（测试里单独钉死，且保证「渲染端放行 ⇒ 主进程也放行」，永远不会更松）：
//  ① 所有 IPv6 字面量一律不放（主进程会放公网 IPv6）——favicon 不会放在裸 IPv6 上；
//  ② 主机名先剥掉**全部**末尾的点再判（主进程只剥一个，`https://intranet../` 会逃过单标签 / 内网后缀判定）。

/** 整条 favicon URL 的长度上限（与主进程 FAVICON_MAX_LENGTH 同值；data: 与 https 都适用） */
export const FAVICON_MAX_LENGTH = 16_000;

/** 只放行这几种位图 / ico 的 data URL（不放 svg：svg 里能带脚本引用 / 外链）；与主进程 FAVICON_DATA_RE 同一份清单 */
const FAVICON_DATA_URL_RE = /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)[;,]/i;

/** 单标签以外、按后缀就能认出的内网 / 本机域（与主进程同一份清单） */
const NON_PUBLIC_SUFFIX_RE = /\.(?:local|localhost|internal|lan|home|corp|intranet|private)$/;

/**
 * 主机名是否「不是公网」：回环 / 私网 / 链路本地 / CGNAT / 192.0/16 / ≥224 组播与保留 / 单标签内网短名 / 内网后缀 /
 * 所有 IPv6 字面量。入参是 `URL.hostname`（WHATWG 已把 `127.1` / `0x7f.1` / 十进制整数规整成点分十进制）。
 */
export const isNonPublicHostname = (hostname: string): boolean => {
  const h = String(hostname ?? "")
    .toLowerCase()
    .replace(/\.+$/, "");
  if (h === "") return true;
  if (h.startsWith("[")) return true; // 渲染端比主进程更严：IPv6 字面量一律不放
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return (
      a === 0 || // 0.0.0.0/8
      a === 10 || // RFC1918
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
      (a === 169 && b === 254) || // link-local（含云元数据 169.254.169.254）
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) || // RFC1918
      (a === 192 && b === 0) || // 192.0.0.0/16：含 192.0.0/24（IETF 协议分配）与 192.0.2/24（文档段）；主进程是整个 192.0/16 一起拒
      a >= 224 // 组播 / 保留
    );
  }
  if (!h.includes(".")) return true; // 单标签：内网短名（router / intranet / nas）
  return NON_PUBLIC_SUFFIX_RE.test(h);
};

/** 当前应用页的 origin（SSR / 非浏览器环境没有 location → null） */
const appOriginNow = (): string | null =>
  typeof location !== "undefined" && typeof location.origin === "string" ? location.origin : null;

/**
 * favicon 的 URL 是页面可控的，而 `<img>` 画在 Flowship 自己的页面里（子资源请求带 Sec-Fetch-Site: same-origin、
 * 不带 Origin）——放行 `http://127.0.0.1:8876/api/...` 就等于让网页触发应用自己的 GET 接口（R1-06）。所以：
 *  - 只放行 `https:`（http 一律不放）与位图 / ico 的 `data:image/*`，整条不超过 {@link FAVICON_MAX_LENGTH}；
 *  - **不 trim**：主进程不 trim，前导空白的 `data:` 在主进程算「非 data」（继而被协议判定拒掉），这里也必须一样；
 *  - 用 `new URL` 解析后再判主机（见 {@link isNonPublicHostname}）；带 userinfo 的、与应用同 origin 的也拒。
 * 返回规整后的 href（实际会被加载的就是它，避免「我们判的」与「浏览器解析的」不一致）。
 */
export const safeFaviconSrc = (
  favicon: string | null | undefined,
  appOrigin: string | null = appOriginNow(),
): string | null => {
  if (typeof favicon !== "string" || favicon.length === 0 || favicon.length > FAVICON_MAX_LENGTH) return null;
  if (/^data:/i.test(favicon)) return FAVICON_DATA_URL_RE.test(favicon) ? favicon : null;
  let u: URL;
  try {
    u = new URL(favicon);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (isNonPublicHostname(u.hostname)) return null;
  if (appOrigin && u.origin === appOrigin) return null;
  return u.href;
};

/** 主进程 `isSafeFaviconUrl` 的渲染端镜像判定（给口径一致性测试用；组件里直接用 {@link safeFaviconSrc}） */
export const isSafeFaviconUrl = (url: unknown, appOrigin: string | null = appOriginNow()): boolean =>
  safeFaviconSrc(typeof url === "string" ? url : null, appOrigin) !== null;

/** 地址栏里显示的 URL：about:blank 当空地址（显示占位文案） */
export const displayAddress = (url: string | null | undefined): string => {
  if (!url || url === "about:blank") return "";
  return url;
};

const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** tab 标题：优先页面标题，其次域名，最后「新标签页」 */
export const tabDisplayTitle = (tab: Pick<TabInfo, "title" | "url" | "loading">): string => {
  // 先剥格式字符再判空：标题全是零宽 / 方向控制符时按「没有标题」处理，别留一个空标签
  const title = clipOneLine(tab.title, 60);
  if (title) return title;
  const host = hostnameOf(tab.url);
  if (host) return host;
  return tab.loading ? "加载中…" : "新标签页";
};

/** 能不能交给系统浏览器打开：只放行 http(s)（about:blank、空地址不行） */
export const isExternalOpenableUrl = (url: string | null | undefined): url is string =>
  !!url && /^https?:\/\//i.test(url);

/** 当前激活 tab（没有标注 isActive 时按 activeTabId 找，再不行取第一个） */
export const findActiveTab = (state: BrowserState | null | undefined): TabInfo | null => {
  if (!state) return null;
  return (
    state.tabs.find((t) => t.isActive) ??
    state.tabs.find((t) => t.id === state.activeTabId) ??
    state.tabs[0] ??
    null
  );
};

/**
 * 「待执行的导航」怎么落地（browser-panel 消费 pending 时用）：
 * - navigate：沿用当前标签（旧行为；没有会话时也走它——启动会话，首个标签就是目标页）；
 * - new-tab：会话已存在、且当前标签有内容时开新标签，不覆盖用户 / AI 正在看的页面；
 *   当前标签是空白页（刚启动的会话 / 刚开的新标签）就直接复用，别白留一个 about:blank。
 */
export const decidePanelOpen = (
  state: BrowserState | null | undefined,
  nav: { newTab: boolean },
): "navigate" | "new-tab" => {
  if (!nav.newTab) return "navigate";
  if (!state?.exists) return "navigate";
  const active = findActiveTab(state);
  if (!active || displayAddress(active.url) === "") return "navigate";
  return "new-tab";
};
