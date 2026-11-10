/**
 * BrowserSession：一个 taskId 对应一份（契约 §6、§8 session.mjs）。
 *
 * 管：多 tab、视图挂载 / 停车、控制权状态机（idle / ai / user）、ask_user_to_act、活动日志接入、状态推送。
 * 不管：CDP 细节（tab.mjs）、具体动作派发（actions.mjs）、IPC 收发（index.mjs / server-channel.mjs）。
 *
 * 本文件刻意不 import electron：tab 工厂、窗口、拾取器都由 host 注入，状态机因此可以用假 tab + 假定时器直接单测。
 */
import { createDownloadRegistry, STATE_DOWNLOADS } from "./downloads.mjs";
import { makeIncognitoPartition, nextIncognitoSeq } from "./incognito.mjs";
import { decidePopup } from "./popup-policy.mjs";
import { createPromptHub } from "./prompts.mjs";
import { BrowserError } from "./server-channel.mjs";
import { livePause, pausedMessage } from "./debug-policy.mjs";

/** AI 动作结束后保持「AI 操作中」的宽限期：连续动作之间不闪烁，也防止用户在两个动作的缝隙里误点 */
export const AI_GRACE_MS = 8000;
const RECENT_COUNT = 20;
const MAX_ASK_MS = 6 * 60 * 60 * 1000;
/** 对话框竞速提前返回的动作，其原 promise 收尾最多让队列等多久 */
const STALE_ACTION_WAIT_MS = 8000;
/** 单个会话同时存在的标签页上限：每个 tab 是一个独立渲染进程 + CDP 会话，不设上限的话页面脚本一个循环 window.open 就能把整机拖垮 */
export const MAX_TABS = 20;
/** 页面（非用户）发起的新标签：滑动窗口内最多这么多个，超出的直接丢弃（正常的 target=_blank / OAuth 弹窗远低于此） */
export const PAGE_TAB_WINDOW_MS = 10_000;
export const PAGE_TAB_MAX_PER_WINDOW = 3;
/**
 * 页面发起的新标签只有在「opener 最近有真实手势」时才抢占激活（R2-06）。5 秒 = Chrome 的瞬态用户激活时长：
 * 点击之后异步（fetch().then(window.open) 的 OAuth / 支付弹窗）打开的窗口仍算用户带来的，没有手势的脚本（setInterval(window.open)）只能后台开。
 */
export const PAGE_TAB_GESTURE_MS = 5000;
/** 录制事件（binding）与 window.open 请求走不同通道，可能乱序：没查到手势时等这么久再查一次，避免用户点链接却被当成「无手势」开在后台 */
export const PAGE_TAB_GESTURE_GRACE_MS = 150;
/**
 * E2·A2：弹窗预留票的有效期。`setWindowOpenHandler`（判定）与 `createWindow`（收养）之间 Electron 要先让 Chromium 建出弹窗 wc，
 * 实测只隔几毫秒；但弹窗可能中途被取消（createWindow 永远不来），票不能一直占着 tab 名额，所以到期自动归还。
 */
export const POPUP_TICKET_TTL_MS = 5000;

const tabSeqOf = (id) => Number(String(id).slice(1)) || 0;

const hostLabel = (url) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 80);
  } catch {
    return String(url ?? "").slice(0, 80);
  }
};

/** Bounds → 取整的非负矩形；非有限数拒收（面板拖拽中可能传出 NaN） */
export const normalizeBounds = (b) => {
  if (!b || typeof b !== "object") throw new BrowserError("BAD_ARGS", "bounds 缺失");
  const vals = [b.x, b.y, b.width, b.height];
  if (!vals.every((v) => typeof v === "number" && Number.isFinite(v))) throw new BrowserError("BAD_ARGS", "bounds 必须是有限数字");
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height)),
  };
};

/** 让一个 promise 能被 signal 打断：被打断时抛 signal.reason（底层操作自己靠 ctx.check() 尽快收手） */
const raceAbort = (promise, signal) => {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
};

/**
 * @typedef {object} SessionHost
 * @property {(opts: { id: string, hooks: object, partition?: string, adopt?: { webContents: any } }) => any} createTab 建一个 tab（真实现是 new BrowserTab）。
 *   partition 缺省 = 共享持久档案；无痕标签给内存 partition，弹窗收养（adopt）时继承 opener 的 partition
 * @property {(opts: { taskId: string, tabId: string }) => string} [allocateIncognitoPartition] 分配一个无痕 partition 名（index.mjs 带复用池 / 引用计数）；缺省按 taskId + tabId + 进程内序号现生成
 * @property {() => any | null} getMainWindow 主窗口（可能不存在 / 已销毁）
 * @property {() => any} getParkingWindow 停车场窗口
 * @property {(taskId: string) => void} onChange 状态变化（manager 去抖后推给渲染进程）
 * @property {(name: string, taskId: string, data: object) => void} emitEvent 发 evt 给 server
 * @property {(taskId: string, picked: object) => void} emitPicked 拾取结果推给渲染进程
 * @property {(tab: any, cb: { onPicked: (p: object) => void, onEnd: () => void }) => { cancel: () => void }} startPicker
 * @property {(tab: any, url: string) => void} [onTabNavigateIntent]
 */

export class BrowserSession {
  #controller = "idle";

  /**
   * @param {{
   *   taskId: string,
   *   host: SessionHost,
   *   activityLog: any,
   *   graceMs?: number,
   *   now?: () => number,
   *   log?: (msg: string) => void,
   *   setTimeoutFn?: typeof setTimeout,
   *   clearTimeoutFn?: typeof clearTimeout,
   * }} deps
   */
  constructor(deps) {
    this.taskId = deps.taskId;
    this.host = deps.host;
    this.activityLog = deps.activityLog;
    this.graceMs = deps.graceMs ?? AI_GRACE_MS;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

    /** @type {Array<any>} */
    this.tabs = [];
    this.activeTabId = null;
    this.tabSeq = 0;
    /** 页面发起新标签的时间戳：按 opener tab 分桶的滑动窗口（#allowPageTab 用；后台 tab 刷屏不能耗掉前台 tab 的配额） */
    this.pageTabTimes = new Map();
    /** 每个 opener 上一次写「被限流」活动日志的时间（每个窗口最多写一条，别让刷屏页面把活动日志刷满） */
    this.pageTabDropNoteAt = new Map();
    /** E2·A2：已放行、还没收养的弹窗预留票（占 tab 名额；见 planPopup） */
    this.popupTickets = new Set();

    this.#controller = "idle";
    /** 契约 §15.1：控制权变化监听 `fn(next, prev)`（网络规则在用户接管时暂停、交还后恢复等）；见 {@link onControllerChange} */
    this.controllerListeners = new Set();
    /** R6-18：AI 即将向页面派发输入（tab.withAiInput 入口）的监听；剪贴板观察窗口据此判断「窗口内确有 AI 触发的页面动作」 */
    this.aiInputListeners = new Set();
    this.activeOps = 0;
    this.graceTimer = null;
    this.inflight = new Set();
    this.queue = Promise.resolve();
    this.ask = null;
    this.aiLabel = null;
    this.aiLabelAt = null;

    this.attached = false;
    this.bounds = null;
    this.covered = false;
    /** setCovered 的序号令牌：每次调用 / detach 自增，在途的旧调用据此自废 */
    this.coverSeq = 0;
    this.pick = null;
    this.destroyed = false;
    this.createdAt = this.now();
    /** 本会话的下载登记表（V3）：index.mjs 的 will-download 写入，`downloads` op 与状态推送读取 */
    this.downloads = createDownloadRegistry({ now: this.now });
    /** 契约 §15.1：等待用户处理的提示（HTTP 认证 / 证书错误 / 页面权限 / evaluate 授权）；状态推送里的 `prompts` 读它 */
    this.prompts = createPromptHub({
      now: this.now,
      setTimeoutFn: this.setTimeoutFn,
      clearTimeoutFn: this.clearTimeoutFn,
      onChange: () => this.#changed(),
      log: this.log,
    });
    /** 契约 §15.1：增强包 E2 各模块的会话级私有状态（key = 模块名）。模块自己负责清理（会话销毁时 `destroy()` 会调用各项的 `dispose?.()`） */
    this.ext = new Map();
  }

