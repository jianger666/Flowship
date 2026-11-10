/**
 * E2·P8 / B5 主进程 op（ops/debug.mjs）：假 tab + 假 CDP + 假 session。
 * 覆盖：参数规整；断点上限 20；条件断点 / scope 走 evaluate 审批（拒绝 → DENIED 且不碰 CDP）；暂停跟踪（状态 / 固定枚举 / 无变量值）；
 * 暂停期间其它 op 的入口闸门；120s 兜底自动 resume（假时钟）；销毁收尾（resume + 清断点 + release）；用户接管放行表；
 * 与 sources 共用 hub（互不干扰）；「只有 sources 用 hub 时页面的 debugger; 也被跟踪」；registerExt("debug.resume")。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 假 CDP / 假 session 的松散形状，只在本测试里用 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { getDebuggerHub } from "../electron-app/browser/debugger-hub.mjs";
import { PAUSE_AUTO_RESUME_MS } from "../electron-app/browser/debug-policy.mjs";
import { OPS, createHandlers, debugPauseGate, normalize } from "../electron-app/browser/ops/debug.mjs";
import { createHandlers as createSourcesHandlers } from "../electron-app/browser/ops/sources.mjs";
import { BrowserError } from "../electron-app/browser/server-channel.mjs";

type Ev = (method: string, params: Record<string, unknown>, sid: string | null) => void;
type Rec = { method: string; params: Record<string, unknown>; sid: string | null };

const SCRIPT = { scriptId: "s1", url: "https://site.test/app.js?token=SECRETTOKEN1234567890", startLine: 0, startColumn: 0, endLine: 20, endColumn: 0 };

const frame = (over: Record<string, unknown> = {}) => ({
  callFrameId: "f0",
  functionName: "compute",
  location: { scriptId: "s1", lineNumber: 5, columnNumber: 4 },
  scopeChain: [
    { type: "block", object: { objectId: "o-block" } },
    { type: "local", object: { objectId: "o-local" } },
    { type: "closure", object: { objectId: "o-closure" } },
    { type: "global", object: { objectId: "o-global" } },
  ],
  ...over,
});

const PROPS: Record<string, unknown[]> = {
  "o-block": [{ name: "i", value: { type: "number", value: 2, description: "2" } }],
  "o-local": [
    { name: "total", value: { type: "number", value: 1, description: "1" } },
    { name: "password", value: { type: "string", value: "hunter2secret" } },
    { name: "apiToken", value: { type: "string", value: "tok-abcdefghijklmnop" } },
    { name: "note", value: { type: "string", value: "Authorization: Bearer abcdef0123456789" } },
    { name: "cfg", value: { type: "object", className: "Object", description: "Object" } },
    { name: "cb", value: { type: "function", description: 'function(){ const password = "hunter2secret" }' } },
    { name: "lazy", get: { type: "function" } },
  ],
  "o-closure": [{ name: "outer", value: { type: "string", value: "outer-value" } }],
  "o-global": [{ name: "window", value: { type: "object", className: "Window" } }],
};

const makeTab = (id = "t1") => {
  const listeners = new Set<Ev>();
  const sent: Rec[] = [];
  const ext = new Map<string, { dispose?: () => void }>();
  const emit: Ev = (m, p, s) => [...listeners].forEach((l) => l(m, p, s));
  let nextBp = 1;
  const tab: Record<string, any> = {
    id,
    url: "https://site.test/page",
    destroyed: false,
    debugPause: undefined as unknown,
    ext,
    sent,
    emit,
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}, sid: string | null = null) => {
      sent.push({ method, params, sid });
      if (tab.destroyed) throw new BrowserError("TAB_NOT_FOUND", "标签页已关闭");
      if (method === "Debugger.enable") {
        emit("Debugger.scriptParsed", SCRIPT, null);
      } else if (method === "Debugger.setBreakpointByUrl") {
        const n = nextBp++;
        return { breakpointId: `${n}:${params.lineNumber}:0:${params.url ?? "re"}`, locations: [{ scriptId: "s1", lineNumber: params.lineNumber, columnNumber: 0 }] };
      } else if (["Debugger.resume", "Debugger.stepOver", "Debugger.stepInto", "Debugger.stepOut"].includes(method)) {
        emit("Debugger.resumed", {}, null);
        if (method !== "Debugger.resume") queueMicrotask(() => emit("Debugger.paused", { reason: "other", callFrames: [frame({ location: { scriptId: "s1", lineNumber: 6, columnNumber: 2 } })], hitBreakpoints: [] }, null));
      } else if (method === "Runtime.getProperties") {
        return { result: PROPS[String(params.objectId)] ?? [] };
      }
      return {};
    }),
    onCdpEvent: (fn: Ev) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    addSessionHook: () => () => {},
    cdpSessionIds: () => [null],
    getExt: (key: string, factory: () => { dispose?: () => void }) => {
      if (!ext.has(key)) ext.set(key, factory());
      return ext.get(key)!;
    },
    /** 模拟 tab 销毁：按 tab.mjs 的约定调每个 ext 的 dispose */
    destroy() {
      tab.destroyed = true;
      for (const e of ext.values()) e.dispose?.();
    },
    pausedAt(over: Record<string, unknown> = {}) {
      emit("Debugger.paused", { reason: "other", callFrames: [frame()], hitBreakpoints: [], ...over }, null);
    },
  };
  return tab;
};

