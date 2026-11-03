/** 媒体卡片的元数据缓存（LRU）与并发闸：纯逻辑。 */
import { describe, expect, it } from "vitest";

import {
  createLimiter,
  createMediaCardCache,
  mediaCardCacheKey,
  posterSeekTime,
  type MediaCardMetaReady,
} from "@/lib/media/media-card-cache";

const meta = (duration: number): MediaCardMetaReady => ({ status: "ready", duration, size: 1 });

describe("mediaCardCache（LRU）", () => {
  it("命中返回同一份；键含 ETag，文件被重新生成后不会拿旧封面冒充", () => {
    const cache = createMediaCardCache(10);
    cache.set(mediaCardCacheKey("/a.mp4", '"1-100"'), meta(10));
    expect(cache.get(mediaCardCacheKey("/a.mp4", '"1-100"'))?.duration).toBe(10);
    expect(cache.get(mediaCardCacheKey("/a.mp4", '"1-200"'))).toBeUndefined();
  });

  it("超过上限淘汰最久没用的；读取会刷新新鲜度", () => {
    const cache = createMediaCardCache(2);
    cache.set("a", meta(1));
    cache.set("b", meta(2));
    expect(cache.get("a")).toBeDefined(); // a 变成最近使用
    cache.set("c", meta(3)); // 淘汰 b
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.size()).toBe(2);
  });

  it("同键覆盖不会增加条目数", () => {
    const cache = createMediaCardCache(3);
    cache.set("a", meta(1));
    cache.set("a", meta(9));
    expect(cache.size()).toBe(1);
    expect(cache.get("a")?.duration).toBe(9);
  });
});

describe("createLimiter（并发闸）", () => {
  it("同时运行的任务不超过上限，其余先进先出", async () => {
    const limiter = createLimiter(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (id: number) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      order.push(id);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return id;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => limiter.run(task(i))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(limiter.pending()).toBe(0);
  });

  it("某个任务抛错不会卡死队列，后面的照常执行", async () => {
    const limiter = createLimiter(1);
    const bad = limiter.run(async () => {
      throw new Error("boom");
    });
    const good = limiter.run(async () => "ok");
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe("ok");
    expect(limiter.pending()).toBe(0);
  });

  it("并发数小于 1 按 1 处理（不会一个都不跑）", async () => {
    const limiter = createLimiter(0);
    await expect(limiter.run(async () => 7)).resolves.toBe(7);
  });
});

describe("posterSeekTime", () => {
  it("取片长 10%、最多 1 秒；时长未知 / 为 0 取 0", () => {
    expect(posterSeekTime(100)).toBe(1);
    expect(posterSeekTime(5)).toBe(0.5);
    expect(posterSeekTime(0)).toBe(0);
    expect(posterSeekTime(Number.NaN)).toBe(0);
  });
});
