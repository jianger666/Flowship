/**
 * BrowserSession（electron-app/browser/session.mjs）单测：契约 §6 控制权状态机 + §5 BrowserState。
 * 假 tab + 假 host + 手动假定时器（注入 now/setTimeoutFn/clearTimeoutFn），不碰 electron、不等真实时间。
 */
import { describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";
import { AI_GRACE_MS, BrowserSession, normalizeBounds } from "../electron-app/browser/session.mjs";

const flush = () => new Promise<void>((r) => setImmediate(r));

/** getState().recent 条目的形状（.mjs 侧推断为 any[]，测试里按契约 §4.4 给精确类型） */
type RecentEntry = { id: number; actor: string; kind: string };

/** 手动时钟：advance 按到期顺序触发定时器 */
const makeClock = (start = 1_000) => {
  let nowVal = start;
  let seq = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => nowVal,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { fn, at: nowVal + ms });
      return id as never;
    },
    clearTimeoutFn: (id: never) => {
      timers.delete(id as number);
    },
    advance: (ms: number) => {
      const target = nowVal + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        nowVal = due[1].at;
        due[1].fn();
      }
      nowVal = target;
    },
    pendingTimers: () => timers.size,
  };
};

class FakeTab {
  ready = Promise.resolve();
  opener: string | null = null;
  /** 页面发起新窗口时 session 问「opener 最近有没有真实手势」（R2-06）；默认有，旧用例保持「立刻前台新标签」的语义 */
  hadRecentGesture = vi.fn<(withinMs: number) => boolean>(() => true);
  destroyedFlag = false;
  url = "https://example.com/page";
  title = "示例页";
  navigate = vi.fn(async () => ({ url: this.url, title: this.title, status: 200 }));
  destroy = vi.fn(() => {
    this.destroyedFlag = true;
  });
  setInputIgnored = vi.fn(async () => {});
  /** ops/input.mjs 在 AI 按下鼠标键后挂到 tab 上的释放入口（R2-08）；session 在接管 / 请用户协助 / 取消时调用 */
  releaseHeldButtons = vi.fn(async () => {});
  overlaySetActive = vi.fn(async () => {});
  overlayHide = vi.fn(async () => {});
  moveToMain = vi.fn();
  moveToParking = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
  capturePlaceholder = vi.fn(async () => "data:image/jpeg;base64,FAKE");
  constructor(public id: string) {}
  info(isActive: boolean) {
    return {
      id: this.id,
      url: this.destroyedFlag ? "" : this.url,
      title: this.title,
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive,
    };
  }
}

const makeSession = () => {
  const clock = makeClock();
  const activityLog = createActivityLog();
  const mainWin = { name: "main" };
  const parkingWin = { name: "parking" };
  let mainAvailable = true;
  const pickerCallbacks: Array<{ onPicked: (p: Record<string, unknown>) => void; onEnd: () => void }> = [];
  const pickerHandle = { cancel: vi.fn() };
  const created: FakeTab[] = [];
  const host = {
    createTab: ({ id }: { id: string }) => {
      const t = new FakeTab(id);
      created.push(t);
      return t;
    },
    getMainWindow: () => (mainAvailable ? mainWin : null),
    getParkingWindow: () => parkingWin,
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: (_tab: unknown, cb: never) => {
      pickerCallbacks.push(cb);
      return pickerHandle;
    },
  };
  const session = new BrowserSession({
    taskId: "task1",
    host: host as never,
    activityLog,
    graceMs: 8_000,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn as never,
    clearTimeoutFn: clock.clearTimeoutFn as never,
  });
  return {
    session,
    clock,
    activityLog,
    host,
    created,
    mainWin,
    parkingWin,
    pickerCallbacks,
    pickerHandle,
    setMainAvailable: (v: boolean) => {
      mainAvailable = v;
    },
  };
};

const userClick = (ts: number, name = "提交") => ({
  type: "click",
  ts,
  tabId: "t1",
  url: "https://example.com/page",
  target: { tag: "button", role: "button", name },
});