const makeSession = (tab: ReturnType<typeof makeTab>, opts: { evaluateEnabled?: boolean; answer?: string } = {}) => {
  const exts = new Map<string, unknown>();
  const prompts: Array<{ kind: string; detail?: { summary?: string } }> = [];
  const session: Record<string, any> = {
    taskId: "task-1",
    tabs: [tab],
    activeTabId: tab.id,
    get activeTab() {
      return tab;
    },
    controller: "idle",
    host: { isEvaluateEnabled: () => opts.evaluateEnabled === true, emitEvent: vi.fn() },
    prompts: {
      request: vi.fn(async (spec: { kind: string; detail?: { summary?: string } }) => {
        prompts.push(spec);
        return { action: opts.answer ?? "deny" };
      }),
    },
    getExt: (key: string, factory: () => unknown) => {
      if (!exts.has(key)) exts.set(key, factory());
      return exts.get(key);
    },
    getTab: (id?: string) => {
      if (id && id !== tab.id) throw new BrowserError("TAB_NOT_FOUND", `没有标签页 ${id}`);
      return tab;
    },
    activityLog: { addAI: vi.fn(), addSystem: vi.fn() },
    log: vi.fn(),
  };
  return { session, prompts };
};

const setup = (opts: { evaluateEnabled?: boolean; answer?: string; autoResumeMs?: number } = {}) => {
  const tab = makeTab();
  const { session, prompts } = makeSession(tab, opts);
  const contributors: Array<(s: unknown) => Record<string, unknown>> = [];
  const exts = new Map<string, (s: unknown, ...a: unknown[]) => Promise<unknown>>();
  const scheduled: string[] = [];
  const handlers = createHandlers({
    requireSession: () => session,
    abortable: <T>(p: Promise<T>) => p,
    scheduleState: (t: string) => scheduled.push(t),
    addStateContributor: (fn: (s: unknown) => Record<string, unknown>) => contributors.push(fn),
    registerExt: (n: string, fn: (s: unknown, ...a: unknown[]) => Promise<unknown>) => exts.set(n, fn),
    sessions: () => [session],
    electron: { debugAutoResumeMs: opts.autoResumeMs },
    log: vi.fn(),
  });
  const run = (args: Record<string, unknown>, signal?: AbortSignal) => handlers.debug("task-1", normalize("debug", args, OP_HELPERS) as Record<string, unknown>, signal);
  const state = () => contributors.reduce((acc, fn) => ({ ...acc, ...fn(session) }), {} as Record<string, any>);
  return { tab, session, prompts, run, handlers, contributors, exts, scheduled, state };
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("normalize", () => {
  it("OPS 只有 debug；action 必填且是枚举", () => {
    expect([...OPS]).toEqual(["debug"]);
    expect(() => normalize("debug", {}, OP_HELPERS)).toThrow(/action/);
    expect(() => normalize("debug", { action: "setSkipAllPauses" }, OP_HELPERS)).toThrow(/只能是/);
    expect(() => normalize("click", {}, OP_HELPERS)).toThrow(/未实现/);
  });
  it("set_breakpoint 校验走 policy（行号 / url / ReDoS / condition）并带 tabId", () => {
    expect(normalize("debug", { action: "set_breakpoint", url: "https://a.test/x.js", line: 3, tabId: "t2" }, OP_HELPERS)).toEqual({ action: "set_breakpoint", url: "https://a.test/x.js", line: 3, tabId: "t2" });
    for (const bad of [{ line: 3 }, { url: "a", line: 0 }, { url: "a", line: 1.5 }, { urlRegex: "(a+)+", line: 1 }, { url: "a", line: 1, condition: "x".repeat(1001) }]) {
      expect(() => normalize("debug", { action: "set_breakpoint", ...bad }, OP_HELPERS), JSON.stringify(bad)).toThrow();
    }
  });
  it("pause_on_exception / remove_breakpoint / scope 的参数规整与夹取", () => {
    expect(() => normalize("debug", { action: "pause_on_exception" }, OP_HELPERS)).toThrow(/state/);
    expect(() => normalize("debug", { action: "pause_on_exception", state: "sometimes" }, OP_HELPERS)).toThrow();
    expect(normalize("debug", { action: "pause_on_exception", state: "all" }, OP_HELPERS)).toMatchObject({ state: "all" });
    expect(() => normalize("debug", { action: "remove_breakpoint" }, OP_HELPERS)).toThrow(/id/);
    expect(normalize("debug", { action: "scope" }, OP_HELPERS)).toEqual({ action: "scope", frame: 0, depth: 1, maxVars: 50 });
    expect(normalize("debug", { action: "scope", frame: 999, depth: 9, maxVars: 99999 }, OP_HELPERS)).toEqual({ action: "scope", frame: 49, depth: 2, maxVars: 200 });
  });
});

describe("断点", () => {
  it("set_breakpoint：行号 1 起对外 / 0 起对内；返回 id 与落点；url 脱敏；写活动日志", async () => {
    const h = setup();
    const r = (await h.run({ action: "set_breakpoint", url: "https://site.test/app.js?token=SECRETTOKEN1234567890", line: 6, column: 5 })) as Record<string, any>;
    const call = h.tab.sent.find((s: Rec) => s.method === "Debugger.setBreakpointByUrl")!;
    expect(call.params).toMatchObject({ lineNumber: 5, columnNumber: 4, url: "https://site.test/app.js?token=SECRETTOKEN1234567890" });
    expect(call.params.condition).toBeUndefined();
    expect(r.breakpoint.line).toBe(6);
    expect(r.breakpoint.locations[0].line).toBe(6);
    expect(r.bound).toBe(true);
    // CDP 的断点 id 形如 `1:5:0:<完整 url>`（带 query 令牌）：对外只给自己的短 id，cdpId 不出站
    expect(r.breakpoint.id).toBe("bp1");
    expect(JSON.stringify(r)).not.toContain("SECRETTOKEN1234567890");
    expect(JSON.stringify(r)).not.toContain("cdpId");
    expect(JSON.stringify(await h.run({ action: "list_breakpoints" }))).not.toContain("SECRETTOKEN1234567890");
    expect(h.session.activityLog.addAI).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringMatching(/设置了断点.*:6/) }));
  });
  it("每 tab 最多 20 个断点：第 21 个 BAD_ARGS 且不发 CDP", async () => {
    const h = setup();
    for (let n = 1; n <= 20; n++) await h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: n });
    const before = h.tab.sent.length;
    await expect(h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 21 })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringMatching(/最多 20 个/) });
    expect(h.tab.sent.length).toBe(before);
    const id = ((await h.run({ action: "list_breakpoints" })) as Record<string, any>).breakpoints[0].id;
    await h.run({ action: "remove_breakpoint", id });
    await expect(h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 22 })).resolves.toBeTruthy();
  });
  it("remove_breakpoint：只能删自己设的；未知 id → BAD_ARGS；list 反映变化", async () => {
    const h = setup();
    const r = (await h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 3 })) as Record<string, any>;
    await expect(h.run({ action: "remove_breakpoint", id: "999:0:0:foreign" })).rejects.toMatchObject({ code: "BAD_ARGS" });
    await h.run({ action: "remove_breakpoint", id: r.breakpoint.id });
    // 发给 CDP 的是内部的真 id，不是对外的短 id
    expect(h.tab.sent.find((s: Rec) => s.method === "Debugger.removeBreakpoint")!.params.breakpointId).toBe("1:2:0:https://site.test/app.js");
    expect(((await h.run({ action: "list_breakpoints" })) as Record<string, any>).count).toBe(0);
  });
  it("Flowship origin 的脚本不能设断点（URL_BLOCKED）", async () => {
    const tab = makeTab();
    const { session } = makeSession(tab);
    const handlers = createHandlers({ requireSession: () => session, abortable: <T>(p: Promise<T>) => p, sessions: () => [session], electron: { isAppUrl: (u: string) => u.includes("flowship.local") } });
    await expect(handlers.debug("task-1", normalize("debug", { action: "set_breakpoint", url: "https://flowship.local/_next/x.js", line: 1 }, OP_HELPERS))).rejects.toMatchObject({ code: "URL_BLOCKED" });
    expect(tab.sent.some((s: Rec) => s.method === "Debugger.setBreakpointByUrl")).toBe(false);
  });
  it("没使用过调试器时 status / list_breakpoints 不会启用 Debugger 域", async () => {
    const h = setup();
    await h.run({ action: "status" });
    await h.run({ action: "list_breakpoints" });
    expect(h.tab.sent.some((s: Rec) => s.method === "Debugger.enable")).toBe(false);
  });
  it("pause_on_exception 发 Debugger.setPauseOnExceptions 并出现在 list / status 里", async () => {
    const h = setup();
    await h.run({ action: "pause_on_exception", state: "uncaught" });
    expect(h.tab.sent.find((s: Rec) => s.method === "Debugger.setPauseOnExceptions")!.params).toEqual({ state: "uncaught" });
    expect(((await h.run({ action: "status" })) as Record<string, any>).pauseOnExceptions).toBe("uncaught");
  });
});

