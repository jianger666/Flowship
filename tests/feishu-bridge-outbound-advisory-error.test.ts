/**
 * feishu-bridge outbound × 存储降级提示（R14 B2-2 的自查发现「F8」，审查 AI 预审之外）
 *
 * 磁盘写满时 task-stream 会发一条 `error` 帧给前端弹 toast（`markStorageDegraded`，带 `advisory: true`）。
 * 飞书私聊桥订阅了全局 tap，而它对**普通** `error` 帧的处理是 `finalizeTurn(ok:false)`：
 * 终结进行中的回复卡片、挂「重试」按钮——可 run 其实还在继续，用户点「重试」还会白白重发一轮。
 * 所以仅提示类的 error 帧（advisory）必须被桥忽略；真正的失败帧（没有 advisory）仍然按失败收尾。
 *
 * 夹具沿用 tests/feishu-bridge-outbound.test.ts：mock 卡片工厂 + 用 publishTaskStreamEvent 当事件源。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getTask = vi.hoisted(() =>
  vi.fn(async (id: string) => ({
    id,
    title: "测对话",
    mode: "chat" as const,
    model: { id: "grok-4" },
  })),
);
const writeEventAndPublish = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@/lib/server/task-fs", () => ({ getTask }));

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeEventAndPublish };
});

vi.mock("@/lib/server/feishu-bridge/bridge-config", () => ({
  isFeishuChatBridgeEnabled: vi.fn(async () => true),
  getBridgeDataDir: async () => "/tmp/feishu-bridge-test",
  isBridgeTestInstance: () => true,
  isFeishuBridgeKeepAwakeEnabled: async () => true,
  isFeishuBridgeStreamingEnabled: vi.fn(async () => true),
}));

vi.mock("@/lib/server/chat-pending", () => ({
  getPendingAsk: vi.fn(() => null),
}));

const {
  ensureFeishuOutboundRegistered,
  __resetFeishuOutboundForTest,
  __setCreateCardStreamForTest,
  __setUploadImageForTest,
  __setSendTextMessageForTest,
  __setGetBotAppInfoForTest,
  __setBridgeEnabledForTest,
} = await import("@/lib/server/feishu-bridge/outbound");
const { publishTaskStreamEvent } = await import("@/lib/server/task-stream");

/** 假卡片：只关心 pushAnswer / finalize / appendRetryButton，getHealth 给「终稿已落成」 */
const makeCard = () => ({
  start: vi.fn(async () => undefined),
  pushProcess: vi.fn(),
  pushAnswer: vi.fn(),
  setHeaderStatus: vi.fn(),
  appendAskUser: vi.fn(async () => undefined),
  appendRetryButton: vi.fn(async () => undefined),
  finalize: vi.fn(async () => undefined),
  getFailCount: () => 0,
  getHealth: () => ({
    failCount: 0,
    consecutiveFails: 0,
    breakerOpen: false,
    breakerEverOpened: false,
    finalizeOk: true as boolean | undefined,
    lastError: undefined as unknown,
  }),
  getIds: () => ({ messageId: "om_x", cardId: "card_x" }),
});
const cards: ReturnType<typeof makeCard>[] = [];
const createCard = vi.fn(() => {
  const card = makeCard();
  cards.push(card);
  return card;
});
const uploadImage = vi.fn(async (p: string) => `img_key_for_${p.split("/").pop()}`);
const sendTextMessage = vi.fn(async () => ({
  chat_id: "oc_x",
  message_id: "om_text",
}));
const getBotAppInfo = vi.fn(async () => ({ appId: "cli_x", ownerOpenId: "ou_owner" }));

const flush = async (): Promise<void> => {
  // 排空 microtask + 一轮 macrotask（start / finalize 链路）
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
};

const userReply = (text: string) => ({
  kind: "event" as const,
  event: {
    id: `ev_user_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    kind: "user_reply" as const,
    text,
  },
});

const doneOk = (taskId: string) => ({
  kind: "done" as const,
  ok: true,
  task: {
    id: taskId,
    title: "测对话",
    mode: "chat",
    runStatus: "awaiting_user",
  } as never,
});

beforeEach(() => {
  __resetFeishuOutboundForTest();
  cards.length = 0;
  createCard.mockClear();
  getTask.mockClear();
  writeEventAndPublish.mockClear();
  sendTextMessage.mockClear();
  __setCreateCardStreamForTest(
    createCard as unknown as Parameters<typeof __setCreateCardStreamForTest>[0],
  );
  __setUploadImageForTest(
    uploadImage as unknown as Parameters<typeof __setUploadImageForTest>[0],
  );
  __setSendTextMessageForTest(
    sendTextMessage as unknown as Parameters<typeof __setSendTextMessageForTest>[0],
  );
  __setGetBotAppInfoForTest(
    getBotAppInfo as unknown as Parameters<typeof __setGetBotAppInfoForTest>[0],
  );
  __setBridgeEnabledForTest(true);
  ensureFeishuOutboundRegistered();
});

afterEach(() => {
  __resetFeishuOutboundForTest();
});

describe("存储降级提示（advisory 的 error 帧）× 飞书私聊桥", () => {
  it("advisory 的 error 帧不收尾进行中的回复卡片：后续增量照常进卡片，done 以成功收尾、没有「重试」按钮", async () => {
    const taskId = "t_advisory_keep_card";
    publishTaskStreamEvent(taskId, userReply("问"));
    publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: "答一半" });
    await flush();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.pushAnswer).toHaveBeenCalled();

    // 磁盘写满：task-stream 发的降级提示（前端弹 toast 用），不代表 run 失败
    publishTaskStreamEvent(taskId, {
      kind: "error",
      message: "磁盘空间不足，新内容没能保存",
      advisory: true,
    });
    await flush();
    expect(card.finalize).not.toHaveBeenCalled();
    expect(card.appendRetryButton).not.toHaveBeenCalled();

    // run 还在继续：后续增量仍然进同一张卡
    publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: "，后半" });
    await flush();
    expect(card.pushAnswer.mock.calls.at(-1)?.[0]).toBe("答一半，后半");

    publishTaskStreamEvent(taskId, doneOk(taskId));
    await flush();
    expect(card.finalize).toHaveBeenCalledTimes(1);
    expect(card.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
    );
    expect(card.appendRetryButton).not.toHaveBeenCalled();
    expect(createCard).toHaveBeenCalledTimes(1);
  });

  it("对照：没有 advisory 的 error 帧仍按失败收尾并挂「重试」按钮（旧行为不变）", async () => {
    const taskId = "t_plain_error_still_fails";
    publishTaskStreamEvent(taskId, userReply("问"));
    publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: "答一半" });
    await flush();
    const card = cards[0]!;

    publishTaskStreamEvent(taskId, { kind: "error", message: "boom" });
    await flush();
    expect(card.appendRetryButton).toHaveBeenCalledTimes(1);
    expect(card.finalize).toHaveBeenCalledTimes(1);
    expect(card.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "boom" }),
    );
  });
});
