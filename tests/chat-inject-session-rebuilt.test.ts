/**
 * chat-inject 会话重建提示接线（S2a-05）
 *
 * 不起 agent、不碰盘：mock 整条外围（骨架抄 session-rotate-chat.test.ts，chat-inject 同一张依赖图），
 * 只验证「什么时候调 announceSessionRebuilt」：
 *   - 懒重启：换模型 → 调一次；换提供方 / 保命轮换（已各写一条自己的 info）→ 不重复调；
 *   - resume 失败降级（无存活会话、有锚点、resume 返回 null）→ 调一次；
 *   - 热路径 send 续接、会话没动 → 不调。
 * 调用时机：runChatSession 同步前奏跑完之后（占位已挂、会话未必已真正建成），且带上刚落盘的当前消息 id 以便排除。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";
import {
  SESSION_ROTATION_INFO_TEXT,
  TOKEN_WATERMARK_ENV,
} from "@/lib/server/session-rotate";

let sessionAlive = true;

const {
  announceSessionRebuilt,
  cancelChatRun,
  getChatRunModel,
  getChatRunProvider,
  getTask,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    announceSessionRebuilt: vi.fn<AnyFn>(async () => true),
    cancelChatRun: vi.fn<AnyFn>(() => {
      sessionAlive = false;
    }),
    getChatRunModel: vi.fn<AnyFn>(() => ({ id: "grok-4.6" })),
    getChatRunProvider: vi.fn<AnyFn>(() => null),
    getTask: vi.fn<AnyFn>(),
    hasChatSession: vi.fn<AnyFn>(() => sessionAlive),
    isChatRunActive: vi.fn<AnyFn>(() => sessionAlive),
    resumeChatSession: vi.fn<AnyFn>(async () => null),
    runChatSession: vi.fn<AnyFn>(async () => {
      sessionAlive = true;
    }),
    sendChatMessage: vi.fn<AnyFn>(async () => "sent"),
    writeEventAndPublish: vi.fn<AnyFn>(async () => ({ id: "ev_info" })),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(async () => ({ id: "ev_user" })),
  };
});

vi.mock("@/lib/server/session-rebuilt-notice", () => ({
  announceSessionRebuilt,
}));
vi.mock("@/lib/server/task-fs", () => ({
  getTask,
  setTaskRunStatus: vi.fn(async (id: string) => ({ id })),
  updateTaskFields: vi.fn(async () => null),
  syncTaskPendingAskId: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/settings-fs", () => ({
  // 换提供方分支要读设置拿展示名；缺文件 → 走空 customProviders 兜底
  readSettingsFile: vi.fn(async () => ({ status: "missing" })),
}));
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: vi.fn(async () => []),
}));
vi.mock("@/lib/server/chat-runner", () => ({
  cancelChatRun,
  forceClearChatRun: vi.fn(),
  getChatRunDisabledMcp: vi.fn(() => null),
  getChatRunModel,
  getChatRunProvider,
  getChatRunRepoPaths: vi.fn(() => null),
  hasChatSession,
  isChatQueueDraining: vi.fn(() => false),
  isChatRunActive,
  releaseChatRunClaim: vi.fn(),
  resumeChatSession,
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
  enqueueChatMessage: vi.fn(() => ({ ok: true, itemId: "item-1", queuedCount: 1 })),
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
  id: "t_rebuilt_inject_1",
  title: "重建提示",
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

const body = {
  text: "继续",
  bootArgs: { apiKey: "k", model: { id: "grok-4.6" } },
};

const infoTexts = (): string[] =>
  writeEventAndPublish.mock.calls
    .map((c) => (c as unknown[])[1] as { kind?: string; text?: string })
    .filter((ev) => ev?.kind === "info")
    .map((ev) => ev.text ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  sessionAlive = true;
  getChatRunModel.mockReturnValue({ id: "grok-4.6" });
  getChatRunProvider.mockReturnValue(null);
  resumeChatSession.mockResolvedValue(null);
  vi.stubEnv(TOKEN_WATERMARK_ENV, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chat-inject：会话重建提示接线", () => {
  it("换模型 → 懒重启起新会话 → 调一次 announceSessionRebuilt，并带上当前消息 id 以便排除", async () => {
    // 旧会话绑的是 old-model，这条请求要求 grok-4.6
    getChatRunModel.mockReturnValue({ id: "old-model" });
    getTask.mockResolvedValue(baseTask);

    const resp = await handleChatReplyInject(baseTask.id, body);

    expect([200, 202]).toContain(resp.status);
    expect(cancelChatRun).toHaveBeenCalledWith(baseTask.id, { reason: "restart" });
    expect(runChatSession).toHaveBeenCalledTimes(1);
    expect(announceSessionRebuilt).toHaveBeenCalledTimes(1);
    expect(announceSessionRebuilt).toHaveBeenCalledWith(
      baseTask.id,
      expect.objectContaining({ skipEventId: "ev_user" }),
    );
    // 顺序：先起会话、再落提示（失败路径不留假提示）
    expect(runChatSession.mock.invocationCallOrder[0]).toBeLessThan(
      announceSessionRebuilt.mock.invocationCallOrder[0],
    );
  });

  it("换提供方 → 已有「已切换到 …」info，不再重复写重建提示", async () => {
    getChatRunProvider.mockReturnValue("cursor");
    getTask.mockResolvedValue({ ...baseTask, provider: "custom-x" } as Task);

    const resp = await handleChatReplyInject(baseTask.id, body);

    expect([200, 202]).toContain(resp.status);
    expect(runChatSession).toHaveBeenCalledTimes(1);
    expect(infoTexts().some((t) => t.startsWith("已切换到"))).toBe(true);
    expect(announceSessionRebuilt).not.toHaveBeenCalled();
  });

  it("保命轮换 → 已有「已自动压缩续接」info，不再重复写重建提示", async () => {
    vi.stubEnv(TOKEN_WATERMARK_ENV, "1");
    getTask.mockResolvedValue({
      ...baseTask,
      sessionInputTokens: 2_100_000,
    } as Task);

    const resp = await handleChatReplyInject(baseTask.id, body);

    expect([200, 202]).toContain(resp.status);
    expect(runChatSession).toHaveBeenCalledTimes(1);
    expect(infoTexts()).toContain(SESSION_ROTATION_INFO_TEXT);
    expect(announceSessionRebuilt).not.toHaveBeenCalled();
  });

  it("resume 失败降级：无存活会话、有锚点、resume 返回 null → 起新会话后调一次", async () => {
    sessionAlive = false;
    resumeChatSession.mockResolvedValue(null);
    getTask.mockResolvedValue({ ...baseTask, sessionAgentId: "agent_old" } as Task);

    const resp = await handleChatReplyInject(baseTask.id, body);

    expect([200, 202]).toContain(resp.status);
    expect(resumeChatSession).toHaveBeenCalledTimes(1);
    expect(runChatSession).toHaveBeenCalledTimes(1);
    expect(announceSessionRebuilt).toHaveBeenCalledTimes(1);
    expect(announceSessionRebuilt).toHaveBeenCalledWith(
      baseTask.id,
      expect.objectContaining({ skipEventId: "ev_user" }),
    );
  });

  it("热路径：会话活着、设置没动 → send 续接，不起新会话、不写重建提示", async () => {
    getTask.mockResolvedValue(baseTask);

    const resp = await handleChatReplyInject(baseTask.id, body);

    expect([200, 202]).toContain(resp.status);
    expect(sendChatMessage).toHaveBeenCalled();
    expect(runChatSession).not.toHaveBeenCalled();
    expect(announceSessionRebuilt).not.toHaveBeenCalled();
  });

  it("提示是 best-effort：announceSessionRebuilt 抛错也不能让发消息失败", async () => {
    getChatRunModel.mockReturnValue({ id: "old-model" });
    getTask.mockResolvedValue(baseTask);
    announceSessionRebuilt.mockRejectedValueOnce(new Error("disk full"));

    const resp = await handleChatReplyInject(baseTask.id, body);

    expect([200, 202]).toContain(resp.status);
    expect(runChatSession).toHaveBeenCalledTimes(1);
  });
});

describe("chat-inject：接线契约（源码）", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/lib/server/chat-inject.ts"),
    "utf-8",
  );

  it("两条起新会话路径（队列优先 / 普通）都在起会话成功后调用，且都排除当前消息", () => {
    const calls = src.match(/announceSessionRebuilt\(/g) ?? [];
    // 一处是 import 之外的两处调用（队列优先 + 普通）；允许经本地 helper 包一层
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(src).toMatch(/skipEventId: firstMessageEventId/);
    expect(src).toMatch(/skipEventId: replyEvent\?\.id/);
  });

  it("换提供方 / 保命轮换分支把「已自己写过 info」记下来，用于跳过重建提示", () => {
    expect(src).toMatch(/rebuildInfoCovered = true/);
  });
});
