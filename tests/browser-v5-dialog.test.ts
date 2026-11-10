/**
 * V5 对话框：真 BrowserTab（假 WebContentsView / 假 CDP / 假计时器）验证挂起 / 处理 / 超时兜底 / 模拟重放；
 * 真 BrowserSession + 假 tab 验证 runAction 与对话框竞速；ops/page-env 的 dialog / emulate 处理器。
 */
import { describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import { describeEmulation } from "../electron-app/browser/emulation.mjs";
import { createHandlers } from "../electron-app/browser/ops/page-env.mjs";
import { BrowserSession } from "../electron-app/browser/session.mjs";
import { BrowserTab, DIALOG_HOLD_MS } from "../electron-app/browser/tab.mjs";

// ───────────────────────── 假 electron 对象 ─────────────────────────

interface Sent {
  method: string;
  params: Record<string, unknown>;
  sessionId: string | null;
}

const makeClock = () => {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeoutFn: (id: number) => {
      timers.delete(id);
    },
    advance: async (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers.entries()]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
      // 让定时器回调里的 async 链跑完
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    pending: () => timers.size,
  };
};

const makeTab = (opts: { failMethods?: Record<string, string> } = {}) => {
  const clock = makeClock();
  const sent: Sent[] = [];
  let attached = false;
  let onMessage: (e: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void = () => {};
  let onDetach: (e: unknown, reason: string) => void = () => {};
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
    sendCommand: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      sent.push({ method, params, sessionId: sessionId ?? null });
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
    loadURL: vi.fn(async () => {}),
    getURL: () => "https://example.com/page?token=secret#frag",
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
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn as never,
    clearTimeoutFn: clock.clearTimeoutFn as never,
  });
  return {
    tab,
    clock,
    sent,
    hooks,
    logs,
    emit: (method: string, params: Record<string, unknown> = {}, sessionId?: string) => onMessage(null, method, params, sessionId),
    detach: () => {
      attached = false;
      onDetach(null, "target closed");
    },
    handled: () => sent.filter((s) => s.method === "Page.handleJavaScriptDialog"),
  };
};

const ready = async (h: ReturnType<typeof makeTab>) => {
  await h.tab.ready;
  h.sent.length = 0;
  h.hooks.onChange.mockClear();
};

const open = (h: ReturnType<typeof makeTab>, params: Record<string, unknown>, sessionId?: string) =>
  h.emit("Page.javascriptDialogOpening", { url: "https://example.com/page?token=secret", ...params }, sessionId);

// ───────────────────────── BrowserTab：挂起 / 处理 ─────────────────────────

