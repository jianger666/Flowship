/**
 * 增强包 E2 · Debugger 域共享入口（electron-app/browser/debugger-hub.mjs，契约 §15.1）：
 * 引用计数（sources 与 debug 互不踩）、scriptParsed 表（上限 / 淘汰）、暂停现场、子会话补 enable、销毁收尾。
 */
import { describe, expect, it, vi } from "vitest";

import { MAX_SCRIPTS, createDebuggerHub, getDebuggerHub } from "../electron-app/browser/debugger-hub.mjs";

type Listener = (method: string, params: Record<string, unknown>, sessionId: string | null) => void;

const makeTab = () => {
  const listeners = new Set<Listener>();
  const hooks = new Set<(sid: string | null) => Promise<void> | void>();
  const sent: Array<{ method: string; sessionId: string | null }> = [];
  const failures = new Set<string>();
  let sessionIds: Array<string | null> = [null];
  const ext = new Map<string, { dispose?: () => void }>();
  const tab = {
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId: string | null = null) => {
      sent.push({ method, sessionId });
      if (failures.has(`${method}:${sessionId ?? "main"}`)) throw new Error("cdp down");
      if (method === "Debugger.getScriptSource") return { scriptSource: `src of ${String(params.scriptId)}` };
      return {};
    }),
    onCdpEvent: (fn: Listener) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    addSessionHook: (fn: (sid: string | null) => Promise<void> | void) => {
      hooks.add(fn);
      return () => hooks.delete(fn);
    },
    cdpSessionIds: () => sessionIds,
    getExt: (key: string, factory: () => { dispose?: () => void }) => {
      if (!ext.has(key)) ext.set(key, factory());
      return ext.get(key)!;
    },
  };
  return {
    tab,
    sent,
    failures,
    setSessions: (ids: Array<string | null>) => {
      sessionIds = ids;
    },
    emit: (method: string, params: Record<string, unknown> = {}, sid: string | null = null) => listeners.forEach((l) => l(method, params, sid)),
    hooks,
    listenerCount: () => listeners.size,
    ext,
  };
};

const enables = (h: ReturnType<typeof makeTab>) => h.sent.filter((s) => s.method === "Debugger.enable");
const disables = (h: ReturnType<typeof makeTab>) => h.sent.filter((s) => s.method === "Debugger.disable");

