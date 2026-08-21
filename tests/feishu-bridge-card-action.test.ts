/**
 * card-action：按钮回调闭环（身份校验 / value 双形态 / ask 投递 / 失效 / retry / 异常不抛）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getBotAppInfo,
  batchUpdateCard,
  sendTextMessage,
  sendTextMessageToChat,
  updateCardEntity,
  getPendingAsk,
  clearPendingAsk,
  deliverChatAskReply,
  hasChatSession,
  handleChatReplyInject,
  loadBridgeBootContext,
  listActiveChatTasks,
  findTaskByMessageId,
  findAskCards,
  rememberAskCard,
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
  injectPendingAskText,
  handleGroupAdvancePick,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    getBotAppInfo: vi.fn<AnyFn>(),
    batchUpdateCard: vi.fn<AnyFn>(async () => undefined),
    sendTextMessage: vi.fn<AnyFn>(async () => ({
      chat_id: "oc",
      message_id: "om",
    })),
    sendTextMessageToChat: vi.fn<AnyFn>(async () => ({
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
    findAskCards: vi.fn<AnyFn>(async () => []),
    rememberAskCard: vi.fn<AnyFn>(async () => undefined),
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
    injectPendingAskText: vi.fn<AnyFn>(async () => ({ ok: true })),
    handleGroupAdvancePick: vi.fn<AnyFn>(async () => undefined),
  };
});

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({
  getBotAppInfo,
  batchUpdateCard,
  sendTextMessage,
  sendTextMessageToChat,
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
  // ask 索引：答完 / 跳过时 ask-card-settle 按 (taskId, askId) 反查所有承载卡
  findAskCards,
  rememberAskCard,
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

// 群答题走动态 import（card-action 按需加载、避开 task-runner 静态边）——
// vi.mock 同样拦得住动态 import
vi.mock("@/lib/server/feishu-bridge/ask-inject", () => ({
  injectPendingAskText,
}));

// 推进选择卡按钮同样走动态 import（group-route 静态挂着 task-runner）——只验分发
vi.mock("@/lib/server/feishu-bridge/group-route", () => ({
  handleGroupAdvancePick,
}));

const {
  handleCardActionEvent,
  normalizeCardActionEvent,
  parseCardButtonValue,
  ensureCardActionHandlerRegistered,
  __resetCardActionRegistrationForTest,
} = await import("@/lib/server/feishu-bridge/card-action");

// 回群登记表跑真实实现（纯内存、无外部调用）——群答题答完要不要回群靠它断言
const {
  __resetGroupReplyStateForTest,
  listGroupReplies,
  rememberGroupReply,
} = await import("@/lib/server/feishu-bridge/group-shared");

// 卡片终态置态跑真实实现（只有 batchUpdateCard 是 mock 的）——占坑表跨用例要重置
const { __resetAskCardSettleForTest } = await import(
  "@/lib/server/feishu-bridge/ask-card-settle"
);

const OWNER = "ou_owner";
const OTHER = "ou_stranger";

const askValue = {
  kind: "ask" as const,
  taskId: "task-1",
  askId: "ask-1",
  questionId: "q1",
  optionId: "opt_a",
};

/** 需求群答题卡按钮 value（比 ask 多一个回群用的 chatId） */
const groupAskValue = {
  kind: "group_ask" as const,
  taskId: "task-1",
  askId: "ask-1",
  questionId: "q1",
  optionId: "opt_a",
  chatId: "oc_req_group",
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
  __resetGroupReplyStateForTest();
  __resetAskCardSettleForTest();
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
  // 这组 ask 挂在一张卡上（p2p 流式卡）——置终态时按 (taskId, askId) 反查得到它
  findAskCards.mockResolvedValue([
    {
      messageId: "om_card",
      cardId: "card_1",
      taskId: "task-1",
      createdAt: Date.now(),
      askTaskId: "task-1",
      askId: "ask-1",
    },
  ]);
  getPendingAsk.mockReturnValue(pendingAsk);
  getTask.mockResolvedValue(chatTask);
  deliverChatAskReply.mockResolvedValue(true);
  loadBridgeBootContext.mockResolvedValue({
    apiKey: "key",
    model: { id: "composer-2" },
    provider: "cursor",
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
  injectPendingAskText.mockResolvedValue({ ok: true });
});

afterEach(() => {
  __resetCardActionRegistrationForTest();
  __resetGroupReplyStateForTest();
  __resetAskCardSettleForTest();
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

  // 来源 chat 是群卡片的唯一「谁能点」依据：取值链漏一层就退回 owner 闸、
  // 群里除属主外全员哑火（跨角色答题 / 群推进都白瞎）
  it.each([
    ["扁平 chat_id", { chat_id: "oc_flat" }, "oc_flat"],
    ["扁平 open_chat_id", { open_chat_id: "oc_flat_open" }, "oc_flat_open"],
    ["嵌套 event.chat_id", { event: { chat_id: "oc_nested" } }, "oc_nested"],
    [
      "嵌套 event.open_chat_id",
      { event: { open_chat_id: "oc_nested_open" } },
      "oc_nested_open",
    ],
    [
      "官方 event.context.open_chat_id",
      { event: { context: { open_chat_id: "oc_ctx" } } },
      "oc_ctx",
    ],
  ])("来源 chat 取值链：%s", (_name, extra, expected) => {
    const n = normalizeCardActionEvent({
      operator_id: OWNER,
      message_id: "om_1",
      action_value: JSON.stringify(askValue),
      ...(extra as Record<string, unknown>),
    });
    expect(n?.chatId).toBe(expected);
  });

  it("来源 chat 全缺 → undefined（调用方据此退回 owner 闸）", () => {
    const n = normalizeCardActionEvent({
      operator_id: OWNER,
      message_id: "om_1",
      action_value: JSON.stringify(askValue),
    });
    expect(n?.chatId).toBeUndefined();
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

  it("group_ask：字段齐才认（缺 chatId 判非法）", () => {
    expect(parseCardButtonValue(groupAskValue)).toEqual(groupAskValue);
    expect(
      parseCardButtonValue({ ...groupAskValue, chatId: undefined }),
    ).toBeNull();
  });

  it("group_advance：字段齐才认（缺 pickId / actionKey 判非法）、label 可选", () => {
    const full = {
      kind: "group_advance" as const,
      taskId: "task-1",
      chatId: "oc_req_group",
      pickId: "pick-1",
      actionKey: "app:weekly-report",
      label: "周报生成",
    };
    expect(parseCardButtonValue(full)).toEqual(full);
    const noLabel = {
      kind: full.kind,
      taskId: full.taskId,
      chatId: full.chatId,
      pickId: full.pickId,
      actionKey: full.actionKey,
    };
    expect(parseCardButtonValue(noLabel)).toEqual(noLabel);
    expect(
      parseCardButtonValue({ ...full, pickId: undefined }),
    ).toBeNull();
    expect(
      parseCardButtonValue({ ...full, actionKey: undefined }),
    ).toBeNull();
  });
});

// 需求群答题卡：群里任何人都能答（跨角色）——不过 owner 闸、先到先得
describe("group_ask（需求群答题）", () => {
  it("非 owner 在卡片所在群点选项 → 受理（不过 owner 闸）、答案标群来源", async () => {
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      chat_id: groupAskValue.chatId,
      action_value: JSON.stringify(groupAskValue),
    });
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
    const call = injectPendingAskText.mock.calls[0]! as unknown[];
    expect(call[0]).toBe("task-1");
    expect(call[1]).toBe("方案 A");
    // 卡片回调事件只有 open_id、换不出姓名（要通讯录权限）→ 记泛称
    expect(call[4]).toMatchObject({ answeredBy: "群成员" });
    // 卡片置态**不在这里做**：injectPendingAskText 送达成功后统一置（群里打字作答走的
    // 也是它）——同一件事只留一个收口点，两个入口结果一致
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });

  it("先到先得：已被答掉（无 pending）→ 不投递、群里回「已经有人回答了」", async () => {
    getPendingAsk.mockReturnValue(null);
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      chat_id: groupAskValue.chatId,
      action_value: JSON.stringify(groupAskValue),
    });
    expect(injectPendingAskText).not.toHaveBeenCalled();
    expect(sendTextMessageToChat).toHaveBeenCalledTimes(1);
    expect(String(sendTextMessageToChat.mock.calls[0]![1])).toContain(
      "已经有人回答了",
    );
  });

  it("askId 对不上（新一组提问顶掉旧的）→ 同样按已失效处理", async () => {
    getPendingAsk.mockReturnValue({ ...pendingAsk, askId: "ask-2" });
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      chat_id: groupAskValue.chatId,
      action_value: JSON.stringify(groupAskValue),
    });
    expect(injectPendingAskText).not.toHaveBeenCalled();
    expect(sendTextMessageToChat).toHaveBeenCalledTimes(1);
  });

  // 官方嵌套形态只在 event.context 里给来源 chat——取值链漏了它，跨角色答题
  // 会被降级成 owner-only、群里其他人点了没反应
  it("官方嵌套形态（event.context.open_chat_id）也认得出来源群 → 非 owner 照样受理", async () => {
    await handleCardActionEvent({
      event: {
        operator: { open_id: OTHER },
        action: { value: groupAskValue },
        context: {
          open_message_id: "om_card",
          open_chat_id: groupAskValue.chatId,
        },
      },
    });
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
  });

  // 卡片能被转发：不校来源的话，任何拿到转发卡的人都能替属主把这组问题答掉
  it("卡片被转发到别的会话、在那边点 → 丢弃（不投递、不回群）", async () => {
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      chat_id: "oc_somewhere_else",
      action_value: JSON.stringify(groupAskValue),
    });
    expect(injectPendingAskText).not.toHaveBeenCalled();
    expect(sendTextMessageToChat).not.toHaveBeenCalled();
  });

  it("事件没给来源 chat → 退回 owner 闸：非 owner 丢弃、owner 放行", async () => {
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      action_value: JSON.stringify(groupAskValue),
    });
    expect(injectPendingAskText).not.toHaveBeenCalled();

    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_card",
      action_value: JSON.stringify(groupAskValue),
    });
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
  });

  // 第五轮双审 P2-1：群里**打字**作答会把 agent 这轮的答复 @ 回群、**点按钮**却
  // 全程不登记——同一件事两种入口两种结果，点完按钮的同事就此没了下文
  it("答完登记回群（@ 点按钮的人、走属主通道）", async () => {
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      chat_id: groupAskValue.chatId,
      action_value: JSON.stringify(groupAskValue),
    });
    expect(listGroupReplies("task-1")).toEqual([
      expect.objectContaining({
        chatId: groupAskValue.chatId,
        requesterOpenId: OTHER,
        requesterName: "群成员",
        kind: "question",
        runTag: null,
      }),
    ]);
  });

  it("答案没送达 → 回滚登记（别挂着让下一轮无关 done 误发进群）", async () => {
    injectPendingAskText.mockResolvedValue({
      ok: false,
      reason: "deliver_failed",
      error: "会话忙",
    });
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      chat_id: groupAskValue.chatId,
      action_value: JSON.stringify(groupAskValue),
    });
    expect(String(sendTextMessageToChat.mock.calls[0]![1])).toContain(
      "答案没送达",
    );
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  // 群内推进跑到一半 agent 调 ask_user：这条答案属于同一轮推进，
  // 顶掉推进登记就是拿一句旁白换掉整份产物卡
  it("推进登记在飞时不另开登记（产物卡才是群里要的结果）", async () => {
    const advance = rememberGroupReply("task-1", {
      chatId: groupAskValue.chatId,
      requesterOpenId: OWNER,
      requesterName: "张三",
      kind: "advance",
      actionId: "act-9",
      channel: "owner",
    })!;
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      chat_id: groupAskValue.chatId,
      action_value: JSON.stringify(groupAskValue),
    });
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
    expect(listGroupReplies("task-1").map((e) => e.token)).toEqual([
      advance.token,
    ]);
  });
});

