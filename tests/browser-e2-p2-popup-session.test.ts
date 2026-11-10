/**
 * E2·P2 / A2：BrowserSession 的弹窗判定（planPopup）、预留票、收养（openPopupTab）。假 tab / 假 host / 手动定时器。
 *   - 判定：手势（录制器 / input-event 任一）/ 无手势 / 未知 opener / 会话已销毁 / 超上限（含已预留票）/ 限流（只在放行时耗配额）
 *   - 票：占名额、TTL 自动归还、收养后转正、销毁时清空
 *   - 收养：继承 opener 的 partition（含无痕）、tab_open 日志、opener / popup 标记、激活策略、下载令牌、AI 驱动期上锁、超限 / 无 opener 抛错
 *   - 弹窗关闭回到 opener；tabHooks.onPopupRequest 接线
 *   - 补充：标签页上限计入已预留的弹窗票
 */
import { describe, expect, it, vi } from "vitest";

import {
  BrowserSession,
  PAGE_TAB_GESTURE_MS,
  PAGE_TAB_MAX_PER_WINDOW,
  PAGE_TAB_WINDOW_MS,
  POPUP_TICKET_TTL_MS,
} from "../electron-app/browser/session.mjs";

class PTab {
  opener: string | null = null;
  popup?: boolean;
  recorderGesture = false;
  trustedInput = false;
  gestureArgs: number[] = [];
  trustedArgs: number[] = [];
  hadRecentGesture = (ms: number) => {
    this.gestureArgs.push(ms);
    return this.recorderGesture;
  };
  hadRecentTrustedInput = (ms: number) => {
    this.trustedArgs.push(ms);
    return this.trustedInput;
  };
  noteBrowserInitiatedLoad = vi.fn();
  lastUrl = "";
  url = "https://opener.example/page";
  title = "页";
  destroy = vi.fn();
  setInputIgnored = vi.fn(async () => {});
  overlaySetActive = vi.fn(async () => {});
  overlayHide = vi.fn(async () => {});
  moveToMain = vi.fn();
  moveToParking = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
  navigate = vi.fn(async () => ({ url: this.url, title: this.title, status: 200 }));
  ready = Promise.resolve();
  constructor(
    public id: string,
    public partition?: string,
  ) {}
  info(isActive: boolean) {
    return { id: this.id, url: this.url, title: this.title, favicon: null, loading: false, canGoBack: false, canGoForward: false, isActive };
  }
}

type Hooks = {
  onNewTab: (i: Record<string, unknown>) => void;
  onPopupRequest: (i: { url: string; openerTabId: string }) => { adopt: (wc: unknown) => unknown; release: () => void } | null;
  onGone: (info?: { hostGone: boolean }) => void;
};

