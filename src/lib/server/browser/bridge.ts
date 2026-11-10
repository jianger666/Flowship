/**
 * 内置浏览器 IPC 客户端（server 侧，协议见 docs/BROWSER-AUTOMATION.md §4）。
 *
 * # 通道
 * 桌面壳用 `spawn(..., stdio: [.., "ipc"])` 拉起 server，所以 server 里有 `process.send` / `process.on("message")`。
 * 没有这条通道（`pnpm dev:web` / `pnpm start` / 纯 headless）= 不可用：不注册 browser_* 工具、所有调用立刻失败。
 * 这条通道是 Node 自带的父子进程私有通道，孙进程（agent shell）拿不到——所以**不需要也不要**用环境变量传 token
 * （agent shell 会原样继承 server 整份 env，见 AGENTS.md）。
 *
 * # 单例
 * Next 同一模块可能被多个 bundle 各实例化一份，dev 下还会 HMR 重载：单例与 `process.on('message')` 的注册都挂
 * `globalThis`，保证全进程只有一个 bridge、只注册一次监听（否则一条 res 被多个实例各处理一遍、pending 表对不上）。
 *
 * # 握手 / 可用性
 * 启动后发 `hello`，3 秒内收到 `hello-ack` 且 capabilities 含 `browser.v1` 才算可用（{@link isBrowserBridgeAvailable} 同步可查）。
 * 超时先判不可用，之后低频重发 hello（壳那边可能晚一点才挂上监听）；任何时候收到合格的 hello-ack 都会转回可用。
 * 通道断开：挂起请求全部以 CANCELLED 拒绝、转不可用（进程里的 IPC 通道断了没法重连；壳重启 server = 新进程 = 新握手）。
 *
 * # 重要约束
 * 本文件会被 `instrumentation-node.ts` 提前动态加载（保证 hello-ack 早于用户第一次使用）。那条链**不能**拖进
 * @cursor/sdk 之类的重模块（webpack 会炸全部路由，见 schedule-service 头注释），所以这里只依赖类型、settings.ts（只读设置）。
 * handback 注入这类重逻辑由 handback.ts 自己注册事件处理器，不在这里 import。
 */

import {
  BrowserBridgeError,
  type BrowserConfig,
  type BrowserErrorCode,
  type BrowserOp,
  type BrowserRequestOptions,
} from "./types";
import {
  normalizeBrowserMaxTabs,
  refreshBrowserSettings,
  onBrowserSettingsChange,
  toBrowserConfig,
  watchBrowserSettings,
} from "./settings";

/** 握手等 hello-ack 的上限（契约 §4.1） */
export const BROWSER_HANDSHAKE_TIMEOUT_MS = 3000;
/** 单次请求的默认本地超时 */
export const BROWSER_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** 握手超时之后重发 hello 的间隔 / 最多次数（壳晚挂监听的兜底；到上限就不再打扰） */
const HELLO_RETRY_MS = 10_000;
const HELLO_RETRY_MAX = 5;
/** 没有处理器的事件（比如 handback 先于 handback.ts 加载到达）最多缓存多少条 / 多久 */
const EVENT_BUFFER_MAX = 20;
const EVENT_BUFFER_TTL_MS = 60_000;

/**
 * 同一个 AbortSignal 已经为哪些任务发过 `cancel`（R1-18）：pi 一轮里模型可能并行调用多个浏览器工具，
 * 它们共用 run 的同一个 signal，stop 时每个请求的 onAbort 都会触发；主进程的 cancel 是「按任务整体中止」，
 * 发一次就够，别给同一个任务连发 N 条。WeakMap：signal 回收时一起回收。
 */
const cancelSentBySignal = new WeakMap<AbortSignal, Set<string>>();

export interface BridgeTransport {
  /** 发一条消息；通道已关 / 同步抛错返回 false。异步发送失败走 onError（只用于日志） */
  send: (msg: unknown, onError?: (err: Error) => void) => boolean;
  /** 注册消息监听，返回取消函数 */
  onMessage: (cb: (msg: unknown) => void) => () => void;
  /** 注册通道断开监听，返回取消函数 */
  onDisconnect: (cb: () => void) => () => void;
  /** 通道当前是否还开着 */
  isOpen: () => boolean;
}

