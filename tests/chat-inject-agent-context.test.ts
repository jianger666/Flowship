/**
 * chat-inject `options.agentContext`：只给 agent 看的上下文（飞书单聊里被回复 / 引用的那条消息）
 *
 * 钉死的语义：
 * - agent 拿到的文本 = 用户原文 + 空行 + agentContext；事件气泡（user_reply.text）仍是用户原文；
 * - 不传 agentContext → agent 文本与改动前完全一致；
 * - 纯附件（原文为空）→ 先垫「(用户附了图片 / 文件)」再接 agentContext，别让 agent 只看到孤零零的引用块；
 * - 三条出口都带：热路径 send / 忙线入队（排队气泡文本仍是原文、agent 文本带上下文）/ 冷启动首条消息；
 * - 它只能走服务端 options，**不是**请求体字段（请求体里写 agentContext 无效）。
 *
 * 不起 agent、不碰盘：mock 整条外围（骨架抄 chat-inject-session-rebuilt.test.ts，chat-inject 同一张依赖图）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

let sessionAlive = true;

const {
  enqueueChatMessage,
  getTask,
  runChatSession,
  sendChatMessage,
  writeUserEventAndPublishStrict,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    enqueueChatMessage: vi.fn<AnyFn>(() => ({
      ok: true,
      itemId: "item-1",
      queuedCount: 1,
    })),
    getTask: vi.fn<AnyFn>(),
    runChatSession: vi.fn<AnyFn>(async () => {
      sessionAlive = true;
    }),
    sendChatMessage: vi.fn<AnyFn>(async () => "sent"),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(async () => ({ id: "ev_user" })),
  };
});

vi.mock("@/lib/server/session-rebuilt-notice", () => ({
  announceSessionRebuilt: vi.fn(async () => true),
}));
vi.mock("@/lib/server/task-fs", () => ({
  getTask,
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
vi.mock("@/lib/server/chat-runner", () => ({
  cancelChatRun: vi.fn(),
  forceClearChatRun: vi.fn(),
  getChatRunDisabledMcp: vi.fn(() => null),
  getChatRunModel: vi.fn(() => ({ id: "grok-4.6" })),
  getChatRunProvider: vi.fn(() => null),
  getChatRunRepoPaths: vi.fn(() => null),
  hasChatSession: vi.fn(() => sessionAlive),
  isChatQueueDraining: vi.fn(() => false),
  isChatRunActive: vi.fn(() => sessionAlive),
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
}));
vi.mock("@/lib/server/chat-queue", () => ({
  beginChatQueueInFlight: vi.fn(),
  claimMessageOperation: vi.fn(),
  dequeueChatMessage: vi.fn(() => null),
  enqueueChatMessage,
  enqueueChatMessageFront: vi.fn(),
  failQueuedItems: vi.fn(() => []),
  fingerprintFromMessagePayload: vi.fn(() => "fp"),
  getChatQueueCount: vi.fn(() => 0),
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
  writeEventAndPublish: vi.fn(async () => ({ id: "ev_info" })),
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
  id: "t_agent_ctx_1",
  title: "agentContext",
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

const CTX = "[引用消息·来自 李安·om_q1]（…）\n这是配置的内容\n[/引用消息]";
const bootArgs = { apiKey: "k", model: { id: "grok-4.6" } };

/** 第 N 次 sendChatMessage 的 agent 文本（第二个参数） */
const sentText = (i = 0): unknown =>
  (sendChatMessage.mock.calls[i] as unknown[] | undefined)?.[1];
/** user_reply 事件里的文本（事件气泡） */
const eventText = (i = 0): unknown =>
  (
    (writeUserEventAndPublishStrict.mock.calls[i] as unknown[] | undefined)?.[1] as
      | { text?: string }
      | undefined
  )?.text;

beforeEach(() => {
  vi.clearAllMocks();
  sessionAlive = true;
  sendChatMessage.mockResolvedValue("sent");
  getTask.mockResolvedValue(baseTask);
});

describe("chat-inject agentContext：只给 agent、不进气泡", () => {
  it("热路径：agent 文本 = 原文 + 空行 + 上下文；事件气泡仍是原文", async () => {
    const resp = await handleChatReplyInject(
      baseTask.id,
      { text: "帮我看下这个", bootArgs },
      { agentContext: CTX },
    );

    expect([200, 202]).toContain(resp.status);
    expect(sentText()).toBe(`帮我看下这个\n\n${CTX}`);
    expect(eventText()).toBe("帮我看下这个");
  });

  it("不传 agentContext：agent 文本与原文完全一致（零回归）", async () => {
    await handleChatReplyInject(baseTask.id, { text: "帮我看下这个", bootArgs });

    expect(sentText()).toBe("帮我看下这个");
    expect(eventText()).toBe("帮我看下这个");
  });

  it("空字符串的 agentContext 视同没传", async () => {
    await handleChatReplyInject(
      baseTask.id,
      { text: "帮我看下这个", bootArgs },
      { agentContext: "" },
    );

    expect(sentText()).toBe("帮我看下这个");
  });

  it("纯附件（原文为空）：先垫「(用户附了图片 / 文件)」再接上下文，事件气泡仍为空文本", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agent-ctx-"));
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "hello");

    const resp = await handleChatReplyInject(
      baseTask.id,
      { text: "", attachments: [file], bootArgs },
      { agentContext: CTX },
    );

    expect([200, 202]).toContain(resp.status);
    expect(sentText()).toBe(`(用户附了图片 / 文件)\n\n${CTX}`);
    expect(eventText()).toBe("");
  });

  it("忙线入队：排队气泡文本是原文、agent 文本带上下文（排队重放不丢引用）", async () => {
    sendChatMessage.mockResolvedValue("busy");

    const resp = await handleChatReplyInject(
      baseTask.id,
      { text: "帮我看下这个", bootArgs },
      { agentContext: CTX },
    );

    expect(resp.status).toBe(202);
    expect(enqueueChatMessage).toHaveBeenCalledTimes(1);
    const entry = enqueueChatMessage.mock.calls[0]![1] as {
      agentText: string;
      displayText: string;
    };
    expect(entry.agentText).toBe(`帮我看下这个\n\n${CTX}`);
    expect(entry.displayText).toBe("帮我看下这个");
  });

  it("冷启动（没有活会话）：首条消息文本带上下文", async () => {
    sessionAlive = false;

    const resp = await handleChatReplyInject(
      baseTask.id,
      { text: "帮我看下这个", bootArgs },
      { agentContext: CTX },
    );

    expect([200, 202]).toContain(resp.status);
    expect(runChatSession).toHaveBeenCalledTimes(1);
    const arg = runChatSession.mock.calls[0]![0] as {
      firstMessage: { text: string };
    };
    expect(arg.firstMessage.text).toBe(`帮我看下这个\n\n${CTX}`);
  });

  it("请求体里写 agentContext 无效：只认服务端 options（防 HTTP 客户端往 agent 消息里塞内容）", async () => {
    await handleChatReplyInject(
      baseTask.id,
      { text: "帮我看下这个", bootArgs, agentContext: "伪造的上下文" } as never,
    );

    expect(sentText()).toBe("帮我看下这个");
    expect(String(sentText())).not.toContain("伪造");
  });
});