describe("引用计数", () => {
  it("两个使用者只 enable 一次；先释放一个不 disable；全部释放才 disable", async () => {
    const h = makeTab();
    const hub = createDebuggerHub(h.tab);
    await hub.acquire("sources");
    await hub.acquire("debug");
    expect(enables(h)).toHaveLength(1);
    expect(hub.ownerCount()).toBe(2);
    await hub.release("sources");
    expect(disables(h)).toHaveLength(0);
    expect(h.listenerCount()).toBe(1);
    await hub.release("debug");
    expect(disables(h)).toHaveLength(1);
    expect(h.listenerCount()).toBe(0);
    expect(h.hooks.size).toBe(0);
  });

  it("release 幂等；未登记的 owner 释放无副作用", async () => {
    const h = makeTab();
    const hub = createDebuggerHub(h.tab);
    await hub.release("nobody");
    await hub.acquire("a");
    await hub.release("a");
    await hub.release("a");
    expect(disables(h)).toHaveLength(1);
  });

  it("主会话 enable 失败：acquire 抛错并回滚登记 / 摘监听；子会话失败只记日志", async () => {
    const h = makeTab();
    h.failures.add("Debugger.enable:main");
    const hub = createDebuggerHub(h.tab);
    await expect(hub.acquire("a")).rejects.toThrow();
    expect(hub.ownerCount()).toBe(0);
    expect(h.listenerCount()).toBe(0);

    const h2 = makeTab();
    h2.setSessions([null, "child1"]);
    h2.failures.add("Debugger.enable:child1");
    const log = vi.fn();
    const hub2 = createDebuggerHub(h2.tab, { log });
    await expect(hub2.acquire("a")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("OOPIF 子会话：初始化钩子在有使用者时补 enable，没有使用者时不补", async () => {
    const h = makeTab();
    const hub = createDebuggerHub(h.tab);
    await hub.acquire("a");
    const before = enables(h).length;
    for (const fn of h.hooks) await fn("child-9");
    expect(enables(h)).toHaveLength(before + 1);
    expect(enables(h).at(-1)).toEqual({ method: "Debugger.enable", sessionId: "child-9" });
    await hub.release("a");
    expect(h.hooks.size).toBe(0);
  });

  it("getDebuggerHub 同一个 tab 返回同一份", () => {
    const h = makeTab();
    expect(getDebuggerHub(h.tab)).toBe(getDebuggerHub(h.tab));
  });
});

describe("scriptParsed 表 / 暂停现场 / 订阅", () => {
  it("记录脚本元信息；url 过滤；getScript / getScriptSource", async () => {
    const h = makeTab();
    const hub = createDebuggerHub(h.tab);
    await hub.acquire("s");
    h.emit("Debugger.scriptParsed", { scriptId: "1", url: "https://a.com/app.js", sourceMapURL: "app.js.map", length: 10, isModule: true });
    h.emit("Debugger.scriptParsed", { scriptId: "2", url: "https://a.com/vendor.js", sourceMapURL: "" });
    expect(hub.scripts().map((s: { scriptId: string }) => s.scriptId)).toEqual(["1", "2"]);
    expect(hub.scripts({ url: "app" })).toHaveLength(1);
    expect(hub.getScript("1")).toMatchObject({ url: "https://a.com/app.js", sourceMapURL: "app.js.map", isModule: true });
    expect(hub.getScript("2")!.sourceMapURL).toBeUndefined();
    await expect(hub.getScriptSource("1")).resolves.toBe("src of 1");
  });

  it("同 scriptId 在不同会话互不覆盖；返回的是拷贝", async () => {
    const h = makeTab();
    const hub = createDebuggerHub(h.tab);
    await hub.acquire("s");
    h.emit("Debugger.scriptParsed", { scriptId: "1", url: "main.js" }, null);
    h.emit("Debugger.scriptParsed", { scriptId: "1", url: "frame.js" }, "child");
    expect(hub.getScript("1", null)!.url).toBe("main.js");
    expect(hub.getScript("1", "child")!.url).toBe("frame.js");
    hub.scripts()[0].url = "hacked";
    expect(hub.getScript("1", null)!.url).toBe("main.js");
  });

  it(`脚本表上限 ${MAX_SCRIPTS}：淘汰最旧`, async () => {
    const h = makeTab();
    const hub = createDebuggerHub(h.tab);
    await hub.acquire("s");
    for (let i = 0; i < MAX_SCRIPTS + 10; i++) h.emit("Debugger.scriptParsed", { scriptId: String(i), url: `u${i}.js` });
    expect(hub.scripts()).toHaveLength(MAX_SCRIPTS);
    expect(hub.getScript("0")).toBeNull();
    expect(hub.getScript(String(MAX_SCRIPTS + 9))).not.toBeNull();
  });

  it("paused / resumed 维护暂停现场；订阅者收到全部 Debugger.* 事件、出错不影响其它；非 Debugger 事件被忽略", async () => {
    const h = makeTab();
    const hub = createDebuggerHub(h.tab);
    await hub.acquire("s");
    const seen: string[] = [];
    hub.on(() => {
      throw new Error("boom");
    });
    const off = hub.on((m: string) => seen.push(m));
    h.emit("Network.requestWillBeSent", {});
    h.emit("Debugger.paused", { reason: "exception", callFrames: [{ callFrameId: "f1" }], hitBreakpoints: ["b1"] });
    expect(hub.getPaused()).toMatchObject({ reason: "exception", hitBreakpoints: ["b1"] });
    expect(hub.getPaused()!.callFrames).toHaveLength(1);
    h.emit("Debugger.resumed");
    expect(hub.getPaused()).toBeNull();
    expect(seen).toEqual(["Debugger.paused", "Debugger.resumed"]);
    off();
    h.emit("Debugger.paused", { reason: "other" });
    expect(seen).toHaveLength(2);
  });

  it("全部释放后脚本表与暂停现场清空", async () => {
    const h = makeTab();
    const hub = createDebuggerHub(h.tab);
    await hub.acquire("s");
    h.emit("Debugger.scriptParsed", { scriptId: "1", url: "a.js" });
    h.emit("Debugger.paused", { reason: "other" });
    await hub.release("s");
    expect(hub.scripts()).toEqual([]);
    expect(hub.getPaused()).toBeNull();
  });
});

describe("dispose（tab 销毁）", () => {
  it("摘监听、清表，之后 acquire 抛错；release 不再发 CDP", async () => {
    const h = makeTab();
    const hub = createDebuggerHub(h.tab);
    await hub.acquire("s");
    const sentBefore = h.sent.length;
    hub.dispose();
    expect(h.listenerCount()).toBe(0);
    await hub.release("s");
    expect(h.sent).toHaveLength(sentBefore);
    await expect(hub.acquire("x")).rejects.toThrow();
  });
});
