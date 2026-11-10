/* eslint-disable @typescript-eslint/no-explicit-any -- 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-17：scroll until_stable 总时长可达 ~150s，超过 bridge 60s 超时，且本地 TIMEOUT 不发 cancel（主进程继续滚、面板被锁）。
 * 修法：① until_stable 总时限硬上限 45s（timeout_ms 夹到 [1000, 45000]，到点 reason:"timeout"）；
 *      ② scroll until_stable 的 bridge 超时 55s（> 上限）；③ bridge 本地 TIMEOUT 向主进程发 `cancel{id}`，主进程只中止该请求；
 *      ④ 被中止后动作队列 / 面板锁释放。
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { scroll } from "../electron-app/browser/actions.mjs";
import { UNTIL_STABLE_MAX_TOTAL_MS, UNTIL_STABLE_MIN_TOTAL_MS, clampTotalMs, normalizeScrollArgs, runUntilStable } from "../electron-app/browser/scroll-kit.mjs";
import { createServerChannel } from "../electron-app/browser/server-channel.mjs";
import { UNTIL_STABLE_BRIDGE_TIMEOUT_MS, parseScrollArgs, renderUntilStable, UNTIL_STABLE_MAX_TOTAL_MS as SERVER_MAX } from "../src/lib/server/browser/screenshot-scroll-args";
import { __resetBrowserSettingsForTest } from "../src/lib/server/browser/settings";
import { getBrowserTools } from "../src/lib/server/browser/tools";
import { installFakeBrowser, NEVER, type FakeBrowser } from "./helpers/browser-bridge-fake";
import { makeP4Env, type P4Env } from "./helpers/browser-e2-p4-fakes";

describe("R6-17·总时限（纯逻辑，假时钟）", () => {
  /** 假时钟：sleep 直接推进时间；页面每 4.9s 才长一点（每一步都要等将近 step_timeout 才看到增长，永远稳定不了） */
  const mkIo = () => {
    let t = 0;
    const height = () => 1000 + Math.floor(t / 4900);
    return {
      get t() {
        return t;
      },
      io: {
        measure: async () => ({ scrollHeight: height(), scrollTop: 0, clientHeight: 800 }),
        scrollToBottom: async () => ({ scrollHeight: height(), scrollTop: 0, clientHeight: 800 }),
        sleep: async (ms: number) => {
          t += ms;
        },
        now: () => t,
        check: () => {},
      },
    };
  };

  it("永远在增长 + max_steps 30 × step_timeout 5000（理论 150s）：总时长 ≤ 45s，reason=timeout，步数远小于 30", async () => {
    const c = mkIo();
    const r = await runUntilStable(c.io, { maxSteps: 30, stepTimeoutMs: 5000 });
    expect(r.reason).toBe("timeout");
    expect(r.elapsedMs).toBeLessThanOrEqual(UNTIL_STABLE_MAX_TOTAL_MS);
    expect(c.t).toBeLessThanOrEqual(UNTIL_STABLE_MAX_TOTAL_MS);
    expect(r.steps).toBeLessThan(30);
  });

  it("页面一直不增长：照旧 2 轮稳定就停（reason=stable），不被总时限影响", async () => {
    let t = 0;
    const r = await runUntilStable(
      {
        measure: async () => ({ scrollHeight: 1000, scrollTop: 200, clientHeight: 800 }),
        scrollToBottom: async () => ({ scrollHeight: 1000, scrollTop: 200, clientHeight: 800 }),
        sleep: async (ms: number) => {
          t += ms;
        },
        now: () => t,
        check: () => {},
      },
      { maxSteps: 30, stepTimeoutMs: 3000 },
    );
    expect(r.reason).toBe("stable");
    expect(r.steps).toBe(2);
  });

  it("显式 timeoutMs：更小的总时限生效；超出上限的被夹到 45s；低于下限被抬到 1s", async () => {
    const a = mkIo();
    const ra = await runUntilStable(a.io, { maxSteps: 30, stepTimeoutMs: 5000, timeoutMs: 6000 });
    expect(ra.reason).toBe("timeout");
    expect(a.t).toBeLessThanOrEqual(6000);
    const b = mkIo();
    await runUntilStable(b.io, { maxSteps: 30, stepTimeoutMs: 5000, timeoutMs: 10_000_000 });
    expect(b.t).toBeLessThanOrEqual(UNTIL_STABLE_MAX_TOTAL_MS);
    const c = mkIo();
    await runUntilStable(c.io, { maxSteps: 30, stepTimeoutMs: 5000, timeoutMs: 1 });
    expect(c.t).toBeGreaterThanOrEqual(UNTIL_STABLE_MIN_TOTAL_MS - 100);
    expect(c.t).toBeLessThanOrEqual(UNTIL_STABLE_MIN_TOTAL_MS + 100);
  });

  it("clampTotalMs / normalizeScrollArgs：夹到 [1000, 45000]；非数字报错；没给就不带（默认在 runUntilStable 里兜底）", () => {
    expect(clampTotalMs(120_000)).toBe(45_000);
    expect(clampTotalMs(5)).toBe(1000);
    expect(clampTotalMs(NaN)).toBe(45_000);
    const n = (a: any) => normalizeScrollArgs(a, OP_HELPERS as any) as any;
    expect(n({ untilStable: { timeoutMs: 120_000 } }).untilStable.timeoutMs).toBe(45_000);
    expect(n({ untilStable: { timeoutMs: 10 } }).untilStable.timeoutMs).toBe(1000);
    expect(n({ untilStable: { timeoutMs: 20_000 } }).untilStable.timeoutMs).toBe(20_000);
    expect(n({ untilStable: true }).untilStable).toEqual({ maxSteps: 10, stepTimeoutMs: 3000 });
    expect(() => n({ untilStable: { timeoutMs: "9999" } })).toThrow(/timeout_ms/);
  });

  it("server 与主进程的上限常量一致；server 参数解析同样夹到 [1000, 45000]", () => {
    expect(SERVER_MAX).toBe(UNTIL_STABLE_MAX_TOTAL_MS);
    expect(UNTIL_STABLE_BRIDGE_TIMEOUT_MS).toBeGreaterThan(UNTIL_STABLE_MAX_TOTAL_MS);
    const B = class extends Error {};
    const parse = (us: unknown) => parseScrollArgs({ until_stable: us }, {}, B as any, (r) => String(r)) as any;
    expect(parse({ timeout_ms: 999_999 }).untilStable.timeoutMs).toBe(45_000);
    expect(parse({ timeout_ms: 1 }).untilStable.timeoutMs).toBe(1000);
    expect(parse({ max_steps: 3 }).untilStable).toEqual({ maxSteps: 3 });
    expect(parse(true).untilStable).toEqual({});
  });

  it("结果渲染：reason=timeout 说明是总时长上限（不冒充 max_steps）", () => {
    const t = renderUntilStable({ steps: 9, heightBefore: 1000, heightAfter: 9000, atBottom: false, reason: "timeout" });
    expect(t).toMatch(/总时长上限/);
    expect(t).not.toMatch(/最大步数/);
  });
});