describe("新标签页的归因：页面自己开的窗口 vs 用户在右键菜单里点的「在新标签页打开」", () => {
  const setup = () => {
    const hooksOf: Record<string, { onNewTab: (info: Record<string, unknown>) => void }> = {};
    const host = {
      createTab: ({ id, hooks }: { id: string; hooks: { onNewTab: (info: Record<string, unknown>) => void } }) => {
        hooksOf[id] = hooks;
        return new FakeTab(id);
      },
      getMainWindow: () => ({}),
      getParkingWindow: () => ({}),
      onChange: vi.fn(),
      emitEvent: vi.fn(),
      emitPicked: vi.fn(),
      startPicker: vi.fn(),
    };
    const clock = makeClock();
    const session = new BrowserSession({
      taskId: "task1",
      host: host as never,
      activityLog: createActivityLog(),
      graceMs: 8_000,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn as never,
      clearTimeoutFn: clock.clearTimeoutFn as never,
    });
    return { session, hooksOf };
  };
  const tabOpenSummaries = (session: BrowserSession) =>
    (session.getState().recent as Array<{ kind: string; summary?: string }>).filter((e) => e.kind === "tab_open").map((e) => e.summary ?? "");

  it("页面 window.open → 日志写「页面打开了新标签页」；用户右键菜单（byUser）→ 写「打开了新标签页」，不能把用户的操作记成页面干的", async () => {
    const { session, hooksOf } = setup();
    await session.openTab({}); // t1：新标签的发起者
    const before = tabOpenSummaries(session).length;
    hooksOf.t1.onNewTab({ url: "https://a.test/x", disposition: "foreground-tab", openerTabId: "t1" });
    await flush();
    hooksOf.t1.onNewTab({ url: "https://b.test/y", disposition: "foreground-tab", openerTabId: "t1", byUser: true });
    await flush();
    const added = tabOpenSummaries(session).slice(before);
    expect(added).toHaveLength(2);
    expect(added[0]).toMatch(/^页面打开了新标签页/);
    expect(added[1]).toMatch(/^打开了新标签页/);
    expect(added[1]).not.toContain("页面");
  });
});

describe("初始状态与 getState 形状（契约 §5）", () => {
  it("idle 起步、getState 字段齐全", () => {
    const { session } = makeSession();
    expect(AI_GRACE_MS).toBe(8000);
    expect(session.getState()).toEqual({
      taskId: "task1",
      exists: true,
      controller: "idle",
      askRequest: null,
      aiLabel: null,
      aiLabelAt: null,
      activeTabId: null,
      tabs: [],
      attached: false,
      covered: false,
      picking: false,
      pendingUserActivity: 0,
      recent: [],
      // 契约 §14.4：主进程总是给默认值（类型上可选只是为了容忍老夹具 / 老壳）
      dialog: null,
      downloads: [],
      // 契约 §15.1：增强包 E2 的状态字段
      prompts: [],
      netRules: null,
      debug: null,
      recording: null,
    });
  });

  it("normalizeBounds 取整、负宽高夹到 0；NaN / 缺失抛 BAD_ARGS", () => {
    expect(normalizeBounds({ x: 1.4, y: 2.6, width: -5, height: 10.2 })).toEqual({ x: 1, y: 3, width: 0, height: 10 });
    expect(() => normalizeBounds({ x: Number.NaN, y: 0, width: 1, height: 1 })).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
    expect(() => normalizeBounds(null as never)).toThrowError(expect.objectContaining({ code: "BAD_ARGS" }));
  });
});