  /** 控制权（idle / ai / user）。所有赋值点都经这个 setter，变化时通知 {@link onControllerChange} 的监听者（监听者出错只记日志） */
  get controller() {
    return this.#controller;
  }

  set controller(next) {
    const prev = this.#controller;
    this.#controller = next;
    if (prev === next) return;
    for (const fn of [...this.controllerListeners]) {
      try {
        fn(next, prev);
      } catch (err) {
        this.log(`[browser:${this.taskId}] 控制权监听出错（已忽略）：${err?.message || err}`);
      }
    }
  }

  /** 契约 §15.1：订阅控制权变化 `fn(next, prev)`；返回取消函数。会话销毁时监听自动清空 */
  onControllerChange(fn) {
    this.controllerListeners.add(fn);
    return () => this.controllerListeners.delete(fn);
  }

  /** R6-18：订阅「AI 即将向页面派发输入」`fn()`（同步调用、出错只记日志）；返回取消函数。会话销毁时监听自动清空 */
  onAiInput(fn) {
    this.aiInputListeners.add(fn);
    return () => this.aiInputListeners.delete(fn);
  }

  /** R6-18：通知监听者「AI 即将向页面派发输入」（tab 的 onAiInput 钩子调它；监听者出错只记日志，不挡 AI 的输入） */
  notifyAiInput() {
    for (const fn of [...this.aiInputListeners]) {
      try {
        fn();
      } catch (err) {
        this.log(`[browser:${this.taskId}] AI 输入监听出错（已忽略）：${err?.message || err}`);
      }
    }
  }

  /** 标签页上限：设置里可配（契约 §15 C6，host.getMaxTabs 注入），缺省 / 非法回退 {@link MAX_TABS} */
  maxTabs() {
    const n = Number(this.host.getMaxTabs?.());
    return Number.isInteger(n) && n >= 5 && n <= 60 ? n : MAX_TABS;
  }

  /** 取 / 建某个模块的会话级私有状态 */
  getExt(key, factory) {
    if (!this.ext.has(key)) this.ext.set(key, factory());
    return this.ext.get(key);
  }

  // ───────────────────────── tab 管理 ─────────────────────────

  get activeTab() {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  }