describe("R6-17·bridge 本地超时发 cancel{id}（真实 bridge + 假传输）", () => {
  let fake: FakeBrowser | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
    __resetBrowserSettingsForTest();
  });
  afterEach(() => {
    fake?.cleanup();
    fake = null;
    vi.useRealTimers();
    __resetBrowserSettingsForTest();
  });

  it("scroll until_stable 的 bridge 超时是 55s（不是默认 60s）；超时后 TIMEOUT 并向主进程发 cancel（带该请求的 id）", async () => {
    fake = installFakeBrowser({ status: () => ({ exists: true, pendingCount: 0 }), scroll: () => NEVER } as any);
    const tool = getBrowserTools({ taskId: "t-r6-17" }).find((t) => t.name === "browser_scroll")!;
    const p = tool.handler({ until_stable: true }, "tok", { taskId: "t-r6-17" });
    await vi.advanceTimersByTimeAsync(54_000);
    expect(fake.other.filter((m) => m.kind === "cancel")).toHaveLength(0); // 还没到 55s：没超时，也没 cancel
    await vi.advanceTimersByTimeAsync(1_500);
    const out = await p;
    expect(out.isError).toBe(true);
    const cancels = fake.other.filter((m) => m.kind === "cancel");
    expect(cancels).toHaveLength(1);
    const reqs = fake.calls.filter((c) => c.op === "scroll");
    expect(reqs).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ v: 1, kind: "cancel", taskId: "t-r6-17" });
    expect(typeof cancels[0].id).toBe("number");
  });

  it("没超时的正常请求不发 cancel", async () => {
    fake = installFakeBrowser({ status: () => ({ exists: true, pendingCount: 0 }), scroll: () => ({ scroll: { y: 0, docH: 100 } }) } as any);
    const tool = getBrowserTools({ taskId: "t-r6-17b" }).find((t) => t.name === "browser_scroll")!;
    await tool.handler({ direction: "down" }, "tok", { taskId: "t-r6-17b" });
    expect(fake.other.filter((m) => m.kind === "cancel")).toHaveLength(0);
  });
});