describe("控制权：idle → ai → 8 秒宽限 → idle", () => {
  it("动作开始置 ai 并上锁；结束后宽限期内仍是 ai，到点回 idle 并解锁", async () => {
    const { session, clock, created } = makeSession();
    await session.openTab({});
    const tab = created[0];
    let inside = "";
    await session.runAction({ op: "click" }, async () => {
      inside = session.controller;
      return "ok";
    });
    expect(inside).toBe("ai");
    expect(tab.setInputIgnored).toHaveBeenCalledWith(true);
    // 动作结束进入宽限：还没回 idle
    expect(session.controller).toBe("ai");
    clock.advance(7_999);
    expect(session.controller).toBe("ai");
    clock.advance(1);
    expect(session.controller).toBe("idle");
    expect(tab.setInputIgnored).toHaveBeenLastCalledWith(false);
    await flush(); // #lockAll 是异步的：overlayHide 在 setInputIgnored 的 await 之后才调
    expect(tab.overlayHide).toHaveBeenCalled();
  });

  it("宽限期内又有动作则续期：从第二个动作结束重新计 8 秒", async () => {
    const { session, clock } = makeSession();
    await session.openTab({});
    await session.runAction({ op: "click" }, async () => 1);
    clock.advance(4_000);
    await session.runAction({ op: "click" }, async () => 2);
    clock.advance(7_999);
    expect(session.controller).toBe("ai");
    clock.advance(1);
    expect(session.controller).toBe("idle");
  });

  it("runAction 串行：后一个动作等前一个结束才开始", async () => {
    const { session } = makeSession();
    await session.openTab({});
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p1 = session.runAction({ op: "a" }, async () => {
      order.push("a-start");
      await gate;
      order.push("a-end");
    });
    const p2 = session.runAction({ op: "b" }, async () => {
      order.push("b-start");
    });
    await flush();
    expect(order).toEqual(["a-start"]);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("一个动作失败不卡住后续动作，且失败原样上抛", async () => {
    const { session } = makeSession();
    await session.openTab({});
    await expect(
      session.runAction({ op: "click" }, async () => {
        throw new Error("点炸了");
      }),
    ).rejects.toThrow("点炸了");
    await expect(session.runAction({ op: "click" }, async () => "下一个照常")).resolves.toBe("下一个照常");
  });

  it("describe 记 aiLabel 与 AI 活动条目", async () => {
    const { session } = makeSession();
    await session.openTab({});
    await session.runAction({ op: "click" }, async (ctx) => {
      (ctx as { describe: (d: unknown) => void }).describe({ kind: "click", label: "点击 按钮「登录」", summary: "点击 按钮「登录」" });
    });
    expect(session.getState().aiLabel).toBe("点击 按钮「登录」");
    expect(session.getState().recent.some((e: RecentEntry) => e.actor === "ai")).toBe(true);
  });
});

describe("控制权：user 接管", () => {
  it("controller==='user' 时动作类直接 USER_CONTROL 且 fn 不执行", async () => {
    const { session } = makeSession();
    await session.openTab({});
    session.takeover();
    const fn = vi.fn(async () => 1);
    await expect(session.runAction({ op: "click" }, fn)).rejects.toMatchObject({ code: "USER_CONTROL" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("ask 挂起时 USER_CONTROL 用「按你的请求」文案，与普通接管不同", async () => {
    const { session } = makeSession();
    await session.openTab({});
    const askP = session.askUserToAct({ message: "请登录", timeoutMs: 60_000, signal: undefined });
    const err1 = await session.runAction({ op: "click" }, async () => 1).catch((e: BrowserError) => e);
    expect(err1.code).toBe("USER_CONTROL");
    expect(err1.message).toContain("按你的请求");
    session.answerAsk("done");
    await askP;

    session.takeover();
    const err2 = await session.runAction({ op: "click" }, async () => 1).catch((e: BrowserError) => e);
    expect(err2.code).toBe("USER_CONTROL");
    expect(err2.message).toContain("接管");
    expect(err2.message).not.toContain("按你的请求");
  });

  it("takeover 打断进行中的动作（USER_TOOK_OVER）、解锁并记 takeover 条目", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    const p = session.runAction({ op: "click" }, () => new Promise(() => {})); // 永不结束，靠 abort 打断
    await flush();
    expect(session.controller).toBe("ai");
    session.takeover();
    await expect(p).rejects.toMatchObject({ code: "USER_TOOK_OVER" });
    expect(session.controller).toBe("user");
    expect(created[0].setInputIgnored).toHaveBeenLastCalledWith(false);
    expect(session.getState().recent.some((e: RecentEntry) => e.kind === "takeover")).toBe(true);
    // 已是 user 时重复 takeover 不重复记条目
    const n = session.getState().recent.filter((e: RecentEntry) => e.kind === "takeover").length;
    session.takeover();
    expect(session.getState().recent.filter((e: RecentEntry) => e.kind === "takeover")).toHaveLength(n);
  });
});

describe("R2-08 释放 AI 按下的鼠标键", () => {
  it("takeover：对每个 tab 调 releaseHeldButtons（即使此刻没有在途动作）；已是 user 时重复接管不再调", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    await session.openTab({});
    session.takeover();
    expect(created.map((t) => t.releaseHeldButtons.mock.calls.length)).toEqual([1, 1]);
    session.takeover();
    expect(created.map((t) => t.releaseHeldButtons.mock.calls.length)).toEqual([1, 1]);
  });

  it("askUserToAct（请用户协助）：调；cancelWaits（任务被停）：无 ask 也调", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    session.cancelWaits();
    expect(created[0].releaseHeldButtons).toHaveBeenCalledTimes(1);
    const p = session.askUserToAct({ message: "请登录", timeoutMs: 60_000, signal: undefined });
    expect(created[0].releaseHeldButtons).toHaveBeenCalledTimes(2);
    session.answerAsk("done");
    await p;
  });

  it("宽限期到期不释放：模型两次调用的间隔常超过 8 秒，释放会破坏 down → move → up（空闲 TTL 另行兜底）", async () => {
    const { session, clock, created } = makeSession();
    await session.openTab({});
    await session.runAction({ op: "mouse" }, async () => "ok");
    clock.advance(9_000);
    expect(session.controller).toBe("idle");
    expect(created[0].releaseHeldButtons).not.toHaveBeenCalled();
  });

  it("releaseHeldButtons 同步抛错 / 返回 rejected promise 都不影响接管本身", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    await session.openTab({});
    created[0].releaseHeldButtons.mockImplementation(() => {
      throw new Error("tab 已销毁");
    });
    created[1].releaseHeldButtons.mockImplementation(async () => {
      throw new Error("CDP 断了");
    });
    expect(() => session.takeover()).not.toThrow();
    await flush();
    expect(session.controller).toBe("user");
  });

  it("ctx.isActive：动作进行中为 true，收尾后 / 被接管打断后为 false", async () => {
    const { session } = makeSession();
    await session.openTab({});
    let ctxRef: { isActive: () => boolean } | null = null;
    await session.runAction({ op: "click" }, async (ctx) => {
      ctxRef = ctx as never;
      expect((ctx as never as { isActive: () => boolean }).isActive()).toBe(true);
    });
    expect(ctxRef!.isActive()).toBe(false);

    let ctx2: { isActive: () => boolean } | null = null;
    const p = session.runAction({ op: "click" }, (ctx) => {
      ctx2 = ctx as never;
      return new Promise(() => {});
    });
    await flush();
    expect(ctx2!.isActive()).toBe(true);
    session.takeover();
    await expect(p).rejects.toMatchObject({ code: "USER_TOOK_OVER" });
    expect(ctx2!.isActive()).toBe(false);
  });
});

describe("handback", () => {
  it("回 idle、记 handback 条目、emitEvent 带未送达 entries 并推进游标（不重复送达）", async () => {
    const { session, host, activityLog } = makeSession();
    await session.openTab({});
    activityLog.ingest(userClick(2_000));
    session.takeover(); // 也产生一条 system 条目
    session.handback("  我登好了  ");
    expect(session.controller).toBe("idle");
    expect(host.emitEvent).toHaveBeenCalledTimes(1);
    const [name, taskId, data] = (host.emitEvent as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, { note: string; entries: Array<{ id: number; kind: string }> }];
    expect(name).toBe("handback");
    expect(taskId).toBe("task1");
    expect(data.note).toBe("我登好了");
    expect(data.entries.map((e) => e.kind)).toContain("click");
    expect(data.entries.map((e) => e.kind)).toContain("takeover");
    expect(data.entries.map((e) => e.kind)).not.toContain("handback"); // handback 本身不在自己的 entries 里
    expect(session.getState().pendingUserActivity).toBe(0);
    expect(session.getState().recent.some((e: RecentEntry) => e.kind === "handback")).toBe(true);

    // idle 时再 handback 是 no-op，不重复发事件
    session.handback("又一次");
    expect(host.emitEvent).toHaveBeenCalledTimes(1);

    // 第二轮：只有新条目被送达
    activityLog.ingest(userClick(3_000, "新按钮"));
    session.takeover();
    session.handback();
    const second = (host.emitEvent as ReturnType<typeof vi.fn>).mock.calls[1][2] as { entries: Array<{ id: number; kind: string }> };
    const firstIds = new Set(data.entries.map((e) => e.id));
    expect(second.entries.every((e) => !firstIds.has(e.id))).toBe(true);
    expect(second.entries.map((e) => e.kind)).toContain("click");
  });

  it("ask 挂起时 handback 等价于 answerAsk(done)，不发 handback 事件（防双重送达）", async () => {
    const { session, host } = makeSession();
    await session.openTab({});
    const askP = session.askUserToAct({ message: "请登录", timeoutMs: 60_000, signal: undefined });
    session.handback("登好了");
    await expect(askP).resolves.toMatchObject({ outcome: "done", note: "登好了" });
    expect(host.emitEvent).not.toHaveBeenCalledWith("handback", expect.anything(), expect.anything());
    expect(session.controller).toBe("idle");
  });
});

describe("askUserToAct", () => {
  it("done / skipped：置 user、getState 暴露 askRequest，答复后回 idle 并带 entries", async () => {
    const { session, activityLog } = makeSession();
    await session.openTab({});
    const p = session.askUserToAct({ message: "请完成登录", timeoutMs: 60_000, signal: undefined });
    expect(session.controller).toBe("user");
    expect(session.getState().askRequest).toEqual({ message: "请完成登录", since: 1_000 });
    activityLog.ingest(userClick(2_000));
    session.answerAsk("done", "好了");
    const r = await p;
    expect(r).toMatchObject({ outcome: "done", note: "好了" });
    expect(r.entries.map((e: { kind: string }) => e.kind)).toContain("click");
    expect(session.controller).toBe("idle");
    expect(session.getState().askRequest).toBeNull();

    const p2 = session.askUserToAct({ message: "再帮个忙", timeoutMs: 60_000, signal: undefined });
    session.answerAsk("skipped");
    await expect(p2).resolves.toMatchObject({ outcome: "skipped" });
  });

  it("timeout：到点以 timeout 返回并回 idle；timeoutMs 有下限钳制", async () => {
    const { session, clock } = makeSession();
    await session.openTab({});
    const p = session.askUserToAct({ message: "请操作", timeoutMs: 10, signal: undefined }); // 被钳到至少 1000ms
    let settled = false;
    void p.then(() => (settled = true));
    clock.advance(999);
    await flush();
    expect(settled).toBe(false);
    clock.advance(1);
    await expect(p).resolves.toMatchObject({ outcome: "timeout" });
    expect(session.controller).toBe("idle");
    expect(session.getState().askRequest).toBeNull();
  });

  it("cancelWaits：挂起 ask 以 CANCELLED 拒绝、清 askRequest、回 idle；无 ask 时 no-op", async () => {
    const { session } = makeSession();
    await session.openTab({});
    session.cancelWaits(); // 无 ask 不抛
    const p = session.askUserToAct({ message: "请操作", timeoutMs: 60_000, signal: undefined });
    session.cancelWaits();
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    expect(session.getState().askRequest).toBeNull();
    expect(session.controller).toBe("idle");
  });

  it("外部 signal abort：以该 reason 拒绝并回 idle；新 ask 顶替旧 ask（旧的 cancelled 返回）", async () => {
    const { session } = makeSession();
    await session.openTab({});
    const ac = new AbortController();
    const p = session.askUserToAct({ message: "甲", timeoutMs: 60_000, signal: ac.signal });
    ac.abort(new BrowserError("CANCELLED", "轮次停了"));
    await expect(p).rejects.toMatchObject({ code: "CANCELLED", message: "轮次停了" });
    expect(session.controller).toBe("idle");

    const old = session.askUserToAct({ message: "旧", timeoutMs: 60_000, signal: undefined });
    const fresh = session.askUserToAct({ message: "新", timeoutMs: 60_000, signal: undefined });
    await expect(old).resolves.toMatchObject({ outcome: "cancelled", entries: [] });
    expect(session.getState().askRequest?.message).toBe("新");
    session.answerAsk("done");
    await expect(fresh).resolves.toMatchObject({ outcome: "done" });
  });
});

describe("tab 管理", () => {
  it("openTab 编号 t1/t2…、默认激活；带 url 时等 ready 后 navigate", async () => {
    const { session, created } = makeSession();
    const t1 = await session.openTab({ url: "https://a.example/" });
    expect(t1.id).toBe("t1");
    await flush();
    expect(created[0].navigate).toHaveBeenCalledWith("https://a.example/");
    const t2 = await session.openTab({ activate: false });
    expect(t2.id).toBe("t2");
    expect(session.activeTabId).toBe("t1");
    expect(session.listTabs().map((t) => [t.id, t.isActive])).toEqual([
      ["t1", true],
      ["t2", false],
    ]);
  });

  it("selectTab 切换激活；找不到抛 TAB_NOT_FOUND", async () => {
    const { session } = makeSession();
    await session.openTab({});
    await session.openTab({});
    session.selectTab("t1");
    expect(session.activeTabId).toBe("t1");
    expect(() => session.selectTab("t99")).toThrowError(expect.objectContaining({ code: "TAB_NOT_FOUND" }));
    expect(() => session.getTab("t99")).toThrowError(expect.objectContaining({ code: "TAB_NOT_FOUND" }));
    await expect(session.closeTab("t99")).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
  });

  it("关非激活 tab 不动激活；关激活 tab 激活相邻的；关最后一个自动补空白 tab", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    await session.openTab({});
    await session.openTab({});
    session.selectTab("t2");
    await session.closeTab("t1"); // 关非激活
    expect(session.activeTabId).toBe("t2");
    await session.closeTab("t2"); // 关激活（中间）→ 激活原后面的 t3
    expect(session.activeTabId).toBe("t3");
    expect(created[1].destroy).toHaveBeenCalled();
    await session.closeTab("t3"); // 关最后一个 → 自动补一个
    expect(session.listTabs()).toHaveLength(1);
    expect(session.activeTabId).toBe("t4");
    expect(session.getState().recent.some((e: RecentEntry) => e.kind === "tab_close")).toBe(true);
  });
});

describe("视图挂载：attach / setBounds / detach / setCovered", () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };

  it("attach 把激活 tab 搬到主窗；setBounds 跟随；detach 全部搬回停车场", async () => {
    const { session, created, mainWin, parkingWin } = makeSession();
    await session.openTab({});
    await session.openTab({});
    session.attach(bounds);
    expect(session.attached).toBe(true);
    expect(created[1].moveToMain).toHaveBeenCalledWith(mainWin, bounds, true);
    const b2 = { x: 10, y: 10, width: 400, height: 300 };
    session.setBounds(b2);
    expect(created[1].setBounds).toHaveBeenCalledWith(b2);
    session.detach();
    expect(session.attached).toBe(false);
    for (const t of created) expect(t.moveToParking).toHaveBeenCalledWith(parkingWin);
  });

  it("covered 时 attach 不得重新显示视图；setCovered 截图占位、恢复返回 null", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    const tab = created[0];
    session.attach(bounds);
    const img = await session.setCovered(true);
    expect(img).toBe("data:image/jpeg;base64,FAKE");
    expect(session.covered).toBe(true);
    expect(tab.setVisible).toHaveBeenLastCalledWith(false);
    // covered 期间再 attach：moveToMain 的 visible 必须是 false
    session.attach(bounds);
    expect(tab.moveToMain).toHaveBeenLastCalledWith(expect.anything(), bounds, false);
    await expect(session.setCovered(false)).resolves.toBeNull();
    expect(tab.setVisible).toHaveBeenLastCalledWith(true);
    // detach 后 covered 被清掉
    await session.setCovered(true);
    session.detach();
    expect(session.covered).toBe(false);
  });

  it("主窗口不存在时 attach 不置 attached；未 attach 时 setCovered 返回 null", async () => {
    const { session, setMainAvailable } = makeSession();
    await session.openTab({});
    await expect(session.setCovered(true)).resolves.toBeNull();
    setMainAvailable(false);
    session.attach(bounds);
    expect(session.attached).toBe(false);
  });
});