describe("条件断点与 scope 走 evaluate 审批", () => {
  it("总闸关 + 用户拒绝：条件断点 DENIED，审批卡标明是条件断点，且不碰 CDP", async () => {
    const h = setup({ evaluateEnabled: false, answer: "deny" });
    await expect(h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 3, condition: "i === 2" })).rejects.toMatchObject({ code: "DENIED" });
    expect(h.prompts[0].kind).toBe("evaluate");
    expect(h.prompts[0].detail?.summary).toMatch(/条件断点.*i === 2/);
    expect(h.tab.sent.length).toBe(0);
  });
  it("没有 condition 的断点不需要审批", async () => {
    const h = setup({ evaluateEnabled: false, answer: "deny" });
    await expect(h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 3 })).resolves.toBeTruthy();
    expect(h.prompts).toHaveLength(0);
  });
  it("批准（task）后条件随 CDP 发出；活动日志只写「带条件」不含表达式", async () => {
    const h = setup({ evaluateEnabled: false, answer: "task" });
    await h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 3, condition: "secretVar === 'p@ss'" });
    expect(h.tab.sent.find((s: Rec) => s.method === "Debugger.setBreakpointByUrl")!.params.condition).toBe("secretVar === 'p@ss'");
    const logs = h.session.activityLog.addAI.mock.calls.map((c: any[]) => c[0].summary).join("\n");
    expect(logs).toContain("带条件");
    expect(logs).not.toContain("p@ss");
    // 本会话已批准：之后不再弹卡（含 scope）
    h.tab.pausedAt();
    await h.run({ action: "scope" });
    expect(h.prompts).toHaveLength(1);
  });
  it("总闸开（evaluateEnabled）：免审批", async () => {
    const h = setup({ evaluateEnabled: true, answer: "deny" });
    await h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 3, condition: "x" });
    expect(h.prompts).toHaveLength(0);
  });
  it("scope 未批准 → DENIED，且不发 Runtime.getProperties", async () => {
    const h = setup({ evaluateEnabled: false, answer: "deny" });
    await h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 6 });
    h.tab.pausedAt({ hitBreakpoints: ["1:5:0:https://site.test/app.js"] });
    await expect(h.run({ action: "scope" })).rejects.toMatchObject({ code: "DENIED" });
    expect(h.prompts[0].detail?.summary).toMatch(/调试器·读取暂停帧变量/);
    expect(h.tab.sent.some((s: Rec) => s.method === "Runtime.getProperties")).toBe(false);
  });
});

