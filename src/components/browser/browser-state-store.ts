/**
 * 浏览器会话状态的前端 store（无 React，可在 node 里测）
 *
 * 为什么要自己搭一个 store、而不是每个组件各自 `onState`：
 *  - 主进程对「全部任务」每 50ms 去抖推一次状态，是高频推送；任务页 / ChatView 又都很重，
 *    谁订阅了谁就重渲，所以必须在入口处做「内容没变就不通知」的浅比较（含 tabs / recent 的结构共享）；
 *  - 头部入口按钮、自动展开、面板本体都要读同一份状态，共用一个 `window.__browser.onState` 订阅
 *    （引用计数：没有任何订阅者时一个监听都不挂）；
 *  - 订阅者按 taskId 分桶：别的任务的推送不会唤醒当前任务的组件。
 */

import type {
  ActivityEntry,
  BrowserBridge,
  BrowserController,
  BrowserState,
  DialogInfo,
  DownloadInfo,
  TabInfo,
  ViewFit,
} from "@/lib/browser-bridge-types";

/** 缺省 / null 等价：都是「视图没被模拟收窄」。逐字段比（主进程每次推送都是新反序列化出来的对象，不能 `===`） */
const sameViewFit = (a: ViewFit | null | undefined, b: ViewFit | null | undefined): boolean => {
  if (!a || !b) return !a && !b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
};

const sameTab = (a: TabInfo, b: TabInfo): boolean =>
  a.id === b.id &&
  a.url === b.url &&
  a.title === b.title &&
  a.favicon === b.favicon &&
  a.loading === b.loading &&
  a.canGoBack === b.canGoBack &&
  a.canGoForward === b.canGoForward &&
  a.isActive === b.isActive &&
  // V4 的缩放标签 / 模拟标签读这两个字段：漏比的话缩放（⌘=）或模拟变了、别的字段没变时 UI 冻结（R1-12）
  a.zoom === b.zoom &&
  (a.emulation ?? null) === (b.emulation ?? null) &&
  // 遮盖占位图按它定位：漏比的话换设备 / 拖面板宽度后，遮盖图还摆在旧位置
  sameViewFit(a.viewFit, b.viewFit) &&
  // 工具栏「适应 xx%」提示读它；缺省 = 没缩放
  (a.fitScale ?? 1) === (b.fitScale ?? 1);

const sameTabs = (a: readonly TabInfo[], b: readonly TabInfo[]): boolean =>
  a.length === b.length && a.every((t, i) => sameTab(t, b[i]!));

// 条目的 id 单调递增，但同一目标连续输入会「就地合并」（summary / count / ts 变、id 不变），所以不能只比 id
// target 逐字段比（R2-14 ①）：它是对象，不能 `===`——主进程每次推送都是新反序列化出来的引用，
// 引用比会让「内容其实没变」的推送每次都唤醒订阅者；漏比则会让「只有 target 变了」的推送被吞掉
const sameTarget = (a: ActivityEntry["target"], b: ActivityEntry["target"]): boolean =>
  a?.role === b?.role && a?.name === b?.name && a?.ref === b?.ref;

const sameEntry = (a: ActivityEntry, b: ActivityEntry): boolean =>
  a.id === b.id &&
  a.ts === b.ts &&
  a.actor === b.actor &&
  a.kind === b.kind &&
  a.summary === b.summary &&
  a.count === b.count &&
  a.url === b.url &&
  a.tabId === b.tabId &&
  sameTarget(a.target, b.target);

const sameRecent = (a: readonly ActivityEntry[], b: readonly ActivityEntry[]): boolean =>
  a.length === b.length && a.every((e, i) => sameEntry(e, b[i]!));

/**
 * 下载条目逐字段比（含 received / total / state / endedAt 这些进度字段）：
 * 主进程 `will-download` 的 updated 事件往往只让 receivedBytes 变，其余都没变——不比的话进度条冻结（R1-12）。
 */
