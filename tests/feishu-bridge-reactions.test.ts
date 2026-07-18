/**
 * 飞书注入结果 emoji 回执：四种 kind 映射 + FIFO 上限
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

import { addReaction } from "@/lib/server/feishu-bridge/lark-api";
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

  it("queued → Typing", async () => {
    await __emitInjectResultForTest({
      kind: "queued",
      messageId: "om_q",
      taskId: "t1",
      text: "hi",
    });
    expect(addReaction).toHaveBeenCalledWith("om_q", EMOJI_QUEUED);
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
});
