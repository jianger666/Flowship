/**
 * F3-02（第五轮审查）：群里答题 / 点群答题卡按钮时会话已死 → 必须写作废标记并把卡置「已失效」
 *
 * 文档承诺（docs/feishu-group-collab.md「卡片终态置态」表）：会话失效这条了结路径经
 * `supersedePendingAsks` 写 `info` 作废标记（meta.supersededAskId），群里的 tap 认出标记后
 * 置卡。ask-reply 路由在「会话已死、也唤不醒」时就是这么做的；`injectPendingAskText`
 * 在同一情形下只把 pending 摘走就返回——事件流里这组 ask 仍显示「待回答」、群里那张橙色卡
 * 原样挂着按钮，用户还会再点一次，得到的却是中性的「已失效或已回答」。
 *
 * 不手捏事件：真实 task + 真实 supersedePendingAsks + 真实 writeEventAndPublish + 真实全局 tap
 * + 真实 settleAskCards，只 mock 飞书网络与 deliver（模拟会话已死 / 还活着）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = mkdtempSync(path.join(os.tmpdir(), "ask-inject-dead-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const { batchUpdateCard, deliverAskReply, deliverChatAskReply, hasChatSession } =
  vi.hoisted(() => {
    type AnyFn = (...args: never[]) => unknown;
    return {
      batchUpdateCard: vi.fn<
        (cardId: string, actions: unknown[], seq: number) => Promise<void>
      >(async () => undefined),
      deliverAskReply: vi.fn<AnyFn>(async () => "no_session"),
      deliverChatAskReply: vi.fn<AnyFn>(async () => false),
      hasChatSession: vi.fn<AnyFn>(() => false),
    };
  });

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({
  batchUpdateCard,
  sendInteractiveCardToChat: vi.fn(),
  sendPostMarkdownToChat: vi.fn(),
  sendTextMessageToChat: vi.fn(),
}));
vi.mock("@/lib/server/task-runner", () => ({ deliverAskReply }));
vi.mock("@/lib/server/chat-runner", () => ({
  deliverChatAskReply,
  hasChatSession,
}));

const { ASK_CARD_VOID_HINT, __resetAskCardSettleForTest } = await import(
  "@/lib/server/feishu-bridge/ask-card-settle"
);
const { __setCardMapMaxForTest, rememberAskCard } = await import(
  "@/lib/server/feishu-bridge/card-map"
);
const {
  __resetGroupOutboundForTest,
  __setGroupOutboundDepsForTest,
  ensureFeishuGroupOutboundRegistered,
} = await import("@/lib/server/feishu-bridge/group-outbound");
const { injectPendingAskText } = await import(
  "@/lib/server/feishu-bridge/ask-inject"
);
const { __resetPendingAskStateForTest, getPendingAsk, registerPendingAsk } =
  await import("@/lib/server/chat-pending");
const { agentSessions, writeEventAndPublish } = await import(
  "@/lib/server/task-stream"
);
const { createTask, getTask } = await import("@/lib/server/task-fs");

const ASK_ID = "ask-dead-1";
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

/**
 * 真实 task + 一条真实的 ask_user_request + 两张承载卡 + 内存 pending 登记。
 * 事件必须在 tap 注册**之前**写：否则 tap 会把它当成「要发群答题卡」的请求去处理，与本测试无关。
 */
const seedAsk = async (mode: "chat" | "task"): Promise<string> => {
  const task = await createTask({ title: "会话已死", mode } as never);
  await writeEventAndPublish(task.id, {
    kind: "ask_user_request",
    text: "需要你确认",
    meta: { askId: ASK_ID, token: "tok", questions: QUESTIONS },
  });
  for (const [messageId, cardId, routeTaskId] of [
    ["om_p2p", "card_p2p", task.id],
    ["om_group", "card_group", ""],
  ] as const) {
    await rememberAskCard({
      messageId,
      cardId,
      routeTaskId,
      askTaskId: task.id,
      askId: ASK_ID,
    });
  }
  registerPendingAsk(task.id, { askId: ASK_ID, questions: QUESTIONS });
  return task.id;
};

const registerTap = (): void => {
  __setGroupOutboundDepsForTest({ isBridgeEnabled: async () => true });
  ensureFeishuGroupOutboundRegistered();
};

const voidMarkersOf = async (taskId: string) =>
  ((await getTask(taskId))?.events ?? []).filter(
    (e) => e.kind === "info" && e.meta?.supersededAskId === ASK_ID,
  );

beforeEach(() => {
  vi.clearAllMocks();
  __resetPendingAskStateForTest();
  __setCardMapMaxForTest(20);
  __resetAskCardSettleForTest();
  agentSessions.clear();
  deliverAskReply.mockResolvedValue("no_session");
  deliverChatAskReply.mockResolvedValue(false);
  hasChatSession.mockReturnValue(false);
});

afterEach(() => {
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  __setCardMapMaxForTest(null);
  __resetAskCardSettleForTest();
  __resetPendingAskStateForTest();
  agentSessions.clear();
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("injectPendingAskText：会话已死且无法唤醒 → 写作废标记、两张卡置「已失效」", () => {
  it.each<["chat" | "task"]>([["chat"], ["task"]])(
    "%s 模式：作废标记落盘 + 私聊卡 / 群卡都删按钮置态、pending 不放回",
    async (mode) => {
      const taskId = await seedAsk(mode);
      registerTap();

      const r = await injectPendingAskText(taskId, "方案 B");

      expect(r).toMatchObject({ ok: false, reason: "deliver_failed" });
      expect(getPendingAsk(taskId)).toBeNull();
      // 事件流里这组 ask 有了作废标记（前端据此收起「待回答」、isAskSettled 才成立）
      expect(await voidMarkersOf(taskId)).toHaveLength(1);
      // 经真实 tap → settleAskCardsOnVoidMarker：两张承载卡一起置终态
      await vi.waitFor(() => expect(batchUpdateCard).toHaveBeenCalledTimes(2));
      const json = JSON.stringify(batchUpdateCard.mock.calls);
      expect(json).toContain(ASK_CARD_VOID_HINT);
      expect(json).toContain("delete_elements");
      expect(json).not.toContain("已回答");
    },
  );

  it("会话还活着（只是这次忙）→ 放回原题、不写作废标记、卡不动", async () => {
    const taskId = await seedAsk("chat");
    registerTap();
    hasChatSession.mockReturnValue(true);

    const r = await injectPendingAskText(taskId, "方案 B");

    expect(r).toMatchObject({ ok: false, reason: "deliver_failed" });
    expect(getPendingAsk(taskId)?.askId).toBe(ASK_ID);
    expect(await voidMarkersOf(taskId)).toHaveLength(0);
    // 给 tap 的异步链一个落地窗口，再断言「没有任何 patch」
    await new Promise((r2) => setTimeout(r2, 50));
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });

  it("判定会话已死之后、写标记之前会话被拉起 → 放手（不把新会话上的 ask 误作废）", async () => {
    const taskId = await seedAsk("chat");
    registerTap();
    // deliver 失败那一刻会话是死的；supersedePendingAsks 读盘期间用户唤醒了新会话
    hasChatSession
      .mockReturnValueOnce(false) // injectPendingAskText 的 sessionAlive 判定
      .mockReturnValue(true); // 之后任何复查（lease）都看到会话已复活

    await injectPendingAskText(taskId, "方案 B");

    expect(await voidMarkersOf(taskId)).toHaveLength(0);
    await new Promise((r2) => setTimeout(r2, 50));
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });
});
