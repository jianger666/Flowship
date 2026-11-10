/**
 * 页面权限闸（增强包 E2 · A8，契约 §15.2）：把 {@link ./permission-policy.mjs} 的纯决策接到 Electron 的
 * `setPermissionRequestHandler` / `setPermissionCheckHandler` 上，并负责三件「有副作用」的事：
 *
 *  1. **询问用户**：决策为 `ask` 时走 `session.prompts.request({ kind: "permission" })`（默认拒绝、60 秒、detail 只有权限名 / origin）。
 *     同一 tab + origin + 权限的并发请求合并成一个提示；被拒 / 超时的 30 秒内不再重复弹（防页面反复请求刷提示条）。
 *  2. **定位模拟自动授权**：CDP 的 `Emulation.setGeolocationOverride` 只有在定位权限已授予时才生效——此前权限一律拒绝，所以
 *     「`emulate` 设了位置，页面还是拿不到」。这里在 `emulate` 设置定位的那一刻记下 tab 当前的 origin，只对**这个 origin** 免提示放行；
 *     tab 导航到别的 origin 立即不再放行（策略读的是实时的 `emulatedGeolocationOrigins`）。
 *  3. **通知不弹系统通知**：通知权限一旦授予，页面的 `new Notification()` 会在用户桌面弹真正的系统通知。授予前先往页面主世界注入一个
 *     `Notification` 代理（只放过 `permission` / `requestPermission` 等静态成员，构造出来的是假实例，**不会**触发系统通知），
 *     同时通过 CDP binding 把标题 / 正文（剥格式字符、限长、≤10 条/分钟）作为一条系统活动记录交给用户 / AI。
 *     装不上代理就不授予通知（fail closed）。
 *
 * 状态都挂在会话 / tab 的扩展点上（`session.getExt` / `tab.getExt`）：会话销毁时 `dispose()` 清空，不落盘；
 * `onBrowsingDataCleared()` 由 `browser:clearBrowsingData` 调用，清掉授予与冷却。
 *
 * 不依赖 electron：`findOwner` / `getConfig` / `isAppUrl` 由 index.mjs 注入，单测用假对象即可。
 */

import {
  canonicalPermission,
  createPermissionGrants,
  decidePermissionWithReason,
  originOf,
  PERMISSION_LABEL_ZH,
} from "./permission-policy.mjs";
import { cleanPromptText, createOverflowLogThrottle, overflowSuppressedNote } from "./prompts.mjs";
import { redactSensitiveText } from "./text-redact.mjs";

/** 权限提示的超时（契约：60 秒无人处理按拒绝） */
export const PERMISSION_PROMPT_TIMEOUT_MS = 60_000;
/** 被拒 / 超时之后，同 tab + origin + 权限多久内不再重复弹提示 */
export const PERMISSION_COOLDOWN_MS = 30_000;
/** 页面通知的活动记录：每分钟最多这么多条 */
export const NOTIFY_RATE_PER_MIN = 10;
const NOTIFY_WINDOW_MS = 60_000;
/** 通知标题 / 正文进活动记录前的长度上限 */
const NOTIFY_TITLE_MAX = 80;
const NOTIFY_BODY_MAX = 120;
/** CDP binding 名：只在页面主世界里存在到 stub 取走它为止 */
export const NOTIFY_BINDING_NAME = "__flowshipNotify";
const STATE_KEY = "permissions";
const MAX_COOLDOWN_ENTRIES = 100;

// ───────────────────────── 通知代理（注入页面主世界） ─────────────────────────

/**
 * 页面主世界里的 `Notification` 代理源码。
 * 约束：自包含、不依赖外部变量、出错一律静默（装不上就不能让页面崩）；binding 函数被取走后立刻从 window 上删掉，页面拿不到。
 * 授予前页面读到的 `Notification` 引用（`const N = Notification`）绕得过代理——这是「用户已经明确允许该站发通知」之后的残余风险，写进报告。
 */