describe("BrowserTab：对话框挂起成 pendingDialog", () => {
  it("DIALOG_HOLD_MS 是 20 秒（契约）", () => {
    expect(DIALOG_HOLD_MS).toBe(20_000);
  });

  it("javascriptDialogOpening 不再自动处置：挂起、URL 去 query、触发 onChange 与监听者", async () => {
    const h = makeTab();
    await ready(h);
    const seen: unknown[] = [];
    h.tab.onDialogOpened((d: unknown) => seen.push(d));
    open(h, { type: "confirm", message: "确定删除吗？" });
    expect(h.handled()).toHaveLength(0); // 没有立刻处置
    expect(h.tab.pendingDialog).toMatchObject({ type: "confirm", message: "确定删除吗？", url: "https://example.com/page" });
    expect(h.tab.pendingDialog!.since).toBe(h.clock.now());
    expect(h.tab.pendingDialog!.defaultPrompt).toBeUndefined();
    expect(h.hooks.onChange).toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(h.clock.pending()).toBe(1); // 兜底定时器已挂上
  });

  it("message 截断到 500 字符；未知 type 当 alert；prompt 带 defaultPrompt", async () => {
    const h = makeTab();
    await ready(h);
    open(h, { type: "alert", message: "字".repeat(900) });
    expect(h.tab.pendingDialog!.message.length).toBeLessThanOrEqual(501);
    open(h, { type: "wat", message: "x" });
    expect(h.tab.pendingDialog!.type).toBe("alert");
    open(h, { type: "prompt", message: "名字？", defaultPrompt: "小明" });
    expect(h.tab.pendingDialog).toMatchObject({ type: "prompt", defaultPrompt: "小明" });
  });

  it("answerDialog(accept)：发 handleJavaScriptDialog、清挂起、取消兜底定时器、hook 带 by", async () => {
    const h = makeTab();
    await ready(h);
    open(h, { type: "confirm", message: "删除？" });
    const r = await h.tab.answerDialog(true, undefined, { by: "ai" });
    expect(r.handled).toBe(true);
    expect(h.handled().map((s) => s.params)).toEqual([{ accept: true }]);
    expect(h.tab.pendingDialog).toBeNull();
    expect(h.clock.pending()).toBe(0);
    expect(h.hooks.onDialog).toHaveBeenCalledWith(expect.objectContaining({ type: "confirm", handled: "已确定", by: "ai" }));
  });

  it("dismiss；prompt 确定带 promptText，缺省用页面默认值", async () => {
    const h = makeTab();
    await ready(h);
    open(h, { type: "confirm", message: "?" });
    await h.tab.answerDialog(false);
    expect(h.handled()[0].params).toEqual({ accept: false });
    open(h, { type: "prompt", message: "名字？", defaultPrompt: "小明" });
    await h.tab.answerDialog(true, "小红");
    expect(h.handled()[1].params).toEqual({ accept: true, promptText: "小红" });
    open(h, { type: "prompt", message: "名字？", defaultPrompt: "小明" });
    await h.tab.answerDialog(true);
    expect(h.handled()[2].params).toEqual({ accept: true, promptText: "小明" });
    open(h, { type: "prompt", message: "名字？", defaultPrompt: "小明" });
    await h.tab.answerDialog(false, "不该带上");
    expect(h.handled()[3].params).toEqual({ accept: false });
  });

  it("没有挂起的对话框：handled:false，不发任何 CDP", async () => {
    const h = makeTab();
    await ready(h);
    expect(await h.tab.answerDialog(true)).toEqual({ handled: false, dialog: null });
    expect(h.handled()).toHaveLength(0);
  });

  it("OOPIF 子会话里的对话框：处置命令发回同一个 sessionId", async () => {
    const h = makeTab();
    await ready(h);
    open(h, { type: "alert", message: "x" }, "child-1");
    await h.tab.answerDialog(true);
    expect(h.handled()[0].sessionId).toBe("child-1");
  });

  it("CDP 处置失败：挂起状态仍被清掉（不残留僵尸），返回 handled:false 并带错误", async () => {
    const h = makeTab({ failMethods: { "Page.handleJavaScriptDialog": "No dialog is showing" } });
    await ready(h);
    open(h, { type: "alert", message: "x" });
    const r = await h.tab.answerDialog(true);
    expect(r.handled).toBe(false);
    expect(r.error).toContain("No dialog is showing");
    expect(h.tab.pendingDialog).toBeNull();
  });

  it("Page.javascriptDialogClosed（页面导航 / 被别处关掉）清挂起；其它 session 的 Closed 不误清", async () => {
    const h = makeTab();
    await ready(h);
    open(h, { type: "alert", message: "x" });
    h.emit("Page.javascriptDialogClosed", { result: true }, "other-session");
    expect(h.tab.pendingDialog).not.toBeNull();
    h.emit("Page.javascriptDialogClosed", { result: true });
    expect(h.tab.pendingDialog).toBeNull();
    expect(h.clock.pending()).toBe(0);
  });

  it("新对话框顶替旧的：旧的定时器作废，只剩一个定时器", async () => {
    const h = makeTab();
    await ready(h);
    open(h, { type: "alert", message: "第一个" });
    open(h, { type: "confirm", message: "第二个" });
    expect(h.tab.pendingDialog!.message).toBe("第二个");
    expect(h.clock.pending()).toBe(1);
  });

  it("onDialogOpened 返回的取消函数有效；destroy 清定时器与监听", async () => {
    const h = makeTab();
    await ready(h);
    const seen: unknown[] = [];
    const off = h.tab.onDialogOpened((d: unknown) => seen.push(d));
    off();
    open(h, { type: "alert", message: "x" });
    expect(seen).toHaveLength(0);
    h.tab.destroy();
    expect(h.clock.pending()).toBe(0);
    expect(h.tab.pendingDialog).toBeNull();
  });
});

