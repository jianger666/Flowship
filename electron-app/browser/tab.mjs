/**
 * BrowserTab：一个 WebContentsView + 它的 CDP 会话（契约 §8 tab.mjs）。
 *
 * 职责：
 * - 建视图（sandbox / 无 preload / 独立 partition）、挂停车场、搬到主窗 / 搬回；
 * - 导航事件与 URL 策略（will-navigate / will-redirect / setWindowOpenHandler 一律过 checkUrl）；
 * - CDP：域启用、OOPIF 子会话自动挂接、页内脚本注入（隔离世界）、console / network 环形缓冲、JS 对话框处置；
 * - 输入锁（Input.setIgnoreInputEvents）与「AI 动作归因 flag」；
 * - 感知类能力：snapshot / screenshot / evaluate / 页面文字（wait_for 用）。
 *
 * 不做的事：控制权状态机、活动日志、多 tab 管理（都在 session.mjs）；点击 / 输入等动作（actions.mjs）。
 * 与 electron 的耦合只有「被注入进来的 WebContentsView 类 + 停车场窗口」，所以单测可以用假对象驱动大部分逻辑。
 */
import { captureAxFrames, collectSnapshotCandidates, formatAxSnapshot, visibilityKey } from "./ax-snapshot.mjs";
import {
  describeEmulation,
  fitBoundsToEmulation,
  fitScaleFor,
  fitViewportOf,
  mergeEmulation,
  sameViewFit,
  scaleInputParams,
  toCdpCommands,
  viewportMetricsCommand,
  withFitScale,
} from "./emulation.mjs";
import { assertBase64WithinCap, FULLPAGE_SHOT_HINT, FULLPAGE_SHOT_MAX_BYTES } from "./output-caps.mjs";
import {
  clampClipToViewport,
  drawAnnotations,
  legendLine,
  MIME_BY_FORMAT,
  pickAnnotations,
  readImageSize,
  SCREENSHOT_FORMATS,
  toPixelBoxes,
} from "./screenshot-kit.mjs";
import {
  createNetworkDetailStore,
  missedResourceEntries,
  NET_BODY_MAX,
  NET_DETAIL_MAX,
  redactUrlSecrets,
  RESOURCE_TIMING_EXPRESSION,
  stashHeaders,
} from "./net-detail.mjs";
import { collectClosedShadowText } from "./closed-shadow.mjs";
import { compactStackFrames } from "./sourcemap.mjs";
import { createStreamCollector, formatInitiator } from "./net-streams.mjs";
import { isIncognitoPartition } from "./incognito.mjs";
import { isGestureInput, isSafePopupPrefs, POPUP_WEB_PREFERENCES } from "./popup-policy.mjs";
import { BrowserError } from "./server-channel.mjs";
import { checkUrl, isSafeFaviconUrl } from "./url-policy.mjs";

// 停车场里的默认视口：AI 在用户没打开面板时看到的页面尺寸
export const PARKING_BOUNDS = Object.freeze({ x: 0, y: 0, width: 1280, height: 800 });
export const BROWSER_PARTITION = "persist:flowship-browser";
/**
 * `Target.setAutoAttach` 的入参（主会话与每个 OOPIF 子会话共用）。
 *
 * 只自动附加 iframe（跨站 iframe 要子会话才读得到树 / 点得中）：`filter` 按顺序首条命中生效，第一条放行 iframe，第二条 `{ exclude: true }`
 * 排除其余全部类型。**不能省略 filter**：省略时 worker / service worker / shared worker 都会被附加，而页面一旦创建 Web Worker
 * （baidu.com 首页就起 blob: Worker），Electron 42.4.0（Chromium 148）对这些会话的 `Target.detachFromTarget` 会让主进程 SIGSEGV 闪退
 * （2026-11-10 v1.9.46 事故；`tests/browser-tab-auto-attach.test.ts` 钉住这个形状）。
 * 以前附加了又立刻 detach 的做法就是触发点；现在从源头就不附加它们，也省掉了每个 worker 的一来一回。
 */
export const AUTO_ATTACH_PARAMS = Object.freeze({
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: Object.freeze([Object.freeze({ type: "iframe" }), Object.freeze({ exclude: true })]),
});
/**
 * 浏览器自己发起的导航（AI navigate / 用户地址栏 / 新建标签带 URL）之后，多久内出现的同 URL 下载仍算「我们发起的」
 * （R1-10：wc.loadURL 引出的下载 hasUserGesture 恒为 false）。这是下限；navigate 带的超时更长时取超时（R3-07 ①：
 * 「导出报表」类接口生成要 20 秒，will-download 到来时 15 秒的令牌已过期会被误拦），封顶 BROWSER_NAV_DOWNLOAD_MAX_MS。
 */
export const BROWSER_NAV_DOWNLOAD_MS = 15_000;
export const BROWSER_NAV_DOWNLOAD_MAX_MS = 60_000;
/** 用户在地址栏 / 新建标签里输入的导航：与 navigate 的默认超时同长 */
export const BROWSER_USER_NAV_DOWNLOAD_MS = 30_000;

/** 去掉 #fragment 再比较（`getURLChain()[0]` 是否保留 fragment 取决于引擎，两边都去掉就不依赖它）；解析失败返回 null */
const urlNoHash = (u) => {
  try {
    const x = new URL(String(u));
    x.hash = "";
    return x.href;
  } catch {
    return null;
  }
};

const CDP_TIMEOUT_MS = 20_000;
/** navigate 因认证 / 证书提示而延后超时之后，再给页面加载的宽限（E2·P1） */
const NAV_AFTER_PROMPT_GRACE_MS = 15_000;
/** JS 对话框最长挂起时间（契约 §14.1）：期间 AI 用 browser_dialog、用户点面板按钮处理；超时按旧策略兜底，页面不能无限卡死 */
export const DIALOG_HOLD_MS = 20_000;
const DIALOG_MESSAGE_MAX = 500;
const CONSOLE_RING_MAX = 500;
const NETWORK_RING_MAX = 500;
const CONSOLE_TEXT_MAX = 1500;
const URL_LOG_MAX = 400;
const MAX_FULLPAGE_CSS_HEIGHT = 12_000; // Chrome 单张纹理上限附近，再高截图会失败

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 定长环形缓冲：满了丢最旧、记丢弃数（console / network 两个 op 的 `dropped` 字段） */
export const createRing = (max) => {
  let items = [];
  let dropped = 0;
  return {
    push(item) {
      items.push(item);
      if (items.length > max) {
        items.shift();
        dropped += 1;
      }
    },
    list: () => items.slice(),
    get dropped() {
      return dropped;
    },
    size: () => items.length,
    clear() {
      items = [];
      dropped = 0;
    },
  };
};

const withTimeout = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrowserError("TIMEOUT", `浏览器内部命令超时（${label}，${ms}ms）`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

const clipText = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : String(s ?? ""));

/**
 * URL 只留 origin + pathname（query / hash 可能带 token）；解析不了就截断原串。导出给测试直接喂真实输出（R4 复审 R3-09）。
 * 几类特殊形态（旧版把 origin 与 pathname 硬拼，得到 `about://blank` / `https://a.comhttps://a.com/x` 这种串，下游按 URL 解析会得到错的主机）：
 *  · `data:` / `javascript:` / `vbscript:`：pathname 就是载荷本身，只留协议；
 *  · `blob:`：pathname 是内层 URL，只留 `blob:` + 内层 origin；
 *  · `about:`：`about:blank` 原样（没有主机）。
 */
export const safeOriginPath = (url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol === "data:" || u.protocol === "javascript:" || u.protocol === "vbscript:") return u.protocol;
    if (u.protocol === "blob:") return `blob:${u.origin === "null" ? "" : u.origin}`.slice(0, 400);
    if (u.protocol === "about:") return `about:${u.pathname}`.slice(0, 100);
    return `${u.origin === "null" ? `${u.protocol}//` : u.origin}${u.pathname}`.slice(0, 400);
  } catch {
    return String(url ?? "").slice(0, 200);
  }
};

/** RemoteObject → 一段给人 / AI 看的文字（console 实参格式化用） */
const remoteObjectText = (o) => {
  if (!o || typeof o !== "object") return "";
  if (o.value !== undefined) return typeof o.value === "string" ? o.value : JSON.stringify(o.value);
  if (o.unserializableValue !== undefined) return String(o.unserializableValue);
  if (typeof o.description === "string") return o.description;
  return String(o.type ?? "");
};

/**
 * @typedef {object} TabHooks
 * @property {() => void} onChange 任何对外可见状态变化（标题 / URL / loading / favicon …）
 * @property {(info: { url: string, title: string }) => void} onLoaded 主 frame 加载完成
 * @property {(info: { url: string, disposition: string, openerTabId: string, byUser?: boolean }) => void} onNewTab 页面要开新窗口（已过 URL 策略）；byUser = 用户在右键菜单里点的，不是页面自己开的
 * @property {(info: { url: string, openerTabId: string }) => ({ adopt: (wc: any) => void, release: () => void } | null)} [onPopupRequest]
 *   E2·A2：页面 `window.open` 想保留 `window.opener`。session 判（会话活着 / opener 有真实手势 / 没超 tab 上限 / 没超限流）：
 *   通过 → 返回「预留票」{ adopt(wc)：把 Chromium 建好的弹窗 wc 收养成本会话的 tab；release()：没走到收养时还票 }；不通过 → null（调用方走老路径：deny + 新 tab，无 opener）。
 *   同步、不得抛错（抛了按 deny 处理）。缺省（老调用方 / 测试）= 不支持，一律老路径。
 * @property {(evt: object) => void} onRecorder 页内录制器事件（已补 tabId）
 * @property {(info: { url: string, reason: string, source: string }) => void} onBlocked 导航被 URL 策略拦下
 * @property {(info: { type: string, message: string, handled: string }) => void} onDialog JS 对话框已自动处置
 * @property {() => void} onNeedLockSync 导航后需要让 session 重新对本 tab 上锁 / 同步覆盖层
 * @property {() => void} [onAiInput] AI 即将经 withAiInput 向页面派发输入（R6-18：剪贴板观察窗口的「AI 触发动作」归因）；缺省 = 无人监听
 * @property {() => void} onCrashed 渲染进程崩溃
 * @property {(info?: { hostGone: boolean }) => void} [onGone] webContents 被页面 / 引擎自己销毁了（window.close()、渲染进程被回收），不是我们 destroy() 的：session 据此摘掉这个 tab。
 *   hostGone=true：宿主窗口已被销毁（app.exit() / 窗口被强关，wc 是被连带销毁的）——此时只能摘 tab，不能再新建任何原生对象
 */

/**
 * 算作「用户 / AI 的真实手势」的录制事件类型（R2-06）：session 据此决定页面发起的新窗口能不能抢占激活、下载能不能放行。
 * 这些类型的条目是录制器「在最近 1 秒内见过 trusted 的按下类输入（pointerdown / mousedown / keydown / touchstart）」之后才外发的
 * （R3-01：click 本身不再是手势来源，UA 转发 / 派发的 click 到不了这里；CDP 派发的 AI 输入同样产生真实的按下类事件）。
 * 不含 scroll / focus / input / select / submit：它们可以被脚本触发 UA 派发（focus() / requestSubmit() / execCommand …）。
 */
const GESTURE_EVENT_TYPES = new Set(["click", "dblclick", "contextmenu", "key"]);

/**
 * 录制器 binding 的令牌桶：页面里的脚本能随便调 binding，不限速的话一个死循环就能把主进程事件循环占满。
 * 按「会话 + 执行上下文（即 frame 的隔离世界）」分桶（R3-04）：一个敌对 frame 灌满自己的桶，不会把别的 frame / 主 frame 的真实事件挤掉。
 * 桶表有上限（{@link BINDING_MAX_BUCKETS}）：满了淘汰「最闲」的桶（补完令牌后最满的，并列取最早建的）——
 * 被敌对 frame 灌空的桶不会因为新桶出现就被淘汰成满桶（R4-03：旧版淘汰最早建的，33+ 个同源 iframe 轮流发事件能让每个桶复用前都被挤掉、永不限速）。
 * 另有 tab 级总桶 {@link BINDING_TOTAL_CAPACITY}：多个 frame 并发时总速率也有上界（旧版只有 32 × 20/s = 640/s）；
 * 单个 frame 最多每秒 20 条，要拖垮总桶得有 5 个以上的 frame 同时满速灌，所以单个敌对 frame 仍挤不掉别的 frame 的真实事件。
 * 取舍：总桶被多 frame 同时灌空期间，真实事件也会被丢（录制器只是辅助记录，主进程不被占满更要紧）。
 */
const BINDING_BUCKET_CAPACITY = 40;
const BINDING_REFILL_PER_SEC = 20;
const BINDING_MAX_BUCKETS = 32;
const BINDING_TOTAL_CAPACITY = 200;
const BINDING_TOTAL_REFILL_PER_SEC = 100;

export class BrowserTab {
  /** 挂起对话框的内部元数据：{ sessionId, timer }（pendingDialog 为 null 时为 null） */
  #dialogMeta = null;

  /**
   * 设备模拟的串行队列（R2-09）：`applyEmulation` 是「读 prev → 改 this.emulation → 逐条发 CDP → 失败回滚到 prev」，
   * AI 的 emulate 与用户 IPC 的 reset 并发时，A 失败后的 `this.emulation = prev` 会覆盖 B 已写入的 next，
   * 状态与页面实际错位。同一 tab 一次只跑一个，后来的排队。
   */
  #emulationChain = Promise.resolve();
  /** 最近一次浏览器自己发起的导航的 { url（去 hash）, at, nav, ttl }（见 consumeBrowserInitiatedDownload） */
  #browserNav = null;

  /** 最近一次真实手势（见 GESTURE_EVENT_TYPES）的时间戳；0 = 从未有过 */
  #lastGestureAt = 0;
  /**
   * E2·A2：最近一次「浏览器进程输入管线里的按下类输入」（`input-event`，见 popup-policy.isGestureInput）的时间戳；0 = 从未有过。
   * 与 #lastGestureAt 的区别：它是浏览器进程在把输入送进渲染进程前**同步**记的，不依赖页内录制器 / binding 的异步回传（不乱序），
   * 页面脚本也伪造不了——真实用户输入与 AI 的 CDP `Input.dispatch*` 都会经过这条管线，`dispatchEvent` / `el.click()` 不会。
   */
  #lastInputAt = 0;
  /** R3-06：`moveToParking(null)`（应用在退出、没有停车场窗口）把 `parentWindow` 置空后，`destroyed` 里的 hostGone 判断会恒为假；留个标记，别让「宿主已走」因置空而丢失 */
  #hostLeft = false;
  /**
   * 占位 div 的矩形（DIP，渲染端汇报、已按宿主缩放换算）——只在视图挂在主窗口时有值，停车场里是 null。
   * 视图实际用的矩形 = 它按设备模拟收窄后的结果（见 emulation.mjs 的 fitBoundsToEmulation），
   * 所以必须记着原始槽位：模拟变化 / 重置时要用它重新摆视图，渲染端不会为此再汇报一次 bounds。
   */
  #slot = null;
  /** 视图占槽位的比例（0..1）；没被模拟收窄时为 null。遮盖占位图靠它摆到视图所在的位置（TabInfo.viewFit） */
  viewFit = null;
  /**
   * 缩放适配（契约 §14.4）：页面**已生效**的缩放比例（最近一次 `setDeviceMetricsOverride` 成功时的 scale；1 = 不缩放）。
   * 决定原生视图的大小（= floor(模拟尺寸 × 它)）——页面渲染成什么样，视图就收成什么样，两者不会错开。
   */
  #fitScale = 1;
  /**
   * 最近一次**发出**的 scale（发送时就更新，失败回滚）。AI 的输入坐标按它补偿：CDP 命令在同一会话里按序执行，
   * 排在缩放命令之后发出的输入，落地时用的就是这个比例（等应答再切会让这段时间里的点击差 1/scale 倍）。
   */
  #inputScale = 1;
  /** 已有一个「按最新槽位重算缩放」的任务在模拟队列里等着：拖面板每帧都来一次 setBounds，合并成一个，永远只补最新的 */
  #refitQueued = false;
  /** 最近一次通知渲染端的缩放百分比（整数）；只有它变了才推状态（拖面板时不必每帧推） */
  #notifiedFitPct = 100;

