/**
 * X3：chat 热会话回收的纯逻辑口径（src/lib/server/chat-reclaim.ts）
 *
 * 钉死的语义（每条都对应一个「不钉就会悄悄出错」的坑）：
 *  - 守卫：回收之前必须全部放行——任何一条命中都不回收（误回收的代价 = 丢后台子代理 / 待答 / 在飞消息）；
 *  - 定时文本识别：按 `[SCHEDULE_FIRED` 前缀认；
 *  - 水位候选排序：占用从大到小、永远不含本次要服务的会话；
 *  - 回收计数 / 热会话探针：run-perf 遥测的数据源，探针没登记 / 抛错都要退化成 undefined 而不是崩。
 *
 * 分类：本文件是新模块的单元测试（基线上模块不存在，所以「改前红」只是缺模块）；
 * 行为级的「改前红 / 改后绿」在 chat-reclaim-runner / chat-reclaim-heap-gate / run-perf-chat-telemetry 里。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { HEAP_GUARD_RATIO } from "@/lib/server/sdk-store-gc";
import {
  CHAT_SWEEP_INTERVAL_MS,
  CHAT_WATERMARK_SOFT_RATIO,
  SCHEDULED_RUN_RECLAIM_GRACE_MS,
  __resetChatReclaimForTests,
  chatReclaimBlockReason,
  getChatHotSessions,
  getChatReclaimCounts,
  isScheduledRunText,
  rankReclaimCandidates,
  recordChatReclaim,
  registerChatHotProbe,
  type ChatReclaimBlock,
  type ChatReclaimSnapshot,
} from "@/lib/server/chat-reclaim";

/** 一个「完全空闲、可以回收」的会话快照；各用例只改一个字段 */
const idle = (over: Partial<ChatReclaimSnapshot> = {}): ChatReclaimSnapshot => ({
  hasAgent: true,
  lifecycle: null,
  runActive: false,
  backgroundRunning: 0,
  queueCount: 0,
  draining: false,
  pendingAsk: false,
  inflightSteers: 0,
  pendingBackgroundResults: 0,
  rewindInProgress: false,
  ...over,
});

afterEach(() => {
  __resetChatReclaimForTests();
});

describe("回收守卫 chatReclaimBlockReason", () => {
  it("对照：完全空闲 → null（能回收）", () => {
    expect(chatReclaimBlockReason(idle())).toBeNull();
  });

  it("对照：lifecycle 缺省（undefined）也算空闲", () => {
    const s = idle();
    delete s.lifecycle;
    expect(chatReclaimBlockReason(s)).toBeNull();
  });

  const cases: Array<[string, Partial<ChatReclaimSnapshot>, ChatReclaimBlock]> = [
    ["冷启动占位期（agent 还没挂上）", { hasAgent: false }, "cold-start"],
    ["stopping 收尾窗口", { lifecycle: "stopping" }, "closing"],
    ["deleting 收尾窗口", { lifecycle: "deleting" }, "closing"],
    ["finalizing 收尾窗口（任何非空 lifecycle 都不插手）", { lifecycle: "finalizing" }, "closing"],
    ["reopening 收尾窗口", { lifecycle: "reopening" }, "closing"],
    ["run 在跑", { runActive: true }, "run-active"],
    ["后台子代理在跑（关会话会连它们一起取消）", { backgroundRunning: 1 }, "background-subagent"],
    ["聊天队列里有等着送的消息（含 flush 刚 dequeue 的 in-flight 槽）", { queueCount: 1 }, "queued"],
    ["flushChatQueue 正在 drain", { draining: true }, "draining"],
    ["有挂起的 ask_user", { pendingAsk: true }, "pending-ask"],
    ["「立即发送」steer 在飞", { inflightSteers: 1 }, "inflight-steer"],
    ["攒着还没送进主 AI 的后台子代理结果", { pendingBackgroundResults: 2 }, "pending-bg-results"],
    ["检查点回退进行中", { rewindInProgress: true }, "rewind"],
  ];
  it.each(cases)("回归：%s → 不回收", (_name, over, expected) => {
    expect(chatReclaimBlockReason(idle(over))).toBe(expected);
  });

  it("多条同时命中：返回优先级最靠前的一条（只影响日志文案，不影响「不回收」的结论）", () => {
    expect(
      chatReclaimBlockReason(
        idle({ runActive: true, queueCount: 3, pendingAsk: true, rewindInProgress: true }),
      ),
    ).toBe("run-active");
    expect(
      chatReclaimBlockReason(idle({ hasAgent: false, runActive: true })),
    ).toBe("cold-start");
    expect(
      chatReclaimBlockReason(idle({ queueCount: 1, pendingBackgroundResults: 1 })),
    ).toBe("queued");
  });

  it("多条同时命中：收尾窗口（closing）排在 run 在跑（run-active）前面", () => {
    expect(
      chatReclaimBlockReason(idle({ lifecycle: "stopping", runActive: true })),
    ).toBe("closing");
  });
});