describe("scope：浅层 + 脱敏", () => {
  const paused = async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 6 });
    h.tab.pausedAt();
    return h;
  };
  it("depth=1：展开 block + local，不展开 closure / global；凭据名变量全部 [已隐藏]，整个结果搜不到明文", async () => {
    const h = await paused();
    const r = (await h.run({ action: "scope" })) as Record<string, any>;
    const asked = h.tab.sent.filter((s: Rec) => s.method === "Runtime.getProperties").map((s: Rec) => s.params.objectId);
    expect(asked).toEqual(["o-block", "o-local"]);
    expect(asked).not.toContain("o-global");
    expect(r.scopes.map((s: any) => s.type)).toEqual(["block", "local"]);
    const vars = Object.fromEntries(r.scopes.flatMap((s: any) => s.vars).map((v: any) => [v.name, v]));
    expect(vars.total.value).toBe("1");
    expect(vars.i.value).toBe("2");
    expect(vars.password.value).toBe("[已隐藏]");
    expect(vars.apiToken.value).toBe("[已隐藏]");
    expect(vars.note.value).not.toContain("abcdef0123456789"); // 值过 redactSensitiveText
    expect(vars.cfg.value).toBe("Object");
    expect(vars.cb.value).toBe("function"); // 不取函数源码
    expect(vars.lazy.value).toBe("(访问器，未执行)");
    expect(r.hiddenCount).toBe(2);
    const dump = JSON.stringify(r);
    for (const secret of ["hunter2secret", "tok-abcdefghijklmnop", "abcdef0123456789"]) expect(dump).not.toContain(secret);
  });
  it("depth=2 才带上 closure；max_vars 截断并给 omitted；frame 越界 BAD_ARGS", async () => {
    const h = await paused();
    expect((((await h.run({ action: "scope", depth: 2 })) as Record<string, any>).scopes as any[]).map((s) => s.type)).toEqual(["block", "local", "closure"]);
    const r = (await h.run({ action: "scope", maxVars: 3 })) as Record<string, any>;
    expect(r.scopes.flatMap((s: any) => s.vars)).toHaveLength(3);
    expect(r.omitted).toBeGreaterThan(0);
    await expect(h.run({ action: "scope", frame: 7 })).rejects.toMatchObject({ code: "BAD_ARGS", message: expect.stringMatching(/没有第 7 帧/) });
  });
  it("没暂停时 scope / step → BAD_ARGS；resume 幂等", async () => {
    const h = setup({ evaluateEnabled: true });
    await expect(h.run({ action: "scope" })).rejects.toMatchObject({ code: "BAD_ARGS" });
    await expect(h.run({ action: "step_over" })).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(await h.run({ action: "resume" })).toMatchObject({ paused: false });
  });
});

