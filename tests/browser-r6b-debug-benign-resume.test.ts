/**
 * R6-38：良性并发 resume（第二个收到 V8 的 `Can only perform operation while paused.`）不能被当失败：
 *   以前 → forceRecover → `Debugger.disable` 清空**全部断点**，且 `pauseOnExceptions` 的显示状态仍写着 all（V8 的 disable 其实把它重置成了 none）。
 * 现在：`not paused` = 页面已在运行 = resume 幂等成功（AI 的 resume、面板「继续运行」、120s 兜底三条路径都一样）；
 *   step_* 与入口的「未暂停」同口径报 BAD_ARGS；都不 forceRecover。真失败（Target closed / 超时）照旧 forceRecover，
 *   且 disable 成功后 `pauseOnExceptions` 归零（让状态与 V8 实际一致）。
 * 假 tab + 假 CDP（与 browser-r6-s3-debug-pause.test.ts 同一套假件，多了断点与「resume 行为可编排」）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 假 CDP / 假 session 的松散形状，只在本测试里用 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { createHandlers, debugPauseGate, isNotPausedError, normalize } from "../electron-app/browser/ops/debug.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";

type Ev = (method: string, params: Record<string, unknown>, sid: string | null) => void;

const NOT_PAUSED = "Can only perform operation while paused.";
const SCRIPT = { scriptId: "s1", url: "https://site.test/app.js", startLine: 0, startColumn: 0, endLine: 20, endColumn: 0 };
const frame = () => ({ callFrameId: "f0", functionName: "compute", location: { scriptId: "s1", lineNumber: 5, columnNumber: 4 }, scopeChain: [] });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

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
    emit,
    /** 让指定命令失败：方法名 → 错误文案 */
    failOn: new Map<string, string>(),
    resumeCalls: 0,
    /** 第 i 次 Debugger.resume 的行为（默认：立刻发 resumed） */
    onResume: async () => emit("Debugger.resumed", {}, null),
    send: vi.fn(async (method: string) => {
      sent.push(method);
      const fail = tab.failOn.get(method);
      if (fail !== undefined) throw new Error(fail);
      if (method === "Debugger.resume") {
        tab.resumeCalls += 1;
        await tab.onResume(tab.resumeCalls);
        return {};
      }
      if (method === "Debugger.setBreakpointByUrl") return { breakpointId: "1:3:0:https://site.test/app.js", locations: [{ scriptId: "s1", lineNumber: 3, columnNumber: 0 }] };
      if (method === "Debugger.enable") emit("Debugger.scriptParsed", SCRIPT, null);
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
  const handlers = createHandlers({
    requireSession: () => session,
    abortable: <T>(p: Promise<T>) => p,
    scheduleState: () => {},
    addStateContributor: () => {},
    registerExt: (n: string, fn: (s: unknown, ...a: unknown[]) => Promise<any>) => registered.set(n, fn),
    sessions: () => [session],
    electron: {},
    log: vi.fn(),
  });
  const run = (args: Record<string, unknown>) => handlers.debug("task-1", normalize("debug", args, OP_HELPERS) as Record<string, unknown>) as Promise<any>;
  const sysLogs = () => session.activityLog.addSystem.mock.calls.map((c: any[]) => String(c[0].summary));
  const panelResume = () => registered.get("debug.resume")!(session);
  return { tab, session, run, registered, sysLogs, panelResume };
};
type Env = ReturnType<typeof setup>;

/** 一个带 1 个断点 + 异常暂停 all 的暂停中 tab */
const pausedWithConfig = async () => {
  const s = setup();
  await s.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 3 });
  await s.run({ action: "pause_on_exception", state: "all" });
  s.tab.pausedAt();
  expect(s.tab.debugPause).toBeTruthy();
  return s;
};

const gateBlocks = (s: Env) => {
  try {
    debugPauseGate(s.session as never, "click", { tabId: "t1" });
    return false;
  } catch (e) {
    return e instanceof BrowserError && e.code === "TIMEOUT";
  }
};

