/**
 * card-action 私聊 ask 按钮：先摘再投（R3-01）
 *
 * 旧实现 `getPendingAsk → (await deliver) → clearPendingAsk`：网页回复 / 飞书另一次点击
 * 几乎同时答同一个 ask，两边都读到 pending、都投递 → agent 收到两份 [ASK_USER_REPLY]。
 * 修法：入口按 askId+token 原子摘除，摘不到的那边彻底放手。
 *
 * chat-pending 用真实实现（测的就是它的 take / 条件 restore 语义），外部调用全 mock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getBotAppInfo,
  batchUpdateCard,
  sendTextMessage,
  deliverChatAskReply,
  hasChatSession,
  getTask,
  getChatLifecycle,
  writeUserEventAndPublishStrict,
  fulfillAskWait,
  syncTaskPendingAskId,
  supersedePendingAsks,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    supersedePendingAsks: vi.fn<AnyFn>(async () => []),
    getBotAppInfo: vi.fn<AnyFn>(async () => ({
      appId: "cli_x",
      ownerOpenId: "ou_owner",
    })),
    batchUpdateCard: vi.fn<AnyFn>(async () => undefined),
    sendTextMessage: vi.fn<AnyFn>(async () => ({
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
  sendTextMessageToChat: vi.fn(async () => ({})),
  updateCardEntity: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/chat-runner", () => ({
  deliverChatAskReply,
  hasChatSession,
}));
vi.mock("@/lib/server/chat-inject", () => ({ handleChatReplyInject: vi.fn() }));
vi.mock("@/lib/server/feishu-bridge/router", () => ({
  loadBridgeBootContext: vi.fn(async () => null),
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
    messageId: "om_card",
    cardId: "card_1",
    taskId: "task-1",
    createdAt: Date.now(),
  })),
  findAskCards: vi.fn(async () => []),
  rememberAskCard: vi.fn(async () => undefined),
}));
// chat-pending 的 meta 同步走动态 import("./task-fs")——一并 mock
vi.mock("@/lib/server/task-fs", () => ({ getTask, syncTaskPendingAskId }));
vi.mock("@/lib/server/task-stream", () => ({
  writeUserEventAndPublishStrict,
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
}));
vi.mock("@/lib/server/chat-gate", () => ({ getChatLifecycle }));
// F3-02：会话已死时要写作废标记——这里只验「调没调、带什么 lease」，真实落盘 + 置卡见
// tests/ask-inject-dead-session-void.test.ts（同一个 supersedePendingAsks 收口）
vi.mock("@/lib/server/ask-supersede", () => ({ supersedePendingAsks }));
vi.mock("@/lib/server/feishu-bridge/ask-inject", () => ({
  injectPendingAskText: vi.fn(),
}));
vi.mock("@/lib/server/feishu-bridge/group-route", () => ({
  handleGroupAdvancePick: vi.fn(),
}));

const {
  getPendingAsk,
  registerPendingAsk,
  takePendingAskIf,
  __resetPendingAskStateForTest,
} = await import("@/lib/server/chat-pending");
const { handleCardActionEvent } = await import(
  "@/lib/server/feishu-bridge/card-action"
);
const { __resetAskCardSettleForTest } = await import(
  "@/lib/server/feishu-bridge/ask-card-settle"
);

const OWNER = "ou_owner";
const TASK_ID = "task-1";

const askValue = {
  kind: "ask" as const,
  taskId: TASK_ID,
  askId: "ask-1",
  questionId: "q1",
  optionId: "opt_a",
};

const registerAsk = (askId = "ask-1"): void => {
  registerPendingAsk(TASK_ID, {
    askId,
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
    ],
  });
};

const click = (): Promise<void> =>
  handleCardActionEvent({
    operator_id: OWNER,
    message_id: "om_card",
    action_value: askValue,
  });

beforeEach(() => {
  vi.clearAllMocks();
  __resetPendingAskStateForTest();
  __resetAskCardSettleForTest();
  getBotAppInfo.mockResolvedValue({ appId: "cli_x", ownerOpenId: OWNER });
  getTask.mockResolvedValue({ id: TASK_ID, mode: "chat", events: [] });
  deliverChatAskReply.mockResolvedValue(true);
  hasChatSession.mockReturnValue(true);
  getChatLifecycle.mockReturnValue(null);
  fulfillAskWait.mockResolvedValue(false);
  writeUserEventAndPublishStrict.mockResolvedValue({ id: "e1" });
});

afterEach(() => {
  __resetPendingAskStateForTest();
  __resetAskCardSettleForTest();
});

describe("私聊 ask 卡按钮：并发只投一次", () => {
  it("飞书同一按钮并发点两次：只投递一份答案，后到的拿失效反馈", async () => {
    registerAsk();
    // deliver 卡住 = 拉开旧实现 get→deliver→clear 的窗口
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    deliverChatAskReply.mockImplementation(async () => {
      await gate;
      return true;
    });

    const first = click();
    const second = click();
    // 让两条链都推进到各自的 await 点后再放行
    await new Promise((r) => setTimeout(r, 10));
    release?.();
    await Promise.all([first, second]);

    expect(deliverChatAskReply).toHaveBeenCalledTimes(1);
    expect(writeUserEventAndPublishStrict).toHaveBeenCalledTimes(1);
    expect(getPendingAsk(TASK_ID)).toBeNull();
    expect(sendTextMessage).toHaveBeenCalledWith(
      OWNER,
      expect.stringContaining("已失效或已回答"),
    );
  });

  it("网页先摘走（app 答题）→ 飞书点击读到 pending 之后才摘：不投递、不落事件", async () => {
    registerAsk();
    // 卡住 getTask：飞书链已经读到 pending、停在 await 上，此时网页链完成摘除
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    getTask.mockImplementation(async () => {
      await gate;
      return { id: TASK_ID, mode: "chat", events: [] };
    });

    const feishu = click();
    await new Promise((r) => setTimeout(r, 10));
    const pending = getPendingAsk(TASK_ID);
    expect(pending).not.toBeNull();
    // 网页 ask-reply 路由的认领口
    expect(takePendingAskIf(TASK_ID, "ask-1", pending!.token)).not.toBeNull();
    release?.();
    await feishu;

    expect(deliverChatAskReply).not.toHaveBeenCalled();
    expect(fulfillAskWait).not.toHaveBeenCalled();
    expect(writeUserEventAndPublishStrict).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith(
      OWNER,
      expect.stringContaining("已失效或已回答"),
    );
  });

  it("投递失败 + 会话还活着 → 放回，可以再点一次", async () => {
    registerAsk();
    deliverChatAskReply.mockResolvedValueOnce(false);

    await click();
    expect(getPendingAsk(TASK_ID)?.askId).toBe("ask-1");

    await click();
    expect(deliverChatAskReply).toHaveBeenCalledTimes(2);
    expect(getPendingAsk(TASK_ID)).toBeNull();
  });

  it("投递失败 + 会话已死 → 不放回", async () => {
    registerAsk();
    deliverChatAskReply.mockResolvedValue(false);
    hasChatSession.mockReturnValue(false);

    await click();

    expect(getPendingAsk(TASK_ID)).toBeNull();
  });

  it("F3-02 投递失败 + 会话已死 → 写作废标记（卡置「已失效」靠它），lease 在会话复活后放手", async () => {
    registerAsk();
    deliverChatAskReply.mockResolvedValue(false);
    hasChatSession.mockReturnValue(false);

    await click();

    expect(supersedePendingAsks).toHaveBeenCalledTimes(1);
    expect(supersedePendingAsks).toHaveBeenCalledWith(
      TASK_ID,
      "会话已失效",
      expect.any(Function),
    );
    // lease：会话仍是死的 → 可写；写标记前用户已把会话唤醒 → 放手（不误作废新会话上的 ask）
    const lease = supersedePendingAsks.mock.calls[0]![2] as unknown as () => boolean;
    expect(lease()).toBe(true);
    hasChatSession.mockReturnValue(true);
    expect(lease()).toBe(false);
  });

  it("F3-02 投递失败但会话还活着（只是忙）→ 放回、不写作废标记", async () => {
    registerAsk();
    deliverChatAskReply.mockResolvedValue(false);
    hasChatSession.mockReturnValue(true);

    await click();

    expect(getPendingAsk(TASK_ID)?.askId).toBe("ask-1");
    expect(supersedePendingAsks).not.toHaveBeenCalled();
  });
});