export const NOTIFICATION_STUB_SOURCE = `(() => {
  try {
    var g = globalThis;
    if (g.__fsNotifStub) return;
    var send = g.${NOTIFY_BINDING_NAME};
    var Orig = g.Notification;
    if (typeof send !== "function" || typeof Orig !== "function") return;
    try { delete g.${NOTIFY_BINDING_NAME}; } catch (e) {}
    var clip = function (v, n) { return String(v == null ? "" : v).slice(0, n); };
    var handler = {
      construct: function (target, args, newTarget) {
        var perm = "denied";
        try { perm = target.permission; } catch (e) {}
        if (perm !== "granted") return Reflect.construct(target, args, newTarget);
        var title = clip(args[0], 200);
        var opts = args[1] && typeof args[1] === "object" ? args[1] : {};
        try { send(JSON.stringify({ t: title, b: clip(opts.body, 300) })); } catch (e) {}
        var fake = new EventTarget();
        try { Object.setPrototypeOf(fake, target.prototype); } catch (e) {}
        var props = { title: title, body: clip(opts.body, 300), tag: clip(opts.tag, 100), icon: "", data: opts.data === undefined ? null : opts.data, lang: "", dir: "auto", silent: null, requireInteraction: false };
        Object.keys(props).forEach(function (k) {
          Object.defineProperty(fake, k, { value: props[k], enumerable: true, configurable: true, writable: false });
        });
        ["click", "show", "error", "close"].forEach(function (n) {
          var h = null;
          Object.defineProperty(fake, "on" + n, {
            get: function () { return h; },
            set: function (f) {
              if (h) fake.removeEventListener(n, h);
              h = typeof f === "function" ? f : null;
              if (h) fake.addEventListener(n, h);
            },
            enumerable: true,
            configurable: true
          });
        });
        Object.defineProperty(fake, "close", {
          value: function () { setTimeout(function () { try { fake.dispatchEvent(new Event("close")); } catch (e) {} }, 0); },
          enumerable: true,
          configurable: true,
          writable: true
        });
        setTimeout(function () { try { fake.dispatchEvent(new Event("show")); } catch (e) {} }, 0);
        return fake;
      }
    };
    Object.defineProperty(g, "Notification", { value: new Proxy(Orig, handler), writable: true, configurable: true, enumerable: false });
    Object.defineProperty(g, "__fsNotifStub", { value: true, enumerable: false, configurable: false, writable: false });
  } catch (e) {}
})();`;

// ───────────────────────── 状态 ─────────────────────────

/** 会话级状态（授予表 / 冷却 / 提示合并 / 通知限速）；`dispose` 供 session.getExt 在会话销毁时调用 */
const createSessionState = (now) => {
  const state = {
    /** 持久 partition（普通标签）的授予表 */
    grants: createPermissionGrants({ now }),
    /**
     * R6-22：无痕标签（独立内存 partition）的授予表——与普通标签完全分开：普通标签上选的「本会话一直允许」不能让同源无痕标签免提示，反之亦然。
     * 冷却 / 提示合并的 key 本来就带 tabId（无痕与普通是不同的 tab），天然隔离，这里不用再拆。
     */
    incognitoGrants: createPermissionGrants({ now }),
    /** 按 tab 所在 partition 取授予表（没有 tab 的调用方 = 持久） */
    grantsFor(tab) {
      return tab?.incognito === true ? state.incognitoGrants : state.grants;
    },
    /** `${tabId}|${origin}|${permission}` → 冷却截止时间 */
    cooldown: new Map(),
    /** 同一键并发请求合并：key → 提示结果 Promise（只有创建者做副作用） */
    pendingAsk: new Map(),
    notifyTimes: [],
    notifyDroppedAt: 0,
    /** R6-19：权限提示名额满（overflow）时的活动日志限速（每个会话一份，只管日志、不影响决策；overflow 不进冷却） */
    overflowLog: createOverflowLogThrottle({ now }),
    dispose() {
      state.grants.clear();
      state.incognitoGrants.clear();
      state.cooldown.clear();
      state.pendingAsk.clear();
      state.notifyTimes.length = 0;
      state.overflowLog.reset();
    },
    /**
     * `browser:clearBrowsingData`：授予与冷却都属于「浏览数据」，一并清掉。
     * R6-22：清除只作用于持久档案——给了 partition 且它是无痕名时不动（无痕的授予随 wipe 清）；不给 / 给持久名 → 清持久授予（旧行为 = 不给时两张都清）。
     */
    onBrowsingDataCleared(partition) {
      const scoped = typeof partition === "string" && partition !== "";
      state.grants.clear();
      if (!scoped) state.incognitoGrants.clear();
      state.cooldown.clear();
    },
    /** R6-10 / R6-22：无痕 partition 被 wipe（最后一个无痕 tab 关闭）——无痕授予表整体作废（同一会话里别的无痕 tab 也将重新询问，偏严） */
    onPartitionWiped(partition) {
      if (typeof partition === "string" && partition.startsWith("flowship-incognito-")) state.incognitoGrants.clear();
    },
  };
  return state;
};

