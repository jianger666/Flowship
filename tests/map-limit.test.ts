/** `mapLimit`：有界并发 map（schedule-store 扫目录 / schedule-service 聚合 / shell 追踪认人共用） */
import { describe, expect, it } from "vitest";

import { mapLimit } from "../src/lib/server/map-limit";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("同时在途的不超过 limit，且全部跑完", async () => {
    let inflight = 0;
    let peak = 0;
    let done = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    await mapLimit(items, 4, async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await sleep(2);
      inflight -= 1;
      done += 1;
    });
    expect(done).toBe(50);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // 确实是并发，不是退化成串行
  });

  it("结果按入参顺序，不按完成顺序（先入的睡得久）", async () => {
    const out = await mapLimit([30, 20, 10, 0], 4, async (ms) => {
      await sleep(ms);
      return ms;
    });
    expect(out).toEqual([30, 20, 10, 0]);
  });

  it("空数组 / limit 非法（0 或负数）也能正常跑完（至少 1 路）", async () => {
    expect(await mapLimit([], 8, async (x: number) => x)).toEqual([]);
    expect(await mapLimit([1, 2, 3], 0, async (x) => x * 2)).toEqual([2, 4, 6]);
    expect(await mapLimit([1, 2, 3], -5, async (x) => x * 2)).toEqual([2, 4, 6]);
  });

  it("limit 是 NaN / undefined：退化成串行，fn 照样每条都跑（不是一次不跑还不报错）", async () => {
    const seen: number[] = [];
    const out1 = await mapLimit([1, 2, 3], Number.NaN, async (x) => {
      seen.push(x);
      return x * 10;
    });
    expect(out1).toEqual([10, 20, 30]);
    const out2 = await mapLimit([1, 2, 3], undefined as unknown as number, async (x) => x + 1);
    expect(out2).toEqual([2, 3, 4]);
    expect(seen).toEqual([1, 2, 3]);
    // Infinity / 小数 / 负数 都照常
    expect(await mapLimit([1, 2], Number.POSITIVE_INFINITY, async (x) => x)).toEqual([1, 2]);
    expect(await mapLimit([1, 2], 1.5, async (x) => x)).toEqual([1, 2]);
  });

  it("limit 大于条数：不多开 worker", async () => {
    let peak = 0;
    let inflight = 0;
    await mapLimit([1, 2], 100, async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await sleep(2);
      inflight -= 1;
    });
    expect(peak).toBe(2);
  });

  it("fn 抛错 → 整体 reject（单个失败要隔离的调用方自己在 fn 里 catch）", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
  });
});