export type BrowserEventHandler = (evt: {
  taskId: string;
  data: Record<string, unknown>;
}) => void | Promise<void>;

export interface BrowserBridge {
  /** 开始握手（幂等） */
  start: () => void;
  /** 已握手成功且通道还开着 */
  isAvailable: () => boolean;
  request: (
    taskId: string,
    op: BrowserOp,
    args: Record<string, unknown>,
    opts?: BrowserRequestOptions,
  ) => Promise<unknown>;
  /** 取消该任务挂起的等待型 op：发 `cancel` 给主进程，并把本地该任务的挂起请求以 CANCELLED 拒绝 */
  cancel: (taskId: string) => void;
  /** 任务被删 / 归档：通知主进程关会话（best-effort，不抛） */
  closeSession: (taskId: string) => void;
  /** 推 config（与上次发过的相同则跳过；force 总发） */
  syncConfig: (cfg: BrowserConfig, force?: boolean) => void;
  /** 订阅主进程 evt；返回取消函数。没处理器时到达的事件会短暂缓存，处理器注册后补发 */
  onEvent: (name: string, handler: BrowserEventHandler) => () => void;
  /** 订阅「某任务会话被主进程关了」 */
  onSessionClosed: (cb: (taskId: string) => void) => () => void;
  /** 当前挂起请求数（测试 / 诊断） */
  pendingCount: (taskId?: string) => number;
  /** 拆掉监听 / 定时器，挂起请求全部拒绝（测试用；生产不调） */
  dispose: () => void;
}

export interface CreateBridgeOptions {
  handshakeTimeoutMs?: number;
  helloRetryMs?: number;
  /** 握手成功（含重新握手）后回调，用来推 config */
  onReady?: () => void;
  now?: () => number;
}

interface Pending {
  taskId: string;
  op: BrowserOp;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  abortCleanup: (() => void) | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const createBrowserBridge = (
  transport: BridgeTransport,
  options: CreateBridgeOptions = {},
): BrowserBridge => {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? BROWSER_HANDSHAKE_TIMEOUT_MS;
  const helloRetryMs = options.helloRetryMs ?? HELLO_RETRY_MS;
  const now = options.now ?? (() => Date.now());

  let state: "idle" | "handshaking" | "ready" | "down" = "idle";
  let started = false;
  let disposed = false;
  let incompatible = false;
  let helloTries = 0;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  let lastSentConfig: string | null = null;
  const offs: Array<() => void> = [];
  const pending = new Map<number, Pending>();
  const eventHandlers = new Map<string, Set<BrowserEventHandler>>();
  const sessionClosedHandlers = new Set<(taskId: string) => void>();
  const eventBuffer: Array<{
    name: string;
    taskId: string;
    data: Record<string, unknown>;
    at: number;
  }> = [];

  const clearTimers = (): void => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    if (retryTimer) clearTimeout(retryTimer);
    handshakeTimer = null;
    retryTimer = null;
  };

  const isAvailable = (): boolean => state === "ready" && !disposed && transport.isOpen();

