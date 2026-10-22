/**
 * 群答题卡按钮：askId 必须一路带到「原子摘除」那一步（N7-a）
 *
 * 旧实现：入口 `getPendingAsk` 比对了 value.askId，随后却先 `await loadBridgeBootContext()`、
 * 再调 `injectPendingAskText(taskId, …)`——后者内部是**无条件** `takePendingAsk(taskId)`，
 * 摘的是「此刻槽位里的那组」。await 期间 agent 若登记了新一组提问（askId 不同），
 * 点旧卡的人就会把旧选项的 label 答到新提问上（私聊卡早已用 takePendingAskIf 堵过，群卡漏了）。
 *
 * 本测试用**真实** chat-pending + **真实** ask-inject（只 mock 它们的外部依赖），
 * 这样「无条件摘除」这件事是真的被执行的、不是靠 mock 假装。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getBotAppInfo,
  batchUpdateCard,
  sendTextMessage,
  sendMarkdownCardToChat,
  deliverChatAskReply,
  hasChatSession,
  getTask,
  getChatLifecycle,
  writeUserEventAndPublishStrict,
  fulfillAskWait,
  syncTaskPendingAskId,
  loadBridgeBootContext,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    getBotAppInfo: vi.fn<AnyFn>(async () => ({
      appId: "cli_x",
      ownerOpenId: "ou_owner",
    })),
    batchUpdateCard: vi.fn<AnyFn>(async () => undefined),
    sendTextMessage: vi.fn<AnyFn>(async () => ({
      chat_id: "oc",
      message_id: "om",
    })),
    sendMarkdownCardToChat: vi.fn<AnyFn>(async () => ({
      chat_id: "oc",
      message_id: "om",
    })),
    deliverChatAskReply: vi.fn<AnyFn>(async () => true),
    hasChatSession: vi.fn<AnyFn>(() => true),
    getTask: vi.fn<AnyFn>(),
    getChatLifecycle: vi.fn<AnyFn>(() => null),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(async () => ({ id: "e1" })),
    fulfillAskWait: vi.fn<AnyFn>(async () => false),
    syncTaskPendingAskId: vi.fn<AnyFn>(async () => undefined),
    loadBridgeBootContext: vi.fn<AnyFn>(async () => null),
  };
});

vi.mock("@/lib/server/ask-wait", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/server/ask-wait")>(
      "@/lib/server/ask-wait",
    );
  return { ...actual, fulfillAskWait };
});
vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({
  getBotAppInfo,
  batchUpdateCard,
  sendTextMessage,
  sendMarkdownCardToChat,
  updateCardEntity: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/chat-runner", () => ({
  deliverChatAskReply,
  hasChatSession,
}));
vi.mock("@/lib/server/task-runner", () => ({
  deliverAskReply: vi.fn(async () => "sent"),
}));
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: vi.fn(async () => []),
}));
vi.mock("@/lib/server/chat-inject", () => ({ handleChatReplyInject: vi.fn() }));
vi.mock("@/lib/server/feishu-bridge/router", () => ({
  loadBridgeBootContext,
  registerCardActionHandler: vi.fn(),
  listActiveChatTasks: vi.fn(async () => []),
}));
vi.mock("@/lib/server/feishu-bridge/bridge-state", () => ({
  setCurrentChatTaskId: vi.fn(async () => undefined),
  getCurrentChatTaskId: vi.fn(async () => ""),
  addEndedChatTaskId: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/feishu-bridge/commands", () => ({
  execNewChatNoArgs: vi.fn(),
  execCleanupCard: vi.fn(),
  execStatusText: vi.fn(),
}));
vi.mock("@/lib/server/stop-task", () => ({ stopTaskAgent: vi.fn() }));
vi.mock("@/lib/server/feishu-bridge/card-map", () => ({
  findTaskByMessageId: vi.fn(async () => ({
    messageId: "om_gcard",
    cardId: "card_g",
    taskId: "",
    createdAt: Date.now(),
  })),
  findAskCards: vi.fn(async () => []),
  rememberAskCard: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/task-fs", () => ({ getTask, syncTaskPendingAskId }));
vi.mock("@/lib/server/task-stream", () => ({
  writeUserEventAndPublishStrict,
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
  agentSessions: new Map(),
}));
vi.mock("@/lib/server/chat-gate", () => ({ getChatLifecycle }));
vi.mock("@/lib/server/feishu-bridge/group-route", () => ({
  handleGroupAdvancePick: vi.fn(),
}));

const {
  getPendingAsk,
  registerPendingAsk,
  __resetPendingAskStateForTest,
} = await import("@/lib/server/chat-pending");
const { handleCardActionEvent } = await import(
  "@/lib/server/feishu-bridge/card-action"
);
const { __resetAskCardSettleForTest } = await import(
  "@/lib/server/feishu-bridge/ask-card-settle"
);
const { __resetGroupReplyStateForTest } = await import(
  "@/lib/server/feishu-bridge/group-shared"
);

const TASK_ID = "task-1";
const GROUP_CHAT = "oc_req_group";
const OTHER = "ou_member";

const registerAsk = (
  askId: string,
  options: Array<{ id: string; label: string }> = [
    { id: "opt_a", label: "方案 A" },
    { id: "opt_b", label: "方案 B" },
  ],
): void => {
  registerPendingAsk(TASK_ID, {
    askId,
    questions: [
      { id: "q1", question: `选哪个（${askId}）？`, allowText: true, options },
    ],
  });
};

/** 点「ask-1 那张群答题卡」的选项 A */
const clickOldCard = (operator = OTHER): Promise<void> =>
  handleCardActionEvent({
    operator_id: operator,
    message_id: "om_gcard",
    chat_id: GROUP_CHAT,
    action_value: {
      kind: "group_ask",
      taskId: TASK_ID,
      askId: "ask-1",
      questionId: "q1",
      optionId: "opt_a",
      chatId: GROUP_CHAT,
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  __resetPendingAskStateForTest();
  __resetAskCardSettleForTest();
  __resetGroupReplyStateForTest();
  getBotAppInfo.mockResolvedValue({ appId: "cli_x", ownerOpenId: "ou_owner" });
  getTask.mockResolvedValue({ id: TASK_ID, mode: "chat", events: [] });
  deliverChatAskReply.mockResolvedValue(true);
  hasChatSession.mockReturnValue(true);
  getChatLifecycle.mockReturnValue(null);
  fulfillAskWait.mockResolvedValue(false);
  writeUserEventAndPublishStrict.mockResolvedValue({ id: "e1" });
  loadBridgeBootContext.mockResolvedValue(null);
});

afterEach(() => {
  __resetPendingAskStateForTest();
  __resetAskCardSettleForTest();
  __resetGroupReplyStateForTest();
});

describe("群答题卡按钮：askId 一路带到原子摘除", () => {
  it("卡片 value 带 askId（N7-a 字面指控「缺 askId」不成立）：解析必须要求 askId 字段齐全", async () => {
    const { parseCardButtonValue } = await import(
      "@/lib/server/feishu-bridge/card-action"
    );
    const { buildGroupAskCardJson } = await import(
      "@/lib/server/feishu-bridge/group-ask-card"
    );
    const card = buildGroupAskCardJson({
      requirementName: "需求",
      taskId: TASK_ID,
      chatId: GROUP_CHAT,
      askId: "ask-1",
      questions: [
        {
          id: "q1",
          question: "选哪个？",
          options: [{ id: "opt_a", label: "方案 A" }],
        },
      ],
      senderName: "张三",
    });
    // 真实构造器产物里每个按钮的 value 都带 askId，且 parse 回来不丢
    const buttons = (
      card.body as {
        elements: Array<{
          tag: string;
          behaviors?: Array<{ value: unknown }>;
        }>;
      }
    ).elements.filter((e) => e.tag === "button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      const parsed = parseCardButtonValue(b.behaviors![0]!.value);
      expect(parsed).toMatchObject({ kind: "group_ask", askId: "ask-1" });
    }
    expect(
      parseCardButtonValue({
        kind: "group_ask",
        taskId: TASK_ID,
        questionId: "q1",
        optionId: "opt_a",
        chatId: GROUP_CHAT,
      }),
    ).toBeNull();
  });

  it("正常路径：当前 pending 就是卡上那组 → 投递一次、摘空槽位", async () => {
    registerAsk("ask-1");
    await clickOldCard();
    expect(deliverChatAskReply).toHaveBeenCalledTimes(1);
    const text = String(
      (deliverChatAskReply.mock.calls[0] as unknown[])[1],
    );
    expect(text).toContain("方案 A");
    expect(getPendingAsk(TASK_ID)).toBeNull();
  });

  it("入口比对 askId 之后、摘除之前 agent 登记了新提问 → 旧卡点击作废，不许答到新提问上", async () => {
    registerAsk("ask-1");
    // 卡住 boot 上下文加载：旧实现的 await 窗口就在这里
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    loadBridgeBootContext.mockImplementation(async () => {
      await gate;
      return null;
    });

    const click = clickOldCard();
    await new Promise((r) => setTimeout(r, 10));
    // 窗口内：用户在 app 里答完 ask-1（事件流里落了 ask_user_reply），agent 马上抛出新一组提问 ask-2
    getTask.mockResolvedValue({
      id: TASK_ID,
      mode: "chat",
      events: [
        {
          id: "ev_reply",
          kind: "ask_user_reply",
          ts: Date.now(),
          text: "",
          meta: { askId: "ask-1" },
        },
      ],
    });
    registerAsk("ask-2", [{ id: "opt_x", label: "完全不同的选项" }]);
    release?.();
    await click;

    // ask-2 没被旧卡的点击碰：没投递、没落事件、槽位原样
    expect(deliverChatAskReply).not.toHaveBeenCalled();
    expect(writeUserEventAndPublishStrict).not.toHaveBeenCalled();
    expect(getPendingAsk(TASK_ID)?.askId).toBe("ask-2");
    // 点击人拿到的是「已经有人回答了」的失效反馈（事件流里确有 ask_user_reply）
    expect(sendMarkdownCardToChat).toHaveBeenCalledTimes(1);
    expect(String(sendMarkdownCardToChat.mock.calls[0]![1])).toContain(
      "已经有人回答了",
    );
  });

  it("同样的窗口、但 ask-1 其实是被取消（没人答过）→ 不许说「已经有人回答了」", async () => {
    registerAsk("ask-1");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    loadBridgeBootContext.mockImplementation(async () => {
      await gate;
      return null;
    });

    const click = clickOldCard();
    await new Promise((r) => setTimeout(r, 10));
    // 窗口内：ask-1 被作废（事件流里只有作废标记、没有回复），agent 抛出新提问 ask-2
    getTask.mockResolvedValue({
      id: TASK_ID,
      mode: "chat",
      events: [
        {
          id: "ev_void",
          kind: "info",
          ts: Date.now(),
          text: "",
          meta: { supersededAskId: "ask-1" },
        },
      ],
    });
    registerAsk("ask-2", [{ id: "opt_x", label: "完全不同的选项" }]);
    release?.();
    await click;

    expect(deliverChatAskReply).not.toHaveBeenCalled();
    expect(getPendingAsk(TASK_ID)?.askId).toBe("ask-2");
    expect(sendMarkdownCardToChat).toHaveBeenCalledTimes(1);
    const text = String(sendMarkdownCardToChat.mock.calls[0]![1]);
    expect(text).not.toContain("有人回答");
    expect(text).toContain("已失效");
  });

  // 行为测试只能证明「此刻没有窗口」；这条把不变量本身钉住：以后谁在比对与摘除之间
  // 再塞一个 await，竞态就悄悄回来了（行为测试里的 await 点是人为卡住的、不一定覆盖新增的）
  it("契约：群分支里 askId 比对 → injectPendingAskText 之间零 await，且 boot 上下文先于比对加载", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../src/lib/server/feishu-bridge/card-action.ts",
      ),
      "utf8",
    );
    const fnStart = src.indexOf("const handleGroupAskAction = async");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const fn = src.slice(fnStart, src.indexOf("\n};", fnStart));
    // 带窗口任务取 boot（review F2-01）：getTask 与 loadBridgeBootContext 都在比对之前
    const boot = fn.indexOf("await loadBridgeBootContext(askTask");
    const cmp = fn.indexOf("const pending = getPendingAsk(value.taskId);");
    const inject = fn.indexOf("await injectPendingAskText(");
    expect(boot).toBeGreaterThanOrEqual(0);
    expect(cmp).toBeGreaterThan(boot);
    expect(inject).toBeGreaterThan(cmp);
    // 失效分支（直接 return、里面有 await 无妨）之后到 inject 之前：不得再有 await
    const afterStale = fn.indexOf("const q = pending.questions.find", cmp);
    expect(afterStale).toBeGreaterThan(cmp);
    expect(fn.slice(afterStale, inject)).not.toMatch(/\bawait\b/);
  });

  it("两个群成员几乎同时点同一张卡：只投一份，后到的拿失效反馈", async () => {
    registerAsk("ask-1");
    const a = clickOldCard("ou_a");
    const b = clickOldCard("ou_b");
    await Promise.all([a, b]);
    expect(deliverChatAskReply).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardToChat).toHaveBeenCalledTimes(1);
    expect(getPendingAsk(TASK_ID)).toBeNull();
  });
});