describe("元素拾取", () => {
  it("startPick / onPicked 推给渲染进程并记条目 / cancelPick 调 handle.cancel", async () => {
    const { session, host, pickerCallbacks, pickerHandle } = makeSession();
    await session.openTab({});
    expect(session.startPick()).toBe(true);
    expect(session.getState().picking).toBe(true);
    expect(session.startPick()).toBe(false); // 已在拾取中
    pickerCallbacks[0].onPicked({ url: "https://example.com/page", name: "登录按钮" });
    expect(host.emitPicked).toHaveBeenCalledWith("task1", expect.objectContaining({ name: "登录按钮" }));
    expect(session.getState().picking).toBe(false);
    expect(session.getState().recent.some((e: RecentEntry) => e.kind === "pick")).toBe(true);

    expect(session.startPick()).toBe(true);
    session.cancelPick();
    expect(pickerHandle.cancel).toHaveBeenCalled();
    expect(session.getState().picking).toBe(false);
  });

  it("无 tab 时 startPick 返回 false", () => {
    const { session } = makeSession();
    expect(session.startPick()).toBe(false);
  });
});

describe("destroy", () => {
  it("销毁 tab、挂起 ask 以 CANCELLED 结束、幂等；销毁后 runAction 报 NO_SESSION", async () => {
    const { session, created } = makeSession();
    await session.openTab({});
    const askP = session.askUserToAct({ message: "请操作", timeoutMs: 60_000, signal: undefined });
    session.destroy();
    await expect(askP).rejects.toMatchObject({ code: "CANCELLED" });
    expect(created[0].destroy).toHaveBeenCalledTimes(1);
    session.destroy(); // 幂等
    expect(created[0].destroy).toHaveBeenCalledTimes(1);
    await expect(session.runAction({ op: "click" }, async () => 1)).rejects.toMatchObject({ code: "NO_SESSION" });
  });
});
