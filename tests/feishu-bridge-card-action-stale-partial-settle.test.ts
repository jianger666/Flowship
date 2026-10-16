/**
 * F3-01（第五轮审查）：多张承载卡「一成一败」后，失败那张卡的按钮连单按钮失效 patch 也被跳过
 *
 * 链路：`settleAskCards` 对同一组 ask 的每张承载卡（私聊流式卡 + 群答题卡）各 patch 一次。
 * 一张成功、另一张失败（重试耗尽 / 业务拒绝不重试）时，**占坑保持**（部分成功不退坑，否则会把已置态
 * 的卡再刷一遍）。点旧卡的失效分支 `patchSingleButtonStale` 原先用「整组是否已占坑」当跳过判据——
 * 于是失败那张卡上还挂着的按钮，被点之后既不置态、也没有单按钮失效提示，只有一句文字回复；
 * 用户看到按钮没变化、会继续点。
 *
 * 修法的最小一步：跳过判据由「整组占坑」收窄为「**这张卡**的终态 patch 已成功」
 *（ask-settle-state.isAskCardPatched）。这张卡没置成功，就补发单按钮失效 patch——这就是它的自愈入口。
 *
 * 真实 card-map + 真实 ask-card-settle + 真实 card-action，只 mock 飞书网络与重依赖。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `card-action-partial-settle-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const { getBotAppInfo, batchUpdateCard, sendTextMessage, sendTextMessageToChat, getTask } =
  vi.hoisted(() => {
    type AnyFn = (...args: never[]) => unknown;
    return {
      getBotAppInfo: vi.fn<AnyFn>(async () => ({
        appId: "cli_x",
        ownerOpenId: "ou_owner",
      })),
      batchUpdateCard: vi.fn<
        (cardId: string, actions: unknown[], seq: number) => Promise<void>
      >(async () => undefined),
      sendTextMessage: vi.fn<AnyFn>(async () => ({})),
      sendTextMessageToChat: vi.fn<AnyFn>(async () => ({})),
      getTask: vi.fn<AnyFn>(),
    };
  });

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({
  getBotAppInfo,
  batchUpdateCard,
  sendTextMessage,
  sendTextMessageToChat,
  updateCardEntity: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/chat-runner", () => ({
  deliverChatAskReply: vi.fn(),
  hasChatSession: vi.fn(() => false),
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
vi.mock("@/lib/server/task-fs", () => ({
  getTask,
  syncTaskPendingAskId: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/task-stream", () => ({
  writeUserEventAndPublishStrict: vi.fn(async () => ({ id: "e1" })),
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
}));
vi.mock("@/lib/server/chat-gate", () => ({ getChatLifecycle: vi.fn(() => null) }));
vi.mock("@/lib/server/feishu-bridge/ask-inject", () => ({
  injectPendingAskText: vi.fn(),
}));
vi.mock("@/lib/server/feishu-bridge/group-route", () => ({
  handleGroupAdvancePick: vi.fn(),
}));

const { __setCardMapMaxForTest, rememberAskCard } = await import(
  "@/lib/server/feishu-bridge/card-map"
);
const { __resetAskCardSettleForTest, settleAskCards } = await import(
  "@/lib/server/feishu-bridge/ask-card-settle"
);
const { __resetPendingAskStateForTest } = await import(
  "@/lib/server/chat-pending"
);
const { askOptionElementId } = await import(
  "@/lib/server/feishu-bridge/card-stream"
);
const { handleCardActionEvent } = await import(
  "@/lib/server/feishu-bridge/card-action"
);

const OWNER = "ou_owner";
const CHAT_ID = "oc_group";
const TASK_ID = "task-1";
const ASK_ID = "ask-1";
const QUESTIONS = [
  {
    id: "q1",
    question: "选哪个方案",
    allowText: true,
    options: [
      { id: "opt_a", label: "方案 A" },
      { id: "opt_b", label: "方案 B" },
    ],
  },
];
const BUTTON_ID = askOptionElementId(ASK_ID, "q1", "opt_a");

const seedCards = async (): Promise<void> => {
  // 私聊流式卡（路由判据 = taskId）+ 需求群答题卡（路由判据空串）；findAskCards 按登记顺序返回
  for (const [messageId, cardId, routeTaskId] of [
    ["om_p2p", "card_p2p", TASK_ID],
    ["om_group", "card_group", ""],
  ] as const) {
    await rememberAskCard({
      messageId,
      cardId,
      routeTaskId,
      askTaskId: TASK_ID,
      askId: ASK_ID,
    });
  }
};

const settle = (): Promise<number> =>
  settleAskCards({
    taskId: TASK_ID,
    askId: ASK_ID,
    questions: QUESTIONS,
    fallbackNote: "（已失效）",
    hintNote: "这组提问已失效、无需再回答",
  });

const clickP2p = (): Promise<void> =>
  handleCardActionEvent({
    operator_id: OWNER,
    message_id: "om_p2p",
    action_value: {
      kind: "ask",
      taskId: TASK_ID,
      askId: ASK_ID,
      questionId: "q1",
      optionId: "opt_a",
    },
  });

const clickGroup = (): Promise<void> =>
  handleCardActionEvent({
    operator_id: "ou_member",
    message_id: "om_group",
    chat_id: CHAT_ID,
    action_value: {
      kind: "group_ask",
      taskId: TASK_ID,
      askId: ASK_ID,
      questionId: "q1",
      optionId: "opt_a",
      chatId: CHAT_ID,
    },
  });

/** 只看「单按钮失效 patch」：update_element 且目标正是被点的那颗按钮 */
const singleButtonPatchesOf = (cardId: string) =>
  batchUpdateCard.mock.calls.filter(
    (c) =>
      c[0] === cardId &&
      JSON.stringify(c[1]).includes(BUTTON_ID) &&
      !JSON.stringify(c[1]).includes("delete_elements"),
  );

