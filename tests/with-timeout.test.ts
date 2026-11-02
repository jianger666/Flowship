/**
 * withTimeout：保存类请求的「挂住出口」（弹窗保存中拦关闭时，必须有超时放行，不能造成新的关不掉）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { guardCloseWhileBusy, withTimeout } from "@/lib/with-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("在时限内 resolve：原样返回，并清掉定时器", async () => {
    vi.useFakeTimers();
    const p = withTimeout(Promise.resolve(42), 1000, "超时");
    await expect(p).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("在时限内 reject：原样抛出原错误，并清掉定时器", async () => {
    vi.useFakeTimers();
    const p = withTimeout(Promise.reject(new Error("boom")), 1000, "超时");
    await expect(p).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("超过时限仍 pending：以给定文案 reject", async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    const p = withTimeout(never, 1000, "保存超时");
    const assertion = expect(p).rejects.toThrow("保存超时");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("超时后原 promise 迟到 resolve：被忽略，不二次触发", async () => {
    vi.useFakeTimers();
    let resolveLate!: (v: number) => void;
    const late = new Promise<number>((r) => {
      resolveLate = r;
    });
    const p = withTimeout(late, 500, "超时");
    const assertion = expect(p).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    resolveLate(1);
    await Promise.resolve();
  });
});

describe("withTimeout：传工厂函数时接入 AbortSignal", () => {
  it("超时：先 abort 底层请求的 signal，再以超时文案 reject（底层 AbortError 不会变成未处理拒绝）", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const p = withTimeout(
      (signal) => {
        seen = signal;
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
      1000,
      "请求超时",
    );
    const assertion = expect(p).rejects.toThrow("请求超时");
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(seen?.aborted).toBe(true);
  });

  it("时限内成功：signal 不被 abort、返回原值、清掉定时器", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const p = withTimeout(
      (signal) => {
        seen = signal;
        return Promise.resolve("ok");
      },
      1000,
      "超时",
    );
    await expect(p).resolves.toBe("ok");
    expect(seen?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("时限内失败：原样抛出原错误，signal 不被 abort", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const p = withTimeout(
      (signal) => {
        seen = signal;
        return Promise.reject(new Error("boom"));
      },
      1000,
      "超时",
    );
    await expect(p).rejects.toThrow("boom");
    expect(seen?.aborted).toBe(false);
  });

  it("工厂同步抛错：当作 reject 处理、不留定时器", async () => {
    vi.useFakeTimers();
    const p = withTimeout(
      () => {
        throw new Error("sync boom");
      },
      1000,
      "超时",
    );
    await expect(p).rejects.toThrow("sync boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("guardCloseWhileBusy：保存中拦关闭 + 超时解锁（组合行为）", () => {
  it("忙时忽略「关」、放行「开」；闲时原样放行", () => {
    const calls: boolean[] = [];
    const onOpenChange = (n: boolean) => calls.push(n);
    guardCloseWhileBusy(true, false, onOpenChange);
    expect(calls).toEqual([]);
    guardCloseWhileBusy(true, true, onOpenChange);
    expect(calls).toEqual([true]);
    guardCloseWhileBusy(false, false, onOpenChange);
    expect(calls).toEqual([true, false]);
  });

  it("请求挂住：忙期间 Esc 被拦；超时后 finally 解锁、Esc 能关（不会变成关不掉）", async () => {
    vi.useFakeTimers();
    let busy = false;
    const closes: boolean[] = [];
    const press = () => guardCloseWhileBusy(busy, false, (n) => closes.push(n));

    busy = true;
    const save = withTimeout(new Promise<never>(() => {}), 60_000, "请求超时")
      .catch(() => "failed")
      .finally(() => {
        busy = false;
      });
    press();
    await vi.advanceTimersByTimeAsync(59_999);
    press();
    expect(closes).toEqual([]); // 超时前一直被拦
    await vi.advanceTimersByTimeAsync(1);
    await expect(save).resolves.toBe("failed");
    press();
    expect(closes).toEqual([false]); // 超时解锁后可关
  });

  it("请求成功：解锁后可关；成功路径自己直接关（不经守卫）", async () => {
    let busy = true;
    const saved = await withTimeout(Promise.resolve("ok"), 1000, "超时").finally(() => {
      busy = false;
    });
    expect(saved).toBe("ok");
    const closes: boolean[] = [];
    guardCloseWhileBusy(busy, false, (n) => closes.push(n));
    expect(closes).toEqual([false]);
  });
});

describe("withTimeout：AbortError 一律按「超时」处理、别的 AbortError 不被冒充", () => {
  it("超时 abort 引发的 AbortError 即使抢在前面 reject，调用方拿到的也是超时文案", async () => {
    vi.useFakeTimers();
    try {
      // 底层在 abort 的同一时刻同步 reject AbortError（比 setTimeout 回调里的 reject 更早）
      const p = withTimeout(
        (signal) =>
          new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("This operation was aborted", "AbortError"));
            });
          }),
        100,
        "超时了；服务端可能已保存成功",
      );
      const assertion = expect(p).rejects.toThrow("超时了；服务端可能已保存成功");
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("还没超时、别处触发的 AbortError（例如页面卸载）：原样抛出，不冒充成超时", async () => {
    const abortErr = new DOMException("aborted elsewhere", "AbortError");
    await expect(
      withTimeout(() => Promise.reject(abortErr), 60_000, "超时文案"),
    ).rejects.toBe(abortErr);
  });
});
