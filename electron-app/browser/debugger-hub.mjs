/**
 * Debugger 域的共享入口（增强包 E2 · 契约 §15.1）：每个 tab 一份（`tab.getExt("debugger-hub")`）。
 *
 * 为什么需要它：`sources`（列脚本 / 取源码 / sourcemap，S5）和 `debug`（断点 / 单步 / 作用域，S6）都要用 CDP `Debugger` 域，
 * 而 `Debugger.enable` / `Debugger.disable` 是**全局开关**——一方 disable 会把另一方的断点与 scriptParsed 订阅一起关掉。
 * 这里做**引用计数**：第一个 `acquire(owner)` 才真正 enable（`Debugger.enable` 会把已加载的脚本重放成 `scriptParsed`，
 * 所以懒启用也能列出启用前就加载的脚本），最后一个 `release(owner)` 才 disable 并清空脚本表。
 *
 * - 所有 `Debugger.*` 事件原样转给订阅者（`on(fn)`，`fn(method, params, sessionId)`），hub 自己只维护两份数据：
 *   `scripts`（scriptId → 元信息，上限 {@link MAX_SCRIPTS}，淘汰最旧）与 `paused`（当前暂停现场，`Debugger.resumed` 清空）；
 * - OOPIF 子会话：经 `tab.addSessionHook` 在每个子会话初始化时补 enable（debugger 重连后同样重放）；
 * - tab 销毁时 `dispose()`（`tab.ext` 的约定）：摘监听、清表，不再发任何 CDP。
 *
 * 纯逻辑 + 注入的 tab：单测用假 tab（`getExt / send / onCdpEvent / addSessionHook / cdpSessionIds`）。
 */

/** 脚本表上限：页面动态生成脚本（eval / new Function 循环）不能把主进程内存撑爆 */
export const MAX_SCRIPTS = 5000;

const keyOf = (sessionId, scriptId) => `${sessionId ?? "main"}:${scriptId}`;

/**
 * hub 创建观察者（E2·P8）：`fn(tab, hub)` 在每个 tab 的 hub **首次创建时**同步调一次。
 * 为什么需要：页面的 `debugger;` 语句只要「任何人」（包括只用 `sources` 的 AI）enable 了 Debugger 域就会把页面冻住，
 * 暂停的跟踪（状态 / 120s 兜底 / 被冻结时的 op 闸门）不能只在 `debug` 被调用后才挂——所以在 hub 诞生时就挂上订阅（hub.on 在 acquire 之前不会有事件，零开销）。
 */
const hubCreatedObservers = new Set();
export const onHubCreated = (fn) => {
  hubCreatedObservers.add(fn);
  return () => hubCreatedObservers.delete(fn);
};

/** 取 / 建某个 tab 的 hub */
export const getDebuggerHub = (tab, deps = {}) =>
  tab.getExt("debugger-hub", () => {
    const hub = createDebuggerHub(tab, deps);
    for (const fn of [...hubCreatedObservers]) {
      try {
        fn(tab, hub);
      } catch (err) {
        deps.log?.(`[browser:debugger-hub] 创建观察者出错（已忽略）：${err?.message || err}`);
      }
    }
    return hub;
  });

/**
 * @param {any} tab
 * @param {{ log?: (msg: string) => void }} [deps]
 */