describe("BrowserTab：超时兜底（假计时器）", () => {
  it("alert 超过 20 秒无人处理 → 自动确定 + hook 写明「20 秒内无人处理」", async () => {
    const h = makeTab();
    await ready(h);
    open(h, { type: "alert", message: "你好" });
    await h.clock.advance(DIALOG_HOLD_MS - 1);
    expect(h.handled()).toHaveLength(0);
    expect(h.tab.pendingDialog).not.toBeNull();
    await h.clock.advance(1);
    expect(h.handled().map((s) => s.params)).toEqual([{ accept: true }]);
    expect(h.tab.pendingDialog).toBeNull();
    const evt = h.hooks.onDialog.mock.calls.at(-1)![0];
    expect(evt).toMatchObject({ type: "alert", by: "auto" });
    expect(evt.handled).toContain("20 秒内无人处理");
    expect(evt.handled).toContain("自动确定");
  });

  it("confirm 超时 → 自动取消；beforeunload 超时 → 自动确定", async () => {
    const h = makeTab();
    await ready(h);
    open(h, { type: "confirm", message: "?" });
    await h.clock.advance(DIALOG_HOLD_MS);
    expect(h.handled()[0].params).toEqual({ accept: false });
    open(h, { type: "beforeunload", message: "" });
    await h.clock.advance(DIALOG_HOLD_MS);
    expect(h.handled()[1].params).toEqual({ accept: true });
  });

  it("期间已被处理：到点不会再处置第二次", async () => {
    const h = makeTab();
    await ready(h);
    open(h, { type: "confirm", message: "?" });
    await h.tab.answerDialog(true, undefined, { by: "user" });
    await h.clock.advance(DIALOG_HOLD_MS * 2);
    expect(h.handled()).toHaveLength(1);
  });

  it("期间被新对话框顶替：旧对话框的定时器不会误处置新的", async () => {
    const h = makeTab();
    await ready(h);
    open(h, { type: "alert", message: "旧" });
    await h.clock.advance(10_000);
    open(h, { type: "confirm", message: "新" });
    await h.clock.advance(10_000); // 旧的 20s 到点，但已作废
    expect(h.handled()).toHaveLength(0);
    await h.clock.advance(10_000); // 新的 20s 到点
    expect(h.handled().map((s) => s.params)).toEqual([{ accept: false }]);
  });
});

// ───────────────────────── BrowserTab：设备模拟 ─────────────────────────

