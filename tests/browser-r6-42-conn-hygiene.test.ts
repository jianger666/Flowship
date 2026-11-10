/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type -- 假 electron 对象 / 假 session 与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-42（R6-10 残余）：连接卫生两处漏洞。
 *
 *  a. `net-guard` 的 `hasCertExceptions` 只看 `allowedCerts`：loopback 自动放行（不写 allowedCerts）、用户的一次性放行（指纹为空不记忆）、
 *     子资源放行过的连接，会话结束时都不 `closeAllConnections`——Chromium 会复用这些连接，之后不再触发 certificate-error。
 *     修法：net 状态里记「放行过证书错误的 partition 集合」（`certAllowedPartitions`，loopback / 用户 / 一次性、主框架 / 子资源都记），
 *     `hasCertExceptions` / `certExceptionPartitions` 一并看它；清除数据 / wipe / dispose 一并清它。
 *  b. `browser:clearBrowsingData` 里 `clearAuthCache`（或 `clearStorageData` / `clearCache`）抛错会直接冒出去，跳过后面的
 *     「例外表清除 + closeAllConnections」。修法：三个 Electron 清除调用逐步隔离，失败只记日志；例外表清除与断连一定执行；
 *     第一个错误在全部做完后再抛（渲染进程仍看得到失败）。
 *  c. （复审补）`onConfig` 里 `trustLoopbackCerts` 开→关只做赋值：此前 loopback 放行建立的连接还活着。修法：true→false 时对 net-guard
 *     有放行记录的 partition（持久 / 无痕）调 `closeConnectionsSafe`；顺手把 `evaluateEnabled` 开→关的「撤销各会话批准」改成先赋值后撤销、逐会话 try/catch。
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { releaseSessionNetwork } from "../electron-app/browser/conn-hygiene.mjs";
import { EVALUATE_APPROVAL_EXT, onEvaluateRevoked } from "../electron-app/browser/evaluate-approval.mjs";
import { createBrowserManager } from "../electron-app/browser/index.mjs";
import { certScopeKey, createNetGuard, getNetGuardState } from "../electron-app/browser/net-guard.mjs";
import { BROWSER_PARTITION } from "../electron-app/browser/tab.mjs";
import { flush as flushMicro, makeEnv, type FakeTab } from "./helpers/browser-e2-p1-fakes";

const PERSIST = "persist:flowship-browser";
const INCOG = "flowship-incognito-task-p1-t2-1";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────── a. net-guard：哪些放行会留下「可能被复用的连接」 ─────────────────────────