  /** 结束一个挂起请求（只处理一次） */
  const settle = (id: number, how: (p: Pending) => void): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    p.abortCleanup?.();
    how(p);
  };

  const rejectWhere = (
    pred: (p: Pending) => boolean,
    code: BrowserErrorCode,
    message: string,
  ): number => {
    let n = 0;
    for (const [id, p] of [...pending]) {
      if (!pred(p)) continue;
      n += 1;
      settle(id, (x) => x.reject(new BrowserBridgeError(code, message, { local: true })));
    }
    return n;
  };

  const sendHello = (): void => {
    if (disposed || !transport.isOpen()) return;
    helloTries += 1;
    if (state !== "ready") state = "handshaking";
    transport.send({ v: 1, kind: "hello" }, (err) =>
      console.warn("[browser-bridge] 发送 hello 失败：", err.message),
    );
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (state === "ready" || disposed) return;
      state = "down";
      console.warn(`[browser-bridge] ${handshakeTimeoutMs}ms 内没收到 hello-ack，内置浏览器暂不可用`);
      scheduleRetry();
    }, handshakeTimeoutMs);
    (handshakeTimer as { unref?: () => void }).unref?.();
  };

  const scheduleRetry = (): void => {
    if (disposed || incompatible || helloTries > HELLO_RETRY_MAX || !transport.isOpen()) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (state === "down") sendHello();
    }, helloRetryMs);
    (retryTimer as { unref?: () => void }).unref?.();
  };

  const dispatchEvent = (name: string, taskId: string, data: Record<string, unknown>): void => {
    const handlers = eventHandlers.get(name);
    if (!handlers || handlers.size === 0) {
      eventBuffer.push({ name, taskId, data, at: now() });
      while (eventBuffer.length > EVENT_BUFFER_MAX) eventBuffer.shift();
      return;
    }
    for (const h of [...handlers]) {
      try {
        const r = h({ taskId, data });
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((err) =>
            console.warn(`[browser-bridge] 事件 ${name} 处理失败：`, err instanceof Error ? err.message : err),
          );
        }
      } catch (err) {
        console.warn(`[browser-bridge] 事件 ${name} 处理抛错：`, err instanceof Error ? err.message : err);
      }
    }
  };

  const flushBufferedFor = (name: string): void => {
    const cutoff = now() - EVENT_BUFFER_TTL_MS;
    const mine: typeof eventBuffer = [];
    for (let i = eventBuffer.length - 1; i >= 0; i--) {
      if (eventBuffer[i]!.name === name) mine.unshift(...eventBuffer.splice(i, 1));
    }
    for (const e of mine) {
      if (e.at >= cutoff) dispatchEvent(e.name, e.taskId, e.data);
    }
  };

  const handleSessionClosed = (taskId: string): void => {
    rejectWhere((p) => p.taskId === taskId, "CANCELLED", "浏览器会话已被关闭");
    for (const cb of [...sessionClosedHandlers]) {
      try {
        cb(taskId);
      } catch {
        /* 订阅者出错不影响其它 */
      }
    }
  };

  const handleMessage = (raw: unknown): void => {
    if (disposed || !isRecord(raw) || raw.v !== 1) return;
    switch (raw.kind) {
      case "hello-ack": {
        const caps = Array.isArray(raw.capabilities) ? raw.capabilities : [];
        if (!caps.includes("browser.v1")) {
          incompatible = true;
          state = "down";
          clearTimers();
          console.warn("[browser-bridge] 主进程不支持 browser.v1，内置浏览器不可用");
          return;
        }
        incompatible = false;
        const wasReady = state === "ready";
        state = "ready";
        helloTries = 0;
        clearTimers();
        // 重新握手 = 主进程那头可能是新的 manager，config 要重推一遍
        lastSentConfig = null;
        if (!wasReady) console.info("[browser-bridge] 内置浏览器已就绪");
        try {
          options.onReady?.();
        } catch (err) {
          console.warn("[browser-bridge] onReady 出错：", err instanceof Error ? err.message : err);
        }
        return;
      }
      case "res": {
        const id = typeof raw.id === "number" ? raw.id : -1;
        if (!pending.has(id)) return;
        if (raw.ok === true) {
          settle(id, (p) => p.resolve(raw.result));
        } else {
          const err = isRecord(raw.error) ? raw.error : {};
          const code = (typeof err.code === "string" ? err.code : "INTERNAL") as BrowserErrorCode;
          const message = typeof err.message === "string" ? err.message : "浏览器操作失败";
          settle(id, (p) => p.reject(new BrowserBridgeError(code, message)));
        }
        return;
      }
      case "evt": {
        const name = typeof raw.name === "string" ? raw.name : "";
        const taskId = typeof raw.taskId === "string" ? raw.taskId : "";
        const data = isRecord(raw.data) ? raw.data : {};
        if (!name || !taskId) return;
        if (name === "session_closed") {
          handleSessionClosed(taskId);
          return;
        }
        dispatchEvent(name, taskId, data);
        return;
      }
      default:
        return;
    }
  };

  const handleDisconnect = (): void => {
    if (disposed) return;
    state = "down";
    clearTimers();
    const n = rejectWhere(() => true, "CANCELLED", "与桌面壳的连接已断开");
    console.warn(`[browser-bridge] IPC 通道断开，已拒绝 ${n} 个挂起请求`);
  };

  const start = (): void => {
    if (started || disposed) return;
    started = true;
    if (!transport.isOpen()) {
      state = "down";
      return;
    }
    offs.push(transport.onMessage(handleMessage), transport.onDisconnect(handleDisconnect));
    sendHello();
  };

  const request: BrowserBridge["request"] = (taskId, op, args, opts = {}) => {
    if (!isAvailable()) {
      return Promise.reject(
        new BrowserBridgeError("UNAVAILABLE", "内置浏览器不可用（仅桌面端可用，或桌面壳尚未就绪）", { local: true }),
      );
    }
    if (opts.signal?.aborted) {
      return Promise.reject(new BrowserBridgeError("CANCELLED", "操作已取消", { local: true }));
    }
    const id = ++seq;
    const timeoutMs = Math.max(1, opts.timeoutMs ?? BROWSER_DEFAULT_REQUEST_TIMEOUT_MS);
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { taskId, op, resolve, reject, timer: null, abortCleanup: null };
      pending.set(id, entry);
      entry.timer = setTimeout(() => {
        if (!pending.has(id)) return;
        settle(id, (p) =>
          p.reject(new BrowserBridgeError("TIMEOUT", `浏览器操作 ${op} 超过 ${Math.round(timeoutMs / 1000)} 秒没有响应`, { local: true })),
        );
        // R6-17：本地超时也要通知主进程取消**这一个请求**（带 id）：否则主进程里的 op（滚动循环 / 等待…）继续跑，占着动作队列与面板锁，
        // 而 server 侧已经当它失败了。带 id 是为了只中止这个超时的请求，不连带中止同任务里别的在途请求（任务级 cancel 会全部中止）。
        // v:1 兼容：不认识 id 的旧主进程会按任务级 cancel 处理（更激进但不会出错）。
        if (isAvailable()) transport.send({ v: 1, kind: "cancel", taskId, id });
      }, timeoutMs);
      (entry.timer as { unref?: () => void }).unref?.();
      const signal = opts.signal;
      if (signal) {
        const onAbort = (): void => {
          settle(id, (p) => p.reject(new BrowserBridgeError("CANCELLED", "操作已取消", { local: true })));
          // 所有 op 都要通知主进程（R1-18）：不止 wait_for / ask_user_to_act / downloads 会挂起，
          // click / type(+submit) / navigate 也要几秒到几十秒——本地 pending 已被上面清掉，之后 stop 链钩子里
          // `pendingCount(key) > 0` 恒为 0、不会再补发 cancel，只能在这里发，否则用户点停止后这些动作在主进程里照常跑完。
          // 主进程 abortTask 本来就是按任务整体中止（server-channel：abort 该任务全部在途请求的 signal + cancelWaits），
          // 与「用户接管打断动作」同一套中断语义，pi 一轮被停时该任务的其余在途请求本来也都该一起停。
          if (!isAvailable()) return;
          const sent = cancelSentBySignal.get(signal) ?? new Set<string>();
          if (sent.has(taskId)) return;
          sent.add(taskId);
          cancelSentBySignal.set(signal, sent);
          transport.send({ v: 1, kind: "cancel", taskId });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }
      const ok = transport.send({ v: 1, kind: "req", id, taskId, op, args }, (err) => {
        settle(id, (p) => p.reject(new BrowserBridgeError("UNAVAILABLE", `发送失败：${err.message}`, { local: true })));
      });
      if (!ok) {
        settle(id, (p) => p.reject(new BrowserBridgeError("UNAVAILABLE", "与桌面壳的连接不可用", { local: true })));
      }
    });
  };

  const cancel: BrowserBridge["cancel"] = (taskId) => {
    if (!taskId) return;
    // 先拒本地（让工具回调立刻退出），再通知主进程（让它清掉 wait_for / ask 的挂起态）
    rejectWhere((p) => p.taskId === taskId, "CANCELLED", "任务已被停止，浏览器操作已取消");
    if (isAvailable()) transport.send({ v: 1, kind: "cancel", taskId });
  };

  const closeSession: BrowserBridge["closeSession"] = (taskId) => {
    if (!taskId || !isAvailable()) return;
    rejectWhere((p) => p.taskId === taskId, "CANCELLED", "任务已关闭，浏览器会话被清理");
    void request(taskId, "close_session", {}, { timeoutMs: 10_000 }).catch((err) => {
      console.warn(
        `[browser-bridge] close_session 失败 task=${taskId}：`,
        err instanceof Error ? err.message : err,
      );
    });
  };

  const syncConfig: BrowserBridge["syncConfig"] = (cfg, force = false) => {
    if (!isAvailable()) return;
    const body = {
      recordInputValues: cfg.recordInputValues === true,
      evaluateEnabled: cfg.evaluateEnabled === true,
      storageAccess: cfg.storageAccess === true,
      pagePermissions: cfg.pagePermissions === true,
      // 「收紧」型：缺省（老调用方没传）按默认开，只认显式 false 才关
      trustLoopbackCerts: cfg.trustLoopbackCerts !== false,
      networkBodyRead: cfg.networkBodyRead !== false,
      maxTabs: normalizeBrowserMaxTabs(cfg.maxTabs),
    };
    const key = JSON.stringify(body);
    if (!force && key === lastSentConfig) return;
    if (transport.send({ v: 1, kind: "config", ...body })) lastSentConfig = key;
  };

  const onEvent: BrowserBridge["onEvent"] = (name, handler) => {
    let set = eventHandlers.get(name);
    if (!set) {
      set = new Set();
      eventHandlers.set(name, set);
    }
    set.add(handler);
    flushBufferedFor(name);
    return () => {
      set!.delete(handler);
    };
  };

  const dispose: BrowserBridge["dispose"] = () => {
    if (disposed) return;
    rejectWhere(() => true, "CANCELLED", "bridge 已销毁");
    disposed = true;
    clearTimers();
    for (const off of offs.splice(0)) off();
    eventHandlers.clear();
    sessionClosedHandlers.clear();
    eventBuffer.length = 0;
  };

  return {
    start,
    isAvailable,
    request,
    cancel,
    closeSession,
    syncConfig,
    onEvent,
    onSessionClosed: (cb) => {
      sessionClosedHandlers.add(cb);
      return () => {
        sessionClosedHandlers.delete(cb);
      };
    },
    pendingCount: (taskId) =>
      taskId === undefined
        ? pending.size
        : [...pending.values()].filter((p) => p.taskId === taskId).length,
    dispose,
  };
};

