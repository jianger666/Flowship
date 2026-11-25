/**
 * 「用户敲的网址有没有成功打开」的判定（纯逻辑，无 React / window，可在 node 里测）——地址栏记忆据此决定记不记。
 *
 * 为什么渲染侧要自己判：`navigate` 通道提交后立刻返回（页面还在加载），主进程不会再回头告诉渲染侧结果；
 * 渲染侧能看到的只有「状态推送」（主进程去抖 50ms 推一次完整的标签状态，快速的 loading 抖动会被合并掉，所以只能看稳定后的样子）。
 * 真机实测（Electron 42）各种结果下一个标签的状态长这样：
 *   - 打开了 / 404 / 500：url = 敲的地址，loading 回到 false，title 是页面标题
 *   - 重定向：url = 最终地址（≠ 敲的地址）
 *   - 打不开（连接被拒 / DNS 失败）：url **仍是敲的地址**（不是 chrome-error://）、loading 回到 false、title 是主机名——
 *     所以主进程给 TabInfo 加了 `loadFailed`，这是唯一能分出「打开了 / 打不开」的信号
 *   - 变成下载 / 被 URL 策略拦下：url 没变（还是出发时的地址）
 *   - 页面有个一直挂着的子资源：url 已经是新页面、loading 却长时间为 true
 *
 * 只记「用户自己敲的网址」：AI 导航不经过地址栏（不会 begin）、搜索词（kind=search）不 begin、无痕标签判定里直接放弃。
 */
import type { TabInfo } from "@/lib/browser-bridge-types";
import { displayBookmarkUrl } from "@/lib/browser-bookmarks";
import { normalizeHistoryUrl } from "@/lib/browser-history";

/** 提交后多久还没等到「成功 / 失败」就不再等（下载、被拦、一直挂着的请求都不该永远占着这个「待判定」槽） */
export const TYPED_VISIT_TTL_MS = 90_000;
/**
 * 页面已经离开出发地址（新文档提交了）但 loading 一直为 true 的宽限：超过它就按「已打开」算。
 * 页面里挂着一个永远不返回的子资源时 loading 会一直是 true，用户眼里这个页面早就打开了。
 * 失败的导航不会拖这么久（失败页提交时 loadFailed 同时出现）。
 */
export const TYPED_VISIT_LOADING_GRACE_MS = 10_000;

export interface PendingTypedVisit {
  /** 主进程解析后的导航目标（用户敲的网址，已补协议；不是搜索词） */
  url: string;
  /** 提交时活动标签的 id；null = 当时还没有标签（会话刚建），以后按「当时的活动标签」判断 */
  tabId: string | null;
  /** 提交时那个标签显示的地址（没有标签 = ""） */
  startUrl: string;
  /** 提交的时间，epoch 毫秒 */
  startedAt: number;
}

export type TypedVisitDropReason = "expired" | "gone" | "incognito" | "failed" | "not-web";

export type TypedVisitVerdict =
  | { action: "wait" }
  | { action: "drop"; reason: TypedVisitDropReason }
  | { action: "record"; url: string; title: string };

type VisitTab = Pick<TabInfo, "id" | "url" | "title" | "loading" | "isActive" | "incognito" | "loadFailed">;

const WAIT: TypedVisitVerdict = { action: "wait" };
const drop = (reason: TypedVisitDropReason): TypedVisitVerdict => ({ action: "drop", reason });

const isBlank = (url: string): boolean => url === "" || url === "about:blank";

const hrefOf = (url: string): string | null => {
  const n = normalizeHistoryUrl(url);
  return n.ok ? n.url : null;
};

const siteOf = (url: string): string | null => {
  const n = normalizeHistoryUrl(url);
  return n.ok ? n.hostname.toLowerCase().replace(/^www\./, "") : null;
};

