/**
 * chat 保命轮换（2026-09-03 OOM 根治）——决策链单测
 *
 * 不起 agent、不碰盘：mock 整条外围，只验证
 * 1. 胖会话（累计 210 万）→ 关旧会话 + 落灰线 + 起新会话（不走 send 续接）
 * 2. 瘦会话（累计 5 万）→ 正常 send 续接，不关不转
 *
 * mock 骨架抄 ask-skip-chat.test.ts（chat-inject 同一张依赖图）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";
import { SESSION_ROTATION_INFO_TEXT } from "@/lib/server/session-rotate";

let sessionAlive = true;

const {
  cancelChatRun,
  enqueueChatMessage,
  getChatQueueCount,
  getChatRunModel,
  getTask,
  hasChatSession,
  isChatRunActive,
  runChatSession,
  sendChatMessage,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    cancelChatRun: vi.fn<AnyFn>(() => {
      sessionAlive = false;
    }),
    enqueueChatMessage: vi.fn<AnyFn>(() => ({
      ok: true,
      itemId: "item-1",
      queuedCount: 1,
    })),
    getChatQueueCount: vi.fn<AnyFn>(() => 0),
    getChatRunModel: vi.fn<AnyFn>(() => ({ id: "grok-4.6" })),
    getTask: vi.fn<AnyFn>(),
    hasChatSession: vi.fn<AnyFn>(() => sessionAlive),
    isChatRunActive: vi.fn<AnyFn>(() => sessionAlive),
    runChatSession: vi.fn<AnyFn>(async () => {
      sessionAlive = true;
    }),
    sendChatMessage: vi.fn<AnyFn>(async () => "sent"),
    writeEventAndPublish: vi.fn<AnyFn>(async () => ({ id: "ev_info" })),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(async () => ({ id: "e1" })),
  };
});

vi.mock("@/lib/server/task-fs", () => ({
  getTask,
  setTaskRunStatus: vi.fn(async (id: string) => ({ id })),
  updateTaskFields: vi.fn(async () => null),
  syncTaskPendingAskId: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: vi.fn(async () => []),
}));
vi.mock("@/lib/server/chat-runner", () => ({
  cancelChatRun,
  forceClearChatRun: vi.fn(),
  getChatRunDisabledMcp: vi.fn(() => null),
  getChatRunModel,
  getChatRunProvider: vi.fn(() => null),
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
  captureChatCheckpoint: vi.fn(async () => ({
    ok: false,
    repoSnapshots: [],
    elapsedMsByRepo: {},
    warnings: [],
  })),
  persistCheckpointForReply: vi.fn(async () => undefined),
  // 模式 2 起新会话落首条 user_reply：mock 返事件（真跑会读盘、无此任务即 undefined→409）
  persistReplyAndCheckpoint: vi.fn(async () => ({ id: "ev_user" })),
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
vi.mock("@/lib/server/failpoints", () => ({
  failpoint: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/chat-gate", () => ({
  getChatLifecycle: vi.fn(() => null),
  isChatRewindInProgress: vi.fn(() => false),
  isChatStartLeaseValid: vi.fn(() => true),
  releaseChatStart: vi.fn(),
  tryReserveChatStart: vi.fn(() => 1),
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
  settleAskCards: vi.fn(async () => 1),
  ASK_CARD_SKIPPED_NOTE: "（已跳过）",
  ASK_CARD_SKIPPED_HINT: "这组提问已跳过、无需再回答",
  ASK_CARD_ANSWERED_HINT: "这组提问已回答、无需再答",
}));

const { handleChatReplyInject } = await import("@/lib/server/chat-inject");

const baseTask = {
  id: "t_rotate_1",
  title: "验收胖会话",
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
} as unknown as Task;

const fatTask: Task = {
  ...baseTask,
  sessionInputTokens: 2_100_000,
  tokenUsage: {
    last: {
      inputTokens: 560_088,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    total: {
      inputTokens: 2_788_972,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    turns: 14,
    updatedAt: 3,
  },
};

const thinTask: Task = {
  ...baseTask,
  sessionInputTokens: 50_000,
  tokenUsage: {
    last: {
      inputTokens: 45_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    total: {
      inputTokens: 300_000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    turns: 6,
    updatedAt: 3,
  },
};

const body = {
  text: "继续",
  bootArgs: { apiKey: "k", model: { id: "grok-4.6" } },
};

describe("chat 保命轮换", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionAlive = true;
  });

  it("胖会话：关旧 + 落灰线 + 起新会话，不走 send 续接", async () => {
    getTask.mockResolvedValue(fatTask);
    const resp = await handleChatReplyInject(fatTask.id, body);
    expect([200, 202]).toContain(resp.status);
    // 旧会话被关（走懒重启分支、不是模型切换）
    expect(cancelChatRun).toHaveBeenCalledWith(fatTask.id);
    // 灰线落盘
    expect(writeEventAndPublish).toHaveBeenCalledWith(
      fatTask.id,
      expect.objectContaining({
        kind: "info",
        text: SESSION_ROTATION_INFO_TEXT,
      }),
    );
    // 新会话被拉起
    expect(runChatSession).toHaveBeenCalled();
    // 胖会话绝不 send 续接
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  it("瘦会话：正常 send 续接，不关不转", async () => {
    getTask.mockResolvedValue(thinTask);
    const resp = await handleChatReplyInject(thinTask.id, body);
    expect([200, 202]).toContain(resp.status);
    expect(sendChatMessage).toHaveBeenCalled();
    expect(cancelChatRun).not.toHaveBeenCalled();
    expect(writeEventAndPublish).not.toHaveBeenCalledWith(
      thinTask.id,
      expect.objectContaining({ text: SESSION_ROTATION_INFO_TEXT }),
    );
  });
});