/** 取会话的权限状态（没有就建）。ops/permissions.mjs 与 index.mjs 也用它 */
export const getPermissionState = (session, now = Date.now) => session.getExt(STATE_KEY, () => createSessionState(now));

const createTabState = () => ({
  /** 定位模拟绑定的 origin（emulate 设置定位那一刻 tab 所在的 origin）；pending = 当时 tab 还没有 http(s) origin，等第一次导航补 */
  geoOrigin: null,
  geoPending: false,
  /** 通知代理：ready = 已装好；installing = 安装中的 Promise；hooked = 已注册 CDP 事件 / 会话钩子 */
  notifReady: false,
  notifInstalling: null,
  notifHooked: false,
  /** 本 tab 最近一次弹过权限提示所在的会话（tab 销毁 / 导航时取消用） */
  session: null,
});

const fallbackTabStates = new WeakMap();
const tabStateOf = (tab) => {
  if (typeof tab.getExt === "function") return tab.getExt(STATE_KEY, createTabState);
  let s = fallbackTabStates.get(tab);
  if (!s) fallbackTabStates.set(tab, (s = createTabState()));
  return s;
};

const hostOfOrigin = (origin) => {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
};

export const permissionLabel = (permission) => PERMISSION_LABEL_ZH[permission] ?? permission;

// ───────────────────────── 工厂 ─────────────────────────

/**
 * @param {{
 *   findOwner: (wc: any) => ({ session: any, tab: any } | null),
 *   getConfig: () => ({ pagePermissions?: boolean } | null),
 *   isAppUrl?: (url: string) => boolean,
 *   log?: (msg: string) => void,
 *   now?: () => number,
 * }} deps
 */