const sameDownload = (a: DownloadInfo, b: DownloadInfo): boolean =>
  a.id === b.id &&
  a.fileName === b.fileName &&
  a.path === b.path &&
  a.url === b.url &&
  a.state === b.state &&
  a.receivedBytes === b.receivedBytes &&
  a.totalBytes === b.totalBytes &&
  a.startedAt === b.startedAt &&
  a.endedAt === b.endedAt &&
  a.tabId === b.tabId;

/** 缺省（老壳）与空数组等价：都是「没有下载」 */
const sameDownloads = (
  a: readonly DownloadInfo[] | undefined,
  b: readonly DownloadInfo[] | undefined,
): boolean => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((d, i) => sameDownload(d, y[i]!));
};

/** 缺省 / null 等价：都是「没有挂起的对话框」 */
const sameDialog = (a: DialogInfo | null | undefined, b: DialogInfo | null | undefined): boolean => {
  if (!a || !b) return !a && !b;
  return (
    a.type === b.type &&
    a.message === b.message &&
    a.defaultPrompt === b.defaultPrompt &&
    a.url === b.url &&
    a.since === b.since
  );
};

/**
 * 把新推送合并进旧状态：整体没变 → 返回旧对象（引用不变，订阅者不会被唤醒）；
 * 只有 tabs / recent / downloads / dialog 没变 → 这几项沿用旧引用（面板里的 tab 条 / 时间线 / 下载列表 memo 才命得中）。
 */
export const mergeBrowserState = (
  prev: BrowserState | undefined,
  next: BrowserState,
): BrowserState => {
  if (!prev) return next;
  const tabs = sameTabs(prev.tabs, next.tabs) ? prev.tabs : next.tabs;
  const recent = sameRecent(prev.recent, next.recent) ? prev.recent : next.recent;
  const downloadsSame = sameDownloads(prev.downloads, next.downloads);
  const dialogSame = sameDialog(prev.dialog, next.dialog);
  const scalarsSame =
    prev.taskId === next.taskId &&
    prev.exists === next.exists &&
    prev.controller === next.controller &&
    (prev.askRequest?.message ?? null) === (next.askRequest?.message ?? null) &&
    (prev.askRequest?.since ?? null) === (next.askRequest?.since ?? null) &&
    prev.aiLabel === next.aiLabel &&
    prev.aiLabelAt === next.aiLabelAt &&
    prev.activeTabId === next.activeTabId &&
    prev.attached === next.attached &&
    prev.covered === next.covered &&
    prev.picking === next.picking &&
    prev.pendingUserActivity === next.pendingUserActivity &&
    // 严格相等、不把缺省当 false：缺省 = 「老壳 / 不确定」，与「窗口确实不在前台」语义不同（R1-35）；
    // 漏比的话窗口焦点变了、别的字段没变时推送被吞，isBrowserTaskForeground 读到过期值（R2-14 ①）
    prev.windowFocused === next.windowFocused;
  if (scalarsSame && tabs === prev.tabs && recent === prev.recent && downloadsSame && dialogSame) {
    return prev;
  }
  const merged: BrowserState = { ...next, tabs, recent };
  // 没变的沿用旧引用；字段本来缺省（老壳）就不凭空加 key
  if (downloadsSame && prev.downloads !== undefined && next.downloads !== undefined) {
    merged.downloads = prev.downloads;
  }
  if (dialogSame && prev.dialog && next.dialog) merged.dialog = prev.dialog;
  return merged;
};

/**
 * 「该不该惊动页面」的最小信号集：头部入口按钮的状态点 / 角标、自动展开都只看这几个字段，
 * 其余（tabs / recent / aiLabel…）变化再频繁，只要这里没变就不重渲外层。
 */
export interface BrowserSignals {
  exists: boolean;
  controller: BrowserController;
  askMessage: string | null;
  askSince: number | null;
  pendingUserActivity: number;
}

export const IDLE_SIGNALS: BrowserSignals = {
  exists: false,
  controller: "idle",
  askMessage: null,
  askSince: null,
  pendingUserActivity: 0,
};

export const deriveSignals = (state: BrowserState | null | undefined): BrowserSignals => {
  if (!state) return IDLE_SIGNALS;
  return {
    exists: state.exists,
    controller: state.controller,
    askMessage: state.askRequest?.message ?? null,
    askSince: state.askRequest?.since ?? null,
    pendingUserActivity: state.pendingUserActivity,
  };
};