// ----------------- 进程 IPC 传输（process.send / process.on('message')） -----------------

const PROCESS_TRANSPORT_KEY = "__flowshipBrowserProcessTransportV1__";

/**
 * 基于 `process.send` 的传输。**进程内只创建一次**（挂 globalThis），`process.on('message' | 'disconnect')`
 * 只注册一次，后续各 bridge 实例通过内部 Set 订阅——多 bundle / HMR 重复 import 不会叠监听。
 */
export const getProcessTransport = (): BridgeTransport => {
  const g = globalThis as unknown as Record<string, BridgeTransport | undefined>;
  const existing = g[PROCESS_TRANSPORT_KEY];
  if (existing) return existing;

  const msgSubs = new Set<(msg: unknown) => void>();
  const discSubs = new Set<() => void>();
  let wired = false;
  const wire = (): void => {
    if (wired) return;
    wired = true;
    process.on("message", (msg: unknown) => {
      for (const cb of [...msgSubs]) {
        try {
          cb(msg);
        } catch (err) {
          console.warn("[browser-bridge] 消息处理抛错：", err instanceof Error ? err.message : err);
        }
      }
    });
    process.on("disconnect", () => {
      for (const cb of [...discSubs]) {
        try {
          cb();
        } catch {
          /* ignore */
        }
      }
    });
  };

  const t: BridgeTransport = {
    send: (msg, onError) => {
      if (typeof process.send !== "function" || process.connected === false) return false;
      try {
        process.send(msg, undefined, undefined, (err: Error | null) => {
          if (err) onError?.(err);
        });
        return true;
      } catch {
        return false;
      }
    },
    onMessage: (cb) => {
      wire();
      msgSubs.add(cb);
      return () => {
        msgSubs.delete(cb);
      };
    },
    onDisconnect: (cb) => {
      wire();
      discSubs.add(cb);
      return () => {
        discSubs.delete(cb);
      };
    },
    isOpen: () => typeof process.send === "function" && process.connected !== false,
  };
  g[PROCESS_TRANSPORT_KEY] = t;
  return t;
};