describe("暂停跟踪 / 状态 / step / resume", () => {
  it("Debugger.paused → 状态 debug:{paused,reason,url,line,since}：url 脱敏、reason 固定枚举、不含变量值或函数名", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 6 });
    h.tab.pausedAt({ hitBreakpoints: ["1:5:0:https://site.test/app.js"] });
    const st = h.state().debug;
    expect(st).toMatchObject({ paused: true, reason: "breakpoint", line: 6 });
    expect(st.url).not.toContain("SECRETTOKEN1234567890");
    expect(Object.keys(st).sort()).toEqual(["line", "paused", "reason", "since", "url"]);
    expect(JSON.stringify(st)).not.toContain("compute");
    expect(h.scheduled.length).toBeGreaterThan(0);
  });
  it("status：位置 / 函数名 / 命中断点 / 异常描述（脱敏）；没暂停时只给计数", async () => {
    const h = setup({ evaluateEnabled: true });
    expect(await h.run({ action: "status" })).toMatchObject({ paused: false, breakpointCount: 0, debuggerActive: false });
    const bp = (await h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 6 })) as Record<string, any>;
    h.tab.pausedAt({ reason: "exception", data: { description: "Error: boom token=SECRETVALUE123456\n    at x" } });
    const s = (await h.run({ action: "status" })) as Record<string, any>;
    expect(s).toMatchObject({ paused: true, reason: "exception", line: 6, functionName: "compute", autoResumeSeconds: 120 });
    expect(s.exception).toContain("boom");
    expect(s.exception).not.toContain("SECRETVALUE123456");
    h.tab.emit("Debugger.resumed", {}, null);
    h.tab.pausedAt({ hitBreakpoints: ["1:5:0:https://site.test/app.js"] });
    expect(((await h.run({ action: "status" })) as Record<string, any>).hitBreakpoints[0].id).toBe(bp.breakpoint.id);
  });
  it("reason 判定：debugger; 语句（other 且没单步）→ debugger_statement；单步落点 → step", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "pause_on_exception", state: "none" });
    h.tab.pausedAt();
    expect(h.state().debug.reason).toBe("debugger_statement");
    const p = h.run({ action: "step_over" });
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(h.state().debug.reason).toBe("step");
  });
  it("step_over：发 Debugger.stepOver，等到新的暂停位置并返回（行号前进）", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "pause_on_exception", state: "none" });
    h.tab.pausedAt();
    const r = (await h.run({ action: "step_over" })) as Record<string, any>;
    expect(h.tab.sent.some((s: Rec) => s.method === "Debugger.stepOver")).toBe(true);
    expect(r).toMatchObject({ paused: true, line: 7 });
  });
  it("resume：发 Debugger.resume；resumed 后静默 300ms 无新暂停 → paused:false 并清状态与定时器", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "pause_on_exception", state: "none" });
    h.tab.pausedAt();
    const p = h.run({ action: "resume" });
    await vi.advanceTimersByTimeAsync(400);
    expect(await p).toMatchObject({ paused: false });
    expect(h.state().debug).toBeUndefined();
    expect(h.tab.debugPause).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("暂停期间的入口闸门（死锁风险点）", () => {
  it("暂停中需要页面主线程的 op 立刻 TIMEOUT「页面被调试器暂停」，放行表内的 op 不抛", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "pause_on_exception", state: "none" });
    h.tab.pausedAt();
    for (const op of ["click", "read", "snapshot", "evaluate", "screenshot", "navigate", "wait_for", "type"]) {
      expect(() => debugPauseGate(h.session as never, op, {}), op).toThrow(expect.objectContaining({ code: "TIMEOUT", message: expect.stringMatching(/调试器暂停.*resume/s) }));
    }
    for (const op of ["debug", "status", "network", "console", "tabs", "user_activity", "ask_user_to_act", "close_session"]) {
      expect(() => debugPauseGate(h.session as never, op, {}), op).not.toThrow();
    }
  });
  it("没暂停 / tab 不存在 / 暂停已结束：放行；不存在的 tabId 交给 op 自己报 TAB_NOT_FOUND", async () => {
    const h = setup({ evaluateEnabled: true });
    expect(() => debugPauseGate(h.session as never, "click", {})).not.toThrow();
    h.tab.pausedAt();
    expect(() => debugPauseGate(h.session as never, "click", { tabId: "nope" })).not.toThrow();
  });
  it("debug 自己不排队：暂停中有一个「等页面」的动作挂着（队列被占），resume 仍然立刻成功", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "pause_on_exception", state: "none" });
    h.tab.pausedAt();
    // debug 的 handler 里没有任何 runAction / session.queue 的使用：直接发 CDP。这里断言它从不碰 session 的队列接口
    const queueTouch = vi.fn();
    (h.session as Record<string, unknown>).runAction = queueTouch;
    const p = h.run({ action: "resume" });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(queueTouch).not.toHaveBeenCalled();
    expect(h.tab.sent.some((s: Rec) => s.method === "Debugger.resume")).toBe(true);
  });
});