export const signalsEqual = (a: BrowserSignals, b: BrowserSignals): boolean =>
  a.exists === b.exists &&
  a.controller === b.controller &&
  a.askMessage === b.askMessage &&
  a.askSince === b.askSince &&
  a.pendingUserActivity === b.pendingUserActivity;

/**
 * 状态变化的来源：
 *  - push：主进程推送 / 本地 attach 回包，是「刚发生的事」；
 *  - seed：挂载时 getState 补的初值，是「早就存在的现状」——自动展开不能把它当成「AI 刚开始操作」。
 */
export type BrowserStateSource = "push" | "seed";

type Listener = (source: BrowserStateSource) => void;

export interface BrowserStore {
  /** 读当前缓存（没收到过该任务的任何状态 = undefined） */
  getState: (taskId: string) => BrowserState | undefined;
  /** 手动灌入一份状态（attach 的回包用）；走同一套浅比较 */
  setState: (state: BrowserState) => void;
  /** 订阅某任务的状态变化；返回取消订阅。首个订阅者出现时才挂 onState，并补一次 getState */
  subscribe: (taskId: string, listener: () => void) => () => void;
  /**
   * 订阅「信号」变化（见 BrowserSignals）：只在信号真的变了才回调，带上前一份与变化来源。
   * 给自动展开这类「不渲染、只响应」的逻辑用，订阅它不会让任何组件重渲。
   */
  subscribeSignals: (
    taskId: string,
    cb: (next: BrowserSignals, prev: BrowserSignals, source: BrowserStateSource) => void,
  ) => () => void;
}

/**
 * 订阅者归零后，延后多久才真的「摘掉 onState 监听 + 清缓存」（毫秒）。
 *
 * 切任务时 React 会先跑旧页面的全部 cleanup、再跑新页面的 effect：订阅者在这一瞬间归零，
 * 立刻清缓存的话新任务的面板会先读到空缓存、闪一下「还没有浏览器会话」，等 seed 回包才恢复（R1-36）。
 * 延后一拍（setTimeout 0）：这一拍里有新订阅就取消清理——onState 一直没摘，缓存仍是新鲜的，可以直接用。
 * 摘监听与清缓存**一起**延后（不能只延后清缓存：监听先摘了，缓存就不再更新，新订阅者会读到陈旧状态）。
 */
export const STORE_TEARDOWN_DELAY_MS = 0;

/**
 * 工厂（getBridge 可注入，方便测试）。同一个 store 全应用共用一个实例，见 getBrowserStore。
 */
