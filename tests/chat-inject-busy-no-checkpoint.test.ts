/**
 * chat 发消息时 run 正在跑 → 立刻入队，不先打「发送前快照」。
 *
 * 2026-11-19 实测：对话里「1 条排队中」点开却是「队列已空」。原因是服务端对「忙线」消息先打快照
 * （captureChatCheckpoint，大仓 1–10s）、才发现 sendChatMessage 回 busy、才入队——快照白打
 * （排队消息 flush 时自己会重打），还把入队推迟了一个快照：客户端本地早已显示「排队中」，服务端队列却是空的。
 * 日志里这条路径的特征：`checkpoint#send=10434ms sendChatMessage=0ms`（chat-reply-timings.log）。
 *
 * 这里钉：
 * - run 在跑（非 owner）→ 不打快照、不 sendChatMessage、直接 enqueue，回 202 queued；
 * - 对照：run 不在跑 → 照旧「先快照再 send」；
 * - resume 出来的 owner 自己认领了 runActive（isChatSendBusy 恒为真）→ 不能因此把自己排进队，仍要先发这条。
 *
 * mock 骨架抄 chat-inject-boot-progress.test.ts（chat-inject 同一张依赖图）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

let sessionAlive = false;

const {
  getTask,
  hasChatSession,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
  publishTaskStreamEvent,
  captureChatCheckpoint,
  isChatSendBusy,
  isChatQueueDraining,
  getChatQueueCount,
  enqueueChatMessage,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    // 默认：没拍到快照（ok:false）——不影响发送、只是不带 checkpointed
    captureChatCheckpoint: vi.fn<AnyFn>(async () => ({
      ok: false,
      repoSnapshots: [],
      elapsedMsByRepo: {},
      warnings: [],
    })),
    getTask: vi.fn<AnyFn>(),
    hasChatSession: vi.fn<AnyFn>(() => sessionAlive),
    // 默认：恢复成功并当上 owner（instanceId=7）
    resumeChatSession: vi.fn<AnyFn>(async () => {
      sessionAlive = true;
      return 7;
    }),
    runChatSession: vi.fn<AnyFn>(async () => {
      sessionAlive = true;
    }),
    sendChatMessage: vi.fn<AnyFn>(async () => "sent"),
    publishTaskStreamEvent: vi.fn<AnyFn>(),
    isChatSendBusy: vi.fn<AnyFn>(() => false),
    isChatQueueDraining: vi.fn<AnyFn>(() => false),
    getChatQueueCount: vi.fn<AnyFn>(() => 0),
    enqueueChatMessage: vi.fn<AnyFn>(() => ({ ok: true, itemId: "item-1", queuedCount: 1 })),
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
  cancelChatRun: vi.fn(),
  forceClearChatRun: vi.fn(),
  getChatRunDisabledMcp: vi.fn(() => null),
  getChatRunModel: vi.fn(() => ({ id: "grok-4.6" })),
  getChatRunProvider: vi.fn(() => null),
  getChatRunRepoPaths: vi.fn(() => null),
  hasChatSession,
  isChatQueueDraining,
  // 起新会话 / 队列优先路径用（本文件不走）；与「忙线判定」是两个函数
  isChatRunActive: vi.fn(() => false),
  isChatSendBusy,
  releaseChatRunClaim: vi.fn(),
  resumeChatSession,
  runChatSession,
  sendChatMessage,
  waitForChatToStop: vi.fn(async () => true),
}));
vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint,
  persistCheckpointForReply: vi.fn(async () => undefined),
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
  publishTaskStreamEvent,
  writeEventAndPublish: vi.fn(async () => ({ id: "ev_info" })),
  writeUserEventAndPublishStrict: vi.fn(async () => ({ id: "e1" })),
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
  id: "t_busy_1",
  title: "忙线入队",
  mode: "chat",
  repoStatus: "developing",
  runStatus: "running",
  currentActionId: null,
  actions: [],
  mrs: [],
  // 绑了仓 → 会打发送前快照（不绑就根本没有快照可省）
  repoPaths: ["/tmp/busy-skip-repo"],
  provider: "cursor",
  model: { id: "grok-4.6" },
  pendingAskId: null,
  createdAt: 1,
  updatedAt: 2,
  events: [],
} as unknown as Task;

const body = {
  text: "先把小红书html给我",
  bootArgs: { apiKey: "k", model: { id: "grok-4.6" } },
};

describe("run 在跑时的发送：先入队、不白打快照", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks 不还原 mockImplementation：上一个用例把快照改成「永不返回」会串到后面
    captureChatCheckpoint.mockImplementation(async () => ({
      ok: false,
      repoSnapshots: [],
      elapsedMsByRepo: {},
      warnings: [],
    }));
    sendChatMessage.mockImplementation(async () => "sent");
    sessionAlive = true; // 热会话
    isChatSendBusy.mockImplementation(() => false);
    isChatQueueDraining.mockImplementation(() => false);
    getChatQueueCount.mockImplementation(() => 0);
    getTask.mockResolvedValue(baseTask);
  });

  it("run 在跑：不打快照、不 send，直接入队并回 202 queued", async () => {
    isChatSendBusy.mockImplementation(() => true);
    const resp = await handleChatReplyInject(baseTask.id, body);
    expect(resp.status).toBe(202);
    expect(await resp.json()).toMatchObject({ ok: true, queued: true });
    expect(captureChatCheckpoint).not.toHaveBeenCalled();
    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(enqueueChatMessage).toHaveBeenCalledTimes(1);
  });

  it("入队发生在任何快照之前（快照再慢也不会拖住入队）：快照挂着不返回，入队仍已完成", async () => {
    isChatSendBusy.mockImplementation(() => true);
    // 即使有人误把快照放回前面：它永远不返回，入队也必须已经发生——这里快照根本不该被调用
    captureChatCheckpoint.mockImplementation(() => new Promise(() => {}));
    const resp = await handleChatReplyInject(baseTask.id, body);
    expect(resp.status).toBe(202);
    expect(enqueueChatMessage).toHaveBeenCalledTimes(1);
  });

  it("对照：run 不在跑、队列也空 → 照旧先快照再 send（快照在 send 之前）", async () => {
    const resp = await handleChatReplyInject(baseTask.id, body);
    expect([200, 202]).toContain(resp.status);
    expect(captureChatCheckpoint).toHaveBeenCalledTimes(1);
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(captureChatCheckpoint.mock.invocationCallOrder[0]!).toBeLessThan(
      sendChatMessage.mock.invocationCallOrder[0]!,
    );
    expect(enqueueChatMessage).not.toHaveBeenCalled();
  });

  it("run 不在跑但队里已有消息 / 正在 drain：照旧直接入队（原有行为不变）", async () => {
    getChatQueueCount.mockImplementation(() => 2);
    expect((await handleChatReplyInject(baseTask.id, body)).status).toBe(202);
    expect(captureChatCheckpoint).not.toHaveBeenCalled();
    expect(sendChatMessage).not.toHaveBeenCalled();

    vi.clearAllMocks();
    getTask.mockResolvedValue(baseTask);
    getChatQueueCount.mockImplementation(() => 0);
    isChatQueueDraining.mockImplementation(() => true);
    expect((await handleChatReplyInject(baseTask.id, body)).status).toBe(202);
    expect(captureChatCheckpoint).not.toHaveBeenCalled();
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  it("探测后 run 才变忙（快照期间别的消息起了 run）：sendChatMessage 回 busy 仍兜底入队，不丢消息", async () => {
    sendChatMessage.mockImplementationOnce(async () => "busy");
    const resp = await handleChatReplyInject(baseTask.id, body);
    expect(resp.status).toBe(202);
    expect(captureChatCheckpoint).toHaveBeenCalledTimes(1);
    expect(enqueueChatMessage).toHaveBeenCalledTimes(1);
  });

  it("resume 当上 owner（它自己认领了 runActive）：不因 isChatSendBusy 为真把自己排进队，照旧先发这条", async () => {
    sessionAlive = false; // 内存没会话 → 冷路径 resume
    const coldTask = { ...baseTask, sessionAgentId: "agent_cold_1" } as unknown as Task;
    getTask.mockResolvedValue(coldTask);
    // owner 认领后 runActive 恒为真（真实实现里 claimRun 同步置位）
    resumeChatSession.mockImplementationOnce(async () => {
      sessionAlive = true;
      isChatSendBusy.mockImplementation(() => true);
      return 7;
    });
    const resp = await handleChatReplyInject(coldTask.id, body);
    expect([200, 202]).toContain(resp.status);
    expect(resumeChatSession).toHaveBeenCalledTimes(1);
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(enqueueChatMessage).not.toHaveBeenCalled();
  });
});
