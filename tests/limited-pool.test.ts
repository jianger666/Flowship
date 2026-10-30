/**
 * Q10-03：并发池 runWithLimit —— 并发上限、总时限放手、快照隔离、定时器不泄漏。
 *
 * 纯函数测试：不 mock 任何模块。时间相关的用例用「手动放行的 deferred」而不是 elapsed 阈值——
 * 判据是「能不能返回」（等了在途任务就会挂到测试超时），不是「花了几毫秒」，所以机器再忙也不抖。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithLimit, type PoolGuard } from "@/lib/server/limited-pool";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/**
 * 真实时钟：ms 内没落定就失败并说清原因——比等 vitest 的 5 秒超时好：
 * vitest 的超时在 JSON / 部分 reporter 里只剩一个占位栈（Error: STACK_TRACE_ERROR），看不出是谁卡住了。
 */
const settled = async <T>(p: Promise<T>, what: string, ms = 4000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what}：${ms}ms 内没有返回（在等不该等的东西：定时器 / 在途任务）`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, stuck]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 假时钟下（setTimeout 被接管，上面的兜底不可用）：不推进时间、只让出足够多轮微任务，看 promise 是否已落定。
 * 「在等定时器才肯返回」的实现会得到 false。
 */
const settlesWithoutTime = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < 3000; i += 1) await Promise.resolve();
  return done;
};

/** 记并发峰值的 worker：每个任务睡 delay 毫秒，返回 n*10 */
const tracker = (delay: number | ((n: number) => number)) => {
  const state = { inFlight: 0, peak: 0, started: 0 };
  const worker = async (n: number): Promise<number> => {
    state.started += 1;
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    await sleep(typeof delay === "function" ? delay(n) : delay);
    state.inFlight -= 1;
    return n * 10;
  };
  return { state, worker };
};

const values = <R>(slots: Array<{ value: R } | undefined>) =>
  slots.map((s) => s?.value);

afterEach(() => {
  vi.useRealTimers();
});

describe("并发上限", () => {
  it("同一时刻最多 limit 个在跑：峰值恰好等于 limit（不多不少）", async () => {
    const { state, worker } = tracker(12);
    const out = await runWithLimit(range(20), 3, worker);
    expect(state.peak).toBe(3);
    expect(state.started).toBe(20);
    expect(out.every((s) => s !== undefined)).toBe(true);
  });

  it("结果按输入位置对位，与任务完成先后无关", async () => {
    // 越靠前越慢：完成顺序与输入顺序相反
    const { worker } = tracker((n) => (5 - n) * 8);
    const out = await runWithLimit(range(5), 5, worker);
    expect(values(out)).toEqual([0, 10, 20, 30, 40]);
  });

  it.each([
    [0, 1],
    [-3, 1],
    [Number.NaN, 1],
    [2.9, 2],
    [Number.POSITIVE_INFINITY, 6],
    [100, 6],
  ])("limit=%s 夹到 [1, items.length]：峰值 %s", async (limit, expectedPeak) => {
    const { state, worker } = tracker(8);
    const out = await runWithLimit(range(6), limit, worker);
    expect(state.peak).toBe(expectedPeak);
    // 传错值不能把池卡死：全部跑完
    expect(values(out)).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it("空输入：直接返回 []，不调 worker、不问 guard", async () => {
    const worker = vi.fn(async (n: number) => n);
    const guard: PoolGuard = {
      shouldStop: vi.fn(() => false),
      deadlineAt: Date.now() + 1000,
      onAbandon: vi.fn(),
    };
    expect(await runWithLimit([], 4, worker, guard)).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
    expect(guard.shouldStop).not.toHaveBeenCalled();
    expect(guard.onAbandon).not.toHaveBeenCalled();
  });

  it("worker 自己返回 undefined 也是「跑完了」（槽 { value: undefined } ≠ 没跑完 undefined）", async () => {
    const out = await runWithLimit([1, 2, 3], 2, async () => undefined);
    expect(out).toEqual([
      { value: undefined },
      { value: undefined },
      { value: undefined },
    ]);
  });
});

describe("shouldStop：领新任务前问一次", () => {
  it("返回 true 后不再领：已启动的跑完，没轮到的槽是 undefined，且不算放手", async () => {
    const { state, worker } = tracker(10);
    let allowed = 5;
    const onAbandon = vi.fn();
    const out = await settled(
      runWithLimit(range(12), 2, worker, {
        shouldStop: () => allowed-- <= 0, // 前 5 次询问放行，之后一律停
        deadlineAt: Date.now() + 60_000,
        onAbandon,
      }),
      "shouldStop 返回 true 之后",
    );
    expect(state.started).toBe(5);
    expect(values(out)).toEqual([
      0, 10, 20, 30, 40,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    ]);
    // 是 shouldStop 主动停的、不是定时器到点：不该走放手回调
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("一开始就该停：一个 worker 都不启动", async () => {
    const worker = vi.fn(async (n: number) => n);
    const out = await settled(
      runWithLimit(range(4), 2, worker, {
        shouldStop: () => true,
        deadlineAt: Date.now() + 60_000,
        onAbandon: vi.fn(),
      }),
      "一开始就该停",
    );
    expect(worker).not.toHaveBeenCalled();
    expect(out).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("到点放手", () => {
  /** 前两个 10ms 跑完，其余全部「在途」——由测试手动放行（gates） */
  const makeGatedWorker = () => {
    const gates = new Map<number, () => void>();
    let calls = 0;
    const worker = (n: number) =>
      new Promise<number>((resolve) => {
        calls += 1;
        if (n < 2) {
          setTimeout(() => resolve(n * 10), 10);
          return;
        }
        gates.set(n, () => resolve(n * 10));
      });
    return { gates, worker, calls: () => calls };
  };

  it("不再等在途任务：带着已完成的部分返回，onAbandon 恰好一次", async () => {
    const { gates, worker, calls } = makeGatedWorker();
    const onAbandon = vi.fn();
    const out = await settled(
      runWithLimit(range(8), 2, worker, {
        shouldStop: () => false,
        deadlineAt: Date.now() + 120,
        onAbandon,
      }),
      "到点放手",
    );
    // 能走到这里本身就证明没等在途任务：在途的两个永远不会自己完成，等它们就会卡住（上面的 settled 会给出明确的失败）
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(values(out)).toEqual([
      0, 10,
      undefined, undefined, undefined, undefined, undefined, undefined,
    ]);
    // 在途的正好是 limit 个（2、3），后面的没领过
    expect([...gates.keys()].sort()).toEqual([2, 3]);
    expect(calls()).toBe(4);
  });

  it("放手后：在途任务跑完也不会改动已返回的结果，也不会再领新任务", async () => {
    const { gates, worker, calls } = makeGatedWorker();
    const out = await settled(
      runWithLimit(range(8), 2, worker, {
        shouldStop: () => false, // 故意不「粘」：池自己也得停
        deadlineAt: Date.now() + 120,
        onAbandon: vi.fn(),
      }),
      "放手之后的返回",
    );
    const snapshot = values(out);
    expect(snapshot[2]).toBeUndefined();

    gates.forEach((open) => open()); // 在途任务这时才完成
    await sleep(40);

    expect(values(out)).toEqual(snapshot); // 快照没被后来的写入改动
    expect(calls()).toBe(4); // 没有因为在途任务让出位置而领新任务
  });

  it("deadlineAt 已经过去：先放出 limit 个，立刻放手（不会负数延时卡住）", async () => {
    const { gates, worker } = makeGatedWorker();
    const onAbandon = vi.fn();
    const out = await settled(
      runWithLimit(range(6), 3, (n) => worker(n + 2), {
        shouldStop: () => false,
        deadlineAt: Date.now() - 5_000,
        onAbandon,
      }),
      "deadlineAt 已经过去",
    );
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(out.every((s) => s === undefined)).toBe(true);
    expect(gates.size).toBe(3);
  });
});

describe("定时器不泄漏", () => {
  const guard = (): PoolGuard => ({
    shouldStop: () => false,
    deadlineAt: Date.now() + 60_000,
    onAbandon: vi.fn(),
  });

  it("全部在时限前跑完：不放手，定时器被清掉", async () => {
    vi.useFakeTimers();
    const g = guard();
    const run = runWithLimit(range(5), 2, async (n) => n, g);
    // 假时钟不推进时间：任务都跑完了就该返回，不能等放手的定时器到点
    expect(await settlesWithoutTime(run), "全部跑完后没有立刻返回（在等定时器？）").toBe(true);
    const out = await run;
    expect(values(out)).toEqual([0, 1, 2, 3, 4]);
    expect(g.onAbandon).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("worker 抛错：整体 reject（与 Promise.all 一致），定时器照样被清掉", async () => {
    vi.useFakeTimers();
    const run = runWithLimit(
      range(3),
      2,
      async (n) => {
        if (n === 1) throw new Error("boom");
        return n;
      },
      guard(),
    );
    expect(await settlesWithoutTime(run), "worker 抛错后没有立刻 reject（在等定时器？）").toBe(true);
    await expect(run).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("不带 guard：只有并发上限，不起定时器", async () => {
    vi.useFakeTimers();
    const out = await runWithLimit(range(4), 2, async (n) => n + 1);
    expect(values(out)).toEqual([1, 2, 3, 4]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
