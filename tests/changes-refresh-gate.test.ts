/**
 * 改动清单刷新的并发控制（纯 TS，用手动控制的假读取验证行为）：
 * 静默刷新不叠加、显式刷新取代在途、中止、失败不卡死、耗时上报、轮询间隔自适应。
 */
import { describe, expect, it } from "vitest";

import { createRefreshGate, nextPollDelay, type RefreshContext } from "@/lib/changes/refresh";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** 让已就绪的微任务 / 定时器跑完 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const harness = (clock = { t: 0 }, timings: number[] = []) => {
  const calls: { ctx: RefreshContext; done: Deferred }[] = [];
  const gate = createRefreshGate({
    load: (ctx) => {
      const done = deferred();
      calls.push({ ctx, done });
      return done.promise;
    },
    onTiming: (ms) => timings.push(ms),
    now: () => clock.t,
  });
  return { gate, calls, clock, timings };
};

describe("createRefreshGate", () => {
  it("空闲时：静默与显式都立即发请求；跑完后回到空闲", async () => {
    const { gate, calls } = harness();
    expect(gate.inFlight()).toBe(false);
    const a = gate.request({ silent: true });
    expect(calls).toHaveLength(1);
    expect(gate.inFlight()).toBe(true);
    calls[0].done.resolve();
    await a;
    expect(gate.inFlight()).toBe(false);

    const b = gate.request();
    expect(calls).toHaveLength(2);
    calls[1].done.resolve();
    await b;
    expect(gate.inFlight()).toBe(false);
  });

  it("静默刷新在途时不叠加：跑完只补一次，不管期间触发了多少次", async () => {
    const { gate, calls } = harness();
    const first = gate.request({ silent: true });
    // 在途期间连续触发 5 次静默：都不发新请求，且立即返回
    for (let i = 0; i < 5; i++) await gate.request({ silent: true });
    expect(calls).toHaveLength(1);
    expect(gate.inFlight()).toBe(true);

    calls[0].done.resolve();
    await first;
    // 补了一次（只一次），补的那次正在跑
    expect(calls).toHaveLength(2);
    expect(gate.inFlight()).toBe(true);
    calls[1].done.resolve();
    await flush();
    // 补的那次期间没有新触发 → 不再补
    expect(calls).toHaveLength(2);
    expect(gate.inFlight()).toBe(false);
  });

  it("补发的那次同样是静默的：它在途期间再来触发，继续合并成「再补一次」", async () => {
    const { gate, calls } = harness();
    const first = gate.request({ silent: true });
    await gate.request({ silent: true });
    calls[0].done.resolve();
    await first;
    expect(calls).toHaveLength(2);

    await gate.request({ silent: true }); // 补发的那次在途
    expect(calls).toHaveLength(2);
    calls[1].done.resolve();
    await flush();
    expect(calls).toHaveLength(3);
    calls[2].done.resolve();
    await flush();
    expect(gate.inFlight()).toBe(false);
  });

  it("显式刷新取代在途：旧请求被中止、结果作废；旧请求收尾不抹掉新请求的状态，也不触发补发", async () => {
    const { gate, calls } = harness();
    const old = gate.request({ silent: true });
    await gate.request({ silent: true }); // 记一笔待补
    const next = gate.request(); // 显式：取代
    expect(calls).toHaveLength(2);
    expect(calls[0].ctx.signal.aborted).toBe(true);
    expect(calls[0].ctx.isCurrent()).toBe(false);
    expect(calls[1].ctx.signal.aborted).toBe(false);
    expect(calls[1].ctx.isCurrent()).toBe(true);

    // 旧的此时才结束（真实场景里是 fetch 抛 AbortError）
    calls[0].done.reject(new DOMException("aborted", "AbortError"));
    await old;
    expect(gate.inFlight()).toBe(true); // 新的还在跑
    expect(calls).toHaveLength(2); // 待补已随取代作废、不补发

    calls[1].done.resolve();
    await next;
    expect(gate.inFlight()).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("先发后到：旧请求的响应晚于新请求时，旧的 isCurrent 一直是 false（结果不会盖掉新数据）", async () => {
    const { gate, calls } = harness();
    const a = gate.request();
    const b = gate.request();
    calls[1].done.resolve();
    await b;
    calls[0].done.resolve();
    await a;
    expect(calls[0].ctx.isCurrent()).toBe(false);
    expect(calls[1].ctx.isCurrent()).toBe(true);
  });

  it("abort：中止在途、清掉待补；已中止的结果不再算当前；之后仍可正常使用", async () => {
    const { gate, calls } = harness();
    const p = gate.request({ silent: true });
    await gate.request({ silent: true }); // 待补
    gate.abort();
    expect(calls[0].ctx.signal.aborted).toBe(true);
    // 即使没有新请求取代它，已中止的结果也不能落
    expect(calls[0].ctx.isCurrent()).toBe(false);
    expect(gate.inFlight()).toBe(false);

    calls[0].done.resolve();
    await p;
    expect(calls).toHaveLength(1); // 没补发

    const again = gate.request({ silent: true });
    expect(calls).toHaveLength(2);
    expect(calls[1].ctx.isCurrent()).toBe(true);
    calls[1].done.resolve();
    await again;
    expect(gate.inFlight()).toBe(false);
  });

  it("空闲时 abort 是无害的空操作", async () => {
    const { gate, calls } = harness();
    gate.abort();
    expect(gate.inFlight()).toBe(false);
    const p = gate.request();
    expect(calls[0].ctx.isCurrent()).toBe(true);
    calls[0].done.resolve();
    await p;
  });

  it("读取失败：request 不 reject、闸门不卡死；失败后待补照样补", async () => {
    const { gate, calls } = harness();
    const p = gate.request({ silent: true });
    await gate.request({ silent: true });
    calls[0].done.reject(new Error("boom"));
    await expect(p).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    calls[1].done.resolve();
    await flush();
    expect(gate.inFlight()).toBe(false);
  });

  it("上报读取耗时：成功与失败都算（慢 / 超时同样该让轮询放慢），被中止的不算", async () => {
    const { gate, calls, clock, timings } = harness({ t: 1000 });
    const a = gate.request({ silent: true });
    clock.t += 120;
    calls[0].done.resolve();
    await a;

    const b = gate.request({ silent: true });
    clock.t += 800;
    calls[1].done.reject(new Error("x"));
    await b;
    expect(timings).toEqual([120, 800]);

    const c = gate.request({ silent: true });
    clock.t += 50;
    gate.abort();
    calls[2].done.resolve();
    await c;
    expect(timings).toEqual([120, 800]);
  });
});

describe("nextPollDelay：轮询间隔随读取耗时自适应", () => {
  it.each([
    // 基础间隔, 上次耗时, 期望
    [4000, null, 4000], // 还没读过
    [4000, 0, 4000],
    [4000, -5, 4000],
    [4000, Number.NaN, 4000],
    [4000, Number.POSITIVE_INFINITY, 4000],
    [4000, 100, 4000], // 读得快：就是基础间隔
    [4000, 1333, 4000], // 3 倍 = 3999 < 基础
    [4000, 1500, 4500], // 读得慢：至少 3 倍
    [4000, 3000, 9000],
    [4000, 30_000, 60_000], // 封顶一分钟
    [4000, 120_000, 60_000],
    [10_000, 2000, 10_000], // 基础间隔本来就更长：不缩短
    [90_000, 100, 90_000], // 基础间隔比封顶还大：不被封顶截短
  ])("基础 %i ms、上次 %s ms → %i ms", (base, last, expected) => {
    expect(nextPollDelay(base, last)).toBe(expected);
  });

  it("读得慢之后又变快：间隔随之恢复", () => {
    expect(nextPollDelay(4000, 5000)).toBe(15_000);
    expect(nextPollDelay(4000, 200)).toBe(4000);
  });
});