export const createBrowserStore = (
  getBridge: () => BrowserBridge | undefined,
  options: { teardownDelayMs?: number } = {},
): BrowserStore => {
  const teardownDelayMs = options.teardownDelayMs ?? STORE_TEARDOWN_DELAY_MS;
  const states = new Map<string, BrowserState>();
  const listeners = new Map<string, Set<Listener>>();
  const hydrated = new Set<string>();
  // 每个任务的「代」：teardown 时统一 +1。hydrate 的 getState 在途期间若发生了 teardown（订阅者归零、缓存清空），
  // 迟到的应答属于上一代、不能再写进缓存——否则它写进的是「无监听的缓存」，重新订阅后新种子又因 states.has 被丢弃，
  // 会话空闲时这份过期状态会一直显示到下一次 push（R2-14 ②）
  const epochs = new Map<string, number>();
  const epochOf = (taskId: string) => epochs.get(taskId) ?? 0;
  let total = 0;
  let unbind: (() => void) | null = null;
  let teardownTimer: ReturnType<typeof setTimeout> | null = null;

  const notify = (taskId: string, source: BrowserStateSource) => {
    const set = listeners.get(taskId);
    if (!set) return;
    // 拷贝一份再遍历：listener 里取消订阅 / 新增订阅不影响本轮
    for (const l of [...set]) l(source);
  };

  const apply = (taskId: string, incoming: BrowserState, source: BrowserStateSource) => {
    const prev = states.get(taskId);
    // 主进程推送里的 taskId 以通道参数为准，免得字段缺失 / 错位把状态写到别的任务头上
    const normalized = incoming.taskId === taskId ? incoming : { ...incoming, taskId };
    const next = mergeBrowserState(prev, normalized);
    if (next === prev) return;
    states.set(taskId, next);
    notify(taskId, source);
  };

  const hydrate = (taskId: string) => {
    if (hydrated.has(taskId)) return;
    const bridge = getBridge();
    if (!bridge) return;
    hydrated.add(taskId);
    const epoch = epochOf(taskId);
    // 挂载时补一次：推送只在状态变化时发，晚挂载的订阅者否则要等到下一次变化才有数据
    bridge
      .getState(taskId)
      .then((s) => {
        // 期间发生过 teardown：这份应答属于上一代，丢掉（新订阅会自己重新 hydrate）
        if (epochOf(taskId) !== epoch) return;
        // 回包可能晚于期间到达的推送：已有数据就不覆盖（推送一定比这份新）
        if (s && !states.has(taskId)) apply(taskId, s, "seed");
      })
      .catch(() => {
        // 上一代的失败不能动这一代的 hydrated 标记（否则会让这一代已在途 / 已完成的 hydrate 被误判为「没做过」）
        if (epochOf(taskId) !== epoch) return;
        // 旧壳 / 主进程还没就绪：当作没有会话，下一次推送会补上
        hydrated.delete(taskId);
      });
  };

  /** 真正的清理：摘 onState、清缓存（没人订阅时主进程的推送我们收不到，缓存会过期，别让下次订阅读到陈旧状态） */
  const teardown = () => {
    teardownTimer = null;
    if (total !== 0) return;
    unbind?.();
    unbind = null;
    // 先让所有在途的 hydrate 作废（见 epochs 的注释），再清缓存
    for (const taskId of hydrated) epochs.set(taskId, epochOf(taskId) + 1);
    states.clear();
    hydrated.clear();
  };

  const addListener = (taskId: string, listener: Listener): (() => void) => {
    let set = listeners.get(taskId);
    if (!set) {
      set = new Set();
      listeners.set(taskId, set);
    }
    set.add(listener);
    total += 1;
    // 订阅者归零后的清理还没执行就又有人订阅了：取消清理，沿用现有的监听与缓存
    if (teardownTimer !== null) {
      clearTimeout(teardownTimer);
      teardownTimer = null;
    }
    if (!unbind) {
      const bridge = getBridge();
      if (bridge) unbind = bridge.onState((tid, state) => apply(tid, state, "push"));
    }
    hydrate(taskId);
    return () => {
      const cur = listeners.get(taskId);
      if (!cur || !cur.delete(listener)) return;
      if (cur.size === 0) listeners.delete(taskId);
      total -= 1;
      if (total === 0 && teardownTimer === null) {
        teardownTimer = setTimeout(teardown, teardownDelayMs);
      }
    };
  };

  return {
    getState: (taskId) => states.get(taskId),
    setState: (state) => apply(state.taskId, state, "push"),
    subscribe: (taskId, listener) => addListener(taskId, () => listener()),
    subscribeSignals: (taskId, cb) => {
      let last = deriveSignals(states.get(taskId));
      return addListener(taskId, (source) => {
        const next = deriveSignals(states.get(taskId));
        if (signalsEqual(next, last)) return;
        const prev = last;
        last = next;
        cb(next, prev, source);
      });
    },
  };
};

let singleton: BrowserStore | null = null;

/** 全应用共用的 store（读 window.__browser 是惰性的，不在模块加载时碰 window，SSR 安全） */
export const getBrowserStore = (): BrowserStore => {
  if (!singleton) {
    singleton = createBrowserStore(() =>
      typeof window === "undefined" ? undefined : window.__browser,
    );
  }
  return singleton;
};

/** 当前是否有浏览器桥（桌面端 true；网页版 / SSR false）。只能在 effect / 事件回调 / useSyncExternalStore 的快照里调 */
export const isBrowserBridgeAvailable = (): boolean =>
  typeof window !== "undefined" && !!window.__browser;
