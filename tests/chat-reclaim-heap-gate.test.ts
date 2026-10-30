/**
 * X3(b)：chat 入口的堆水位门（chat-inject.ts 的 applyChatHeapGate，经 handleChatReplyInject 驱动）
 *
 * 语义（简报 §1.4(b)）：
 *   - 堆占用 < 软水位 0.7：不动，一次都不回收；
 *   - ≥ 0.7：先回收「空闲、守卫放行」的别的热会话（目标会话除外），**不拒单**——定时没人盯，拒了接力就停摆；
 *   - 回收之后仍 ≥ 0.85（沿用 task 路径 assertHeapOk 的口径）：才拒这条新活，503；
 *   - 门在 claim / 落盘 / 起会话之前：拒单不留 claim、不写半截 user_reply，水位降下来后同一个 clientItemId 能立刻重发；
 *   - 定时触发被 503 拒 → 经真实 classifyInjectResponse 得 retry（暂时送不进），不是永久失败；
 *   - 回收本身出错（尽力而为）不能挡住用户消息。
 *
 * 骨架抄 schedule-chat-busy.test.ts（同一张依赖图）：chat-runner 全 mock（这里只验 inject 层与回收函数的衔接，
 * 回收函数自身的行为——只挑空闲会话、不挑目标、占用从大到小——在 chat-reclaim-runner.test.ts 用真实 chat-runner 验）。
 * 堆读数经 mock 的 sdk-store-gc.heapPressure 注入（HeapPressureError 保留真实类，文案与 task 路径同源）。
 *
 * 分类：回归 = 改前会红（改前 chat 入口没有任何水位门）；对照 = 改前改后都绿，防止改过头。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";
import { CHAT_WATERMARK_SOFT_RATIO } from "@/lib/server/chat-reclaim";
import { TOKEN_WATERMARK_ENV } from "@/lib/server/session-rotate";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-reclaim-heap-gate-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const h = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  const state = {
    sessionAlive: true,
    sendResult: "sent" as "sent" | "busy",
    lifecycle: null as "stopping" | "deleting" | null,
    /** heapPressure 的读数序列；读完后一直返回最后一个 */
    ratios: [0.1] as number[],
  };
  return {
    state,
    getTask: vi.fn<AnyFn>(),
    sendChatMessage: vi.fn<AnyFn>(),
    runChatSession: vi.fn<AnyFn>(),
    reclaim: vi.fn<AnyFn>(),
    maybeGc: vi.fn<AnyFn>(),
    heapPressure: vi.fn<AnyFn>(),
    writeEventAndPublish: vi.fn<AnyFn>(),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(),
  };
});

vi.mock("@/lib/server/session-rebuilt-notice", () => ({
  announceSessionRebuilt: vi.fn(async () => true),
}));
vi.mock("@/lib/server/task-fs", () => ({
  getTask: h.getTask,
  setTaskRunStatus: vi.fn(async (id: string) => ({ id })),
  updateTaskFields: vi.fn(async () => null),
  syncTaskPendingAskId: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/settings-fs", () => ({
  readSettingsFile: vi.fn(async () => ({ status: "missing" })),
}));
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: vi.fn(async () => []),
}));
vi.mock("@/lib/server/sdk-store-gc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/sdk-store-gc")>()),
  heapPressure: h.heapPressure,
  maybeGcSdkStore: h.maybeGc,
}));
vi.mock("@/lib/server/chat-runner", () => ({
  cancelChatRun: vi.fn(),
  forceClearChatRun: vi.fn(),
  getChatRunDisabledMcp: vi.fn(() => null),
  getChatRunModel: vi.fn(() => ({ id: "grok-4.6" })),
  getChatRunProvider: vi.fn(() => null),
  getChatRunRepoPaths: vi.fn(() => null),
  hasChatSession: vi.fn(() => h.state.sessionAlive),
  isChatQueueDraining: vi.fn(() => false),
  isChatRunActive: vi.fn(() => h.state.sessionAlive),
  reclaimChatSessionsForWatermark: h.reclaim,
  releaseChatRunClaim: vi.fn(),
  resumeChatSession: vi.fn(async () => null),
  runChatSession: h.runChatSession,
  sendChatMessage: h.sendChatMessage,
  waitForChatToStop: vi.fn(async () => true),
}));
vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint: vi.fn(async () => ({
    ok: false,
    repoSnapshots: [],
    elapsedMsByRepo: {},
    warnings: [],
  })),
  persistCheckpointForReply: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/failpoints", () => ({
  failpoint: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/chat-gate", () => ({
  getChatLifecycle: vi.fn(() => h.state.lifecycle),
  isChatRewindInProgress: vi.fn(() => false),
  isChatStartLeaseValid: vi.fn(() => true),
  releaseChatStart: vi.fn(),
  tryReserveChatStart: vi.fn(() => 1),
}));
vi.mock("@/lib/server/task-stream", () => ({
  PERSIST_FAIL_RETRY_MESSAGE: "落盘失败、请重试",
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
  publish: vi.fn(),
  publishTaskStreamEvent: vi.fn(),
  writeEventAndPublish: h.writeEventAndPublish,
  writeUserEventAndPublishStrict: h.writeUserEventAndPublishStrict,
}));
vi.mock("@/lib/server/update-pending", () => ({
  checkUpdatePendingRestart: vi.fn(async () => null),
}));
vi.mock("@/lib/server/feishu-bridge/ask-card-settle", () => ({
  settleAskCards: vi.fn(async () => 1),
  ASK_CARD_SKIPPED_NOTE: "（已跳过）",
  ASK_CARD_SKIPPED_HINT: "这组提问已跳过、无需再回答",
  ASK_CARD_ANSWERED_HINT: "这组提问已回答、无需再答",
}));

