/**
 * R6-09：调试器暂停态不能只靠 `Debugger.resumed` 清——崩溃 / 换进程导航 / debugger detach / resume 失败 / tab 关闭后
 * `tab.debugPause` 都必须被清掉并留一条（脱敏的）系统活动日志，清后 tab 不再被入口闸门锁住；闸门自带「兜底超时」。
 * 假 tab（带 addContextLostHook）+ 假 CDP：与 browser-e2-p8-op.test.ts 同一套假件，只多了「页面上下文失效」事件。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 假 CDP / 假 session 的松散形状，只在本测试里用 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { PAUSE_GATE_STALE_MS, livePause } from "../electron-app/browser/debug-policy.mjs";
import { createHandlers, debugPauseGate, normalize } from "../electron-app/browser/ops/debug.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";

type Ev = (method: string, params: Record<string, unknown>, sid: string | null) => void;

const SCRIPT = { scriptId: "s1", url: "https://site.test/app.js?token=SECRETTOKEN1234567890", startLine: 0, startColumn: 0, endLine: 20, endColumn: 0 };
const frame = () => ({ callFrameId: "f0", functionName: "compute", location: { scriptId: "s1", lineNumber: 5, columnNumber: 4 }, scopeChain: [] });

const makeTab = () => {
  const listeners = new Set<Ev>();
  const lost = new Set<(r: string) => void>();
  const ext = new Map<string, { dispose?: () => void }>();
  const emit: Ev = (m, p, s) => [...listeners].forEach((l) => l(m, p, s));
  const sent: string[] = [];
  const tab: Record<string, any> = {
    id: "t1",
    url: "https://site.test/page",
    destroyed: false,
    debugPause: undefined as unknown,
    ext,
    sent,
    /** 测试开关：让指定命令失败（模拟会话已失效 / 目标已死） */
    failOn: new Set<string>(),
    send: vi.fn(async (method: string) => {
      sent.push(method);
      if (tab.failOn.has(method)) throw new BrowserError("INTERNAL", `${method} 失败 token=SECRETTOKEN1234567890`);
      if (method === "Debugger.enable") emit("Debugger.scriptParsed", SCRIPT, null);
      else if (method === "Debugger.resume") emit("Debugger.resumed", {}, null);
      return {};
    }),
    onCdpEvent: (fn: Ev) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    addSessionHook: () => () => {},
    addContextLostHook: (fn: (r: string) => void) => {
      lost.add(fn);
      return () => lost.delete(fn);
    },
    cdpSessionIds: () => [null],
    getExt: (key: string, factory: () => { dispose?: () => void }) => {
      if (!ext.has(key)) ext.set(key, factory());
      return ext.get(key)!;
    },
    fireLost: (reason: string) => [...lost].forEach((f) => f(reason)),
    destroy() {
      tab.destroyed = true;
      for (const e of ext.values()) e.dispose?.();
    },
    pausedAt: () => emit("Debugger.paused", { reason: "other", callFrames: [frame()], hitBreakpoints: [] }, null),
  };
  return tab;
};

const setup = () => {
  const tab = makeTab();
  const exts = new Map<string, unknown>();
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
  const registered = new Map<string, (s: unknown, ...a: unknown[]) => Promise<any>>();
  const scheduled: string[] = [];
  const handlers = createHandlers({
    requireSession: () => session,
    abortable: <T>(p: Promise<T>) => p,
    scheduleState: (t: string) => scheduled.push(t),
    addStateContributor: () => {},
    registerExt: (n: string, fn: (s: unknown, ...a: unknown[]) => Promise<any>) => registered.set(n, fn),
    sessions: () => [session],
    electron: {},
    log: vi.fn(),
  });
  const run = (args: Record<string, unknown>) => handlers.debug("task-1", normalize("debug", args, OP_HELPERS) as Record<string, unknown>);
  const sysLogs = () => session.activityLog.addSystem.mock.calls.map((c: any[]) => String(c[0].summary));
  return { tab, session, run, registered, scheduled, sysLogs };
};

const activate = async (s: ReturnType<typeof setup>) => {
  await s.run({ action: "pause_on_exception", state: "all" }); // ensureActive：挂 hub 订阅与上下文失效钩子
  s.tab.pausedAt();
  expect(s.tab.debugPause).toBeTruthy();
};