describe("R6-17·主进程通道：cancel{id} 只中止那一个请求", () => {
  class FakeProc extends EventEmitter {
    sent: unknown[] = [];
    connected = true;
    send(msg: unknown, cb?: (err?: Error) => void) {
      this.sent.push(msg);
      cb?.();
      return true;
    }
  }
  it("带 id：只 abort 该请求的 signal，同任务别的请求不受影响，不触发任务级 onCancel；不带 id 仍是任务级（兼容）", async () => {
    const signals = new Map<number, AbortSignal>();
    const proc = new FakeProc();
    const onCancel = vi.fn();
    createServerChannel({
      proc: proc as never,
      dispatch: async (_op: string, args: Record<string, unknown>, ctx: { signal: AbortSignal }) => {
        signals.set(args.n as number, ctx.signal);
        return new Promise(() => {});
      },
      onCancel,
      log: () => {},
    } as never);
    proc.emit("message", { v: 1, kind: "req", id: 1, taskId: "t1", op: "scroll", args: { n: 1 } });
    proc.emit("message", { v: 1, kind: "req", id: 2, taskId: "t1", op: "wait_for", args: { n: 2 } });
    proc.emit("message", { v: 1, kind: "req", id: 3, taskId: "t2", op: "scroll", args: { n: 3 } });
    await new Promise((r) => setImmediate(r));
    proc.emit("message", { v: 1, kind: "cancel", taskId: "t1", id: 1 });
    expect(signals.get(1)!.aborted).toBe(true);
    expect(signals.get(2)!.aborted).toBe(false);
    expect(signals.get(3)!.aborted).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    // taskId 对不上的单请求取消不能误杀别人的请求
    proc.emit("message", { v: 1, kind: "cancel", taskId: "t1", id: 3 });
    expect(signals.get(3)!.aborted).toBe(false);
    // 不带 id：任务级（旧行为）
    proc.emit("message", { v: 1, kind: "cancel", taskId: "t1" });
    expect(signals.get(2)!.aborted).toBe(true);
    expect(onCancel).toHaveBeenCalledWith("t1");
  });
});

describe("R6-17·主进程 op 被取消后动作队列 / 面板锁释放（真实 BrowserSession）", () => {
  let env: P4Env | null = null;
  afterEach(() => {
    env?.cleanup();
    env = null;
  });

  it("until_stable 进行中收到 signal 中止：循环立刻退出，activeOps 归零、inflight 清空，下一个动作能立刻排上队", async () => {
    env = await makeP4Env({
      cdp: {
        "Runtime.evaluate": () => ({ result: { value: { scrollHeight: 1000 + Math.floor(Math.random() * 1e6), scrollTop: 0, clientHeight: 800, where: "page" } } }),
      },
    });
    const ac = new AbortController();
    const p = scroll(env.session, { untilStable: { maxSteps: 30, stepTimeoutMs: 5000, timeoutMs: 45_000 } }, { signal: ac.signal }).then(
      () => "OK",
      (err: any) => String(err?.code ?? err?.name ?? err),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(env.session.activeOps).toBe(1); // 滚动循环正占着队列 / 锁
    const t0 = Date.now();
    ac.abort(Object.assign(new Error("server 超时取消"), { code: "CANCELLED" }));
    const res = await p;
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(res).toBe("CANCELLED");
    expect(env.session.activeOps).toBe(0);
    expect(env.session.inflight.size).toBe(0);
    // 队列没卡死：紧接着的动作能执行
    const next = await env.session.runAction({ op: "noop" }, async () => "done");
    expect(next).toBe("done");
  });
});