// ----------------- 全局单例 -----------------

const BRIDGE_KEY = "__flowshipBrowserBridgeV1__";

interface BridgeHolder {
  bridge: BrowserBridge | null;
  /** 测试注入的 bridge 优先于真实通道 */
  override: BrowserBridge | null;
}

const bridgeHolder = (): BridgeHolder => {
  const g = globalThis as unknown as Record<string, BridgeHolder | undefined>;
  if (!g[BRIDGE_KEY]) g[BRIDGE_KEY] = { bridge: null, override: null };
  return g[BRIDGE_KEY]!;
};

/** 握手成功 / 设置变化时把 config 推给主进程 */
const wireConfigSync = (bridge: BrowserBridge): void => {
  watchBrowserSettings();
  onBrowserSettingsChange(() => bridge.syncConfig(toBrowserConfig()));
};

const pushConfigNow = async (bridge: BrowserBridge): Promise<void> => {
  await refreshBrowserSettings();
  bridge.syncConfig(toBrowserConfig(), true);
};

/** 真实 IPC 通道此刻能不能建（vitest / next build 阶段 / 没有 process.send 都不建） */
const canUseProcessChannel = (): boolean =>
  typeof process.send === "function" &&
  process.connected !== false &&
  !process.env.VITEST &&
  process.env.NEXT_PHASE !== "phase-production-build";

