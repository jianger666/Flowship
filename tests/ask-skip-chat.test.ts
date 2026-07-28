/**
 * chat 模式「不答提问、直接发新消息」= 跳过（用户实测缺陷的主现场）
 *
 * task 模式原本就作废旧 ask，chat 这条链**一个字都没处理**：答题卡和顶部
 * 「AI 在等你回答」悬浮条会一直挂着（用户原话「像牛皮癣一样」）。
 *
 * 三条送达路径各钉一遍——它们是 chat 侧「消息已被受理」的全部出口：
 * 1. 活会话直接 send
 * 2. 排队（202，稍后 flush 给 agent）
 * 3. 起新会话（首条消息）
 *
 * 外加失败路径：没送出去要把登记放回，用户还能回去答。
 * 全部 mock 外部调用——不起 agent、不碰盘、不调飞书。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task, TaskEvent } from "@/lib/types";

const {
  captureChatCheckpoint,
  enqueueChatMessage,
  getChatLifecycle,
  getChatQueueCount,
  getChatRunModel,
  getTask,
  hasChatSession,
  isChatRunActive,
  runChatSession,
  sendChatMessage,
  setTaskRunStatus,
  settleAskCards,
  syncTaskPendingAskId,
  tryReserveChatStart,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    captureChatCheckpoint: vi.fn<AnyFn>(async () => ({
      ok: false,
      repoSnapshots: [],
      elapsedMsByRepo: {},
      warnings: [],
    })),
    enqueueChatMessage: vi.fn<AnyFn>(() => ({
      ok: true,
      itemId: "item-1",
      queuedCount: 1,
    })),
    getChatLifecycle: vi.fn<AnyFn>(() => null),
    getChatQueueCount: vi.fn<AnyFn>(() => 0),
    getChatRunModel: vi.fn<AnyFn>(() => null),
    getTask: vi.fn<AnyFn>(),
    hasChatSession: vi.fn<AnyFn>(() => true),
    isChatRunActive: vi.fn<AnyFn>(() => true),
    runChatSession: vi.fn<AnyFn>(async () => undefined),
    sendChatMessage: vi.fn<AnyFn>(async () => "sent"),
    setTaskRunStatus: vi.fn<AnyFn>(),
    settleAskCards: vi.fn<AnyFn>(async () => 1),
    syncTaskPendingAskId: vi.fn<AnyFn>(async () => undefined),
    tryReserveChatStart: vi.fn<AnyFn>(() => 1),
    writeEventAndPublish: vi.fn<AnyFn>(async () => ({ id: "ev_skip" })),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(async () => ({ id: "e1" })),
  };
});

vi.mock("@/lib/server/task-fs", () => ({
  getTask,
  setTaskRunStatus,
  updateTaskFields: vi.fn(async () => null),
  // chat-pending 的 meta 同步走动态 import("./task-fs")
  syncTaskPendingAskId,
}));
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: vi.fn(async () => []),
}));
vi.mock("@/lib/server/chat-runner", () => ({
  cancelChatRun: vi.fn(),
  forceClearChatRun: vi.fn(),
  getChatRunDisabledMcp: vi.fn(() => null),
  getChatRunModel,
  getChatRunRepoPaths: vi.fn(() => null),
  hasChatSession,
  isChatQueueDraining: vi.fn(() => false),
  isChatRunActive,
  releaseChatRunClaim: vi.fn(),
  resumeChatSession: vi.fn(async () => null),
  runChatSession,
  sendChatMessage,
  waitForChatToStop: vi.fn(async () => true),
}));
vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint,
  persistCheckpointForReply: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/chat-queue", () => ({
  beginChatQueueInFlight: vi.fn(),
  claimMessageOperation: vi.fn(),
  dequeueChatMessage: vi.fn(() => null),
  enqueueChatMessage,
  enqueueChatMessageFront: vi.fn(),
  failQueuedItems: vi.fn(() => []),
  fingerprintFromMessagePayload: vi.fn(() => "fp"),
  getChatQueueCount,
  getChatQueueGeneration: vi.fn(() => 1),
  getMessageOperation: vi.fn(() => undefined),
  isMessageOperationTerminal: vi.fn(() => false),
  markMessagePersisted: vi.fn(),
  settleMessageFailed: vi.fn(),
  settleMessageHandedOff: vi.fn(),
}));
vi.mock("@/lib/server/failpoints", () => ({ failpoint: vi.fn(async () => undefined) }));
vi.mock("@/lib/server/chat-gate", () => ({
  getChatLifecycle,
  isChatRewindInProgress: vi.fn(() => false),
  isChatStartLeaseValid: vi.fn(() => true),
  releaseChatStart: vi.fn(),
  tryReserveChatStart,
}));
vi.mock("@/lib/server/task-stream", () => ({
  PERSIST_FAIL_RETRY_MESSAGE: "落盘失败、请重试",
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
  publishTaskStreamEvent: vi.fn(),
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
}));
vi.mock("@/lib/server/update-pending", () => ({
  checkUpdatePendingRestart: vi.fn(async () => null),
}));
vi.mock("@/lib/server/feishu-bridge/ask-card-settle", () => ({
  settleAskCards,
  ASK_CARD_SKIPPED_NOTE: "（已跳过）",
  ASK_CARD_SKIPPED_HINT: "这组提问已跳过、无需再回答",
  ASK_CARD_ANSWERED_HINT: "这组提问已回答、无需再答",
}));

// chat-pending 用真的——认领 / 放回语义就是被测对象
const { __resetPendingAskStateForTest, getPendingAsk, registerPendingAsk } =
  await import("@/lib/server/chat-pending");
const { handleChatReplyInject } = await import("@/lib/server/chat-inject");

const TASK_ID = "chat-1";
const ASK_ID = "ask-1";
const QUESTIONS = [{ id: "q1", question: "要不要顺手加埋点", allowText: true }];

const seedPendingAsk = (): string =>
  registerPendingAsk(TASK_ID, { askId: ASK_ID, questions: QUESTIONS }).token;

const chatTask = (token: string): Task =>
  ({
    id: TASK_ID,
    title: "重构登录",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    repoPaths: [],
    mrs: [],
    actions: [],
    events: [
      {
        id: "ev-ask",
        kind: "ask_user_request",
        text: "有问题要问",
        ts: Date.now(),
        meta: { askId: ASK_ID, token, questions: QUESTIONS },
      } as unknown as TaskEvent,
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as Task;

const BODY = {
  text: "不用加埋点、直接改吧",
  bootArgs: { apiKey: "sk-test", model: { id: "m1" } },
};

/** 落下的跳过事件（meta.supersededAskId 非空的那些） */
const skipEvents = (): Array<Record<string, unknown>> =>
  (writeEventAndPublish as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((c) => (c[1] as { meta?: Record<string, unknown> })?.meta ?? {})
    .filter((m) => !!m.supersededAskId);

beforeEach(() => {
  vi.clearAllMocks();
  __resetPendingAskStateForTest();
  getChatLifecycle.mockReturnValue(null);
  hasChatSession.mockReturnValue(true);
  getChatRunModel.mockReturnValue(null);
  getChatQueueCount.mockReturnValue(0);
  sendChatMessage.mockResolvedValue("sent");
  isChatRunActive.mockReturnValue(true);
  tryReserveChatStart.mockReturnValue(1);
  writeEventAndPublish.mockResolvedValue({ id: "ev_skip" });
  writeUserEventAndPublishStrict.mockResolvedValue({ id: "e1" });
});

describe("chat 模式发新消息 = 跳过提问", () => {
  it("活会话直接 send → agent 文本带跳过上下文、落跳过事件、pending 清空", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));

    const resp = await handleChatReplyInject(TASK_ID, BODY);
    expect(resp.status).toBe(200);

    const agentText = String(
      (sendChatMessage as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[1] ?? "",
    );
    expect(agentText).toContain("已跳过");
    expect(agentText).toContain("重新问一次");
    expect(agentText.indexOf("已跳过")).toBeLessThan(
      agentText.indexOf("不用加埋点"),
    );

    expect(skipEvents()[0]?.askSkipped).toBe(true);
    expect(getPendingAsk(TASK_ID)).toBeNull();
    expect(settleAskCards).toHaveBeenCalledTimes(1);
  });

  it("气泡只存用户原文——跳过上下文不进事件流", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    await handleChatReplyInject(TASK_ID, BODY);

    const bubble = (
      writeUserEventAndPublishStrict as unknown as {
        mock: { calls: unknown[][] };
      }
    ).mock.calls[0]?.[1] as { text?: string };
    expect(bubble?.text).toBe(BODY.text);
    expect(bubble?.text).not.toContain("已跳过");
  });

  it("排队（202）也算受理 → 排的那条带跳过上下文、跳过标记落地", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    // run 在跑 → send 返回 busy → 入队
    sendChatMessage.mockResolvedValue("busy");

    const resp = await handleChatReplyInject(TASK_ID, BODY);
    expect(resp.status).toBe(202);
    const queued = (
      enqueueChatMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0]?.[1] as { agentText?: string; displayText?: string };
    expect(queued?.agentText).toContain("已跳过");
    // 排队气泡同样只显示原文
    expect(queued?.displayText).toBe(BODY.text);
    expect(skipEvents()[0]?.askSkipped).toBe(true);
  });

  it("起新会话（首条消息）→ 同样落跳过标记", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    hasChatSession.mockReturnValue(false);
    setTaskRunStatus.mockResolvedValue(chatTask(token));

    const resp = await handleChatReplyInject(TASK_ID, BODY);
    expect(resp.status).toBe(202);
    const firstMessage = (
      runChatSession as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0]?.[0] as { firstMessage?: { text?: string } };
    expect(firstMessage?.firstMessage?.text).toContain("已跳过");
    expect(skipEvents()[0]?.askSkipped).toBe(true);
  });

  it("消息没送出去（会话被停）→ 登记放回、不写跳过事件", async () => {
    const token = seedPendingAsk();
    getTask.mockImplementation(async () => chatTask(token));
    sendChatMessage.mockResolvedValue("cancelled");

    const resp = await handleChatReplyInject(TASK_ID, BODY);
    expect(resp.status).toBe(409);
    expect(skipEvents()).toHaveLength(0);
    // 还能回去答那组问题
    expect(getPendingAsk(TASK_ID)?.askId).toBe(ASK_ID);
    expect(getPendingAsk(TASK_ID)?.token).toBe(token);
  });

  it("没有待答提问 → 文本零变化、不落任何跳过事件（老行为）", async () => {
    getTask.mockImplementation(
      async () => ({ ...chatTask("tok"), events: [] }) as unknown as Task,
    );
    await handleChatReplyInject(TASK_ID, BODY);
    const agentText = String(
      (sendChatMessage as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[1] ?? "",
    );
    expect(agentText).toBe(BODY.text);
    expect(skipEvents()).toHaveLength(0);
    expect(settleAskCards).not.toHaveBeenCalled();
  });
});
