import { describe, expect, it } from "vitest";

import {
  buildEventDedupKeyWithEpoch,
  buildIntentRefMarker,
  buildTotalRssLimit,
  classifyWorkerMemory,
  decideInterceptTier,
  IDLE_TTL_MINUTES,
  isAtMostOnceKind,
  isRelayOverBudget,
  isRotationAllowed,
  isWriteFenced,
  MAX_WORKERS_HARD_CAP,
  nextWorkerEpoch,
  parseWorkerEpoch,
  RELAY_BUDGET_TOKENS,
  resolveMaxWorkers,
  ROTATION_MAX_PER_ACTION,
  ROTATION_MAX_PER_TASK_PER_HOUR,
  ROTATION_TASK_TOTAL_CAP,
  SESSION_IDLE_TTL_MINUTES,
  shouldAutoRetryIntent,
  WORKER_HEAP_RATIO_HARD,
  WORKER_IDLE_REAP_MINUTES,
  WORKER_RSS_HARD_BYTES,
} from "../src/lib/server/mem-governance";

describe("v3.1 §3.2 双 guard", () => {
  it("三线取最高档", () => {
    expect(
      classifyWorkerMemory({
        oldSpaceBytes: 100,
        heapRatio: 0.1,
        rssBytes: 100,
      }),
    ).toBe("normal");
    expect(
      classifyWorkerMemory({
        oldSpaceBytes: 1.3 * 1024 * 1024 * 1024,
        heapRatio: 0.1,
        rssBytes: 100,
      }),
    ).toBe("soft");
    expect(
      classifyWorkerMemory({
        oldSpaceBytes: 100,
        heapRatio: WORKER_HEAP_RATIO_HARD,
        rssBytes: 100,
      }),
    ).toBe("hard");
    expect(
      classifyWorkerMemory({
        oldSpaceBytes: 100,
        rssBytes: WORKER_RSS_HARD_BYTES + 1,
      }),
    ).toBe("hard");
  });
});

describe("v3.1 §3.4 整机顶", () => {
  it("TTL 单一常数对齐", () => {
    expect(IDLE_TTL_MINUTES).toBe(SESSION_IDLE_TTL_MINUTES);
    expect(WORKER_IDLE_REAP_MINUTES).toBe(IDLE_TTL_MINUTES);
  });

  it("动态 MAX_WORKERS：上限 4、下限 1", () => {
    const GB = 1024 * 1024 * 1024;
    // 32G 服务器跑满 4
    expect(
      resolveMaxWorkers({ totalMemBytes: 32 * GB, reserveBytes: 4 * GB }),
    ).toBe(MAX_WORKERS_HARD_CAP);
    // 16G 开发机降到 2~3（按 2.3G/worker）
    const dev = resolveMaxWorkers({
      totalMemBytes: 16 * GB,
      reserveBytes: 8 * GB,
    });
    expect(dev).toBeGreaterThanOrEqual(1);
    expect(dev).toBeLessThanOrEqual(4);
    // 小内存保底 1，不许算出 0
    expect(resolveMaxWorkers({ totalMemBytes: 2 * GB, reserveBytes: 4 * GB })).toBe(1);
    expect(resolveMaxWorkers({ totalMemBytes: 0, reserveBytes: 0 })).toBe(1);
  });

  it("整机公式", () => {
    expect(
      buildTotalRssLimit({ mainProcRssBytes: 500, maxWorkers: 2 }),
    ).toBe(500 + 2 * WORKER_RSS_HARD_BYTES);
  });
});