  /**
   * @param {{
   *   id: string,
   *   WebContentsView: new (opts: object) => any,
   *   parkingWindow: any,
   *   pageScripts: { PAGE_WORLD_NAME: string, RECORDER_BINDING: string, buildPageScript: (o?: { recordValues?: boolean }) => string },
   *   isAppUrl: (url: string) => boolean,
   *   hooks: TabHooks,
   *   nativeImage?: any,
   *   log?: (msg: string) => void,
   *   now?: () => number,
   *   recordValues?: boolean,
   *   partition?: string,
   *   setTimeoutFn?: typeof setTimeout,
   *   clearTimeoutFn?: typeof clearTimeout,
   * }} deps
   */
  constructor(deps) {
    this.id = deps.id;
    this.deps = deps;
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? Date.now;
    this.hooks = deps.hooks;
    this.pageScripts = deps.pageScripts;
    this.recordValues = deps.recordValues === true;

    this.destroyed = false;
    this.crashed = false;
    /** 最后一次提交的导航 URL（tab 被页面销毁后 url getter 返回空串，日志用它） */
    this.lastUrl = "";
    /** 录制器 binding 令牌桶：key（会话:执行上下文）→ { tokens, at } */
    this.bindingBuckets = new Map();
    /** tab 级总桶（第一次取令牌时才建，起点取当时的时钟） */
    this.bindingTotal = null;
    /** CDP 初始化一次性失败后的恢复：null = 还没试过；Promise = 已试过（成功 / 失败的结果被缓存，不无限重试） */
    this.initRecovery = null;
    this.favicon = null;
    this.lastStatus = null;
    this.lastLoadError = null;
    this.lastBlocked = null;
    this.navStarted = 0;
    this.navCommitted = 0;
    /** 该 tab 上 AI 想要的输入锁状态；导航 / 重连后据此重新上锁 */
    this.desiredIgnore = false;
    this.consoleRing = createRing(CONSOLE_RING_MAX);
    this.networkRing = createRing(NETWORK_RING_MAX);
    /** V2：网络条目单调递增 id（flush 进环形缓冲时分配，clear 后也不回绕）与详情暂存表（id → 头 / mime / postData / requestId） */
    this.netSeq = 0;
    this.netDetails = createNetworkDetailStore(NET_DETAIL_MAX);
    /** 资源计时补录：clear 时刻（之前开始的资源不再补）与已补过的行（去重，环淘汰后不重复补） */
    this.netClearedAt = 0;
    this.timingSeen = new Set();
    /** E2·S3 B1：WebSocket 帧 / SSE 事件采集（每连接 ≤200 帧、每 tab ≤50 连接；逻辑在 net-streams.mjs） */
    this.streams = createStreamCollector({ now: () => this.now(), addEntry: (partial) => this.#addStreamEntry(partial) });
    /** E2·S3 A5：`Fetch.requestPaused` 比 `Network.requestWillBeSent` 先到时暂存的「被规则处理」标记（`${sessionId|main}:${networkId}` → { ruled, ruleId }，见 noteNetworkRuled） */
    this.pendingRuled = new Map();
    /** 挂起中的 JS 对话框（DialogInfo 形状，对外可见）；内部元数据（sessionId / 定时器）在 #dialogMeta */
    /** @type {{ type: string, message: string, defaultPrompt?: string, url: string, since: number } | null} */
    this.pendingDialog = null;
    this.#dialogMeta = null;
    this.dialogListeners = new Set();
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
    /** 设备 / 环境模拟状态（emulation.mjs 的状态对象）；CDP 初始化后按它重放 */
    this.emulation = {};
    /** ref 表：{ first, last, map } | null（导航后失效）；nextRefNo 单调递增 */
    this.refTable = null;
    this.nextRefNo = 1;

    // ── CDP 状态 ──
    this.cdpReady = false;
    /** sessionId → { sessionId, targetId, parentSessionId }（仅 iframe 类型的子会话） */
    this.children = new Map();
    /** `${sessionId|main}:${frameId}` → 隔离世界 contextId */
    this.isoContexts = new Map();
    this.mainFrameId = null;
    this.scriptIds = new Map();
    /** `${sessionId}:${requestId}` → 网络条目（等响应补全） */
    this.inflight = new Map();
    this.cdpListeners = new Set();
    /** 契约 §15.1 扩展点：每个 CDP 会话（主 / OOPIF 子会话）初始化时调用；销毁时调用；各模块的 tab 级私有状态 */
    this.sessionHooks = new Set();
    this.destroyHooks = new Set();
    /** R6-09：「页面执行上下文已失效」订阅者（崩溃 / 跨文档导航提交 / debugger 断开）；见 addContextLostHook */
    this.contextLostHooks = new Set();
    this.ext = new Map();
    /** E2·P1：设备模拟落地后的回调 `fn({ next, prev, patch })`（页面权限据此给「定位模拟」绑定 origin；见 addEmulationHook） */
    this.emulationHooks = new Set();
    /**
     * E2·P1（net-guard 设置）：返回「本 tab 上正挂着的认证 / 证书提示」的结算 Promise，没有挂起提示返回 null。
     * navigate 超时到点时若还有提示在等用户，继续等它结算（提示自己有超时），免得用户正在填密码时 AI 就拿到「超时」。
     */
    this.promptHold = null;
    /** E2·P1：最近一次被放行的主框架证书错误 `{ host, error, source: "loopback"|"user", at }`（net-guard 写；导航到新文档时清空）；navigate 结果据此标注 */
    this.certOverride = null;

    /** 所属 partition（无痕标签是内存 partition：见 incognito.mjs）；弹窗收养的 tab 继承 opener 的 */
    this.partition = deps.partition ?? BROWSER_PARTITION;
    /** E2·A6：无痕标签（独立内存 partition，不共享持久档案的登录态） */
    this.incognito = isIncognitoPartition(this.partition);
    /** E2·A2：收养 Chromium 建好的弹窗 wc 时为 true（构造时不 loadURL：初始导航已由 Chromium 发起） */
    const adoptedWc = deps.adopt?.webContents ?? null;
    this.adopted = adoptedWc !== null;
    if (adoptedWc && !isSafePopupPrefs(adoptedWc.getLastWebPreferences?.())) {
      // 防御：弹窗 wc 的偏好比普通 tab 宽松（Electron 继承规则变化 / features 夹带）就拒收；调用方（createWindow 回调）会关掉它
      throw new BrowserError("INTERNAL", "弹窗 webContents 的安全偏好不符合要求，拒绝收养");
    }
    const view = adoptedWc
      ? new deps.WebContentsView({ webContents: adoptedWc })
      : new deps.WebContentsView({
          webPreferences: {
            partition: this.partition,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            // 视图挂在隐藏窗口里也要正常跑定时器 / rAF（探针 T3）
            backgroundThrottling: false,
            webSecurity: true,
            // 刻意不设 preload：页面碰不到任何壳 API
          },
        });
    this.view = view;
    this.wc = view.webContents;
    // 白底：没有这行时页面没设背景会透出窗口底色（暗色主题下一片黑）
    try {
      view.setBackgroundColor("#ffffff");
    } catch {
      /* 老版本没有该 API，忽略 */
    }
    // 后台跑的页面不该出声（停车场里 AI 自己在逛）
    try {
      this.wc.setAudioMuted(true);
    } catch {
      /* 忽略 */
    }
    this.parentWindow = null;
    this.#park(deps.parkingWindow);
    this.#wireWebContents();
    this.ready = this.#init().catch((err) => {
      this.log(`[browser:${this.id}] 初始化失败：${err?.message || err}`);
      throw err;
    });
    // 初始化失败也不能变成未处理的 rejection；真正用到时 await this.ready 会再抛出来
    this.ready.catch(() => {});
  }

  // ───────────────────────── 视图位置 ─────────────────────────

