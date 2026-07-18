/**
 * 飞书撤回同步出队：命中出队+撤表情 / 未命中忽略
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/feishu-bridge/lark-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/feishu-bridge/lark-api")>();
  return {
    ...actual,
    getBotAppInfo: vi.fn(async () => ({
      appId: "cli_x",
      ownerOpenId: "ou_owner",
    })),
    sendTextMessage: vi.fn(async () => ({
      chat_id: "c",
      message_id: "m",
    })),
    removeReaction: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => ({ reaction_id: "rid_q" })),
  };
});

import {
  clearChatQueue,
  enqueueChatMessage,
  getChatQueueCount,
} from "@/lib/server/chat-queue";
import {
  getBotAppInfo,
  removeReaction,
  sendTextMessage,
} from "@/lib/server/feishu-bridge/lark-api";
import {
  __queuedMapForTest,
  __resetRecallForTest,
  ensureRecallHandlingRegistered,
  handleRecallEvent,
  parseRecalledMessageId,
} from "@/lib/server/feishu-bridge/recall";
import {
  __resetReactionsForTest,
  ensureReactionReceiptsRegistered,
  getStoredReaction,
} from "@/lib/server/feishu-bridge/reactions";
import {
  __clearInjectResultListenersForTest,
  __emitInjectResultForTest,
} from "@/lib/server/feishu-bridge/router";

describe("parseRecalledMessageId", () => {
  it("解析官方嵌套 event.message_id", () => {
    expect(
      parseRecalledMessageId({
        schema: "2.0",
        header: { event_type: "im.message.recalled_v1" },
        event: { message_id: "om_nested", chat_id: "oc_x" },
      }),
    ).toBe("om_nested");
  });

  it("兼容扁平 message_id", () => {
    expect(parseRecalledMessageId({ message_id: "om_flat" })).toBe("om_flat");
  });

  it("无 id → null", () => {
    expect(parseRecalledMessageId({})).toBeNull();
    expect(parseRecalledMessageId(null)).toBeNull();
  });
});

describe("handleRecallEvent", () => {
  const taskId = "task-recall-1";

  beforeEach(() => {
    clearChatQueue(taskId);
    __resetRecallForTest();
    __resetReactionsForTest();
    __clearInjectResultListenersForTest();
    vi.mocked(sendTextMessage).mockClear();
    vi.mocked(removeReaction).mockClear();
    vi.mocked(getBotAppInfo).mockClear();
    ensureReactionReceiptsRegistered();
    ensureRecallHandlingRegistered();
  });

  afterEach(() => {
    clearChatQueue(taskId);
    __resetRecallForTest();
    __resetReactionsForTest();
    __clearInjectResultListenersForTest();
  });

  it("命中队列 → 出队 + 撤 Typing + 回「已撤回该消息」", async () => {
    enqueueChatMessage(taskId, {
      agentText: "排队中的话",
      displayText: "排队中的话",
      enqueuedAt: Date.now(),
    });
    expect(getChatQueueCount(taskId)).toBe(1);

    await __emitInjectResultForTest({
      kind: "queued",
      messageId: "om_queued",
      taskId,
      text: "排队中的话",
    });
    expect(__queuedMapForTest().has("om_queued")).toBe(true);
    expect(getStoredReaction("om_queued")?.emojiType).toBe("Typing");

    await handleRecallEvent({
      schema: "2.0",
      event: { message_id: "om_queued", chat_id: "oc_x" },
    });

    expect(getChatQueueCount(taskId)).toBe(0);
    expect(__queuedMapForTest().has("om_queued")).toBe(false);
    expect(removeReaction).toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith(
      "ou_owner",
      "已撤回该消息",
    );
  });

  it("未命中（未知 messageId）→ 忽略", async () => {
    enqueueChatMessage(taskId, {
      agentText: "别动我",
      displayText: "别动我",
      enqueuedAt: Date.now(),
    });
    await handleRecallEvent({
      event: { message_id: "om_unknown" },
    });
    expect(getChatQueueCount(taskId)).toBe(1);
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(removeReaction).not.toHaveBeenCalled();
  });

  it("已 sent 的 messageId 不在 queuedMap → 忽略", async () => {
    await __emitInjectResultForTest({
      kind: "queued",
      messageId: "om_then_sent",
      taskId,
      text: "x",
    });
    await __emitInjectResultForTest({
      kind: "sent",
      messageId: "om_then_sent",
      taskId,
    });
    expect(__queuedMapForTest().has("om_then_sent")).toBe(false);

    await handleRecallEvent({
      event: { message_id: "om_then_sent" },
    });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});
