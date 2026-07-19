/**
 * 飞书注入结果 emoji 回执：四种 kind 映射 + FIFO 上限（queued/sent 两态统一 Get）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/feishu-bridge/lark-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/feishu-bridge/lark-api")>();
  return {
    ...actual,
    addReaction: vi.fn(async (_mid: string, emoji: string) => ({
      reaction_id: `rid_${emoji}`,
    })),
    removeReaction: vi.fn(async () => undefined),
  };
});

import { emitQueuedMessageFlushed } from "@/lib/server/chat-queue";
import {
  addReaction,
  removeReaction,
} from "@/lib/server/feishu-bridge/lark-api";
import {
  __reactionOrderForTest,
  __resetReactionsForTest,
  EMOJI_FAILED,
  EMOJI_QUEUED,
  EMOJI_SENT,
  ensureReactionReceiptsRegistered,
  getStoredReaction,
} from "@/lib/server/feishu-bridge/reactions";
import {
  __clearInjectResultListenersForTest,
  __emitInjectResultForTest,
} from "@/lib/server/feishu-bridge/router";

describe("feishu-bridge reactions", () => {
  beforeEach(() => {
    __resetReactionsForTest();
    __clearInjectResultListenersForTest();
    vi.mocked(addReaction).mockClear();
    vi.mocked(removeReaction).mockClear();
    vi.mocked(addReaction).mockImplementation(async (mid, emoji) => ({
      reaction_id: `rid_${emoji}_${mid}`,
    }));
    ensureReactionReceiptsRegistered();
  });

  afterEach(() => {
    __resetReactionsForTest();
    __clearInjectResultListenersForTest();
  });

  it("sent → Get", async () => {
    await __emitInjectResultForTest({ kind: "sent", messageId: "om_sent" });
    expect(addReaction).toHaveBeenCalledWith("om_sent", EMOJI_SENT);
    expect(getStoredReaction("om_sent")?.emojiType).toBe(EMOJI_SENT);
  });

  // T8 用户拍板：queued 也点 Get（不要 Typing 敲键盘动画）
  it("queued → Get（与 sent 同表情）", async () => {
    await __emitInjectResultForTest({
      kind: "queued",
      messageId: "om_q",
      taskId: "t1",
      text: "hi",
    });
    expect(addReaction).toHaveBeenCalledWith("om_q", EMOJI_QUEUED);
    expect(EMOJI_QUEUED).toBe(EMOJI_SENT);
  });

  it("failed → CrossMark", async () => {
    await __emitInjectResultForTest({
      kind: "failed",
      messageId: "om_f",
      error: "x",
    });
    expect(addReaction).toHaveBeenCalledWith("om_f", EMOJI_FAILED);
  });

  it("skipped → 不点", async () => {
    await __emitInjectResultForTest({
      kind: "skipped",
      messageId: "om_s",
    });
    expect(addReaction).not.toHaveBeenCalled();
  });

  it("FIFO 超 500 淘汰最旧", async () => {
    for (let i = 0; i < 501; i++) {
      await __emitInjectResultForTest({
        kind: "sent",
        messageId: `om_${i}`,
      });
    }
    expect(getStoredReaction("om_0")).toBeNull();
    expect(getStoredReaction("om_500")).not.toBeNull();
    expect(__reactionOrderForTest().length).toBe(500);
  });

  it("ensure 幂等：不双挂 listener", async () => {
    ensureReactionReceiptsRegistered();
    ensureReactionReceiptsRegistered();
    await __emitInjectResultForTest({ kind: "sent", messageId: "om_once" });
    expect(addReaction).toHaveBeenCalledTimes(1);
  });

  // T8：两态同表情后升级逻辑已删——flush 后不撤旧表情、不重复点
  it("队列 flush 后不重复点表情（升级逻辑已删）", async () => {
    await __emitInjectResultForTest({
      kind: "queued",
      messageId: "om_upgrade",
      taskId: "t1",
      text: "hi",
    });
    expect(getStoredReaction("om_upgrade")?.emojiType).toBe(EMOJI_QUEUED);
    vi.mocked(addReaction).mockClear();
    vi.mocked(removeReaction).mockClear();

    emitQueuedMessageFlushed("t1", {
      itemId: "cq_test_upgrade",
      agentText: "hi",
      displayText: "hi",
      enqueuedAt: Date.now(),
      extraMeta: { feishuMessageId: "om_upgrade" },
    });
    // flush 事件发出后给回调机会执行——期望完全无表情操作
    await new Promise((r) => setTimeout(r, 50));
    expect(removeReaction).not.toHaveBeenCalled();
    expect(addReaction).not.toHaveBeenCalled();
    expect(getStoredReaction("om_upgrade")?.emojiType).toBe(EMOJI_QUEUED);
  });
});