describe("120s 兜底自动 resume（假时钟）", () => {
  it("暂停满 120s：自动发 Debugger.resume 并写活动日志；没满不动", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "pause_on_exception", state: "none" });
    h.tab.pausedAt();
    await vi.advanceTimersByTimeAsync(PAUSE_AUTO_RESUME_MS - 1000);
    expect(h.tab.sent.some((s: Rec) => s.method === "Debugger.resume")).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.tab.sent.some((s: Rec) => s.method === "Debugger.resume")).toBe(true);
    expect(h.session.activityLog.addSystem).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringMatching(/暂停超过 120 秒，已自动继续运行/) }));
  });
  it("手动 resume 清掉定时器（不会在之后再多发一次）；再次暂停重新计时", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "pause_on_exception", state: "none" });
    h.tab.pausedAt();
    h.tab.emit("Debugger.resumed", {}, null);
    expect(vi.getTimerCount()).toBe(0);
    h.tab.pausedAt();
    expect(vi.getTimerCount()).toBe(1);
    h.tab.emit("Debugger.resumed", {}, null);
    await vi.advanceTimersByTimeAsync(PAUSE_AUTO_RESUME_MS * 2);
    expect(h.tab.sent.filter((s: Rec) => s.method === "Debugger.resume")).toHaveLength(0);
  });
  it("用户接管开始时处于暂停：不自动 resume，但 120s 兜底照常", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "pause_on_exception", state: "none" });
    h.tab.pausedAt();
    h.session.controller = "user";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.tab.sent.some((s: Rec) => s.method === "Debugger.resume")).toBe(false);
    expect(h.state().debug?.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(h.tab.sent.some((s: Rec) => s.method === "Debugger.resume")).toBe(true);
  });
  it("注入的兜底时长（e2e 用）生效；坏值回落到 120s", async () => {
    const a = setup({ evaluateEnabled: true, autoResumeMs: 1500 });
    await a.run({ action: "pause_on_exception", state: "none" });
    a.tab.pausedAt();
    await vi.advanceTimersByTimeAsync(1600);
    expect(a.tab.sent.some((s: Rec) => s.method === "Debugger.resume")).toBe(true);
    const b = setup({ evaluateEnabled: true, autoResumeMs: -5 });
    await b.run({ action: "pause_on_exception", state: "none" });
    b.tab.pausedAt();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(b.tab.sent.some((s: Rec) => s.method === "Debugger.resume")).toBe(false);
  });
});

