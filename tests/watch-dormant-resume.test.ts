import { describe, expect, it } from "vitest";

import {
  resolveWatchReconnectPolicy,
  shouldResumeWatch,
  WATCH_DORMANT_RETRY_INTERVAL_MS,
  WATCH_MAX_TRANSIENT_FAILURES,
} from "../src/lib/task-terminal";

describe("SSE 重连：预算耗尽后进入休眠、可被唤醒（S12-02）", () => {
  it("退避序列有上限（1.5s 递增、封顶 12s），第 6 次连续失败才耗尽", () => {
    let transientFailures = 0;
    const delays: number[] = [];
    let last: ReturnType<typeof resolveWatchReconnectPolicy> | null = null;
    for (let i = 0; i < WATCH_MAX_TRANSIENT_FAILURES; i++) {
      last = resolveWatchReconnectPolicy({
        kind: "retryable",
        unavailableAttempts: 0,
        transientFailures,
        unavailableNotified: false,
      });
      if (last.action !== "retry") break;
      delays.push(last.delayMs);
      transientFailures = last.nextTransientFailures;
    }
    expect(delays).toEqual([1500, 3000, 4500, 6000, 7500]);
    // 耗尽时由 hook 进入休眠待重连（不再静默 return），决策本身契约不变
    expect(last?.action).toBe("terminate_exhausted");
  });

  it("休眠期：手动重连无条件放行", () => {
    expect(shouldResumeWatch("manual", { hidden: true, online: false })).toBe(
      true,
    );
  });

  it("休眠期：页面隐藏不重连（避免后台疯狂重试）", () => {
    for (const signal of ["online", "visible", "tick"] as const) {
      expect(shouldResumeWatch(signal, { hidden: true, online: true })).toBe(
        false,
      );
    }
  });

  it("休眠期：离线不重连；可见且在线才重连", () => {
    for (const signal of ["online", "visible", "tick"] as const) {
      expect(shouldResumeWatch(signal, { hidden: false, online: false })).toBe(
        false,
      );
      expect(shouldResumeWatch(signal, { hidden: false, online: true })).toBe(
        true,
      );
    }
  });

  it("兜底复查间隔是低频（≥30s）", () => {
    expect(WATCH_DORMANT_RETRY_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
  });
});
