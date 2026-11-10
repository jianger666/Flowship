/**
 * R6-39②：`tab.mjs` 的 `#fireContextLost`（render-process-gone → crash / did-navigate → navigate / debugger detach → detach）
 * 以前只被「假 tab 自己带 fireLost」的测试覆盖——删掉 tab.mjs 里这三处调用，110 个相关测试仍全绿。
 * 这里把接线升级成**行为**：真 BrowserTab（假 webContents / 假 debugger，捕获它注册的事件处理器并手动触发）+ 真 ops/debug.mjs 调试器模块：
 *   - tab 层：三种事件分别以正确的 reason 触发 addContextLostHook 订阅者；回调抛错只记日志、不影响其它订阅者；取消订阅 / 销毁后不再触发；
 *             同文档导航（did-navigate-in-page）与导航开始（did-start-navigation）**不**触发（R6-09 的有意偏差：提交才算）；
 *   - 端到端：真 tab 上暂停 → 崩溃 / 换进程导航 / debugger 断开 / resume 失败 → `tab.debugPause` 被清、入口闸门解锁、留一条系统日志。
 * 参考 tests/browser-r6-s3-debug-pause.test.ts（它用假 tab 直接 fireLost，只证明了 debug 模块这一半）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 假 webContents / 假 session 的松散形状，只在本测试里用 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { createHandlers, debugPauseGate, normalize } from "../electron-app/browser/ops/debug.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";
import { BrowserTab } from "../electron-app/browser/tab.mjs";

const SCRIPT = { scriptId: "s1", url: "https://site.test/app.js", startLine: 0, startColumn: 0, endLine: 20, endColumn: 0 };
const frame = () => ({ callFrameId: "f0", functionName: "compute", location: { scriptId: "s1", lineNumber: 5, columnNumber: 4 }, scopeChain: [] });

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** 真 BrowserTab + 假 WebContentsView / 假 debugger；wc.on 注册的处理器全部捕获，测试里手动触发 */
const makeRealTab = () => {
  let attached = false;
  const wcHandlers = new Map<string, Array<(...a: any[]) => void>>();
  let onMessage: (e: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void = () => {};
  let onDetach: (e: unknown, reason: string) => void = () => {};
  const sent: string[] = [];
  const failOn = new Map<string, string>();
  const dbg = {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
    },
    on: (ev: string, fn: never) => {
      if (ev === "message") onMessage = fn;
      if (ev === "detach") onDetach = fn;
    },
    sendCommand: vi.fn(async (method: string) => {
      sent.push(method);
      const fail = failOn.get(method);
      if (fail !== undefined) throw new Error(fail);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Debugger.enable") onMessage(null, "Debugger.scriptParsed", SCRIPT);
      if (method === "Debugger.resume") onMessage(null, "Debugger.resumed", {});
      return {};
    }),
  };
  const wc = {
    debugger: dbg,
    on: vi.fn((ev: string, fn: (...a: any[]) => void) => {
      wcHandlers.set(ev, [...(wcHandlers.get(ev) ?? []), fn]);
    }),
    setWindowOpenHandler: vi.fn(),
    setAudioMuted: vi.fn(),
    loadURL: vi.fn(async () => {}),
    getURL: () => "https://site.test/page",
    getTitle: () => "示例页",
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    close: vi.fn(),
  };
  class FakeView {
    webContents = wc;
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setVisible = vi.fn();
  }
  const parking = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
  const hooks = {
    onChange: vi.fn(),
    onLoaded: vi.fn(),
    onNewTab: vi.fn(),
    onRecorder: vi.fn(),
    onBlocked: vi.fn(),
    onDialog: vi.fn(),
    onNeedLockSync: vi.fn(),
    onCrashed: vi.fn(),
  };
  const logs: string[] = [];
  const tab = new BrowserTab({
    id: "t1",
    WebContentsView: FakeView as never,
    parkingWindow: parking,
    pageScripts: { PAGE_WORLD_NAME: "flowship", RECORDER_BINDING: "__rec", buildPageScript: () => "//" } as never,
    isAppUrl: () => false,
    hooks,
    log: (m: string) => logs.push(m),
  });
  cleanups.push(() => {
    if (!tab.destroyed) tab.destroy();
  });
  return {
    tab,
    hooks,
    logs,
    sent,
    failOn,
    /** 触发 webContents 事件（与 Electron 一致：第一个参数是 event） */
    fire: (ev: string, ...args: unknown[]) => {
      const hs = wcHandlers.get(ev) ?? [];
      expect(hs.length, `tab.mjs 没有注册 wc.on("${ev}")`).toBeGreaterThan(0);
      for (const h of hs) h({}, ...args);
    },
    /** 触发 debugger 的 detach 事件 */
    detach: (reason = "target closed") => {
      attached = false;
      onDetach(null, reason);
    },
    /** 灌一条 CDP 消息（走 tab 真实的 #onCdpMessage 分发） */
    cdp: (method: string, params: Record<string, unknown> = {}) => onMessage(null, method, params),
  };
};