describe("用户接管放行表", () => {
  it("接管中：status / list_breakpoints 放行，其余 action 全部 USER_CONTROL 且不发 CDP", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "pause_on_exception", state: "none" });
    h.tab.pausedAt();
    h.session.controller = "user";
    const before = h.tab.sent.length;
    for (const args of [
      { action: "set_breakpoint", url: "https://site.test/app.js", line: 1 },
      { action: "remove_breakpoint", id: "x" },
      { action: "pause_on_exception", state: "all" },
      { action: "step_over" },
      { action: "step_into" },
      { action: "step_out" },
      { action: "resume" },
      { action: "scope" },
    ]) {
      await expect(h.run(args), args.action).rejects.toMatchObject({ code: "USER_CONTROL" });
    }
    expect(h.tab.sent.length).toBe(before);
    await expect(h.run({ action: "status" })).resolves.toMatchObject({ paused: true });
    await expect(h.run({ action: "list_breakpoints" })).resolves.toBeTruthy();
  });
  it("面板「继续运行」（ext debug.resume）：接管期间也可用，对暂停中的 tab 发 resume 并记系统日志", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "pause_on_exception", state: "none" });
    h.tab.pausedAt();
    h.session.controller = "user";
    const r = (await h.exts.get("debug.resume")!(h.session)) as { resumed: number };
    expect(r.resumed).toBe(1);
    expect(h.tab.sent.some((s: Rec) => s.method === "Debugger.resume")).toBe(true);
    expect(h.session.activityLog.addSystem).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringMatching(/继续运行/) }));
    expect(((await h.exts.get("debug.resume")!(h.session)) as { resumed: number }).resumed).toBe(0);
  });
});

