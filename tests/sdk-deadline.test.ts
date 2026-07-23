/**
 * SDK deadline 单测：超时 reject、文案可被 isRetryableRunError 识别、成功路径原样返回、
 * 超时后迟到 resolve 走单一入口收尸（Agent.close / Run.cancel）。
 */
import { describe, expect, it, vi } from "vitest";

import { isRetryableRunError } from "@/lib/server/sdk-error";
import {
  SdkDeadlineError,
  reapLateSdkResult,
  withSdkDeadline,
} from "@/lib/server/sdk-deadline";

describe("withSdkDeadline / SdkDeadlineError", () => {
  it("成功路径：在 deadline 内 resolve 原值", async () => {
    const v = await withSdkDeadline(
      Promise.resolve(42),
      1_000,
      "Agent.create",
    );
    expect(v).toBe(42);
  });

  it("超时：reject SdkDeadlineError，message 含 timeout/deadline", async () => {
    vi.useFakeTimers();
    const pending = withSdkDeadline(
      new Promise<number>(() => {
        /* never resolves */
      }),
      100,
      "agent.send",
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: "SdkDeadlineError",
      operation: "agent.send",
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    vi.useRealTimers();
  });

  it("超时错误可被 isRetryableRunError 识别（走 auto-reconnect）", () => {
    const err = new SdkDeadlineError("Agent.resume", 180_000);
    expect(isRetryableRunError(err.message, err)).toBe(true);
  });

  it("超时后清理 timer：不泄漏（成功后不再 reject）", async () => {
    vi.useFakeTimers();
    let resolve!: (n: number) => void;
    const p = new Promise<number>((r) => {
      resolve = r;
    });
    const raced = withSdkDeadline(p, 5_000, "Agent.create");
    resolve(7);
    await expect(raced).resolves.toBe(7);
    // 越过原 deadline 不应再抛（timer 已清）
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
  });

  it("超时后迟到 Agent：默认 reap 调 close", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    let resolveAgent!: (a: { close: () => void }) => void;
    const pendingCreate = new Promise<{ close: () => void }>((r) => {
      resolveAgent = r;
    });
    const raced = withSdkDeadline(pendingCreate, 50, "Agent.create");
    const assertion = expect(raced).rejects.toMatchObject({
      name: "SdkDeadlineError",
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    resolveAgent({ close });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("超时后迟到 Run：默认 reap 调 cancel", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn().mockResolvedValue(undefined);
    let resolveRun!: (r: { cancel: () => Promise<void> }) => void;
    const pendingSend = new Promise<{ cancel: () => Promise<void> }>((r) => {
      resolveRun = r;
    });
    const raced = withSdkDeadline(pendingSend, 50, "agent.send");
    const assertion = expect(raced).rejects.toMatchObject({
      name: "SdkDeadlineError",
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    resolveRun({ cancel });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("onLate 自定义回调优先于默认 reap", async () => {
    vi.useFakeTimers();
    const onLate = vi.fn();
    const close = vi.fn();
    let resolveAgent!: (a: { close: () => void }) => void;
    const pending = new Promise<{ close: () => void }>((r) => {
      resolveAgent = r;
    });
    const raced = withSdkDeadline(pending, 50, "Agent.create", { onLate });
    const assertion = expect(raced).rejects.toBeInstanceOf(SdkDeadlineError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    const agent = { close };
    resolveAgent(agent);
    await Promise.resolve();
    expect(onLate).toHaveBeenCalledWith(agent);
    expect(close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reapLateSdkResult：无 close/cancel 的值安全 no-op", () => {
    expect(() => reapLateSdkResult(null)).not.toThrow();
    expect(() => reapLateSdkResult(42)).not.toThrow();
    expect(() => reapLateSdkResult({})).not.toThrow();
  });
});