export const createPermissionGate = (deps) => {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const getConfig = () => deps.getConfig?.() ?? null;
  /** Flowship 自己的 origin；判断出错按「是」处理（fail closed） */
  const isAppOrigin = (origin) => {
    if (origin === null) return false;
    try {
      return deps.isAppUrl?.(origin) === true;
    } catch {
      return true;
    }
  };
  const alive = (owner) => !!owner && !owner.session?.destroyed && !owner.tab?.destroyed;

  const geoOriginsOf = (tab) => {
    if (!tab.emulation?.geolocation) return [];
    const ts = tabStateOf(tab);
    return ts.geoOrigin ? [ts.geoOrigin] : [];
  };

  /**
   * 一次权限判定。`frame`：{ isMainFrame, top, forceCross? }——跨源子框架（origin ≠ 顶层 origin，或检查处理器报了 embeddingOrigin）一律拒绝，
   * 授予是按「顶层站点」给的，不能让嵌进来的第三方 iframe 蹭到；通知只给主框架（stub 只装在主框架主世界）。
   */
  const evaluate = (owner, permission, origin, frame) => {
    const perm = canonicalPermission(permission) ?? String(permission);
    const base = decidePermissionWithReason({
      permission: perm,
      origin,
      grants: getPermissionState(owner.session, now).grantsFor(owner.tab),
      config: getConfig(),
      emulatedGeolocationOrigins: geoOriginsOf(owner.tab),
      isAppOrigin: isAppOrigin(origin) || isAppOrigin(frame.top),
    });
    // 「无隐私面的放行项」（剪贴板写）保持旧行为不分框架；其余（授予 / 模拟放行，以及要询问的）只给顶层站点自己的框架
    if (base.decision === "allow" ? base.reason !== "allowed" : base.decision === "ask") {
      const cross = !frame.isMainFrame && (frame.forceCross === true || origin !== frame.top);
      if (cross) return { perm, decision: "deny", reason: "cross-origin-frame" };
      if (perm === "notifications" && !frame.isMainFrame) return { perm, decision: "deny", reason: "notifications-main-frame-only" };
    }
    return { perm, ...base };
  };

  // ── 通知代理 ──

  const handleBindingCalled = (owner, params) => {
    if (params?.name !== NOTIFY_BINDING_NAME) return;
    const state = getPermissionState(owner.session, now);
    const t = now();
    state.notifyTimes = state.notifyTimes.filter((x) => t - x < NOTIFY_WINDOW_MS);
    if (state.notifyTimes.length >= NOTIFY_RATE_PER_MIN) {
      // 每个窗口只记一条「太频繁」，不让页面借通知刷活动日志
      if (t - state.notifyDroppedAt >= NOTIFY_WINDOW_MS) {
        state.notifyDroppedAt = t;
        safeSystemLog(owner, "notification", `页面通知过于频繁，已丢弃后续通知（每分钟最多记录 ${NOTIFY_RATE_PER_MIN} 条）`);
      }
      return;
    }
    state.notifyTimes.push(t);
    let data = null;
    try {
      data = JSON.parse(String(params.payload ?? ""));
    } catch {
      data = null;
    }
    if (!data || typeof data !== "object") return;
    // R6-12：页面可控的通知文字先脱敏、再截断（先截断会把 JWT 劈成两半、残留段匹配不上）；活动日志写入口另有统一兜底（activity-log.mjs safeText，幂等）
    const title = cleanPromptText(redactSensitiveText(String(data.t ?? "").slice(0, 2048)), NOTIFY_TITLE_MAX);
    const body = cleanPromptText(redactSensitiveText(String(data.b ?? "").slice(0, 2048)), NOTIFY_BODY_MAX);
    safeSystemLog(owner, "notification", `页面发出通知（已拦截，未弹系统通知）：「${title || "（无标题）"}」${body ? `— ${body}` : ""}`);
  };

  const safeSystemLog = (owner, kind, summary) => {
    try {
      owner.session.activityLog.addSystem({ kind, tabId: owner.tab.id, url: owner.tab.url, summary });
    } catch (err) {
      log(`[browser] 权限活动日志写入失败：${err?.message || err}`);
    }
  };

  const installNotifOnSession = async (tab, sessionId) => {
    await tab.send("Runtime.addBinding", { name: NOTIFY_BINDING_NAME }, sessionId);
    // 之后的每个新文档都先装好代理（binding 在新文档里同样存在）；当前文档立刻装
    await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: NOTIFICATION_STUB_SOURCE }, sessionId);
    if (sessionId === null) {
      await tab.send("Runtime.evaluate", { expression: NOTIFICATION_STUB_SOURCE, returnByValue: true }, null);
    }
  };

  /** 保证 tab 的通知代理已装好；失败返回 false（调用方据此拒绝授予） */
  const ensureNotifStub = (tab) => {
    const ts = tabStateOf(tab);
    if (ts.notifReady) return Promise.resolve(true);
    if (ts.notifInstalling) return ts.notifInstalling;
    ts.notifInstalling = (async () => {
      try {
        await installNotifOnSession(tab, null);
        if (!ts.notifHooked) {
          ts.notifHooked = true;
          // debugger 断线重连后 binding / 新文档脚本都没了：重放（只主会话；子框架不授予通知）
          tab.addSessionHook?.(async (sessionId) => {
            if (sessionId !== null || !ts.notifReady) return;
            await installNotifOnSession(tab, null);
          });
          tab.onCdpEvent?.((method, params, sessionId) => {
            if (method !== "Runtime.bindingCalled" || (sessionId ?? null) !== null) return;
            const owner = deps.findOwner?.(tab.wc);
            if (alive(owner)) handleBindingCalled(owner, params);
          });
        }
        ts.notifReady = true;
        return true;
      } catch (err) {
        log(`[browser:${tab.id}] 通知代理安装失败，不授予通知权限：${err?.message || err}`);
        return false;
      } finally {
        ts.notifInstalling = null;
      }
    })();
    return ts.notifInstalling;
  };

  // ── 询问用户 ──

  const askUser = (owner, perm, origin) => {
    const { session, tab } = owner;
    const state = getPermissionState(session, now);
    const key = `${tab.id}|${origin}|${perm}`;
    if ((state.cooldown.get(key) ?? 0) > now()) return Promise.resolve(false);
    let pending = state.pendingAsk.get(key);
    if (!pending) {
      tabStateOf(tab).session = session;
      pending = session.prompts
        .request({
          kind: "permission",
          tabId: tab.id,
          host: hostOfOrigin(origin),
          detail: { permission: perm, origin },
          timeoutMs: PERMISSION_PROMPT_TIMEOUT_MS,
        })
        .then((ans) => {
          state.pendingAsk.delete(key);
          const label = permissionLabel(perm);
          if (ans?.action === "allow" || ans?.action === "allow-session") {
            if (ans.action === "allow-session") state.grantsFor(tab).allow(origin, perm, "user");
            safeSystemLog(owner, "permission", `用户${ans.action === "allow-session" ? "在本会话内一直允许" : "允许了一次"}${hostOfOrigin(origin)}的「${label}」权限`);
            return true;
          }
          // R6-19：名额满（overflow）不是用户的决定：不进冷却（名额空出后同一来源仍要能被询问）、文案不写「无人处理」。
          // 但没有冷却就没有天然的去重——页面循环请求会让每次都走到这里，所以 overflow 的**日志**单独限速（每会话每 60 秒一条，其余只计数）：
          // 活动日志是 500 条的环形缓冲，逐次写会把真实的用户 / 系统条目挤掉。限速只管日志，决策（拒绝）不变。
          if (ans?.overflow) {
            const slot = state.overflowLog.take("permission");
            if (slot.log) {
              safeSystemLog(owner, "permission", `提示太多，已按默认拒绝${hostOfOrigin(origin)}的「${label}」权限请求${overflowSuppressedNote(slot.suppressed)}`);
            }
            return false;
          }
          if (state.cooldown.size >= MAX_COOLDOWN_ENTRIES) state.cooldown.clear();
          state.cooldown.set(key, now() + PERMISSION_COOLDOWN_MS);
          safeSystemLog(owner, "permission", `${ans?.timedOut ? "无人处理，已自动拒绝" : "已拒绝"}${hostOfOrigin(origin)}的「${label}」权限请求`);
          return false;
        });
      state.pendingAsk.set(key, pending);
    }
    return pending;
  };

  // ── Electron 回调 ──

  /** `session.setPermissionRequestHandler` 的处理函数：callback 恰好调一次，任何异常都拒绝 */
  const handleRequest = (wc, permission, callback, details) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        callback(ok === true);
      } catch (err) {
        log(`[browser] 权限回调失败（已忽略）：${err?.message || err}`);
      }
    };
    try {
      const owner = wc ? deps.findOwner?.(wc) : null;
      if (!alive(owner)) return done(false);
      const origin = originOf(details?.requestingUrl);
      const frame = { isMainFrame: details?.isMainFrame !== false, top: originOf(owner.tab.url) };
      const v = evaluate(owner, permission, origin, frame);
      if (v.decision === "deny") return done(false);
      const finish = (allowed) => {
        if (!allowed) return done(false);
        if (v.perm !== "notifications") return done(true);
        // 通知：代理装好才授予
        void ensureNotifStub(owner.tab).then(done, () => done(false));
      };
      if (v.decision === "allow") return finish(true);
      void askUser(owner, v.perm, origin).then(
        (allowed) => finish(allowed && alive(owner)),
        () => done(false),
      );
    } catch (err) {
      log(`[browser] 权限请求处理出错，已拒绝：${err?.message || err}`);
      done(false);
    }
  };

  /** `session.setPermissionCheckHandler`：同步判断，不弹提示（`ask` 一律当作「未授予」）；wc 为 null（Service Worker 等）一律 false */
  const handleCheck = (wc, permission, requestingOrigin, details) => {
    try {
      const owner = wc ? deps.findOwner?.(wc) : null;
      if (!alive(owner)) return false;
      const origin = originOf(requestingOrigin) ?? originOf(details?.requestingUrl);
      const top = originOf(owner.tab.url);
      // embeddingOrigin 只在「跨源子框架」的检查里才有；它与请求来源不同 = 被别的站点嵌着，一律不当作顶层站点自己的框架
      const embedding = originOf(details?.embeddingOrigin);
      const forceCross = embedding !== null && embedding !== origin;
      const isMainFrame = details?.isMainFrame !== false && !forceCross;
      const v = evaluate(owner, permission, origin, { isMainFrame, top, forceCross });
      if (v.decision !== "allow") return false;
      // 通知：代理没装好时不报告已授予（否则页面会读到 granted 然后直接弹真通知）
      if (v.perm === "notifications" && !tabStateOf(owner.tab).notifReady) return false;
      return true;
    } catch (err) {
      log(`[browser] 权限检查出错，已拒绝：${err?.message || err}`);
      return false;
    }
  };

  // ── tab 绑定 ──

  /** 每个 tab 创建后调一次：定位模拟的 origin 绑定、导航 / 销毁时作废本 tab 的权限提示 */
  const bindTab = (tab) => {
    const ts = tabStateOf(tab);
    tab.addEmulationHook?.(({ next, prev, patch }) => {
      if (!next?.geolocation) {
        ts.geoOrigin = null;
        ts.geoPending = false;
        return;
      }
      // 只有「这次设置动了定位」才重绑（模拟 UA / 视口时不改变定位绑定的 origin）
      if (patch?.geolocation === undefined && prev?.geolocation) return;
      const cur = originOf(tab.url);
      ts.geoOrigin = cur;
      ts.geoPending = cur === null;
    });
    const cancelMine = () => {
      const session = ts.session;
      if (!session || session.destroyed) return;
      try {
        session.prompts.cancelWhere((p) => p.kind === "permission" && p.tabId === tab.id);
      } catch {
        // 会话正在销毁：提示已由 dispose 结算
      }
    };
    tab.addDestroyHook?.(cancelMine);
    const wc = tab.wc;
    // 与 tab.mjs 同一签名：Electron 42 的 did-start-navigation 第一个参数就是带 isMainFrame / isSameDocument 的 details
    wc?.on?.("did-start-navigation", (details) => {
      if (details?.isMainFrame === true && details.isSameDocument !== true) cancelMine();
    });
    wc?.on?.("did-navigate", (_e, url) => {
      if (!ts.geoPending) return;
      const o = originOf(url);
      if (!o) return;
      ts.geoOrigin = o;
      ts.geoPending = false;
    });
  };

  /**
   * AI 授予通知后：把当前就在该 origin 上的 tab 的通知代理预先装好
   * （页面常常先读 `Notification.permission` 再决定要不要请求；代理没装好时 check 处理器会如实报「未授予」）。
   * 返回实际装好的 tab 数。
   */
  const prepareGrant = async (session, origin, permission) => {
    if (permission !== "notifications") return 0;
    let n = 0;
    for (const tab of session.tabs ?? []) {
      if (tab.destroyed || originOf(tab.url) !== origin) continue;
      if (await ensureNotifStub(tab)) n += 1;
    }
    return n;
  };

  return {
    handleRequest,
    handleCheck,
    bindTab,
    prepareGrant,
    ensureNotifStub,
    /** 单测 / 诊断：策略当前认为「定位模拟生效」的 origin 列表 */
    emulatedGeolocationOrigins: geoOriginsOf,
  };
};
