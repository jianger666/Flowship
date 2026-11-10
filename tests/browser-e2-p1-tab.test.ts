/**
 * E2·P1 在 tab.mjs 上的两处最小改动（真 BrowserTab + 假 wc / 假 debugger）：
 *  - `addEmulationHook`：设备模拟落地后通知（页面权限据此给「定位模拟」绑定 origin）；失败回滚时不通知；回调出错不影响模拟；销毁时清空；
 *  - `promptHold` / navigate 超时分支：本 tab 上挂着认证 / 证书提示时，超时先等提示结算（再给加载宽限），而不是让用户填密码的时间算进「超时」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserTab } from "../electron-app/browser/tab.mjs";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const makeTab = (opts: { failMethods?: Record<string, string> } = {}) => {
  let attached = false;
  let loadResolve: (() => void) | null = null;
  const dbg = {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
    },
    on: vi.fn(),
    sendCommand: vi.fn(async (method: string) => {
      const fail = opts.failMethods?.[method];
      if (fail) throw new Error(fail);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      return {};
    }),
  };
  const wc = {
    debugger: dbg,
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setAudioMuted: vi.fn(),
    // about:blank 的初始导航立刻完成；之后的 loadURL 由测试手动放行
    loadURL: vi.fn((url: string) => (url === "about:blank" ? Promise.resolve() : new Promise<void>((r) => (loadResolve = r)))),
    getURL: () => "https://example.com/final",
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
  return { tab, logs, finishLoad: () => loadResolve?.() };
};

const settleAll = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("addEmulationHook", () => {
  it("模拟落地后调 hook({ next, prev, patch })；取消订阅后不再调；失败回滚时不调", async () => {
    const h = makeTab();
    await h.tab.ready;
    const seen: Array<{ next: Record<string, unknown>; prev: Record<string, unknown>; patch: Record<string, unknown> }> = [];
    const off = h.tab.addEmulationHook((e: never) => seen.push(e));
    await h.tab.applyEmulation({ geolocation: { latitude: 31.2, longitude: 121.5 } });
    expect(seen).toHaveLength(1);
    expect(seen[0].next.geolocation).toEqual({ latitude: 31.2, longitude: 121.5 });
    expect(seen[0].prev.geolocation).toBeUndefined();
    expect(seen[0].patch).toEqual({ geolocation: { latitude: 31.2, longitude: 121.5 } });
    off();
    await h.tab.applyEmulation({ colorScheme: "dark" });
    expect(seen).toHaveLength(1);

    const f = makeTab({ failMethods: { "Emulation.setGeolocationOverride": "boom" } });
    await f.tab.ready;
    const fSeen: unknown[] = [];
    f.tab.addEmulationHook((e: never) => fSeen.push(e));
    await expect(f.tab.applyEmulation({ geolocation: { latitude: 1, longitude: 2 } })).rejects.toThrow(/设备模拟设置失败/);
    expect(fSeen).toHaveLength(0);
    expect((f.tab.emulation as { geolocation?: unknown }).geolocation).toBeUndefined();
  });

  it("hook 抛错只记日志、不影响模拟结果与其它 hook", async () => {
    const h = makeTab();
    await h.tab.ready;
    const second = vi.fn();
    h.tab.addEmulationHook(() => {
      throw new Error("hook boom");
    });
    h.tab.addEmulationHook(second);
    const r = await h.tab.applyEmulation({ geolocation: { latitude: 1, longitude: 2 } });
    expect(r.emulation).toBeTruthy();
    expect(second).toHaveBeenCalledTimes(1);
    expect(h.logs.join("\n")).toContain("模拟回调出错");
  });

  it("reset 也通知（next 为空对象，页面权限据此撤销定位绑定）；销毁时 hook 清空", async () => {
    const h = makeTab();
    await h.tab.ready;
    const seen: Array<{ next: Record<string, unknown> }> = [];
    h.tab.addEmulationHook((e: never) => seen.push(e));
    await h.tab.applyEmulation({ geolocation: { latitude: 1, longitude: 2 } });
    await h.tab.applyEmulation({ reset: true });
    expect(seen).toHaveLength(2);
    expect(seen[1].next.geolocation).toBeUndefined();
    h.tab.destroy();
    expect(h.tab.emulationHooks.size).toBe(0);
    expect(h.tab.promptHold).toBeNull();
  });
});

describe("navigate 超时分支与 promptHold", () => {
  it("没有挂起的提示：行为不变（到点按超时返回，status 为 null）", async () => {
    const h = makeTab();
    await h.tab.ready;
    const p = h.tab.navigate("https://example.com/", { timeoutMs: 1000 });
    let done = false;
    void p.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await settleAll();
    expect(done).toBe(true);
    await expect(p).resolves.toMatchObject({ url: "https://example.com/final", status: null });
  });

  it("超时时挂着提示：先等提示结算，再给加载宽限（min(timeout, 15s)）才返回", async () => {
    const h = makeTab();
    await h.tab.ready;
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    let calls = 0;
    h.tab.promptHold = () => {
      calls += 1;
      return calls === 1 ? hold : null;
    };
    const p = h.tab.navigate("https://example.com/", { timeoutMs: 1000 });
    let done = false;
    void p.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(30_000); // 提示还没处理：再久也不返回
    expect(done).toBe(false);
    release();
    await settleAll();
    expect(done).toBe(false); // 提示结算后还有加载宽限
    await vi.advanceTimersByTimeAsync(1000);
    await settleAll();
    expect(done).toBe(true);
    await expect(p).resolves.toMatchObject({ status: null });
  });

  it("提示挂着期间页面先加载完 → 立即返回（不等提示）", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.promptHold = () => new Promise(() => {}); // 永不结算的提示
    const p = h.tab.navigate("https://example.com/", { timeoutMs: 5000 });
    let done = false;
    void p.then(() => {
      done = true;
    });
    await settleAll();
    h.finishLoad();
    await settleAll();
    expect(done).toBe(true);
  });

  it("promptHold 抛错 / 返回被拒绝的 Promise 都当作没有挂起处理，不让 navigate 崩", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.tab.promptHold = () => {
      throw new Error("x");
    };
    const p1 = h.tab.navigate("https://example.com/", { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    await settleAll();
    await expect(p1).resolves.toMatchObject({ status: null });

    const h2 = makeTab();
    await h2.tab.ready;
    let n = 0;
    h2.tab.promptHold = () => (++n === 1 ? Promise.reject(new Error("rejected")) : null);
    const p2 = h2.tab.navigate("https://example.com/", { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await settleAll();
    await expect(p2).resolves.toMatchObject({ status: null });
  });

  it("certOverride 字段默认 null（net-guard 写、新导航开始时清空）", async () => {
    const h = makeTab();
    await h.tab.ready;
    expect(h.tab.certOverride).toBeNull();
  });
});
