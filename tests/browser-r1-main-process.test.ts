/**
 * 评审 R1 主进程基础设施这一批的回归测试（docs/REVIEW-browser-automation.md「R1」）：
 *  - R1-04 录制器 binding 令牌桶        - R1-06 favicon 白名单（主进程侧 + 纯函数）
 *  - R1-08 标签页上限 / 页面开标签限流    - R1-09 页面 window.close() / wc 被销毁
 *  - R1-10 下载放行策略（手势 / 大小 / 并发 / 频率 / cancel）
 *  - R1-13 setCovered 竞态              - R1-14 主窗口整页导航收回视图
 *  - R1-21 CDP 初始化一次性失败恢复      - R1-32 partition 配置失败可重试 / 设备权限默认拒绝
 * 真 Electron 里的对应行为见 scripts/browser-e2e/r1-lifecycle.cjs。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import {
  BLOCK_REPORT_INTERVAL_MS,
  createBlockThrottle,
  createDownloadWindow,
  decideDownload,
  DOWNLOAD_WINDOW_MS,
  exceedsSizeCap,
  MAX_ACTIVE_DOWNLOADS,
  MAX_DOWNLOAD_BYTES,
  MAX_DOWNLOADS_PER_WINDOW,
  MAX_PAUSED_DOWNLOADS,
} from "../electron-app/browser/download-policy.mjs";
import { createBrowserManager } from "../electron-app/browser/index.mjs";
import { FULLPAGE_SHOT_MAX_BYTES } from "../electron-app/browser/output-caps.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";
import {
  BrowserSession,
  MAX_TABS,
  PAGE_TAB_GESTURE_GRACE_MS,
  PAGE_TAB_GESTURE_MS,
  PAGE_TAB_MAX_PER_WINDOW,
  PAGE_TAB_WINDOW_MS,
} from "../electron-app/browser/session.mjs";
import { BROWSER_NAV_DOWNLOAD_MAX_MS, BROWSER_NAV_DOWNLOAD_MS, BROWSER_USER_NAV_DOWNLOAD_MS, BrowserTab } from "../electron-app/browser/tab.mjs";
import { isNonPublicHostname, isSafeFaviconUrl } from "../electron-app/browser/url-policy.mjs";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
};

// ───────────────────────── BrowserTab 夹具：会登记事件的 wc ─────────────────────────

class FakeWc extends EventEmitter {
  destroyedFlag = false;
  attached = false;
  attachCalls = 0;
  attachFail: (n: number) => boolean = () => false;
  messageHandler: (e: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void = () => {};
  private guard() {
    if (this.destroyedFlag) throw new TypeError("Object has been destroyed");
  }
  isDestroyed = () => this.destroyedFlag;
  setWindowOpenHandler = vi.fn();
  setAudioMuted = vi.fn();
  loadURL = vi.fn(async () => {});
  close = vi.fn();
  getZoomLevel = () => 0;
  getURL = () => {
    this.guard();
    return "https://example.com/page";
  };
  getTitle = () => {
    this.guard();
    return "示例页";
  };
  isLoading = () => {
    this.guard();
    return false;
  };
  get navigationHistory() {
    this.guard();
    return { canGoBack: () => false, canGoForward: () => false };
  }
  debugger = {
    isAttached: () => this.attached,
    attach: vi.fn(() => {
      this.attachCalls += 1;
      if (this.attachFail(this.attachCalls)) throw new Error("Another debugger is already attached");
      this.attached = true;
    }),
    detach: vi.fn(() => {
      this.attached = false;
    }),
    on: (ev: string, fn: never) => {
      if (ev === "message") this.messageHandler = fn;
    },
    sendCommand: vi.fn(async (method: string) => {
      this.guard();
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "s1" };
      return {};
    }),
  };
}

const makeTab = (opts: { attachFail?: (n: number) => boolean; isAppUrl?: (u: string) => boolean } = {}) => {
  const wc = new FakeWc();
  if (opts.attachFail) wc.attachFail = opts.attachFail;
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
    onGone: vi.fn(),
  };
  const clock = { t: 1_000_000 };
  const logs: string[] = [];
  const tab = new BrowserTab({
    id: "t1",
    WebContentsView: FakeView as never,
    parkingWindow: parking,
    pageScripts: { PAGE_WORLD_NAME: "flowship", RECORDER_BINDING: "__rec", buildPageScript: () => "//" } as never,
    isAppUrl: opts.isAppUrl ?? (() => false),
    hooks,
    log: (m: string) => logs.push(m),
    now: () => clock.t,
  });
  return { tab, wc, hooks, clock, logs, parking };
};

// ───────────────────────── R1-09：页面 window.close() / wc 被销毁 ─────────────────────────

describe("R1-09 BrowserTab：wc 被页面 / 引擎销毁", () => {
  it("destroyed 事件：tab 自行收尾（不再碰 debugger / wc.close）、通知 session 一次；之后读状态 / 发 CDP 都不抛、按「已关闭」处理", async () => {
    const { tab, wc, hooks, parking } = makeTab();
    await tab.ready;
    // 模拟真 Electron：wc 先被销毁（此后任何访问都抛 Object has been destroyed），然后才发 destroyed 事件
    wc.destroyedFlag = true;
    wc.emit("destroyed");
    expect(tab.destroyed).toBe(true);
    expect(hooks.onGone).toHaveBeenCalledTimes(1);
    expect(wc.close).not.toHaveBeenCalled();
    expect(wc.debugger.detach).not.toHaveBeenCalled();
    expect(parking.contentView.removeChildView).toHaveBeenCalledTimes(1); // 视图从父窗口摘掉
    // info() 不抛：这正是状态推送定时器里的崩溃点
    expect(() => tab.info(false)).not.toThrow();
    expect(tab.info(false)).toMatchObject({ url: "", title: "", loading: false, canGoBack: false, zoom: 100 });
    await expect(tab.send("Page.enable")).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
    await expect(tab.ensureCdp()).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
    // 重复事件 / 随后的 destroy() 都是幂等的
    wc.emit("destroyed");
    tab.destroy();
    expect(hooks.onGone).toHaveBeenCalledTimes(1);
  });

  it("读属性的瞬间才被销毁（isDestroyed() 仍为 false，访问却抛 Object has been destroyed）：info() 靠 try/catch 兜底也不抛", async () => {
    const { tab, wc } = makeTab();
    await tab.ready;
    wc.destroyedFlag = true;
    wc.isDestroyed = () => false; // 检查与访问之间的竞态：#wcGone() 看不出来
    expect(tab.destroyed).toBe(false);
    expect(() => tab.info(true)).not.toThrow();
    expect(tab.info(true)).toMatchObject({ canGoBack: false, canGoForward: false, zoom: 100, isActive: true });
  });

  it("wc 已销毁但 destroyed 事件还没到（窗口期）：info() / send() 也不抛", async () => {
    const { tab, wc } = makeTab();
    await tab.ready;
    wc.destroyedFlag = true; // 事件尚未触发，tab.destroyed 仍是 false
    expect(tab.destroyed).toBe(false);
    expect(() => tab.info(true)).not.toThrow();
    await expect(tab.send("Runtime.evaluate")).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
    await expect(tab.capturePlaceholder()).resolves.toBeNull();
  });

  it("我们自己 destroy()：先置 destroyed，随后的 destroyed 事件不会再回调 onGone（否则 session 会重复摘 tab）", async () => {
    const { tab, wc, hooks } = makeTab();
    await tab.ready;
    tab.destroy();
    expect(wc.close).toHaveBeenCalledTimes(1);
    wc.destroyedFlag = true;
    wc.emit("destroyed");
    expect(hooks.onGone).not.toHaveBeenCalled();
  });

  it("宿主窗口已销毁（app.exit() 连带销毁子视图）：onGone 带 hostGone=true；宿主还活着（页面自己 window.close()）为 false", async () => {
    // 真 Electron 探针：app.exit() 时先是窗口 closed（win.isDestroyed() 已为 true），约 16ms 后才是子视图 wc destroyed
    const dead = makeTab();
    await dead.tab.ready;
    (dead.parking as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;
    dead.wc.destroyedFlag = true;
    dead.wc.emit("destroyed");
    expect(dead.hooks.onGone).toHaveBeenCalledTimes(1);
    expect(dead.hooks.onGone).toHaveBeenCalledWith({ hostGone: true });

    const alive = makeTab();
    await alive.tab.ready;
    (alive.parking as unknown as { isDestroyed: () => boolean }).isDestroyed = () => false;
    alive.wc.destroyedFlag = true;
    alive.wc.emit("destroyed");
    expect(alive.hooks.onGone).toHaveBeenCalledWith({ hostGone: false });

    // 宿主窗口没有 isDestroyed（老夹具 / 极端对象）：按「页面自己关」处理，不误判成在退出
    const noApi = makeTab();
    await noApi.tab.ready;
    noApi.wc.destroyedFlag = true;
    noApi.wc.emit("destroyed");
    expect(noApi.hooks.onGone).toHaveBeenCalledWith({ hostGone: false });
  });

  it("问宿主窗口 isDestroyed() 自己就抛（窗口对象已不可用）：按 hostGone=true 处理，且不向外抛", async () => {
    const { tab, wc, hooks, parking } = makeTab();
    await tab.ready;
    (parking as unknown as { isDestroyed: () => boolean }).isDestroyed = () => {
      throw new Error("Object has been destroyed");
    };
    wc.destroyedFlag = true;
    expect(() => wc.emit("destroyed")).not.toThrow();
    expect(hooks.onGone).toHaveBeenCalledWith({ hostGone: true });
  });

  it("onGone 回调自己抛错也被吞（它跑在 wc 事件里，抛出就是主进程 uncaughtException）", async () => {
    const { tab, wc, hooks, logs } = makeTab();
    await tab.ready;
    hooks.onGone.mockImplementation(() => {
      throw new Error("boom");
    });
    wc.destroyedFlag = true;
    expect(() => wc.emit("destroyed")).not.toThrow();
    expect(logs.some((l) => l.includes("onGone 处理失败"))).toBe(true);
  });
});

// ───────────────────────── R1-21：CDP 初始化一次性失败恢复 ─────────────────────────

describe("R1-21 BrowserTab：初始化失败只重试一次，之后给可操作的指引", () => {
  it("首次 attach 失败（ready 被拒）→ ensureCdp 重试一次并恢复；之后正常、不再重试", async () => {
    const { tab, wc } = makeTab({ attachFail: (n) => n === 1 });
    await expect(tab.ready).rejects.toThrow(/debugger/);
    expect(wc.attachCalls).toBe(1);
    await expect(tab.ensureCdp()).resolves.toBeUndefined();
    expect(wc.attachCalls).toBe(2);
    expect(tab.cdpReady).toBe(true);
    await tab.ensureCdp(); // ready 已被替换成已解决的 promise
    expect(wc.attachCalls).toBe(2);
  });

  it("重试仍失败：抛 INTERNAL 并告诉 AI 关掉重开；后续调用直接复用这条错误、不再重试（不无限重连）", async () => {
    const { tab, wc } = makeTab({ attachFail: () => true });
    await expect(tab.ready).rejects.toThrow();
    const err1 = await tab.ensureCdp().catch((e) => e);
    expect(err1).toBeInstanceOf(BrowserError);
    expect(err1).toMatchObject({ code: "INTERNAL" });
    expect(String(err1.message)).toMatch(/browser_tabs close/);
    expect(wc.attachCalls).toBe(2); // 初始化 1 次 + 重试 1 次
    const err2 = await tab.ensureCdp().catch((e) => e);
    expect(err2.message).toBe(err1.message);
    expect(wc.attachCalls).toBe(2);
  });

  it("并发调用共用同一次重试", async () => {
    const { tab, wc } = makeTab({ attachFail: (n) => n === 1 });
    await expect(tab.ready).rejects.toThrow();
    await Promise.all([tab.ensureCdp(), tab.ensureCdp(), tab.ensureCdp()]);
    expect(wc.attachCalls).toBe(2);
  });
});

// ───────────────────────── R1-04：录制器 binding 令牌桶 ─────────────────────────

describe("R1-04 BrowserTab：录制器 binding 限速", () => {
  const call = (h: ReturnType<typeof makeTab>, n: number, name = "__rec") => {
    for (let i = 0; i < n; i++) {
      h.wc.messageHandler(null, "Runtime.bindingCalled", { name, payload: JSON.stringify({ type: "click", ts: i }) }, "");
    }
  };

  it("瞬时灌 100 条只放行桶容量（40）；过 1 秒补 20 条；错误的 binding 名一律忽略", async () => {
    const h = makeTab();
    await h.tab.ready;
    call(h, 100);
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(40);
    h.hooks.onRecorder.mockClear();
    h.clock.t += 1000;
    call(h, 100);
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(20);
    h.hooks.onRecorder.mockClear();
    h.clock.t += 60_000; // 久不动不会无限攒：封顶容量
    call(h, 100);
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(40);
    h.hooks.onRecorder.mockClear();
    call(h, 5, "__other");
    expect(h.hooks.onRecorder).not.toHaveBeenCalled();
  });

  it("正常使用（每秒几条）不受影响", async () => {
    const h = makeTab();
    await h.tab.ready;
    for (let s = 0; s < 30; s++) {
      h.clock.t += 1000;
      call(h, 5);
    }
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(150);
  });

  // R3-04：令牌桶按「会话 + 执行上下文」分账——一个敌对 frame 灌满自己的桶，不挤掉别的 frame 的真实事件
  const callIn = (h: ReturnType<typeof makeTab>, n: number, executionContextId: number, sessionId = "") => {
    for (let i = 0; i < n; i++) {
      h.wc.messageHandler(null, "Runtime.bindingCalled", { name: "__rec", executionContextId, payload: JSON.stringify({ type: "click", ts: i }) }, sessionId);
    }
  };

  it("按执行上下文分桶：frame A 把桶灌满后，frame B / 子会话的事件照常放行", async () => {
    const h = makeTab();
    await h.tab.ready;
    callIn(h, 200, 11); // 敌对 frame：只放过 40
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(40);
    h.hooks.onRecorder.mockClear();
    callIn(h, 3, 12); // 另一个 frame
    callIn(h, 3, 11, "child-1"); // OOPIF 子会话里的同号上下文也是另一个桶
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(6);
    h.hooks.onRecorder.mockClear();
    callIn(h, 5, 11); // A 仍然是空的
    expect(h.hooks.onRecorder).not.toHaveBeenCalled();
  });

  it("桶表有上限（并列时淘汰最早建的）；上下文销毁 / 清空时对应的桶被摘掉，导航再多也不会把桶表占满", async () => {
    const h = makeTab();
    await h.tab.ready;
    const buckets = () => (h.tab as unknown as { bindingBuckets: Map<string, unknown> }).bindingBuckets;
    for (let id = 1; id <= 100; id++) callIn(h, 1, id);
    expect(buckets().size).toBeLessThanOrEqual(32);
    h.wc.messageHandler(null, "Runtime.executionContextDestroyed", { executionContextId: 100 }, "");
    expect(buckets().has("main:100")).toBe(false);
    callIn(h, 1, 7, "child-2");
    expect(buckets().has("child-2:7")).toBe(true);
    h.wc.messageHandler(null, "Runtime.executionContextsCleared", {}, "child-2");
    expect([...buckets().keys()].some((k) => k.startsWith("child-2:"))).toBe(false);
    // 所有桶令牌数并列时，淘汰的是最早建的：它下次是满的（只会更宽松，不会饿死真实事件）
    h.hooks.onRecorder.mockClear();
    callIn(h, 40, 1);
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(40);
  });

  // R4-03：旧版淘汰「最早建的」桶 + 新桶初始是满的 → 33+ 个同源 iframe 轮流发事件，每个桶复用前都被挤掉，永不限速；且没有 tab 级总速率上限
  it("R4-03 淘汰最闲的桶：被灌空的桶不会因为新 frame 出现而被淘汰成满桶（旧版 FIFO 会）", async () => {
    const h = makeTab();
    await h.tab.ready;
    const buckets = () => (h.tab as unknown as { bindingBuckets: Map<string, unknown> }).bindingBuckets;
    callIn(h, 200, 1); // frame 1（最早建）被灌空：只放过 40
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(40);
    for (let id = 2; id <= 32; id++) callIn(h, 1, id); // 凑满 32 个桶
    expect(buckets().size).toBe(32);
    for (let id = 33; id <= 60; id++) callIn(h, 1, id); // 再来 28 个新 frame：每次要淘汰一个
    expect(buckets().size).toBeLessThanOrEqual(32);
    expect(buckets().has("main:1")).toBe(true); // 灌空的桶还在（被淘汰的是别的、更闲的桶）
    h.hooks.onRecorder.mockClear();
    callIn(h, 5, 1);
    expect(h.hooks.onRecorder).not.toHaveBeenCalled(); // 它仍然是空的——没有被「淘汰成满桶」绕过限速
  });

  it("R4-03 淘汰按「补完令牌后」的量比较，不是桶里记录的原始令牌数：闲了很久的空桶补满后才是最闲的", async () => {
    const h = makeTab();
    await h.tab.ready;
    const buckets = () => (h.tab as unknown as { bindingBuckets: Map<string, unknown> }).bindingBuckets;
    callIn(h, 200, 1); // t0：frame 1 被灌空（记录的原始令牌 0）
    h.clock.t += 10_000; // 10 秒后：frame 1 补满（20/s × 10s ≥ 40）；总桶也补满
    for (let id = 2; id <= 32; id++) callIn(h, 1, id); // 31 个桶各用掉 1 个（原始令牌 39）
    expect(buckets().size).toBe(32);
    callIn(h, 1, 33); // 第 33 个：要淘汰一个——补完后 frame 1 是 40、其余 39，最闲的是 frame 1
    expect(buckets().has("main:1")).toBe(false);
    expect(buckets().has("main:2")).toBe(true); // 若按原始令牌比，会淘汰 frame 2（第一个 39）而留下原始为 0 的 frame 1
    h.hooks.onRecorder.mockClear();
    callIn(h, 40, 2); // frame 2 没被淘汰，还是 39：40 次里只放过 39
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(39);
  });

  it("R4-03 复审原攻击：40 个 frame（> 32 个桶）轮流灌水——旧版每次访问都 miss、永远拿到满桶（2000 条全放行），现在被总桶封顶", async () => {
    const h = makeTab();
    await h.tab.ready;
    for (let round = 0; round < 10; round++) {
      for (let id = 1; id <= 40; id++) callIn(h, 5, id); // 同一时刻（时钟不动），每个 frame 每轮 5 条，共 2000 次尝试
    }
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(200); // = 总桶容量；旧版是 2000
  });

  it("R4-03 tab 级总桶：多个 frame 同时满速灌，总放行量不超过总桶（200 + 每秒 100），而不是 32 × 40", async () => {
    const h = makeTab();
    await h.tab.ready;
    for (let id = 1; id <= 10; id++) callIn(h, 40, id); // 10 个 frame 各 40 次尝试 = 400 次，每个 frame 自己的桶都够
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(200);
    h.hooks.onRecorder.mockClear();
    h.clock.t += 1000; // 总桶补 100；每个 frame 桶补 20（10 × 20 = 200 > 100）
    for (let id = 1; id <= 10; id++) callIn(h, 40, id);
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(100);
    h.hooks.onRecorder.mockClear();
    h.clock.t += 60_000; // 久不动：总桶封顶 200，不会无限攒
    for (let id = 1; id <= 10; id++) callIn(h, 40, id);
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(200);
  });

  it("R4-03 单个敌对 frame 灌不满总桶：它自己的桶先挡住，别的 frame 的真实事件照常放行（R3-04 的公平性仍成立）", async () => {
    const h = makeTab();
    await h.tab.ready;
    callIn(h, 100_000, 11);
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(40);
    h.hooks.onRecorder.mockClear();
    for (let id = 1; id <= 3; id++) callIn(h, 5, id); // 3 个正常 frame 各 5 条
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(15);
  });

  it("R4-03 正常使用（每秒十几条、单 frame）不受总桶影响", async () => {
    const h = makeTab();
    await h.tab.ready;
    for (let sec = 0; sec < 60; sec++) {
      h.clock.t += 1000;
      callIn(h, 15, 1);
    }
    expect(h.hooks.onRecorder).toHaveBeenCalledTimes(900);
  });
});

// ───────────────────────── R1-06：favicon ─────────────────────────

describe("R1-06 favicon 白名单", () => {
  it("isSafeFaviconUrl：只认公网 https 与位图 data URL", () => {
    const ok = [
      "https://example.com/favicon.ico",
      "https://cdn.example.co.uk/a/b.png?v=1",
      "https://[2606:4700::1111]/f.ico",
      "data:image/png;base64,AAAA",
      "data:image/x-icon;base64,AAAA",
      "data:image/jpeg,xx",
    ];
    for (const u of ok) expect(isSafeFaviconUrl(u), u).toBe(true);
    const bad = [
      "http://example.com/favicon.ico", // 非 https
      "https://127.0.0.1:8876/api/repo-branches", // 回环 + 应用端口
      "https://localhost/f.ico",
      "https://foo.localhost/f.ico",
      "https://10.1.2.3/f.ico",
      "https://172.16.0.9/f.ico",
      "https://192.168.1.1/f.ico",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/f.ico",
      "https://0.0.0.0/f.ico",
      "https://[::1]/f.ico",
      "https://[fd00::1]/f.ico",
      "https://[fe80::1]/f.ico",
      "https://[::ffff:7f00:1]/f.ico",
      "https://router/f.ico", // 单标签内网短名
      "https://nas.local/f.ico",
      "https://corp.internal/f.ico",
      "https://user:pw@example.com/f.ico", // userinfo
      "data:image/svg+xml;base64,AAAA", // svg 可带脚本
      "data:text/html,<script>1</script>",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://example.com/f.ico",
      "//example.com/f.ico",
      "not a url",
      "",
      `data:image/png;base64,${"A".repeat(20_000)}`, // 过长
    ];
    for (const u of bad) expect(isSafeFaviconUrl(u), u).toBe(false);
    expect(isSafeFaviconUrl(undefined)).toBe(false);
    expect(isSafeFaviconUrl(42 as never)).toBe(false);
  });

  it("isAppUrl 命中也拒（应用自己的地址即使是 https 公网写法）", () => {
    const isAppUrl = (u: string) => u.startsWith("https://app.example.com/");
    expect(isSafeFaviconUrl("https://app.example.com/x.ico", { isAppUrl })).toBe(false);
    expect(isSafeFaviconUrl("https://other.example.com/x.ico", { isAppUrl })).toBe(true);
  });

  it("isNonPublicHostname 的边界", () => {
    for (const h of ["127.0.0.1", "10.0.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "100.127.0.1", "224.0.0.1", "localhost", "a.b.local", "intranet", "[::1]", "[fc00::1]", "[fe80::1]", "[::ffff:a00:1]"]) {
      expect(isNonPublicHostname(h), h).toBe(true);
    }
    for (const h of ["172.15.0.1", "172.32.0.1", "100.63.0.1", "8.8.8.8", "example.com", "a.b.c.example.org", "[2001:4860:4860::8888]"]) {
      expect(isNonPublicHostname(h), h).toBe(false);
    }
  });

  it("BrowserTab 的 page-favicon-updated：跳过不安全的候选，取第一个安全的；全不安全则为 null", async () => {
    const { tab, wc } = makeTab({ isAppUrl: (u) => u.includes("app.example.com") });
    await tab.ready;
    wc.emit("page-favicon-updated", {}, ["http://127.0.0.1:8876/api/x", "https://10.0.0.1/f.ico", "https://app.example.com/f.ico", "https://cdn.example.com/f.png"]);
    expect(tab.favicon).toBe("https://cdn.example.com/f.png");
    wc.emit("page-favicon-updated", {}, ["http://127.0.0.1:8876/api/x", "data:image/svg+xml,<svg/>"]);
    expect(tab.favicon).toBeNull();
    wc.emit("page-favicon-updated", {}, "not-an-array");
    expect(tab.favicon).toBeNull();
  });
});

// ───────────────────────── BrowserSession 夹具 ─────────────────────────

class SessTab {
  ready: Promise<void> = Promise.resolve();
  opener: string | null = null;
  /** 页面发起新窗口时 session 问「opener 最近有没有真实手势」（R2-06）：默认有，旧用例保持「前台新标签立刻激活」的语义 */
  gesture = true;
  gestureWindows: number[] = [];
  hadRecentGesture = (withinMs: number) => {
    this.gestureWindows.push(withinMs);
    return this.gesture;
  };
  lastUrl = "";
  url = "https://example.com/page";
  title = "示例页";
  destroyedFlag = false;
  navigate = vi.fn(async () => ({ url: this.url, title: this.title, status: 200 }));
  destroy = vi.fn(() => {
    this.destroyedFlag = true;
  });
  setInputIgnored = vi.fn(async () => {});
  overlaySetActive = vi.fn(async () => {});
  overlayHide = vi.fn(async () => {});
  moveToMain = vi.fn();
  moveToParking = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
  capturePlaceholder: () => Promise<string | null> = vi.fn(async () => "data:image/jpeg;base64,FAKE");
  constructor(public id: string) {}
  info(isActive: boolean) {
    return { id: this.id, url: this.url, title: this.title, favicon: null, loading: false, canGoBack: false, canGoForward: false, isActive };
  }
}