const makeEnv = (opts: { maxTabs?: number } = {}) => {
  const clock = { t: 1_000 };
  const hooksOf: Record<string, Hooks> = {};
  const createCalls: Array<Record<string, unknown>> = [];
  const created: PTab[] = [];
  const timers: Array<{ id: number; ms: number; fn: () => void; cleared: boolean }> = [];
  const setTimeoutFn = ((fn: () => void, ms: number) => {
    const t = { id: timers.length + 1, ms, fn, cleared: false };
    timers.push(t);
    return t as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((t: { cleared: boolean }) => {
    if (t) t.cleared = true;
  }) as unknown as typeof clearTimeout;
  const activityLog = { addSystem: vi.fn(), ingest: vi.fn(() => false) };
  const host = {
    createTab: (args: { id: string; hooks: Hooks; partition?: string; adopt?: unknown }) => {
      createCalls.push(args as unknown as Record<string, unknown>);
      hooksOf[args.id] = args.hooks;
      const t = new PTab(args.id, args.partition);
      created.push(t);
      return t;
    },
    getMainWindow: () => ({ name: "main" }),
    getParkingWindow: () => ({ name: "parking" }),
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: vi.fn(),
    ...(opts.maxTabs !== undefined ? { getMaxTabs: () => opts.maxTabs } : {}),
  };
  const session = new BrowserSession({
    taskId: "task1",
    host: host as never,
    activityLog: activityLog as never,
    now: () => clock.t,
    setTimeoutFn,
    clearTimeoutFn,
  });
  /** 触发尚未清除的、延迟为 ms 的定时器 */
  const fire = (ms: number) => timers.filter((t) => t.ms === ms && !t.cleared).forEach((t) => ((t.cleared = true), t.fn()));
  return { session, clock, hooksOf, createCalls, created, timers, fire, activityLog, host };
};

const fakeWc = () => ({ id: "popup-wc" }) as unknown;
const sysLog = (env: ReturnType<typeof makeEnv>) => env.activityLog.addSystem.mock.calls.map((c) => c[0] as Record<string, unknown>);

describe("planPopup：判定", () => {
  it("opener 有录制器手势 → 放行（返回票）", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    env.created[0].recorderGesture = true;
    const ticket = env.session.planPopup({ url: "https://idp.example/auth", openerTabId: "t1" });
    expect(ticket).not.toBeNull();
    expect(env.created[0].gestureArgs).toContain(PAGE_TAB_GESTURE_MS);
  });

  it("opener 只有 input-event 手势（AI 的 CDP 点击 / 真实输入，录制器事件还在路上）→ 同样放行", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    env.created[0].trustedInput = true;
    expect(env.session.planPopup({ url: "https://idp.example/auth", openerTabId: "t1" })).not.toBeNull();
    expect(env.created[0].trustedArgs).toContain(PAGE_TAB_GESTURE_MS);
  });

  it("无手势（脚本自己 window.open）→ null，且不吃限流配额、不占名额", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    for (let i = 0; i < 10; i++) expect(env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" })).toBeNull();
    expect(env.session.popupTickets.size).toBe(0);
    expect(env.session.pageTabTimes.size).toBe(0);
    // 之后一次有手势的请求不受之前无手势请求影响
    env.created[0].recorderGesture = true;
    expect(env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" })).not.toBeNull();
  });

  it("opener 不在会话里（已关 / 伪造的 tabId）→ null", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    env.created[0].recorderGesture = true;
    expect(env.session.planPopup({ url: "https://x.example/", openerTabId: "t99" })).toBeNull();
    expect(env.session.planPopup({ url: "https://x.example/", openerTabId: undefined as never })).toBeNull();
  });

  it("会话已销毁 → null", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    env.created[0].recorderGesture = true;
    env.session.destroy();
    expect(env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" })).toBeNull();
  });

  it("超上限：已有 tab + 已预留的票 ≥ maxTabs → null（票也占名额）", async () => {
    const env = makeEnv({ maxTabs: 5 });
    for (let i = 0; i < 3; i++) await env.session.openTab({});
    env.created[0].recorderGesture = true;
    const a = env.session.planPopup({ url: "https://a.example/", openerTabId: "t1" }); // 3 tab + 0 票 → 放
    expect(a).not.toBeNull();
    const b = env.session.planPopup({ url: "https://b.example/", openerTabId: "t1" }); // 3 + 1 票 = 4 < 5 → 放
    expect(b).not.toBeNull();
    expect(env.session.planPopup({ url: "https://c.example/", openerTabId: "t1" })).toBeNull(); // 3 + 2 票 = 5 → 拒
    a!.release();
    expect(env.session.planPopup({ url: "https://c.example/", openerTabId: "t1" })).not.toBeNull(); // 还票后又有名额
  });

  it("限流：窗口内最多 PAGE_TAB_MAX_PER_WINDOW 个，超出 → null；窗口过后恢复；按 opener 分桶", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    await env.session.openTab({});
    env.created[0].recorderGesture = true;
    env.created[1].recorderGesture = true;
    expect(PAGE_TAB_MAX_PER_WINDOW).toBe(3);
    for (let i = 0; i < PAGE_TAB_MAX_PER_WINDOW; i++) {
      const t = env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" });
      expect(t, `第 ${i + 1} 个`).not.toBeNull();
      t!.release(); // 还票不还配额
    }
    expect(env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" })).toBeNull();
    // 另一个 opener 的配额独立
    expect(env.session.planPopup({ url: "https://x.example/", openerTabId: "t2" })).not.toBeNull();
    env.clock.t += PAGE_TAB_WINDOW_MS;
    expect(env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" })).not.toBeNull();
  });

  it("手势只读 opener 自己：别的 tab 有手势不能给 opener 背书", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    await env.session.openTab({});
    env.created[1].recorderGesture = true;
    env.created[1].trustedInput = true;
    expect(env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" })).toBeNull();
  });

  it("钩子形状：不抛——tab 的 hadRecentGesture 抛错也只是返回 null", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    env.created[0].hadRecentGesture = () => {
      throw new Error("boom");
    };
    expect(() => env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" })).not.toThrow();
    expect(env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" })).toBeNull();
  });

  it("tab 钩子 onPopupRequest 接到 planPopup（tab.mjs 的 setWindowOpenHandler 调的就是它）", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    env.created[0].recorderGesture = true;
    const hook = env.hooksOf.t1.onPopupRequest;
    expect(typeof hook).toBe("function");
    expect(hook({ url: "https://x.example/", openerTabId: "t1" })).not.toBeNull();
    env.created[0].recorderGesture = false;
    expect(hook({ url: "https://x.example/", openerTabId: "t1" })).toBeNull();
  });
});

describe("预留票：占名额 / TTL / 销毁", () => {
  it("票占名额：openTab 也要把票算进上限（刚放行一个弹窗、紧接着 AI 开新标签不能把总数顶过上限）", async () => {
    const env = makeEnv({ maxTabs: 5 });
    for (let i = 0; i < 4; i++) await env.session.openTab({});
    env.created[0].recorderGesture = true;
    const ticket = env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" });
    expect(ticket).not.toBeNull();
    await expect(env.session.openTab({})).rejects.toMatchObject({ code: "BAD_ARGS" });
    ticket!.release();
    await expect(env.session.openTab({})).resolves.toBeDefined();
  });

  it("TTL 到期自动还票（handler 之后弹窗被取消、createWindow 永远不来也不会永久占名额）", async () => {
    const env = makeEnv({ maxTabs: 5 });
    for (let i = 0; i < 4; i++) await env.session.openTab({});
    env.created[0].recorderGesture = true;
    expect(env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" })).not.toBeNull();
    expect(env.session.popupTickets.size).toBe(1);
    const timer = env.timers.find((t) => t.ms === POPUP_TICKET_TTL_MS);
    expect(timer).toBeDefined();
    env.fire(POPUP_TICKET_TTL_MS);
    expect(env.session.popupTickets.size).toBe(0);
    await expect(env.session.openTab({})).resolves.toBeDefined();
  });

  it("收养时清掉票的定时器；release 幂等", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    env.created[0].recorderGesture = true;
    const ticket = env.session.planPopup({ url: "https://idp.example/auth", openerTabId: "t1" })!;
    const timer = env.timers.find((t) => t.ms === POPUP_TICKET_TTL_MS)!;
    ticket.adopt(fakeWc());
    expect(timer.cleared).toBe(true);
    expect(env.session.popupTickets.size).toBe(0);
    expect(() => {
      ticket.release();
      ticket.release();
    }).not.toThrow();
  });

  it("会话销毁：所有未收养的票被还掉、定时器清掉；之后迟到的 adopt 抛 NO_SESSION（tab 的 createWindow 回调会兜住）", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    env.created[0].recorderGesture = true;
    const ticket = env.session.planPopup({ url: "https://idp.example/auth", openerTabId: "t1" })!;
    const timer = env.timers.find((t) => t.ms === POPUP_TICKET_TTL_MS)!;
    env.session.destroy();
    expect(env.session.popupTickets.size).toBe(0);
    expect(timer.cleared).toBe(true);
    expect(() => ticket.adopt(fakeWc())).toThrowError(expect.objectContaining({ code: "NO_SESSION" }));
  });
});