describe("BrowserTab：设备 / 环境模拟状态与重放", () => {
  it("applyEmulation 叠加并只发变化的命令；info().emulation 是摘要", async () => {
    const h = makeTab();
    await ready(h);
    expect(h.tab.info(true).emulation).toBeNull();
    const r1 = await h.tab.applyEmulation({ device: "iPhone 15" });
    expect(r1.emulation).toBe("iPhone 15");
    expect(h.sent.map((s) => s.method)).toEqual(["Emulation.setDeviceMetricsOverride", "Emulation.setTouchEmulationEnabled", "Emulation.setUserAgentOverride"]);
    h.sent.length = 0;
    const r2 = await h.tab.applyEmulation({ colorScheme: "dark" });
    expect(r2.emulation).toBe("iPhone 15 · 暗色");
    expect(h.sent.map((s) => s.method)).toEqual(["Emulation.setEmulatedMedia"]);
    expect(h.tab.info(true).emulation).toBe("iPhone 15 · 暗色");
    expect(h.hooks.onChange).toHaveBeenCalled();
  });

  it("主会话命令不带 sessionId（OOPIF 子会话不处理）", async () => {
    const h = makeTab();
    await ready(h);
    await h.tab.applyEmulation({ offline: true });
    expect(h.sent.every((s) => s.sessionId === null)).toBe(true);
  });

  it("resetEmulation 发 clear 命令并回到 null；已经没有模拟时什么都不发", async () => {
    const h = makeTab();
    await ready(h);
    expect(await h.tab.resetEmulation()).toEqual({ emulation: null });
    expect(h.sent).toHaveLength(0);
    await h.tab.applyEmulation({ device: "Pixel 8", offline: true });
    h.sent.length = 0;
    const r = await h.tab.resetEmulation();
    expect(r.emulation).toBeNull();
    expect(h.sent.map((s) => s.method)).toEqual(
      expect.arrayContaining(["Emulation.clearDeviceMetricsOverride", "Emulation.setUserAgentOverride", "Network.emulateNetworkConditions"]),
    );
    expect(h.tab.info(true).emulation).toBeNull();
  });

  it("debugger 断开后重连（ensureCdp）按存下的状态重放", async () => {
    const h = makeTab();
    await ready(h);
    await h.tab.applyEmulation({ device: "iPhone 15", colorScheme: "dark" });
    h.sent.length = 0;
    h.detach();
    await h.tab.ensureCdp();
    const replayed = h.sent.map((s) => s.method);
    expect(replayed).toEqual(expect.arrayContaining(["Emulation.setDeviceMetricsOverride", "Emulation.setUserAgentOverride", "Emulation.setEmulatedMedia"]));
    // 重放发生在主会话初始化之后
    expect(replayed.indexOf("Page.enable")).toBeLessThan(replayed.indexOf("Emulation.setDeviceMetricsOverride"));
  });

  it("个别命令失败（评审 R1-24）：其它项照样发（汇总失败原因），但状态回滚到原样并撤回已套上的部分——不留「状态说生效了、页面里只套一半」的错位", async () => {
    const h = makeTab({ failMethods: { "Emulation.setGeolocationOverride": "boom" } });
    await ready(h);
    await h.tab.applyEmulation({ offline: true }); // 先有一个成功的前态
    const prev = h.tab.emulation;
    h.sent.length = 0;
    const changes = vi.fn();
    h.hooks.onChange.mockImplementation(changes);
    await expect(h.tab.applyEmulation({ geolocation: { latitude: 1, longitude: 2 }, colorScheme: "dark" })).rejects.toThrowError(/setGeolocationOverride.*boom|已恢复原状/s);
    const methods = h.sent.map((s) => s.method);
    // 第一轮：其它项照样发
    expect(methods).toContain("Emulation.setEmulatedMedia");
    // 状态回滚：完全等于失败前（没有 colorScheme / geolocation），且 offline 保留
    expect(h.tab.emulation).toEqual(prev);
    expect(h.tab.emulation).not.toHaveProperty("colorScheme");
    expect(h.tab.info(true).emulation).toBe(describeEmulation(prev));
    // 撤回：已套上的 colorScheme 被清掉（setEmulatedMedia 至少发了两次：设 dark + 撤回）
    expect(methods.filter((m) => m === "Emulation.setEmulatedMedia").length).toBeGreaterThanOrEqual(2);
    // 面板被通知刷新
    expect(changes).toHaveBeenCalled();
  });

  it("时区 already in effect：先清再设重试一次", async () => {
    const h = makeTab();
    await ready(h);
    let first = true;
    (h.tab.wc.debugger.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(async (method: string, params: Record<string, unknown>) => {
      h.sent.push({ method, params, sessionId: null });
      if (method === "Emulation.setTimezoneOverride" && params.timezoneId === "Asia/Tokyo" && first) {
        first = false;
        throw new Error("Timezone override is already in effect");
      }
      return {};
    });
    await h.tab.applyEmulation({ timezone: "Asia/Tokyo" });
    const tz = h.sent.filter((s) => s.method === "Emulation.setTimezoneOverride").map((s) => s.params.timezoneId);
    expect(tz).toEqual(["Asia/Tokyo", "", "Asia/Tokyo"]);
  });

  // 评审 R2-09：applyEmulation 失败回滚写的是「this.emulation = prev」，并发的 reset 若已写入新状态会被它覆盖
  it("并发 emulate（失败回滚）与 reset 串行执行：最终状态是 reset 后的空状态，reset 的命令排在 emulate 的回滚命令之后", async () => {
    const h = makeTab();
    await ready(h);
    await h.tab.applyEmulation({ offline: true }); // 前态：有一项模拟，reset 才不是空操作
    h.sent.length = 0;
    const sendCommand = h.tab.wc.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const base = sendCommand.getMockImplementation()! as (m: string, p: Record<string, unknown>, sid?: string) => Promise<unknown>;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    sendCommand.mockImplementation(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      if (method === "Emulation.setGeolocationOverride") {
        h.sent.push({ method, params, sessionId: sessionId ?? null });
        await gate; // 卡住：此时 emulate 还没结束，状态已先写成 next
        throw new Error("boom");
      }
      return base(method, params, sessionId);
    });

    const emulate = h.tab.applyEmulation({ geolocation: { latitude: 1, longitude: 2 }, colorScheme: "dark" });
    const emulateSettled = emulate.then(
      () => "ok",
      () => "rejected",
    );
    const reset = h.tab.resetEmulation();
    // 让两个调用都有机会推进到被卡住的位置：reset 不应该在 emulate 结束前发出任何命令
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.sent.map((s) => s.method)).not.toContain("Network.emulateNetworkConditions");
    release();
    expect(await emulateSettled).toBe("rejected");
    expect(await reset).toEqual({ emulation: null });

    expect(h.tab.emulation).toEqual({}); // 没被 emulate 的「this.emulation = prev」覆盖回 { offline: true }
    expect(h.tab.info(true).emulation).toBeNull();
    const methods = h.sent.map((s) => s.method);
    const lastUndo = methods.lastIndexOf("Emulation.setEmulatedMedia"); // emulate 的撤回
    const resetCmd = methods.indexOf("Network.emulateNetworkConditions"); // reset 清掉 offline
    expect(lastUndo).toBeGreaterThanOrEqual(0);
    expect(resetCmd).toBeGreaterThan(lastUndo);
  });

  it("串行队列不被失败毒死：前一个 emulate 失败，后面的 emulate 照常执行并成功", async () => {
    const h = makeTab({ failMethods: { "Emulation.setGeolocationOverride": "boom" } });
    await ready(h);
    await expect(h.tab.applyEmulation({ geolocation: { latitude: 1, longitude: 2 } })).rejects.toThrowError(/已恢复原状/);
    const r = await h.tab.applyEmulation({ colorScheme: "dark" });
    expect(r.emulation).toBe("暗色");
  });
});

