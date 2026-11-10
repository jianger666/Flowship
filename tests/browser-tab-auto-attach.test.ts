/* eslint-disable @typescript-eslint/no-explicit-any -- 假 electron 对象 / 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * 2026-11-10 v1.9.46 事故回归：用户在内置浏览器地址栏输入 baidu.com，Flowship 主进程 SIGSEGV 闪退。
 *
 * 根因：tab 初始化时开了 `Target.setAutoAttach { flatten: true }`（为了拿到跨站 iframe 的子会话），没带 filter，
 * 于是页面每创建一个 Web Worker（baidu.com 首页会起 `blob:` Worker）Chromium 就发一条 `Target.attachedToTarget`；
 * 旧的 `#onAttached` 对非 iframe 目标立刻回 `Target.detachFromTarget`——Electron 42.4.0（Chromium 148）上这条命令会让主进程崩掉。
 *
 * 真 Electron 复现 / 验证见 PR 描述里的复现脚本（需要联网访问 baidu.com），这里只钉住单测能钉住的三件事：
 *   ① 自动附加参数带「只放行 iframe」的 filter（主会话与每个子会话都发）；
 *   ② worker / service worker 等非 iframe 目标即使漏进来，也**绝不**发 detachFromTarget、不登记成子会话、不做任何初始化；
 *   ③ iframe（OOPIF）子会话照常登记并初始化（防止修复误伤跨站 iframe 读树）。
 */
import { describe, expect, it, vi } from "vitest";

import { AUTO_ATTACH_PARAMS, BrowserTab } from "../electron-app/browser/tab.mjs";

type Sent = { method: string; params: Record<string, unknown>; sessionId: string | null };

const makeTab = () => {
  const sent: Sent[] = [];
  let attached = false;
  let onMessage: (e: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void = () => {};
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
    },
    sendCommand: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      sent.push({ method, params, sessionId: sessionId ?? null });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
      return {};
    }),
  };
  const wc = {
    debugger: dbg,
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setAudioMuted: vi.fn(),
    loadURL: vi.fn(async () => {}),
    getURL: () => "https://www.baidu.com/",
    getTitle: () => "百度一下，你就知道",
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
  const hooks = new Proxy({}, { get: () => vi.fn() }) as never;
  const tab = new BrowserTab({
    id: "t1",
    WebContentsView: FakeView as never,
    parkingWindow: { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } },
    pageScripts: { PAGE_WORLD_NAME: "flowship", RECORDER_BINDING: "__rec", buildPageScript: () => "//" } as never,
    isAppUrl: () => false,
    hooks,
  } as any);
  const emit = (method: string, params: Record<string, unknown>, sessionId?: string) => onMessage(null, method, params, sessionId);
  const settle = () => new Promise<void>((r) => setTimeout(r, 25));
  const cmds = (method: string) => sent.filter((c) => c.method === method);
  return { tab, sent, emit, settle, cmds };
};

describe("AUTO_ATTACH_PARAMS：只自动附加 iframe", () => {
  it("形状：flatten + 不等调试器 + filter 先放行 iframe、再排除其余全部类型", () => {
    expect(AUTO_ATTACH_PARAMS.autoAttach).toBe(true);
    expect(AUTO_ATTACH_PARAMS.flatten).toBe(true);
    expect(AUTO_ATTACH_PARAMS.waitForDebuggerOnStart).toBe(false);
    // 顺序有语义（首条命中生效）：iframe 必须在前、catch-all 排除必须在后
    expect(AUTO_ATTACH_PARAMS.filter).toEqual([{ type: "iframe" }, { exclude: true }]);
  });

  it("主会话初始化时发的 Target.setAutoAttach 就是这份参数（带 filter）", async () => {
    const h = makeTab();
    await h.tab.ready;
    const calls = h.cmds("Target.setAutoAttach");
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBeNull();
    expect(calls[0].params).toEqual(AUTO_ATTACH_PARAMS);
    expect((calls[0].params as any).filter).toEqual([{ type: "iframe" }, { exclude: true }]);
  });
});

describe("非 iframe 目标（worker 等）：绝不 detach、不登记、不初始化", () => {
  for (const type of ["worker", "service_worker", "shared_worker", "worklet", "other"]) {
    it(`type=${type}：不发 Target.detachFromTarget，也不当子会话初始化`, async () => {
      const h = makeTab();
      await h.tab.ready;
      const before = h.sent.length;
      h.emit(
        "Target.attachedToTarget",
        { sessionId: `s-${type}`, targetInfo: { type, targetId: `T-${type}`, url: "blob:https://www.baidu.com/b3572aeb-bd56-44f6-8e6e-168706fec824" } },
        undefined,
      );
      await h.settle();
      // 这条命令就是 v1.9.46 闪退的触发点
      expect(h.cmds("Target.detachFromTarget")).toHaveLength(0);
      // 一个字节都不往这个会话发
      expect(h.sent.slice(before)).toEqual([]);
      expect(h.tab.children.has(`s-${type}`)).toBe(false);
    });
  }

  it("子会话（OOPIF）里再冒出 worker 同理：不 detach、不发命令", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.emit("Target.attachedToTarget", { sessionId: "child0", targetInfo: { type: "iframe", targetId: "T0" } });
    await h.settle();
    const before = h.sent.length;
    h.emit("Target.attachedToTarget", { sessionId: "w-in-child", targetInfo: { type: "worker", targetId: "TW" } }, "child0");
    await h.settle();
    expect(h.cmds("Target.detachFromTarget")).toHaveLength(0);
    expect(h.sent.slice(before)).toEqual([]);
    expect(h.tab.children.has("w-in-child")).toBe(false);
  });
});

describe("iframe（OOPIF）子会话：照常登记并初始化", () => {
  it("登记进 children，并在子会话上做完整初始化（含带 filter 的 setAutoAttach）", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.emit("Target.attachedToTarget", { sessionId: "child0", targetInfo: { type: "iframe", targetId: "T0" } });
    await h.settle();
    expect(h.tab.children.has("child0")).toBe(true);
    const onChild = (m: string) => h.cmds(m).filter((c) => c.sessionId === "child0");
    for (const m of ["Page.enable", "Runtime.enable", "DOM.enable", "Network.enable", "Log.enable", "Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument"]) {
      expect(onChild(m), `${m} 应发到子会话`).toHaveLength(1);
    }
    const auto = onChild("Target.setAutoAttach");
    expect(auto).toHaveLength(1);
    expect(auto[0].params).toEqual(AUTO_ATTACH_PARAMS);
    expect(h.cmds("Target.detachFromTarget")).toHaveLength(0);
  });

  it("worker 与 iframe 混着来：只有 iframe 被登记", async () => {
    const h = makeTab();
    await h.tab.ready;
    h.emit("Target.attachedToTarget", { sessionId: "w1", targetInfo: { type: "worker", targetId: "TW1" } });
    h.emit("Target.attachedToTarget", { sessionId: "f1", targetInfo: { type: "iframe", targetId: "TF1" } });
    h.emit("Target.attachedToTarget", { sessionId: "sw1", targetInfo: { type: "service_worker", targetId: "TS1" } });
    await h.settle();
    expect([...h.tab.children.keys()]).toEqual(["f1"]);
    expect(h.cmds("Target.detachFromTarget")).toHaveLength(0);
  });
});