const gateBlocks = (s: ReturnType<typeof setup>) => {
  try {
    debugPauseGate(s.session as never, "click", { tabId: "t1" });
    return false;
  } catch (e) {
    return e instanceof BrowserError && e.code === "TIMEOUT";
  }
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("R6-09：上下文失效事件清暂停态", () => {
  it.each([
    ["crash", /页面进程崩溃/],
    ["navigate", /已导航到新文档/],
    ["detach", /调试连接已断开/],
  ])("%s：debugPause 被清、闸门解锁、写一条系统日志、推送状态", async (reason, label) => {
    const s = setup();
    await activate(s);
    expect(gateBlocks(s)).toBe(true);
    const before = s.scheduled.length;
    s.tab.fireLost(reason);
    expect(s.tab.debugPause).toBeNull();
    expect(gateBlocks(s)).toBe(false);
    expect(s.sysLogs().some((x: string) => label.test(x) && x.includes("暂停状态已清除"))).toBe(true);
    expect(s.scheduled.length).toBeGreaterThan(before);
    // 日志里没有 url 里的令牌
    expect(s.sysLogs().join("\n")).not.toContain("SECRETTOKEN");
  });

  it("没有暂停时事件无副作用（navigate 天天发，不能刷日志）", async () => {
    const s = setup();
    await s.run({ action: "pause_on_exception", state: "all" });
    const n = s.session.activityLog.addSystem.mock.calls.length;
    s.tab.fireLost("navigate");
    expect(s.session.activityLog.addSystem.mock.calls.length).toBe(n);
  });

  it("清掉后兜底定时器也撤了：到点不会再对已清的暂停发 resume", async () => {
    const s = setup();
    await activate(s);
    s.tab.fireLost("crash");
    s.tab.sent.length = 0;
    await vi.advanceTimersByTimeAsync(200_000);
    expect(s.tab.sent).not.toContain("Debugger.resume");
  });

  it("清掉后新的 Debugger.paused 仍能正常跟踪（不是永久失效）", async () => {
    const s = setup();
    await activate(s);
    s.tab.fireLost("navigate");
    s.tab.pausedAt();
    expect(s.tab.debugPause).toBeTruthy();
    expect(gateBlocks(s)).toBe(true);
  });

  it("tab 关闭（ext dispose）：暂停态被清并留痕", async () => {
    const s = setup();
    await activate(s);
    s.tab.destroy();
    expect(s.tab.debugPause).toBeNull();
    expect(s.sysLogs().some((x: string) => x.includes("标签页关闭时调试器仍处于暂停"))).toBe(true);
  });
});

describe("R6-09：resume 失败 → 强制清 + 尝试 Debugger.disable + 可读错误", () => {
  it("AI resume 抛错：debugPause 被清、闸门解锁、发了 Debugger.disable、错误可读且脱敏", async () => {
    const s = setup();
    await activate(s);
    s.tab.failOn.add("Debugger.resume");
    const err: any = await s.run({ action: "resume" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BrowserError);
    expect(String(err.message)).toMatch(/继续运行失败/);
    expect(String(err.message)).toMatch(/强制清除暂停状态/);
    expect(String(err.message)).not.toContain("SECRETTOKEN");
    expect(s.tab.debugPause).toBeNull();
    expect(gateBlocks(s)).toBe(false);
    expect(s.tab.sent).toContain("Debugger.disable");
    expect(s.sysLogs().some((x: string) => x.includes("resume 失败") && !x.includes("SECRETTOKEN"))).toBe(true);
  });

  it("step_over 的命令失败同样走强制恢复", async () => {
    const s = setup();
    await activate(s);
    s.tab.failOn.add("Debugger.stepOver");
    await expect(s.run({ action: "step_over" })).rejects.toThrow(/继续运行失败/);
    expect(s.tab.debugPause).toBeNull();
  });

  it("disable 也失败：照样清状态，报错里说明「关闭调试器也未成功」", async () => {
    const s = setup();
    await activate(s);
    s.tab.failOn.add("Debugger.resume");
    s.tab.failOn.add("Debugger.disable");
    await expect(s.run({ action: "resume" })).rejects.toThrow(/尝试关闭调试器也未成功/);
    expect(s.tab.debugPause).toBeNull();
  });

  it("用户面板 resume 失败：同样清状态，返回 failed + 可读 error（不再死锁）", async () => {
    const s = setup();
    await activate(s);
    s.tab.failOn.add("Debugger.resume");
    const r = await s.registered.get("debug.resume")!(s.session);
    expect(r).toMatchObject({ resumed: 0, failed: 1 });
    expect(String(r.error)).toMatch(/继续运行失败/);
    expect(String(r.error)).not.toContain("SECRETTOKEN");
    expect(s.tab.debugPause).toBeNull();
    expect(gateBlocks(s)).toBe(false);
  });

  it("120s 兜底自动 resume 失败：强制清，不是只记 log", async () => {
    const s = setup();
    await activate(s);
    s.tab.failOn.add("Debugger.resume");
    await vi.advanceTimersByTimeAsync(121_000);
    expect(s.tab.debugPause).toBeNull();
    expect(gateBlocks(s)).toBe(false);
    expect(s.tab.sent).toContain("Debugger.disable");
  });
});

describe("R6-09：入口闸门兜底超时（livePause 的 staleMs）", () => {
  it("暂停超过 staleMs：闸门放行并写日志，镜像被清；未超时仍拦", async () => {
    const s = setup();
    await activate(s);
    // 清掉自动 resume 的定时器影响：直接把镜像的 since 往前拨，模拟「所有清理路径都失灵」
    s.tab.debugPause.since = Date.now() - 10_000;
    expect(gateBlocks(s)).toBe(true);
    s.tab.debugPause.since = Date.now() - PAUSE_GATE_STALE_MS - 1000;
    expect(gateBlocks(s)).toBe(false);
    expect(s.tab.debugPause).toBeNull();
    expect(s.sysLogs().some((x: string) => x.includes("暂停状态已过期"))).toBe(true);
  });

  it("livePause 不传 opts 时行为不变（status 等老调用方）", () => {
    const tab: any = { debugPause: { since: 1, reason: "other" } };
    expect(livePause(tab)).toBe(tab.debugPause);
  });
});