const makeSession = () => {
  const clock = { t: 1_000 };
  type SessHooks = { onNewTab: (i: Record<string, unknown>) => void; onGone: (info?: { hostGone: boolean }) => void };
  const hooksOf: Record<string, SessHooks> = {};
  const created: SessTab[] = [];
  const mainWin = { name: "main" };
  const parkingWin = { name: "parking" };
  const host = {
    createTab: ({ id, hooks }: { id: string; hooks: SessHooks }) => {
      hooksOf[id] = hooks;
      const t = new SessTab(id);
      created.push(t);
      return t;
    },
    getMainWindow: () => mainWin,
    getParkingWindow: vi.fn(() => parkingWin),
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: vi.fn(),
  };
  const activityLog = createActivityLog();
  const session = new BrowserSession({
    taskId: "task1",
    host: host as never,
    activityLog,
    now: () => clock.t,
  });
  return { session, clock, hooksOf, created, activityLog, host };
};

// ───────────────────────── R1-08：标签页上限 / 页面开标签限流 ─────────────────────────

describe("R1-08 BrowserSession：标签页上限与页面发起新标签限流", () => {
  it("MAX_TABS=20：第 21 个 openTab 抛 BAD_ARGS（带指引）；关掉一个后又能开", async () => {
    const { session } = makeSession();
    expect(MAX_TABS).toBe(20);
    for (let i = 0; i < MAX_TABS; i++) await session.openTab({});
    expect(session.tabs).toHaveLength(MAX_TABS);
    const err = await session.openTab({}).catch((e) => e);
    expect(err).toBeInstanceOf(BrowserError);
    expect(err).toMatchObject({ code: "BAD_ARGS" });
    expect(String(err.message)).toMatch(/上限.*20.*browser_tabs close/s);
    expect(session.tabs).toHaveLength(MAX_TABS);
    await session.closeTab("t1");
    await expect(session.openTab({})).resolves.toBeDefined();
  });

  it("页面发起的新标签：窗口内最多 3 个，超出直接丢弃；窗口过后恢复；用户发起（byUser）不限", async () => {
    const { session, hooksOf, clock } = makeSession();
    await session.openTab({}); // t1
    expect(PAGE_TAB_MAX_PER_WINDOW).toBe(3);
    const page = () => hooksOf.t1.onNewTab({ url: "https://a.test/x", disposition: "foreground-tab", openerTabId: "t1" });
    for (let i = 0; i < 10; i++) page();
    await flush();
    expect(session.tabs).toHaveLength(1 + 3);
    // 用户右键「在新标签页打开」不受页面限流
    hooksOf.t1.onNewTab({ url: "https://b.test/y", disposition: "foreground-tab", openerTabId: "t1", byUser: true });
    await flush();
    expect(session.tabs).toHaveLength(1 + 3 + 1);
    // 窗口过后恢复
    clock.t += PAGE_TAB_WINDOW_MS + 1;
    page();
    await flush();
    expect(session.tabs).toHaveLength(1 + 3 + 1 + 1);
  });

  it("被限流丢弃的页面请求不累加窗口：刷屏页面不能把窗口一直续下去", async () => {
    const { session, hooksOf, clock } = makeSession();
    await session.openTab({});
    const page = () => hooksOf.t1.onNewTab({ url: "https://a.test/x", disposition: "foreground-tab", openerTabId: "t1" });
    for (let i = 0; i < 3; i++) page(); // 放行 3 个，占满窗口
    await flush();
    const n = session.tabs.length;
    clock.t += PAGE_TAB_WINDOW_MS - 1;
    for (let i = 0; i < 50; i++) page(); // 窗口快到期时刷屏：全部丢弃
    await flush();
    expect(session.tabs).toHaveLength(n);
    clock.t += 2; // 最早那 3 个到期 → 恢复（若刷屏也计数就永远恢复不了）
    page();
    await flush();
    expect(session.tabs).toHaveLength(n + 1);
  });

  it("页面发起的新标签：opener 是当前激活 tab 才抢占激活；后台 tab 里的脚本开的不抢焦点", async () => {
    const { session, hooksOf } = makeSession();
    await session.openTab({}); // t1
    await session.openTab({}); // t2（激活）
    expect(session.activeTabId).toBe("t2");
    hooksOf.t1.onNewTab({ url: "https://a.test/bg", disposition: "foreground-tab", openerTabId: "t1" }); // 后台 tab 开的
    await flush();
    expect(session.tabs).toHaveLength(3);
    expect(session.activeTabId).toBe("t2"); // 没抢
    hooksOf.t2.onNewTab({ url: "https://a.test/fg", disposition: "foreground-tab", openerTabId: "t2" }); // 激活 tab 开的
    await flush();
    expect(session.tabs).toHaveLength(4);
    expect(session.activeTabId).toBe("t4"); // 前台新标签
  });
});