describe("R6-39② tab 层：#fireContextLost 的三处接线（真 BrowserTab）", () => {
  const withHook = async () => {
    const h = makeRealTab();
    await h.tab.ready;
    const reasons: string[] = [];
    h.tab.addContextLostHook((r: string) => reasons.push(r));
    return { h, reasons };
  };

  it("render-process-gone → reason=crash（并照常 crashed=true / onCrashed）", async () => {
    const { h, reasons } = await withHook();
    h.fire("render-process-gone", { reason: "crashed" });
    expect(reasons).toEqual(["crash"]);
    expect(h.tab.crashed).toBe(true);
    expect(h.hooks.onCrashed).toHaveBeenCalledTimes(1);
  });

  it("did-navigate（主框架跨文档导航已提交）→ reason=navigate，且发生在 navCommitted 自增之后", async () => {
    const { h, reasons } = await withHook();
    let committedAtFire = -1;
    h.tab.addContextLostHook(() => {
      committedAtFire = h.tab.navCommitted;
    });
    h.fire("did-navigate", "https://site.test/next", 200);
    expect(reasons).toEqual(["navigate"]);
    expect(committedAtFire).toBe(1);
  });

  it("debugger detach → reason=detach（cdpReady 同时置 false）", async () => {
    const { h, reasons } = await withHook();
    expect(h.tab.cdpReady).toBe(true);
    h.detach("target closed");
    expect(reasons).toEqual(["detach"]);
    expect(h.tab.cdpReady).toBe(false);
  });

  it("三种事件依次发生 → 订阅者按顺序收到 crash / navigate / detach，各一次", async () => {
    const { h, reasons } = await withHook();
    h.fire("render-process-gone", { reason: "oom" });
    h.fire("did-navigate", "https://site.test/b", 200);
    h.detach();
    expect(reasons).toEqual(["crash", "navigate", "detach"]);
  });

  it("不触发：did-navigate-in-page（同文档）、did-start-navigation（导航开始但可能被取消 / 被暂停挂住）——提交才算", async () => {
    const { h, reasons } = await withHook();
    h.fire("did-navigate-in-page", "https://site.test/page#x", true);
    h.fire("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(reasons).toEqual([]);
  });

  it("订阅者抛错：只记日志，不影响同一事件的其它订阅者，也不影响 tab 自己的后续处理（onCrashed 照常调）", async () => {
    const h = makeRealTab();
    await h.tab.ready;
    const second = vi.fn();
    h.tab.addContextLostHook(() => {
      throw new Error("hook boom");
    });
    h.tab.addContextLostHook(second);
    h.fire("render-process-gone", { reason: "crashed" });
    expect(second).toHaveBeenCalledWith("crash");
    expect(h.hooks.onCrashed).toHaveBeenCalledTimes(1);
    expect(h.logs.join("\n")).toContain("上下文失效钩子出错");
  });

  it("取消订阅后不再触发；tab 销毁后清空订阅（之后到的事件不再回调）", async () => {
    const h = makeRealTab();
    await h.tab.ready;
    const a = vi.fn();
    const b = vi.fn();
    const offA = h.tab.addContextLostHook(a);
    h.tab.addContextLostHook(b);
    offA();
    h.fire("render-process-gone", {});
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    h.tab.destroy();
    h.fire("render-process-gone", {});
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("R6-39② 端到端：真 tab + 真 debug 模块——暂停后崩溃 / 换进程导航 / debugger 断开 / resume 失败，暂停态都被清", () => {
  const setup = async () => {
    const h = makeRealTab();
    await h.tab.ready;
    const exts = new Map<string, unknown>();
    const tab = h.tab as any;
    const session: Record<string, any> = {
      taskId: "task-1",
      tabs: [tab],
      activeTabId: tab.id,
      get activeTab() {
        return tab;
      },
      controller: "idle",
      host: { isEvaluateEnabled: () => false, emitEvent: vi.fn() },
      prompts: { request: vi.fn(async () => ({ action: "deny" })) },
      getExt: (key: string, factory: () => unknown) => {
        if (!exts.has(key)) exts.set(key, factory());
        return exts.get(key);
      },
      getTab: () => tab,
      activityLog: { addAI: vi.fn(), addSystem: vi.fn() },
      log: vi.fn(),
    };
    const scheduled: string[] = [];
    const handlers = createHandlers({
      requireSession: () => session,
      abortable: <T>(p: Promise<T>) => p,
      scheduleState: (t: string) => scheduled.push(t),
      addStateContributor: () => {},
      registerExt: () => {},
      sessions: () => [session],
      electron: {},
      log: vi.fn(),
    } as any);
    const run = (args: Record<string, unknown>) => handlers.debug("task-1", normalize("debug", args, OP_HELPERS) as Record<string, unknown>) as Promise<any>;
    const sysLogs = () => session.activityLog.addSystem.mock.calls.map((c: any[]) => String(c[0].summary));
    const gateBlocks = () => {
      try {
        debugPauseGate(session as never, "click", { tabId: "t1" });
        return false;
      } catch (e) {
        return e instanceof BrowserError && e.code === "TIMEOUT";
      }
    };
    /** 让调试器模块接上真 tab 并制造一次暂停（paused 事件走 tab 真实的 CDP 消息分发） */
    const pause = async () => {
      await run({ action: "pause_on_exception", state: "all" });
      h.cdp("Debugger.paused", { reason: "other", callFrames: [frame()], hitBreakpoints: [] });
      expect(tab.debugPause).toBeTruthy();
      expect(gateBlocks()).toBe(true);
    };
    return { h, tab, session, run, sysLogs, gateBlocks, pause, scheduled };
  };

  it.each([
    ["render-process-gone", /页面进程崩溃/, (h: ReturnType<typeof makeRealTab>) => h.fire("render-process-gone", { reason: "crashed" })],
    ["did-navigate（换进程 / 新文档提交）", /已导航到新文档/, (h: ReturnType<typeof makeRealTab>) => h.fire("did-navigate", "https://other.test/next", 200)],
    ["debugger detach", /调试连接已断开/, (h: ReturnType<typeof makeRealTab>) => h.detach("target closed")],
  ])("%s：debugPause 被清、入口闸门解锁、写一条系统日志、推送状态", async (_name, label, trigger) => {
    const s = await setup();
    await s.pause();
    const before = s.scheduled.length;
    trigger(s.h);
    expect(s.tab.debugPause).toBeNull();
    expect(s.gateBlocks()).toBe(false);
    expect(s.sysLogs().some((x: string) => label.test(x) && x.includes("暂停状态已清除"))).toBe(true);
    expect(s.scheduled.length).toBeGreaterThan(before);
  });

  it("对照：没有暂停时这三种事件不写日志（navigate 天天发，不能刷屏）", async () => {
    const s = await setup();
    await s.run({ action: "pause_on_exception", state: "all" });
    const n = s.session.activityLog.addSystem.mock.calls.length;
    s.h.fire("did-navigate", "https://site.test/x", 200);
    s.h.fire("render-process-gone", {});
    s.h.detach();
    expect(s.session.activityLog.addSystem.mock.calls.length).toBe(n);
  });

  it("对照：did-navigate-in-page（同文档）不清暂停态——页面仍冻在断点上", async () => {
    const s = await setup();
    await s.pause();
    s.h.fire("did-navigate-in-page", "https://site.test/page#x", true);
    expect(s.tab.debugPause).toBeTruthy();
    expect(s.gateBlocks()).toBe(true);
  });

  it("resume 失败（真 tab.send 抛错）：debugPause 被清、闸门解锁、发了 Debugger.disable、错误可读", async () => {
    const s = await setup();
    await s.pause();
    s.h.failOn.set("Debugger.resume", "Target closed");
    await expect(s.run({ action: "resume" })).rejects.toThrow(/继续运行失败.*强制清除暂停状态/);
    expect(s.tab.debugPause).toBeNull();
    expect(s.gateBlocks()).toBe(false);
    expect(s.h.sent).toContain("Debugger.disable");
    expect(s.sysLogs().some((x: string) => x.includes("resume 失败"))).toBe(true);
  });

  it("清掉之后新的 Debugger.paused 仍能正常跟踪（订阅没有随事件被拆掉）", async () => {
    const s = await setup();
    await s.pause();
    s.h.fire("did-navigate", "https://site.test/next", 200);
    expect(s.tab.debugPause).toBeNull();
    s.h.cdp("Debugger.paused", { reason: "other", callFrames: [frame()], hitBreakpoints: [] });
    expect(s.tab.debugPause).toBeTruthy();
    expect(s.gateBlocks()).toBe(true);
  });
});