/**
 * 取全局 bridge（懒创建 + 启动握手）。没有 IPC 通道时返回 null（调用方当作「不可用」）。
 * 重复调用、多个 bundle 各调一次都只会得到同一个实例。
 */
export const getBrowserBridge = (): BrowserBridge | null => {
  const h = bridgeHolder();
  if (h.override) return h.override;
  if (h.bridge) return h.bridge;
  if (!canUseProcessChannel()) return null;
  const bridge = createBrowserBridge(getProcessTransport(), {
    onReady: () => {
      void pushConfigNow(bridge);
    },
  });
  h.bridge = bridge;
  wireConfigSync(bridge);
  // 先读一遍设置，让工具注册那边的同步缓存尽早有真实值
  void refreshBrowserSettings();
  bridge.start();
  return bridge;
};

/** server 启动钩子调用：提前握手，保证 hello-ack 早于用户第一次使用 */
export const initBrowserBridge = (): void => {
  try {
    getBrowserBridge();
  } catch (err) {
    console.warn("[browser-bridge] 初始化失败（忽略）：", err instanceof Error ? err.message : err);
  }
};

/** 同步查是否可用；没有通道 / 没握手成功 / 断线 → false，零开销 */
export const isBrowserBridgeAvailable = (): boolean => {
  const h = bridgeHolder();
  if (h.override) return h.override.isAvailable();
  if (h.bridge) return h.bridge.isAvailable();
  // 还没建过：只有真实通道在才值得尝试创建（顺带触发握手）
  if (!canUseProcessChannel()) return false;
  return getBrowserBridge()?.isAvailable() ?? false;
};

/** 任务被停止：取消该任务挂起的浏览器等待（没有 bridge 时无操作） */
export const cancelBrowserTask = (taskId: string): void => {
  const h = bridgeHolder();
  const b = h.override ?? h.bridge;
  if (!b || !taskId) return;
  try {
    b.cancel(taskId);
  } catch (err) {
    console.warn("[browser-bridge] cancel 出错：", err instanceof Error ? err.message : err);
  }
};

/** 任务被删 / 归档：关掉它的浏览器会话（没有 bridge / 不可用时无操作） */
export const closeBrowserSession = (taskId: string): void => {
  const h = bridgeHolder();
  const b = h.override ?? h.bridge;
  if (!b || !taskId) return;
  try {
    b.closeSession(taskId);
  } catch (err) {
    console.warn("[browser-bridge] closeSession 出错：", err instanceof Error ? err.message : err);
  }
};

/** 单测：注入假 bridge（null = 清除）；同时清掉真实单例 */
export const __setBrowserBridgeForTest = (b: BrowserBridge | null): void => {
  const h = bridgeHolder();
  h.override = b;
  if (b === null && h.bridge) {
    h.bridge.dispose();
    h.bridge = null;
  }
};