describe("R6-42a·net-guard：放行过证书错误的 partition 都算「有例外」", () => {
  const FP = { fingerprint: "sha256/AAAAAAAAAAAA", subjectName: "CN=x", issuerName: "CN=x" };
  const setup = async (cfg: { trustLoopbackCerts?: boolean } = {}) => {
    const env = makeEnv(cfg);
    const guard = createNetGuard({ findOwner: env.findOwner, getConfig: () => env.config, isAppUrl: env.isAppUrl, log: () => {} });
    const normal = (await env.openTab("about:blank")) as FakeTab;
    (normal as any).partition = PERSIST;
    (normal as any).incognito = false;
    const incog = (await env.openTab("about:blank")) as FakeTab;
    (incog as any).partition = INCOG;
    (incog as any).incognito = true;
    guard.bindTab(normal);
    guard.bindTab(incog);
    const certError = (tab: FakeTab, url: string, isMainFrame = true, cert: Record<string, unknown> = FP) => {
      const cb = vi.fn();
      tab.wc.emit("certificate-error", { preventDefault: vi.fn() }, url, "net::ERR_CERT_AUTHORITY_INVALID", cert, cb, isMainFrame);
      return cb;
    };
    const state = () => getNetGuardState(env.session);
    return { ...env, guard, normal, incog, certError, state };
  };

  it("loopback 主框架自动放行：回调 true，allowedCerts 为空，但 hasCertExceptions(该 partition) = true（旧行为 false → 会话结束不断连）", async () => {
    const s = await setup();
    const cb = s.certError(s.normal, "https://localhost:8443/");
    expect(cb).toHaveBeenCalledWith(true);
    expect(s.state().allowedCerts.size).toBe(0); // 证明走的是 loopback 自动放行、不在 allowedCerts 里
    expect(s.state().hasCertExceptions(PERSIST)).toBe(true);
    expect(s.state().hasCertExceptions(INCOG)).toBe(false); // 只记实际放行的那个 partition
    expect(s.state().certExceptionPartitions()).toEqual([PERSIST]);
  });

  it("loopback 子资源放行（主框架没有 markOverride）同样算", async () => {
    const s = await setup();
    const cb = s.certError(s.normal, "https://127.0.0.1:9443/api.js", false);
    expect(cb).toHaveBeenCalledWith(true);
    expect(s.state().overrideHosts.size).toBe(0);
    expect(s.state().allowedCerts.size).toBe(0);
    expect(s.state().hasCertExceptions(PERSIST)).toBe(true);
    expect(s.state().certExceptionPartitions()).toEqual([PERSIST]); // 只在集合里：枚举接口也要看到它
  });

  it("用户的「一次性放行」（证书没有可用指纹 → 不写 allowedCerts）也算：连接照样已经建立", async () => {
    const s = await setup();
    const cb = s.certError(s.normal, "https://self.example/", true, { subjectName: "CN=x" }); // 无 fingerprint
    await flushMicro();
    const p = (s.session.prompts.list() as Array<{ id: string; kind: string }>).find((x) => x.kind === "cert")!;
    expect(s.session.prompts.answer(p.id, { action: "allow-host" })).toBe(true);
    await flushMicro();
    expect(cb).toHaveBeenCalledWith(true);
    expect(s.state().allowedCerts.size).toBe(0); // 没指纹：rememberCert 什么都没记
    expect(s.state().hasCertExceptions(PERSIST)).toBe(true);
    // overrideHosts 有 50 条的容量上限（满了会整表清空）：它被清掉之后，「放行过」的记录也不能丢——集合独立记
    s.state().overrideHosts.clear();
    expect(s.state().hasCertExceptions(PERSIST)).toBe(true);
    expect(s.state().certExceptionPartitions()).toEqual([PERSIST]);
  });

  it("用户 allow-host（有指纹）：allowedCerts 里有、也记入集合；之后同 host 子资源走 user-allowed 放行同样记", async () => {
    const s = await setup({ trustLoopbackCerts: false });
    const cb = s.certError(s.normal, "https://self.example/");
    await flushMicro();
    const p = (s.session.prompts.list() as Array<{ id: string; kind: string }>).find((x) => x.kind === "cert")!;
    s.session.prompts.answer(p.id, { action: "allow-host" });
    await flushMicro();
    expect(cb).toHaveBeenCalledWith(true);
    expect(s.state().hasCertExceptions(PERSIST)).toBe(true);
    s.state().onBrowsingDataCleared(PERSIST);
    expect(s.state().hasCertExceptions(PERSIST)).toBe(false);
    // 清完后例外表没了：同 host 子资源被拒（没有放行 → 不记）
    s.certError(s.normal, "https://self.example/x.js", false);
    expect(s.state().hasCertExceptions(PERSIST)).toBe(false);
  });

  it("没有任何放行就没有记录：用户拒绝 / 子资源被拒 / 开关关着的 loopback（要问）/ Flowship 自己的 origin", async () => {
    const s = await setup({ trustLoopbackCerts: false });
    // 开关关着：loopback 主框架要问，还没人回答 → 没放行
    const cbAsk = s.certError(s.normal, "https://localhost:8443/");
    await flushMicro();
    expect(cbAsk).not.toHaveBeenCalled();
    expect(s.state().hasCertExceptions(PERSIST)).toBe(false);
    // 用户拒绝
    const p = (s.session.prompts.list() as Array<{ id: string; kind: string }>).find((x) => x.kind === "cert")!;
    s.session.prompts.answer(p.id, { action: "deny" });
    await flushMicro();
    expect(cbAsk).toHaveBeenCalledWith(false);
    // 非 loopback 子资源被拒、Flowship 自己的 origin 被拒
    expect(s.certError(s.normal, "https://other.example/x.js", false)).toHaveBeenCalledWith(false);
    expect(s.certError(s.normal, "http://127.0.0.1:8876/", true)).toHaveBeenCalledWith(false);
    expect(s.state().hasCertExceptions(PERSIST)).toBe(false);
    expect(s.state().certExceptionPartitions()).toEqual([]);
  });

  it("partition 隔离：无痕里的放行不让持久 partition 被算成「有例外」，反之亦然", async () => {
    const s = await setup();
    s.certError(s.incog, "https://localhost:9000/");
    expect(s.state().hasCertExceptions(INCOG)).toBe(true);
    expect(s.state().hasCertExceptions(PERSIST)).toBe(false);
    s.certError(s.normal, "https://localhost:9001/");
    expect(s.state().certExceptionPartitions().sort()).toEqual([INCOG, PERSIST].sort());
  });

  it("清理：onBrowsingDataCleared(partition) 只清该 partition；无参全清；onPartitionWiped / dropPartition / dispose 各清各的", async () => {
    const s = await setup();
    s.certError(s.normal, "https://localhost:1/");
    s.certError(s.incog, "https://localhost:2/");
    const st = s.state();
    st.onBrowsingDataCleared(PERSIST);
    expect(st.hasCertExceptions(PERSIST)).toBe(false);
    expect(st.hasCertExceptions(INCOG)).toBe(true); // 无痕的不动
    st.onPartitionWiped(INCOG);
    expect(st.hasCertExceptions(INCOG)).toBe(false);

    s.certError(s.normal, "https://localhost:3/");
    s.certError(s.incog, "https://localhost:4/");
    st.onBrowsingDataCleared(); // 无参 = 全清（旧行为）
    expect(st.hasCertExceptions(PERSIST)).toBe(false);
    expect(st.hasCertExceptions(INCOG)).toBe(false);

    s.certError(s.normal, "https://localhost:5/");
    st.dropPartition(PERSIST);
    expect(st.hasCertExceptions(PERSIST)).toBe(false);

    s.certError(s.normal, "https://localhost:6/");
    st.dispose();
    expect(st.hasCertExceptions(PERSIST)).toBe(false);
    expect(st.certExceptionPartitions()).toEqual([]);
  });

  it("会话结束的网络清理（真 net 状态 → releaseSessionNetwork）：只有 loopback 放行过也会 closeAllConnections；什么都没放行不断", async () => {
    const s = await setup();
    const ses = { clearAuthCache: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) };
    // 什么都没放行：只清认证缓存
    let r = await releaseSessionNetwork({ netState: s.state(), ses, partition: PERSIST });
    expect(r).toEqual({ authCleared: true, connectionsClosed: false });
    expect(ses.closeAllConnections).not.toHaveBeenCalled();
    // loopback 放行过一次
    s.certError(s.normal, "https://localhost:8443/");
    r = await releaseSessionNetwork({ netState: s.state(), ses, partition: PERSIST });
    expect(r.connectionsClosed).toBe(true);
    expect(ses.closeAllConnections).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── 真 createBrowserManager（假 electron）：会话结束 + clearBrowsingData ─────────────────────────

class MWc extends EventEmitter {
  destroyedFlag = false;
  prefs: Record<string, unknown> = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };
  setWindowOpenHandler = vi.fn();
  setAudioMuted = vi.fn();
  isDestroyed = () => this.destroyedFlag;
  loadURL = vi.fn(async () => {});
  getURL = () => "about:blank";
  getTitle = () => "";
  isLoading = () => false;
  stop = vi.fn();
  getZoomLevel = () => 0;
  getLastWebPreferences = () => this.prefs;
  capturePage = vi.fn(async () => ({ isEmpty: () => true }));
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  finishClose = () => {
    this.destroyedFlag = true;
    this.emit("destroyed");
  };
  close = vi.fn(() => {
    queueMicrotask(this.finishClose);
  });
  debugger = { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), on: vi.fn(), sendCommand: vi.fn(async () => ({})) };
}

const makeManager = () => {
  const wcs: MWc[] = [];
  class FakeView {
    webContents: MWc;
    setBounds = vi.fn();
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
    constructor(o: Record<string, any>) {
      this.webContents = o.webContents ?? new MWc();
      wcs.push(this.webContents);
    }
  }
  const makeWin = () => ({
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
    on: vi.fn(),
    once: vi.fn(),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { send: vi.fn(), isDestroyed: () => false, getZoomFactor: () => 1 },
  });
  class FakeWindow {
    constructor() {
      return makeWin() as never;
    }
  }
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipcMain = {
    handle: (n: string, f: never) => void handlers.set(n, f),
    on: vi.fn(),
    removeHandler: (n: string) => void handlers.delete(n),
    removeListener: vi.fn(),
  };
  /** 记录 session 方法的调用顺序，用来断言「先清表、后断连」 */
  const order: string[] = [];
  const sessions = new Map<string, Record<string, any>>();
  const fromPartition = vi.fn((name: string) => {
    let s = sessions.get(name);
    if (!s) {
      s = {
        name,
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setDevicePermissionHandler: vi.fn(),
        on: vi.fn(),
        clearStorageData: vi.fn(async () => void order.push("clearStorageData")),
        clearCache: vi.fn(async () => void order.push("clearCache")),
        clearAuthCache: vi.fn(async () => void order.push("clearAuthCache")),
        closeAllConnections: vi.fn(async () => void order.push("closeAllConnections")),
      };
      sessions.set(name, s);
    }
    return s;
  });
  const logs: string[] = [];
  const manager = createBrowserManager({
    app: { getPath: () => "/tmp" },
    BrowserWindow: FakeWindow,
    WebContentsView: FakeView,
    session: { fromPartition },
    ipcMain,
    getMainWindow: () => makeWin(),
    isAppUrl: () => false,
    isTrustedIpcSender: () => true,
    log: (m: string) => logs.push(m),
    startPicker: () => ({ cancel() {} }),
  } as never);
  const dispatch = (op: string, args: Record<string, unknown>, taskId = "T1") => (manager as any).dispatch(op, args, { taskId, signal: undefined });
  return { manager, dispatch, wcs, sessions, handlers, logs, order };
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** 经真 wc 事件驱动的 loopback 自动放行（走真 manager 里装好的 net-guard） */
const loopbackAllow = (wc: MWc, url = "https://localhost:8443/", isMainFrame = true) => {
  const cb = vi.fn();
  wc.emit("certificate-error", { preventDefault: vi.fn() }, url, "net::ERR_CERT_AUTHORITY_INVALID", { fingerprint: "sha256/AAAAAAAAAAAA" }, cb, isMainFrame);
  return cb;
};

describe("R6-42a·真 manager：会话结束时 loopback 放行过的持久 partition 会断连", () => {
  it("close_session：本会话里 loopback 自动放行过（主框架）→ 持久 session 的 closeAllConnections 被调用", async () => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "about:blank" });
    const cb = loopbackAllow(env.wcs[0]);
    expect(cb).toHaveBeenCalledWith(true);
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    await env.dispatch("close_session", {});
    await flush();
    expect(persistent.clearAuthCache).toHaveBeenCalledTimes(1);
    expect(persistent.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it("子资源的 loopback 放行同样触发断连；没有任何放行则不断连（不无故打断并发任务）", async () => {
    const sub = makeManager();
    await sub.dispatch("navigate", { url: "about:blank" });
    expect(loopbackAllow(sub.wcs[0], "https://127.0.0.1:9443/api.js", false)).toHaveBeenCalledWith(true);
    await sub.dispatch("close_session", {});
    await flush();
    expect(sub.sessions.get(BROWSER_PARTITION)!.closeAllConnections).toHaveBeenCalledTimes(1);

    const none = makeManager();
    await none.dispatch("navigate", { url: "about:blank" });
    await none.dispatch("close_session", {});
    await flush();
    expect(none.sessions.get(BROWSER_PARTITION)!.closeAllConnections).not.toHaveBeenCalled();
  });
});

describe("R6-42b·真 manager：clearBrowsingData 的 Electron 清除调用任一抛错，例外表清除与断连照常执行", () => {
  const prepare = async () => {
    const env = makeManager();
    (env.manager as any).registerIpc();
    await env.dispatch("navigate", { url: "about:blank" });
    await env.dispatch("tabs", { action: "new", incognito: true });
    const incName = [...env.sessions.keys()].find((n) => n.startsWith("flowship-incognito-"))!;
    const session = (env.manager as any).getSession("T1");
    const state = getNetGuardState(session);
    // 持久 partition：既有用户放行的例外（allowedCerts），也有 loopback 自动放行（certAllowedPartitions）；无痕的另放一份
    state.allowedCerts.set(certScopeKey(BROWSER_PARTITION, "bad.example:8443"), new Set(["sha256/AAAAAAAAAAAA"]));
    loopbackAllow(env.wcs[0]);
    state.allowedCerts.set(certScopeKey(incName, "inc.example"), new Set(["sha256/BBBBBBBBBBBB"]));
    expect(state.hasCertExceptions(BROWSER_PARTITION)).toBe(true);
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    const clear = () => (env.handlers.get("browser:clearBrowsingData") as Function)({}) as Promise<unknown>;
    return { env, state, persistent, incName, clear };
  };

  it("基线（无失败）：依次 clearStorageData → clearCache → clearAuthCache →（例外表清）→ closeAllConnections；resolve", async () => {
    const t = await prepare();
    t.env.order.length = 0;
    await expect(t.clear()).resolves.toBeUndefined();
    expect(t.env.order).toEqual(["clearStorageData", "clearCache", "clearAuthCache", "closeAllConnections"]);
    expect(t.state.hasCertExceptions(BROWSER_PARTITION)).toBe(false);
    expect(t.state.hasCertExceptions(t.incName)).toBe(true); // 无痕的例外不动
    expect(t.env.sessions.get(t.incName)!.closeAllConnections).not.toHaveBeenCalled();
  });

  it("clearAuthCache 抛错：例外表仍被清、closeAllConnections 仍被调；句柄 reject（渲染进程看得到失败）并带原错误；日志记了哪一步失败", async () => {
    const t = await prepare();
    t.persistent.clearAuthCache = vi.fn(async () => {
      throw new Error("auth-boom");
    });
    await expect(t.clear()).rejects.toThrow("auth-boom");
    expect(t.persistent.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(t.state.hasCertExceptions(BROWSER_PARTITION)).toBe(false); // allowedCerts + loopback 记录都清了
    expect(t.state.allowedCerts.has(certScopeKey(BROWSER_PARTITION, "bad.example:8443"))).toBe(false);
    expect(t.state.hasCertExceptions(t.incName)).toBe(true);
    expect(t.env.logs.join("\n")).toMatch(/clearAuthCache 失败.*auth-boom/);
  });

  it("clearAuthCache 同步抛错（不是 reject）同样被隔离", async () => {
    const t = await prepare();
    t.persistent.clearAuthCache = vi.fn(() => {
      throw new Error("auth-sync-boom");
    });
    await expect(t.clear()).rejects.toThrow("auth-sync-boom");
    expect(t.persistent.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(t.state.hasCertExceptions(BROWSER_PARTITION)).toBe(false);
  });

  it("clearStorageData 抛错：clearCache / clearAuthCache 照跑，例外表清、断连照做；reject 的是第一个错误", async () => {
    const t = await prepare();
    t.persistent.clearStorageData = vi.fn(async () => {
      throw new Error("storage-boom");
    });
    await expect(t.clear()).rejects.toThrow("storage-boom");
    expect(t.persistent.clearCache).toHaveBeenCalledTimes(1);
    expect(t.persistent.clearAuthCache).toHaveBeenCalledTimes(1);
    expect(t.persistent.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(t.state.hasCertExceptions(BROWSER_PARTITION)).toBe(false);
  });

  it("clearCache 抛错：后面的 clearAuthCache、例外表清除、断连都照常", async () => {
    const t = await prepare();
    t.persistent.clearCache = vi.fn(async () => {
      throw new Error("cache-boom");
    });
    await expect(t.clear()).rejects.toThrow("cache-boom");
    expect(t.persistent.clearAuthCache).toHaveBeenCalledTimes(1);
    expect(t.persistent.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(t.state.hasCertExceptions(BROWSER_PARTITION)).toBe(false);
  });

  it("三个清除调用全抛错：全部都被尝试过；仍然清表 + 断连；reject 的是第一个错误", async () => {
    const t = await prepare();
    for (const [m, msg] of [["clearStorageData", "e1"], ["clearCache", "e2"], ["clearAuthCache", "e3"]] as const) {
      t.persistent[m] = vi.fn(async () => {
        throw new Error(msg);
      });
    }
    await expect(t.clear()).rejects.toThrow("e1");
    for (const m of ["clearStorageData", "clearCache", "clearAuthCache"]) expect(t.persistent[m]).toHaveBeenCalledTimes(1);
    expect(t.persistent.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(t.state.hasCertExceptions(BROWSER_PARTITION)).toBe(false);
  });

  it("clearAuthCache 抛错 + closeAllConnections 也抛错：不冒出第二个错误（reject 仍是 clearAuthCache 的），清表照做", async () => {
    const t = await prepare();
    t.persistent.clearAuthCache = vi.fn(async () => {
      throw new Error("auth-boom");
    });
    t.persistent.closeAllConnections = vi.fn(async () => {
      throw new Error("conn-boom");
    });
    await expect(t.clear()).rejects.toThrow("auth-boom");
    expect(t.state.hasCertExceptions(BROWSER_PARTITION)).toBe(false);
    expect(t.env.logs.join("\n")).toContain("conn-boom");
  });
});

// ───────────────────────── c. onConfig：trustLoopbackCerts 开→关断连 + evaluateEnabled 先赋值后撤销 ─────────────────────────

describe("R6-42c·真 manager：onConfig 的 trustLoopbackCerts 开→关会断开「放行过证书错误」的 partition", () => {
  /** 持久 tab（wcs[0]）；可选再开一个无痕 tab（wcs[1]） */
  const prepare = async (opts: { incognito?: boolean } = {}) => {
    const env = makeManager();
    await env.dispatch("navigate", { url: "about:blank" });
    const persistent = env.sessions.get(BROWSER_PARTITION)!;
    let incName = "";
    if (opts.incognito) {
      await env.dispatch("tabs", { action: "new", incognito: true });
      incName = [...env.sessions.keys()].find((n) => n.startsWith("flowship-incognito-"))!;
    }
    const incog = opts.incognito ? env.sessions.get(incName)! : null;
    const state = () => getNetGuardState((env.manager as any).getSession("T1"));
    const onConfig = (cfg: Record<string, unknown>) => (env.manager as any).onConfig(cfg);
    return { env, persistent, incName, incog, state, onConfig };
  };

  it("loopback 放行（持久 partition）后 onConfig({trustLoopbackCerts:false}) → 该 partition 的 closeAllConnections 被调用；日志无异常", async () => {
    const t = await prepare();
    expect(loopbackAllow(t.env.wcs[0])).toHaveBeenCalledWith(true);
    expect(t.state().certExceptionPartitions()).toEqual([BROWSER_PARTITION]);
    expect(t.persistent.closeAllConnections).not.toHaveBeenCalled();
    t.onConfig({ trustLoopbackCerts: false });
    await flush();
    expect(t.persistent.closeAllConnections.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(t.persistent.closeAllConnections).toHaveBeenCalledTimes(1);
    expect((t.env.manager as any).getConfig().trustLoopbackCerts).toBe(false); // 开关本身照常生效
    expect(t.env.logs.join("\n")).not.toContain("已忽略");
  });

  it("没放行过：同样的 onConfig → closeAllConnections 0 次（不无故打断存量连接）", async () => {
    const t = await prepare({ incognito: true });
    expect(t.state().certExceptionPartitions()).toEqual([]);
    t.onConfig({ trustLoopbackCerts: false });
    await flush();
    expect(t.persistent.closeAllConnections).not.toHaveBeenCalled();
    expect(t.incog!.closeAllConnections).not.toHaveBeenCalled();
    expect((t.env.manager as any).getConfig().trustLoopbackCerts).toBe(false);
  });

  it("无痕与持久 partition 都覆盖；只有一边放行过就只断那一边", async () => {
    const both = await prepare({ incognito: true });
    loopbackAllow(both.env.wcs[0]);
    loopbackAllow(both.env.wcs[1], "https://127.0.0.1:9443/");
    expect(both.state().certExceptionPartitions().sort()).toEqual([BROWSER_PARTITION, both.incName].sort());
    both.onConfig({ trustLoopbackCerts: false });
    await flush();
    expect(both.persistent.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(both.incog!.closeAllConnections).toHaveBeenCalledTimes(1);

    const onlyIncog = await prepare({ incognito: true });
    loopbackAllow(onlyIncog.env.wcs[1]);
    expect(onlyIncog.state().certExceptionPartitions()).toEqual([onlyIncog.incName]);
    onlyIncog.onConfig({ trustLoopbackCerts: false });
    await flush();
    expect(onlyIncog.incog!.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(onlyIncog.persistent.closeAllConnections).not.toHaveBeenCalled(); // 持久 partition 没放行过
  });

  it("多个会话共用同一持久 partition、都放行过：只断一次（按 partition 去重）", async () => {
    const t = await prepare();
    await t.env.dispatch("navigate", { url: "about:blank" }, "T2");
    loopbackAllow(t.env.wcs[0]);
    loopbackAllow(t.env.wcs[1], "https://localhost:9443/");
    expect(getNetGuardState((t.env.manager as any).getSession("T2")).certExceptionPartitions()).toEqual([BROWSER_PARTITION]);
    t.onConfig({ trustLoopbackCerts: false });
    await flush();
    expect(t.persistent.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it("只有 true→false 才断：true→true / false→false / false→true / 不带这个键都不断（放行记录一直在，末尾 true→false 作正对照）", async () => {
    const t = await prepare();
    // 先在「没有记录」时把开关关掉（不断连），再手工塞一条放行记录：之后的每一步都「有记录但不该断」
    t.onConfig({ trustLoopbackCerts: false });
    await flush();
    expect(t.persistent.closeAllConnections).not.toHaveBeenCalled();
    t.state().certAllowedPartitions.add(BROWSER_PARTITION);
    expect(t.state().hasCertExceptions(BROWSER_PARTITION)).toBe(true);

    t.onConfig({ trustLoopbackCerts: false }); // false→false
    t.onConfig({ storageAccess: true, networkBodyRead: false }); // 不带这个键
    t.onConfig({}); // 空配置
    t.onConfig({ trustLoopbackCerts: "no" as never }); // 非 boolean 被忽略
    await flush();
    expect(t.persistent.closeAllConnections).not.toHaveBeenCalled();
    t.onConfig({ trustLoopbackCerts: true }); // false→true
    await flush();
    expect(t.persistent.closeAllConnections).not.toHaveBeenCalled();
    t.onConfig({ trustLoopbackCerts: true }); // true→true
    await flush();
    expect(t.persistent.closeAllConnections).not.toHaveBeenCalled();
    expect((t.env.manager as any).getConfig().trustLoopbackCerts).toBe(true);

    t.onConfig({ trustLoopbackCerts: false }); // 正对照：true→false
    await flush();
    expect(t.persistent.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it("closeAllConnections 抛错（同步抛 / reject）：onConfig 不抛、同一次配置里的其它键照常生效、别的 partition 照常断连；日志记了失败", async () => {
    const t = await prepare({ incognito: true });
    loopbackAllow(t.env.wcs[0]);
    loopbackAllow(t.env.wcs[1]);
    t.persistent.closeAllConnections = vi.fn(() => {
      throw new Error("conn-sync-boom");
    });
    t.incog!.closeAllConnections = vi.fn(async () => {
      throw new Error("conn-reject-boom");
    });
    expect(() => t.onConfig({ trustLoopbackCerts: false, maxTabs: 12 })).not.toThrow();
    await flush();
    expect(t.persistent.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(t.incog!.closeAllConnections).toHaveBeenCalledTimes(1); // 持久那边抛错不影响无痕这边
    const cfg = (t.env.manager as any).getConfig();
    expect(cfg.trustLoopbackCerts).toBe(false);
    expect(cfg.maxTabs).toBe(12);
    const logs = t.env.logs.join("\n");
    expect(logs).toMatch(/closeAllConnections 失败.*conn-sync-boom/);
    expect(logs).toMatch(/closeAllConnections 失败.*conn-reject-boom/);
  });

  it("session 没有 closeAllConnections 方法（旧 Electron / 假 session）：跳过，不抛", async () => {
    const t = await prepare();
    loopbackAllow(t.env.wcs[0]);
    delete t.persistent.closeAllConnections;
    expect(() => t.onConfig({ trustLoopbackCerts: false })).not.toThrow();
    await flush();
  });
});

describe("R6-42c·真 manager：onConfig 的 evaluateEnabled 开→关——先赋值、后逐会话撤销", () => {
  const prepare = async () => {
    const env = makeManager();
    const onConfig = (cfg: Record<string, unknown>) => (env.manager as any).onConfig(cfg);
    onConfig({ evaluateEnabled: true });
    await env.dispatch("navigate", { url: "about:blank" }, "T1");
    await env.dispatch("navigate", { url: "about:blank" }, "T2");
    const s1 = (env.manager as any).getSession("T1");
    const s2 = (env.manager as any).getSession("T2");
    const approvedOf = (s: any) => (s.getExt(EVALUATE_APPROVAL_EXT, () => ({ approved: false })) as { approved: boolean }).approved;
    // 两个会话都处于「仅本任务」已批准的状态
    for (const s of [s1, s2]) s.getExt(EVALUATE_APPROVAL_EXT, () => ({ approved: false })).approved = true;
    return { env, onConfig, s1, s2, approvedOf };
  };

  it("先赋值后撤销：撤销回调执行时总闸已经是 false（调回「先撤销后赋值」会读到 true）；回调收到 reason=gate-off、had=true", async () => {
    const t = await prepare();
    const seen: Array<{ gate: boolean; reason: string; had: boolean }> = [];
    for (const s of [t.s1, t.s2]) {
      onEvaluateRevoked(s, (info: { reason: string; had: boolean }) => {
        seen.push({ gate: s.host.isEvaluateEnabled(), reason: info.reason, had: info.had });
      });
    }
    t.onConfig({ evaluateEnabled: false });
    expect(seen).toEqual([
      { gate: false, reason: "gate-off", had: true },
      { gate: false, reason: "gate-off", had: true },
    ]);
    expect(t.approvedOf(t.s1)).toBe(false);
    expect(t.approvedOf(t.s2)).toBe(false);
  });

  it("某个会话的 revoke 抛错：onConfig 不抛；总闸仍然落到 false（fail-closed）；其它会话照常被撤销；日志写明哪个会话失败", async () => {
    const t = await prepare();
    const s2Hook = vi.fn();
    onEvaluateRevoked(t.s2, s2Hook);
    // T1（Map 里排第一）的 revoke 会抛：revokeEvaluateApproval 第一步就是读它的审批状态 ext
    const origGetExt = t.s1.getExt.bind(t.s1);
    t.s1.getExt = (key: string, factory: () => unknown) => {
      if (key === EVALUATE_APPROVAL_EXT) throw new Error("revoke-boom");
      return origGetExt(key, factory);
    };
    expect(() => t.onConfig({ evaluateEnabled: false })).not.toThrow();
    expect((t.env.manager as any).getConfig().evaluateEnabled).toBe(false);
    expect(t.s1.host.isEvaluateEnabled()).toBe(false);
    expect(t.s2.host.isEvaluateEnabled()).toBe(false);
    expect(t.approvedOf(t.s2)).toBe(false); // T1 抛错没有拦住后面的 T2
    expect(s2Hook).toHaveBeenCalledTimes(1);
    expect(t.env.logs.join("\n")).toMatch(/撤销会话 T1 的 evaluate 批准失败.*revoke-boom/);
    t.s1.getExt = origGetExt;
  });

  it("revoke 抛错不影响同一次配置里的后续步骤：trustLoopbackCerts 开→关的断连与其它开关照常", async () => {
    const t = await prepare();
    loopbackAllow(t.env.wcs[0]);
    const origGetExt = t.s1.getExt.bind(t.s1);
    t.s1.getExt = (key: string, factory: () => unknown) => {
      if (key === EVALUATE_APPROVAL_EXT) throw new Error("revoke-boom");
      return origGetExt(key, factory);
    };
    expect(() => t.onConfig({ evaluateEnabled: false, trustLoopbackCerts: false, storageAccess: true })).not.toThrow();
    await flush();
    expect(t.env.sessions.get(BROWSER_PARTITION)!.closeAllConnections).toHaveBeenCalledTimes(1);
    const cfg = (t.env.manager as any).getConfig();
    expect(cfg).toMatchObject({ evaluateEnabled: false, trustLoopbackCerts: false, storageAccess: true });
    t.s1.getExt = origGetExt;
  });

  it("总闸不是 开→关（false→false / false→true / true→true）不撤销已有批准", async () => {
    const t = await prepare();
    t.onConfig({ evaluateEnabled: true }); // true→true
    expect(t.approvedOf(t.s1)).toBe(true);
    t.onConfig({ evaluateEnabled: false }); // true→false：撤销
    expect(t.approvedOf(t.s1)).toBe(false);
    t.s1.getExt(EVALUATE_APPROVAL_EXT, () => ({})).approved = true;
    t.onConfig({ evaluateEnabled: false }); // false→false
    expect(t.approvedOf(t.s1)).toBe(true);
    t.onConfig({ evaluateEnabled: true }); // false→true
    expect(t.approvedOf(t.s1)).toBe(true);
    expect(t.s1.host.isEvaluateEnabled()).toBe(true);
  });
});