beforeEach(async () => {
  vi.clearAllMocks();
  batchUpdateCard.mockReset();
  batchUpdateCard.mockImplementation(async () => undefined);
  getBotAppInfo.mockResolvedValue({ appId: "cli_x", ownerOpenId: OWNER });
  // 事件流里没有任何了结证据 → 文案走中性「已失效或已回答」，与本测试关注点无关
  getTask.mockResolvedValue({ id: TASK_ID, mode: "chat", events: [] });
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  __setCardMapMaxForTest(20);
  __resetAskCardSettleForTest();
  __resetPendingAskStateForTest();
});

afterEach(async () => {
  __setCardMapMaxForTest(null);
  __resetAskCardSettleForTest();
  __resetPendingAskStateForTest();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("F3-01 两张卡一成一败：失败那张卡点旧按钮 → 补发单按钮失效 patch", () => {
  it("私聊卡 settle 失败（业务拒绝、不重试）、群卡成功：点私聊卡的旧按钮 → 该按钮被换成失效提示", async () => {
    await seedCards();
    batchUpdateCard.mockImplementation(async (cardId: string) => {
      if (cardId === "card_p2p") throw new Error("permission denied");
    });
    expect(await settle()).toBe(1); // 群卡成功、私聊卡失败
    batchUpdateCard.mockReset();
    batchUpdateCard.mockImplementation(async () => undefined);

    await clickP2p();

    const patches = singleButtonPatchesOf("card_p2p");
    expect(patches).toHaveLength(1);
    expect(JSON.stringify(patches[0]![1])).toContain("该问题已失效或已回答");
    // 文字回复照旧
    expect(sendTextMessage).toHaveBeenCalledWith(
      OWNER,
      expect.stringContaining("已失效或已回答"),
    );
  });

  it("群卡 settle 失败、私聊卡成功：点群卡的旧按钮 → 同样补发单按钮失效 patch", async () => {
    await seedCards();
    batchUpdateCard.mockImplementation(async (cardId: string) => {
      if (cardId === "card_group") throw new Error("permission denied");
    });
    expect(await settle()).toBe(1);
    batchUpdateCard.mockReset();
    batchUpdateCard.mockImplementation(async () => undefined);

    await clickGroup();

    expect(singleButtonPatchesOf("card_group")).toHaveLength(1);
  });

  it("对照（不许修过头）：这张卡的终态 patch 已成功 → 点它残留的按钮不再 patch（element 早被删）", async () => {
    await seedCards();
    batchUpdateCard.mockImplementation(async (cardId: string) => {
      if (cardId === "card_p2p") throw new Error("permission denied");
    });
    expect(await settle()).toBe(1);
    batchUpdateCard.mockReset();
    batchUpdateCard.mockImplementation(async () => undefined);

    await clickGroup(); // 群卡是成功那张

    expect(singleButtonPatchesOf("card_group")).toHaveLength(0);
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });

  it("对照：两张卡都置态成功 → 点任何一张的旧按钮都不再 patch", async () => {
    await seedCards();
    expect(await settle()).toBe(2);
    batchUpdateCard.mockClear();

    await clickP2p();
    await clickGroup();

    expect(batchUpdateCard).not.toHaveBeenCalled();
  });
});