/**
 * 页面标题能不能当「标题」记：
 * - 跳到了另一个站点（短链 → 目标站）的标题属于别的站，不记（联想里显示主机名）；
 * - 页面没设 `<title>` 或还没解析到时，webContents 给的是 URL 去掉协议后的样子（`127.0.0.1:8080/page`）——那不是标题。
 */
const titleFor = (typedUrl: string, tab: VisitTab): string => {
  const title = tab.title.trim();
  if (title === "") return "";
  const site = siteOf(tab.url);
  if (site === null || site !== siteOf(typedUrl)) return "";
  const lower = title.toLowerCase();
  if (lower === displayBookmarkUrl(tab.url).toLowerCase() || lower === site) return "";
  return title;
};

/**
 * 「光靠时间流逝」判定结论可能变化的下一个时刻：宽限到点（还在加载也按已打开算 → 可能变 record）、TTL 到点（→ drop）。
 * 这两个「等」不会有任何状态推送来解开（页面挂着个不返回的子资源时标签状态不再变），所以调用方要自己到点复核一次。
 * 两个时刻都过了 = 之后光靠时间不会再变，返回 null。
 */
export const nextTypedVisitCheckAt = (pending: PendingTypedVisit, now: number): number | null => {
  const marks = [pending.startedAt + TYPED_VISIT_LOADING_GRACE_MS, pending.startedAt + TYPED_VISIT_TTL_MS + 1].filter((t) => t > now);
  return marks.length > 0 ? Math.min(...marks) : null;
};

/**
 * 看一眼当前的标签状态，判断这次「用户敲的网址」该记 / 该继续等 / 该放弃。
 *
 * 结论只有三种，且 record / drop 之后调用方应清掉待判定：
 * - record：打开了——记「用户敲的地址」（不是重定向后的最终地址：下次敲同样的字还会走同样的跳转）；
 * - drop：确定不记（过期 / 标签没了 / 无痕 / 打不开 / 跳到了非网页地址）；
 * - wait：还看不出来（导航还没生效、还在加载）。
 */
export const decideTypedVisit = (pending: PendingTypedVisit, tabs: readonly VisitTab[], now: number): TypedVisitVerdict => {
  if (now - pending.startedAt > TYPED_VISIT_TTL_MS) return drop("expired");
  const tab = pending.tabId === null ? tabs.find((t) => t.isActive) : tabs.find((t) => t.id === pending.tabId);
  if (!tab) return drop("gone");
  if (tab.incognito) return drop("incognito");

  const typedHref = hrefOf(pending.url);
  if (typedHref === null) return drop("not-web"); // 主进程已过 URL 策略，到不了这里；防御

  const atTyped = hrefOf(tab.url) === typedHref;
  // 「还没离开出发地」：空白页不算离开（会话刚建、出发地址未知时标签显示的就是空白页）
  const moved = tab.url !== pending.startUrl && !isBlank(tab.url);
  const settled = !tab.loading || now - pending.startedAt >= TYPED_VISIT_LOADING_GRACE_MS;

  if (!moved) {
    // 导航还没生效（状态推送有去抖）、被 URL 策略拦下、或变成了下载——等，TTL 到了作废。
    // 例外：敲的就是当前页的地址（回车 = 重新加载），页面已经在那了：加载完且没失败就算数。
    // loadFailed 在这里只能等：它可能是上一次失败的残留（同一个地址重敲、新一轮加载还没开始），也可能是这次又失败了
    if (!atTyped || tab.loadFailed === true || !settled) return WAIT;
    return { action: "record", url: pending.url, title: titleFor(pending.url, tab) };
  }

  // 离开了出发地：新页面已提交（或错误页已提交）
  if (hrefOf(tab.url) === null) return drop("not-web"); // about: / file: / chrome-error: 等：不是网页（被后置拦截退回空白页也在这）
  if (tab.loadFailed === true) return drop("failed");
  if (!settled) return WAIT;
  return { action: "record", url: pending.url, title: titleFor(pending.url, tab) };
};