describe("定时文本识别 isScheduledRunText", () => {
  it("定时到点消息（与 schedule.ts 的 formatScheduleFireMessage 同形）→ true", () => {
    expect(isScheduledRunText("[SCHEDULE_FIRED id=sch_abc.1.1] 定时任务到点了。")).toBe(true);
    expect(isScheduledRunText("[SCHEDULE_FIRED id=sch_x] 到点了：去看一眼 CI")).toBe(true);
  });

  it("前导空白不影响（与 isScheduleBoilerplateText 同口径）", () => {
    expect(isScheduledRunText("  \n[SCHEDULE_FIRED id=sch_x] 到点了")).toBe(true);
  });

  it("对照：用户普通消息 / 空串 / 正文里提到该标记 → false", () => {
    expect(isScheduledRunText("帮我看看这个 bug")).toBe(false);
    expect(isScheduledRunText("")).toBe(false);
    expect(isScheduledRunText("我想说 [SCHEDULE_FIRED id=x] 这个前缀是什么意思")).toBe(false);
  });

  it("对照：前面被拼了别的前缀（如跳过提问的 hint）→ false，会话退回 12 分钟 TTL 清扫，不丢数据", () => {
    expect(isScheduledRunText("【系统提示】……\n[SCHEDULE_FIRED id=sch_x] 到点了")).toBe(false);
  });
});

