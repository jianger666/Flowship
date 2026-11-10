/**
 * 「把某任务的浏览器面板打开」的跨组件桥（模块级、无 React）
 *
 * 为什么需要：打开面板的状态住在任务页 / ChatView 里（task：左栏标签 + 折叠；chat：右栏开合），
 * 而发起方在别处——预览入口（workspace-actions）点「在内置浏览器打开」要「展开面板 + 导航」。
 * 做法与 composer-insert-bridge 同构：页面挂载时按 taskId 注册一个「打开」函数，发起方调 request 即可。
 */

type Opener = () => void;

const openers = new Map<string, Opener>();
/** 注册顺序（最后一个 = 当前显示着的任务页）：「当前任务」没有显式 taskId 的入口（聊天里的链接 / 产物区路径）靠它找任务 */
const order: string[] = [];
const dropFromOrder = (taskId: string) => {
  const i = order.indexOf(taskId);
  if (i >= 0) order.splice(i, 1);
};

/** 注册某任务页的「展开浏览器面板」函数；返回注销函数（只清自己那一份，不误伤后来者） */
export const registerBrowserPanelOpener = (taskId: string, opener: Opener): (() => void) => {
  openers.set(taskId, opener);
  dropFromOrder(taskId);
  order.push(taskId);
  return () => {
    if (openers.get(taskId) === opener) {
      openers.delete(taskId);
      dropFromOrder(taskId);
    }
  };
};

/**
 * 当前显示着的任务（最后注册、还没注销的那个）；没有 = 当前页面不带任务上下文（设置页 / 首页 / 任务列表…）。
 * 任务页（含 chat 模式）挂载时注册、卸载时注销，所以「有注册 = 有任务上下文」。
 */
export const getActiveBrowserTaskId = (): string | null => order[order.length - 1] ?? null;

/** 展开面板；返回是否有页面接单（false = 当前没有显示该任务的页面） */
export const requestOpenBrowserPanel = (taskId: string): boolean => {
  const opener = openers.get(taskId);
  if (!opener) return false;
  opener();
  return true;
};

/** 待执行的导航过期时间：面板挂载 / 会话启动可能要几百毫秒，但超过这个就别再执行一个早已无人记得的导航 */
export const PENDING_NAVIGATION_TTL_MS = 30_000;

/** 待执行的导航：newTab = 要在新标签里开（聊天里点链接 / 本地 HTML）；false = 在当前标签里导航（预览入口等原有行为） */
export interface PendingNavigation {
  url: string;
  newTab: boolean;
}

interface PendingNav extends PendingNavigation {
  at: number;
}

export interface OpenInBrowserOptions {
  /** 在新标签里打开（默认 false = 导航当前标签，保持原有行为） */
  newTab?: boolean;
}

const pending = new Map<string, PendingNav>();
const pendingListeners = new Map<string, Set<() => void>>();

/**
 * 「在内置浏览器打开某个地址」：登记导航意图 + 展开面板。
 * 为什么不直接 `window.__browser.navigate`：会话是懒创建的（attach 才创建），面板没挂载时还没有会话，
 * 直接 navigate 可能落空。导航由面板在视口 attach 之后消费（takePendingNavigation）。
 * 返回 false = 没有页面接单（调用方可退回系统浏览器 / 提示）。
 */
export const requestOpenInBrowser = (taskId: string, url: string, now = Date.now(), options: OpenInBrowserOptions = {}): boolean => {
  const opener = openers.get(taskId);
  if (!opener) return false;
  pending.set(taskId, { url, newTab: options.newTab === true, at: now });
  opener();
  // 面板已经挂着的话它不会再「挂载」，靠通知把导航意图推给它
  for (const l of [...(pendingListeners.get(taskId) ?? [])]) l();
  return true;
};

/**
 * 在「当前显示着的任务」的内置浏览器里打开（聊天里的链接 / 产物区路径没有 taskId，只知道自己在某个任务页里）。
 * 返回 false = 当前页面没有任务上下文（调用方回退系统浏览器）。
 */
export const requestOpenInActiveBrowser = (url: string, options: OpenInBrowserOptions = {}, now = Date.now()): boolean => {
  const taskId = getActiveBrowserTaskId();
  if (!taskId) return false;
  return requestOpenInBrowser(taskId, url, now, options);
};

/** 取走（并清掉）该任务待执行的导航请求（含 newTab 意图）；过期 / 没有返回 null */
export const takePendingNavigationRequest = (taskId: string, now = Date.now()): PendingNavigation | null => {
  const p = pending.get(taskId);
  if (!p) return null;
  pending.delete(taskId);
  return now - p.at <= PENDING_NAVIGATION_TTL_MS ? { url: p.url, newTab: p.newTab } : null;
};

/** 取走（并清掉）该任务待执行的导航地址；过期 / 没有返回 null（不关心 newTab 的旧调用方） */
export const takePendingNavigation = (taskId: string, now = Date.now()): string | null =>
  takePendingNavigationRequest(taskId, now)?.url ?? null;

/** 面板挂着时订阅「有新的待导航地址」；返回取消订阅 */
export const subscribePendingNavigation = (taskId: string, cb: () => void): (() => void) => {
  let set = pendingListeners.get(taskId);
  if (!set) {
    set = new Set();
    pendingListeners.set(taskId, set);
  }
  set.add(cb);
  return () => {
    const cur = pendingListeners.get(taskId);
    if (!cur) return;
    cur.delete(cb);
    if (cur.size === 0) pendingListeners.delete(taskId);
  };
};