describe("销毁收尾", () => {
  it("tab 销毁：暂停中尽力 resume + 清断点 + 释放 hub；之后不再有残留状态 / 定时器", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 6 });
    h.tab.pausedAt();
    expect(getDebuggerHub(h.tab as never).ownerCount()).toBe(1);
    h.tab.destroy();
    await flush();
    const methods = h.tab.sent.map((s: Rec) => s.method);
    expect(methods).toContain("Debugger.resume");
    expect(h.tab.sent.find((s: Rec) => s.method === "Debugger.removeBreakpoint")!.params.breakpointId).toBe("1:5:0:https://site.test/app.js");
    expect(h.tab.debugPause).toBeNull();
    expect(h.state().debug).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("没暂停时销毁：不发 resume；销毁两次幂等", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 6 });
    h.tab.destroy();
    h.tab.destroy();
    await flush();
    expect(h.tab.sent.filter((s: Rec) => s.method === "Debugger.resume")).toHaveLength(0);
  });
});

describe("与 sources 共用 hub", () => {
  it("sources 用完释放后 debug 的断点仍有效（hub 不 disable）；debug 常驻到 tab 销毁才释放", async () => {
    const h = setup({ evaluateEnabled: true });
    await h.run({ action: "set_breakpoint", url: "https://site.test/app.js", line: 6 });
    const sources = createSourcesHandlers({ requireSession: () => h.session, abortable: <T>(p: Promise<T>) => p, sessions: () => [h.session], electron: {}, checkAiUrl: () => ({ ok: true }) } as never);
    await (sources.sources as (t: string, a: Record<string, unknown>) => Promise<unknown>)("task-1", { action: "list", kind: "script", limit: 10 }).catch(() => undefined);
    expect(h.tab.sent.filter((s: Rec) => s.method === "Debugger.disable")).toHaveLength(0);
    expect(getDebuggerHub(h.tab as never).ownerCount()).toBe(1);
    h.tab.pausedAt();
    expect(h.state().debug?.paused).toBe(true);
  });
  it("只有 sources（或任何人）创建了 hub、AI 从没用过 debug：页面的 debugger; 暂停也被跟踪（状态 / 闸门 / 120s 兜底）", async () => {
    const h = setup({ evaluateEnabled: true });
    const hub = getDebuggerHub(h.tab as never); // 模拟 sources 创建 hub（debug op 一次都没调用）
    await hub.acquire("sources");
    h.tab.pausedAt();
    expect(h.state().debug).toMatchObject({ paused: true, reason: "debugger_statement" });
    expect(() => debugPauseGate(h.session as never, "click", {})).toThrow(/调试器暂停/);
    await vi.advanceTimersByTimeAsync(PAUSE_AUTO_RESUME_MS + 1000);
    expect(h.tab.sent.some((s: Rec) => s.method === "Debugger.resume")).toBe(true);
  });
  it("hub 被释放（Debugger.disable 让页面恢复、没有 resumed 事件）后，过期的暂停镜像不会让闸门一直拦着", async () => {
    const h = setup({ evaluateEnabled: true });
    const hub = getDebuggerHub(h.tab as never);
    await hub.acquire("sources");
    h.tab.pausedAt();
    expect(() => debugPauseGate(h.session as never, "click", {})).toThrow();
    await hub.release("sources");
    expect(() => debugPauseGate(h.session as never, "click", {})).not.toThrow();
    expect(h.state().debug).toBeUndefined();
  });
});
