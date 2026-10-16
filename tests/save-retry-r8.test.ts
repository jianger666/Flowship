/**
 * 第八轮 L1-01（全表）：4xx 里只有 408 / 425 / 429 要重试，其余一律是永久拒绝。
 *
 * 408 / 425 / 429 各自的「首次 / 重试 / 混合 / 世代」行为用例在 tests/save-retry.test.ts（同批第八轮 L1-01 的 describe）里；
 * 这里只补它没有的一条：把 400–499 整段逐个走一遍真实函数体（saveWithRetry + createSaveRetrier + 假定时器），
 * 钉死「例外恰好是这三个、不多不少」——以后有人把例外放宽成一个范围（如 `>= 408 && <= 429`）或漏掉一个，这里会红。
 * 假定时器：vi.useFakeTimers() 默认连 setInterval 一起 fake；不含任何绝对耗时阈值。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSaveRetrier, saveWithRetry } from "@/lib/save-retry";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** 带 HTTP 状态码的失败结果（local-store.saveSettingsDetailed 的形状） */
const fail = (status: number) => ({ ok: false as const, status });

// 4xx 里「同一份请求体再发可能成功」的三个：请求超时 / Too Early / Too Many Requests
const RETRYABLE_4XX = [408, 425, 429] as const;

describe("第八轮 L1-01（全表）：4xx 里只有 408 / 425 / 429 重试", () => {
  it("400–499 逐个过真实 saveWithRetry：只有 408 / 425 / 429 重试，其余 97 个一律走 onRejected、不重试", async () => {
    const retried: number[] = [];
    const rejected: number[] = [];
    for (let status = 400; status <= 499; status++) {
      const r = createSaveRetrier({ delaysMs: [100] });
      const retry = vi.fn(async () => true);
      const onRejected = vi.fn();
      await saveWithRetry({ retrier: r, key: "k", first: async () => fail(status), retry, onRejected });
      await vi.advanceTimersByTimeAsync(100);
      if (retry.mock.calls.length > 0) retried.push(status);
      if (onRejected.mock.calls.length > 0) rejected.push(status);
    }
    expect(retried).toEqual([...RETRYABLE_4XX]);
    // 与「重试」互斥、不重叠：被拒绝的恰好是其余 97 个
    expect(rejected).toHaveLength(100 - RETRYABLE_4XX.length);
    expect(rejected.filter((s) => (RETRYABLE_4XX as readonly number[]).includes(s))).toEqual([]);
  });

  it("同一张表里：被拒绝的 4xx 不提示「将自动重试」（onFailed 不触发）；可重试的 3 个才提示", async () => {
    const failedFor: number[] = [];
    for (let status = 400; status <= 499; status++) {
      const r = createSaveRetrier({ delaysMs: [100] });
      const onFailed = vi.fn();
      await saveWithRetry({ retrier: r, key: "k", first: async () => fail(status), retry: async () => true, onFailed });
      if (onFailed.mock.calls.length > 0) failedFor.push(status);
    }
    expect(failedFor).toEqual([...RETRYABLE_4XX]);
  });

  it("重试那一次（createSaveRetrier）也是同一张表：408 / 425 / 429 继续退避、其余 4xx 立刻终止（attempt 只跑一次）", async () => {
    const continued: number[] = [];
    const terminated: number[] = [];
    for (let status = 400; status <= 499; status++) {
      const onRejected = vi.fn();
      const onGiveUp = vi.fn();
      const r = createSaveRetrier({ delaysMs: [10, 10], onRejected, onGiveUp });
      const attempt = vi.fn(async () => fail(status));
      r.schedule("k", attempt);
      await vi.advanceTimersByTimeAsync(1_000);
      if (attempt.mock.calls.length === 2 && onGiveUp.mock.calls.length === 1) continued.push(status);
      if (attempt.mock.calls.length === 1 && onRejected.mock.calls.length === 1) terminated.push(status);
    }
    expect(continued).toEqual([...RETRYABLE_4XX]);
    expect(terminated).toHaveLength(100 - RETRYABLE_4XX.length);
  });
});