// ───────────────────────── BrowserSession：runAction 与对话框竞速 ─────────────────────────

class FakeTab {
  ready = Promise.resolve();
  url = "https://example.com/page";
  title = "示例页";
  pendingDialog: Record<string, unknown> | null = null;
  listeners = new Set<(d: Record<string, unknown>) => void>();
  emulation: Record<string, unknown> = {};
  destroy = vi.fn();
  setInputIgnored = vi.fn(async () => {});
  overlaySetActive = vi.fn(async () => {});
  overlayHide = vi.fn(async () => {});
  moveToMain = vi.fn();
  moveToParking = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
  navigate = vi.fn(async () => ({ url: this.url, title: this.title, status: 200 }));
  constructor(public id: string) {}
  onDialogOpened(fn: (d: Record<string, unknown>) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  popDialog(info: Record<string, unknown> = { type: "confirm", message: "确定？", url: "https://example.com/page", since: 1 }) {
    this.pendingDialog = info;
    for (const l of [...this.listeners]) l(info);
  }
  info(isActive: boolean) {
    return { id: this.id, url: this.url, title: this.title, favicon: null, loading: false, canGoBack: false, canGoForward: false, isActive };
  }
}

const makeSession = () => {
  const clock = makeClock();
  const activityLog = createActivityLog();
  const created: FakeTab[] = [];
  const host = {
    createTab: ({ id }: { id: string }) => {
      const t = new FakeTab(id);
      created.push(t);
      return t;
    },
    getMainWindow: () => null,
    getParkingWindow: () => ({}),
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: vi.fn(),
  };
  const session = new BrowserSession({
    taskId: "task1",
    host: host as never,
    activityLog,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn as never,
    clearTimeoutFn: clock.clearTimeoutFn as never,
  });
  return { session, clock, activityLog, created, host };
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("BrowserSession.runAction：与对话框竞速", () => {
  it("动作被对话框阻塞：对话框先到 → 动作带 dialog 字段提前结束；原 promise 之后自然收尾、无未处理异常", async () => {
    const { session, created, activityLog } = makeSession();
    await session.openTab({});
    const tab = created[0];
    let finishBody: (v: string) => void = () => {};
    let bodyFinished = false;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const p = session.runAction({ op: "click", tabId: "t1" }, async (ctx: object) => {
      (ctx as { describe: (d: object) => void }).describe({ kind: "click", summary: "点击了按钮「删除」", label: "点击 删除" });
      const v = await new Promise<string>((resolve) => {
        finishBody = resolve;
      });
      bodyFinished = true;
      return v;
    });
    await flush();
    tab.popDialog();
    const res = (await p) as Record<string, unknown>;
    expect(res).toMatchObject({ tabId: "t1", navigated: false, dialog: { type: "confirm", message: "确定？" } });
    expect(bodyFinished).toBe(false);
    // AI 动作照常写活动日志
    expect(activityLog.list().some((e: { actor: string; summary: string }) => e.actor === "ai" && e.summary.includes("删除"))).toBe(true);
    // 对话框被处理后原动作自然结束
    finishBody("late");
    await flush();
    expect(bodyFinished).toBe(true);
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(tab.listeners.size).toBe(0); // 竞速订阅已取消
  });

  it("原 promise 提前返回后才抛错：被吞掉，不产生未处理 rejection", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let failBody: (e: Error) => void = () => {};
    const p = session.runAction({ op: "click", tabId: "t1" }, () => new Promise((_, reject) => (failBody = reject)));
    await flush();
    created[0].popDialog();
    await p;
    failBody(new Error("Input.dispatchMouseEvent 超时"));
    await flush();
    await new Promise((r) => setTimeout(r, 5));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("动作自己先完成：结果原样返回；若此刻有挂起的对话框就补上 dialog", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    const plain = (await session.runAction({ op: "click", tabId: "t1" }, async () => ({ tabId: "t1", navigated: false }))) as Record<string, unknown>;
    expect(plain).toEqual({ tabId: "t1", navigated: false });
    const withPending = (await session.runAction({ op: "scroll", tabId: "t1", allowPendingDialog: true }, async () => {
      created[0].pendingDialog = { type: "alert", message: "刚弹的", url: "u", since: 1 };
      return { tabId: "t1", navigated: false };
    })) as Record<string, unknown>;
    expect(withPending.dialog).toMatchObject({ type: "alert", message: "刚弹的" });
  });

  it("动作自己抛错：错误照常传出（不被竞速吞掉）", async () => {
    const { session } = makeSession();
    await session.openTab({});
    await expect(session.runAction({ op: "click", tabId: "t1" }, async () => Promise.reject(new Error("boom")))).rejects.toThrowError("boom");
  });

  it("开始前就有挂起的对话框：不执行 fn，直接带 dialog + notExecuted 返回", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    created[0].pendingDialog = { type: "confirm", message: "先处理我", url: "u", since: 1 };
    const fn = vi.fn(async () => ({ ok: true }));
    const res = (await session.runAction({ op: "click", tabId: "t1" }, fn)) as Record<string, unknown>;
    expect(fn).not.toHaveBeenCalled();
    expect(res).toMatchObject({ tabId: "t1", navigated: false, notExecuted: true, dialog: { message: "先处理我" } });
    expect(session.controller).toBe("idle"); // 没执行就不进 ai 状态
  });

  it("allowPendingDialog:true 的 op 照常执行", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    created[0].pendingDialog = { type: "confirm", message: "x", url: "u", since: 1 };
    const fn = vi.fn(async () => ({ ok: true }));
    await session.runAction({ op: "emulate", tabId: "t1", allowPendingDialog: true, raceDialog: false }, fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("needsTab:false 的动作（tabs 管理）不参与对话框竞速", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    created[0].pendingDialog = { type: "confirm", message: "x", url: "u", since: 1 };
    const fn = vi.fn(async () => ({ tabs: [] }));
    const res = await session.runAction({ op: "tabs", needsTab: false }, fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(res).toEqual({ tabs: [] });
  });

  it("竞速提前返回的动作，其原 promise 还没收尾时：下一个动作排队等它（有上限）", async () => {
    const { session, created, clock } = makeSession();
    await session.openTab({});
    let finishBody: () => void = () => {};
    const order: string[] = [];
    const p1 = session.runAction({ op: "click", tabId: "t1" }, async () => {
      await new Promise<void>((r) => (finishBody = r));
      order.push("first-tail");
    });
    await flush();
    created[0].popDialog();
    await p1;
    created[0].pendingDialog = null;
    const p2 = session.runAction({ op: "click", tabId: "t1" }, async () => {
      order.push("second");
      return { tabId: "t1" };
    });
    await flush();
    expect(order).toEqual([]); // 第二个还在排队
    finishBody();
    await p2;
    expect(order).toEqual(["first-tail", "second"]);
    void clock;
  });

  it("原 promise 迟迟不收尾：队列最多等 8 秒，不会永远卡住", async () => {
    const { session, created, clock } = makeSession();
    await session.openTab({});
    const p1 = session.runAction({ op: "click", tabId: "t1" }, () => new Promise(() => {}));
    await flush();
    created[0].popDialog();
    await p1;
    created[0].pendingDialog = null;
    let ran = false;
    const p2 = session.runAction({ op: "click", tabId: "t1" }, async () => {
      ran = true;
      return { tabId: "t1" };
    });
    await flush();
    expect(ran).toBe(false);
    await clock.advance(8_000);
    await p2;
    expect(ran).toBe(true);
  });

  it("getState().dialog 跟着激活 tab 的挂起对话框走", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    expect(session.getState().dialog).toBeNull();
    created[0].pendingDialog = { type: "alert", message: "hi", url: "u", since: 5 };
    expect(session.getState().dialog).toEqual({ type: "alert", message: "hi", url: "u", since: 5 });
  });

  it("onDialog 钩子写活动日志：auto / user 记 system 条目，ai 不重复记", async () => {
    // 钩子是 session 在 createTab 时交给 tab 的：用一个会把 hooks 抓出来的 host
    let hooks: { onDialog: (i: object) => void } | null = null;
    const clock = makeClock();
    const activityLog = createActivityLog();
    const session = new BrowserSession({
      taskId: "t",
      host: {
        createTab: ({ id, hooks: h }: { id: string; hooks: { onDialog: (i: object) => void } }) => {
          hooks = h;
          return new FakeTab(id);
        },
        getMainWindow: () => null,
        getParkingWindow: () => ({}),
        onChange: vi.fn(),
        emitEvent: vi.fn(),
        emitPicked: vi.fn(),
        startPicker: vi.fn(),
      } as never,
      activityLog,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn as never,
      clearTimeoutFn: clock.clearTimeoutFn as never,
    });
    await session.openTab({});
    hooks!.onDialog({ type: "confirm", message: "删除？", handled: "20 秒内无人处理，已自动取消", by: "auto" });
    hooks!.onDialog({ type: "alert", message: "用户点的", handled: "已确定", by: "user" });
    hooks!.onDialog({ type: "alert", message: "AI 点的", handled: "已确定", by: "ai" });
    const entries = activityLog.list().filter((e: { kind: string }) => e.kind === "dialog");
    expect(entries).toHaveLength(2);
    expect(entries[0].summary).toContain("20 秒内无人处理，已自动取消");
    expect(entries[1].summary).toContain("用户已确定");
    expect(entries.every((e: { actor: string }) => e.actor === "system")).toBe(true);
  });
});

// ───────────────────────── ops/page-env：dialog / emulate 处理器 ─────────────────────────

const makeHandlers = () => {
  const { session, created, activityLog } = makeSession();
  const scheduleState = vi.fn();
  const handlers = createHandlers({
    requireSession: () => session,
    scheduleState,
  } as never);
  return { session, created, activityLog, handlers, scheduleState };
};

describe("ops/page-env handlers", () => {
  it("dialog status：无 / 有挂起；返回副本", async () => {
    const { session, created, handlers } = makeHandlers();
    await session.openTab({});
    expect(await handlers.dialog("task1", { action: "status" })).toEqual({ pending: null });
    created[0].pendingDialog = { type: "confirm", message: "x", url: "u", since: 1 };
    const r = (await handlers.dialog("task1", { action: "status" })) as { pending: Record<string, unknown> };
    expect(r.pending).toEqual({ type: "confirm", message: "x", url: "u", since: 1 });
    expect(r.pending).not.toBe(created[0].pendingDialog);
  });

  it("用户接管期间 AI 不能处理对话框（评审 R1-28）：accept / dismiss 抛 USER_CONTROL 且不转调 answerDialog；status 仍可读；交还后恢复", async () => {
    const { session, created, handlers } = makeHandlers();
    await session.openTab({});
    const tab = created[0] as unknown as { answerDialog: unknown; pendingDialog: unknown };
    const answer = vi.fn(async () => ({ handled: true, dialog: { type: "confirm", message: "删？", url: "u", since: 1 } }));
    tab.answerDialog = answer;
    tab.pendingDialog = { type: "confirm", message: "删？", url: "u", since: 1 };
    session.takeover();
    expect(session.controller).toBe("user");
    await expect(handlers.dialog("task1", { action: "accept" })).rejects.toMatchObject({ code: "USER_CONTROL" });
    await expect(handlers.dialog("task1", { action: "dismiss" })).rejects.toMatchObject({ code: "USER_CONTROL" });
    expect(answer).not.toHaveBeenCalled();
    // 只读 status 不受限：AI 仍能看到「页面卡在一个对话框上」，从而知道该 ask_user_to_act
    const st = (await handlers.dialog("task1", { action: "status" })) as { pending: unknown };
    expect(st.pending).toMatchObject({ type: "confirm" });
    // 用户交还后恢复
    session.handback();
    const r = await handlers.dialog("task1", { action: "accept" });
    expect(answer).toHaveBeenCalledWith(true, undefined, { by: "ai" });
    expect(r).toMatchObject({ handled: true });
  });

  it("dialog accept / dismiss：转调 tab.answerDialog，写 actor:ai 的日志（文字截断）", async () => {
    const { session, created, handlers, activityLog, scheduleState } = makeHandlers();
    await session.openTab({});
    const tab = created[0] as unknown as { answerDialog: unknown; pendingDialog: unknown };
    const answer = vi.fn(async () => ({ handled: true, dialog: { type: "confirm", message: "删".repeat(200), url: "u", since: 1 } }));
    tab.answerDialog = answer;
    await handlers.dialog("task1", { action: "dismiss", promptText: "忽略" });
    expect(answer).toHaveBeenCalledWith(false, "忽略", { by: "ai" });
    const e = activityLog.list().find((x: { kind: string }) => x.kind === "dialog");
    expect(e).toMatchObject({ actor: "ai" });
    expect(e.summary).toContain("取消了页面的确认框");
    expect(e.summary.length).toBeLessThan(160);
    expect(scheduleState).toHaveBeenCalled();
  });

  it("dialog accept 但没有挂起：handled:false，不写日志", async () => {
    const { session, created, handlers, activityLog } = makeHandlers();
    await session.openTab({});
    (created[0] as unknown as { answerDialog: unknown }).answerDialog = async () => ({ handled: false, dialog: null });
    expect(await handlers.dialog("task1", { action: "accept" })).toEqual({ pending: null, handled: false });
    expect(activityLog.list().filter((x: { kind: string }) => x.kind === "dialog")).toHaveLength(0);
  });

  it("emulate：走 runAction、叠加、写 ai 日志（摘要）、返回 applied + emulation", async () => {
    const { session, created, handlers, activityLog } = makeHandlers();
    await session.openTab({});
    const tab = created[0] as unknown as { applyEmulation: unknown; emulation: Record<string, unknown> };
    tab.applyEmulation = vi.fn(async (patch: Record<string, unknown>) => {
      tab.emulation = { ...tab.emulation, ...patch };
      return { emulation: "iPhone 15 · 暗色" };
    });
    const r = (await handlers.emulate("task1", { device: "iPhone 15", colorScheme: "dark" })) as Record<string, unknown>;
    expect(tab.applyEmulation).toHaveBeenCalledWith({ device: "iPhone 15", colorScheme: "dark" });
    expect(r).toMatchObject({ tabId: "t1", emulation: "iPhone 15 · 暗色" });
    expect((r.applied as string[]).join("|")).toContain("设备 iPhone 15");
    const log = activityLog.list().find((x: { actor: string }) => x.actor === "ai");
    expect(log.summary).toContain("设备模拟");
    expect(log.summary).toContain("iPhone 15 · 暗色");
  });

  it("emulate 在用户接管时被拒（动作类，遵守 §6）", async () => {
    const { session, handlers } = makeHandlers();
    await session.openTab({});
    session.takeover();
    await expect(handlers.emulate("task1", { colorScheme: "dark" })).rejects.toMatchObject({ code: "USER_CONTROL" });
  });

  it("emulate reset：摘要写「重置了设备模拟」", async () => {
    const { session, created, handlers, activityLog } = makeHandlers();
    await session.openTab({});
    const tab = created[0] as unknown as { applyEmulation: unknown; emulation: Record<string, unknown> };
    tab.emulation = { colorScheme: "dark" };
    tab.applyEmulation = vi.fn(async () => ({ emulation: null }));
    const r = (await handlers.emulate("task1", { reset: true })) as Record<string, unknown>;
    expect(r).toMatchObject({ emulation: null, applied: ["已重置全部模拟"] });
    expect(activityLog.list().find((x: { actor: string }) => x.actor === "ai").summary).toBe("重置了设备模拟");
  });
});