describe("水位门候选排序 rankReclaimCandidates", () => {
  const c = (taskId: string, usageBytes: number, lastActiveAt: number) => ({
    taskId,
    usageBytes,
    lastActiveAt,
  });

  it("占用从大到小", () => {
    const out = rankReclaimCandidates([c("a", 10, 1), c("b", 300, 2), c("c", 50, 3)]);
    expect(out.map((x) => x.taskId)).toEqual(["b", "c", "a"]);
  });

  it("占用相同（含全取不到记 0）：空闲最久的先回收", () => {
    const out = rankReclaimCandidates([c("new", 0, 900), c("old", 0, 100), c("mid", 0, 500)]);
    expect(out.map((x) => x.taskId)).toEqual(["old", "mid", "new"]);
  });

  it("再相同按 taskId 稳定排序（结果不依赖输入顺序）", () => {
    const a = rankReclaimCandidates([c("z", 0, 1), c("a", 0, 1), c("m", 0, 1)]);
    const b = rankReclaimCandidates([c("m", 0, 1), c("z", 0, 1), c("a", 0, 1)]);
    expect(a.map((x) => x.taskId)).toEqual(["a", "m", "z"]);
    expect(b.map((x) => x.taskId)).toEqual(["a", "m", "z"]);
  });

  it("回归：exceptTaskId（本次要服务的会话）永远不进候选，哪怕它占用最大", () => {
    const out = rankReclaimCandidates(
      [c("target", 9_999_999, 1), c("x", 10, 2), c("y", 20, 3)],
      "target",
    );
    expect(out.map((x) => x.taskId)).toEqual(["y", "x"]);
  });

  it("不改入参（返回新数组）", () => {
    const input = [c("a", 1, 1), c("b", 2, 2)];
    const snapshot = JSON.stringify(input);
    rankReclaimCandidates(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("回收计数与热会话探针", () => {
  it("计数按原因分开累计；getChatReclaimCounts 返回副本", () => {
    recordChatReclaim("idle");
    recordChatReclaim("scheduled-end");
    recordChatReclaim("scheduled-end");
    recordChatReclaim("watermark");
    const counts = getChatReclaimCounts();
    expect(counts).toEqual({ idle: 1, scheduledEnd: 2, watermark: 1 });
    counts.idle = 99;
    expect(getChatReclaimCounts().idle, "外部改返回值不能污染内部计数").toBe(1);
  });

  it("探针没登记 → undefined（调用方据此省略遥测字段）", () => {
    expect(getChatHotSessions()).toBeUndefined();
  });

  it("登记后返回探针的结果；探针抛错 → 退化为 undefined、不向外抛", () => {
    registerChatHotProbe(() => [
      { taskId: "t1", agentId: "a1", idleMs: 5, runActive: false, backgroundRunning: 0 },
    ]);
    expect(getChatHotSessions()).toEqual([
      { taskId: "t1", agentId: "a1", idleMs: 5, runActive: false, backgroundRunning: 0 },
    ]);
    registerChatHotProbe(() => {
      throw new Error("boom");
    });
    expect(getChatHotSessions()).toBeUndefined();
  });

  it("热会话数为 0 与「探针没登记」要能区分（前者是回收生效的证据）", () => {
    registerChatHotProbe(() => []);
    expect(getChatHotSessions()).toEqual([]);
  });
});

describe("默认占用估算器 defaultChatUsageEstimator", () => {
  /** 用假的 SDK store 句柄重新加载 chat-reclaim（估算器内部是动态 import("./sdk-agent-store")，只看不开 store） */
  const loadEstimator = async (peek: () => Promise<unknown>) => {
    vi.resetModules();
    vi.doMock("@/lib/server/sdk-agent-store", () => ({ peekSdkStoreHandle: peek }));
    const mod = await import("@/lib/server/chat-reclaim");
    return mod.defaultChatUsageEstimator;
  };

  afterEach(() => {
    vi.doUnmock("@/lib/server/sdk-agent-store");
    vi.resetModules();
  });

  it("回归：读 SDK store 句柄的 agentStats(agentId).bytes（与 run-perf 的 store.agentMB 同源）；没有该 agent → undefined", async () => {
    const estimate = await loadEstimator(async () => ({
      fast: {
        agentStats: (id: string) => (id === "agent_big" ? { bytes: 4096 } : undefined),
      },
    }));
    expect(await estimate("agent_big")).toBe(4096);
    expect(await estimate("agent_unknown")).toBeUndefined();
  });

  it("对照：store 没开（句柄 undefined）/ 句柄没有 fast / 取句柄抛错 → undefined 且不抛（估算只用来排序，不能把水位门带崩）", async () => {
    expect(await (await loadEstimator(async () => undefined))("a")).toBeUndefined();
    expect(await (await loadEstimator(async () => ({})))("a")).toBeUndefined();
    expect(
      await (
        await loadEstimator(async () => {
          throw new Error("boom");
        })
      )("a"),
    ).toBeUndefined();
  });
});

describe("常量契约", () => {
  it("软水位 < 硬水位（硬水位沿用 task 路径的 HEAP_GUARD_RATIO）", () => {
    expect(CHAT_WATERMARK_SOFT_RATIO).toBe(0.7);
    expect(CHAT_WATERMARK_SOFT_RATIO).toBeLessThan(HEAP_GUARD_RATIO);
  });

  it("清扫拍点 < 空闲 TTL（12 分钟）：拍点缩短是为了更早发现，TTL 数值不变", () => {
    expect(CHAT_SWEEP_INTERVAL_MS).toBe(2 * 60 * 1000);
    expect(CHAT_SWEEP_INTERVAL_MS).toBeLessThan(12 * 60 * 1000);
  });

  it("定时 run 收尾的回收宽限是秒级（让收尾后立刻 drain / 用户秒回先有机会起新 run），远小于接力间隔", () => {
    expect(SCHEDULED_RUN_RECLAIM_GRACE_MS).toBeGreaterThanOrEqual(30_000);
    expect(SCHEDULED_RUN_RECLAIM_GRACE_MS).toBeLessThanOrEqual(60_000);
  });
});