describe("v3.1 §4 双限额", () => {
  it("任一超限即降级", () => {
    expect(
      isRotationAllowed({ actionCount: 0, taskHourCount: 0, taskTotalCount: 0 }).allowed,
    ).toBe(true);
    expect(
      isRotationAllowed({
        actionCount: ROTATION_MAX_PER_ACTION,
        taskHourCount: 0,
        taskTotalCount: 0,
      }),
    ).toEqual({ allowed: false, reason: "action-cap" });
    expect(
      isRotationAllowed({
        actionCount: 0,
        taskHourCount: ROTATION_MAX_PER_TASK_PER_HOUR,
        taskTotalCount: 0,
      }),
    ).toEqual({ allowed: false, reason: "hour-cap" });
    expect(
      isRotationAllowed({
        actionCount: 0,
        taskHourCount: 0,
        taskTotalCount: ROTATION_TASK_TOTAL_CAP,
      }),
    ).toEqual({ allowed: false, reason: "task-cap" });
  });
});

describe("v3.1 §5.1 intent", () => {
  it("幂等标记格式", () => {
    expect(buildIntentRefMarker("t1:a1:c1")).toBe("[ref:t1:a1:c1]");
  });

  it("at-most-once：feishu/notify 不自动重试", () => {
    expect(isAtMostOnceKind("feishu-message")).toBe(true);
    expect(isAtMostOnceKind("notify")).toBe(true);
    expect(isAtMostOnceKind("git-push")).toBe(false);
    expect(
      shouldAutoRetryIntent({ kind: "feishu-message", verifiedAbsent: true }),
    ).toBe(false);
    expect(
      shouldAutoRetryIntent({ kind: "notify", verifiedAbsent: false }),
    ).toBe(false);
    // 不确定时一律不重发
    expect(
      shouldAutoRetryIntent({ kind: "git-push", verifiedAbsent: false }),
    ).toBe(false);
    expect(
      shouldAutoRetryIntent({ kind: "git-push", verifiedAbsent: true }),
    ).toBe(true);
  });
});

describe("v3.1 §6 接力预算", () => {
  it("8k 硬顶", () => {
    expect(RELAY_BUDGET_TOKENS).toBe(8000);
    expect(isRelayOverBudget(8000)).toBe(false);
    expect(isRelayOverBudget(8001)).toBe(true);
  });
});

describe("v3.1 §7 epoch", () => {
  it("解析：缺失/损坏回 0", () => {
    expect(parseWorkerEpoch(null)).toBe(0);
    expect(parseWorkerEpoch("")).toBe(0);
    expect(parseWorkerEpoch("not-json")).toBe(0);
    expect(parseWorkerEpoch(JSON.stringify({ epoch: 5 }))).toBe(5);
    expect(parseWorkerEpoch(JSON.stringify({ epoch: -1 }))).toBe(0);
  });

  it("递增下限 1", () => {
    expect(nextWorkerEpoch(0)).toBe(1);
    expect(nextWorkerEpoch(7)).toBe(8);
  });

  it("fencing：旧 epoch 写被拒", () => {
    expect(isWriteFenced({ writeEpoch: 5, currentEpoch: 6 })).toBe(true);
    expect(isWriteFenced({ writeEpoch: 6, currentEpoch: 6 })).toBe(false);
    expect(isWriteFenced({ writeEpoch: 7, currentEpoch: 6 })).toBe(false);
  });

  it("去重键含 epoch", () => {
    expect(buildEventDedupKeyWithEpoch("ag", "run-1", 3, 7)).toBe("ag:run-1:3:7");
  });
});

describe("v3.1 §5.2 四档判定", () => {
  it("优先级 a > b > c > d", () => {
    expect(
      decideInterceptTier({ hasHook: true, hasToolOverride: true, pathInjectionEffective: true }),
    ).toBe("a-hook");
    expect(
      decideInterceptTier({ hasHook: false, hasToolOverride: true, pathInjectionEffective: true }),
    ).toBe("b-override");
    expect(
      decideInterceptTier({ hasHook: false, hasToolOverride: false, pathInjectionEffective: true }),
    ).toBe("c-path-shim");
    expect(
      decideInterceptTier({ hasHook: false, hasToolOverride: false, pathInjectionEffective: false }),
    ).toBe("d-residual");
  });
});