const { handleChatReplyInject } = await import("@/lib/server/chat-inject");
const { cleanupChatQueueState, getChatQueueCount } = await import("@/lib/server/chat-queue");
const { classifyInjectResponse } = await import("@/lib/server/schedule-runner");

const SCHEDULED = { scheduledTrigger: true } as const;

let seq = 0;
const usedIds: string[] = [];
const newId = (): string => {
  seq += 1;
  const id = `t_heap_gate_${seq}`;
  usedIds.push(id);
  return id;
};

const makeTask = (id: string): Task =>
  ({
    id,
    title: "水位门 chat",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    provider: "cursor",
    model: { id: "grok-4.6" },
    pendingAskId: null,
    createdAt: 1,
    updatedAt: 2,
    events: [],
  }) as unknown as Task;

const bodyOf = (clientItemId?: string, text = "用户随手补一句") => ({
  text,
  bootArgs: { apiKey: "k", model: { id: "grok-4.6" } },
  ...(clientItemId ? { clientItemId } : {}),
});
const scheduledBody = (key: string) =>
  bodyOf(key, "[SCHEDULE_FIRED id=sch_x] 到点了：去看一眼 CI");

const jsonOf = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

/** 堆读数：按序返回，读完后一直返回最后一个 */
const setRatios = (...ratios: number[]): void => {
  h.state.ratios = ratios;
  let i = 0;
  h.heapPressure.mockImplementation(() => {
    const ratio = h.state.ratios[Math.min(i, h.state.ratios.length - 1)]!;
    i += 1;
    return { usedMB: Math.round(ratio * 4096), limitMB: 4096, ratio, over: ratio >= 0.85 };
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(TOKEN_WATERMARK_ENV, "");
  h.state.sessionAlive = true;
  h.state.sendResult = "sent";
  h.state.lifecycle = null;
  setRatios(0.1);
  h.getTask.mockImplementation(async (id: string) => makeTask(id));
  h.sendChatMessage.mockImplementation(async () => h.state.sendResult);
  h.runChatSession.mockImplementation(async () => {
    h.state.sessionAlive = true;
  });
  h.reclaim.mockImplementation(async () => 0);
  h.writeEventAndPublish.mockImplementation(async () => ({ id: "ev_info" }));
  h.writeUserEventAndPublishStrict.mockImplementation(async () => ({ id: "ev_user" }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const id of usedIds) cleanupChatQueueState(id);
  usedIds.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("软水位以下：不碰任何东西", () => {
  it("对照：堆 0.5（< 0.7）→ 不回收、不拒，用户消息照常送达", async () => {
    const id = newId();
    setRatios(0.5);

    const res = await handleChatReplyInject(id, bodyOf());

    expect(res.status).toBe(200);
    expect(h.reclaim, "软水位以下不该回收任何会话").not.toHaveBeenCalled();
    expect(h.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("对照：恰好在软水位以下一点（0.69）→ 仍不回收", async () => {
    const id = newId();
    setRatios(0.69);
    const res = await handleChatReplyInject(id, bodyOf());
    expect(res.status).toBe(200);
    expect(h.reclaim).not.toHaveBeenCalled();
  });
});

describe("≥ 软水位：先回收别的空闲热会话，不拒单", () => {
  it("边界：堆占用恰好等于软水位 → 调用回收（只有「低于」软水位才不动）", async () => {
    const id = newId();
    setRatios(CHAT_WATERMARK_SOFT_RATIO, 0.6);

    const res = await handleChatReplyInject(id, bodyOf());

    expect(res.status).toBe(200);
    expect(h.reclaim, "恰好等于软水位已算「到了」，要回收").toHaveBeenCalledTimes(1);
  });

  it("回归：堆 0.75 → 调用回收（目标会话 id 作为 exceptTaskId）；回收后读到 0.6 → 放行并送达", async () => {
    const id = newId();
    setRatios(0.75, 0.6);

    const res = await handleChatReplyInject(id, bodyOf());

    expect(res.status, "改前：入口没有水位门，不会回收").toBe(200);
    expect(h.reclaim).toHaveBeenCalledTimes(1);
    const arg = h.reclaim.mock.calls[0]![0] as unknown as {
      exceptTaskId?: string;
      heapRatio: () => number;
    };
    expect(arg.exceptTaskId, "目标会话不能被回收").toBe(id);
    expect(typeof arg.heapRatio).toBe("function");
    expect(h.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(h.maybeGc, "没拒单就不触发 SDK store GC").not.toHaveBeenCalled();
    // 顺序：回收先于送达
    expect(h.reclaim.mock.invocationCallOrder[0]!).toBeLessThan(
      h.sendChatMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("回归：回收后读数仍在软硬之间（0.8，< 0.85）→ 仍放行——软水位只回收、不拒单", async () => {
    const id = newId();
    setRatios(0.75, 0.8);

    const res = await handleChatReplyInject(id, bodyOf());

    expect(res.status).toBe(200);
    expect(h.reclaim).toHaveBeenCalledTimes(1);
    expect(h.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("回归：传给回收函数的 heapRatio 读的是实时堆占用（回收函数每回收一个就复读一次）", async () => {
    const id = newId();
    setRatios(0.75, 0.6);
    // 断言必须放在回收函数「外面」：门对回收函数里抛的错是 try/catch 吞掉的（回收尽力而为），
    // 写在 mock 里面的 expect 失败会被吞，等于没断言（变异「复读固定用回收前的读数」就是这样活下来的）
    let reread: number | undefined;
    h.reclaim.mockImplementationOnce(async (opts: never) => {
      // 模拟回收函数里的复读：用调用方给的 heapRatio 读到的应该是 mock 的下一个读数
      const { heapRatio } = opts as unknown as { heapRatio: () => number };
      reread = heapRatio();
      return 1;
    });
    const res = await handleChatReplyInject(id, bodyOf());
    expect(res.status).toBe(200);
    expect(reread, "复读读的是实时堆占用（回收前读到的是 0.75，不能一直返回那个旧值）").toBe(0.6);
  });
});

describe("回收后仍 ≥ 硬水位（0.85）：才拒新活", () => {
  it("回归：堆 0.9、回收后仍 0.9 → 503，错误文案与 task 路径同源；send / 起会话 / 落盘都没发生；触发一次 SDK store GC", async () => {
    const id = newId();
    setRatios(0.9, 0.9);

    const res = await handleChatReplyInject(id, bodyOf());

    expect(res.status, "改前：chat 入口不拒").toBe(503);
    const body = await jsonOf(res);
    expect(String(body.error)).toContain("服务内存偏高");
    expect(String(body.error)).toContain("本条消息已拒绝");
    expect(h.reclaim, "拒之前必须先试过回收").toHaveBeenCalledTimes(1);
    expect(h.sendChatMessage).not.toHaveBeenCalled();
    expect(h.runChatSession).not.toHaveBeenCalled();
    expect(h.writeUserEventAndPublishStrict, "拒单不能留下半截 user_reply").not.toHaveBeenCalled();
    expect(h.maybeGc, "沿用 assertHeapOk：拒之前顺手触发一轮 GC").toHaveBeenCalledTimes(1);
    expect(getChatQueueCount(id), "拒单不入队").toBe(0);
  });

  it("回归：刚好 0.85（边界）→ 拒；0.849 → 放行", async () => {
    const a = newId();
    setRatios(0.85, 0.85);
    expect((await handleChatReplyInject(a, bodyOf())).status).toBe(503);

    const b = newId();
    setRatios(0.85, 0.849);
    expect((await handleChatReplyInject(b, bodyOf())).status).toBe(200);
  });

  it("回归：门在 claim 之前——被 503 拒后，水位降下来同一个 clientItemId 能立刻重发并送达（没有残留的「已受理」）", async () => {
    const id = newId();
    const key = "ci_heap_retry_1";

    setRatios(0.9, 0.9);
    const first = await handleChatReplyInject(id, bodyOf(key));
    expect(first.status).toBe(503);

    setRatios(0.3);
    const second = await handleChatReplyInject(id, bodyOf(key));
    expect(second.status, "改前后这里都应是 200；若门放在 claim 之后，这里会是 202 alreadyAccepted / 409").toBe(200);
    expect(await jsonOf(second)).toMatchObject({ ok: true, outcome: "delivered", itemId: key });
    expect(h.sendChatMessage).toHaveBeenCalledTimes(1);
  });
});

describe("定时触发：被拒是「暂时送不进」，不是永久失败", () => {
  it("回归：堆高压 503 经真实 classifyInjectResponse 得 retry（调度器按窗口重试，接力不会因一次高压永久停摆）", async () => {
    const id = newId();
    setRatios(0.92, 0.92);

    const res = await handleChatReplyInject(id, scheduledBody("sch_a.1.1"), SCHEDULED);
    expect(res.status).toBe(503);
    const outcome = classifyInjectResponse(res.status, await jsonOf(res));

    expect(outcome.kind).toBe("retry");
  });

  it("回归：定时触发同样先回收再判（软水位下回收后放行 → 正常送达）", async () => {
    const id = newId();
    setRatios(0.78, 0.55);

    const res = await handleChatReplyInject(id, scheduledBody("sch_a.1.1"), SCHEDULED);

    expect(res.status).toBe(200);
    expect(h.reclaim).toHaveBeenCalledTimes(1);
    expect((h.reclaim.mock.calls[0]![0] as unknown as { exceptTaskId?: string }).exceptTaskId).toBe(id);
  });
});

describe("回收自己出错：尽力而为，不能挡住用户消息", () => {
  it("回归：回收抛错 + 读数在硬水位以下 → 消息照常送达，错误只进日志", async () => {
    const id = newId();
    setRatios(0.75, 0.75);
    h.reclaim.mockRejectedValueOnce(new Error("boom"));

    const res = await handleChatReplyInject(id, bodyOf());

    expect(res.status, "改前后都不该因回收出错而 500").toBe(200);
    expect(h.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("回归：回收抛错 + 读数仍 ≥ 硬水位 → 照常 503（沿用回收后读数判）", async () => {
    const id = newId();
    setRatios(0.9, 0.9);
    h.reclaim.mockRejectedValueOnce(new Error("boom"));

    const res = await handleChatReplyInject(id, bodyOf());

    expect(res.status).toBe(503);
    expect(h.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe("门的位置：不抢在更早的入口拦截之前", () => {
  it.each([
    ["stopping", "正在停止"],
    ["deleting", "任务正在删除"],
  ] as const)("对照：%s 收尾窗口 → 仍回原来的 409 文案，且不触发回收（门在 lifecycle 检查之后）", async (lifecycle, snippet) => {
    const id = newId();
    h.state.lifecycle = lifecycle;
    setRatios(0.95);

    const res = await handleChatReplyInject(id, bodyOf());

    expect(res.status).toBe(409);
    expect(String((await jsonOf(res)).error)).toContain(snippet);
    expect(h.reclaim).not.toHaveBeenCalled();
    expect(h.heapPressure, "更早拦下的请求连堆都不用读").not.toHaveBeenCalled();
  });
});
