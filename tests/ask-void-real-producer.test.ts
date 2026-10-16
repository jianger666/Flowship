/**
 * M5-03 补强：作废标记的**真实生产者** → 飞书桥接 tap → 卡片置终态
 *
 * tests/ask-stale.test.ts 里的作废标记是手捏的 `{ supersededAskId }` 对象——它能证明「tap 认得这种形状」，
 * 证明不了「真实的取消 / 顶替 / 停止 / 过期路径写出来的就是这种形状」。两边一旦漂移（谁改了 meta 键名、
 * 谁换了写事件的函数导致不再 fanout 到全局 tap），旧卡就又回到「按钮还能点」，而手捏的单测全绿。
 *
 * 所以这里不手捏：用**真实** `supersedePendingAsks`（取消 / 顶替 / 停止 / 会话失效 / 24h 过期全走它）
 * 在真实临时数据目录里的真实 task 上写标记，经**真实** `writeEventAndPublish` → 真实 `publish` →
 * 已注册的真实全局 tap → 真实 `settleAskCards`，只 mock 飞书网络（batchUpdateCard）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = mkdtempSync(path.join(os.tmpdir(), "ask-void-real-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const { batchUpdateCard } = vi.hoisted(() => ({
  batchUpdateCard: vi.fn<
    (cardId: string, actions: unknown[], seq: number) => Promise<void>
  >(async () => undefined),
}));

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({
  batchUpdateCard,
  sendInteractiveCardToChat: vi.fn(),
  sendPostMarkdownToChat: vi.fn(),
  sendTextMessageToChat: vi.fn(),
}));

const {
  ASK_CARD_EXPIRED_HINT,
  ASK_CARD_VOID_HINT,
  ASK_CARD_ANSWERED_HINT,
  __resetAskCardSettleForTest,
} = await import("@/lib/server/feishu-bridge/ask-card-settle");
const { __setCardMapMaxForTest, rememberAskCard } = await import(
  "@/lib/server/feishu-bridge/card-map"
);
const {
  __resetGroupOutboundForTest,
  __setGroupOutboundDepsForTest,
  ensureFeishuGroupOutboundRegistered,
} = await import("@/lib/server/feishu-bridge/group-outbound");
const { supersedePendingAsks } = await import("@/lib/server/ask-supersede");
const { createTask } = await import("@/lib/server/task-fs");
const { writeEventAndPublish } = await import("@/lib/server/task-stream");

const ASK_ID = "ask-real-1";

const SINGLE = [
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
const MULTI = [
  SINGLE[0]!,
  {
    id: "q2",
    question: "要不要缓存",
    allowText: true,
    options: [{ id: "y", label: "要" }],
  },
];

/**
 * 真实 task + 一条真实的 ask_user_request 事件。
 * 事件必须在 tap 注册**之前**写：否则 tap 会把它当成「要发群答题卡」的请求去处理，与本测试无关。
 */
const seedAsk = async (
  questions: unknown[],
): Promise<{ taskId: string }> => {
  const task = await createTask({ title: "停止测试", mode: "chat" } as never);
  await writeEventAndPublish(task.id, {
    kind: "ask_user_request",
    text: "需要你确认",
    meta: { askId: ASK_ID, token: "tok", questions },
  });
  // 私聊流式卡（路由判据 = taskId）+ 需求群答题卡（路由判据空串）
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
  return { taskId: task.id };
};

const registerTap = (): void => {
  __setGroupOutboundDepsForTest({ isBridgeEnabled: async () => true });
  ensureFeishuGroupOutboundRegistered();
};

const patchedJson = (): string => JSON.stringify(batchUpdateCard.mock.calls);
const patchedCardIds = (): string[] =>
  [...new Set(batchUpdateCard.mock.calls.map((c) => c[0]))].sort();

beforeEach(() => {
  vi.clearAllMocks();
  __setCardMapMaxForTest(20);
  __resetAskCardSettleForTest();
});

afterEach(() => {
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  __setCardMapMaxForTest(null);
  __resetAskCardSettleForTest();
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("真实 supersedePendingAsks 写的作废标记 → 两张承载卡置成「已失效」", () => {
  it("取消 / 顶替 / 停止 / 会话失效（同一个入口）：私聊卡 + 群卡都置态、删按钮、不冒充已回答", async () => {
    const { taskId } = await seedAsk(SINGLE);
    registerTap();

    await supersedePendingAsks(taskId, "用户停止");

    await vi.waitFor(() => expect(batchUpdateCard).toHaveBeenCalledTimes(2));
    expect(patchedCardIds()).toEqual(["card_group", "card_p2p"]);
    const json = patchedJson();
    expect(json).toContain(ASK_CARD_VOID_HINT);
    expect(json).toContain("delete_elements");
    expect(json).not.toContain(ASK_CARD_ANSWERED_HINT);
    expect(json).not.toContain("已回答");
  });

  it("24h 过期（expired:true）：真实标记带的过期位被认出来 → 「已过期」", async () => {
    const { taskId } = await seedAsk(SINGLE);
    registerTap();

    await supersedePendingAsks(taskId, "等待超过 24 小时", undefined, {
      expired: true,
    });

    await vi.waitFor(() => expect(batchUpdateCard).toHaveBeenCalledTimes(2));
    expect(patchedJson()).toContain(ASK_CARD_EXPIRED_HINT);
    expect(patchedJson()).not.toContain(ASK_CARD_VOID_HINT);
  });

  it("多题卡经真实生产者：同样置态，且不对不存在的按钮发 delete_elements（M5-01 在这条链上也成立）", async () => {
    const { taskId } = await seedAsk(MULTI);
    registerTap();

    await supersedePendingAsks(taskId, "被新提问顶替");

    await vi.waitFor(() => expect(batchUpdateCard).toHaveBeenCalledTimes(2));
    expect(patchedJson()).toContain(ASK_CARD_VOID_HINT);
    expect(patchedJson()).not.toContain("delete_elements");
  });

  it("这组 ask 已经被回答：supersedePendingAsks 不写标记 → 卡片不会被盖成「已失效」", async () => {
    const { taskId } = await seedAsk(SINGLE);
    await writeEventAndPublish(taskId, {
      kind: "ask_user_reply",
      text: "答：方案 A",
      meta: { askId: ASK_ID, source: "feishu" },
    });
    registerTap();

    await supersedePendingAsks(taskId, "用户停止");
    // 给 tap 的异步链一个落地窗口，再断言「没有任何 patch」
    await new Promise((r) => setTimeout(r, 50));
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });

  it("重复作废（重启后又来一遍）：不再写第二条标记、卡片只置一次态", async () => {
    const { taskId } = await seedAsk(SINGLE);
    registerTap();

    await supersedePendingAsks(taskId, "用户停止");
    await vi.waitFor(() => expect(batchUpdateCard).toHaveBeenCalledTimes(2));
    await supersedePendingAsks(taskId, "会话已失效");
    await new Promise((r) => setTimeout(r, 50));
    expect(batchUpdateCard).toHaveBeenCalledTimes(2);
  });
});