export const createDebuggerHub = (tab, deps = {}) => {
  const log = deps.log ?? (() => {});
  /** @type {Set<unknown>} */
  const owners = new Set();
  /** @type {Map<string, any>} */
  const scripts = new Map();
  /** @type {Set<(method: string, params: any, sessionId: string | null) => void>} */
  const listeners = new Set();
  /** @type {null | { sessionId: string | null, reason: string, callFrames: any[], hitBreakpoints: string[], data?: any, since: number }} */
  let paused = null;
  let offCdp = null;
  let offHook = null;
  let enabling = null;
  let disposed = false;

  const sendSafe = async (method, sessionId) => {
    try {
      await tab.send(method, {}, sessionId);
      return true;
    } catch (err) {
      log(`[browser:debugger-hub] ${method} 失败（会话 ${sessionId ?? "main"}）：${err?.message || err}`);
      return false;
    }
  };

  const onEvent = (method, params, sessionId) => {
    if (typeof method !== "string" || !method.startsWith("Debugger.")) return;
    const sid = sessionId ?? null;
    if (method === "Debugger.scriptParsed" && params && typeof params.scriptId === "string") {
      const key = keyOf(sid, params.scriptId);
      scripts.delete(key); // 重新插入以刷新「最新」顺序
      scripts.set(key, {
        scriptId: params.scriptId,
        sessionId: sid,
        url: typeof params.url === "string" ? params.url : "",
        startLine: params.startLine ?? 0,
        startColumn: params.startColumn ?? 0,
        endLine: params.endLine ?? 0,
        endColumn: params.endColumn ?? 0,
        hash: typeof params.hash === "string" ? params.hash : "",
        sourceMapURL: typeof params.sourceMapURL === "string" && params.sourceMapURL !== "" ? params.sourceMapURL : undefined,
        isModule: params.isModule === true,
        length: Number.isFinite(params.length) ? params.length : undefined,
      });
      while (scripts.size > MAX_SCRIPTS) scripts.delete(scripts.keys().next().value);
    } else if (method === "Debugger.paused") {
      paused = {
        sessionId: sid,
        reason: typeof params?.reason === "string" ? params.reason : "other",
        callFrames: Array.isArray(params?.callFrames) ? params.callFrames : [],
        hitBreakpoints: Array.isArray(params?.hitBreakpoints) ? params.hitBreakpoints : [],
        data: params?.data,
        since: Date.now(),
      };
    } else if (method === "Debugger.resumed") {
      paused = null;
    }
    for (const fn of [...listeners]) {
      try {
        fn(method, params, sid);
      } catch (err) {
        log(`[browser:debugger-hub] 订阅者出错（已忽略）：${err?.message || err}`);
      }
    }
  };

  const stop = async () => {
    offCdp?.();
    offHook?.();
    offCdp = null;
    offHook = null;
    enabling = null;
    paused = null;
    scripts.clear();
  };

  return {
    /** 登记一个使用者并确保 `Debugger` 已启用；主会话 enable 失败会抛（并回滚这次登记） */
    async acquire(owner) {
      if (disposed) throw new Error("debugger hub 已销毁");
      owners.add(owner);
      if (!offCdp) {
        offCdp = tab.onCdpEvent(onEvent);
        offHook = tab.addSessionHook(async (sessionId) => {
          if (owners.size > 0) await sendSafe("Debugger.enable", sessionId);
        });
        // 先订阅事件再 enable：enable 会同步重放 scriptParsed，晚订阅会漏
        enabling = (async () => {
          const ids = tab.cdpSessionIds();
          const results = await Promise.all(ids.map((id) => sendSafe("Debugger.enable", id)));
          // 主会话（ids[0] === null）必须成功；子会话失败只记日志
          if (results[0] === false) throw new Error("Debugger.enable 失败");
        })();
      }
      try {
        await enabling;
      } catch (err) {
        owners.delete(owner);
        if (owners.size === 0) await stop();
        throw err;
      }
    },

    /** 释放一个使用者；最后一个释放时 `Debugger.disable` 并清空脚本表。幂等 */
    async release(owner) {
      if (!owners.delete(owner)) return;
      if (owners.size > 0 || !offCdp) return;
      const ids = disposed ? [] : tab.cdpSessionIds();
      await stop();
      await Promise.all(ids.map((id) => sendSafe("Debugger.disable", id)));
    },

    /** 订阅 `Debugger.*` 事件；返回取消函数 */
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** 已加载脚本的快照（拷贝，按加载顺序，最新在后）；`url` 给了就按「包含」过滤 */
    scripts(filter = {}) {
      const all = [...scripts.values()].map((s) => ({ ...s }));
      return filter.url ? all.filter((s) => s.url.includes(filter.url)) : all;
    },

    /** @param {string} scriptId @param {string | null} [sessionId] */
    getScript(scriptId, sessionId = null) {
      const s = scripts.get(keyOf(sessionId, scriptId));
      return s ? { ...s } : null;
    },

    /** 取脚本源码（经 CDP，按需）；脚本不在表里也允许尝试（调用方可能拿到的是别处的 scriptId） */
    /** @param {string} scriptId @param {string | null} [sessionId] */
    async getScriptSource(scriptId, sessionId = null) {
      const r = await tab.send("Debugger.getScriptSource", { scriptId }, sessionId);
      return typeof r?.scriptSource === "string" ? r.scriptSource : "";
    },

    /** 当前暂停现场（拷贝的引用）；没暂停 = null */
    getPaused() {
      return paused;
    },

    /**
     * R6-09：强制丢掉暂停现场（页面崩溃 / 换进程导航 / debugger 断开 / resume 失败时，不会再有 `Debugger.resumed` 来清它）。
     * 不发 CDP、不通知订阅者（调用方自己处理镜像状态与日志）；返回之前是否处于暂停。
     */
    clearPaused() {
      const was = paused !== null;
      paused = null;
      return was;
    },

    /** 有多少个使用者（单测 / 诊断用） */
    ownerCount: () => owners.size,

    /** tab 销毁（`tab.ext` 约定）：摘监听、清表，不再发 CDP */
    dispose() {
      disposed = true;
      owners.clear();
      listeners.clear();
      void stop();
    },
  };
};