// 需求群推进选择卡：属主闸在 group-route 内做（非属主要回群提示）——
// card-action 侧只验「先于 owner 闸分发、value + operator 原样透传」
describe("group_advance（推进选择卡）分发", () => {
  const groupAdvanceValue = {
    kind: "group_advance" as const,
    taskId: "task-1",
    chatId: "oc_req_group",
    pickId: "pick-1",
    actionKey: "review",
    label: "复核",
  };

  it("非 owner 在卡片所在群点按钮 → 仍分发到 group-route（那边回群拒绝、不是这里静默丢）", async () => {
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      chat_id: groupAdvanceValue.chatId,
      action_value: JSON.stringify(groupAdvanceValue),
    });
    expect(handleGroupAdvancePick).toHaveBeenCalledTimes(1);
    const call = handleGroupAdvancePick.mock.calls[0]! as unknown[];
    expect(call[0]).toEqual(groupAdvanceValue);
    expect(call[1]).toBe(OTHER);
  });

  it("owner 点按钮 → 分发并带 bootContext 加载器", async () => {
    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_card",
      chat_id: groupAdvanceValue.chatId,
      action_value: groupAdvanceValue,
    });
    expect(handleGroupAdvancePick).toHaveBeenCalledTimes(1);
    const call = handleGroupAdvancePick.mock.calls[0]! as unknown[];
    expect(call[1]).toBe(OWNER);
    // 第三参是 loadBootContext 惰性加载器——调用后透传 router 的 boot 上下文
    const loader = call[2] as () => Promise<unknown>;
    await expect(loader()).resolves.toMatchObject({ apiKey: "key" });
  });

  // 推进卡的回执 / 拒绝提示都发往 value.chatId（出卡时写死的那个需求群）——
  // 转发出去点一下就是往无关群里丢消息，同 group_ask 一条口径
  it("卡片被转发到别的会话、在那边点 → 丢弃（不分发）", async () => {
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      chat_id: "oc_somewhere_else",
      action_value: JSON.stringify(groupAdvanceValue),
    });
    expect(handleGroupAdvancePick).not.toHaveBeenCalled();
  });

  it("事件没给来源 chat → 退回 owner 闸：非 owner 丢弃、owner 放行", async () => {
    await handleCardActionEvent({
      operator_id: OTHER,
      message_id: "om_card",
      action_value: JSON.stringify(groupAdvanceValue),
    });
    expect(handleGroupAdvancePick).not.toHaveBeenCalled();

    await handleCardActionEvent({
      operator_id: OWNER,
      message_id: "om_card",
      action_value: JSON.stringify(groupAdvanceValue),
    });
    expect(handleGroupAdvancePick).toHaveBeenCalledTimes(1);
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
      provider: "cursor",
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