/** 断点 / 异常暂停设置都还在（没被 Debugger.disable 清掉） */
const configIntact = async (s: Env) => {
  const list = await s.run({ action: "list_breakpoints" });
  expect(list.breakpoints).toHaveLength(1);
  expect(list.pauseOnExceptions).toBe("all");
  expect(s.tab.sent).not.toContain("Debugger.disable");
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("R6-38 isNotPausedError：只认「页面没暂停」，不吞真失败", () => {
  it("V8 固定句子 / 字面 not paused（任意大小写、包在 Error / BrowserError / 字符串里）→ true", () => {
    expect(isNotPausedError(new Error(NOT_PAUSED))).toBe(true);
    expect(isNotPausedError(new BrowserError("INTERNAL", `Debugger.resume 失败：${NOT_PAUSED}`))).toBe(true);
    expect(isNotPausedError("Debugger is NOT PAUSED")).toBe(true);
    expect(isNotPausedError({ message: "can only perform operation while paused" })).toBe(true);
  });
  it("超时 / 目标已死 / 会话失效 / 空值 → false（这些必须走 forceRecover）", () => {
    for (const m of ["浏览器内部命令超时（Debugger.resume，5000ms）", "Target closed", "Session with given id not found.", "标签页已关闭", "", "paused"]) {
      expect(isNotPausedError(new Error(m)), m).toBe(false);
    }
    expect(isNotPausedError(undefined)).toBe(false);
    expect(isNotPausedError(null)).toBe(false);
  });
});

describe("R6-38 并发 resume：第二个收到 not paused → 视作成功，不 forceRecover，断点与异常暂停设置保留", () => {
  it("两个 AI resume 并发：都成功；没发 Debugger.disable；断点仍在；pauseOnExceptions 仍是 all；暂停态已清、闸门解锁", async () => {
    const s = await pausedWithConfig();
    const gate = deferred();
    s.tab.onResume = async (i: number) => {
      if (i === 1) {
        await gate.promise; // 第一个 resume 的 resumed 事件稍后才到，第二个命令已经在 V8 里被判「没暂停」
        s.tab.emit("Debugger.resumed", {}, null);
        return;
      }
      throw new Error(NOT_PAUSED);
    };
    const p1 = s.run({ action: "resume" });
    const p2 = s.run({ action: "resume" });
    gate.resolve();
    await vi.advanceTimersByTimeAsync(600);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toMatchObject({ action: "resume", paused: false });
    expect(r2).toMatchObject({ action: "resume", paused: false });
    expect(String(r2.note ?? r1.note)).toMatch(/没有暂停|无需继续/);
    expect(s.tab.resumeCalls).toBe(2);
    await configIntact(s);
    expect(s.tab.debugPause).toBeNull();
    expect(gateBlocks(s)).toBe(false);
    expect(s.sysLogs().some((x: string) => x.includes("resume 失败"))).toBe(false);
  });

  it("AI resume 与用户面板「继续运行」并发（面板是第二个）：面板返回 resumed:1 且没有 failed / error；断点仍在", async () => {
    const s = await pausedWithConfig();
    const gate = deferred();
    s.tab.onResume = async (i: number) => {
      if (i === 1) {
        await gate.promise;
        s.tab.emit("Debugger.resumed", {}, null);
        return;
      }
      throw new Error(NOT_PAUSED);
    };
    const ai = s.run({ action: "resume" });
    const panel = s.panelResume();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(600);
    const [, pr] = await Promise.all([ai, panel]);
    expect(pr).toEqual({ resumed: 1 });
    await configIntact(s);
    expect(s.tab.debugPause).toBeNull();
  });

  it("用户面板先发、AI 后发（AI 是第二个收到 not paused 的）同样成功", async () => {
    const s = await pausedWithConfig();
    const gate = deferred();
    s.tab.onResume = async (i: number) => {
      if (i === 1) {
        await gate.promise;
        s.tab.emit("Debugger.resumed", {}, null);
        return;
      }
      throw new Error(NOT_PAUSED);
    };
    const panel = s.panelResume();
    const ai = s.run({ action: "resume" });
    gate.resolve();
    await vi.advanceTimersByTimeAsync(600);
    const [pr, ar] = await Promise.all([panel, ai]);
    expect(pr).toEqual({ resumed: 1 });
    expect(ar).toMatchObject({ action: "resume", paused: false });
    await configIntact(s);
  });

  it("step_over 收到 not paused：与入口的「未暂停」同口径报 BAD_ARGS，不 forceRecover；断点保留，过期的暂停镜像被清", async () => {
    const s = await pausedWithConfig();
    s.tab.failOn.set("Debugger.stepOver", NOT_PAUSED);
    await expect(s.run({ action: "step_over" })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringMatching(/没有被调试器暂停/) });
    await configIntact(s);
    expect(s.tab.debugPause).toBeNull();
    expect(gateBlocks(s)).toBe(false);
  });

  it("120s 兜底自动 resume 收到 not paused：只清镜像，不 forceRecover（断点保留）", async () => {
    const s = await pausedWithConfig();
    s.tab.failOn.set("Debugger.resume", NOT_PAUSED);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(s.tab.debugPause).toBeNull();
    expect(gateBlocks(s)).toBe(false);
    await configIntact(s);
    expect(s.sysLogs().some((x: string) => x.includes("resume 失败"))).toBe(false);
  });

  it("镜像守卫：not paused 到达时镜像已被「新的暂停」覆盖 → 不清新暂停；结果如实说「又在新位置暂停了」", async () => {
    const s = await pausedWithConfig();
    s.tab.onResume = async () => {
      s.tab.pausedAt(); // 上一次暂停刚结束，页面立刻又命中断点
      throw new Error(NOT_PAUSED);
    };
    const r = await s.run({ action: "resume" });
    expect(r).toMatchObject({ action: "resume", paused: true });
    expect(String(r.note)).toMatch(/新的位置暂停/);
    expect(s.tab.debugPause).toBeTruthy();
    expect(gateBlocks(s)).toBe(true);
    await configIntact(s);
  });
});

