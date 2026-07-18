/**
 * card-action：按钮回调闭环（身份校验 / value 双形态 / ask 投递 / 失效 / retry / 异常不抛）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getBotAppInfo,
  batchUpdateCard,
  sendTextMessage,
  getPendingAsk,
  clearPendingAsk,
  deliverChatAskReply,
  hasChatSession,
  handleChatReplyInject,
  loadBridgeBootContext,
  findTaskByMessageId,
  getTask,
  appendEvent,
  publishTaskStreamEvent,
  getChatLifecycle,
  registerCardActionHandler,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    getBotAppInfo: vi.fn<AnyFn>(),
    batchUpdateCard: vi.fn<AnyFn>(async () => undefined),
    sendTextMessage: vi.fn<AnyFn>(async () => ({
      chat_id: "oc",
      message_id: "om",
    })),
    getPendingAsk: vi.fn<AnyFn>(),
    clearPendingAsk: vi.fn<AnyFn>(),
    deliverChatAskReply: vi.fn<AnyFn>(),
    hasChatSession: vi.fn<AnyFn>(() => true),
    handleChatReplyInject: vi.fn<AnyFn>(),
    loadBridgeBootContext: vi.fn<AnyFn>(),
    findTaskByMessageId: vi.fn<AnyFn>(),
    getTask: vi.fn<AnyFn>(),
    appendEvent: vi.fn<AnyFn>(),
    publishTaskStreamEvent: vi.fn<AnyFn>(),
    getChatLifecycle: vi.fn<AnyFn>(() => null),
    registerCardActionHandler: vi.fn<AnyFn>(),
  };
});

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({
  getBotAppInfo,
  batchUpdateCard,
  sendTextMessage,
}));

vi.mock("@/lib/server/chat-pending", () => ({
  getPendingAsk,
  clearPendingAsk,
}));

vi.mock("@/lib/server/chat-runner", () => ({
  deliverChatAskReply,
  hasChatSession,
}));

vi.mock("@/lib/server/chat-inject", () => ({
  handleChatReplyInject,
}));

vi.mock("@/lib/server/feishu-bridge/router", () => ({
  loadBridgeBootContext,
  registerCardActionHandler,
}));

vi.mock("@/lib/server/feishu-bridge/card-map", () => ({
  findTaskByMessageId,
}));

vi.mock("@/lib/server/task-fs", () => ({
  getTask,
  appendEvent,
}));

vi.mock("@/lib/server/task-stream", () => ({
  publishTaskStreamEvent,
}));

vi.mock("@/lib/server/chat-gate", () => ({
  getChatLifecycle,
}));

const {
  handleCardActionEvent,
  normalizeCardActionEvent,
  parseCardButtonValue,
  ensureCardActionHandlerRegistered,
  __resetCardActionRegistrationForTest,
} = await import("@/lib/server/feishu-bridge/card-action");

const OWNER = "ou_owner";
const OTHER = "ou_stranger";

const askValue = {
  kind: "ask" as const,
  taskId: "task-1",
  askId: "ask-1",
  questionId: "q1",
  optionId: "opt_a",
};

const pendingAsk = {
  askId: "ask-1",
  token: "tok",
  createdAt: Date.now(),
  questions: [
    {
      id: "q1",
      question: "选哪个？",
      allowText: true,
      options: [
        { id: "opt_a", label: "方案 A" },
        { id: "opt_b", label: "方案 B" },
      ],
    },
    {
      id: "q2",
      question: "第二题？",
      allowText: true,
      options: [{ id: "opt_x", label: "X" }],
    },
  ],
};

const chatTask = {
  id: "task-1",
  mode: "chat",
  events: [
    {
      id: "ev1",
      kind: "ask_user_request",
      createdAt: Date.now(),
      actionId: "act-1",
      meta: { askId: "ask-1" },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetCardActionRegistrationForTest();
  getBotAppInfo.mockResolvedValue({
    appId: "cli_x",
    ownerOpenId: OWNER,
  });
  findTaskByMessageId.mockResolvedValue({
    messageId: "om_card",
    cardId: "card_1",
    taskId: "task-1",
    createdAt: Date.now(),
  });
  getPendingAsk.mockReturnValue(pendingAsk);
  getTask.mockResolvedValue(chatTask);
  deliverChatAskReply.mockResolvedValue(true);
  loadBridgeBootContext.mockResolvedValue({
    apiKey: "key",
    model: { id: "composer-2" },
    repoPaths: [],
  });
  appendEvent.mockResolvedValue({
    id: "ev_reply",
    kind: "ask_user_reply",
    createdAt: Date.now(),
  });
  handleChatReplyInject.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  getChatLifecycle.mockReturnValue(null);
  hasChatSession.mockReturnValue(true);
});

afterEach(() => {
  __resetCardActionRegistrationForTest();
});

describe("normalize / parse helpers", () => {
  it("扁平 schema：operator_id + action_value 字符串", () => {
    const n = normalizeCardActionEvent({
      type: "card.action.trigger",
      operator_id: OWNER,
      message_id: "om_1",
      action_value: JSON.stringify(askValue),
      token: "tok_delay",
    });
    expect(n?.operatorOpenId).toBe(OWNER);
    expect(n?.messageId).toBe("om_1");
    expect(n?.token).toBe("tok_delay");
    expect(parseCardButtonValue(n!.valueRaw)).toEqual(askValue);
  });

  it("嵌套官方形态：operator.open_id + action.value 对象", () => {
    const n = normalizeCardActionEvent({
      event: {
        operator: { open_id: OWNER },
        action: { value: askValue },
        context: { open_message_id: "om_nested" },
        token: "t2",
      },
    });
    expect(n?.operatorOpenId).toBe(OWNER);
    expect(n?.messageId).toBe("om_nested");
    expect(parseCardButtonValue(n!.valueRaw)?.kind).toBe("ask");
  });

  it("非法 value 返回 null", () => {
    expect(parseCardButtonValue("not-json")).toBeNull();
    expect(parseCardButtonValue({ kind: "ask", taskId: "x" })).toBeNull();
  });
});

describe("handleCardActionEvent", () => {
  it("operator≠owner → 丢弃（不投递、不改卡）", async () => {
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      action_value: askValue,
    });
    expect(deliverChatAskReply).not.toHaveBeenCalled();
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });

  it("ask 命中：投递 + clearPending + 落事件 + 卡片置已选", async () => {
    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_card",
      action_value: JSON.stringify(askValue),
    });

    expect(deliverChatAskReply).toHaveBeenCalledTimes(1);
    const [, replyText] = deliverChatAskReply.mock.calls[0]!;
    expect(String(replyText)).toContain("[ASK_USER_REPLY]");
    expect(String(replyText)).toContain("答：方案 A");
    expect(String(replyText)).toContain("答：（未回答）");

    expect(clearPendingAsk).toHaveBeenCalledWith("task-1");
    expect(appendEvent).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        kind: "ask_user_reply",
        meta: expect.objectContaining({
          askId: "ask-1",
          source: "feishu",
        }),
      }),
    );
    expect(batchUpdateCard).toHaveBeenCalled();
    const actionsJson = JSON.stringify(batchUpdateCard.mock.calls);
    expect(actionsJson).toContain("✅ 已选：方案 A");
    expect(actionsJson).toContain("delete_elements");
  });

  it("askId 不匹配 → 失效提示 + bot 私聊，不投递", async () => {
    getPendingAsk.mockReturnValue({
      ...pendingAsk,
      askId: "ask-OTHER",
    });

    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_card",
      action_value: askValue,
    });

    expect(deliverChatAskReply).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith(
      OWNER,
      expect.stringContaining("已失效或已回答"),
    );
    expect(batchUpdateCard).toHaveBeenCalled();
    const actionsJson = JSON.stringify(batchUpdateCard.mock.calls);
    expect(actionsJson).toContain("已失效或已回答");
  });

  it("value 对象形态与字符串形态均可", async () => {
    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_card",
      action_value: askValue, // 对象
    });
    expect(deliverChatAskReply).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    getBotAppInfo.mockResolvedValue({ appId: "cli_x", ownerOpenId: OWNER });
    findTaskByMessageId.mockResolvedValue({
      messageId: "om_card",
      cardId: "card_1",
      taskId: "task-1",
      createdAt: Date.now(),
    });
    getPendingAsk.mockReturnValue(pendingAsk);
    getTask.mockResolvedValue(chatTask);
    deliverChatAskReply.mockResolvedValue(true);
    loadBridgeBootContext.mockResolvedValue({
      apiKey: "key",
      model: { id: "composer-2" },
      repoPaths: [],
    });
    appendEvent.mockResolvedValue({
      id: "ev_reply",
      kind: "ask_user_reply",
      createdAt: Date.now(),
    });

    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_card",
      action_value: JSON.stringify(askValue),
    });
    expect(deliverChatAskReply).toHaveBeenCalledTimes(1);
  });

  it("retry：重发 lastUserMessage + 按钮改已重试", async () => {
    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_card",
      action_value: {
        kind: "retry",
        taskId: "task-1",
        lastUserMessage: "上次的问题",
      },
    });

    expect(handleChatReplyInject).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        text: "上次的问题",
        bootArgs: expect.objectContaining({ apiKey: "key" }),
      }),
      expect.objectContaining({
        userReplyMetaExtra: expect.objectContaining({ source: "feishu" }),
      }),
    );
    const actionsJson = JSON.stringify(batchUpdateCard.mock.calls);
    expect(actionsJson).toContain("🔄 已重试");
  });

  it("依赖抛错不向外抛", async () => {
    getBotAppInfo.mockRejectedValue(new Error("boom"));
    await expect(
      handleCardActionEvent({
        operator_id: OWNER,
        message_id: "om_card",
        action_value: askValue,
      }),
    ).resolves.toBeUndefined();

    getBotAppInfo.mockResolvedValue({ appId: "cli_x", ownerOpenId: OWNER });
    deliverChatAskReply.mockRejectedValue(new Error("deliver boom"));
    await expect(
      handleCardActionEvent({
        operator_id: OWNER,
        message_id: "om_card",
        action_value: askValue,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("ensureCardActionHandlerRegistered", () => {
  it("globalThis 幂等只注册一次", () => {
    // beforeEach 的 reset 会调一次 register(null)，清掉再验注册次数
    vi.clearAllMocks();
    ensureCardActionHandlerRegistered();
    ensureCardActionHandlerRegistered();
    expect(registerCardActionHandler).toHaveBeenCalledTimes(1);
    expect(registerCardActionHandler).toHaveBeenCalledWith(
      handleCardActionEvent,
    );
  });
});