  /** 取 tab：缺省 = 激活 tab；找不到抛 TAB_NOT_FOUND */
  getTab(tabId) {
    const id = tabId === undefined || tabId === null || tabId === "" ? this.activeTabId : String(tabId);
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) {
      throw new BrowserError(
        "TAB_NOT_FOUND",
        tabId ? `没有标签页 ${tabId}（当前：${this.tabs.map((t) => t.id).join("、") || "无"}）` : "当前没有标签页",
      );
    }
    return tab;
  }

  listTabs() {
    return this.tabs.map((t) => t.info(t.id === this.activeTabId));
  }

  #changed() {
    if (!this.destroyed) this.host.onChange(this.taskId);
  }

  /** AI 正在驱动时，AI 自己造成的导航 / 加载 / 开关 tab 不记「系统」条目——否则下一次 user_activity 会把 AI 自己的动作当成「用户做了什么」 */
  #quietSystem(kind) {
    return this.controller === "ai" && (kind === "load" || kind === "navigate" || kind === "tab_open" || kind === "tab_close");
  }

  /**
   * @param {object} entry
   * @param {{ force?: boolean }} [opts] force：不是 AI 自己造成的（页面 window.close() / 引擎回收了 tab），绕过上面的静默规则——
   *   这类事件偏偏发生在 AI 刚点完按钮的控制期里，吞掉就等于 AI 的 tab 凭空消失却没有任何记录
   */
  #logSystem(entry, { force = false } = {}) {
    if (!force && this.#quietSystem(entry.kind)) return;
    try {
      this.activityLog.addSystem(entry);
    } catch (err) {
      this.log(`[browser] 活动日志写入失败：${err?.message || err}`);
    }
  }

  #tabHooks(tabId) {
    return {
      onChange: () => this.#changed(),
      onLoaded: ({ url, title }) => {
        if (!url || url === "about:blank") return;
        this.#logSystem({
          kind: "load",
          tabId,
          url,
          summary: title ? `页面加载完成：「${title}」（${hostLabel(url)}）` : `页面加载完成：${hostLabel(url)}`,
        });
      },
      onNewTab: ({ url, openerTabId, byUser }) => {
        // 页面自己开的窗口：开成同会话新 tab（对标浏览器 target=_blank 的新标签）。
        // byUser：用户在右键菜单里点的「在新标签页打开」，同样走这里，但日志不能写成「页面打开了」
        const byPage = byUser !== true;
        // viaGesture：这个新窗口是不是由 opener 里的真实手势带来的。没有手势的（脚本自己 window.open）也会开成后台 tab，
        // 但它引出的下载不能算「我们发起的」（R1-10：否则页面能靠 window.open(下载URL) 绕过下载手势闸）
        const open = (activate, viaGesture = true) => {
          void this.openTab({ url, activate, opener: openerTabId, byPage, viaGesture }).catch((err) => {
            this.log(`[browser] 页面新窗口打开失败：${err?.message || err}`);
          });
        };
        if (!byPage) {
          open(true);
          return;
        }
        if (!this.#allowPageTab(openerTabId)) {
          // 页面在刷新标签（循环 window.open / 恶意脚本）：丢弃，不开、不抢焦点
          this.log(`[browser] 页面新窗口被限流丢弃（同一标签页 ${PAGE_TAB_WINDOW_MS / 1000} 秒内超过 ${PAGE_TAB_MAX_PER_WINDOW} 个）`);
          this.#noteDroppedPageTab(openerTabId, url);
          return;
        }
        // 页面发起的新标签只有同时满足「opener 就是当前激活 tab」与「opener 最近有真实手势」才抢占激活：
        // 后台 tab 里的脚本、前台页面没人点击就自己 setInterval(window.open) 的脚本都不能把用户正在看的 tab 换掉
        const opener = this.tabs.find((t) => t.id === openerTabId);
        const gesture = () => opener?.hadRecentGesture?.(PAGE_TAB_GESTURE_MS) === true;
        if (!this.activeTabId) {
          open(true, gesture());
        } else if (openerTabId !== this.activeTabId) {
          open(false, gesture());
        } else if (gesture()) {
          open(true, true);
        } else {
          // 手势事件可能还在路上：等一小会儿再查一次，仍没有就后台开
          this.setTimeoutFn(() => {
            if (this.destroyed) return;
            const g = gesture();
            open(this.activeTabId === openerTabId && g, g);
          }, PAGE_TAB_GESTURE_GRACE_MS);
        }
      },
      // E2·A2：页面 window.open 想保留 window.opener（见 planPopup）；返回 null = 不放行，tab 走 onNewTab 老路径
      onPopupRequest: ({ url, openerTabId }) => this.planPopup({ url, openerTabId }),
      onRecorder: (evt) => {
        try {
          if (this.activityLog.ingest(evt)) this.#changed();
        } catch (err) {
          this.log(`[browser] 录制事件处理失败：${err?.message || err}`);
        }
      },
      onBlocked: ({ url }) => {
        // 被拦的导航不进活动日志（里面可能是带 token 的 URL）；只推状态让面板有机会提示
        void url;
        this.#changed();
      },
      onDialog: ({ type, message, handled, by }) => {
        // AI 自己处理的由 dialog op 写 actor:"ai" 条目；这里再写一条 system 会让下次 user_activity 把 AI 的动作当成「发生了什么」
        if (by === "ai") {
          this.#changed();
          return;
        }
        const tab = this.tabs.find((t) => t.id === tabId);
        const kindText = { alert: "提示框", confirm: "确认框", prompt: "输入框", beforeunload: "离开确认框" }[type] ?? "对话框";
        const how = by === "user" ? `用户${handled}` : handled;
        this.#logSystem({
          kind: "dialog",
          tabId,
          url: tab?.url ?? "",
          summary: message ? `页面弹出${kindText}「${message}」，${how}` : `页面弹出${kindText}，${how}`,
        });
        this.#changed();
      },
      onDownload: ({ fileName, state, reason }) => {
        const tab = this.tabs.find((t) => t.id === tabId);
        // blocked（评审 R1-10）：被下载策略拦下，原因是我们自己写的固定文案，让 AI / 用户知道「为什么没下载」
        const summary =
          state === "completed"
            ? `下载完成：${fileName}`
            : state === "started"
              ? `开始下载：${fileName}`
              : state === "blocked"
                ? `下载被拦截：${fileName}${reason ? `（${reason}）` : ""}`
                : `下载未完成：${fileName}`;
        this.#logSystem({ kind: "download", tabId, url: tab?.url ?? "", summary });
        this.#changed();
      },
      onNeedLockSync: () => {
        const tab = this.tabs.find((t) => t.id === tabId);
        if (tab) void this.#syncTab(tab);
      },
      onAiInput: () => this.notifyAiInput(),
      onCrashed: () => {
        this.#logSystem({ kind: "load", tabId, url: "", summary: "页面进程崩溃，需要重新加载" });
        this.#changed();
      },
      onGone: (info) => {
        const tab = this.tabs.find((t) => t.id === tabId);
        if (!tab) return; // 已被 closeTab 摘掉（我们自己关的不会走到这里，兜底）
        void this.#onTabGone(tab, String(tab.lastUrl ?? ""), info?.hostGone === true).catch((err) => this.log(`[browser] 摘除已销毁的标签页失败：${err?.message || err}`));
      },
    };
  }

  /** 一个 tab 按当前控制权重新上锁 / 重画覆盖层：导航提交与加载完成时各调一次（页内状态随新文档清零） */
  async #syncTab(tab) {
    try {
      await tab.setInputIgnored(this.controller === "ai");
      if (this.controller === "ai") await tab.overlaySetActive(true, this.aiLabel ?? "AI 操作中");
    } catch {
      /* tab 正在销毁 / 页面换进程：下一次事件会再同步 */
    }
  }

  /**
   * 新开 tab。
   * incognito（E2·A6）：用一个独立的内存 partition（不共享持久档案的登录态，tab 关闭即清空）；占 tab 上限的名额，与普通标签同等计数。
   * @param {{ url?: string, activate?: boolean, opener?: string, byPage?: boolean, viaGesture?: boolean, incognito?: boolean }} opts
   */
  async openTab({ url, activate = true, opener, byPage = false, viaGesture = true, incognito = false } = {}) {
    if (this.destroyed) throw new BrowserError("NO_SESSION", "浏览器会话已关闭");
    const maxTabs = this.maxTabs();
    // 已放行但还没收养的弹窗（popupTickets）也占名额：否则「刚放行一个弹窗、紧接着 AI 开新标签」能把总数顶过上限
    if (this.tabs.length + this.popupTickets.size >= maxTabs) {
      throw new BrowserError("BAD_ARGS", `标签页已达上限（${maxTabs} 个）：请先关闭不再需要的标签页（browser_tabs close）`);
    }
    const id = `t${++this.tabSeq}`;
    const partition = incognito === true ? this.#allocateIncognito(id) : undefined;
    const tab = this.host.createTab({ id, hooks: this.#tabHooks(id), ...(partition ? { partition } : {}) });
    tab.opener = opener ?? null;
    this.tabs.push(tab);
    if (activate || !this.activeTabId) this.#activate(tab);
    const what = incognito === true ? "无痕标签页" : "新标签页";
    this.#logSystem({
      kind: "tab_open",
      tabId: id,
      url: url ?? "",
      summary: byPage ? `页面打开了${what}${url ? `：${hostLabel(url)}` : ""}` : `打开了${what}${url ? `：${hostLabel(url)}` : ""}`,
    });
    // 新 tab 在 AI 驱动期间诞生：按当前控制权上锁（desiredIgnore 在 CDP 就绪后自动生效）
    if (this.controller === "ai") void tab.setInputIgnored(true);
    this.#changed();
    if (url) {
      // 页面发起的新窗口不等加载完成（它是后台事件）；AI 的 tabs(new,url) 由调用方自己 await tab.navigate。
      // 直接调 navigate（内部 ensureCdp 会重试初始化）：以前套了 `tab.ready.then(...).catch(() => {})`，初始化失败的 tab 会把 URL 静默吞掉（R2-06）
      // viaGesture=false（页面脚本无手势自己开的窗口）：告诉 tab 这次导航不算「我们发起的」，其引出的下载照常过手势闸
      const nav = viaGesture === false ? tab.navigate(url, { browserInitiated: false }) : tab.navigate(url);
      void nav.catch((err) => this.log(`[browser] 新标签页导航失败：${err?.message || err}`));
    }
    return tab;
  }

  /** 无痕 partition 名：host 有复用池 / 引用计数就用 host 的，否则现生成一个（taskId 净化 + tabId + 进程内序号，必然匹配 INCOGNITO_PARTITION_RE） */
  #allocateIncognito(tabId) {
    const fromHost = this.host.allocateIncognitoPartition?.({ taskId: this.taskId, tabId });
    return typeof fromHost === "string" && fromHost !== "" ? fromHost : makeIncognitoPartition({ taskId: this.taskId, tabId, seq: nextIncognitoSeq() });
  }

  /**
   * E2·A2：页面 `window.open` 能不能保留 `window.opener`——判定并**同步预留**一个 tab 名额。不抛错（出任何意外都返回 null = 不放行）。
   * 由 tab 的 setWindowOpenHandler 在 URL 已过 checkUrl（含 Flowship origin 阻断）之后调用。
   *
   * 放行条件见 {@link decidePopup}：会话活着、opener 在会话里、opener 最近有真实手势（录制器手势 **或** 浏览器输入管线里的按下类输入——
   * 两者都是页面脚本伪造不了的；AI 的 CDP 点击同样产生，所以「AI 点了按钮 → 页面弹 OAuth 窗」能放行）、tab 数（含已预留的弹窗）没超上限、
   * 页面开 tab 限流没超。任何一条不满足都返回 null，tab 退回 E1 的老路径（deny + onNewTab 开成无 opener 的新标签）。
   *
   * 返回的票占一个名额，直到 adopt（转成真 tab）/ release（归还）/ {@link POPUP_TICKET_TTL_MS} 到期自动归还——
   * handler 与 createWindow 之间弹窗可能被取消，名额不能永久挂着。
   * @param {{ url: string, openerTabId: string }} req
   * @returns {{ adopt: (webContents: any) => any, release: () => void } | null}
   */
  planPopup({ url, openerTabId }) {
    try {
      const opener = this.tabs.find((t) => t.id === openerTabId) ?? null;
      const gesture =
        opener !== null &&
        (opener.hadRecentGesture?.(PAGE_TAB_GESTURE_MS) === true || opener.hadRecentTrustedInput?.(PAGE_TAB_GESTURE_MS) === true);
      const verdict = decidePopup({
        urlOk: true, // 调用方（tab 的 setWindowOpenHandler）已过 checkUrl
        sessionAlive: !this.destroyed,
        openerKnown: opener !== null,
        gesture,
        tabCount: this.tabs.length + this.popupTickets.size,
        maxTabs: this.maxTabs(),
        consumeQuota: () => this.#allowPageTab(openerTabId),
      });
      if (!verdict.allow) return null;
      const ticket = { openerTabId: String(openerTabId), url: String(url ?? ""), timer: null };
      ticket.timer = this.setTimeoutFn(() => this.#releasePopupTicket(ticket), POPUP_TICKET_TTL_MS);
      ticket.timer?.unref?.();
      this.popupTickets.add(ticket);
      return {
        adopt: (webContents) => this.openPopupTab({ opener: ticket.openerTabId, url: ticket.url, webContents, ticket }),
        release: () => this.#releasePopupTicket(ticket),
      };
    } catch (err) {
      this.log(`[browser] 弹窗判定出错，按普通新标签处理：${err?.message || err}`);
      return null;
    }
  }

  #releasePopupTicket(ticket) {
    if (!this.popupTickets.delete(ticket)) return;
    if (ticket.timer) this.clearTimeoutFn(ticket.timer);
    ticket.timer = null;
  }

  /**
   * E2·A2：把 Chromium 已建好的弹窗 webContents 收养成本会话的一个 tab（由 tab 的 `createWindow` 回调经预留票调用）。**同步**：
   * 弹窗 wc 的初始导航已经在路上，任何 await 都可能让页面在我们挂好监听前就跑过关键事件。
   *
   * - 名额：先还自己的票，再按「已有 tab + 其余票」检查上限（票过期被还掉后这里仍能兜住上限）；
   * - partition：继承 opener 的（无痕标签的弹窗仍在同一个内存 partition 里，登录态不外泄也不丢）；
   * - 激活策略：opener 是前台 tab（手势已是放行前提）才抢占激活，后台 tab 的弹窗静默开在后台；
   * - 记 `tab_open` 活动日志（actor 为系统，AI 驱动期间按 #quietSystem 静默）；`tab.opener` 记 opener，`tab.popup=true` 供关闭时回到 opener；
   * - 下载令牌：弹窗初始 URL 记成「浏览器侧已验证手势发起」，与 E1 路径里 `tab.navigate(url)` 的效果一致。
   * 抛错（会话已销毁 / opener 不在了 / 超上限 / createTab 失败）由调用方（tab 的 createWindow 回调）兜住：关掉弹窗 wc 并按普通新标签补开。
   * @param {{ opener: string, url?: string, webContents: any, ticket?: object }} p
   */
  openPopupTab({ opener: openerTabId, url, webContents, ticket }) {
    if (ticket) this.#releasePopupTicket(ticket);
    if (this.destroyed) throw new BrowserError("NO_SESSION", "浏览器会话已关闭");
    const opener = this.tabs.find((t) => t.id === openerTabId);
    if (!opener) throw new BrowserError("TAB_NOT_FOUND", "弹窗的 opener 标签页已关闭");
    const maxTabs = this.maxTabs();
    if (this.tabs.length + this.popupTickets.size >= maxTabs) {
      throw new BrowserError("BAD_ARGS", `标签页已达上限（${maxTabs} 个）`);
    }
    const id = `t${++this.tabSeq}`;
    const tab = this.host.createTab({ id, hooks: this.#tabHooks(id), partition: opener.partition, adopt: { webContents } });
    tab.opener = openerTabId;
    tab.popup = true;
    this.tabs.push(tab);
    if (!this.activeTabId || openerTabId === this.activeTabId) this.#activate(tab);
    this.#logSystem({
      kind: "tab_open",
      tabId: id,
      url: url ?? "",
      summary: `页面打开了弹窗${url ? `：${hostLabel(url)}` : ""}（保留 opener，可与原页面通信）`,
    });
    if (url) tab.noteBrowserInitiatedLoad?.(url);
    // 新 tab 在 AI 驱动期间诞生：按当前控制权上锁（desiredIgnore 在 CDP 就绪后自动生效）
    if (this.controller === "ai") void tab.setInputIgnored(true);
    this.#changed();
    return tab;
  }

  /** 页面发起新标签的滑动窗口限速（按 opener 分桶）：放行返回 true 并记一笔；超限返回 false（不记，避免被刷屏的页面把窗口一直续下去） */
  #allowPageTab(openerTabId) {
    const now = this.now();
    const key = String(openerTabId ?? "");
    const times = (this.pageTabTimes.get(key) ?? []).filter((t) => now - t < PAGE_TAB_WINDOW_MS);
    if (times.length >= PAGE_TAB_MAX_PER_WINDOW) {
      this.pageTabTimes.set(key, times);
      return false;
    }
    times.push(now);
    this.pageTabTimes.set(key, times);
    return true;
  }

  /**
   * 页面新窗口被限流丢弃时给 AI / 用户留一条线索（R2-06）：否则 AI 带修饰键点击（Ctrl+点击 = 新标签页）的第 N 个会静默没反应、也没有任何错误。
   * force：这类事件常发生在 AI 刚点完按钮的控制期里，不能被「AI 自己造成的 tab_open 静默」吞掉；每个 opener 每个窗口最多一条。
   */
  #noteDroppedPageTab(openerTabId, url) {
    const now = this.now();
    const key = String(openerTabId ?? "");
    const last = this.pageTabDropNoteAt.get(key);
    if (last !== undefined && now - last < PAGE_TAB_WINDOW_MS) return;
    this.pageTabDropNoteAt.set(key, now);
    const tab = this.tabs.find((t) => t.id === openerTabId);
    this.#logSystem(
      {
        kind: "tab_open",
        tabId: String(openerTabId ?? ""),
        url: tab?.url ?? "",
        summary: `页面连续打开新窗口，超出限额（${PAGE_TAB_WINDOW_MS / 1000} 秒内最多 ${PAGE_TAB_MAX_PER_WINDOW} 个），多出的已丢弃${url ? `（如 ${hostLabel(url)}）` : ""}`,
      },
      { force: true },
    );
  }

  #activate(tab) {
    const prev = this.activeTab;
    this.activeTabId = tab.id;
    if (this.pick && this.pick.tabId !== tab.id) this.#endPick();
    if (!this.attached) return;
    const win = this.host.getMainWindow();
    if (!win || !this.bounds) return;
    if (prev && prev !== tab) prev.moveToParking(this.host.getParkingWindow());
    tab.moveToMain(win, this.bounds, !this.covered);
  }

  selectTab(tabId) {
    const tab = this.getTab(tabId);
    if (tab.id !== this.activeTabId) {
      this.#activate(tab);
      this.#changed();
    }
    return tab;
  }

  /** 关 tab：关光后自动补一个空白页，保证会话始终有激活 tab */
  async closeTab(tabId) {
    const tab = this.getTab(tabId);
    const url = tab.url;
    await this.#removeTab(tab, { destroy: true, url, summary: `关闭了标签页${url ? `：${hostLabel(url)}` : ""}` });
  }

  /**
   * 页面自己关掉了这个 tab（window.close()）或引擎把它的 webContents 回收了：tab 已自行收尾（不能再 destroy），
   * 这里只把它从会话里摘掉、补激活邻居 / 空白页（评审 R1-09）。
   *
   * hostGone：宿主窗口已被销毁（app.exit() / 窗口被强关，wc 是被连带销毁的）。此时**只摘 tab**：不补空白页（会新建视图，
   * 甚至经 host.getParkingWindow() 重建停车场窗口——在退出过程中创建原生对象会让 Electron SIGTRAP 崩掉）、不写活动日志。
   * 会话留下零个 tab，之后若真有请求进来，openTab 会按常规路径重建停车场窗口与视图。
   */
  async #onTabGone(tab, lastUrl, hostGone = false) {
    if (this.destroyed || !this.tabs.includes(tab)) return;
    if (hostGone) {
      this.tabs.splice(this.tabs.indexOf(tab), 1);
      if (this.pick?.tabId === tab.id) this.#endPick();
      if (this.activeTabId === tab.id) this.activeTabId = null;
      return;
    }
    await this.#removeTab(tab, { destroy: false, url: lastUrl, summary: `页面关闭了标签页${lastUrl ? `：${hostLabel(lastUrl)}` : ""}` });
  }

  async #removeTab(tab, { destroy, url, summary }) {
    const idx = this.tabs.indexOf(tab);
    if (idx < 0) return;
    const wasActive = tab.id === this.activeTabId;
    this.tabs.splice(idx, 1);
    if (this.pick?.tabId === tab.id) this.#endPick();
    if (destroy) tab.destroy();
    // destroy=false = 页面 / 引擎自己关的，不是 AI 的动作：不受「AI 控制期静默」约束（见 #logSystem 的 force）
    this.#logSystem({ kind: "tab_close", tabId: tab.id, url, summary }, { force: !destroy });
    if (wasActive) {
      // E2·A2：激活的弹窗（OAuth / 支付窗）关掉后回到弹出它的页面，而不是随便一个邻居；opener 已不在才按常规取邻居
      const back = tab.popup === true ? this.tabs.find((t) => t.id === tab.opener) : undefined;
      const next = back ?? this.tabs[Math.min(idx, this.tabs.length - 1)] ?? null;
      if (next) this.#activate(next);
      else {
        this.activeTabId = null;
        await this.openTab({ activate: true });
      }
    }
    this.#changed();
  }

  // ───────────────────────── 视图挂载 ─────────────────────────

  /** 面板挂载：把激活 tab 的视图搬到主窗口。bounds 已由调用方过 normalizeBounds */
  attach(bounds) {
    const win = this.host.getMainWindow();
    this.bounds = bounds;
    if (!win) {
      this.attached = false;
      this.#changed();
      return;
    }
    this.attached = true;
    const tab = this.activeTab;
    if (tab) tab.moveToMain(win, bounds, !this.covered);
    this.#changed();
  }

  setBounds(bounds) {
    this.bounds = bounds;
    if (!this.attached) return;
    this.activeTab?.setBounds(bounds);
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    // 面板卸载 = 不再有「被遮盖」这回事，避免下次挂载时视图还是隐藏的
    this.covered = false;
    this.coverSeq += 1; // 作废在途的 setCovered(true)（见 setCovered 的序号令牌）
    for (const t of this.tabs) t.moveToParking(this.host.getParkingWindow());
    this.#changed();
  }

  /**
   * covered=true：截图占位 + 隐藏视图（原生视图永远盖在 DOM 之上，弹层 / 菜单要盖住它只能先让它让位，探针 T1）。
   * 截图失败也照样隐藏，返回 null。
   */
  async setCovered(covered) {
    // 序号令牌：capturePlaceholder 是 await 点，期间可能来了更新的 setCovered（典型：弹层开了又立刻关）或 detach。
    // 不做这层判断，慢的那次 true 会在 false 之后才落地，把视图永久藏起来（再也没有人发 false，用户看到一片空白）
    const seq = ++this.coverSeq;
    const tab = this.activeTab;
    if (covered) {
      let image = null;
      if (tab && this.attached && !this.covered) {
        try {
          image = await tab.capturePlaceholder();
        } catch {
          image = null;
        }
        if (seq !== this.coverSeq) return null; // 已被更新的 setCovered / detach 接管，这次作废
        // 截图期间切了 tab：图属于旧 tab，不能当占位图盖在新 tab 上；covered 状态本身仍要生效（#activate 按它决定可见性）
        if (this.activeTab !== tab) image = null;
      }
      this.covered = true;
      // 读「现在」的激活 tab：截图 await 期间可能已切 tab，此时 #activate 是按 covered=false 把新 tab 摆成可见的，
      // 藏旧 tab（已被停进停车场）没有意义，新 tab 会继续盖在弹层上
      const current = this.activeTab;
      if (current && this.attached) current.setVisible(false);
      this.#changed();
      return image;
    }
    this.covered = false;
    if (tab && this.attached) tab.setVisible(true);
    this.#changed();
    return null;
  }

  // ───────────────────────── 控制权状态机 ─────────────────────────

  #clearGrace() {
    if (this.graceTimer) {
      this.clearTimeoutFn(this.graceTimer);
      this.graceTimer = null;
    }
  }

  async #lockAll(on, label) {
    await Promise.all(
      this.tabs.map(async (t) => {
        try {
          await t.setInputIgnored(on);
          // 关闭时用 hide 而不是 setActive(false)：后者只收边框和角标，虚拟光标 / 高亮会残留在页面上
          if (on) await t.overlaySetActive(true, label ?? null);
          else await t.overlayHide();
        } catch {
          /* 个别 tab 挂了不影响其他 tab */
        }
      }),
    );
  }

  /** 动作类 op 开始：置 ai、上锁、覆盖层亮起 */
  #enterAi() {
    this.activeOps += 1;
    this.#clearGrace();
    if (this.controller === "ai") return;
    this.controller = "ai";
    void this.#lockAll(true, "AI 操作中");
    this.#changed();
  }

  #leaveAi() {
    this.activeOps = Math.max(0, this.activeOps - 1);
    if (this.activeOps > 0 || this.controller !== "ai") return;
    this.#clearGrace();
    // 宽限期：期间又有动作就续期（#enterAi 清掉计时器），到点才放手
    this.graceTimer = this.setTimeoutFn(() => {
      this.graceTimer = null;
      if (this.controller !== "ai" || this.activeOps > 0) return;
      this.controller = "idle";
      void this.#lockAll(false);
      this.#changed();
    }, this.graceMs);
  }

  #assertAiAllowed() {
    if (this.controller === "user") {
      throw new BrowserError(
        "USER_CONTROL",
        this.ask
          ? "用户正在按你的请求操作浏览器，请等待用户点「完成 / 放弃」后再继续（不要重复操作）"
          : "用户正在接管浏览器，AI 的动作被拒绝。请结束本轮、或调用 ask_user_to_act 请用户协助，等用户点「交还给 AI」后再继续",
      );
    }
  }

  /**
   * 执行一个动作类 op：串行排队 → 校验控制权 → 置 ai → 跑 fn → 记日志。
   * fn 收到的 ctx：{ tab, signal, check(), describe(), tabSeqAtStart }。
   * 为什么串行：同一会话里两个动作并发会抢 AI flag / 输入锁，彼此把对方的窗口关掉。
   *
   * 对话框（契约 §14.1）：动作进行中该 tab 弹出 JS 对话框 → 与动作竞速，对话框先到就让动作带 `dialog` 字段提前结束；
   * tab 上本来就有未处理的对话框 → 不执行动作，直接带 `dialog` + `notExecuted` 返回（opts.allowPendingDialog / raceDialog:false 可关）。
   *
   * @param {{ op: string, tabId?: string, needsTab?: boolean, signal?: AbortSignal, allowPendingDialog?: boolean, raceDialog?: boolean }} opts
   * @param {(ctx: object) => Promise<any>} fn
   */
  runAction(opts, fn) {
    /** 因对话框竞速而提前返回的动作的「原 promise」（队列据此等它收尾） */
    let stalePromise = null;
    const run = async () => {
      if (this.destroyed) throw new BrowserError("NO_SESSION", "浏览器会话已关闭");
      this.#assertAiAllowed();
      const needsTab = opts.needsTab !== false;
      const tab = needsTab ? this.getTab(opts.tabId) : null;
      if (opts.signal?.aborted) throw opts.signal.reason;
      // 页面上已经有个没处理的对话框时，渲染进程被它阻塞，任何 CDP 派发都会挂住：不执行动作，直接把对话框交还给调用方
      // （server 的 renderAction 据此提示「先用 browser_dialog 处理」）。notExecuted 让文案能说清「这次动作没做」。
      if (tab?.pendingDialog && opts.allowPendingDialog !== true) {
        return { tabId: tab.id, url: tab.url, title: tab.title, navigated: false, dialog: { ...tab.pendingDialog }, notExecuted: true };
      }
      // E2·B5：页面被调试器暂停时主线程冻结，任何动作的 CDP 派发都会无限挂住——入口快速失败（不占队列、不切「AI 操作中」）。
      // 调用方是 debug 自己的话不会走 runAction（debug 不排队），所以这里没有「放行」开关。
      const pausedAtEntry = tab ? livePause(tab) : null;
      if (pausedAtEntry) throw new BrowserError("TIMEOUT", pausedMessage(pausedAtEntry));
      const abort = new AbortController();
      // 请求被 cancel 与用户接管都要能打断当前动作：两路汇到同一个 signal
      const onReqAbort = () => abort.abort(opts.signal.reason);
      opts.signal?.addEventListener("abort", onReqAbort, { once: true });
      this.inflight.add(abort);
      this.#enterAi();
      /** @type {{ kind?: string, summary?: string, target?: object, label?: string } | null} */
      let described = null;
      /** 本次 runAction 已收尾（finally 里置位）：仍在后台跑的「僵尸 fn」不能再碰覆盖层 / aiLabel */
      let finished = false;
      const ctx = {
        tab,
        signal: abort.signal,
        tabSeqAtStart: this.tabSeq,
        session: this,
        check: () => {
          if (abort.signal.aborted) throw abort.signal.reason;
        },
        /** 本次动作是否还「活着」：没收尾、没被打断（actions.mjs 的 showAction 据此决定要不要再点亮覆盖层，R2-08） */
        isActive: () => !finished && !abort.signal.aborted,
        describe: (d) => {
          // R1-33：被 takeover / cancel 打断、或因对话框竞速提前返回的动作，其 fn 可能还在后台跑，晚到的 describe 会重新点亮
          // AI 覆盖层与 aiLabel——而此时已经没有人会再 hide（控制权早已是 user / idle），覆盖层就永久留在用户的页面上
          if (finished || abort.signal.aborted) return;
          described = d;
          if (d.label) {
            this.aiLabel = d.label;
            this.aiLabelAt = this.now();
            // 覆盖层同步显示当前在干什么（失败不影响动作）
            if (tab) void tab.overlaySetActive(true, d.label);
            this.#changed();
          }
        },
      };
      // 对话框竞速订阅要在 fn 启动之前：fn 的第一个 await 之前对话框不会到，但订阅晚了就有「漏掉」的理论窗口
      const dialogRace = tab && opts.raceDialog !== false && typeof tab.onDialogOpened === "function" ? this.#dialogRace(tab) : null;
      // E2·B5：动作进行中页面被断点 / debugger; 语句冻结（如点击触发了断点）→ 与动作竞速，暂停先到就让动作带「被暂停」错误提前结束
      const pauseRace = tab && typeof tab.onCdpEvent === "function" ? this.#pauseRace(tab) : null;
      try {
        let result;
        if (!dialogRace && !pauseRace) {
          result = await raceAbort(fn(ctx), abort.signal);
        } else {
          const body = fn(ctx);
          const winner = await raceAbort(
            Promise.race([
              body.then((value) => ({ value })),
              ...(dialogRace ? [dialogRace.promise.then((dialog) => ({ dialog }))] : []),
              ...(pauseRace ? [pauseRace.promise.then((paused) => ({ paused }))] : []),
            ]),
            abort.signal,
          );
          if (winner.paused) {
            // 与对话框同理：原 promise 在 resume 后自然收尾，队列等它（有上限）；debug 的 resume 不走队列，所以不会死锁
            stalePromise = body;
            body.catch(() => {});
            throw new BrowserError("TIMEOUT", `${pausedMessage(winner.paused)}。本次动作进行中触发了暂停，它是否已生效不确定，resume 后请先 snapshot 确认现状`);
          }
          if (winner.dialog) {
            // 页面同步 alert / confirm 会让进行中的 CDP 派发一直不返回：不等它，带着对话框提前结束本次动作。
            // 原 promise 自然收尾（对话框被处理后 CDP 命令返回、后续异常已被 race 内部的 then 吞掉）；
            // 队列要等它收尾（有上限），免得它收尾阶段的 AI flag / 锁复位干扰下一个动作。
            stalePromise = body;
            result = { tabId: tab.id, url: tab.url, title: tab.title, navigated: false, dialog: winner.dialog };
          } else {
            result = winner.value;
            // 动作刚好做完、对话框紧跟着挂起：也带上，别让调用方漏看
            if (tab.pendingDialog && result && typeof result === "object" && !Array.isArray(result) && !result.dialog) {
              result = { ...result, dialog: { ...tab.pendingDialog } };
            }
          }
        }
        if (described?.summary) {
          try {
            this.activityLog.addAI({
              kind: described.kind ?? "click",
              tabId: tab?.id ?? this.activeTabId ?? "",
              url: tab?.url ?? "",
              summary: described.summary,
              target: described.target,
            });
          } catch (err) {
            this.log(`[browser] AI 动作日志写入失败：${err?.message || err}`);
          }
        }
        return result;
      } finally {
        finished = true;
        dialogRace?.off();
        pauseRace?.off();
        opts.signal?.removeEventListener("abort", onReqAbort);
        this.inflight.delete(abort);
        this.#leaveAi();
        this.#changed();
      }
    };
    const p = this.queue.then(run, run);
    // 队列链上吞掉错误：一个动作失败不能让后面的动作永远卡在 rejected 链上；
    // 对话框竞速提前返回的动作，其原 promise 还在收尾——队列等它（有上限），避免它的收尾与下一个动作互相踩 flag / 锁
    this.queue = p
      .catch(() => {})
      .then(() => (stalePromise ? this.#awaitCapped(stalePromise, STALE_ACTION_WAIT_MS) : undefined));
    return p;
  }

  /**
   * 订阅「该 tab 被调试器暂停」；返回 { promise（首次暂停 resolve，值 = 暂停位置镜像）, off }。
   * 经 tab.onCdpEvent 听 `Debugger.paused`（hub 的监听先注册，所以此时 tab.debugPause 已是最新）。
   */
  #pauseRace(tab) {
    let off = () => {};
    const promise = new Promise((resolve) => {
      const unsub = tab.onCdpEvent((method) => {
        if (method === "Debugger.paused") resolve(tab.debugPause ?? {});
      });
      if (typeof unsub === "function") off = unsub;
    });
    return { promise, off };
  }

  /** 订阅「该 tab 有对话框挂起」；返回 { promise（首个对话框 resolve）, off } */
  #dialogRace(tab) {
    let off = () => {};
    const promise = new Promise((resolve) => {
      off = tab.onDialogOpened((info) => resolve(info));
    });
    return { promise, off };
  }

  /** 等一个 promise 结束（成功 / 失败都算），但最多等 ms：不让一个迟迟不收尾的 promise 把队列永远卡住 */
  #awaitCapped(promise, ms) {
    return new Promise((resolve) => {
      const timer = this.setTimeoutFn(resolve, ms);
      const done = () => {
        this.clearTimeoutFn(timer);
        resolve();
      };
      promise.then(done, done);
    });
  }

  /**
   * 释放 AI 按下的鼠标键（R2-08）：用户接管 / 请用户协助 / 任务被取消时调用。down 成功返回后没有在途 op 的话，
   * 这是清掉按下态的唯一时机（在途 op 的 catch 自己会补 release）。不在宽限期到期时调：模型两次调用的间隔常超过 8 秒，
   * 到期就释放会破坏 down → move → up 的序列；那种「忘了抬起」由 ops/input.mjs 的空闲 TTL 兜底。
   */
  #releaseHeldInput() {
    for (const t of this.tabs) {
      try {
        const p = t.releaseHeldButtons?.();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        /* 个别 tab 已销毁 */
      }
    }
  }

  /** 用户点「接管」：解锁、中断进行中的 AI 动作 */
  takeover() {
    if (this.destroyed || this.controller === "user") return;
    this.#clearGrace();
    this.#abortInflight(
      new BrowserError("USER_TOOK_OVER", "用户在你操作的过程中接管了浏览器，该动作已中断，页面状态可能已变化。请先 snapshot 确认现状，再决定是否继续"),
    );
    this.#releaseHeldInput();
    this.controller = "user";
    void this.#lockAll(false);
    this.#logSystem({ kind: "takeover", tabId: this.activeTabId ?? "", url: this.activeTab?.url ?? "", summary: "用户接管了浏览器" });
    this.#changed();
  }

  #abortInflight(reason) {
    for (const a of [...this.inflight]) a.abort(reason);
  }

  /** 用户点「交还给 AI」：回 idle，记 handback，向 server 发 evt（带自上次送达以来的用户 / 系统条目） */
  handback(note) {
    if (this.destroyed) return;
    // ask 挂起时「交还」等价于「完成」：工具以 outcome 返回，不发 handback 事件，避免双重送达
    if (this.ask) {
      this.answerAsk("done", note);
      return;
    }
    if (this.controller !== "user") return;
    this.controller = "idle";
    const cleanNote = typeof note === "string" ? note.trim().slice(0, 2000) : "";
    // 先收集再记 handback 本身：这条是「事件的触发者」，不该出现在自己的 entries 里
    const entries = this.activityLog.unseenUserEntries().map((e) => ({ ...e }));
    this.activityLog.addSystem({
      kind: "handback",
      tabId: this.activeTabId ?? "",
      url: this.activeTab?.url ?? "",
      summary: cleanNote ? `用户把浏览器交还给 AI：${cleanNote.slice(0, 80)}` : "用户把浏览器交还给 AI",
    });
    this.activityLog.markSeen();
    this.host.emitEvent("handback", this.taskId, { note: cleanNote, entries });
    this.#changed();
  }

  /**
   * ask_user_to_act：挂起直到用户答复 / 超时 / 被 cancel。
   * 同一会话只保留一个挂起的 ask：新来的顶替旧的，旧的以 outcome:"cancelled" 返回（让上一个等待者不会永远悬着）。
   */
  askUserToAct({ message, timeoutMs, signal }) {
    if (this.destroyed) return Promise.reject(new BrowserError("NO_SESSION", "浏览器会话已关闭"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.ask) this.#finishAsk("cancelled");
    this.#clearGrace();
    this.#abortInflight(new BrowserError("USER_TOOK_OVER", "你请求用户协助，进行中的动作已中断"));
    this.#releaseHeldInput();
    this.controller = "user";
    void this.#lockAll(false);
    const wait = Math.min(Math.max(1000, Math.round(timeoutMs ?? 1_800_000)), MAX_ASK_MS);
    return new Promise((resolve, reject) => {
      const entry = {
        message: String(message ?? "").slice(0, 500),
        since: this.now(),
        resolve,
        reject,
        timer: null,
        onAbort: null,
        signal,
      };
      entry.timer = this.setTimeoutFn(() => {
        if (this.ask === entry) this.#finishAsk("timeout");
      }, wait);
      if (signal) {
        entry.onAbort = () => {
          if (this.ask !== entry) return;
          this.#clearAsk(entry);
          // cancel：回 idle（用户那边的横幅随状态消失），工具以 CANCELLED 结束
          this.controller = "idle";
          this.#changed();
          reject(signal.reason);
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.ask = entry;
      this.#changed();
    });
  }

  #clearAsk(entry) {
    this.clearTimeoutFn(entry.timer);
    if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
    if (this.ask === entry) this.ask = null;
  }

  #finishAsk(outcome, note) {
    const entry = this.ask;
    if (!entry) return;
    this.#clearAsk(entry);
    this.controller = "idle";
    const cleanNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 2000) : undefined;
    const entries = outcome === "cancelled" ? [] : this.activityLog.unseenUserEntries().map((e) => ({ ...e }));
    if (outcome !== "cancelled") this.activityLog.markSeen();
    entry.resolve({ outcome, ...(cleanNote ? { note: cleanNote } : {}), entries });
    this.#changed();
  }

  /** 用户在条幅上点「完成 / 放弃」 */
  answerAsk(outcome, note) {
    if (!this.ask) return;
    this.#finishAsk(outcome === "skipped" ? "skipped" : "done", note);
  }

  /** server 发来 cancel（该任务的 AI 轮次被停）：清掉挂起的 ask 并回 idle。请求自身的 signal 路径也会走同样的结果，这里是兜底 */
  cancelWaits() {
    // 任务被停：AI 若还按着鼠标键（down 之后没来得及 up），在这里补 release（R2-08）
    this.#releaseHeldInput();
    const entry = this.ask;
    if (!entry) return;
    this.#clearAsk(entry);
    this.controller = "idle";
    entry.reject(new BrowserError("CANCELLED", "任务已被取消"));
    this.#changed();
  }

  // ───────────────────────── 元素拾取（P3） ─────────────────────────

  startPick() {
    const tab = this.activeTab;
    if (!tab || this.pick || this.controller === "ai") return false;
    // let + 先占位：startPicker 若同步回调 onEnd（比如注入失败），此时 handle 还没赋值
    let handle = null;
    handle = this.host.startPicker(tab, {
      onPicked: (picked) => {
        this.#endPick();
        this.#logSystem({
          kind: "pick",
          tabId: tab.id,
          url: picked.url,
          summary: `用户拾取了页面元素${picked.name ? `「${picked.name}」` : picked.role ? `（${picked.role}）` : ""}`,
        });
        this.host.emitPicked(this.taskId, picked);
      },
      onEnd: () => {
        if (this.pick?.handle === handle) this.#endPick(false);
      },
    });
    this.pick = { tabId: tab.id, handle };
    this.#changed();
    return true;
  }

  #endPick(cancel = true) {
    const p = this.pick;
    if (!p) return;
    this.pick = null;
    if (cancel) {
      try {
        p.handle.cancel();
      } catch {
        /* 拾取器已结束 */
      }
    }
    this.#changed();
  }

  cancelPick() {
    this.#endPick(true);
  }

  // ───────────────────────── 状态 ─────────────────────────

  getState() {
    return {
      taskId: this.taskId,
      exists: true,
      controller: this.controller,
      askRequest: this.ask ? { message: this.ask.message, since: this.ask.since } : null,
      aiLabel: this.aiLabel,
      aiLabelAt: this.aiLabelAt,
      activeTabId: this.activeTabId,
      tabs: this.listTabs(),
      attached: this.attached,
      covered: this.covered,
      picking: this.pick !== null,
      pendingUserActivity: this.activityLog.pendingCount(),
      recent: this.activityLog.recent(RECENT_COUNT).map((e) => ({ ...e })),
      // V5：当前激活 tab 挂起的 JS 对话框（没有为 null）；V4 的对话框条读它
      dialog: this.activeTab?.pendingDialog ? { ...this.activeTab.pendingDialog } : null,
      // V3：最近 10 条下载（最新在前）；UI 的下载按钮 / 弹层读它
      downloads: this.downloads.recent(STATE_DOWNLOADS),
      // 契约 §15.1：等待用户处理的提示
      prompts: this.prompts.list(),
      // 增强包 E2 各模块的状态字段默认值（模块没贡献 = 没有这个东西）
      netRules: null,
      debug: null,
      recording: null,
      // 增强包 E2 各模块贡献的状态字段（netRules / debug / recording …）：host.stateContributors 里每项 (session) => 对象，浅合并
      ...this.#contributedState(),
    };
  }

  #contributedState() {
    const out = {};
    for (const fn of this.host.stateContributors ?? []) {
      try {
        Object.assign(out, fn(this) ?? {});
      } catch (err) {
        this.log(`[browser:${this.taskId}] 状态贡献者出错（已忽略）：${err?.message || err}`);
      }
    }
    return out;
  }

  // ───────────────────────── 销毁 ─────────────────────────

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.#clearGrace();
    this.#abortInflight(new BrowserError("CANCELLED", "浏览器会话已关闭"));
    if (this.ask) {
      const entry = this.ask;
      this.#clearAsk(entry);
      entry.reject(new BrowserError("CANCELLED", "浏览器会话已关闭"));
    }
    this.#endPick(true);
    // 契约 §15.1：挂起的提示全部按默认动作（取消 / 拒绝）结束；各模块的会话级状态清理
    this.prompts.dispose();
    this.controllerListeners.clear();
    this.aiInputListeners.clear();
    for (const v of this.ext.values()) {
      try {
        v?.dispose?.();
      } catch (err) {
        this.log(`[browser:${this.taskId}] 扩展状态清理出错（已忽略）：${err?.message || err}`);
      }
    }
    this.ext.clear();
    // V3：叫醒挂在 downloads wait 上的请求（它们以 CANCELLED 结束），并拒绝之后迟到的下载事件
    this.downloads.dispose();
    // E2·A2：还掉所有未收养的弹窗预留票（定时器清掉，之后迟到的 adopt 会因 destroyed 抛错，由 tab 的 createWindow 兜住）
    for (const ticket of [...this.popupTickets]) this.#releasePopupTicket(ticket);
    for (const t of this.tabs) t.destroy();
    this.tabs = [];
    this.activeTabId = null;
    this.attached = false;
  }
}

export { tabSeqOf };