// ───────────────────────── R2-06：页面发起的新标签（前台抢焦点 / 配额分桶 / handler fail-open / openTab 重试） ─────────────────────────

describe("R2-06 BrowserSession：页面发起新标签的激活门槛（真实手势）、配额按 opener 分桶、限流留线索", () => {
  const open = (hooksOf: Record<string, { onNewTab: (i: Record<string, unknown>) => void }>, from: string, url = "https://a.test/x") =>
    hooksOf[from].onNewTab({ url, disposition: "foreground-tab", openerTabId: from });

  it("前台 tab 无手势（没人点击就自己 window.open）：不抢占激活，宽限期（150ms）后在后台开；PAGE_TAB_GESTURE_MS 是 5 秒", async () => {
    vi.useFakeTimers();
    try {
      const { session, hooksOf, created } = makeSession();
      await session.openTab({}); // t1，激活
      created[0].gesture = false;
      expect(PAGE_TAB_GESTURE_MS).toBe(5000);
      open(hooksOf, "t1");
      expect(session.tabs).toHaveLength(1); // 宽限期内还没开（要等手势事件可能晚到）
      await vi.advanceTimersByTimeAsync(PAGE_TAB_GESTURE_GRACE_MS + 1);
      expect(session.tabs).toHaveLength(2);
      expect(session.activeTabId).toBe("t1"); // 没抢
      expect(created[0].gestureWindows.every((w) => w === PAGE_TAB_GESTURE_MS)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("手势事件晚到（binding 与 window.open 不同通道，可能乱序）：宽限期内到达 → 仍抢占激活（用户点链接不能被当成无手势）", async () => {
    vi.useFakeTimers();
    try {
      const { session, hooksOf, created } = makeSession();
      await session.openTab({});
      created[0].gesture = false;
      open(hooksOf, "t1");
      await vi.advanceTimersByTimeAsync(50);
      created[0].gesture = true; // 点击事件到了
      await vi.advanceTimersByTimeAsync(PAGE_TAB_GESTURE_GRACE_MS);
      expect(session.tabs).toHaveLength(2);
      expect(session.activeTabId).toBe("t2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("有手势：立刻（不等宽限期）开成前台新标签", async () => {
    const { session, hooksOf } = makeSession();
    await session.openTab({});
    open(hooksOf, "t1");
    await flush();
    expect(session.tabs).toHaveLength(2);
    expect(session.activeTabId).toBe("t2");
  });

  it("宽限期内会话被销毁：不再开标签（定时器回调要认 destroyed）", async () => {
    vi.useFakeTimers();
    try {
      const { session, hooksOf, created } = makeSession();
      await session.openTab({});
      created[0].gesture = false;
      open(hooksOf, "t1");
      await session.destroy();
      await vi.advanceTimersByTimeAsync(PAGE_TAB_GESTURE_GRACE_MS + 1);
      expect(session.tabs).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("配额按 opener 分桶：后台 tab 刷满自己的配额，不耗前台 tab 的（用户点 target=_blank 不会被静默丢弃）", async () => {
    const { session, hooksOf } = makeSession();
    await session.openTab({}); // t1
    await session.openTab({}); // t2（激活）
    for (let i = 0; i < 10; i++) open(hooksOf, "t1"); // 后台 tab 刷屏
    await flush();
    expect(session.tabs).toHaveLength(2 + PAGE_TAB_MAX_PER_WINDOW); // t1 只放行 3 个
    open(hooksOf, "t2"); // 前台 tab 的第一个，不受影响
    await flush();
    expect(session.tabs).toHaveLength(2 + PAGE_TAB_MAX_PER_WINDOW + 1);
    expect(session.activeTabId).toBe(`t${2 + PAGE_TAB_MAX_PER_WINDOW + 1}`);
  });

  it("被限流丢弃：每个 opener 每个窗口写一条活动日志线索（AI 控制期也写，不被「AI 自己的 tab_open 静默」吞掉），窗口过后再丢再写", async () => {
    const { session, hooksOf, clock, activityLog } = makeSession();
    await session.openTab({});
    (session as unknown as { controller: string }).controller = "ai";
    const notes = () => activityLog.list().filter((x: { kind: string; summary?: string }) => x.kind === "tab_open" && /超出限额/.test(x.summary ?? ""));
    for (let i = 0; i < 12; i++) open(hooksOf, "t1", "https://spam.test/p?token=secret");
    await flush();
    expect(notes()).toHaveLength(1);
    expect(notes()[0].summary).toContain("spam.test");
    expect(notes()[0].summary).not.toContain("secret"); // 不带 query
    clock.t += PAGE_TAB_WINDOW_MS + 1;
    for (let i = 0; i < 12; i++) open(hooksOf, "t1");
    await flush();
    expect(notes()).toHaveLength(2);
  });

  it("用户发起（byUser）不走手势门槛也不受配额限制，且仍然立刻前台", async () => {
    const { session, hooksOf, created } = makeSession();
    await session.openTab({});
    created[0].gesture = false;
    for (let i = 0; i < 5; i++) hooksOf.t1.onNewTab({ url: "https://b.test/y", disposition: "foreground-tab", openerTabId: "t1", byUser: true });
    await flush();
    expect(session.tabs).toHaveLength(6);
  });

  it("openTab 带 url：初始化失败（ready 被拒）的 tab 也会走 navigate（由 navigate 内部 ensureCdp 重试），不再把 URL 静默吞掉", async () => {
    const { session, host, created } = makeSession();
    const failing = new SessTab("t1");
    const rejected = Promise.reject(new Error("init failed"));
    rejected.catch(() => {});
    failing.ready = rejected;
    (host as unknown as { createTab: unknown }).createTab = ({ id }: { id: string }) => {
      void id;
      created.push(failing);
      return failing;
    };
    await session.openTab({ url: "https://a.test/x", activate: false, byPage: true });
    await flush();
    expect(failing.navigate).toHaveBeenCalledWith("https://a.test/x");
  });
});

describe("R2-06 BrowserTab：真实手势记录与 window.open 处理器的 fail-closed", () => {
  const bind = (h: ReturnType<typeof makeTab>, evt: Record<string, unknown>) => {
    h.wc.messageHandler(null, "Runtime.bindingCalled", { name: "__rec", payload: JSON.stringify(evt) }, "");
  };

  it("hadRecentGesture：click / dblclick / contextmenu / key 算手势；scroll / focus / input / select / submit 不算；超过窗口失效", async () => {
    const h = makeTab();
    await h.tab.ready;
    expect(h.tab.hadRecentGesture(5000)).toBe(false); // 从未有过
    for (const type of ["scroll", "focus", "input", "select", "submit"]) {
      bind(h, { type });
      expect(h.tab.hadRecentGesture(5000), type).toBe(false);
    }
    for (const type of ["click", "dblclick", "contextmenu", "key"]) {
      h.clock.t += 100_000;
      expect(h.tab.hadRecentGesture(5000)).toBe(false);
      bind(h, { type });
      expect(h.tab.hadRecentGesture(5000), type).toBe(true);
    }
    h.clock.t += 5000;
    expect(h.tab.hadRecentGesture(5000)).toBe(true); // 边界：恰好 5000ms 仍算
    h.clock.t += 1;
    expect(h.tab.hadRecentGesture(5000)).toBe(false);
  });

  it("跨文档导航（did-navigate）后上一个页面里的手势作废：新页面的脚本不能借旧页面的点击 window.open（R1-10 真机：否则无手势 window.open(下载URL) 会被当成有手势）", async () => {
    const h = makeTab();
    await h.tab.ready;
    bind(h, { type: "click" });
    expect(h.tab.hadRecentGesture(5000)).toBe(true);
    h.wc.emit("did-navigate", {}, "https://example.com/next", 200);
    expect(h.tab.hadRecentGesture(5000)).toBe(false);
    // 导航之后的新手势照常算
    bind(h, { type: "click" });
    expect(h.tab.hadRecentGesture(5000)).toBe(true);
  });

  it("被令牌桶丢掉的 binding 不算手势（先限速、再记手势）", async () => {
    const h = makeTab();
    await h.tab.ready;
    for (let i = 0; i < 40; i++) bind(h, { type: "scroll" }); // 把桶耗尽
    bind(h, { type: "click" });
    expect(h.tab.hadRecentGesture(5000)).toBe(false);
  });

  it("window.open 处理器：onNewTab 抛错也返回 deny（不让 Electron 回落到默认放行开出不受管理的窗口），并记日志", async () => {
    const h = makeTab();
    await h.tab.ready;
    const handler = h.wc.setWindowOpenHandler.mock.calls[0][0] as (d: Record<string, unknown>) => { action: string };
    h.hooks.onNewTab.mockImplementation(() => {
      throw new Error("boom");
    });
    let verdict: { action: string } | undefined;
    expect(() => {
      verdict = handler({ url: "https://a.test/x", disposition: "foreground-tab" });
    }).not.toThrow();
    expect(verdict).toEqual({ action: "deny" });
    expect(h.logs.some((l) => l.includes("已拒绝") && l.includes("boom"))).toBe(true);
  });

  it("window.open 处理器：正常路径仍是 deny + 交给 session；被 URL 策略拦的不交给 session", async () => {
    const h = makeTab({ isAppUrl: (u) => u.includes("localhost:8876") });
    await h.tab.ready;
    const handler = h.wc.setWindowOpenHandler.mock.calls[0][0] as (d: Record<string, unknown>) => { action: string };
    expect(handler({ url: "https://a.test/x", disposition: "foreground-tab" })).toEqual({ action: "deny" });
    expect(h.hooks.onNewTab).toHaveBeenCalledTimes(1);
    expect(handler({ url: "http://localhost:8876/", disposition: "foreground-tab" })).toEqual({ action: "deny" });
    expect(h.hooks.onNewTab).toHaveBeenCalledTimes(1); // 没增加
  });
});

// ───────────────────────── R1-09（session 侧）：tab 被页面关掉 ─────────────────────────

describe("R1-09 BrowserSession：onGone 摘掉被页面关掉的 tab", () => {
  it("关掉的是激活 tab：邻居补位激活，写一条「页面关闭了标签页」，不对已销毁的 tab 再 destroy", async () => {
    const { session, hooksOf, created, activityLog } = makeSession();
    await session.openTab({}); // t1
    await session.openTab({}); // t2
    created[1].lastUrl = "https://example.com/closing?token=secret";
    hooksOf.t2.onGone();
    await flush();
    expect(session.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(session.activeTabId).toBe("t1");
    expect(created[1].destroy).not.toHaveBeenCalled();
    const e = activityLog.list().find((x: { kind: string }) => x.kind === "tab_close");
    expect(e?.summary).toMatch(/^页面关闭了标签页：example\.com\/closing/);
    expect(e?.summary).not.toContain("secret"); // 日志文案不带 query
  });

  it("AI 控制期（刚点完按钮）页面自己关 tab：「页面关闭了标签页」仍要记（它不是 AI 自己的动作，不受静默规则约束）", async () => {
    const { session, hooksOf, activityLog } = makeSession();
    await session.openTab({}); // t1
    await session.openTab({}); // t2
    (session as unknown as { controller: string }).controller = "ai";
    hooksOf.t2.onGone();
    await flush();
    const closed = activityLog.list().filter((x: { kind: string }) => x.kind === "tab_close");
    expect(closed).toHaveLength(1);
    expect(closed[0].summary).toMatch(/^页面关闭了标签页/);
  });

  it("对照：AI 自己 closeTab 时仍静默（不把 AI 自己的动作当成「发生了什么」）", async () => {
    const { session, activityLog } = makeSession();
    await session.openTab({}); // t1
    await session.openTab({}); // t2
    (session as unknown as { controller: string }).controller = "ai";
    await session.closeTab("t2");
    expect(activityLog.list().filter((x: { kind: string }) => x.kind === "tab_close")).toHaveLength(0);
  });

  it("关掉的是最后一个 tab：补一个空白页，会话始终有激活 tab", async () => {
    const { session, hooksOf } = makeSession();
    await session.openTab({}); // t1
    hooksOf.t1.onGone();
    await flush();
    expect(session.tabs).toHaveLength(1);
    expect(session.tabs[0].id).not.toBe("t1");
    expect(session.activeTabId).toBe(session.tabs[0].id);
  });

  it("宿主窗口已销毁（app.exit()）：只摘 tab——不补空白页、不新建任何视图 / 窗口、不写活动日志（退出中创建原生对象会 SIGTRAP）", async () => {
    const { session, hooksOf, created, activityLog, host } = makeSession();
    await session.openTab({}); // t1：唯一的 tab
    const createdBefore = created.length;
    const parkingCallsBefore = host.getParkingWindow.mock.calls.length;
    hooksOf.t1.onGone({ hostGone: true });
    await flush();
    expect(session.tabs).toEqual([]);
    expect(session.activeTabId).toBeNull();
    expect(created).toHaveLength(createdBefore); // 没有补空白页
    expect(host.getParkingWindow.mock.calls.length).toBe(parkingCallsBefore); // 没有碰（更没有重建）停车场窗口
    expect(created[0].destroy).not.toHaveBeenCalled();
    expect(activityLog.list().filter((x: { kind: string }) => x.kind === "tab_close")).toHaveLength(0);
  });

  it("对照：hostGone 缺省 / false 时仍补空白页（页面自己 window.close() 的路径不受影响）", async () => {
    const { session, hooksOf, created } = makeSession();
    await session.openTab({});
    const createdBefore = created.length;
    hooksOf.t1.onGone({ hostGone: false });
    await flush();
    expect(created.length).toBe(createdBefore + 1);
    expect(session.tabs).toHaveLength(1);
    expect(session.tabs[0].id).not.toBe("t1");
  });

  it("重复 / 已摘掉的 tab 的 onGone 是幂等的；会话已销毁时不报错", async () => {
    const { session, hooksOf } = makeSession();
    await session.openTab({});
    await session.openTab({});
    hooksOf.t2.onGone();
    hooksOf.t2.onGone();
    await flush();
    expect(session.tabs.map((t) => t.id)).toEqual(["t1"]);
    session.destroy();
    expect(() => hooksOf.t1.onGone()).not.toThrow();
  });
});

// ───────────────────────── R1-13：setCovered 竞态 ─────────────────────────

describe("R1-13 BrowserSession.setCovered：截图 await 期间被超越", () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const deferred = () => {
    let resolve!: (v: string | null) => void;
    const promise = new Promise<string | null>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it("true 在途时来了 false：慢的 true 落地后不能把视图藏起来（否则永久空白）", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    session.attach(bounds);
    const d = deferred();
    created[0].capturePlaceholder = vi.fn(() => d.promise);
    const pTrue = session.setCovered(true);
    await session.setCovered(false);
    expect(session.covered).toBe(false);
    created[0].setVisible.mockClear();
    d.resolve("data:image/jpeg;base64,LATE");
    await expect(pTrue).resolves.toBeNull();
    expect(session.covered).toBe(false);
    expect(created[0].setVisible).not.toHaveBeenCalledWith(false);
  });

  it("true 在途时面板卸载（detach）：落地后不能再置 covered / 藏视图（下次 attach 会是空白）", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    session.attach(bounds);
    const d = deferred();
    created[0].capturePlaceholder = vi.fn(() => d.promise);
    const pTrue = session.setCovered(true);
    session.detach();
    created[0].setVisible.mockClear();
    d.resolve("data:image/jpeg;base64,LATE");
    await expect(pTrue).resolves.toBeNull();
    expect(session.covered).toBe(false);
    expect(created[0].setVisible).not.toHaveBeenCalled();
    session.attach(bounds);
    expect(created[0].moveToMain).toHaveBeenLastCalledWith(expect.anything(), bounds, true); // 下次挂载可见
  });

  it("截图期间切了 tab：covered 仍生效（作用于当前激活 tab），但旧 tab 的截图不当占位图返回", async () => {
    const { session, created } = makeSession();
    await session.openTab({}); // t1
    session.attach(bounds);
    const d = deferred();
    created[0].capturePlaceholder = vi.fn(() => d.promise);
    const pTrue = session.setCovered(true);
    const t2 = await session.openTab({}); // 激活 t2
    d.resolve("data:image/jpeg;base64,OLD");
    await expect(pTrue).resolves.toBeNull();
    expect(session.covered).toBe(true);
    expect((t2 as unknown as SessTab).setVisible).toHaveBeenLastCalledWith(false);
  });

  it("两次连续 true：后一次接管，前一次作废（不重复藏、不返回过期图）", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    session.attach(bounds);
    const d1 = deferred();
    const d2 = deferred();
    created[0].capturePlaceholder = vi.fn().mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const p1 = session.setCovered(true);
    const p2 = session.setCovered(true);
    d2.resolve("data:image/jpeg;base64,NEW");
    d1.resolve("data:image/jpeg;base64,OLD");
    await expect(p2).resolves.toBe("data:image/jpeg;base64,NEW");
    await expect(p1).resolves.toBeNull();
    expect(session.covered).toBe(true);
  });

  it("attach() 不重置 covered（弹层还开着时重新挂载，视图必须仍然让位）——既有契约保持", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    session.attach(bounds);
    await session.setCovered(true);
    session.attach(bounds);
    expect(session.covered).toBe(true);
    expect(created[0].moveToMain).toHaveBeenLastCalledWith(expect.anything(), bounds, false);
  });
});

// ───────────────────────── manager 夹具（假 electron） ─────────────────────────

const makeManager = (opts: { sesExtra?: Record<string, unknown>; permissionThrowsOnce?: boolean } = {}) => {
  const views: Array<{ webContents: Record<string, unknown> }> = [];
  class FakeView {
    webContents: Record<string, unknown>;
    setBounds = vi.fn();
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
    constructor() {
      this.webContents = {
        on: vi.fn(),
        isDestroyed: () => false,
        setWindowOpenHandler: vi.fn(),
        setAudioMuted: vi.fn(),
        loadURL: vi.fn(async () => {}),
        getURL: () => "about:blank",
        getTitle: () => "",
        isLoading: () => false,
        stop: vi.fn(),
        close: vi.fn(),
        capturePage: vi.fn(async () => ({ isEmpty: () => true })),
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        debugger: { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), on: vi.fn(), sendCommand: vi.fn(async () => ({})) },
      };
      views.push(this);
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
  });
  const windows: Array<ReturnType<typeof makeWin>> = [];
  class FakeWindow {
    constructor() {
      const w = makeWin();
      windows.push(w);
      return w as never;
    }
  }
  const mainWc = new EventEmitter() as EventEmitter & { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean; getZoomFactor: () => number };
  mainWc.send = vi.fn();
  mainWc.isDestroyed = () => false;
  mainWc.getZoomFactor = () => 1;
  const mainWin = { ...makeWin(), webContents: mainWc };
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipcMain = {
    handle: (n: string, f: never) => void handlers.set(n, f),
    on: vi.fn(),
    removeHandler: (n: string) => void handlers.delete(n),
    removeListener: vi.fn(),
  };
  const ses = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
    ...(opts.sesExtra ?? {}),
  };
  if (opts.permissionThrowsOnce) ses.setPermissionRequestHandler.mockImplementationOnce(() => {
    throw new Error("setPermissionRequestHandler boom");
  });
  const manager = createBrowserManager({
    app: { getPath: () => "/tmp" },
    BrowserWindow: FakeWindow,
    WebContentsView: FakeView,
    session: { fromPartition: () => ses },
    ipcMain,
    getMainWindow: () => mainWin,
    isAppUrl: () => false,
    isTrustedIpcSender: () => true,
    log: () => {},
    startPicker: () => ({ cancel() {} }),
  } as never);
  return { manager, views, ses, mainWin, mainWc, handlers, windows };
};

// ───────────────────────── R1-10：下载放行策略 ─────────────────────────

describe("R1-33 BrowserSession.runAction：僵尸 fn 晚到的 describe 不能重新点亮覆盖层 / aiLabel", () => {
  type Ctx = { describe: (d: unknown) => void };
  const desc = (label: string) => ({ kind: "click", label, summary: label });

  it("对照：动作进行中 describe 照常点亮覆盖层并记 aiLabel", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    created[0].overlaySetActive.mockClear();
    await session.runAction({ op: "click" }, async (ctx: object) => {
      (ctx as Ctx).describe(desc("点击 登录"));
    });
    expect(created[0].overlaySetActive).toHaveBeenCalledWith(true, "点击 登录");
    expect(session.aiLabel).toBe("点击 登录");
  });

  it("被 takeover 打断的瞬间（fn 还没来得及收尾）：晚到的 describe 被 abort 守卫挡掉", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    let late!: () => void;
    const p = session.runAction({ op: "click" }, (ctx: object) => new Promise<void>((resolve) => {
      late = () => {
        (ctx as Ctx).describe(desc("僵尸：点击 X"));
        resolve();
      };
    }));
    await flush();
    created[0].overlaySetActive.mockClear();
    const before = session.aiLabel;
    session.takeover();
    late(); // 同步调用：此刻 runAction 的 finally 还没跑，只有 abort 信号能挡住
    await expect(p).rejects.toMatchObject({ code: "USER_TOOK_OVER" });
    await flush();
    expect(created[0].overlaySetActive).not.toHaveBeenCalledWith(true, expect.anything());
    expect(session.aiLabel).toBe(before);
  });

  it("runAction 已收尾之后（对话框竞速提前返回 / 任何迟到）：保留的 ctx 再 describe 无效", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    let held!: Ctx;
    await session.runAction({ op: "click" }, async (ctx: object) => {
      held = ctx as Ctx;
    });
    await flush();
    created[0].overlaySetActive.mockClear();
    const before = session.aiLabel;
    held.describe(desc("迟到：点击 Y"));
    await flush();
    expect(created[0].overlaySetActive).not.toHaveBeenCalled();
    expect(session.aiLabel).toBe(before);
  });
});

describe("R1-10 download-policy 纯函数", () => {
  const base = { hasUserGesture: true, totalBytes: 100, activeCount: 0, recentCount: 0 };
  it("放行：有手势 / 手势未知（老 Electron 无该 API）/ 大小未知（0）", () => {
    expect(decideDownload(base)).toEqual({ allow: true });
    expect(decideDownload({ ...base, hasUserGesture: undefined })).toEqual({ allow: true });
    expect(decideDownload({ ...base, totalBytes: 0 })).toEqual({ allow: true });
    expect(decideDownload({ ...base, totalBytes: MAX_DOWNLOAD_BYTES })).toEqual({ allow: true }); // 恰为上限放行
  });
  it("拦：无手势 / 超大 / 并发满 / 频率满，各带原因", () => {
    expect(decideDownload({ ...base, hasUserGesture: false })).toMatchObject({ allow: false, reason: expect.stringContaining("用户操作") });
    expect(decideDownload({ ...base, totalBytes: MAX_DOWNLOAD_BYTES + 1 })).toMatchObject({ allow: false, reason: expect.stringContaining("过大") });
    expect(decideDownload({ ...base, activeCount: MAX_ACTIVE_DOWNLOADS })).toMatchObject({ allow: false, reason: expect.stringContaining("同时") });
    expect(decideDownload({ ...base, recentCount: MAX_DOWNLOADS_PER_WINDOW })).toMatchObject({ allow: false, reason: expect.stringContaining("频繁") });
  });
  it("exceedsSizeCap：流式下载按已收字节兜底", () => {
    expect(exceedsSizeCap(MAX_DOWNLOAD_BYTES)).toBe(false);
    expect(exceedsSizeCap(MAX_DOWNLOAD_BYTES + 1)).toBe(true);
    expect(exceedsSizeCap(Number.NaN)).toBe(false);
  });
  it("createDownloadWindow：按 key 滑动窗口计数，过期淘汰", () => {
    let t = 0;
    const w = createDownloadWindow({ now: () => t });
    w.record("a");
    w.record("a");
    w.record("b");
    expect(w.count("a")).toBe(2);
    expect(w.count("b")).toBe(1);
    t += DOWNLOAD_WINDOW_MS - 1;
    expect(w.count("a")).toBe(2);
    t += 1;
    expect(w.count("a")).toBe(0);
  });
});

describe("R1-10 manager 的 will-download 处理", () => {
  let seq = 0;
  const makeItem = (o: { gesture?: boolean | undefined; total?: number; received?: () => number; saveThrows?: boolean; noGestureApi?: boolean } = {}) => {
    const item = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const name = `r1-dl-${process.pid}-${++seq}.bin`;
    Object.assign(item, {
      getFilename: () => name,
      getTotalBytes: () => o.total ?? 100,
      getReceivedBytes: o.received ?? (() => 0),
      getURL: () => "https://example.com/f.bin",
      setSavePath: vi.fn(() => {
        if (o.saveThrows) throw new Error("EACCES");
      }),
      cancel: vi.fn(),
    });
    if (!o.noGestureApi) item.hasUserGesture = () => ("gesture" in o ? o.gesture : true);
    return item as EventEmitter & { setSavePath: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } & Record<string, unknown>;
  };

  const setup = async () => {
    const h = makeManager();
    await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
    const wc = h.views[0].webContents;
    const willDownload = h.ses.on.mock.calls.find((c) => c[0] === "will-download")![1] as (e: unknown, item: unknown, wc: unknown) => void;
    const fire = (item: unknown) => willDownload({ preventDefault: vi.fn() }, item, wc);
    const logs = () => h.manager.getSession("T1")!.activityLog.list().filter((e: { kind: string }) => e.kind === "download") as Array<{ summary: string }>;
    return { ...h, fire, logs };
  };

  it("无用户手势：cancel、不设保存路径（不弹原生另存为）、活动日志写「下载被拦截」", async () => {
    const { fire, logs, manager } = await setup();
    const item = makeItem({ gesture: false });
    fire(item);
    expect(item.cancel).toHaveBeenCalledTimes(1);
    expect(item.setSavePath).not.toHaveBeenCalled();
    expect(logs().map((e) => e.summary).join("|")).toMatch(/下载被拦截：r1-dl-.*用户操作/);
    manager.destroy();
  });

  it("有手势：正常设保存路径、记「开始下载」，不 cancel", async () => {
    const { fire, logs, manager } = await setup();
    const item = makeItem({ gesture: true });
    fire(item);
    expect(item.cancel).not.toHaveBeenCalled();
    expect(item.setSavePath).toHaveBeenCalledTimes(1);
    expect(String(item.setSavePath.mock.calls[0][0])).toMatch(/^\/tmp\/r1-dl-/);
    expect(logs().map((e) => e.summary).join("|")).toMatch(/开始下载/);
    manager.destroy();
  });

  it("手势 API 不存在（老 Electron）：放行，不能因此误杀所有下载", async () => {
    const { fire, manager } = await setup();
    const item = makeItem({ noGestureApi: true });
    fire(item);
    expect(item.cancel).not.toHaveBeenCalled();
    expect(item.setSavePath).toHaveBeenCalled();
    manager.destroy();
  });

  it("声明大小超过 2GB：cancel", async () => {
    const { fire, manager } = await setup();
    const item = makeItem({ total: MAX_DOWNLOAD_BYTES + 1 });
    fire(item);
    expect(item.cancel).toHaveBeenCalledTimes(1);
    expect(item.setSavePath).not.toHaveBeenCalled();
    manager.destroy();
  });

  it("setSavePath 抛错：必须 cancel（否则 Electron 弹原生保存框）", async () => {
    const { fire, manager } = await setup();
    const item = makeItem({ saveThrows: true });
    fire(item);
    expect(item.cancel).toHaveBeenCalledTimes(1);
    manager.destroy();
  });

  it("流式下载（声明大小 0）下载中超过上限：updated 里 cancel", async () => {
    const { fire, manager } = await setup();
    let received = 1000;
    const item = makeItem({ total: 0, received: () => received });
    fire(item);
    item.emit("updated");
    expect(item.cancel).not.toHaveBeenCalled();
    received = MAX_DOWNLOAD_BYTES + 1;
    item.emit("updated");
    expect(item.cancel).toHaveBeenCalledTimes(1);
    manager.destroy();
  });

  it(`并发上限：同时在途满 ${MAX_ACTIVE_DOWNLOADS} 个后第 ${MAX_ACTIVE_DOWNLOADS + 1} 个被拦；一个完成后又能开`, async () => {
    const { fire, manager } = await setup();
    const items = Array.from({ length: MAX_ACTIVE_DOWNLOADS }, () => makeItem());
    for (const it of items) fire(it);
    for (const it of items) expect(it.cancel).not.toHaveBeenCalled();
    const extra = makeItem();
    fire(extra);
    expect(extra.cancel).toHaveBeenCalledTimes(1);
    items[0].emit("done", {}, "completed");
    const again = makeItem();
    fire(again);
    expect(again.cancel).not.toHaveBeenCalled();
    manager.destroy();
  });

  it(`频率上限：一个窗口内新开 ${MAX_DOWNLOADS_PER_WINDOW} 个后再来的被拦（即使前面都已完成）`, async () => {
    const { fire, manager } = await setup();
    for (let i = 0; i < MAX_DOWNLOADS_PER_WINDOW; i++) {
      const it = makeItem();
      fire(it);
      expect(it.cancel).not.toHaveBeenCalled();
      it.emit("done", {}, "completed");
    }
    const extra = makeItem();
    fire(extra);
    expect(extra.cancel).toHaveBeenCalledTimes(1);
    manager.destroy();
  });
});

describe("R1-10 复审：browser-initiated 下载 / 拦截记录节流 / 在途计数泄漏", () => {
  it("decideDownload：无手势但 browserInitiated=true 放行；其余闸（大小 / 并发 / 频率）照常；省略 browserInitiated 等于 false", () => {
    const base = { hasUserGesture: false, totalBytes: 100, activeCount: 0, recentCount: 0 };
    expect(decideDownload(base)).toMatchObject({ allow: false });
    expect(decideDownload({ ...base, browserInitiated: false })).toMatchObject({ allow: false });
    expect(decideDownload({ ...base, browserInitiated: true })).toEqual({ allow: true });
    expect(decideDownload({ ...base, browserInitiated: true, totalBytes: MAX_DOWNLOAD_BYTES + 1 })).toMatchObject({ allow: false, reason: expect.stringContaining("过大") });
    expect(decideDownload({ ...base, browserInitiated: true, activeCount: MAX_ACTIVE_DOWNLOADS })).toMatchObject({ allow: false });
    expect(decideDownload({ ...base, browserInitiated: true, recentCount: MAX_DOWNLOADS_PER_WINDOW })).toMatchObject({ allow: false });
  });

  it("createBlockThrottle：间隔内只报告第一次，期间次数累计；到点再报告并带上被吞掉的次数；key 互相独立；drop 清状态", () => {
    let t = 0;
    const th = createBlockThrottle({ now: () => t });
    expect(th.hit("a")).toEqual({ report: true, suppressed: 0 });
    expect(th.hit("a")).toMatchObject({ report: false });
    expect(th.hit("a")).toMatchObject({ report: false });
    expect(th.hit("b")).toEqual({ report: true, suppressed: 0 });
    t += BLOCK_REPORT_INTERVAL_MS - 1;
    expect(th.hit("a")).toMatchObject({ report: false });
    t += 1;
    expect(th.hit("a")).toEqual({ report: true, suppressed: 3 });
    th.drop("a");
    expect(th.hit("a")).toEqual({ report: true, suppressed: 0 });
  });

  it("R3-07 decideDownload 带 code；navExpired 只换文案、不放行", () => {
    const base = { hasUserGesture: false, totalBytes: 100, activeCount: 0, recentCount: 0 };
    expect(decideDownload(base)).toMatchObject({ allow: false, code: "no-gesture" });
    const expired = decideDownload({ ...base, navExpired: true });
    expect(expired).toMatchObject({ allow: false, code: "nav-expired" });
    expect((expired as { reason: string }).reason).toMatch(/过期/);
    expect(decideDownload({ ...base, hasUserGesture: true, totalBytes: MAX_DOWNLOAD_BYTES + 1 })).toMatchObject({ code: "too-large" });
    expect(decideDownload({ ...base, hasUserGesture: true, activeCount: MAX_ACTIVE_DOWNLOADS })).toMatchObject({ code: "too-many-active" });
    expect(decideDownload({ ...base, hasUserGesture: true, recentCount: MAX_DOWNLOADS_PER_WINDOW })).toMatchObject({ code: "too-frequent" });
    // navExpired 不影响有手势 / 已命中令牌的放行
    expect(decideDownload({ ...base, hasUserGesture: true, navExpired: true })).toEqual({ allow: true });
    expect(decideDownload({ ...base, browserInitiated: true, navExpired: true })).toEqual({ allow: true });
  });

  it("R3-07 ② createBlockThrottle：被吞掉的计数到点由 onFlush 补记；drop(前缀) 先 flush 再清掉该会话所有「会话|原因」key，不动别的会话", () => {
    let t = 0;
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const flushed: Array<[string, number]> = [];
    const th = createBlockThrottle({
      now: () => t,
      onFlush: (k, n) => void flushed.push([k, n]),
      setTimer: (fn, ms) => {
        const rec = { fn, ms, live: true };
        timers.push(rec);
        return rec;
      },
      clearTimer: (h) => void ((h as { live: boolean }).live = false),
    });
    expect(th.hit("T1|no-gesture")).toEqual({ report: true, suppressed: 0 });
    t += 1000;
    th.hit("T1|no-gesture");
    th.hit("T1|no-gesture");
    expect(timers).toHaveLength(1); // 只起一个定时器
    expect(timers[0].ms).toBe(BLOCK_REPORT_INTERVAL_MS - 1000); // 到距上次报告满一个间隔的时刻
    t += BLOCK_REPORT_INTERVAL_MS;
    timers[0].fn();
    expect(flushed).toEqual([["T1|no-gesture", 2]]);
    // flush 之后计数清零、间隔重新计；下一次命中又在间隔内 → 再吞
    expect(th.hit("T1|no-gesture")).toMatchObject({ report: false, suppressed: 1 });

    // 会话销毁：先把未报告的计数交出去、再清；T10 不是 T1 的前缀匹配对象
    th.hit("T1|too-large");
    th.hit("T1|too-large");
    th.hit("T10|no-gesture");
    th.hit("T10|no-gesture");
    flushed.length = 0;
    th.drop("T1");
    expect(flushed.map(([k, n]) => `${k}:${n}`).sort()).toEqual(["T1|no-gesture:1", "T1|too-large:1"]);
    expect(th.hit("T1|too-large")).toEqual({ report: true, suppressed: 0 }); // 已清
    expect(th.hit("T10|no-gesture")).toMatchObject({ report: false }); // T10 没被误清
    // report 时清掉挂着的定时器
    t += BLOCK_REPORT_INTERVAL_MS * 10;
    const liveBefore = timers.filter((x) => x.live).length;
    th.hit("T10|no-gesture"); // 过了间隔 → report，应摘掉它挂着的定时器
    expect(timers.filter((x) => x.live).length).toBeLessThan(liveBefore);
  });

  describe("BrowserTab.consumeBrowserInitiatedDownload", () => {
    const URL1 = "https://example.com/file.bin?x=1";
    it("navigate 之后同 URL 的下载命中，且一次性（第二次不再命中）", async () => {
      const { tab } = makeTab();
      await tab.ready;
      await tab.navigate(URL1);
      expect(tab.consumeBrowserInitiatedDownload([URL1])).toBe(true);
      expect(tab.consumeBrowserInitiatedDownload([URL1])).toBe(false);
    });

    it("下载链首项才算（重定向后的 URL 不影响）；不同 URL 不命中、也不消费（真正的那个仍可命中）", async () => {
      const { tab } = makeTab();
      await tab.ready;
      await tab.navigate(URL1);
      expect(tab.consumeBrowserInitiatedDownload(["https://evil.example/other.bin"])).toBe(false);
      expect(tab.consumeBrowserInitiatedDownload([URL1, "https://cdn.example/real.bin"])).toBe(true);
    });

    it("没 navigate 过 / 空链 / 非数组：不命中", async () => {
      const { tab } = makeTab();
      await tab.ready;
      expect(tab.consumeBrowserInitiatedDownload([URL1])).toBe(false);
      await tab.navigate(URL1);
      expect(tab.consumeBrowserInitiatedDownload([])).toBe(false);
      expect(tab.consumeBrowserInitiatedDownload(undefined as never)).toBe(false);
    });

    it("超过令牌有效期失效；期间提交过别的导航（它是个普通页面）也失效", async () => {
      const a = makeTab();
      await a.tab.ready;
      await a.tab.navigate(URL1, { timeoutMs: 1000 }); // 超时短于下限：有效期取下限 BROWSER_NAV_DOWNLOAD_MS
      a.clock.t += BROWSER_NAV_DOWNLOAD_MS + 1;
      expect(a.tab.consumeBrowserInitiatedDownload([URL1])).toBe(false);

      const b = makeTab();
      await b.tab.ready;
      await b.tab.navigate(URL1);
      b.wc.emit("did-navigate", {}, "https://example.com/page", 200);
      expect(b.tab.consumeBrowserInitiatedDownload([URL1])).toBe(false);
    });

    it("navigate(url, { browserInitiated:false })（页面脚本无手势自己开的窗口）：不记录，下载照常过手势闸", async () => {
      const { tab } = makeTab();
      await tab.ready;
      await tab.navigate(URL1, { browserInitiated: false });
      expect(tab.consumeBrowserInitiatedDownload([URL1])).toBe(false);
    });

    it("被 URL 策略拒绝的 navigate（抛 URL_BLOCKED）不留下记录", async () => {
      const { tab } = makeTab({ isAppUrl: () => true });
      await tab.ready;
      await expect(tab.navigate(URL1)).rejects.toMatchObject({ code: "URL_BLOCKED" });
      expect(tab.consumeBrowserInitiatedDownload([URL1])).toBe(false);
    });

    it("R3-07 ① 有效期跟 navigate 的超时走：默认 30 秒内（生成报表的慢响应）仍命中，之后过期；超时设得再大也封顶 BROWSER_NAV_DOWNLOAD_MAX_MS", async () => {
      const a = makeTab();
      await a.tab.ready;
      await a.tab.navigate(URL1); // 默认超时 30 秒
      a.clock.t += 29_000;
      expect(a.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("hit");

      const b = makeTab();
      await b.tab.ready;
      await b.tab.navigate(URL1);
      b.clock.t += 31_000;
      expect(b.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("expired");

      const c = makeTab();
      await c.tab.ready;
      await c.tab.navigate(URL1, { timeoutMs: 10 * 60_000 });
      c.clock.t += BROWSER_NAV_DOWNLOAD_MAX_MS + 1;
      expect(c.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("expired");
      const d = makeTab();
      await d.tab.ready;
      await d.tab.navigate(URL1, { timeoutMs: 10 * 60_000 });
      d.clock.t += BROWSER_NAV_DOWNLOAD_MAX_MS;
      expect(d.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("hit");
    });

    it("R3-07 ① 有效期有下限：navigate 的超时设得很短（1 秒）也至少 BROWSER_NAV_DOWNLOAD_MS；用户导航（loadUrlByUser）30 秒", async () => {
      const a = makeTab();
      await a.tab.ready;
      await a.tab.navigate(URL1, { timeoutMs: 1000 });
      a.clock.t += BROWSER_NAV_DOWNLOAD_MS - 1000;
      expect(a.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("hit");
      const b = makeTab();
      await b.tab.ready;
      await b.tab.navigate(URL1, { timeoutMs: 1000 });
      b.clock.t += BROWSER_NAV_DOWNLOAD_MS + 1;
      expect(b.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("expired");

      // 用户导航：30 秒内命中、之后过期（常量本身钉死，免得被悄悄改小）
      expect(BROWSER_USER_NAV_DOWNLOAD_MS).toBe(30_000);
      const c = makeTab();
      await c.tab.ready;
      void c.tab.loadUrlByUser(URL1);
      c.clock.t += BROWSER_USER_NAV_DOWNLOAD_MS - 1000;
      expect(c.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("hit");
      const d = makeTab();
      await d.tab.ready;
      void d.tab.loadUrlByUser(URL1);
      d.clock.t += BROWSER_USER_NAV_DOWNLOAD_MS + 1;
      expect(d.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("expired");
    });

    it("R3-07 ① verdict：过期但 URL 对不上 → none（不把别的页面的下载说成「令牌过期」）；没记录 / 期间提交过别的导航 → none；过期令牌被清掉不重复报", async () => {
      const a = makeTab();
      await a.tab.ready;
      expect(a.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("none");
      await a.tab.navigate(URL1);
      a.clock.t += 60_000;
      expect(a.tab.consumeBrowserInitiatedDownloadVerdict(["https://evil.example/x.bin"])).toBe("none");
      expect(a.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("none"); // 上一次调用已把过期令牌清掉

      const b = makeTab();
      await b.tab.ready;
      await b.tab.navigate(URL1);
      b.clock.t += 60_000;
      expect(b.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("expired");
      expect(b.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("none");

      const c = makeTab();
      await c.tab.ready;
      await c.tab.navigate(URL1);
      c.wc.emit("did-navigate", {}, "https://example.com/page", 200);
      expect(c.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("none");
    });

    it("R3-07 ① 比较前两边都去掉 #fragment：navigate 带 hash、下载链不带（或反过来）都命中；query 不同仍不命中", async () => {
      const a = makeTab();
      await a.tab.ready;
      await a.tab.navigate("https://example.com/export.csv?id=1#section");
      expect(a.tab.consumeBrowserInitiatedDownload(["https://example.com/export.csv?id=1"])).toBe(true);
      const b = makeTab();
      await b.tab.ready;
      await b.tab.navigate("https://example.com/export.csv?id=1");
      expect(b.tab.consumeBrowserInitiatedDownload(["https://example.com/export.csv?id=1#x"])).toBe(true);
      const c = makeTab();
      await c.tab.ready;
      await c.tab.navigate("https://example.com/export.csv?id=1#x");
      expect(c.tab.consumeBrowserInitiatedDownload(["https://example.com/export.csv?id=2"])).toBe(false);
    });

    it("R1-10 复审 ① 用户导航：loadUrlByUser 调 wc.loadURL 并登记令牌（同 URL 的无手势下载命中，一次性）；有效期 BROWSER_USER_NAV_DOWNLOAD_MS", async () => {
      const a = makeTab();
      await a.tab.ready;
      await a.tab.loadUrlByUser(URL1);
      expect(a.wc.loadURL).toHaveBeenLastCalledWith(URL1);
      expect(a.tab.consumeBrowserInitiatedDownload([URL1])).toBe(true);
      expect(a.tab.consumeBrowserInitiatedDownload([URL1])).toBe(false);

      const b = makeTab();
      await b.tab.ready;
      await b.tab.loadUrlByUser(URL1);
      b.clock.t += BROWSER_USER_NAV_DOWNLOAD_MS;
      expect(b.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("hit");
      const c = makeTab();
      await c.tab.ready;
      await c.tab.loadUrlByUser(URL1);
      c.clock.t += BROWSER_USER_NAV_DOWNLOAD_MS + 1;
      expect(c.tab.consumeBrowserInitiatedDownloadVerdict([URL1])).toBe("expired");
    });

    // R4-04 ①：当前页是 https://example.com/page（FakeWc.getURL）
    it("R4-04 ① 用户只改 #hash（同文档导航）：不登记令牌（否则令牌 URL 等于当前页、空挂到 TTL）；仍然调 wc.loadURL", async () => {
      const CUR = "https://example.com/page";
      for (const target of [`${CUR}#section`, `${CUR}#`, `${CUR}#a/b?c=d`]) {
        const a = makeTab();
        await a.tab.ready;
        await a.tab.loadUrlByUser(target);
        expect(a.wc.loadURL, target).toHaveBeenLastCalledWith(target);
        expect(a.tab.consumeBrowserInitiatedDownloadVerdict([CUR]), target).toBe("none");
        expect(a.tab.consumeBrowserInitiatedDownloadVerdict([target]), target).toBe("none");
      }
    });

    it("R4-04 ① 对照：同 URL 无 fragment（重新加载，跨文档）、换路径带 hash、改 query 带 hash 仍然登记", async () => {
      const CUR = "https://example.com/page";
      const a = makeTab();
      await a.tab.ready;
      await a.tab.loadUrlByUser(CUR);
      expect(a.tab.consumeBrowserInitiatedDownload([CUR])).toBe(true);
      const b = makeTab();
      await b.tab.ready;
      await b.tab.loadUrlByUser("https://example.com/export.csv#x");
      expect(b.tab.consumeBrowserInitiatedDownload(["https://example.com/export.csv"])).toBe(true);
      const c = makeTab();
      await c.tab.ready;
      await c.tab.loadUrlByUser(`${CUR}?download=1#x`);
      expect(c.tab.consumeBrowserInitiatedDownload([`${CUR}?download=1`])).toBe(true);
      // 非法 URL 不抛（loadURL 自己会拒绝）
      const d = makeTab();
      await d.tab.ready;
      await expect(d.tab.loadUrlByUser("not a url#x")).resolves.toBeUndefined();
    });
  });

  describe("session.openTab 的 viaGesture：页面脚本无手势开的窗口不算「我们发起的」", () => {
    it("opener 最近有真实手势：tab.navigate(url) 原样调用（不带 browserInitiated:false）", async () => {
      const { session, hooksOf, created } = makeSession();
      await session.openTab({ url: "https://example.com/a" });
      hooksOf.t1.onNewTab({ url: "https://example.com/dl.bin", openerTabId: "t1" });
      await flush();
      const t2 = created[1];
      expect(t2.navigate).toHaveBeenCalledWith("https://example.com/dl.bin");
    });

    it("前台 tab 无手势（宽限期后在后台开）：带 { browserInitiated:false }", async () => {
      vi.useFakeTimers();
      try {
        const { session, hooksOf, created } = makeSession();
        await session.openTab({ url: "https://example.com/a" });
        created[0].gesture = false;
        hooksOf.t1.onNewTab({ url: "https://example.com/dl.bin", openerTabId: "t1" });
        await vi.advanceTimersByTimeAsync(PAGE_TAB_GESTURE_GRACE_MS + 10);
        expect(created[1].navigate).toHaveBeenCalledWith("https://example.com/dl.bin", { browserInitiated: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it("opener 不是当前激活 tab（后台 tab 里的脚本）且无手势：带 { browserInitiated:false }；有手势则不带", async () => {
      const { session, hooksOf, created } = makeSession();
      await session.openTab({ url: "https://example.com/a" });
      await session.openTab({ url: "https://example.com/b" }); // t2 成为激活 tab
      created[0].gesture = false;
      hooksOf.t1.onNewTab({ url: "https://example.com/dl1.bin", openerTabId: "t1" });
      await flush();
      expect(created[2].navigate).toHaveBeenCalledWith("https://example.com/dl1.bin", { browserInitiated: false });
      created[0].gesture = true;
      hooksOf.t1.onNewTab({ url: "https://example.com/dl2.bin", openerTabId: "t1" });
      await flush();
      expect(created[3].navigate).toHaveBeenCalledWith("https://example.com/dl2.bin");
    });

    it("会话暂时没有激活 tab（activeTabId 为空）：同样按 opener 手势区分，无手势带 { browserInitiated:false }，有手势不带", async () => {
      const { session, hooksOf, created } = makeSession();
      await session.openTab({ url: "https://example.com/a" });
      session.activeTabId = null;
      created[0].gesture = false;
      hooksOf.t1.onNewTab({ url: "https://example.com/dl1.bin", openerTabId: "t1" });
      await flush();
      expect(created[1].navigate).toHaveBeenCalledWith("https://example.com/dl1.bin", { browserInitiated: false });
      session.activeTabId = null;
      created[0].gesture = true;
      hooksOf.t1.onNewTab({ url: "https://example.com/dl2.bin", openerTabId: "t1" });
      await flush();
      expect(created[2].navigate).toHaveBeenCalledWith("https://example.com/dl2.bin");
    });

    it("byUser（右键菜单「在新标签页打开」）与 AI 的 tabs new：不受影响", async () => {
      const { session, hooksOf, created } = makeSession();
      await session.openTab({ url: "https://example.com/a" });
      created[0].gesture = false;
      hooksOf.t1.onNewTab({ url: "https://example.com/u", openerTabId: "t1", byUser: true });
      await flush();
      expect(created[1].navigate).toHaveBeenCalledWith("https://example.com/u");
      await session.openTab({ url: "https://example.com/ai" });
      expect(created[2].navigate).toHaveBeenCalledWith("https://example.com/ai");
    });
  });

  describe("manager 的 will-download：browserInitiated / 节流 / 在途计数", () => {
    let seq = 0;
    const makeItem = (o: { gesture?: boolean; url?: string; state?: () => string; paused?: () => boolean } = {}) => {
      const item = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const name = `r1-dl2-${process.pid}-${++seq}.bin`;
      const url = o.url ?? `https://example.com/${name}`;
      Object.assign(item, {
        getFilename: () => name,
        getTotalBytes: () => 100,
        getReceivedBytes: () => 0,
        getURL: () => url,
        getURLChain: () => [url],
        hasUserGesture: () => o.gesture ?? true,
        setSavePath: vi.fn(),
        cancel: vi.fn(),
        ...(o.state ? { getState: o.state } : {}),
        ...(o.paused ? { isPaused: o.paused } : {}),
      });
      return item as EventEmitter & { setSavePath: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } & Record<string, unknown>;
    };
    const setup = async () => {
      const h = makeManager();
      await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
      const wc = h.views[0].webContents;
      const willDownload = h.ses.on.mock.calls.find((c) => c[0] === "will-download")![1] as (e: unknown, item: unknown, wc: unknown) => void;
      const fire = (item: unknown) => willDownload({ preventDefault: vi.fn() }, item, wc);
      const blockedLogs = () =>
        (h.manager.getSession("T1")!.activityLog.list() as Array<{ kind: string; summary: string }>).filter((e) => e.kind === "download" && /下载被拦截/.test(e.summary));
      return { ...h, fire, blockedLogs };
    };

    it("browser_navigate 直达附件 URL（hasUserGesture=false）：放行；一次性——同 URL 的第二个无手势下载被拦", async () => {
      const { fire, manager } = await setup();
      const url = "https://example.com/report.pdf";
      await manager.dispatch("navigate", { url }, { taskId: "T1" });
      const first = makeItem({ gesture: false, url });
      fire(first);
      expect(first.cancel).not.toHaveBeenCalled();
      expect(first.setSavePath).toHaveBeenCalledTimes(1);
      const replay = makeItem({ gesture: false, url });
      fire(replay);
      expect(replay.cancel).toHaveBeenCalledTimes(1);
      manager.destroy();
    });

    it("页面自己发起（没 navigate 过）/ URL 对不上：仍被拦", async () => {
      const { fire, manager } = await setup();
      const a = makeItem({ gesture: false });
      fire(a);
      expect(a.cancel).toHaveBeenCalledTimes(1);
      await manager.dispatch("navigate", { url: "https://example.com/page" }, { taskId: "T1" });
      const b = makeItem({ gesture: false, url: "https://evil.example/drive-by.bin" });
      fire(b);
      expect(b.cancel).toHaveBeenCalledTimes(1);
      manager.destroy();
    });

    it("有手势的下载不去消费 navigate 的记录（留给它真正对应的那个）", async () => {
      const { fire, manager } = await setup();
      const url = "https://example.com/report.pdf";
      await manager.dispatch("navigate", { url }, { taskId: "T1" });
      fire(makeItem({ gesture: true }));
      const nav = makeItem({ gesture: false, url });
      fire(nav);
      expect(nav.cancel).not.toHaveBeenCalled();
      manager.destroy();
    });

    it("拦截记录节流：同一会话间隔内连续被拦 N 次，cancel 每次都做，但日志 / 活动条目只有 1 条；过了间隔再记一条并带「另有 N 次」", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(10_000_000);
      try {
        const { fire, blockedLogs, manager } = await setup();
        const items = Array.from({ length: 6 }, () => makeItem({ gesture: false }));
        for (const it of items) fire(it);
        for (const it of items) expect(it.cancel).toHaveBeenCalledTimes(1);
        expect(blockedLogs()).toHaveLength(1);
        vi.setSystemTime(10_000_000 + BLOCK_REPORT_INTERVAL_MS);
        const again = makeItem({ gesture: false });
        fire(again);
        expect(again.cancel).toHaveBeenCalledTimes(1);
        const logs = blockedLogs();
        expect(logs).toHaveLength(2);
        expect(logs[1].summary).toContain("另有 5 次");
        manager.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it(`暂停 / interrupted 的下载不占并发名额：${MAX_ACTIVE_DOWNLOADS} 个都 interrupted 后还能开新的；恢复后重新计入`, async () => {
      const { fire, manager } = await setup();
      const states = Array.from({ length: MAX_ACTIVE_DOWNLOADS }, () => ({ s: "progressing" }));
      const items = states.map((st) => makeItem({ state: () => st.s }));
      for (const it of items) fire(it);
      const blocked = makeItem();
      fire(blocked);
      expect(blocked.cancel).toHaveBeenCalledTimes(1); // 满了
      // 全部转 interrupted：updated 事件里摘掉
      states.forEach((st) => (st.s = "interrupted"));
      for (const it of items) it.emit("updated");
      const ok = makeItem();
      fire(ok);
      expect(ok.cancel).not.toHaveBeenCalled();
      // 其中一个恢复 → 重新计入
      states[0].s = "progressing";
      items[0].emit("updated");
      // 现在在途：items[0] + ok = 2；再开 3 个到 5，第 6 个被拦
      const more = Array.from({ length: 3 }, () => makeItem());
      for (const it of more) fire(it);
      for (const it of more) expect(it.cancel).not.toHaveBeenCalled();
      const over = makeItem();
      fire(over);
      expect(over.cancel).toHaveBeenCalledTimes(1);
      manager.destroy();
    });

    it("isPaused() 同样摘掉；done 之后晚到的 updated 不会把它记回去（不会凭空占名额）", async () => {
      const { fire, manager } = await setup();
      const paused = { v: false };
      const items = Array.from({ length: MAX_ACTIVE_DOWNLOADS }, () => makeItem({ paused: () => paused.v }));
      for (const it of items) fire(it);
      paused.v = true;
      for (const it of items) it.emit("updated");
      const ok = makeItem();
      fire(ok);
      expect(ok.cancel).not.toHaveBeenCalled();
      // done 之后再来 updated：不记回
      paused.v = false;
      for (const it of items) it.emit("done", {}, "cancelled");
      for (const it of items) it.emit("updated");
      const batch = Array.from({ length: MAX_ACTIVE_DOWNLOADS - 1 }, () => makeItem());
      for (const it of batch) fire(it); // ok 占 1 个，再开 4 个正好满
      for (const it of batch) expect(it.cancel).not.toHaveBeenCalled();
      const over = makeItem();
      fire(over);
      expect(over.cancel).toHaveBeenCalledTimes(1);
      manager.destroy();
    });

    it("close_session 清掉该会话的在途计数：重开同 taskId 的会话不继承旧计数，旧下载晚到的 done 也不会误扣新会话", async () => {
      const { fire, manager, views, ses } = await setup();
      const old = Array.from({ length: MAX_ACTIVE_DOWNLOADS }, () => makeItem());
      for (const it of old) fire(it);
      await manager.dispatch("close_session", {}, { taskId: "T1" });
      await manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
      const wc2 = views[views.length - 1].webContents;
      const willDownload = ses.on.mock.calls.find((c) => c[0] === "will-download")![1] as (e: unknown, item: unknown, wc: unknown) => void;
      const fire2 = (item: unknown) => willDownload({ preventDefault: vi.fn() }, item, wc2);
      const fresh = Array.from({ length: MAX_ACTIVE_DOWNLOADS }, () => makeItem());
      for (const it of fresh) fire2(it);
      for (const it of fresh) expect(it.cancel).not.toHaveBeenCalled(); // 不继承旧计数
      for (const it of old) it.emit("done", {}, "cancelled"); // 旧下载晚到的 done
      const over = makeItem();
      fire2(over);
      expect(over.cancel).toHaveBeenCalledTimes(1); // 新会话仍是满的（没被旧 done 误扣）
      manager.destroy();
    });

    // ── R3 复审 / R3-07 ──
    const flushTicks = () => new Promise<void>((r) => setTimeout(r, 0));

    it("R1-10 复审 ① 用户在地址栏（browser:navigate）导航到附件直链：放行，一次性；页面自己发起的同 URL 仍被拦", async () => {
      const { fire, manager, handlers } = await setup();
      manager.registerIpc();
      const url = "https://example.com/export/report.xlsx";
      const r = await handlers.get("browser:navigate")!({}, "T1", url);
      expect(r).toEqual({ ok: true });
      const first = makeItem({ gesture: false, url });
      fire(first);
      expect(first.cancel).not.toHaveBeenCalled();
      expect(first.setSavePath).toHaveBeenCalledTimes(1);
      const replay = makeItem({ gesture: false, url });
      fire(replay);
      expect(replay.cancel).toHaveBeenCalledTimes(1);
      manager.destroy();
    });

    it("R1-10 复审 ① 新建标签带 URL（browser:newTab）直达附件：放行（来自新标签的 webContents）", async () => {
      const { manager, handlers, views, ses } = await setup();
      manager.registerIpc();
      const url = "https://example.com/export/report2.xlsx";
      const id = await handlers.get("browser:newTab")!({}, "T1", url);
      expect(typeof id).toBe("string");
      await flushTicks();
      await flushTicks();
      const wcNew = views[views.length - 1].webContents;
      expect(wcNew.loadURL).toHaveBeenCalledWith(url);
      const willDownload = ses.on.mock.calls.find((c) => c[0] === "will-download")![1] as (e: unknown, item: unknown, wc: unknown) => void;
      const item = makeItem({ gesture: false, url });
      willDownload({ preventDefault: vi.fn() }, item, wcNew);
      expect(item.cancel).not.toHaveBeenCalled();
      manager.destroy();
    });

    it("R3-07 ① 令牌过期后才开始下载：仍拦，但活动记录说「授权已过期」，不说成页面偷偷下载", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(50_000_000);
      try {
        const { fire, blockedLogs, manager } = await setup();
        const url = "https://example.com/slow-report.pdf";
        await manager.dispatch("navigate", { url }, { taskId: "T1" });
        vi.setSystemTime(50_000_000 + 61_000);
        const late = makeItem({ gesture: false, url });
        fire(late);
        expect(late.cancel).toHaveBeenCalledTimes(1);
        const logs = blockedLogs();
        expect(logs).toHaveLength(1);
        expect(logs[0].summary).toMatch(/过期/);
        expect(logs[0].summary).not.toMatch(/没有经过用户操作/);
        manager.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("R3-07 ② 拦截记录按「会话 + 原因」节流：页面无手势自动下载已上报后，用户真点的超大文件被拦仍有自己的记录", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(60_000_000);
      try {
        const { fire, blockedLogs, manager } = await setup();
        fire(makeItem({ gesture: false })); // t=0：无手势，上报
        vi.setSystemTime(60_000_000 + 2000);
        const big = makeItem({ gesture: true });
        (big as unknown as { getTotalBytes: () => number }).getTotalBytes = () => MAX_DOWNLOAD_BYTES + 1;
        fire(big); // t=2s：文件过大，原因不同 → 不被吞
        expect(big.cancel).toHaveBeenCalledTimes(1);
        const logs = blockedLogs();
        expect(logs).toHaveLength(2);
        expect(logs[0].summary).toMatch(/没有经过用户操作/);
        expect(logs[1].summary).toMatch(/文件过大/);
        manager.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("R3-07 ② 被吞掉的次数到点自动补记一条（页面不再触发也不会石沉大海）；会话销毁时也补记", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(70_000_000);
      try {
        const { fire, blockedLogs, manager } = await setup();
        for (let i = 0; i < 4; i++) fire(makeItem({ gesture: false })); // 1 条上报 + 3 次被吞
        expect(blockedLogs()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(BLOCK_REPORT_INTERVAL_MS + 10);
        const logs = blockedLogs();
        expect(logs).toHaveLength(2);
        expect(logs[1].summary).toContain("另有 3 次");
        manager.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it(`R3-07 ③ 暂停 / interrupted 的下载有独立上限 ${MAX_PAUSED_DOWNLOADS}：之后再 interrupted 的被 cancel`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(80_000_000);
      try {
        const { fire, manager } = await setup();
        const interrupted: Array<ReturnType<typeof makeItem>> = [];
        // 频率闸每分钟 10 个：分批开，每个一开就 interrupted（active 恒为 0，只剩频率闸挡着）
        for (let batch = 0; interrupted.length < MAX_PAUSED_DOWNLOADS; batch++) {
          for (let i = 0; i < MAX_DOWNLOADS_PER_WINDOW && interrupted.length < MAX_PAUSED_DOWNLOADS; i++) {
            const st = { s: "interrupted" };
            const it = makeItem({ state: () => st.s });
            fire(it);
            expect(it.cancel).not.toHaveBeenCalled();
            it.emit("updated");
            expect(it.cancel).not.toHaveBeenCalled();
            interrupted.push(it);
          }
          vi.setSystemTime(80_000_000 + (batch + 1) * (DOWNLOAD_WINDOW_MS + 1000));
        }
        const extra = makeItem({ state: () => "interrupted" });
        fire(extra);
        expect(extra.cancel).not.toHaveBeenCalled(); // 刚开出来还没 interrupted
        extra.emit("updated"); // 第 21 个 interrupted：超限被掐
        expect(extra.cancel).toHaveBeenCalledTimes(1);
        // 已登记的再来 updated 不会被误掐（幂等）
        interrupted[0].emit("updated");
        expect(interrupted[0].cancel).not.toHaveBeenCalled();
        // 其中一个 done 之后腾出名额
        interrupted[1].emit("done", {}, "cancelled");
        const next = makeItem({ state: () => "interrupted" });
        fire(next);
        next.emit("updated");
        expect(next.cancel).not.toHaveBeenCalled();
        manager.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("R3-07 ③ interrupted 的下载恢复时复核并发上限：在途已满则被 cancel，不能越过上限", async () => {
      const { fire, manager } = await setup();
      const st = { s: "progressing" };
      const resumer = makeItem({ state: () => st.s });
      fire(resumer);
      st.s = "interrupted";
      resumer.emit("updated"); // 摘出在途
      const fill = Array.from({ length: MAX_ACTIVE_DOWNLOADS }, () => makeItem());
      for (const it of fill) fire(it); // 在途刚好满
      for (const it of fill) expect(it.cancel).not.toHaveBeenCalled();
      st.s = "progressing";
      resumer.emit("updated"); // 恢复：在途已满 → 掐掉
      expect(resumer.cancel).toHaveBeenCalledTimes(1);
      manager.destroy();
    });
  });
});

describe("R1-32 复审：退出途中不新建原生窗口（manager.setQuitting 护栏）", () => {
  const attachedSetup = async () => {
    const h = makeManager();
    await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
    h.manager.registerIpc();
    const attach = h.handlers.get("browser:attach")!;
    expect(attach).toBeTypeOf("function");
    await attach({}, "T1", { x: 0, y: 0, width: 400, height: 300 });
    const session = h.manager.getSession("T1")!;
    expect(session.attached).toBe(true);
    return { ...h, session };
  };

  it("停车场窗口已先被关掉 + quitting：detach 不新建窗口，只把视图从主窗口摘下", async () => {
    const h = await attachedSetup();
    expect(h.windows).toHaveLength(1); // 停车场
    h.windows[0].destroyed = true; // 模拟 Windows 逆序关窗：停车场先没了
    h.manager.setQuitting(true);
    expect(() => h.session.detach()).not.toThrow();
    expect(h.windows).toHaveLength(1); // 没有新建
    expect(h.mainWin.contentView.removeChildView).toHaveBeenCalledWith(h.views[0]);
    expect(h.session.attached).toBe(false);
    h.manager.destroy();
  });

  it("没有 quitting 时同样场景会新建停车场窗口（对照：护栏确实是 setQuitting 在起作用）", async () => {
    const h = await attachedSetup();
    h.windows[0].destroyed = true;
    h.session.detach();
    expect(h.windows).toHaveLength(2);
    h.manager.destroy();
  });

  it("quitting 但停车场窗口还活着：照常搬回停车场（不是一刀切不动视图）", async () => {
    const h = await attachedSetup();
    h.manager.setQuitting(true);
    h.session.detach();
    expect(h.windows).toHaveLength(1);
    expect(h.windows[0].contentView.addChildView).toHaveBeenLastCalledWith(h.views[0]);
    h.manager.destroy();
  });

  it("quitting 时不能新建 tab（NO_SESSION，也不会为它新建停车场窗口）；setQuitting(false) 复位后恢复", async () => {
    const h = makeManager();
    h.manager.setQuitting(true);
    await expect(h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" })).rejects.toMatchObject({ code: "NO_SESSION", message: expect.stringContaining("退出") });
    expect(h.windows).toHaveLength(0);
    h.manager.setQuitting(false); // 退出被取消
    await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
    expect(h.windows).toHaveLength(1);
    h.manager.destroy();
  });

  it("setQuitting 只认严格的 true（undefined / 'true' 当作复位）", async () => {
    const h = makeManager();
    h.manager.setQuitting(true);
    (h.manager.setQuitting as (v: unknown) => void)(undefined);
    await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
    expect(h.windows).toHaveLength(1);
    h.manager.setQuitting(true);
    (h.manager.setQuitting as (v: unknown) => void)("true");
    await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
    h.manager.destroy();
  });
});

describe("R1-32 复审：BrowserTab.moveToParking(null)", () => {
  it("没有停车场窗口（退出途中）：把视图从当前父窗口摘下、不 addChildView、不抛；之后还能 moveToMain", async () => {
    const { tab, parking } = makeTab();
    await tab.ready;
    const main = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, isDestroyed: () => false };
    tab.moveToMain(main as never, { x: 0, y: 0, width: 10, height: 10 });
    const parked = parking.contentView.addChildView.mock.calls.length;
    expect(() => tab.moveToParking(null as never)).not.toThrow();
    expect(main.contentView.removeChildView).toHaveBeenCalledTimes(1);
    expect(parking.contentView.addChildView.mock.calls.length).toBe(parked);
    expect(tab.parentWindow).toBeNull();
    tab.moveToMain(main as never, { x: 0, y: 0, width: 10, height: 10 });
    expect(tab.parentWindow).toBe(main);
  });

  it("父窗口已销毁（主窗口 closed 事件里）/ removeChildView 抛错：吞掉；已销毁的 tab 无操作", async () => {
    const { tab } = makeTab();
    await tab.ready;
    const dead = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, isDestroyed: () => true };
    tab.moveToMain(dead as never, { x: 0, y: 0, width: 10, height: 10 });
    expect(() => tab.moveToParking(null as never)).not.toThrow();
    expect(dead.contentView.removeChildView).not.toHaveBeenCalled(); // 已销毁的窗口不去碰

    const boom = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn(() => { throw new TypeError("Object has been destroyed"); }) },
      isDestroyed: () => false,
    };
    tab.moveToMain(boom as never, { x: 0, y: 0, width: 10, height: 10 });
    expect(() => tab.moveToParking(null as never)).not.toThrow();
    expect(boom.contentView.removeChildView).toHaveBeenCalledTimes(1);
  });
});

describe("R3-06：moveToParking(null) 之后 wc 被销毁，hostGone 仍为 true（不因 parentWindow 置空而变假）", () => {
  it("退出途中摘下视图（parentWindow=null）后 wc destroyed：onGone({hostGone:true})；重新 moveToMain 后恢复按真实宿主判断", async () => {
    const a = makeTab();
    await a.tab.ready;
    const main = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, isDestroyed: () => false };
    a.tab.moveToMain(main as never, { x: 0, y: 0, width: 10, height: 10 });
    a.tab.moveToParking(null as never); // 应用在退出：没有停车场窗口，只摘视图
    expect(a.tab.parentWindow).toBeNull();
    a.wc.destroyedFlag = true;
    a.wc.emit("destroyed");
    expect(a.hooks.onGone).toHaveBeenCalledWith({ hostGone: true });

    // 对照：退出被取消、重新附着到活着的主窗口后，页面自己 window.close() 仍走「补空白页」那条（hostGone=false）
    const b = makeTab();
    await b.tab.ready;
    b.tab.moveToMain(main as never, { x: 0, y: 0, width: 10, height: 10 });
    b.tab.moveToParking(null as never);
    b.tab.moveToMain(main as never, { x: 0, y: 0, width: 10, height: 10 });
    b.wc.destroyedFlag = true;
    b.wc.emit("destroyed");
    expect(b.hooks.onGone).toHaveBeenCalledWith({ hostGone: false });
  });

  it("main.js 接线：applyStagedUpdate 的 relaunch 分支在 quitting=true 旁置位 setQuitting(true)，失败分支对称复位", () => {
    const src = readFileSync(path.join(process.cwd(), "electron-app/main.js"), "utf8");
    const fn = src.slice(src.indexOf("const applyStagedUpdate = async"), src.indexOf("const tryApplyStagedUpdateOnLaunch"));
    expect(fn.length).toBeGreaterThan(500);
    const setIdx = fn.indexOf("browserManager.setQuitting(true);");
    const stopIdx = fn.indexOf("await stopServer()");
    const exitIdx = fn.lastIndexOf("app.exit(0);");
    expect(setIdx).toBeGreaterThan(0);
    expect(setIdx).toBeLessThan(stopIdx); // 先置位、再停 server（停 server 期间窗口就可能被关）
    expect(stopIdx).toBeLessThan(exitIdx);
    expect(fn).toContain("browserManager.setQuitting(false)"); // 失败回滚
  });

  it("R4-04 ⑦ main.js 接线：updates 目录的 mkdirSync 在 try 里（先于 rename、后于 stopServer），失败也走复位 catch", () => {
    const src = readFileSync(path.join(process.cwd(), "electron-app/main.js"), "utf8");
    const fn = src.slice(src.indexOf("const applyStagedUpdate = async"), src.indexOf("const tryApplyStagedUpdateOnLaunch"));
    const stopIdx = fn.indexOf("await stopServer()");
    const mkIdx = fn.indexOf("mkdirSync(updatesDir");
    const renameIdx = fn.indexOf("await fs.rename(appPath, stagedOld)");
    const resetIdx = fn.indexOf("browserManager.setQuitting(false)");
    expect(mkIdx).toBeGreaterThan(stopIdx);
    expect(mkIdx).toBeLessThan(renameIdx);
    // 离 mkdir 最近的上一个 `try {` 必须在 stopServer 之后（= mkdir 被 try 包住），且复位语句在它的 catch 里（mkdir 之后）
    const tryIdx = fn.lastIndexOf("try {", mkIdx);
    expect(tryIdx).toBeGreaterThan(stopIdx);
    expect(resetIdx).toBeGreaterThan(mkIdx);
    // try 与 mkdir 之间只能是注释，不能有别的语句把 mkdir 挤到 try 之外
    expect(fn.slice(tryIdx + "try {".length, mkIdx).split("\n").every((l) => l.trim() === "" || l.trim().startsWith("//"))).toBe(true);
  });
});

// ───────────────────────── R1-32：partition 配置 ─────────────────────────

describe("R1-09 manager：状态推送定时器不能把异常抛成主进程 uncaughtException", () => {
  it("某个会话读状态抛错（wc 在读的瞬间被销毁）：定时器回调吞掉并记日志，下一次变化仍能推送", async () => {
    vi.useFakeTimers();
    try {
      const h = makeManager();
      await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
      vi.advanceTimersByTime(1000); // 先把建 tab 引起的推送冲掉
      const session = h.manager.getSession("T1")!;
      const real = session.getState.bind(session);
      let boom = true;
      session.getState = () => {
        if (boom) throw new TypeError("Object has been destroyed");
        return real();
      };
      h.mainWc.send.mockClear();
      await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" }); // 触发 scheduleState
      // 定时器里抛出去 = 主进程 uncaughtException；fake timers 下它会从 advanceTimersByTime 里冒出来
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(h.mainWc.send).not.toHaveBeenCalled();
      // 恢复正常后，下一次变化照常推送（定时器没有被卡成「已排队」）
      boom = false;
      await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
      vi.advanceTimersByTime(1000);
      expect(h.mainWc.send).toHaveBeenCalled();
      h.manager.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("R1-26 network op：列表出口的 URL 脱敏", () => {
  it("url 里的 ?code= / ?token= / userinfo / fragment 令牌都不出现在返回里；普通 URL 不变；filter=failed/xhr 分支同样脱敏", async () => {
    const h = makeManager();
    await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
    const tab = h.manager.getSession("T1")!.activeTab as unknown as { networkRing: { push: (e: unknown) => void } };
    const secret = "S3CRET-VALUE-123";
    tab.networkRing.push({ id: 1, method: "GET", url: `https://api.example.com/cb?code=${secret}&page=2`, status: 200, type: "XHR" });
    tab.networkRing.push({ id: 2, method: "GET", url: `https://user:${secret}@host.example.com/x`, status: 500, failed: true, type: "Document" });
    tab.networkRing.push({ id: 3, method: "GET", url: `https://app.example.com/#access_token=${secret}`, status: 200, type: "Fetch" });
    tab.networkRing.push({ id: 4, method: "GET", url: "https://cdn.example.com/app.js?v=3", status: 200, type: "Script" });

    const r = (await h.manager.dispatch("network", {}, { taskId: "T1" })) as { entries: Array<{ id: number; url: string }> };
    expect(r.entries).toHaveLength(4);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.entries.find((e) => e.id === 1)!.url).toContain("page=2"); // 键保留、无害参数不动
    expect(r.entries.find((e) => e.id === 4)!.url).toBe("https://cdn.example.com/app.js?v=3");
    const failed = (await h.manager.dispatch("network", { filter: "failed" }, { taskId: "T1" })) as { entries: Array<{ id: number }> };
    expect(failed.entries.map((e) => e.id)).toEqual([2]);
    expect(JSON.stringify(failed)).not.toContain(secret);
    const xhr = (await h.manager.dispatch("network", { filter: "xhr" }, { taskId: "T1" })) as { entries: Array<{ id: number }> };
    expect(xhr.entries.map((e) => e.id)).toEqual([1, 3]);
    expect(JSON.stringify(xhr)).not.toContain(secret);
    h.manager.destroy();
  });
});

describe("网络：加载结束后收尾丢了 loadingFinished 的 Document（真机实测约 1–2%/次导航，裸 WebContentsView 同样丢）", () => {
  const cdp = (wc: FakeWc, method: string, params: Record<string, unknown>) => wc.messageHandler({}, method, params);
  const docStart = (wc: FakeWc, id: string, url: string, type = "Document") =>
    cdp(wc, "Network.requestWillBeSent", { requestId: id, type, timestamp: 10, request: { url, method: "GET", headers: {} } });
  const docResponse = (wc: FakeWc, id: string, status: number, type = "Document") =>
    cdp(wc, "Network.responseReceived", { requestId: id, type, timestamp: 10.1, response: { url: "https://a.test/", status, headers: {}, mimeType: "text/html" } });

  const ready = async () => {
    const h = makeTab();
    await h.tab.ready;
    return h;
  };

  it("有响应头但 loadingFinished 没来：did-stop-loading 后按真实状态进环、inflight 清零（networkIdle 不再被它拖住）", async () => {
    const { tab, wc, clock } = await ready();
    docStart(wc, "D1", "https://a.test/?n=1");
    clock.t += 120;
    docResponse(wc, "D1", 200);
    expect(tab.inflightRequestCount).toBe(1);
    wc.emit("did-stop-loading");
    expect(tab.inflightRequestCount).toBe(0);
    const [e] = tab.networkRing.list() as Array<Record<string, unknown>>;
    expect(e).toMatchObject({ url: "https://a.test/?n=1", type: "Document", status: 200 });
    expect(e.failed).toBeUndefined();
    expect(e.durationMs).toBe(120);
    expect(tab.networkRing.size()).toBe(1);
  });

  it("响应是 404 / 500 的 Document 收尾后仍标 failed；没有响应头的（被取消的导航）记为 canceled 而不是失败", async () => {
    const { tab, wc } = await ready();
    docStart(wc, "D404", "https://a.test/missing");
    docResponse(wc, "D404", 404);
    docStart(wc, "DX", "https://a.test/aborted");
    wc.emit("did-stop-loading");
    const list = tab.networkRing.list() as Array<Record<string, unknown>>;
    expect(list.find((e) => e.url === "https://a.test/missing")).toMatchObject({ status: 404, failed: true });
    const aborted = list.find((e) => e.url === "https://a.test/aborted")!;
    expect(aborted).toMatchObject({ errorText: "canceled", status: null });
    expect(aborted.failed).toBe(false);
    expect(tab.inflightRequestCount).toBe(0);
  });

  it("wc 仍在加载（新导航已开始）时不动；非 Document 的在途请求（XHR / 图片）任何时候都不动", async () => {
    const { tab, wc } = await ready();
    docStart(wc, "D2", "https://a.test/next");
    docStart(wc, "X1", "https://a.test/api/slow", "XHR");
    wc.isLoading = () => true;
    wc.emit("did-stop-loading");
    expect(tab.inflightRequestCount).toBe(2);
    expect(tab.networkRing.size()).toBe(0);
    wc.isLoading = () => false;
    wc.emit("did-stop-loading");
    expect(tab.inflightRequestCount).toBe(1); // 只剩 XHR
    expect((tab.networkRing.list() as Array<{ type: string }>).map((e) => e.type)).toEqual(["Document"]);
  });

  it("正常顺序（loadingFinished 先到）不重复记；收尾之后迟到的 loadingFinished 被忽略、不产生第二条", async () => {
    const { tab, wc } = await ready();
    docStart(wc, "N1", "https://a.test/ok");
    docResponse(wc, "N1", 200);
    cdp(wc, "Network.loadingFinished", { requestId: "N1", timestamp: 10.2 });
    wc.emit("did-stop-loading");
    expect(tab.networkRing.size()).toBe(1);
    docStart(wc, "L1", "https://a.test/late");
    docResponse(wc, "L1", 200);
    wc.emit("did-stop-loading");
    expect(tab.networkRing.size()).toBe(2);
    cdp(wc, "Network.loadingFinished", { requestId: "L1", timestamp: 10.5 }); // 迟到
    expect(tab.networkRing.size()).toBe(2);
    expect(tab.inflightRequestCount).toBe(0);
  });

  it("wc 已销毁 / isLoading 抛错：不抛、不动 inflight", async () => {
    const { tab, wc } = await ready();
    docStart(wc, "D3", "https://a.test/x");
    wc.isLoading = () => {
      throw new TypeError("Object has been destroyed");
    };
    expect(() => wc.emit("did-stop-loading")).not.toThrow();
    expect(tab.inflightRequestCount).toBe(1);
  });
});

describe("R1-29 BrowserTab.screenshot：超大输出在解码之前拦下", () => {
  it("base64 解码后超过上限：BAD_ARGS（带替代做法），不分配 Buffer", async () => {
    const { tab, wc } = makeTab();
    await tab.ready;
    const big = "A".repeat(Math.ceil((FULLPAGE_SHOT_MAX_BYTES * 4) / 3) + 8);
    wc.debugger.sendCommand.mockImplementation((async (method: string) => (method === "Page.captureScreenshot" ? { data: big } : {})) as never);
    const spy = vi.spyOn(Buffer, "from");
    try {
      await expect(tab.screenshot({ fullPage: false })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringMatching(/超过 30MB 上限.*视口截图/s) });
      expect(spy.mock.calls.some((c) => c[0] === big)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("未超上限：照常返回 base64（门槛是「严格大于」）", async () => {
    const { tab, wc } = makeTab();
    await tab.ready;
    const small = Buffer.from("not-really-a-jpeg").toString("base64");
    wc.debugger.sendCommand.mockImplementation((async (method: string) => (method === "Page.captureScreenshot" ? { data: small } : {})) as never);
    const r = await tab.screenshot({ fullPage: false });
    expect(r.mimeType).toBe("image/jpeg");
    expect(r.dataBase64).toBe(small);
  });
});

describe("R1-35 状态出口附带 windowFocused（BrowserWindow.isFocused 真值）", () => {
  const lastPushed = (h: ReturnType<typeof makeManager>) => {
    const calls = h.mainWc.send.mock.calls.filter((c) => c[0] === "browser:state");
    return calls[calls.length - 1]?.[2] as Record<string, unknown> | undefined;
  };

  it("推送：窗口有焦点 → true；没有 / 没有 isFocused API / isFocused 抛错 → false（不确定就不静音通知）", async () => {
    vi.useFakeTimers();
    try {
      const h = makeManager();
      const win = h.mainWin as unknown as { isFocused?: () => boolean };
      await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
      vi.advanceTimersByTime(1000);
      expect(lastPushed(h)).toMatchObject({ taskId: "T1", windowFocused: false }); // 夹具窗口没有 isFocused

      win.isFocused = () => true;
      await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
      vi.advanceTimersByTime(1000);
      expect(lastPushed(h)).toMatchObject({ windowFocused: true });

      // 紧接在 true 之后测抛错：若不兜底，这次推送会整条丢掉，最后一条仍是上一次的 true（这样才测得出来）
      win.isFocused = () => {
        throw new Error("Object has been destroyed");
      };
      await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(lastPushed(h)).toMatchObject({ windowFocused: false });

      win.isFocused = () => false;
      await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
      vi.advanceTimersByTime(1000);
      expect(lastPushed(h)).toMatchObject({ windowFocused: false });
      h.manager.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("browser:getState / browser:attach 返回值也带；未知任务仍返回 null", async () => {
    const h = makeManager();
    h.manager.registerIpc();
    (h.mainWin as unknown as { isFocused: () => boolean }).isFocused = () => true;
    const attached = (await h.handlers.get("browser:attach")!({}, "T1", { x: 0, y: 0, width: 800, height: 600 })) as Record<string, unknown>;
    expect(attached.windowFocused).toBe(true);
    const got = (await h.handlers.get("browser:getState")!({}, "T1")) as Record<string, unknown>;
    expect(got.windowFocused).toBe(true);
    expect(await h.handlers.get("browser:getState")!({}, "T-unknown")).toBeNull();
    // 会话本身的状态不带窗口信息（纯会话状态）
    expect("windowFocused" in h.manager.getSession("T1")!.getState()).toBe(false);
    h.manager.destroy();
  });
});

describe("R1-32 partition 配置", () => {
  it("配置中途抛错：partitionReady 不置位，下次建 tab 重试，且 will-download 只挂一次", async () => {
    const h = makeManager({ permissionThrowsOnce: true });
    await expect(h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" })).rejects.toThrow(/boom/);
    // 第一次抛在 setPermissionRequestHandler：下载守卫是最先装的，此时已经挂上了（失败也不能让它缺席）
    expect(h.ses.on.mock.calls.filter((c) => c[0] === "will-download")).toHaveLength(1);
    await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" }); // 重试成功：不能重复挂
    expect(h.ses.setPermissionRequestHandler).toHaveBeenCalledTimes(2);
    expect(h.ses.on.mock.calls.filter((c) => c[0] === "will-download")).toHaveLength(1);
    // 成功后不再重复配置
    await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
    expect(h.ses.setPermissionRequestHandler).toHaveBeenCalledTimes(2);
    expect(h.ses.on).toHaveBeenCalledTimes(1);
    h.manager.destroy();
  });

  it("设备权限（WebUSB / HID / Serial）默认拒绝；没有该 API 的老版本不报错", async () => {
    const setDevice = vi.fn();
    const h = makeManager({ sesExtra: { setDevicePermissionHandler: setDevice } });
    await h.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" });
    expect(setDevice).toHaveBeenCalledTimes(1);
    expect((setDevice.mock.calls[0][0] as () => boolean)()).toBe(false);
    h.manager.destroy();
    const h2 = makeManager(); // ses 没有 setDevicePermissionHandler
    await expect(h2.manager.dispatch("tabs", { action: "new" }, { taskId: "T1" })).resolves.toBeDefined();
    h2.manager.destroy();
  });
});

// ───────────────────────── R1-14：主窗口整页导航收回视图 ─────────────────────────

describe("R1-14 主窗口整页导航 / 渲染进程退出：收回原生视图", () => {
  const attach = async () => {
    const h = makeManager();
    h.manager.registerIpc();
    const ev = {};
    await h.handlers.get("browser:attach")!(ev, "T1", { x: 0, y: 0, width: 800, height: 600 });
    const session = h.manager.getSession("T1")!;
    expect(session.attached).toBe(true);
    return { ...h, session };
  };

  it("主 frame 的跨文档导航（reload / 整页跳转）→ detach；之后可重新 attach", async () => {
    const { manager, mainWc, session, handlers } = await attach();
    mainWc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(session.attached).toBe(false);
    await handlers.get("browser:attach")!({}, "T1", { x: 0, y: 0, width: 800, height: 600 });
    expect(session.attached).toBe(true);
    manager.destroy();
  });

  it("站内路由（isSameDocument）与子 frame 导航不收回", async () => {
    const { manager, mainWc, session } = await attach();
    mainWc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    mainWc.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    mainWc.emit("did-start-navigation", undefined);
    expect(session.attached).toBe(true);
    manager.destroy();
  });

  it("主窗口渲染进程退出 → detach", async () => {
    const { manager, mainWc, session } = await attach();
    mainWc.emit("render-process-gone", {}, { reason: "crashed" });
    expect(session.attached).toBe(false);
    manager.destroy();
  });

  it("监听只挂一次：多次 attach 不会重复挂 did-start-navigation", async () => {
    const { manager, mainWc, handlers } = await attach();
    await handlers.get("browser:attach")!({}, "T1", { x: 0, y: 0, width: 800, height: 600 });
    await handlers.get("browser:attach")!({}, "T2", { x: 0, y: 0, width: 800, height: 600 });
    expect(mainWc.listenerCount("did-start-navigation")).toBe(1);
    expect(mainWc.listenerCount("render-process-gone")).toBe(1);
    manager.destroy();
  });
});