  #park(parkingWindow) {
    if (this.destroyed) return;
    this.#hostLeft = false;
    this.#slot = null;
    this.viewFit = null;
    parkingWindow.contentView.addChildView(this.view);
    this.parentWindow = parkingWindow;
    this.view.setBounds({ ...PARKING_BOUNDS });
    this.view.setVisible(true);
    try {
      this.wc.setAudioMuted(true);
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 搬回停车场。parkingWindow 为空（应用在退出、停车场窗口已先被关掉，R1-32）：不新建窗口，只把视图从当前父窗口摘下。
   * 父窗口此刻可能已销毁（主窗口 closed 事件里）：全程吞掉「已销毁」错误。
   */
  moveToParking(parkingWindow) {
    if (parkingWindow) {
      this.#park(parkingWindow);
      return;
    }
    if (this.destroyed) return;
    const parent = this.parentWindow;
    this.parentWindow = null;
    this.#hostLeft = true;
    this.#slot = null;
    this.viewFit = null;
    try {
      if (parent && !(typeof parent.isDestroyed === "function" && parent.isDestroyed())) parent.contentView.removeChildView(this.view);
    } catch {
      /* 窗口已销毁 / 视图已不在其上：无事可做 */
    }
  }

  /** 搬到主窗并设 bounds（addChildView 会自动从旧父窗口摘下，页面状态保留，探针 T8） */
  moveToMain(mainWindow, bounds, visible = true) {
    if (this.destroyed) return;
    this.#hostLeft = false;
    mainWindow.contentView.addChildView(this.view);
    this.parentWindow = mainWindow;
    this.#slot = bounds;
    this.#applySlot();
    this.#scheduleRefit();
    this.view.setVisible(visible);
    try {
      this.wc.setAudioMuted(false);
    } catch {
      /* 忽略 */
    }
  }

  setBounds(bounds) {
    if (this.destroyed) return;
    this.#slot = bounds;
    this.#applySlot();
    this.#scheduleRefit();
  }

  /**
   * 把槽位按当前设备模拟收窄后摆到视图上（居中、顶部对齐；没有模拟 / 模拟视口不比槽位小 = 原样）。
   * 只在挂在主窗口时有槽位；停车场里的视图用固定的 PARKING_BOUNDS，不走这里。
   *
   * R9-03：`viewFit`（视图占槽位的比例）随槽位宽 / 高变——A 模式（模拟视口比槽位小、不缩放）拖面板、B 模式里被高度限制的缩放拖宽，
   * 缩放百分比都不变、`viewFit` 却变了。渲染端遮盖占位图按它定位，所以它变了就要推状态（`onChange` 下游本来就是去抖的，拖面板每帧调也只合并成一次推送）；
   * 光靠 `#refit` 里「整数百分比变了才通知」会漏掉这种情况，遮盖图一出现就按旧比例摆一下。
   */
  #applySlot() {
    if (this.destroyed || !this.#slot) return;
    const { bounds, fit } = fitBoundsToEmulation(this.#slot, this.emulation, this.#fitScale);
    const fitChanged = !sameViewFit(this.viewFit, fit);
    this.viewFit = fit;
    this.view.setBounds(bounds);
    if (fitChanged) this.hooks.onChange();
  }

  /**
   * 该用的缩放比例：模拟视口（宽高都明确）比槽位大 → 整体缩小适应（不放大）；否则 1。
   * 停车场里（没有槽位）沿用当前比例，不为看不见的视图来回改——回到面板时 attach 会按新槽位重算。
   */
  #desiredFitScale(emulation = this.emulation) {
    if (!fitViewportOf(emulation)) return 1;
    if (!this.#slot) return this.#fitScale;
    return fitScaleFor(this.#slot, emulation);
  }

  /**
   * 排一个「按最新槽位重算缩放」的任务进模拟队列（与 emulate / reset 串行，不会和它们交叉发 CDP）。
   * 同一时刻队列里最多一个：拖面板每帧一次 setBounds，任务执行时读的是**当时最新**的槽位。
   */
  #scheduleRefit() {
    if (this.destroyed || this.#refitQueued) return;
    // 没有可缩放的视口、当前也没在缩放：槽位怎么变都与 CDP 无关
    if (this.#inputScale === 1 && !fitViewportOf(this.emulation)) return;
    this.#refitQueued = true;
    void this.#enqueueEmulation(async () => {
      this.#refitQueued = false;
      await this.#refit();
    }).catch(() => {});
  }

  /**
   * 让「页面实际的缩放」追上「槽位要求的缩放」：不一样就单独重发一条视口覆盖（带新 scale），成功后视图收成新大小。
   * 永不抛出（失败只记日志，视图仍按已生效的比例摆）。必须在模拟队列里调（见 #scheduleRefit / #applyEmulationNow）。
   */
  async #refit() {
    try {
      if (this.destroyed) return;
      if (this.cdpReady) {
        const want = this.#desiredFitScale();
        if (want !== this.#inputScale) {
          const cmd = viewportMetricsCommand(this.emulation, want);
          if (cmd) {
            const failed = await this.#runEmulationCommands([cmd]);
            if (failed.length > 0) this.log(`[browser:${this.id}] 缩放适配失败（页面保持原比例）：${failed.join("；")}`);
          }
        }
      }
      this.#applySlot();
      const pct = Math.round(this.#fitScale * 100);
      if (pct !== this.#notifiedFitPct) {
        this.#notifiedFitPct = pct;
        this.hooks.onChange();
      }
    } catch (err) {
      this.log(`[browser:${this.id}] 缩放适配出错（已忽略）：${err?.message || err}`);
    }
  }

  setVisible(visible) {
    if (!this.destroyed) this.view.setVisible(visible);
  }

  /** 视图自己的截图 → jpeg dataURL（遮盖占位图用；宿主截图不含原生视图，探针 T1） */
  async capturePlaceholder(maxWidth = 1600) {
    if (this.#wcGone()) return null;
    const img = await this.wc.capturePage();
    if (!img || img.isEmpty()) return null;
    const size = img.getSize();
    const scaled = size.width > maxWidth ? img.resize({ width: maxWidth }) : img;
    return `data:image/jpeg;base64,${scaled.toJPEG(70).toString("base64")}`;
  }

  // ───────────────────────── 基本信息 ─────────────────────────

  get url() {
    try {
      return this.destroyed ? "" : this.wc.getURL();
    } catch {
      return "";
    }
  }

  get title() {
    try {
      return this.destroyed ? "" : this.wc.getTitle();
    } catch {
      return "";
    }
  }

  /**
   * 在途网络请求数（只读；V1 wait_for networkIdle 用）。直接数 inflight 表，不改 #onNetwork：
   * 表里是「已发出、还没收到完成 / 失败事件」的请求（含 OOPIF 子会话的）。
   */
  get inflightRequestCount() {
    return this.inflight.size;
  }

  isLoading() {
    try {
      return !this.destroyed && this.wc.isLoading();
    } catch {
      return false;
    }
  }

  /**
   * wc 是否已不可用。页面自己 window.close() / 渲染进程被回收时，webContents 会先于我们的 destroy() 被销毁，
   * 此后任何访问（包括 getURL / navigationHistory / debugger）都抛 `Object has been destroyed`——
   * 在定时器 / 事件回调里抛出就是主进程 uncaughtException（Electron 默认弹错误框，评审 R1-09 真机复现）。
   */
  #wcGone() {
    if (this.destroyed) return true;
    try {
      return this.wc.isDestroyed?.() === true;
    } catch {
      return true;
    }
  }

  info(isActive) {
    let nav = null;
    let zoom = 100;
    let canGoBack = false;
    let canGoForward = false;
    if (!this.#wcGone()) {
      try {
        nav = this.wc.navigationHistory;
        canGoBack = nav ? nav.canGoBack() : false;
        canGoForward = nav ? nav.canGoForward() : false;
        // 缩放百分比整数（契约 §14.3）：读 wc 的实时 zoomLevel（1.2 ** level）。实测 Electron 的缩放按 host 共享（同 Chrome），
        // 所以读实时值才不会和实际画面对不上；100 = 不缩放
        zoom = nav ? Math.round(1.2 ** (this.wc.getZoomLevel?.() ?? 0) * 100) : 100;
      } catch {
        /* 读的瞬间 wc 被销毁：按「已关闭」的默认值返回，由 destroyed 事件把 tab 摘掉 */
      }
    }
    return {
      id: this.id,
      url: this.url,
      title: this.title,
      favicon: this.favicon,
      loading: this.isLoading(),
      canGoBack,
      canGoForward,
      zoom,
      isActive: isActive === true,
      // 设备 / 环境模拟的人话摘要（无模拟为 null）
      emulation: describeEmulation(this.emulation),
      // 视图被模拟收窄时，它占占位 div 的比例（遮盖占位图靠它摆位置）；没收窄时不带，普通标签的 info 形状不变
      ...(this.viewFit ? { viewFit: { ...this.viewFit } } : {}),
      // 缩放适配生效时（页面被整体缩小以放进面板）的比例，0..1；没缩放时不带。只用于工具栏提示，不进 AI 看到的模拟摘要
      ...(this.#fitScale < 1 ? { fitScale: this.#fitScale } : {}),
      // E2·A6：无痕标签（只在为真时带，普通标签的 info 形状不变）
      ...(this.incognito ? { incognito: true } : {}),
    };
  }

  // ───────────────────────── webContents 事件 ─────────────────────────

  #wireWebContents() {
    const wc = this.wc;
    const changed = () => {
      if (!this.destroyed) this.hooks.onChange();
    };

    // 主 frame 导航的 URL 策略：will-navigate（页面 / 用户发起）+ will-redirect（服务端 30x）。子 frame 不拦（契约 §7）
    const guard = (event, urlArg, source) => {
      const url = String(event?.url ?? urlArg ?? "");
      const verdict = checkUrl(url, { isAppUrl: this.deps.isAppUrl });
      if (verdict.ok) return;
      event.preventDefault();
      this.#noteBlocked(url, verdict.reason, source);
    };
    wc.on("will-navigate", (event, url) => guard(event, url, "will-navigate"));
    wc.on("will-redirect", (event, url) => guard(event, url, "will-redirect"));

    wc.setWindowOpenHandler((details) => {
      // 任何异常都一律 deny（R2-06）：这个回调抛错时 Electron 会按默认放行开出一个不受管理的原生窗口
      try {
        const verdict = checkUrl(details.url, { isAppUrl: this.deps.isAppUrl });
        if (!verdict.ok) {
          this.#noteBlocked(details.url, verdict.reason, "window-open");
          return { action: "deny" };
        }
        const disposition = String(details.disposition ?? "");
        // E2·A2：满足全部条件（真实手势 / URL 过策略 / 没超 tab 上限 / 没超限流，由 session 判）的弹窗放行并保留 window.opener
        const popup = this.#popupAllow(verdict.url, disposition);
        if (popup) return popup;
        this.hooks.onNewTab({ url: verdict.url, disposition, openerTabId: this.id });
      } catch (err) {
        this.log(`[browser:${this.id}] 处理页面新窗口请求出错，已拒绝：${err?.message || err}`);
      }
      // 其余一律 deny：新窗口交给 session 开成同会话的新 tab（无 opener：脚本式 / 无手势 / 超限 / 被限流的 window.open 走这里，行为同 E1）
      return { action: "deny" };
    });
    // 浏览器进程输入管线里的按下类输入 = 真实手势（A2 弹窗放行的判据之一，见 #lastInputAt）。回调要极轻：mouseMove 等高频事件也会进来
    wc.on("input-event", (_e, inputEvent) => {
      if (isGestureInput(inputEvent)) this.#lastInputAt = this.now();
    });

    wc.on("did-start-navigation", (details) => {
      if (details?.isMainFrame && !details.isSameDocument) {
        this.navStarted += 1;
        this.lastLoadError = null;
      }
      changed();
    });
    wc.on("did-navigate", (_e, url, httpResponseCode) => {
      this.navCommitted += 1;
      // R6-09：新文档已提交（可能换了渲染进程）= 旧文档里的调试器暂停不再有意义，也不会再有 Debugger.resumed
      this.#fireContextLost("navigate");
      // 真实手势只对「当前文档」有效（与 Chrome 的 transient activation 一致）：跨文档导航后上一个页面里的点击不能再给新页面的 window.open 背书
      this.#lastGestureAt = 0;
      this.#lastInputAt = 0;
      this.lastUrl = String(url ?? ""); // 页面自己 window.close() 后 url getter 已返回空串，日志里要留最后所在的页面
      this.lastStatus = typeof httpResponseCode === "number" && httpResponseCode > 0 ? httpResponseCode : null;
      this.refTable = null; // §3：该 tab 发生导航后旧 ref 全部失效
      this.favicon = null;
      // 事后兜底：被拦的导航理论上到不了这里；万一到了（引擎路径遗漏），立刻退回空白页而不是停在被禁地址上
      if (!/^chrome-error:/i.test(url)) {
        const verdict = checkUrl(url, { isAppUrl: this.deps.isAppUrl });
        if (!verdict.ok) {
          this.#noteBlocked(url, verdict.reason, "post-commit");
          void this.wc.loadURL("about:blank").catch(() => {});
        }
      }
      this.hooks.onNeedLockSync();
      changed();
    });
    wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => {
      if (isMainFrame) changed();
    });
    wc.on("did-start-loading", changed);
    wc.on("did-stop-loading", () => {
      this.#settleStuckDocuments();
      changed();
    });
    wc.on("page-title-updated", changed);
    wc.on("page-favicon-updated", (_e, favicons) => {
      // 评审 R1-06：URL 由页面决定、渲染进程会直接 <img src> 它——只放公网 https / 位图 data URL（见 url-policy.isSafeFaviconUrl）
      const pick = (Array.isArray(favicons) ? favicons : []).find((u) => isSafeFaviconUrl(u, { isAppUrl: this.deps.isAppUrl }));
      this.favicon = pick ?? null;
      changed();
    });
    // 页面自己 window.close() / 渲染进程被引擎回收：wc 在我们不知情时就没了。必须摘掉这个 tab，
    // 否则下一次状态推送读 wc 会抛 `Object has been destroyed`（主进程 uncaughtException，评审 R1-09）。
    // 我们自己 destroy() 时 this.destroyed 已先置位，这里直接返回。
    //
    // 区分「页面自己关」与「宿主窗口整个在拆」：app.exit() / 窗口被强关时，Electron 先销毁窗口（`closed`，此时
    // `win.isDestroyed()` 已为 true），约十几毫秒后才连带销毁子视图的 wc（真机探针实测）；页面自己 window.close() 时宿主窗口还活着。
    // 后一种情况 session 不能「补空白页」——那会在退出过程中新建原生视图 / 停车场窗口，Electron 直接 SIGTRAP 崩掉
    // （`tests/browser-e2e-bridge.test.ts` 的 g 用例：peer 带着活会话 app.exit(0) 时复现过，生产里自更新重启走的也是 app.exit）。
    wc.on("destroyed", () => {
      if (this.destroyed) return;
      let hostGone = this.#hostLeft; // moveToParking(null) 置空过 parentWindow = 应用在退出，宿主已走
      try {
        if (!hostGone) hostGone = this.parentWindow?.isDestroyed?.() === true;
      } catch {
        hostGone = true; // 连问一声都抛 = 窗口对象已经不可用，按「在拆」处理
      }
      this.log(`[browser:${this.id}] webContents 被${hostGone ? "销毁（宿主窗口已销毁，应用在退出）" : "页面 / 引擎销毁"}`);
      this.#teardown({ closeWc: false });
      try {
        this.hooks.onGone?.({ hostGone });
      } catch (err) {
        this.log(`[browser:${this.id}] onGone 处理失败：${err?.message || err}`);
      }
    });
    wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 = ERR_ABORTED：被新导航 / 停止 / will-* 拦截打断，不算失败
      if (isMainFrame && errorCode !== -3) {
        this.lastLoadError = { code: errorCode, description: String(errorDescription ?? ""), url: String(validatedURL ?? "") };
      }
      changed();
    });
    wc.on("did-finish-load", () => {
      this.crashed = false;
      this.hooks.onLoaded({ url: this.url, title: this.title });
      this.hooks.onNeedLockSync();
      changed();
    });
    wc.on("render-process-gone", (_e, details) => {
      this.crashed = true;
      this.cdpReady = false;
      this.log(`[browser:${this.id}] 页面进程退出 reason=${details?.reason}`);
      this.#fireContextLost("crash");
      this.hooks.onCrashed();
      changed();
    });
  }

  #noteBlocked(url, reason, source) {
    this.lastBlocked = { url, reason, source, at: this.now() };
    this.log(`[browser:${this.id}] 导航被拦截 source=${source} url=${String(url).slice(0, 80)}`);
    this.hooks.onBlocked({ url, reason, source });
  }

  // ───────────────────────── CDP ─────────────────────────

  /** 向主会话（或子会话）发 CDP 命令；带超时，避免页面卡死时把整个 op 链拖死 */
  send(method, params = {}, sessionId = null, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.#wcGone()) return Promise.reject(new BrowserError("TAB_NOT_FOUND", "标签页已关闭"));
    // 缩放适配生效时，AI 给的是页面 CSS 坐标、CDP 输入要的是视图坐标：在这唯一的出口统一乘 scale（契约 §14.4；全仓只有这里碰 debugger.sendCommand）
    const wire = this.#inputScale < 1 ? scaleInputParams(method, params, this.#inputScale) : params;
    let p;
    try {
      const dbg = this.wc.debugger;
      p = sessionId ? dbg.sendCommand(method, wire, sessionId) : dbg.sendCommand(method, wire);
    } catch (err) {
      // 检查与访问之间 wc 被销毁：同步抛出变成 rejection，调用方统一按「标签页已关闭」处理
      return Promise.reject(new BrowserError("TAB_NOT_FOUND", `标签页已关闭（${String(err?.message || err).slice(0, 60)}）`));
    }
    return withTimeout(p, timeoutMs, method);
  }

  /**
   * 契约 §15.1：注册「CDP 会话初始化」钩子 `fn(sessionId | null)`（null = 主会话）。
   * 每次主会话（重新）attach 与每个 OOPIF 子会话挂接时都会调用（域启用之后、页内脚本安装之后），所以模块的 CDP 开关（`Fetch.enable` /
   * `Network.setCacheDisabled` / `Audits.enable` …）放这里就能在 debugger 重连、新子 frame 上自动重放。钩子出错只记日志、不影响初始化。
   * 返回取消函数。已经在跑的会话不会补调：要立刻生效请自己对 {@link cdpSessionIds} 逐个调一遍。
   */
  addSessionHook(fn) {
    this.sessionHooks.add(fn);
    return () => this.sessionHooks.delete(fn);
  }

  /** 当前所有 CDP 会话 id：`null`（主会话）+ 全部 OOPIF 子会话 */
  cdpSessionIds() {
    return [null, ...this.children.keys()];
  }

  /** 契约 §15.1：tab 销毁时调用（模块释放 timer / 文件句柄等）；返回取消函数 */
  addDestroyHook(fn) {
    this.destroyHooks.add(fn);
    return () => this.destroyHooks.delete(fn);
  }

  /**
   * R6-09：订阅「页面执行上下文已失效」`fn(reason)`，reason ∈ `crash`（渲染进程退出）/ `navigate`（跨文档导航已提交，含换进程）/ `detach`（debugger 断开）。
   * 为什么需要：调试器暂停态此前只靠 `Debugger.resumed` 清——这三种情况都不会再来 `resumed`，`tab.debugPause` 清不掉，入口闸门把该 tab 永久锁死。
   * tab 销毁走 destroyHook（不在这里）。回调出错只记日志；返回取消函数。
   */
  addContextLostHook(fn) {
    this.contextLostHooks.add(fn);
    return () => this.contextLostHooks.delete(fn);
  }

  #fireContextLost(reason) {
    for (const fn of [...this.contextLostHooks]) {
      try {
        fn(reason);
      } catch (err) {
        this.log(`[browser:${this.id}] 上下文失效钩子出错（已忽略）：${err?.message || err}`);
      }
    }
  }

  /**
   * E2·P1：订阅「设备模拟已落地」`fn({ next, prev, patch })`（成功才调；失败回滚时不调）。
   * 页面权限用它在 `emulate` 设置定位时记下「当时在哪个 origin」，让定位模拟只对该 origin 免提示。回调出错只记日志。返回取消函数。
   */
  addEmulationHook(fn) {
    this.emulationHooks.add(fn);
    return () => this.emulationHooks.delete(fn);
  }

  /** 契约 §15.1：取 / 建某个模块的 tab 级私有状态 */
  getExt(key, factory) {
    if (!this.ext.has(key)) this.ext.set(key, factory());
    return this.ext.get(key);
  }

  /** 订阅 CDP 事件（actions 里的拖拽拦截等用）；返回取消函数 */
  onCdpEvent(fn) {
    this.cdpListeners.add(fn);
    return () => this.cdpListeners.delete(fn);
  }

  async #init() {
    // 必须先有一次导航：没有渲染进程的空视图上 debugger.attach 后 Page.enable 会一直挂住（实测）。
    // 收养的弹窗 wc 不需要：Chromium 已为它发起了初始导航（探针实测：不 loadURL，弹窗直接加载目标页；这里再 loadURL 反而会打断它）
    if (!this.adopted) await this.wc.loadURL("about:blank").catch(() => {});
    await this.#attachDebugger();
  }

  async #attachDebugger() {
    const dbg = this.wc.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    if (!this.dbgBound) {
      this.dbgBound = true;
      // 主会话的 sessionId：真 Electron 给的是空串 ""（不是 undefined / null），用 ?? 归一不掉；
      // 必须是 null，否则 isoContexts 的键会分裂成 `main:<frame>`（初始化时写）与 `:<frame>`（事件里写），
      // 前者过期后永远清不掉，mainFrameId 也不随导航更新（Page.frameNavigated 判的是 sessionId === null），
      // 导致隔离世界里的 overlay / 资源计时补录第一次导航之后全打到过期的 context 上（被 catch 静默吞掉）
      dbg.on("message", (_e, method, params, sessionId) => this.#onCdpMessage(method, params, sessionId || null));
      dbg.on("detach", (_e, reason) => {
        this.cdpReady = false;
        // debugger 断开 = 页面里的视口覆盖（含缩放）都没了；重新 attach 后由 #replayEmulation 按状态重放
        this.#inputScale = 1;
        this.#fitScale = 1;
        this.log(`[browser:${this.id}] debugger 断开 reason=${reason}`);
        this.#fireContextLost("detach");
      });
    }
    await this.#setupSession(null);
    this.cdpReady = true;
    // debugger 重新 attach 后之前的覆盖都没了：按 tab 上存的状态重放（只对主会话，OOPIF 子会话不处理）
    await this.#replayEmulation();
    this.#applySlot(); // 重放里的缩放比例可能变了：视图跟着收成对应大小
    await this.#syncMainFrameId();
    // 控制权在 CDP 就绪前就可能已经切到 ai（新 tab 诞生于 AI 驱动期间）：这里补上锁
    if (this.desiredIgnore) await this.#applyIgnore(true);
  }

  /** 每次 op 前确认 CDP 可用：渲染进程崩溃重载后 debugger 会掉，这里自愈 */
  async ensureCdp() {
    if (this.#wcGone()) throw new BrowserError("TAB_NOT_FOUND", "标签页已关闭");
    try {
      await this.ready;
    } catch (err) {
      // 构造时的一次性初始化失败（首次导航 / attach 抛错）。此前 this.ready 永久 rejected，这个 tab 此后每个 op 都失败、
      // AI 只看到同一句晦涩的内部错误（评审 R1-21）：这里再试一次，仍失败就给出可操作的指引
      await this.#recoverInit(err);
    }
    if (this.#wcGone()) throw new BrowserError("TAB_NOT_FOUND", "标签页已关闭");
    if (!this.cdpReady || !this.wc.debugger.isAttached()) {
      this.children.clear();
      this.isoContexts.clear();
      await this.#attachDebugger();
    }
  }

  /** 初始化失败的恢复：只重试一次（并发调用共用同一次），结果被缓存——成功后 ready 视为就绪，失败后每次都直接给同一条指引 */
  #recoverInit(firstErr) {
    if (this.initRecovery === null) {
      this.initRecovery = (async () => {
        this.log(`[browser:${this.id}] 初始化失败，重试一次：${firstErr?.message || firstErr}`);
        this.children.clear();
        this.isoContexts.clear();
        try {
          await this.#attachDebugger();
          this.ready = Promise.resolve();
        } catch (err) {
          this.log(`[browser:${this.id}] 初始化重试仍失败：${err?.message || err}`);
          throw new BrowserError(
            "INTERNAL",
            `该标签页的调试连接初始化失败（${String(err?.message || err).slice(0, 80)}），无法操作：请用 browser_tabs close 关闭它，再 new 一个新标签页`,
          );
        }
      })();
      // 失败结果会被后续调用再次 await；先挂个空 catch，避免第一次没人 await 时变成未处理的 rejection
      this.initRecovery.catch(() => {});
    }
    return this.initRecovery;
  }

  async #syncMainFrameId() {
    try {
      const r = await this.send("Page.getFrameTree", {});
      this.mainFrameId = r?.frameTree?.frame?.id ?? this.mainFrameId;
    } catch {
      /* 取不到就等 frameNavigated 事件补 */
    }
  }

  /** 一个会话（主 / OOPIF 子会话）的统一初始化：域启用 → 自动挂接 → 绑定 → 页内脚本 */
  async #setupSession(sessionId) {
    const s = (method, params) => this.send(method, params ?? {}, sessionId);
    await Promise.all([
      s("Page.enable"),
      s("Runtime.enable"),
      s("DOM.enable"),
      s("Network.enable", { maxTotalBufferSize: 2_000_000, maxResourceBufferSize: 500_000 }),
      s("Log.enable"),
      s("Emulation.setFocusEmulationEnabled", { enabled: true }),
    ]);
    await s("Target.setAutoAttach", AUTO_ATTACH_PARAMS);
    await this.#installPageScripts(sessionId);
    for (const hook of [...this.sessionHooks]) {
      try {
        await hook(sessionId);
      } catch (err) {
        this.log(`[browser:${this.id}] 会话钩子出错（已忽略）：${err?.message || err}`);
      }
    }
  }

  async #installPageScripts(sessionId) {
    const { PAGE_WORLD_NAME, RECORDER_BINDING, buildPageScript } = this.pageScripts;
    const source = buildPageScript({ recordValues: this.recordValues });
    const s = (method, params) => this.send(method, params ?? {}, sessionId);
    await s("Runtime.addBinding", { name: RECORDER_BINDING, executionContextName: PAGE_WORLD_NAME });
    const added = await s("Page.addScriptToEvaluateOnNewDocument", { source, worldName: PAGE_WORLD_NAME });
    if (added?.identifier) this.scriptIds.set(sessionId ?? "main", added.identifier);
    // 已存在的 frame：新文档脚本只对「之后创建的文档」生效，所以对现有 frame 也手动装一遍（脚本自带幂等保护）
    const tree = (await s("Page.getFrameTree"))?.frameTree;
    const frames = [];
    const walk = (n) => {
      if (!n?.frame) return;
      frames.push(n.frame.id);
      for (const c of n.childFrames ?? []) walk(c);
    };
    walk(tree);
    await Promise.all(
      frames.map(async (frameId) => {
        try {
          const { executionContextId } = await s("Page.createIsolatedWorld", { frameId, worldName: PAGE_WORLD_NAME });
          this.isoContexts.set(`${sessionId ?? "main"}:${frameId}`, executionContextId);
          await s("Runtime.evaluate", { expression: source, contextId: executionContextId, silent: true });
        } catch {
          /* frame 正好在导航 / 已销毁：新文档脚本会兜住 */
        }
      }),
    );
  }

  /** 录制配置变化（config 消息）：重装页内脚本使「新文档」按新配置启动，并让现有文档立刻生效 */
  async setRecordValues(on) {
    this.recordValues = on === true;
    if (!this.cdpReady) return;
    try {
      const expression = `globalThis.__flowship && globalThis.__flowship.configure({recordValues:${this.recordValues}})`;
      await Promise.all(
        [...this.isoContexts.entries()].map(([key, contextId]) =>
          this.send("Runtime.evaluate", { expression, contextId, silent: true }, this.#sessionOfKey(key)).catch(() => {}),
        ),
      );
      // 新文档的脚本源码里烧进了 recordValues：换掉旧注册
      for (const [key, identifier] of [...this.scriptIds.entries()]) {
        const sid = key === "main" ? null : key;
        await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sid).catch(() => {});
        this.scriptIds.delete(key);
        const source = this.pageScripts.buildPageScript({ recordValues: this.recordValues });
        const added = await this.send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source, worldName: this.pageScripts.PAGE_WORLD_NAME },
          sid,
        ).catch(() => null);
        if (added?.identifier) this.scriptIds.set(key, added.identifier);
      }
    } catch (err) {
      this.log(`[browser:${this.id}] 更新录制配置失败：${err?.message || err}`);
    }
  }

  #sessionOfKey(key) {
    const sid = key.slice(0, key.indexOf(":"));
    return sid === "main" ? null : sid;
  }

  #onCdpMessage(method, params, sessionId) {
    for (const l of this.cdpListeners) {
      try {
        l(method, params, sessionId);
      } catch {
        /* 监听者出错不能影响分发 */
      }
    }
    switch (method) {
      case "Target.attachedToTarget":
        this.#onAttached(params, sessionId);
        return;
      case "Target.detachedFromTarget": {
        const sid = params?.sessionId;
        if (sid) {
          this.children.delete(sid);
          for (const k of [...this.isoContexts.keys()]) if (k.startsWith(`${sid}:`)) this.isoContexts.delete(k);
          this.scriptIds.delete(sid);
        }
        return;
      }
      case "Page.frameNavigated": {
        const f = params?.frame;
        if (f && !f.parentId && sessionId === null) this.mainFrameId = f.id;
        return;
      }
      case "Runtime.executionContextCreated": {
        const c = params?.context;
        if (c?.name === this.pageScripts.PAGE_WORLD_NAME && c.auxData?.frameId) {
          this.isoContexts.set(`${sessionId ?? "main"}:${c.auxData.frameId}`, c.id);
        }
        return;
      }
      case "Runtime.executionContextDestroyed": {
        const id = params?.executionContextId;
        this.#dropBindingBuckets(sessionId, id);
        for (const [k, v] of [...this.isoContexts.entries()]) {
          if (v === id && this.#sessionOfKey(k) === sessionId) this.isoContexts.delete(k);
        }
        return;
      }
      case "Runtime.executionContextsCleared": {
        this.#dropBindingBuckets(sessionId, null);
        for (const k of [...this.isoContexts.keys()]) if (this.#sessionOfKey(k) === sessionId) this.isoContexts.delete(k);
        return;
      }
      case "Runtime.bindingCalled":
        this.#onBinding(params, sessionId);
        return;
      case "Runtime.consoleAPICalled":
        this.#onConsole(params);
        return;
      case "Runtime.exceptionThrown":
        this.#onException(params);
        return;
      case "Log.entryAdded":
        this.#onLogEntry(params);
        return;
      case "Network.requestWillBeSent":
      case "Network.responseReceived":
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        this.#onNetwork(method, params, sessionId);
        return;
      // E2·S3 B1：WebSocket 帧 / SSE 事件 / 内存缓存命中（采集逻辑在 net-streams.mjs）
      case "Network.webSocketCreated":
      case "Network.webSocketWillSendHandshakeRequest":
      case "Network.webSocketHandshakeResponseReceived":
      case "Network.webSocketFrameSent":
      case "Network.webSocketFrameReceived":
      case "Network.webSocketFrameError":
      case "Network.webSocketClosed":
      case "Network.eventSourceMessageReceived":
        try {
          this.streams.handle(method, params, sessionId);
        } catch (err) {
          this.log(`[browser:${this.id}] 流式网络事件处理出错（已忽略）：${err?.message || err}`);
        }
        return;
      case "Network.requestServedFromCache": {
        const cached = this.inflight.get(`${sessionId ?? "main"}:${params?.requestId}`);
        if (cached) cached.cache = "fromMemoryCache";
        return;
      }
      case "Page.javascriptDialogOpening":
        this.#onDialog(params, sessionId);
        return;
      case "Page.javascriptDialogClosed":
        // 对话框被别的途径收掉了（页面导航 / 渲染进程换血）：挂起状态不能残留
        this.#onDialogClosed(sessionId);
        return;
      default:
    }
  }

  #onAttached(params, parentSessionId) {
    const { sessionId, targetInfo } = params ?? {};
    if (!sessionId) return;
    if (targetInfo?.type !== "iframe") {
      // 正常到不了这里：AUTO_ATTACH_PARAMS 带了 iframe 过滤器，worker / service worker 根本不会被附加。
      // **绝不能**在这里回 Target.detachFromTarget（以前的做法）：Electron 42.4.0（Chromium 148）上，页面一创建 Web Worker
      // （baidu.com 首页就会起 blob: Worker），对它的会话发 detachFromTarget 会让主进程 SIGSEGV 直接闪退（2026-11-10 v1.9.46 事故）。
      // 万一过滤器哪天失效漏进来：留着不动即可，没人往这个会话发命令，开销可以忽略。
      return;
    }
    this.children.set(sessionId, { sessionId, targetId: targetInfo.targetId, parentSessionId: parentSessionId ?? null });
    // OOPIF 子会话：与主会话同一套初始化（探针 T6：子会话读树、录制器 / 绑定也要各装一份）
    void this.#setupSession(sessionId).catch((err) => {
      this.log(`[browser:${this.id}] 子会话初始化失败：${err?.message || err}`);
    });
  }

  /**
   * 取一个令牌：先过本 frame 的桶（容量 BINDING_BUCKET_CAPACITY、每秒补 BINDING_REFILL_PER_SEC），再过 tab 级总桶；任一为空返回 false。
   * 先扣 frame 桶：灌水的 frame 先烧光自己的令牌被拒，碰不到总桶。
   */
  #takeBindingToken(bucketKey) {
    const now = this.now();
    let b = this.bindingBuckets.get(bucketKey);
    if (!b) {
      if (this.bindingBuckets.size >= BINDING_MAX_BUCKETS) {
        // 淘汰最闲的桶（补完令牌后最满的）；严格大于 = 并列时留第一个（最早建的）
        let victim = null;
        let best = -1;
        for (const [k, v] of this.bindingBuckets) {
          const filled = Math.min(BINDING_BUCKET_CAPACITY, v.tokens + (Math.max(0, now - v.at) / 1000) * BINDING_REFILL_PER_SEC);
          if (filled > best) {
            best = filled;
            victim = k;
          }
        }
        this.bindingBuckets.delete(victim);
      }
      b = { tokens: BINDING_BUCKET_CAPACITY, at: now };
      this.bindingBuckets.set(bucketKey, b);
    }
    if (!BrowserTab.#takeFrom(b, now, BINDING_BUCKET_CAPACITY, BINDING_REFILL_PER_SEC)) return false;
    if (!this.bindingTotal) this.bindingTotal = { tokens: BINDING_TOTAL_CAPACITY, at: now };
    return BrowserTab.#takeFrom(this.bindingTotal, now, BINDING_TOTAL_CAPACITY, BINDING_TOTAL_REFILL_PER_SEC);
  }

  /** 令牌桶补充 + 扣一个：桶 { tokens, at }；不够 1 个返回 false */
  static #takeFrom(bucket, now, capacity, perSec) {
    const elapsedSec = Math.max(0, now - bucket.at) / 1000;
    bucket.at = now;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * perSec);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** 某个会话的某个（或全部）执行上下文没了：对应的令牌桶一并清掉，免得导航多了把桶表占满 */
  #dropBindingBuckets(sessionId, executionContextId) {
    const sid = sessionId ?? "main";
    if (executionContextId != null) {
      this.bindingBuckets.delete(`${sid}:${executionContextId}`);
      return;
    }
    for (const k of [...this.bindingBuckets.keys()]) if (k.startsWith(`${sid}:`)) this.bindingBuckets.delete(k);
  }

  #onBinding(params, sessionId) {
    if (params?.name !== this.pageScripts.RECORDER_BINDING) return;
    const payload = params.payload;
    // 防御：录制器是我们自己的脚本，但它跑在被不信任页面的进程里，载荷大小 / 形状都不能假设
    if (typeof payload !== "string" || payload.length > 16_000) return;
    // 令牌桶限速（评审 R1-04）：binding 对页面主世界不可见，但录制器本身运行在被不信任页面的进程里，
    // 页内脚本一旦以某种方式拿到调用能力就能无限灌——超限的事件直接丢，不 JSON.parse、不进活动日志。
    // 按 frame（会话 + 执行上下文）分桶（R3-04）
    if (!this.#takeBindingToken(`${sessionId ?? "main"}:${params.executionContextId ?? "?"}`)) return;
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    if (!evt || typeof evt !== "object") return;
    if (GESTURE_EVENT_TYPES.has(evt.type)) this.#lastGestureAt = this.now();
    this.hooks.onRecorder({ ...evt, tabId: this.id });
  }

  /** 最近 withinMs 毫秒内有没有真实手势（点击 / Enter 等）；session 用它判断页面发起的新窗口是不是用户操作带来的 */
  hadRecentGesture(withinMs) {
    return this.#lastGestureAt > 0 && this.now() - this.#lastGestureAt <= withinMs;
  }

  /**
   * E2·A2：最近 withinMs 毫秒内浏览器进程的输入管线里有没有按下类输入（鼠标按下 / 触摸 / 按键，见 popup-policy.isGestureInput）。
   * 真实用户输入与 AI 的 CDP 派发输入都会触发，页面脚本伪造不了；弹窗放行与 {@link hadRecentGesture}（页内录制器）任一为真即可。
   */
  hadRecentTrustedInput(withinMs) {
    return this.#lastInputAt > 0 && this.now() - this.#lastInputAt <= withinMs;
  }

  /**
   * 把「这个 tab 刚加载的 URL 是浏览器侧（已验证过真实手势）发起的」记成下载令牌——收养的弹窗 wc 没经过 loadURL，
   * 它的初始导航引出的下载同样 hasUserGesture()=false（与 {@link loadUrlByUser} 同理）。只记通过 URL 策略的 URL。
   * @param {string} url
   */
  noteBrowserInitiatedLoad(url) {
    const verdict = checkUrl(url, { isAppUrl: this.deps.isAppUrl });
    if (verdict.ok) this.#recordBrowserNav(verdict.url, BROWSER_USER_NAV_DOWNLOAD_MS);
  }

  /**
   * E2·A2：这次 `window.open` 能不能放行并保留 `window.opener`。
   * 通过（session 经 onPopupRequest 给了预留票）→ 返回 `{ action: "allow", createWindow }`；否则返回 null（调用方走老路径）。
   * 此时 URL 已过 checkUrl（含 Flowship origin 阻断）；手势 / tab 上限 / 限流由 session 在 onPopupRequest 里判。
   *
   * 只对 foreground-tab / new-window 放行：background-tab 是用户按住修饰键点链接（浏览器侧行为，本来就没有 opener 语义），
   * save-to-disk / other 不是 window.open。
   */
  #popupAllow(url, disposition) {
    if (typeof this.hooks.onPopupRequest !== "function") return null;
    if (disposition !== "foreground-tab" && disposition !== "new-window") return null;
    let ticket = null;
    try {
      ticket = this.hooks.onPopupRequest({ url, openerTabId: this.id }) ?? null;
    } catch (err) {
      this.log(`[browser:${this.id}] 弹窗判定出错，按普通新标签处理：${err?.message || err}`);
      return null;
    }
    if (!ticket) return null;
    return {
      action: "allow",
      // 弹窗是会话里的一个 tab：opener 跨站导航（render view 被换掉）时 Electron 默认会连带销毁弹窗，这里要求它独立存活
      outlivesOpener: true,
      // 与普通 tab 同样的安全偏好（覆盖 features 字符串里解析出的宽松项）；刻意没有 preload / partition
      overrideBrowserWindowOptions: { webPreferences: { ...POPUP_WEB_PREFERENCES } },
      createWindow: (options) => this.#adoptPopup(options, ticket, url, disposition),
    };
  }

  /**
   * `createWindow` 回调：把 Chromium 建好的弹窗 wc 收养成 tab。
   * **必须原样返回 `options.webContents` 且绝不能抛**（Electron 校验返回值同一性；回调抛错 = 主进程 uncaughtException，探针实测）：
   * 任何失败都吞掉，退化成「关掉弹窗 wc + 按普通新标签补开」。
   */
  #adoptPopup(options, ticket, url, disposition) {
    const popupWc = options?.webContents;
    try {
      if (!popupWc) {
        // Chromium 没预建 wc（Electron 只在 -new-window 路径这样；返回值此时被忽略）：没有 opener 可保留，按普通新标签开
        ticket.release();
        this.hooks.onNewTab({ url, disposition, openerTabId: this.id });
        return popupWc;
      }
      // 弹窗必须与 opener 同 session（同 partition）：Chromium 对同 browsing context group 的弹窗保证这点，这里再核对一次
      if (popupWc.session !== this.wc.session) throw new Error("弹窗的 session 与 opener 不一致");
      if (this.#wcGone()) throw new Error("opener 已销毁");
      ticket.adopt(popupWc);
    } catch (err) {
      this.log(`[browser:${this.id}] 弹窗收养失败，已关闭并按普通新标签处理：${err?.message || err}`);
      try {
        ticket.release();
      } catch {
        /* 票已还 / 会话已销毁 */
      }
      try {
        if (popupWc && !popupWc.isDestroyed?.()) popupWc.close?.();
      } catch {
        /* 已销毁 */
      }
      try {
        this.hooks.onNewTab({ url, disposition, openerTabId: this.id });
      } catch {
        /* 补开失败也不能让 createWindow 抛 */
      }
    }
    return popupWc;
  }

  #onConsole(params) {
    const type = String(params?.type ?? "log");
    const level = type === "error" || type === "assert" ? "error" : type === "warning" ? "warning" : type === "debug" ? "debug" : type === "info" ? "info" : "log";
    const text = clipText((params?.args ?? []).map(remoteObjectText).join(" "), CONSOLE_TEXT_MAX);
    const frame = params?.stackTrace?.callFrames?.[0];
    const entry = { ts: this.now(), level, text };
    if (frame?.url) entry.url = clipText(frame.url, URL_LOG_MAX);
    if (typeof frame?.lineNumber === "number") entry.line = frame.lineNumber + 1;
    // E2·P7a B3：保留结构化栈（限帧 / 限长 / URL 脱敏），读取时才按需经 sourcemap 还原
    const stack = compactStackFrames(params?.stackTrace?.callFrames, redactUrlSecrets);
    if (stack) entry.stack = stack;
    this.consoleRing.push(entry);
  }

  #onException(params) {
    const d = params?.exceptionDetails;
    if (!d) return;
    const text = clipText(d.exception?.description ?? d.text ?? "未捕获的异常", CONSOLE_TEXT_MAX);
    const entry = { ts: this.now(), level: "error", text };
    if (d.url) entry.url = clipText(d.url, URL_LOG_MAX);
    if (typeof d.lineNumber === "number") entry.line = d.lineNumber + 1;
    const stack = compactStackFrames(d.stackTrace?.callFrames, redactUrlSecrets);
    if (stack) entry.stack = stack;
    this.consoleRing.push(entry);
  }

  #onLogEntry(params) {
    const e = params?.entry;
    if (!e) return;
    // Log 域：浏览器自己产生的日志（资源 404 / CSP 拦截 / 弃用警告）。console API 的不走这里，避免重复
    if (e.source === "javascript") return;
    const level = e.level === "error" ? "error" : e.level === "warning" ? "warning" : e.level === "verbose" ? "debug" : "info";
    const entry = { ts: this.now(), level, text: clipText(e.text ?? "", CONSOLE_TEXT_MAX) };
    if (e.url) entry.url = clipText(e.url, URL_LOG_MAX);
    if (typeof e.lineNumber === "number") entry.line = e.lineNumber + 1;
    this.consoleRing.push(entry);
  }

  #onNetwork(method, p, sessionId) {
    const key = `${sessionId ?? "main"}:${p?.requestId}`;
    if (method === "Network.requestWillBeSent") {
      const req = p.request ?? {};
      const url = String(req.url ?? "");
      if (/^(data|blob):/i.test(url)) return;
      // 重定向：requestWillBeSent 带 redirectResponse，先把上一跳收尾（沿用同一 requestId）
      const prev = this.inflight.get(key);
      if (prev && p.redirectResponse) {
        prev.status = p.redirectResponse.status ?? prev.status;
        prev.durationMs = Math.max(0, Math.round((p.timestamp - prev.__t0) * 1000));
        // V2：中间跳留下它自己的响应头 / mime，并标记「重定向」（它没有可取的响应体）
        prev.__res = { headers: stashHeaders(p.redirectResponse.headers), mimeType: String(p.redirectResponse.mimeType ?? "") };
        prev.__redirected = true;
        this.#flushNet(prev);
      }
      const entry = {
        ts: this.now(),
        method: String(req.method ?? "GET"),
        url: clipText(url, URL_LOG_MAX),
        status: null,
        type: String(p.type ?? "Other"),
        __t0: p.timestamp,
        // V2 暂存（flush 时拆出去，不进环形缓冲条目）：请求头 / postData（≤20000）/ requestId + sessionId（取 body 用）
        __rid: p.requestId,
        __sid: sessionId ?? null,
        __req: {
          headers: stashHeaders(req.headers),
          postData: typeof req.postData === "string" ? req.postData.slice(0, NET_BODY_MAX) : undefined,
          hasPostData: req.hasPostData === true || typeof req.postData === "string",
        },
      };
      // E2·S3 B1：发起者（≤3 帧调用栈，URL 已脱敏）；A5：Fetch.requestPaused 先到时暂存的「被规则处理」标记
      const initiator = formatInitiator(p.initiator);
      if (initiator) entry.initiator = initiator;
      const earlyRuled = this.pendingRuled.get(key);
      if (earlyRuled) {
        this.pendingRuled.delete(key);
        entry.ruled = earlyRuled.ruled;
        if (earlyRuled.ruleId) entry.__ruleId = earlyRuled.ruleId;
      }
      this.inflight.set(key, entry);
      // 在途表封顶：页面疯狂发请求又收不到完成事件时不能无限涨
      if (this.inflight.size > 2000) this.inflight.delete(this.inflight.keys().next().value);
      return;
    }
    let entry = this.inflight.get(key);
    if (!entry) {
      // 早期子资源补录：导航提交后渲染进程里的 Network 代理比预加载扫描器启用得晚，页面解析最早发出的
      // img / css / js 请求没有 requestWillBeSent（实测：真 Electron 里每次导航这三类资源都缺，只剩 responseReceived /
      // loadingFinished）。只认 responseReceived 来补建——它带 URL / 状态 / 类型 / 计时；loadingFinished / loadingFailed
      // 单独到达没有 URL，补不了（早期就失败的请求仍然看不到，是已知缺口）。
      // 方法按 GET 记（预加载扫描器发起的子资源都是 GET）；请求头拿不到，留空；耗时用 timing.requestTime（与 timestamp 同一单调时钟）。
      if (method !== "Network.responseReceived") {
        // E2·S3 B1：SSE 流在 responseReceived 时已入环并出了在途表，它的收尾事件到这里：补 durationMs / 失败原因
        if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
          this.streams.endSse(sessionId ?? null, p?.requestId, {
            failed: method === "Network.loadingFailed" && p.canceled !== true,
            errorText: method === "Network.loadingFailed" ? String(p.errorText ?? "failed") : undefined,
            timestamp: p.timestamp,
          });
        }
        return;
      }
      const res = p.response ?? {};
      const url = String(res.url ?? "");
      if (!url || /^(data|blob):/i.test(url)) return;
      const reqTime = res.timing?.requestTime;
      entry = {
        ts: this.now(),
        method: "GET",
        url: clipText(url, URL_LOG_MAX),
        status: null,
        type: String(p.type ?? "Other"),
        __t0: typeof reqTime === "number" && reqTime > 0 ? reqTime : p.timestamp,
        __rid: p.requestId,
        __sid: sessionId ?? null,
        __req: { headers: {}, postData: undefined, hasPostData: false },
      };
      this.inflight.set(key, entry);
      // 与 requestWillBeSent 路径同样封顶（wait_for networkIdle 数的就是这张表的大小，收不到完成事件时不能无限涨）
      if (this.inflight.size > 2000) this.inflight.delete(this.inflight.keys().next().value);
    }
    if (method === "Network.responseReceived") {
      entry.status = p.response?.status ?? null;
      if (p.type) entry.type = String(p.type);
      entry.__res = { headers: stashHeaders(p.response?.headers), mimeType: String(p.response?.mimeType ?? "") };
      // E2·S3 B1：缓存命中（内存缓存由 Network.requestServedFromCache 标记）/ 服务工作线程应答
      if (p.response?.fromDiskCache === true) entry.cache = "fromDiskCache";
      if (p.response?.fromServiceWorker === true) entry.fromServiceWorker = true;
      if (entry.type === "EventSource") {
        // SSE 是永不收尾的长连接：响应头到了就入环（已建立）并立刻出在途表——否则 wait_for networkIdle 永远等不到空闲。
        // 之后的 eventSourceMessageReceived 由 streams 收进帧缓冲，loadingFinished / loadingFailed 走上面的 endSse
        const t0 = entry.__t0;
        this.inflight.delete(key);
        const flushed = this.#flushNet(entry);
        this.streams.openSse(sessionId ?? null, p.requestId, flushed, this.netDetails.get(flushed.id), t0);
      }
      return;
    }
    entry.durationMs = Math.max(0, Math.round((p.timestamp - entry.__t0) * 1000));
    if (method === "Network.loadingFailed") {
      // canceled：被页面 / 导航取消的请求（导航中止、预取被丢弃、页面自己 abort 的 fetch）不算「失败」，但保留记录；
      // 否则 browser_network {filter:"failed"} 里会混进一堆并非故障的 net::ERR_ABORTED，淹没真正的失败请求。
      // 注意时序：请求完成事件进环形缓冲的时刻可能晚于 navigate 返回（navigate 等的是 load，页面脚本里的 fetch 不受 load 约束），
      // 所以「刚导航完立刻看 network」可能还没有页面加载期发起的慢请求——属预期，需要时让 AI 先 wait_for 再看。
      entry.failed = p.canceled !== true;
      entry.errorText = String(p.errorText ?? (p.canceled ? "canceled" : "failed"));
    }
    this.inflight.delete(key);
    this.#flushNet(entry);
  }

  /**
   * 页面加载结束（did-stop-loading 且 wc 已不在加载）时，收尾仍挂在 inflight 里的 Document 请求。
   *
   * 为什么需要：实测（Electron 42，`WebContentsView`）约 1–2% 的主文档导航，Document 的 `Network.loadingFinished`
   * 永远不到——裸对照实验（只开 `Network.enable`、不带任何 Flowship 代码的 `WebContentsView`：400 次导航丢 5–7 次；
   * 同样配置的普通 `BrowserWindow.webContents`：300 次 0 次），所以不是我们的初始化 / 监听器造成的。
   * 不处理的后果：① `browser_network` 里偶尔缺这条 Document；② 它永远留在 inflight 里，而 `wait_for networkIdle` 数的
   * 就是 inflight 表的大小——一旦卡住一条，这个 tab 之后的 networkIdle 永远等不到空闲（导航 50 次后约一半概率中招）。
   *
   * 加载都结束了，Document 必然已经收完：有响应头的按其状态正常记录，没有响应头的（被新导航取消的）按「取消」记录。
   * 之后若 loadingFinished 迟到，#onNetwork 找不到在途条目会直接忽略，不会重复记。
   */
  #settleStuckDocuments() {
    if (this.#wcGone()) return;
    try {
      if (this.wc.isLoading()) return; // 新一轮导航已经开始：这些 Document 可能是新页面的，不能提前收尾
    } catch {
      return; // 读的瞬间 wc 被销毁
    }
    for (const [key, entry] of [...this.inflight.entries()]) {
      if (entry.type !== "Document") continue;
      this.inflight.delete(key);
      entry.durationMs = Math.max(0, this.now() - entry.ts);
      if (!entry.__res) {
        entry.failed = false;
        entry.errorText = "canceled";
      }
      this.#flushNet(entry);
    }
  }

  #flushNet(entry) {
    const { __t0, __rid, __sid, __req, __res, __redirected, __timingOnly, __ruleId, __stream, ...rest } = entry;
    void __t0;
    if (typeof rest.status === "number" && rest.status >= 400) rest.failed = true;
    // E2·S3 A5：被规则 block / fail 掉的请求一定算「失败」（CDP 对 Fetch.failRequest 的 loadingFailed 可能带 canceled，那样默认不算失败）
    // R14：mock-refused（mock 命中了会让 Chromium 崩溃的「跨源 / 无法确认同源 + 带体」请求，引擎不发终结命令，改发 continueRequest 并把 url 改写到受限端口 REFUSE_URL、本机立刻失败）同理
    if ((rest.ruled === "block" || rest.ruled === "fail" || rest.ruled === "mock-refused") && typeof rest.errorText === "string" && rest.errorText !== "") rest.failed = true;
    // V2：id 在这里分配（= 列表顺序，单调递增，clear 后不回绕），详情另存暂存表，环形缓冲里的条目保持轻量
    rest.id = ++this.netSeq;
    this.networkRing.push(rest);
    this.netDetails.add(rest.id, {
      requestId: __rid,
      sessionId: __sid ?? null,
      requestHeaders: __req?.headers ?? {},
      postData: __req?.postData,
      hasPostData: __req?.hasPostData === true,
      responseHeaders: __res?.headers ?? {},
      mimeType: __res?.mimeType ?? "",
      redirected: __redirected === true,
      // 来自页面资源计时的补录：浏览器没推它的网络事件，没有请求头 / 响应头 / 响应体可取
      ...(__timingOnly === true ? { timingOnly: true } : {}),
      // E2·S3：命中的规则 id（A5）/ 流式连接类别（B1：websocket | sse）
      ...(__ruleId ? { ruleId: __ruleId } : {}),
      ...(__stream ? { stream: __stream } : {}),
    });
    return rest;
  }

  /** E2·S3 B1：WebSocket 条目入环（streams 采集器回调）。条目与详情都是环里 / 详情表里的同一对象引用，之后握手 / 关闭事件会继续改它们 */
  #addStreamEntry(partial) {
    const entry = this.#flushNet({
      ...partial,
      __req: { headers: {}, postData: undefined, hasPostData: false },
      __res: { headers: {}, mimeType: "" },
    });
    return { entry, detail: this.netDetails.get(entry.id) };
  }

  /**
   * E2·S3 A5：网络规则（Fetch.requestPaused）处理了一个请求，给对应的网络条目打 `ruled` 标记（block / fail / mock / delay / headers / mock-refused）。
   * `networkId` 即 `Network.requestId`。正常情况 requestWillBeSent 先到、条目还在途；顺序反了就暂存（≤200 条），条目创建时取走。
   */
  noteNetworkRuled({ sessionId = null, networkId, ruled, ruleId } = {}) {
    if (typeof networkId !== "string" || networkId === "" || typeof ruled !== "string") return;
    const key = `${sessionId ?? "main"}:${networkId}`;
    const live = this.inflight.get(key);
    if (live) {
      live.ruled = ruled;
      if (ruleId) live.__ruleId = ruleId;
      return;
    }
    this.pendingRuled.set(key, { ruled, ruleId });
    while (this.pendingRuled.size > 200) this.pendingRuled.delete(this.pendingRuled.keys().next().value);
  }

  /** V2：清空网络记录（network op 的 clear=true）。id 计数不回绕，详情暂存表同步清空；E2·S3：WebSocket / SSE 连接与帧一并清空（清空后到达的帧找不到连接，直接忽略） */
  clearNetwork() {
    this.networkRing.clear();
    this.netDetails.clear();
    this.streams.clear();
    this.pendingRuled.clear();
    this.netClearedAt = this.now();
  }

  /**
   * 补录 CDP 没推送的早期子资源（根因与取舍见 net-detail.mjs「资源计时补录」）：在主 frame 的隔离世界里读
   * Resource Timing，把环里没有的那些补进去。network op 读环之前调；同一渲染进程里 CDP 事件先于本次 evaluate 的返回
   * 到达，所以正常请求不会被重复补录。
   * 补录只是锦上添花：页面没就绪 / 没有隔离世界 / 超时 / 返回值不对，一律静默返回 0，不能让 network op 失败。
   * @returns {Promise<number>} 补了几条
   */
  async backfillResourceTiming() {
    const contextId = this.isoContexts.get(`main:${this.mainFrameId}`);
    if (contextId === undefined || this.destroyed) return 0;
    let value;
    try {
      const r = await this.send(
        "Runtime.evaluate",
        { expression: RESOURCE_TIMING_EXPRESSION, contextId, returnByValue: true, silent: true },
        null,
        2000,
      );
      value = r?.result?.value;
    } catch {
      return 0;
    }
    if (!value || !Array.isArray(value.rows)) return 0;
    const missed = missedResourceEntries({
      rows: value.rows,
      origin: value.origin,
      existing: this.networkRing.list(),
      since: this.netClearedAt,
      seen: this.timingSeen,
    });
    for (const m of missed) {
      this.#flushNet({
        ...m,
        url: clipText(m.url, URL_LOG_MAX),
        __rid: null,
        __sid: null,
        __req: { headers: {}, postData: undefined, hasPostData: false },
        __res: { headers: {}, mimeType: "" },
        __timingOnly: true,
      });
    }
    return missed.length;
  }

  /** V2：按 id 取列表条目 + 详情暂存；已被淘汰 / id 不存在返回 null */
  getNetworkEntry(id) {
    const entry = this.networkRing.list().find((e) => e.id === id);
    if (!entry) return null;
    return { entry, detail: this.netDetails.get(id) ?? null };
  }

  /**
   * V2：取某条请求的响应体（Network.getResponseBody）。浏览器侧缓冲有上限（见 Network.enable 的 maxTotalBufferSize），
   * 老请求的 body 可能已被回收：失败不抛，返回 { ok:false, reason } 让上层写 bodyUnavailableReason。
   */
  async fetchNetworkResponseBody(id) {
    const d = this.netDetails.get(id);
    if (!d) return { ok: false, reason: "该请求的详情已被淘汰（只保留最近 200 条）" };
    if (d.redirected) return { ok: false, reason: "这是一次重定向的中间响应，没有响应体" };
    if (d.timingOnly) return { ok: false, reason: "这条记录来自页面的资源计时（浏览器没有推送它的网络事件），没有响应头 / 响应体可取" };
    try {
      await this.ensureCdp();
      const r = await this.send("Network.getResponseBody", { requestId: d.requestId }, d.sessionId, 8000);
      return { ok: true, body: String(r?.body ?? ""), base64Encoded: r?.base64Encoded === true };
    } catch (err) {
      return { ok: false, reason: `响应体已被浏览器回收或无法读取（${clipText(String(err?.message ?? err), 120)}）` };
    }
  }

  /** V2：请求体（requestWillBeSent 里没带全时补取一次）；失败返回 undefined */
  async fetchNetworkPostData(id) {
    const d = this.netDetails.get(id);
    if (!d || typeof d.postData === "string" || d.hasPostData !== true) return undefined;
    try {
      await this.ensureCdp();
      const r = await this.send("Network.getRequestPostData", { requestId: d.requestId }, d.sessionId, 5000);
      return typeof r?.postData === "string" ? r.postData.slice(0, NET_BODY_MAX) : undefined;
    } catch {
      return undefined;
    }
  }

  // ───────────────────────── JS 对话框（契约 §14.1：先挂起、给 AI / 用户 DIALOG_HOLD_MS 处理，超时兜底） ─────────────────────────

  /**
   * JS 对话框：CDP 的 Page 域一旦启用，对话框就被调试器接管、原生界面不再弹（页面会卡住直到有人处理）。
   * 旧策略是立刻自动处置，AI 看不到弹窗内容、用户也没法决定；现在先挂起成 pendingDialog（进状态推送），
   * 等 AI 的 browser_dialog / 用户在面板上点按钮，超过 DIALOG_HOLD_MS 才按旧策略兜底（对标 Playwright：
   * alert / beforeunload 确定（不阻塞导航）、confirm / prompt 取消），页面不会被无限卡住。
   */
  #onDialog(params, sessionId) {
    // 理论上渲染进程被对话框阻塞时不会再弹第二个；真来了就让新的顶替旧的（旧的定时器作废）
    this.#clearDialogState();
    const type = ["alert", "confirm", "prompt", "beforeunload"].includes(params?.type) ? params.type : "alert";
    const info = {
      type,
      // 页面来的文字：只截断，不可信包装由 server 侧负责（§14.5）
      message: clipText(String(params?.message ?? ""), DIALOG_MESSAGE_MAX),
      url: safeOriginPath(params?.url || this.url),
      since: this.now(),
    };
    if (type === "prompt" && typeof params?.defaultPrompt === "string") info.defaultPrompt = clipText(params.defaultPrompt, DIALOG_MESSAGE_MAX);
    const timer = this.setTimeoutFn(() => void this.#autoHandleDialog(info), DIALOG_HOLD_MS);
    timer?.unref?.();
    this.pendingDialog = info;
    this.#dialogMeta = { sessionId: sessionId ?? null, timer };
    for (const fn of [...this.dialogListeners]) {
      try {
        fn({ ...info });
      } catch {
        /* 监听者出错不能影响状态推送 */
      }
    }
    this.hooks.onChange();
  }

  /** 清掉挂起状态（不发 CDP、不通知 hook）：定时器作废 + pendingDialog 置空 */
  #clearDialogState() {
    const meta = this.#dialogMeta;
    if (meta?.timer) this.clearTimeoutFn(meta.timer);
    this.#dialogMeta = null;
    this.pendingDialog = null;
  }

  #onDialogClosed(sessionId) {
    if (!this.pendingDialog) return;
    if ((this.#dialogMeta?.sessionId ?? null) !== (sessionId ?? null)) return;
    this.#clearDialogState();
    if (!this.destroyed) this.hooks.onChange();
  }

  /** 超时兜底：只处置「还是这一个」对话框（期间被处理过 / 被顶替就什么都不做） */
  async #autoHandleDialog(info) {
    if (this.destroyed || this.pendingDialog !== info) return;
    const accept = info.type === "alert" || info.type === "beforeunload";
    await this.answerDialog(accept, undefined, { by: "auto" });
  }

  /** 订阅「有对话框挂起了」（session.runAction 用它与动作竞速）；返回取消函数 */
  onDialogOpened(fn) {
    this.dialogListeners.add(fn);
    return () => this.dialogListeners.delete(fn);
  }

  /**
   * 处理挂起的对话框（AI 的 browser_dialog、V4 的 IPC 转调、超时兜底共用）。
   * 先同步摘掉挂起状态再发 CDP：这样兜底定时器 / 重复点击不会对同一个对话框处置两次。
   * @param {boolean} accept
   * @param {string} [promptText] 仅 prompt 有效；缺省用页面给的默认值
   * @param {{ by?: "ai" | "user" | "auto" }} [opts]
   * @returns {Promise<{ handled: boolean, dialog: object | null, error?: string }>}
   */
  async answerDialog(accept, promptText, { by = "user" } = {}) {
    const info = this.pendingDialog;
    const meta = this.#dialogMeta;
    if (!info) return { handled: false, dialog: null };
    this.#clearDialogState();
    const ok = accept === true;
    const text = ok && info.type === "prompt" ? (typeof promptText === "string" ? promptText : (info.defaultPrompt ?? "")) : undefined;
    try {
      await this.send(
        "Page.handleJavaScriptDialog",
        { accept: ok, ...(text !== undefined ? { promptText: text } : {}) },
        meta?.sessionId ?? null,
        5000,
      );
    } catch (err) {
      this.log(`[browser:${this.id}] 处置对话框失败：${err?.message || err}`);
      if (!this.destroyed) this.hooks.onChange();
      return { handled: false, dialog: info, error: String(err?.message || err) };
    }
    if (!this.destroyed) {
      const holdSec = Math.round(DIALOG_HOLD_MS / 1000);
      this.hooks.onDialog({
        type: info.type,
        message: clipText(info.message, 100),
        handled: by === "auto" ? `${holdSec} 秒内无人处理，已自动${ok ? "确定" : "取消"}` : ok ? "已确定" : "已取消",
        by,
      });
    }
    return { handled: true, dialog: info };
  }

  // ───────────────────────── 设备 / 环境模拟（契约 §14.1 emulate；纯逻辑在 emulation.mjs） ─────────────────────────

  /** 逐条发 CDP 命令；个别命令失败不影响其它项，最后把失败汇总抛出（replay 时只记日志） */
  async #runEmulationCommands(commands) {
    const failed = [];
    for (const { method, params } of commands) {
      // 视口覆盖 / 清除会改变页面的缩放比例：输入补偿用的比例在**发出时**就切（同一会话按序执行），视图用的比例等**应答成功**再切
      const isMetrics = method === "Emulation.setDeviceMetricsOverride";
      const isClear = method === "Emulation.clearDeviceMetricsOverride";
      const nextScale = isMetrics ? (typeof params?.scale === "number" ? params.scale : 1) : 1;
      const prevInputScale = this.#inputScale;
      if (isMetrics || isClear) this.#inputScale = nextScale;
      try {
        await this.send(method, params, null, 5000);
        if (isMetrics || isClear) this.#fitScale = nextScale;
      } catch (err) {
        if (isMetrics || isClear) this.#inputScale = prevInputScale;
        const msg = String(err?.message || err);
        // 时区 / 语言：CDP 报「已有覆盖」时先清再设一次（状态重放与 CDP 里残留的覆盖撞车时会发生）
        if (/already in effect/i.test(msg) && /(Timezone|Locale)/.test(method)) {
          try {
            const clear = method.includes("Timezone") ? { timezoneId: "" } : { locale: "" };
            await this.send(method, clear, null, 5000);
            await this.send(method, params, null, 5000);
            continue;
          } catch (err2) {
            failed.push(`${method}: ${String(err2?.message || err2).slice(0, 80)}`);
            continue;
          }
        }
        failed.push(`${method}: ${msg.slice(0, 80)}`);
      }
    }
    return failed;
  }

  async #replayEmulation() {
    const commands = withFitScale(toCdpCommands(this.emulation), this.#desiredFitScale());
    if (commands.length === 0) return;
    const failed = await this.#runEmulationCommands(commands);
    if (failed.length > 0) this.log(`[browser:${this.id}] 重放设备模拟部分失败：${failed.join("；")}`);
  }

  /**
   * 增量叠加一次模拟（patch 形状见 emulation.mjs / 契约 §14.1，已由 op 层校验）。
   * 只对主会话生效：OOPIF 子会话不单独设置（跨站 iframe 的视口 / UA 是否跟随未验证）。
   * @returns {Promise<{ emulation: string | null }>} 当前摘要
   */
  applyEmulation(patch) {
    return this.#enqueueEmulation(() => this.#applyEmulationNow(patch));
  }

  /**
   * 排进串行队列：前一个无论成败都不挡后一个；本次的结果 / 异常原样交给调用方
   * @template T
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   */
  #enqueueEmulation(job) {
    const run = this.#emulationChain.then(job);
    this.#emulationChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #applyEmulationNow(patch) {
    await this.ensureCdp();
    const prev = this.emulation;
    const next = mergeEmulation(prev, patch);
    this.emulation = next;
    const failed = await this.#runEmulationCommands(withFitScale(toCdpCommands(next, prev), this.#desiredFitScale(next)));
    if (failed.length > 0) {
      // 评审 R1-24：失败不能留下「状态说是 next、页面里只套了一半」的错位——状态回滚到 prev，
      // 并尽力把页面里已套上的部分撤回（从 next 退回 prev 的差量命令；撤回自己失败只记日志，状态已按 prev 为准）
      this.emulation = prev;
      const undoFailed = await this.#runEmulationCommands(withFitScale(toCdpCommands(prev, next), this.#desiredFitScale(prev)));
      if (undoFailed.length > 0) this.log(`[browser:${this.id}] 模拟失败后的回滚也有部分失败：${undoFailed.join("；")}`);
      await this.#refit(); // 视图尺寸 / 缩放跟着回滚后的状态走（槽位没变，但 this.emulation 已经变回 prev）
      this.hooks.onChange();
      throw new BrowserError("INTERNAL", `设备模拟设置失败，已恢复原状：${failed.join("；")}`);
    }
    // 视口尺寸变了（换设备 / 改宽高 / 重置）：缩放比例要按新模拟重算、视图要跟着收窄或放回整个槽位，渲染端不会为此再汇报 bounds
    await this.#refit();
    this.hooks.onChange();
    for (const fn of [...this.emulationHooks]) {
      try {
        fn({ next, prev, patch });
      } catch (err) {
        this.log(`[browser:${this.id}] 模拟回调出错（已忽略）：${err?.message || err}`);
      }
    }
    return { emulation: describeEmulation(next) };
  }

  /** 清空全部模拟（V4 的 browser:resetEmulation IPC 转调这里） */
  resetEmulation() {
    // 「有没有东西要清」的判断也必须在队列里做：排在前面的 emulate 还没落地时，此刻读到的 this.emulation 是旧的
    return this.#enqueueEmulation(async () => {
      if (this.destroyed) return { emulation: null };
      if (Object.keys(this.emulation).length === 0) return { emulation: null };
      return this.#applyEmulationNow({ reset: true });
    });
  }

  // ───────────────────────── 输入锁 / AI 归因 / 覆盖层 ─────────────────────────

  async #applyIgnore(ignore) {
    try {
      await this.send("Input.setIgnoreInputEvents", { ignore }, null, 5000);
    } catch {
      /* 页面崩溃 / 正在换进程：导航完成后 onNeedLockSync 会重新上 */
    }
  }

  /** session 设定「AI 想让输入处于什么状态」；导航后会按它重新上锁（契约 §2.3） */
  async setInputIgnored(ignore) {
    this.desiredIgnore = ignore === true;
    if (this.destroyed || !this.cdpReady) return;
    await this.#applyIgnore(this.desiredIgnore);
  }

  /** 导航完成 / 进程重建后按期望状态重新上锁（幂等） */
  async resyncLock() {
    if (this.destroyed || !this.cdpReady) return;
    await this.#applyIgnore(this.desiredIgnore);
  }

  /**
   * 在「已置 AI flag + 已解锁」的窗口里执行输入派发，结束后重新上锁并清 flag（契约 §3 主进程步骤）。
   * 解锁 / 上锁只围着真正的 Input.* 派发——窗口越短，用户抢点被误归因 / 误放行的概率越低（探针 T5：错标 0 次）。
   */
  async withAiInput(fn) {
    // R6-18：先通知 session「AI 要向页面派发输入了」（剪贴板观察窗口据此重定基线并认定窗口内有 AI 动作）；监听出错不影响派发
    try {
      this.hooks.onAiInput?.();
    } catch {
      /* 监听者的问题，不能挡住 AI 的输入 */
    }
    await this.setAI(true);
    await this.#applyIgnore(false);
    try {
      return await fn();
    } finally {
      // 读 desiredIgnore：执行期间用户接管会把它改成 false，此时不能再把锁加回去
      await this.#applyIgnore(this.desiredIgnore);
      await this.setAI(false);
    }
  }

  async #evalInIsolated(expression, { all = false } = {}) {
    const entries = all
      ? [...this.isoContexts.entries()]
      : [[`main:${this.mainFrameId}`, this.isoContexts.get(`main:${this.mainFrameId}`)]].filter(([, v]) => v !== undefined);
    await Promise.all(
      entries.map(([key, contextId]) =>
        this.send("Runtime.evaluate", { expression, contextId, silent: true }, this.#sessionOfKey(key), 3000).catch(() => {}),
      ),
    );
  }

  /** 页内归因 flag：所有 frame 的隔离世界都置位（点击可能落在任意 frame 里） */
  setAI(on) {
    return this.#evalInIsolated(`globalThis.__flowship && globalThis.__flowship.setAI(${on === true})`, { all: true });
  }

  overlayShowAction({ point, rect, label, kind }) {
    const payload = JSON.stringify({ point, rect, label, kind });
    return this.#evalInIsolated(`globalThis.__flowship && globalThis.__flowship.overlay.showAction(${payload})`);
  }

  overlaySetActive(on, label) {
    return this.#evalInIsolated(
      `globalThis.__flowship && globalThis.__flowship.overlay.setActive(${on === true}, ${JSON.stringify(label ?? null)})`,
    );
  }

  overlayHide() {
    return this.#evalInIsolated("globalThis.__flowship && globalThis.__flowship.overlay.hide()");
  }

  // ───────────────────────── 导航 ─────────────────────────

  /** 等当前加载结束（或超时 / 取消）；不抛超时——调用方看返回的 settled */
  async waitForLoad(timeoutMs, signal) {
    const deadline = this.now() + timeoutMs;
    while (this.isLoading() && this.now() < deadline) {
      if (signal?.aborted) throw signal.reason;
      await sleep(40);
    }
    return !this.isLoading();
  }

  /**
   * 导航到 url。策略检查由这里统一做（AI navigate op 与用户地址栏共用）。
   * @returns {Promise<{ url: string, title: string, status: number | null }>}
   */
  /**
   * R1-10：这次导航引出的下载是不是「我们自己发起的」。Chromium 对 wc.loadURL（browser-initiated）引出的下载给 hasUserGesture()=false，
   * 但那不是页面脚本在偷偷下载：navigate 是 AI 的工具调用，页面 window.open / target=_blank 开的新标签页在 session 层已过手势闸。
   * 匹配条件：最近一次浏览器自己发起的导航（navigate / 用户地址栏 / 新建标签带 URL）的目标 URL（去 #fragment）=== 下载链第一个 URL（去 #fragment）、
   * 期间没有提交过别的导航（提交了说明它是个普通页面，不是下载）、在令牌有效期内（navigate 的超时，下限 BROWSER_NAV_DOWNLOAD_MS，上限
   * BROWSER_NAV_DOWNLOAD_MAX_MS；用户导航 BROWSER_USER_NAV_DOWNLOAD_MS）；命中即消费（一次性，页面脚本无法借它再放行第二个下载）。
   * 已知残余（R3-07 ④，已写进 BROWSER-AUTOMATION.md §14.9）：令牌只比 URL 不比发起方——有效期内、导航响应还没回来时，同站旧页面里无手势的
   * a[download] 请求同一个 URL 会被当成「我们发起的」放行；Electron 的 will-download 拿不到引起它的导航 id，没法更精确。
   * @param {string[]} urlChain item.getURLChain()（首项是最初请求的 URL，重定向不影响）
   */
  consumeBrowserInitiatedDownload(urlChain) {
    return this.consumeBrowserInitiatedDownloadVerdict(urlChain) === "hit";
  }

  /**
   * 同上，但把「过期」与「根本没有」分开（R3-07 ①：拦截文案要说准——是浏览器发起的导航等太久、令牌过期了，还是页面在偷偷下载）。
   * @param {string[]} urlChain
   * @returns {"hit" | "expired" | "none"}
   */
  consumeBrowserInitiatedDownloadVerdict(urlChain) {
    const rec = this.#browserNav;
    if (!rec) return "none";
    // 期间提交过别的导航：它是个普通页面，不是下载
    if (rec.nav !== this.navCommitted) {
      this.#browserNav = null;
      return "none";
    }
    const first = Array.isArray(urlChain) ? urlChain[0] : undefined;
    const same = typeof first === "string" && urlNoHash(first) !== null && urlNoHash(first) === rec.url;
    if (this.now() - rec.at > rec.ttl) {
      this.#browserNav = null;
      return same ? "expired" : "none";
    }
    if (same) this.#browserNav = null;
    return same ? "hit" : "none";
  }

  /** 记下「这次导航是我们自己发起的」（只记通过 URL 策略的 url；ttl 毫秒内同 URL 的下载放行） */
  #recordBrowserNav(url, ttlMs) {
    const u = urlNoHash(url);
    this.#browserNav = u ? { url: u, at: this.now(), nav: this.navCommitted, ttl: ttlMs } : null;
  }

  /**
   * 用户自己的导航（地址栏、新建标签带 URL；R3 复审 R1-10 ①）：和 AI 的 navigate 一样走 wc.loadURL、同样引出 hasUserGesture=false 的下载，
   * 所以同样登记「浏览器发起」令牌。URL 策略由调用方（resolveUserInput）已经过。
   * @param {string} url
   */
  loadUrlByUser(url) {
    // 只改 #hash 的导航是同文档导航（滚到锚点，不会发请求、不会引出下载）：目标带 fragment 且去掉 fragment 后与当前页相同——
    // 令牌的 URL 就等于当前页，会空挂到 TTL 结束（R4-04 ①）。不带 fragment 的同 URL 是重新加载（跨文档），仍然登记。
    if (!this.#isSameDocumentHashNav(url)) this.#recordBrowserNav(url, BROWSER_USER_NAV_DOWNLOAD_MS);
    return this.wc.loadURL(url);
  }

  /** 目标 URL 是不是「当前页上的 fragment 导航」 */
  #isSameDocumentHashNav(url) {
    try {
      const target = new URL(String(url));
      if (!target.href.includes("#")) return false; // 没有 `#` 就不是 fragment 导航（`page#` 这种空 fragment 也算有）
      const cur = urlNoHash(this.url);
      return cur !== null && cur === urlNoHash(target.href);
    } catch {
      return false;
    }
  }

  async navigate(url, { timeoutMs = 30_000, signal, browserInitiated = true } = {}) {
    await this.ensureCdp();
    const verdict = checkUrl(url, { isAppUrl: this.deps.isAppUrl });
    if (!verdict.ok) throw new BrowserError("URL_BLOCKED", `该地址不允许访问：${verdict.reason}`);
    // browserInitiated=false：页面脚本无手势自己开的窗口（session 层判定）——不记，它引出的下载走正常手势闸
    if (browserInitiated === false) this.#browserNav = null;
    else this.#recordBrowserNav(verdict.url, Math.min(BROWSER_NAV_DOWNLOAD_MAX_MS, Math.max(BROWSER_NAV_DOWNLOAD_MS, Number(timeoutMs) || 0)));
    const blockedBefore = this.lastBlocked?.at ?? 0;
    this.lastLoadError = null;
    const committedBefore = this.navCommitted;
    const load = this.wc.loadURL(verdict.url).catch((err) => err);
    const outcome = await Promise.race([
      load.then(() => "loaded"),
      this.#navTimeout(timeoutMs),
      new Promise((_, reject) => {
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
    // loadURL 的 rejection 在 `load` 里被吞成了值；失败详情以 did-fail-load 记录的为准
    const failure = this.lastLoadError;
    if (outcome !== "timeout" && failure) {
      throw new BrowserError("NAV_FAILED", `页面加载失败：${failure.description || failure.code}（${clipText(failure.url, 120)}）`);
    }
    if (this.lastBlocked && this.lastBlocked.at > blockedBefore) {
      throw new BrowserError("URL_BLOCKED", `导航被拦截：${this.lastBlocked.reason}`);
    }
    return {
      url: this.url,
      title: this.title,
      status: this.navCommitted > committedBefore ? this.lastStatus : null,
    };
  }

  /**
   * navigate 的超时分支（E2·P1）：到点时若本 tab 正挂着认证 / 证书提示（`promptHold`，等用户处理），先等提示结算再判超时——
   * 用户填密码的时间不该算进页面加载超时；结算后再给一小段时间让页面把剩下的加载完（页面先加载完则外层 race 已先返回）。
   */
  async #navTimeout(timeoutMs) {
    await sleep(timeoutMs);
    let held = false;
    for (let i = 0; i < 4; i++) {
      let p = null;
      try {
        p = this.promptHold?.() ?? null;
      } catch {
        p = null;
      }
      if (!p) break;
      held = true;
      await p.catch(() => {});
    }
    if (held) await sleep(Math.min(timeoutMs, NAV_AFTER_PROMPT_GRACE_MS));
    return "timeout";
  }

  async history(direction, { timeoutMs = 30_000, signal } = {}) {
    await this.ensureCdp();
    const nav = this.wc.navigationHistory;
    if (direction === "back") {
      if (!nav.canGoBack()) throw new BrowserError("NAV_FAILED", "没有可后退的历史记录");
      nav.goBack();
    } else if (direction === "forward") {
      if (!nav.canGoForward()) throw new BrowserError("NAV_FAILED", "没有可前进的历史记录");
      nav.goForward();
    } else {
      this.wc.reload();
    }
    // 给导航一个起跑的机会，否则下面立刻看到 isLoading=false 就提前返回
    await sleep(60);
    await this.waitForLoad(timeoutMs, signal);
    return { url: this.url, title: this.title };
  }

  stop() {
    if (!this.destroyed) this.wc.stop();
  }

  // ───────────────────────── ref 表 ─────────────────────────

  /**
   * 按 ref 取登记项。三种失败的区分是契约要求（§3 / §4.2）：
   * - 编号小于当前代首号（或整张表已失效但编号发过）→ REF_STALE：页面变了 / 已重新 snapshot；
   * - 编号格式不对 / 比发过的最大编号还大 → REF_NOT_FOUND。
   */
  resolveRef(ref) {
    const m = /^e(\d{1,9})$/.exec(String(ref ?? ""));
    if (!m) throw new BrowserError("REF_NOT_FOUND", `ref 格式不对：「${String(ref).slice(0, 20)}」（应形如 e12，来自最近一次 browser_snapshot）`);
    const n = Number(m[1]);
    const table = this.refTable;
    if (table && n >= table.first && n <= table.last) {
      const entry = table.map.get(`e${n}`);
      if (entry) return entry;
    }
    if (n < this.nextRefNo) {
      throw new BrowserError("REF_STALE", `ref ${ref} 已失效（页面发生了导航或已重新 snapshot）。请先重新调用 browser_snapshot 获取最新 ref`);
    }
    throw new BrowserError("REF_NOT_FOUND", `没有 ref ${ref}。请检查是否抄错，或重新调用 browser_snapshot`);
  }

  // ───────────────────────── 感知：snapshot / screenshot / evaluate / 文字 ─────────────────────────

  async layoutMetrics() {
    const m = await this.send("Page.getLayoutMetrics");
    const vv = m.cssVisualViewport ?? m.visualViewport ?? {};
    const cs = m.cssContentSize ?? m.contentSize ?? {};
    return {
      x: Math.round(vv.pageX ?? 0),
      y: Math.round(vv.pageY ?? 0),
      viewportW: Math.round(vv.clientWidth ?? 0),
      viewportH: Math.round(vv.clientHeight ?? 0),
      docW: Math.round(cs.width ?? 0),
      docH: Math.round(cs.height ?? 0),
    };
  }

  async scrollInfo() {
    const m = await this.layoutMetrics();
    return { x: m.x, y: m.y, viewportW: m.viewportW, viewportH: m.viewportH, docH: m.docH };
  }

  /** @returns {Promise<{ text: string, refCount: number, truncated: boolean, scroll: object }>} */
  async snapshot({ maxChars = 30_000, maxElements = 1500, viewportOnly = false, query } = {}) {
    await this.ensureCdp();
    const send = (method, params, sessionId) => this.send(method, params ?? {}, sessionId ?? null);
    const childSessions = [...this.children.values()];
    const frames = await captureAxFrames({ send, childSessions });

    let visible = null;
    if (viewportOnly) {
      visible = await this.#probeVisible(collectSnapshotCandidates({ frames }), frames);
    }
    // query（V1）：先按大预算生成完整快照（ref 全部登记、不被截断吞掉命中行），再由 formatAxSnapshot 过滤；ref 编号不变
    const formatted = formatAxSnapshot({ frames, maxChars, maxElements, refStart: this.nextRefNo, visible, query });
    // 新的一代：旧 ref 全部失效（编号单调递增，旧编号永远小于新首号）
    if (formatted.refCount > 0) {
      this.refTable = { first: this.nextRefNo, last: formatted.nextRef - 1, map: formatted.refs };
      this.nextRefNo = formatted.nextRef;
    } else {
      this.refTable = { first: this.nextRefNo, last: this.nextRefNo - 1, map: new Map() };
    }
    const scroll = await this.scrollInfo().catch(() => ({ x: 0, y: 0, viewportW: 0, viewportH: 0, docH: 0 }));
    return { text: formatted.text, refCount: formatted.refCount, truncated: formatted.truncated, scroll };
  }

  /** viewportOnly：对候选节点逐个取几何，保留与视口有交集的（OOPIF 节点要换算到主视口坐标） */
  async #probeVisible(candidates, frames) {
    const metrics = await this.layoutMetrics();
    const visible = new Set();
    const chainBySession = new Map();
    for (const f of frames) if (!chainBySession.has(f.sessionId ?? "")) chainBySession.set(f.sessionId ?? "", f.chain);
    const offsetCache = new Map();
    const offsetFor = async (sessionId) => {
      const k = sessionId ?? "";
      if (offsetCache.has(k)) return offsetCache.get(k);
      const off = await this.frameOffset(chainBySession.get(k) ?? []).catch(() => null);
      offsetCache.set(k, off);
      return off;
    };
    const MAX_PROBE = 4000;
    const list = candidates.slice(0, MAX_PROBE);
    const BATCH = 64;
    for (let i = 0; i < list.length; i += BATCH) {
      await Promise.all(
        list.slice(i, i + BATCH).map(async ({ sessionId, backendNodeId }) => {
          try {
            const { quads } = await this.send("DOM.getContentQuads", { backendNodeId }, sessionId);
            const off = await offsetFor(sessionId);
            if (!off || !quads?.length) return;
            const q = quads[0];
            const xs = [q[0], q[2], q[4], q[6]].map((v) => v + off.x);
            const ys = [q[1], q[3], q[5], q[7]].map((v) => v + off.y);
            const x1 = Math.max(0, Math.min(...xs));
            const y1 = Math.max(0, Math.min(...ys));
            const x2 = Math.min(metrics.viewportW, Math.max(...xs));
            const y2 = Math.min(metrics.viewportH, Math.max(...ys));
            if (x2 > x1 && y2 > y1) visible.add(visibilityKey(sessionId, backendNodeId));
          } catch {
            /* 无布局的节点：视为不可见 */
          }
        }),
      );
    }
    return visible;
  }

  /** iframe 所有者链的累计偏移（OOPIF 局部坐标 → 主视口坐标）。链为空 = 主 frame / 同进程 frame，偏移 0 */
  async frameOffset(chain) {
    let x = 0;
    let y = 0;
    for (const owner of chain) {
      const { quads } = await this.send("DOM.getContentQuads", { backendNodeId: owner.backendNodeId }, owner.sessionId);
      const q = quads?.[0];
      if (!q) throw new BrowserError("NOT_INTERACTABLE", "目标所在的 iframe 当前不可见（尺寸为 0 或已隐藏）");
      x += Math.min(q[0], q[2], q[4], q[6]);
      y += Math.min(q[1], q[3], q[5], q[7]);
    }
    return { x, y };
  }

  /**
   * annotate 用：取 ref 表里每个元素在**视口 CSS 坐标**下的包围框（OOPIF 元素换算到主视口）。
   * 只读 CDP（DOM.getContentQuads），不往页面注入任何东西；取不到框的元素（无布局 / 已脱离）静默跳过。
   * @returns {Promise<{ items: { ref: string, role?: string, name?: string, box: { x: number, y: number, width: number, height: number } }[], viewportW: number, viewportH: number, total: number }>}
   */
  async collectAnnotationItems() {
    const entries = [...(this.refTable?.map?.values?.() ?? [])].slice(0, 600);
    if (entries.length === 0) {
      throw new BrowserError("REF_STALE", "当前没有可标注的 ref（还没 snapshot，或页面已导航使 ref 失效）。请先调用 browser_snapshot，再用 annotate 截图");
    }
    const metrics = await this.layoutMetrics();
    const offsets = new Map();
    const offsetFor = (e) => {
      const k = `${e.sessionId ?? ""}|${e.frameKey ?? ""}`;
      if (!offsets.has(k)) offsets.set(k, this.frameOffset(e.chain ?? []).catch(() => null));
      return offsets.get(k);
    };
    const items = [];
    const BATCH = 32;
    for (let i = 0; i < entries.length; i += BATCH) {
      await Promise.all(
        entries.slice(i, i + BATCH).map(async (e) => {
          try {
            const off = await offsetFor(e);
            if (!off) return;
            const { quads } = await this.send("DOM.getContentQuads", { backendNodeId: e.backendNodeId }, e.sessionId ?? null);
            const q = quads?.[0];
            if (!q) return;
            const xs = [q[0], q[2], q[4], q[6]];
            const ys = [q[1], q[3], q[5], q[7]];
            const x = Math.min(...xs) + off.x;
            const y = Math.min(...ys) + off.y;
            items.push({ ref: e.ref, role: e.role, name: e.name, box: { x, y, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } });
          } catch {
            /* 无布局的节点：不标注 */
          }
        }),
      );
    }
    return { items, viewportW: metrics.viewportW, viewportH: metrics.viewportH, total: entries.length };
  }

  /**
   * 截图（E2·P5a 增强）。新参数：`clip`（视口 CSS 像素）/ `scale` / `omitBackground`（仅 png）/ `annotate` / format 加 webp。
   * 参数互斥关系在 screenshot-kit.normalizeScreenshotArgs 里校验过；这里对直接调用（save / picker）仍保持旧行为。
   */
  async screenshot({ fullPage = false, ref, format = "jpeg", quality = 70, maxWidth = 1280, clip: userClip, scale, omitBackground = false, annotate = false } = {}) {
    await this.ensureCdp();
    const nativeImage = this.deps.nativeImage;
    const effScale = typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? Math.min(3, Math.max(0.1, scale)) : 1;
    // annotate：先收集标注框（失败 / ref 表为空要在截图之前就报，不白截一张）
    const annotation = annotate && !fullPage && !ref && !userClip ? await this.collectAnnotationItems() : null;
    let clip;
    let captureBeyondViewport = false;
    if (ref) {
      const entry = this.resolveRef(ref);
      try {
        await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId }, entry.sessionId);
        const off = await this.frameOffset(entry.chain);
        const { quads } = await this.send("DOM.getContentQuads", { backendNodeId: entry.backendNodeId }, entry.sessionId);
        const q = quads?.[0];
        if (!q) throw new BrowserError("NOT_INTERACTABLE", `元素 ${ref} 当前不可见，无法截图`);
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        const x = Math.min(...xs) + off.x;
        const y = Math.min(...ys) + off.y;
        const width = Math.max(...xs) - Math.min(...xs);
        const height = Math.max(...ys) - Math.min(...ys);
        if (width < 1 || height < 1) throw new BrowserError("NOT_INTERACTABLE", `元素 ${ref} 尺寸为 0，无法截图`);
        // 修复既有缺陷（E2·P5a e2e 发现）：getContentQuads 给的是视口坐标，而 captureScreenshot 的 clip 是文档坐标——
        // 页面滚动过（含上面 scrollIntoViewIfNeeded 刚滚的）就会截到别处。这里加上视觉视口的滚动偏移
        const pg = await this.layoutMetrics().catch(() => ({ x: 0, y: 0 }));
        clip = { x: x + pg.x, y: y + pg.y, width, height, scale: effScale };
      } catch (err) {
        throw this.mapNodeError(err, ref);
      }
    } else if (fullPage) {
      const m = await this.layoutMetrics();
      const height = Math.min(Math.max(m.docH, m.viewportH), MAX_FULLPAGE_CSS_HEIGHT);
      clip = { x: 0, y: 0, width: Math.max(m.docW, m.viewportW), height, scale: effScale };
      captureBeyondViewport = true;
    } else if (userClip) {
      // 视口 CSS 像素（与 ref 路径的 getContentQuads 同坐标系）；超出视口的部分夹掉
      const m = await this.layoutMetrics();
      const c = clampClipToViewport(userClip, m.viewportW, m.viewportH, effScale, (msg) => new BrowserError("BAD_ARGS", msg));
      // CDP 的 clip 是「文档坐标」（Puppeteer 同样要加滚动偏移）：把视口坐标换算过去，页面滚动过也截对地方
      clip = { ...c, x: c.x + m.x, y: c.y + m.y };
    } else if (effScale !== 1) {
      // 只给 scale：整个视口做 clip。宽高取 innerWidth/innerHeight（含滚动条，与不带 clip 的整面截图同范围）；
      // 读不到 / 值离谱就退回 layoutMetrics 的视口（不含滚动条）。只读两个数字，不改页面。
      const m = await this.layoutMetrics();
      const probe = await this.send("Runtime.evaluate", { expression: "[window.innerWidth, window.innerHeight]", returnByValue: true, silent: true }).catch(() => null);
      const [iw, ih] = Array.isArray(probe?.result?.value) ? probe.result.value : [];
      const sane = (v) => typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 8192;
      clip = { x: m.x, y: m.y, width: sane(iw) ? iw : m.viewportW, height: sane(ih) ? ih : m.viewportH, scale: effScale };
    }
    // annotate 在像素上绘制：CDP 一律截无损 png（jpeg 会让标注边缘糊），画完再按 format 编码
    const outFormat = SCREENSHOT_FORMATS.includes(format) ? format : "jpeg";
    const isPng = outFormat === "png";
    const isWebp = outFormat === "webp";
    const q = Math.min(100, Math.max(1, Math.round(quality)));
    if (annotation && !nativeImage) throw new BrowserError("UNSUPPORTED", "当前环境不能在截图上绘制标注（缺少图像处理模块），请去掉 annotate");
    const capture = async (clipArg) => {
      const cdpFormat = annotation ? "png" : outFormat;
      // omit_background：临时把默认背景设为全透明，finally 里一定还原（失败路径也还原，不把用户页面留成透明底）
      const overrideBg = omitBackground && cdpFormat === "png";
      if (overrideBg) await this.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
      try {
        return await this.send("Page.captureScreenshot", {
          format: cdpFormat,
          ...(cdpFormat === "png" ? {} : { quality: q }),
          fromSurface: true,
          captureBeyondViewport,
          ...(clipArg ? { clip: clipArg } : {}),
        });
      } finally {
        if (overrideBg) await this.send("Emulation.setDefaultBackgroundColorOverride", {}).catch(() => {});
      }
    };
    let r = await capture(clip);
    // R1-29：超长页面的 fullPage png 可以是几十到几百 MB 的 base64，必须在解码（分配 Buffer、nativeImage 解码）之前拦下；
    // 不返回被截断的半截图，文案告诉模型怎么改（视口截图 / 只截元素 / 先滚动）
    assertBase64WithinCap(r.data, FULLPAGE_SHOT_MAX_BYTES, fullPage ? "fullPage 截图" : "截图", FULLPAGE_SHOT_HINT);
    let buf = Buffer.from(r.data, "base64");
    let width = 0;
    let height = 0;
    let annotated;
    if (isWebp) {
      // nativeImage 解不了 webp：读文件头拿尺寸，超宽就按比例缩小 scale 重截一次（比解码再编码便宜，也不引依赖）
      const size = readImageSize(buf);
      if (size && size.width > maxWidth) {
        const ratio = (maxWidth - 1) / size.width;
        let base = clip;
        if (!base) {
          const m = await this.layoutMetrics();
          base = { x: m.x, y: m.y, width: m.viewportW, height: m.viewportH, scale: 1 };
        }
        r = await capture({ ...base, scale: base.scale * ratio });
        assertBase64WithinCap(r.data, FULLPAGE_SHOT_MAX_BYTES, fullPage ? "fullPage 截图" : "截图", FULLPAGE_SHOT_HINT);
        buf = Buffer.from(r.data, "base64");
      }
    } else if (nativeImage) {
      let img = nativeImage.createFromBuffer(buf);
      if (!img.isEmpty()) {
        let size = img.getSize();
        let touched = false;
        if (annotation) {
          const { picked, omitted } = pickAnnotations(annotation.items, { viewportW: annotation.viewportW, viewportH: annotation.viewportH });
          const bitmap = Buffer.from(img.toBitmap());
          const n = drawAnnotations(
            bitmap,
            size.width,
            size.height,
            toPixelBoxes(picked, { imgW: size.width, imgH: size.height, viewportW: annotation.viewportW, viewportH: annotation.viewportH }),
          );
          if (n > 0) {
            img = nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
            size = img.getSize();
          }
          touched = true; // annotate 总要重新编码（原图是为标注截的 png，目标可能是 jpeg）
          annotated = { count: n, legend: picked.map((it) => legendLine(it)), omitted, total: annotation.total };
        }
        // 按 CSS 宽度换算：Retina 下像素宽是 CSS 宽的 2 倍，maxWidth 约束的是输出像素宽
        if (size.width > maxWidth) {
          img = img.resize({ width: maxWidth });
          touched = true;
        }
        if (touched) buf = isPng ? img.toPNG() : img.toJPEG(q);
        const out = img.getSize();
        width = out.width;
        height = out.height;
      }
    }
    // annotate 要求「画完再编码」：原图解码失败时不能把未标注的 png 冒充成已标注 / 目标格式交回去
    if (annotation && !annotated) throw new BrowserError("INTERNAL", "截图解码失败，无法绘制标注，请重试或去掉 annotate");
    // 没有 nativeImage（单测 / 极端环境）或它没解出来：从文件头读尺寸，结果里的 width×height 不至于是 0
    if (!(width > 0)) {
      const size = readImageSize(buf);
      if (size) {
        width = size.width;
        height = size.height;
      }
    }
    // V1：同时回报视口 CSS 尺寸——browser_mouse 的坐标系就是它（截图像素宽高可能是 CSS 的 2 倍 / 被 maxWidth 缩小，不能直接拿来当坐标）
    const vp = await this.layoutMetrics().catch(() => null);
    return {
      mimeType: MIME_BY_FORMAT[outFormat],
      format: outFormat,
      ...(annotated ? { annotated: true, legend: annotated.legend, annotatedCount: annotated.count, annotationOmitted: annotated.omitted, annotationCandidates: annotated.total } : {}),
      dataBase64: buf.toString("base64"),
      width,
      height,
      viewportW: vp?.viewportW ?? 0,
      viewportH: vp?.viewportH ?? 0,
    };
  }

  /** 把 CDP 里「节点没了 / 没布局」类错误翻译成协议错误；其余原样抛 */
  mapNodeError(err, ref) {
    if (err instanceof BrowserError) return err;
    const msg = String(err?.message ?? err);
    if (/Could not find node|No node with given id|Node with given id does not belong|Cannot find context|backend node id/i.test(msg)) {
      return new BrowserError("REF_STALE", `ref ${ref} 对应的元素已不在页面上（页面已更新）。请先重新调用 browser_snapshot`);
    }
    if (/does not have a layout object|not visible|Node is detached|not an Element|could not compute|layout/i.test(msg)) {
      return new BrowserError(
        "NOT_INTERACTABLE",
        `元素 ${ref} 当前不可见或不可操作（display:none / 尺寸为 0 / 已脱离页面）。请先 scroll 或展开它所在的区域，再重新 snapshot`,
      );
    }
    return err;
  }

  async evaluate(expression) {
    await this.ensureCdp();
    const params = { expression: String(expression), awaitPromise: true, returnByValue: true, userGesture: false, timeout: 10_000 };
    let r;
    try {
      r = await this.send("Runtime.evaluate", params);
    } catch (err) {
      // 结果不可按值序列化（DOM 节点 / 循环引用）：退回描述串
      r = await this.send("Runtime.evaluate", { ...params, returnByValue: false }).catch(() => {
        throw err;
      });
    }
    if (r.exceptionDetails) {
      const text = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "表达式执行出错";
      return { type: "error", value: null, exceptionText: clipText(text, 1000) };
    }
    const o = r.result ?? {};
    if (o.type === "undefined") return { type: "undefined", value: null };
    let value = o.value;
    if (value === undefined) value = o.description ?? o.unserializableValue ?? null;
    // 超大结果截断：整段回传会撑爆 ipc 与模型上下文
    if (typeof value === "string" && value.length > 20_000) value = `${value.slice(0, 20_000)}…（已截断，原长 ${value.length}）`;
    else if (value !== null && typeof value === "object") {
      const json = JSON.stringify(value);
      if (json.length > 20_000) value = `${json.slice(0, 20_000)}…（已截断，原长 ${json.length}）`;
    }
    return { type: String(o.type ?? typeof value), value };
  }

  /** 页面可见文字（wait_for 轮询用）：主 frame（含 open shadow / 同源 iframe）+ 各 OOPIF 子会话 */
  async pageText() {
    await this.ensureCdp();
    const main = await this.send("Runtime.evaluate", { expression: PAGE_TEXT_EXPRESSION, returnByValue: true, silent: true }).catch(() => null);
    const parts = [typeof main?.result?.value === "string" ? main.result.value : ""];
    for (const c of this.children.values()) {
      const r = await this.send(
        "Runtime.evaluate",
        { expression: "document.body ? document.body.innerText : ''", returnByValue: true, silent: true },
        c.sessionId,
        5000,
      ).catch(() => null);
      if (typeof r?.result?.value === "string") parts.push(r.result.value);
    }
    // C7：closed shadow root 页内读不到（host.shadowRoot === null），改走 CDP 的 pierce 取；整树序列化较贵，限频 1s
    const closed = await this.closedShadowText();
    if (closed) parts.push(closed);
    return parts.join("\n");
  }

  /** closed shadow root 内的文字（见 closed-shadow.mjs）；1 秒内复用上次结果，wait_for 轮询不会每轮都序列化整棵 DOM */
  async closedShadowText() {
    const now = Date.now();
    const nav = this.navCommitted ?? 0;
    // 缓存按导航序号失效：刚导航完的新页面不能拿到上一页 closed 里的文字
    if (this.closedTextCache && this.closedTextCache.nav === nav && now - this.closedTextCache.at < 1000) return this.closedTextCache.text;
    const text = await collectClosedShadowText(this);
    this.closedTextCache = { at: Date.now(), nav, text };
    return text;
  }

  // ───────────────────────── 销毁 ─────────────────────────

  destroy() {
    if (this.destroyed) return;
    this.#teardown({ closeWc: true });
  }

  /**
   * 收尾（幂等由调用方的 this.destroyed 保证）。closeWc=false：wc 已经被页面 / 引擎销毁（destroyed 事件进来的），
   * 不能再碰 debugger / close——只做「把视图摘下来、清状态」。
   */
  #teardown({ closeWc }) {
    this.destroyed = true;
    this.cdpReady = false;
    if (closeWc) {
      try {
        if (this.wc.debugger.isAttached()) this.wc.debugger.detach();
      } catch {
        /* 已断开 */
      }
    }
    try {
      this.parentWindow?.contentView.removeChildView(this.view);
    } catch {
      /* 窗口已销毁 */
    }
    if (closeWc) {
      try {
        this.wc.close({ waitForBeforeUnload: false });
      } catch {
        /* 已销毁 */
      }
    }
    for (const hook of [...this.destroyHooks]) {
      try {
        hook();
      } catch (err) {
        this.log(`[browser:${this.id}] 销毁钩子出错（已忽略）：${err?.message || err}`);
      }
    }
    this.destroyHooks.clear();
    this.contextLostHooks.clear();
    this.sessionHooks.clear();
    this.emulationHooks.clear();
    this.promptHold = null;
    for (const v of this.ext.values()) {
      try {
        v?.dispose?.();
      } catch {
        /* 忽略 */
      }
    }
    this.ext.clear();
    this.cdpListeners.clear();
    this.#clearDialogState();
    this.dialogListeners.clear();
  }
}

// 页内取文字：优先 body.innerText（尊重 display:none），再补 open shadow root 与同源 iframe。
// 只用语法最朴素的 ES5 写法，页面把 Array.prototype 之类弄坏也不影响（尽力而为）。
const PAGE_TEXT_EXPRESSION = `(() => {
  var out = [];
  var seen = 0;
  function visit(doc, depth) {
    try {
      if (doc.body) out.push(doc.body.innerText || '');
      var all = doc.querySelectorAll('*');
      for (var i = 0; i < all.length && seen < 20000; i++) {
        seen++;
        var el = all[i];
        if (el.shadowRoot) out.push(el.shadowRoot.textContent || '');
        if (depth < 3 && el.tagName === 'IFRAME') {
          try { if (el.contentDocument) visit(el.contentDocument, depth + 1); } catch (e) {}
        }
      }
    } catch (e) {}
  }
  visit(document, 0);
  return out.join('\\n').slice(0, 2000000);
})()`;