describe("R6-38 真失败仍走 forceRecover；disable 成功后 pauseOnExceptions 归零（与 V8 实际一致）", () => {
  it("AI resume 因 Target closed 失败：清断点 + pauseOnExceptions 归 none（list_breakpoints / status 都是 none）；错误文案告知异常暂停也被关了", async () => {
    const s = await pausedWithConfig();
    s.tab.failOn.set("Debugger.resume", "Target closed");
    const err: any = await s.run({ action: "resume" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BrowserError);
    expect(String(err.message)).toMatch(/继续运行失败/);
    expect(String(err.message)).toMatch(/异常时暂停已关闭/);
    expect(s.tab.sent).toContain("Debugger.disable");
    const list = await s.run({ action: "list_breakpoints" });
    expect(list.breakpoints).toHaveLength(0);
    expect(list.pauseOnExceptions).toBe("none");
    expect((await s.run({ action: "status" })).pauseOnExceptions).toBe("none");
    expect(s.sysLogs().some((x: string) => x.includes("resume 失败") && x.includes("异常时暂停已关闭"))).toBe(true);
  });

  it("命令超时（TIMEOUT）不是「没暂停」：照旧 forceRecover", async () => {
    const s = await pausedWithConfig();
    s.tab.failOn.set("Debugger.resume", "浏览器内部命令超时（Debugger.resume，5000ms）");
    await expect(s.run({ action: "resume" })).rejects.toThrow(/继续运行失败/);
    expect(s.tab.sent).toContain("Debugger.disable");
    expect((await s.run({ action: "list_breakpoints" })).breakpoints).toHaveLength(0);
  });

  it("用户面板 resume 真失败：同样归零；返回 failed + 文案", async () => {
    const s = await pausedWithConfig();
    s.tab.failOn.set("Debugger.resume", "Target closed");
    const r = await s.panelResume();
    expect(r).toMatchObject({ resumed: 0, failed: 1 });
    expect(String(r.error)).toMatch(/异常时暂停已关闭/);
    expect((await s.run({ action: "list_breakpoints" })).pauseOnExceptions).toBe("none");
  });

  it("120s 兜底 resume 真失败：同样归零", async () => {
    const s = await pausedWithConfig();
    s.tab.failOn.set("Debugger.resume", "Target closed");
    await vi.advanceTimersByTimeAsync(121_000);
    expect(s.tab.sent).toContain("Debugger.disable");
    expect((await s.run({ action: "list_breakpoints" })).pauseOnExceptions).toBe("none");
  });

  it("Debugger.disable 也失败：V8 里什么都没被重置，断点列表与 pauseOnExceptions 显示保持原样（不谎称已清）", async () => {
    const s = await pausedWithConfig();
    s.tab.failOn.set("Debugger.resume", "Target closed");
    s.tab.failOn.set("Debugger.disable", "Target closed");
    await expect(s.run({ action: "resume" })).rejects.toThrow(/尝试关闭调试器也未成功/);
    const list = await s.run({ action: "list_breakpoints" });
    expect(list.breakpoints).toHaveLength(1);
    expect(list.pauseOnExceptions).toBe("all");
    expect(s.tab.debugPause).toBeNull(); // 暂停镜像照样清（闸门解锁）
  });
});
