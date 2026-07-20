/**
 * card-action：按钮回调闭环（身份校验 / value 双形态 / ask 投递 / 失效 / retry / 异常不抛）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getBotAppInfo,
  batchUpdateCard,
  sendTextMessage,
  updateCardEntity,
  getPendingAsk,
  clearPendingAsk,
  deliverChatAskReply,
  hasChatSession,
  handleChatReplyInject,
  loadBridgeBootContext,
  listActiveChatTasks,
  findTaskByMessageId,
  getTask,
  stopTaskAgent,
  writeUserEventAndPublishStrict,
  getChatLifecycle,
  registerCardActionHandler,
  setCurrentChatTaskId,
  getCurrentChatTaskId,
  addEndedChatTaskId,
  execNewChatNoArgs,
  execCleanupCard,
  execStatusText,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    getBotAppInfo: vi.fn<AnyFn>(),
    batchUpdateCard: vi.fn<AnyFn>(async () => undefined),
    sendTextMessage: vi.fn<AnyFn>(async () => ({
      chat_id: "oc",
      message_id: "om",
    })),
    updateCardEntity: vi.fn<AnyFn>(async () => undefined),
    getPendingAsk: vi.fn<AnyFn>(),
    clearPendingAsk: vi.fn<AnyFn>(),
    deliverChatAskReply: vi.fn<AnyFn>(),
    hasChatSession: vi.fn<AnyFn>(() => true),
    handleChatReplyInject: vi.fn<AnyFn>(),
    loadBridgeBootContext: vi.fn<AnyFn>(),
    listActiveChatTasks: vi.fn<AnyFn>(async () => []),
    findTaskByMessageId: vi.fn<AnyFn>(),
    getTask: vi.fn<AnyFn>(),
    stopTaskAgent: vi.fn<AnyFn>(async () => undefined),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(),
    getChatLifecycle: vi.fn<AnyFn>(() => null),
    registerCardActionHandler: vi.fn<AnyFn>(),
    setCurrentChatTaskId: vi.fn<AnyFn>(async () => undefined),
    getCurrentChatTaskId: vi.fn<AnyFn>(async () => ""),
    addEndedChatTaskId: vi.fn<AnyFn>(async () => undefined),
    execNewChatNoArgs: vi.fn<AnyFn>(async () => "handled"),
    execCleanupCard: vi.fn<AnyFn>(async () => "handled"),
    execStatusText: vi.fn<AnyFn>(async () => "handled"),
  };
});

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({
  getBotAppInfo,
  batchUpdateCard,
  sendTextMessage,
  updateCardEntity,
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
  listActiveChatTasks,
}));

vi.mock("@/lib/server/feishu-bridge/bridge-state", () => ({
  setCurrentChatTaskId,
  getCurrentChatTaskId,
  addEndedChatTaskId,
}));

// 面板按钮 cmd 分发目标（commands 的共用执行体）——只验分发、不跑真实流程
vi.mock("@/lib/server/feishu-bridge/commands", () => ({
  execNewChatNoArgs,
  execCleanupCard,
  execStatusText,
}));

vi.mock("@/lib/server/stop-task", () => ({
  stopTaskAgent,
}));

vi.mock("@/lib/server/feishu-bridge/card-map", () => ({
  findTaskByMessageId,
}));

vi.mock("@/lib/server/task-fs", () => ({
  getTask,
}));

vi.mock("@/lib/server/task-stream", () => ({
  writeUserEventAndPublishStrict,
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
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
  writeUserEventAndPublishStrict.mockResolvedValue({
    id: "ev_reply",
    kind: "ask_user_reply",
    createdAt: Date.now(),
  });
  handleChatReplyInject.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  getChatLifecycle.mockReturnValue(null);
  hasChatSession.mockReturnValue(true);
  listActiveChatTasks.mockResolvedValue([]);
  getCurrentChatTaskId.mockResolvedValue("");
  setCurrentChatTaskId.mockResolvedValue(undefined);
  addEndedChatTaskId.mockResolvedValue(undefined);
  stopTaskAgent.mockResolvedValue(undefined);
  updateCardEntity.mockResolvedValue(undefined);
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

  it("end_chat / end_all / cmd 三类新 value 解析", () => {
    expect(
      parseCardButtonValue({ kind: "end_chat", taskId: "task-9" }),
    ).toEqual({ kind: "end_chat", taskId: "task-9" });
    expect(parseCardButtonValue({ kind: "end_chat" })).toBeNull();
    expect(parseCardButtonValue({ kind: "end_all" })).toEqual({
      kind: "end_all",
    });
    expect(parseCardButtonValue({ kind: "cmd", command: "clean" })).toEqual({
      kind: "cmd",
      command: "clean",
    });
    expect(parseCardButtonValue({ kind: "cmd", command: "hack" })).toBeNull();
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
    expect(writeUserEventAndPublishStrict).toHaveBeenCalledWith(
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
    expect(actionsJson).toContain("已选择：方案 A");
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
    writeUserEventAndPublishStrict.mockResolvedValue({
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

describe("清理卡 / 控制面板按钮", () => {
  /** 清理卡在 card-map 里的条目：taskId 空串（不参与锚定）、只供反查 cardId */
  const cleanupCardEntry = {
    messageId: "om_cleanup",
    cardId: "card_cleanup",
    taskId: "",
    createdAt: Date.now(),
  };

  it("end_chat：停运行 + 出局 + 清指针 + patch 行「已结束」", async () => {
    getTask.mockResolvedValue({
      id: "task-9",
      mode: "chat",
      title: "要结束的对话",
      runStatus: "running",
      events: [],
    });
    // 指针正指向被结束的对话 → 应清空
    getCurrentChatTaskId.mockResolvedValue("task-9");
    findTaskByMessageId.mockResolvedValue(cleanupCardEntry);

    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_cleanup",
      action_value: { kind: "end_chat", taskId: "task-9" },
    });

    expect(stopTaskAgent).toHaveBeenCalledTimes(1);
    expect(addEndedChatTaskId).toHaveBeenCalledWith("task-9");
    expect(setCurrentChatTaskId).toHaveBeenCalledWith("");
    const actionsJson = JSON.stringify(batchUpdateCard.mock.calls);
    expect(actionsJson).toContain("已结束：要结束的对话");
    expect(actionsJson).toContain("delete_elements");
  });

  it("end_chat 空闲对话：不停运行、仍出局；指针指向别处不清", async () => {
    getTask.mockResolvedValue({
      id: "task-9",
      mode: "chat",
      title: "空闲对话",
      runStatus: "idle",
      events: [],
    });
    getCurrentChatTaskId.mockResolvedValue("task-other");
    findTaskByMessageId.mockResolvedValue(cleanupCardEntry);

    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_cleanup",
      action_value: { kind: "end_chat", taskId: "task-9" },
    });

    expect(stopTaskAgent).not.toHaveBeenCalled();
    expect(addEndedChatTaskId).toHaveBeenCalledWith("task-9");
    expect(setCurrentChatTaskId).not.toHaveBeenCalled();
  });

  it("end_all：点击时重算活跃、逐个出局、整卡换「已全部结束（N 个）」", async () => {
    listActiveChatTasks.mockResolvedValue([
      { id: "task-a", title: "A", runStatus: "idle" },
      { id: "task-b", title: "B", runStatus: "running" },
    ]);
    getTask.mockImplementation(async (id: unknown) => ({
      id,
      mode: "chat",
      title: String(id).toUpperCase(),
      runStatus: id === "task-b" ? "running" : "idle",
      events: [],
    }));
    findTaskByMessageId.mockResolvedValue(cleanupCardEntry);

    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_cleanup",
      action_value: { kind: "end_all" },
    });

    expect(addEndedChatTaskId).toHaveBeenCalledWith("task-a");
    expect(addEndedChatTaskId).toHaveBeenCalledWith("task-b");
    // 只有 running 的 B 需要停
    expect(stopTaskAgent).toHaveBeenCalledTimes(1);
    expect(updateCardEntity).toHaveBeenCalledTimes(1);
    const cardJson = JSON.stringify(updateCardEntity.mock.calls);
    expect(cardJson).toContain("已全部结束（2 个）");
  });

  it("cmd 三连：new / clean / status 分发到对应命令流程", async () => {
    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_panel",
      action_value: { kind: "cmd", command: "new" },
    });
    expect(execNewChatNoArgs).toHaveBeenCalledTimes(1);

    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_panel",
      action_value: { kind: "cmd", command: "clean" },
    });
    expect(execCleanupCard).toHaveBeenCalledTimes(1);

    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_panel",
      action_value: { kind: "cmd", command: "status" },
    });
    expect(execStatusText).toHaveBeenCalledTimes(1);
  });

  it("cmd 按钮非本人点击 → 丢弃不分发", async () => {
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_panel",
      action_value: { kind: "cmd", command: "new" },
    });
    expect(execNewChatNoArgs).not.toHaveBeenCalled();
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
