/**
 * awaitWithCap：「最多等 capMs，等不到就放手」（status 接口等桥接对账用，R20-15）
 *
 * 要钉的是它的**每条语义**，不是「大概能跑」：
 *  - cap 之前兑现 → 带值返回、计时器清干净；
 *  - cap 之前拒绝 → 照样抛给调用方（发起方自己的对账失败由调用方记日志）；
 *  - 先到 cap → 返回 { capped: true }、不取消 p（后台继续跑完）；
 *  - cap 之后 p 才拒绝 → 不变成 unhandledRejection，交给 onLateError（回调自己抛也不外泄）；缺省静默。
 * 与真实对账合在一起的一条（并入卡住的在途对账 → 到点放手 → 放手后对账仍收尾）在 feishu-bridge-settings-sync.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { awaitWithCap } from "@/lib/server/feishu-bridge/await-with-cap";

import { readSource } from "./helpers/source-text";

/** 用 deferred 摆出「想什么时候兑现 / 拒绝都行」的 p */
const deferredOf = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("awaitWithCap（fake timers）", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    process.off("unhandledRejection", onUnhandled);
  });

  /** 让微任务 / 回调链走完（unhandledRejection 在 process 层面是下一轮事件循环才触发，所以真让出一次） */
  const settleMicrotasks = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await new Promise<void>((r) => setImmediate(r));
    vi.useFakeTimers();
  };

  it("cap 之前兑现：带值返回 { capped: false }，计时器已清（不留悬挂定时器）", async () => {
    const d = deferredOf<string>();
    const r = awaitWithCap(d.promise, 15_000);
    await vi.advanceTimersByTimeAsync(1_000);
    d.resolve("done");
    await expect(r).resolves.toEqual({ capped: false, value: "done" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("先到 cap：返回 { capped: true }；到点之前不会提前放手", async () => {
    const d = deferredOf<string>();
    let result: unknown = null;
    void awaitWithCap(d.promise, 15_000).then((v) => {
      result = v;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(result).toBeNull(); // 还差 1ms：必须还在等
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ capped: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("放手不取消 p：到点放手之后 p 仍可以兑现（后台继续跑完）", async () => {
    let finished = false;
    const d = deferredOf<void>();
    const p = d.promise.then(() => {
      finished = true;
    });
    const r = awaitWithCap(p, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(r).resolves.toEqual({ capped: true });
    expect(finished).toBe(false);
    d.resolve();
    await p;
    expect(finished).toBe(true);
  });

  it("cap 之前拒绝：错误照样抛给调用方（不被吞），计时器清干净", async () => {
    const d = deferredOf<string>();
    const r = awaitWithCap(d.promise, 15_000);
    const caught = r.then(
      () => "resolved",
      (e: unknown) => `rejected:${(e as Error).message}`,
    );
    d.reject(new Error("boom"));
    expect(await caught).toBe("rejected:boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cap 之后 p 才拒绝：错误交给 onLateError，且不产生 unhandledRejection", async () => {
    const d = deferredOf<string>();
    const late: unknown[] = [];
    const r = awaitWithCap(d.promise, 100, (e) => late.push(e));
    await vi.advanceTimersByTimeAsync(100);
    await expect(r).resolves.toEqual({ capped: true });
    expect(late).toEqual([]); // 还没拒绝，回调不能提前被叫

    const err = new Error("late-boom");
    d.reject(err);
    await settleMicrotasks();
    expect(late).toEqual([err]);
    expect(unhandled).toEqual([]);
  });

  it("onLateError 自己抛错：也不外泄成 unhandledRejection", async () => {
    const d = deferredOf<string>();
    const r = awaitWithCap(d.promise, 100, () => {
      throw new Error("logger-broke");
    });
    await vi.advanceTimersByTimeAsync(100);
    await r;
    d.reject(new Error("late-boom"));
    await settleMicrotasks();
    expect(unhandled).toEqual([]);
  });

  it("缺省 onLateError：cap 之后的拒绝静默吞掉（不是 unhandledRejection）", async () => {
    const d = deferredOf<string>();
    const r = awaitWithCap(d.promise, 100);
    await vi.advanceTimersByTimeAsync(100);
    await r;
    d.reject(new Error("late-boom"));
    await settleMicrotasks();
    expect(unhandled).toEqual([]);
  });

  it("p 在 cap 之前已经是 settled：立即带值返回，不需要推进时间", async () => {
    await expect(awaitWithCap(Promise.resolve(7), 15_000)).resolves.toEqual({
      capped: false,
      value: 7,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("awaitWithCap（真实计时器）", () => {
  it("永不兑现的 p：真实计时器下到点放手（20ms），不会挂住", async () => {
    const t0 = Date.now();
    const r = await awaitWithCap(new Promise<never>(() => undefined), 20);
    expect(r).toEqual({ capped: true });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("源码结构钉子：计时器 unref（兜底：不拖住进程退出）且在 finally 里清掉", () => {
    const src = readSource("src/lib/server/feishu-bridge/await-with-cap.ts");
    expect(src).toMatch(/timer\.unref\?\.\(\)/);
    expect(src).toMatch(/finally \{[\s\S]*clearTimeout\(timer\)/);
  });
});