describe("openPopupTab：收养成会话里的 tab", () => {
  const withPopup = async (env: ReturnType<typeof makeEnv>, openerPartition?: string) => {
    // t1 = opener（可带 partition）；经 host.createTab 建，partition 由测试直接设到 fake tab 上
    await env.session.openTab({});
    if (openerPartition) env.created[0].partition = openerPartition;
    env.created[0].recorderGesture = true;
    const ticket = env.session.planPopup({ url: "https://idp.example/auth?x=1", openerTabId: "t1" })!;
    return ticket;
  };

  it("createTab 被调用时带 adopt.webContents，并继承 opener 的 partition", async () => {
    const env = makeEnv();
    const ticket = await withPopup(env);
    const wc = fakeWc();
    const tab = ticket.adopt(wc) as PTab;
    const call = env.createCalls.at(-1)!;
    expect(call.adopt).toEqual({ webContents: wc });
    expect("partition" in call).toBe(true);
    expect(call.partition).toBeUndefined(); // opener 没有显式 partition（走默认持久档案）
    expect(tab.id).toBe("t2");
  });

  it("opener 是无痕标签 → 弹窗继承它的内存 partition（登录态不外泄也不丢）", async () => {
    const env = makeEnv();
    const part = "flowship-incognito-task1-t1-7";
    const ticket = await withPopup(env, part);
    ticket.adopt(fakeWc());
    expect(env.createCalls.at(-1)!.partition).toBe(part);
    expect(env.created.at(-1)!.partition).toBe(part);
  });

  it("opener / popup 标记；计入 tabs；opener 是前台（手势已是放行前提）→ 弹窗抢占激活", async () => {
    const env = makeEnv();
    const ticket = await withPopup(env);
    expect(env.session.activeTabId).toBe("t1");
    const tab = ticket.adopt(fakeWc()) as PTab;
    expect(tab.opener).toBe("t1");
    expect(tab.popup).toBe(true);
    expect(env.session.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(env.session.activeTabId).toBe("t2");
  });

  it("opener 是后台 tab → 弹窗静默开在后台，不抢用户正在看的 tab", async () => {
    const env = makeEnv();
    await env.session.openTab({}); // t1
    await env.session.openTab({}); // t2（激活）
    env.created[0].recorderGesture = true; // t1 在后台有手势（后台 tab 里的脚本 / 过期手势）
    const ticket = env.session.planPopup({ url: "https://idp.example/auth", openerTabId: "t1" })!;
    expect(env.session.activeTabId).toBe("t2");
    ticket.adopt(fakeWc());
    expect(env.session.activeTabId).toBe("t2");
    expect(env.session.tabs.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("写一条 tab_open 活动日志（带 URL 与「保留 opener」说明）", async () => {
    const env = makeEnv();
    const ticket = await withPopup(env);
    env.activityLog.addSystem.mockClear();
    ticket.adopt(fakeWc());
    const open = sysLog(env).find((e) => e.kind === "tab_open");
    expect(open).toMatchObject({ kind: "tab_open", tabId: "t2", url: "https://idp.example/auth?x=1" });
    expect(String(open!.summary)).toContain("弹窗");
    expect(String(open!.summary)).toContain("opener");
  });

  it("AI 驱动期间诞生的弹窗：按当前控制权上锁；tab_open 日志被「AI 自己造成」的静默规则吞掉", async () => {
    const env = makeEnv();
    const ticket = await withPopup(env);
    env.session.controller = "ai";
    env.activityLog.addSystem.mockClear();
    const tab = ticket.adopt(fakeWc()) as PTab;
    expect(tab.setInputIgnored).toHaveBeenCalledWith(true);
    expect(sysLog(env).filter((e) => e.kind === "tab_open")).toHaveLength(0);
  });

  it("下载令牌：弹窗初始 URL 记成浏览器侧发起（与 E1 路径里 tab.navigate(url) 等价）", async () => {
    const env = makeEnv();
    const ticket = await withPopup(env);
    const tab = ticket.adopt(fakeWc()) as PTab;
    expect(tab.noteBrowserInitiatedLoad).toHaveBeenCalledWith("https://idp.example/auth?x=1");
  });

  it("不 navigate：收养的弹窗初始导航由 Chromium 负责", async () => {
    const env = makeEnv();
    const ticket = await withPopup(env);
    const tab = ticket.adopt(fakeWc()) as PTab;
    expect(tab.navigate).not.toHaveBeenCalled();
  });

  it("收养瞬间超上限（票已过期、其间被别的 tab 占满）→ 抛 BAD_ARGS，不建 tab", async () => {
    const env = makeEnv({ maxTabs: 5 });
    for (let i = 0; i < 4; i++) await env.session.openTab({});
    env.created[0].recorderGesture = true;
    const ticket = env.session.planPopup({ url: "https://x.example/", openerTabId: "t1" })!;
    env.fire(POPUP_TICKET_TTL_MS); // 票过期
    await env.session.openTab({}); // 名额被别人拿走（现在 5 个）
    const before = env.createCalls.length;
    expect(() => ticket.adopt(fakeWc())).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
    expect(env.createCalls.length).toBe(before);
    expect(env.session.tabs).toHaveLength(5);
  });

  it("收养瞬间 opener 已被关掉 → 抛 TAB_NOT_FOUND，不建 tab（没有 opener 就不能继承 partition）", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    await env.session.openTab({});
    env.created[1].recorderGesture = true;
    const ticket = env.session.planPopup({ url: "https://x.example/", openerTabId: "t2" })!;
    await env.session.closeTab("t2");
    const before = env.createCalls.length;
    expect(() => ticket.adopt(fakeWc())).toThrowError(expect.objectContaining({ code: "TAB_NOT_FOUND" }));
    expect(env.createCalls.length).toBe(before);
  });

  it("host.createTab 抛错（wc 偏好不安全等）→ 异常原样上抛、会话里不留半个 tab、票已还", async () => {
    const env = makeEnv();
    const ticket = await withPopup(env);
    const orig = env.host.createTab;
    env.host.createTab = (() => {
      throw new Error("偏好不安全");
    }) as never;
    expect(() => ticket.adopt(fakeWc())).toThrowError("偏好不安全");
    env.host.createTab = orig;
    expect(env.session.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(env.session.popupTickets.size).toBe(0);
  });
});

describe("弹窗关闭（window.close()）与激活回退", () => {
  it("激活的弹窗被页面关闭 → 回到 opener，而不是随便一个邻居", async () => {
    const env = makeEnv();
    await env.session.openTab({}); // t1
    await env.session.openTab({}); // t2（无关的邻居）
    env.session.selectTab("t1");
    env.created[0].recorderGesture = true;
    const popup = env.session.planPopup({ url: "https://idp.example/auth", openerTabId: "t1" })!.adopt(fakeWc()) as PTab;
    expect(env.session.activeTabId).toBe(popup.id); // t3
    env.hooksOf[popup.id].onGone({ hostGone: false });
    await vi.waitFor(() => expect(env.session.tabs.map((t) => t.id)).toEqual(["t1", "t2"]));
    expect(env.session.activeTabId).toBe("t1");
  });

  it("日志：页面关闭弹窗写 tab_close（force，不被 AI 静默吞掉）", async () => {
    const env = makeEnv();
    await env.session.openTab({});
    env.created[0].recorderGesture = true;
    const popup = env.session.planPopup({ url: "https://idp.example/auth", openerTabId: "t1" })!.adopt(fakeWc()) as PTab;
    env.session.controller = "ai";
    env.activityLog.addSystem.mockClear();
    env.hooksOf[popup.id].onGone({ hostGone: false });
    await vi.waitFor(() => expect(sysLog(env).some((e) => e.kind === "tab_close")).toBe(true));
  });

  it("对照：普通（非弹窗）tab 关闭仍按邻居激活规则，不受 popup 回退影响", async () => {
    const env = makeEnv();
    await env.session.openTab({}); // t1
    await env.session.openTab({}); // t2
    await env.session.openTab({}); // t3（激活）
    await env.session.closeTab("t3");
    expect(env.session.activeTabId).toBe("t2");
  });

  it("opener 已不在 → 回退到常规邻居（不抛）", async () => {
    const env = makeEnv();
    await env.session.openTab({}); // t1
    await env.session.openTab({}); // t2
    env.session.selectTab("t2");
    env.created[1].recorderGesture = true;
    const popup = env.session.planPopup({ url: "https://idp.example/auth", openerTabId: "t2" })!.adopt(fakeWc()) as PTab; // t3，激活
    await env.session.closeTab("t2"); // opener 先被关（t3 仍激活）
    expect(env.session.activeTabId).toBe(popup.id);
    await env.session.closeTab(popup.id);
    expect(env.session.activeTabId).toBe("t1");
  });
});
