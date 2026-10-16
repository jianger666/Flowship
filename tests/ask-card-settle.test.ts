/**
 * ask 卡片终态置态 + card-map 的 ask 索引（HANDOFF 记的那笔欠账）
 *
 * 欠账原文：「App 里答完群答题卡后，群里那张卡不置态、看着还像待答」。根因是终态 patch
 * 只写在「**从这张卡点按钮**」的分支里——从别处（app 答题 / 群里打字 / 用户跳过）了结时
 * 两边卡片都不动。修法是给 card-map 加 `(askTaskId, askId)` 索引 + 一个统一收口点，
 * 谁了结的谁调一次，它把**所有**承载卡一起置成终态。
 *
 * 全部 mock 飞书调用（batchUpdateCard）——不真发消息。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `ask-card-settle-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const { batchUpdateCard } = vi.hoisted(() => ({
  batchUpdateCard: vi.fn<
    (cardId: string, actions: unknown[], seq: number) => Promise<void>
  >(async () => undefined),
}));

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({ batchUpdateCard }));

const {
  __setCardMapMaxForTest,
  findAskCards,
  findTaskByMessageId,
  rememberAskCard,
  rememberCardMessage,
} = await import("@/lib/server/feishu-bridge/card-map");
const {
  __resetAskCardSettleForTest,
  isAskCardSettled,
  settleAskCards,
} = await import("@/lib/server/feishu-bridge/ask-card-settle");

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

/** 全部 batch_update actions 拍平成一个字符串，方便做包含断言 */
const patchedJson = (): string => JSON.stringify(batchUpdateCard.mock.calls);

beforeEach(async () => {
  vi.clearAllMocks();
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  __setCardMapMaxForTest(20);
  __resetAskCardSettleForTest();
});

afterEach(async () => {
  __setCardMapMaxForTest(null);
  __resetAskCardSettleForTest();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("card-map 的 ask 索引", () => {
  it("按 (taskId, askId) 反查得到承载卡；两张卡都收得回来", async () => {
    // p2p 流式卡（路由判据 = 真 taskId）
    await rememberAskCard({
      messageId: "om_p2p",
      cardId: "card_p2p",
      routeTaskId: TASK_ID,
      askTaskId: TASK_ID,
      askId: ASK_ID,
    });
    // 需求群答题卡（路由判据留空、不参与 p2p 回复锚定）
    await rememberAskCard({
      messageId: "om_group",
      cardId: "card_group",
      routeTaskId: "",
      askTaskId: TASK_ID,
      askId: ASK_ID,
    });

    const cards = await findAskCards(TASK_ID, ASK_ID);
    expect(cards.map((c) => c.cardId).sort()).toEqual([
      "card_group",
      "card_p2p",
    ]);
    // 群卡的路由判据仍是空串——p2p 回复锚定不该命中它
    expect((await findTaskByMessageId("om_group"))?.taskId).toBe("");
    expect((await findTaskByMessageId("om_p2p"))?.taskId).toBe(TASK_ID);
  });

  it("补录已有条目：只补 ask 索引、不动路由判据", async () => {
    await rememberCardMessage({
      messageId: "om_p2p",
      cardId: "card_p2p",
      taskId: TASK_ID,
      createdAt: 1,
    });
    // 流式卡建卡在前、追加提问在后——补录时 routeTaskId 传什么都不许覆盖原值
    await rememberAskCard({
      messageId: "om_p2p",
      cardId: "card_p2p",
      routeTaskId: "SHOULD_NOT_OVERWRITE",
      askTaskId: TASK_ID,
      askId: ASK_ID,
    });
    expect((await findTaskByMessageId("om_p2p"))?.taskId).toBe(TASK_ID);
    expect(await findAskCards(TASK_ID, ASK_ID)).toHaveLength(1);
  });

  it("别的 task / 别的 ask 不串", async () => {
    await rememberAskCard({
      messageId: "om_a",
      cardId: "card_a",
      routeTaskId: "",
      askTaskId: TASK_ID,
      askId: ASK_ID,
    });
    expect(await findAskCards(TASK_ID, "ask-OTHER")).toHaveLength(0);
    expect(await findAskCards("task-OTHER", ASK_ID)).toHaveLength(0);
  });
});

describe("settleAskCards", () => {
  const seedTwoCards = async (): Promise<void> => {
    await rememberAskCard({
      messageId: "om_p2p",
      cardId: "card_p2p",
      routeTaskId: TASK_ID,
      askTaskId: TASK_ID,
      askId: ASK_ID,
    });
    await rememberAskCard({
      messageId: "om_group",
      cardId: "card_group",
      routeTaskId: "",
      askTaskId: TASK_ID,
      askId: ASK_ID,
    });
  };

  it("从别处了结 → 两张卡一起置终态（欠账主用例）", async () => {
    await seedTwoCards();
    const patched = await settleAskCards({
      taskId: TASK_ID,
      askId: ASK_ID,
      questions: QUESTIONS,
      fallbackNote: "已在 Flowship 里回答",
      hintNote: "这组提问已回答、无需再答",
    });

    expect(patched).toBe(2);
    const cardIds = batchUpdateCard.mock.calls.map((c) => c[0]);
    expect(cardIds.sort()).toEqual(["card_group", "card_p2p"]);
    const json = patchedJson();
    // 选项按钮全删（防重复点）+ 问题区换成终态说明 + 群卡的「还能怎么答」说明行也换掉
    expect(json).toContain("delete_elements");
    expect(json).toContain("已在 Flowship 里回答");
    expect(json).toContain("这组提问已回答、无需再答");
  });

  it("逐题文案优先于兜底文案", async () => {
    await seedTwoCards();
    await settleAskCards({
      taskId: TASK_ID,
      askId: ASK_ID,
      questions: QUESTIONS,
      noteByQuestion: { q1: "群成员 已选择：方案 A" },
      fallbackNote: "（未回答）",
      hintNote: "done",
    });
    expect(patchedJson()).toContain("群成员 已选择：方案 A");
    expect(patchedJson()).not.toContain("（未回答）");
  });

  it("幂等：同一组 ask 再置一次直接跳过（答 / 跳两条链都可能调到）", async () => {
    await seedTwoCards();
    expect(
      await settleAskCards({
        taskId: TASK_ID,
        askId: ASK_ID,
        questions: QUESTIONS,
        fallbackNote: "已回答",
        hintNote: "done",
      }),
    ).toBe(2);
    batchUpdateCard.mockClear();

    expect(
      await settleAskCards({
        taskId: TASK_ID,
        askId: ASK_ID,
        questions: QUESTIONS,
        fallbackNote: "（已跳过）",
        hintNote: "skipped",
      }),
    ).toBe(0);
    expect(batchUpdateCard).not.toHaveBeenCalled();
    expect(isAskCardSettled(TASK_ID, ASK_ID)).toBe(true);
  });

  it("一张都没置成 → 退坑、下一条了结链还能再试", async () => {
    await seedTwoCards();
    batchUpdateCard.mockRejectedValueOnce(new Error("lark 挂了"));
    batchUpdateCard.mockRejectedValueOnce(new Error("lark 挂了"));
    expect(
      await settleAskCards({
        taskId: TASK_ID,
        askId: ASK_ID,
        questions: QUESTIONS,
        fallbackNote: "已回答",
        hintNote: "done",
      }),
    ).toBe(0);
    expect(isAskCardSettled(TASK_ID, ASK_ID)).toBe(false);

    // 飞书恢复后重试成功
    expect(
      await settleAskCards({
        taskId: TASK_ID,
        askId: ASK_ID,
        questions: QUESTIONS,
        fallbackNote: "已回答",
        hintNote: "done",
      }),
    ).toBe(2);
  });

  it("压根没记上卡（桥接没开）→ 不报错、也不把坑占死", async () => {
    expect(
      await settleAskCards({
        taskId: TASK_ID,
        askId: ASK_ID,
        questions: QUESTIONS,
        fallbackNote: "已回答",
        hintNote: "done",
      }),
    ).toBe(0);
    expect(batchUpdateCard).not.toHaveBeenCalled();
    expect(isAskCardSettled(TASK_ID, ASK_ID)).toBe(false);
  });

  it("某张卡 patch 失败不影响另一张（best-effort、绝不抛）", async () => {
    await seedTwoCards();
    batchUpdateCard.mockRejectedValueOnce(new Error("这张卡没了"));
    const patched = await settleAskCards({
      taskId: TASK_ID,
      askId: ASK_ID,
      questions: QUESTIONS,
      fallbackNote: "已回答",
      hintNote: "done",
    });
    expect(patched).toBe(1);
  });
});

describe("settle 占坑释放 / 终态视图生命周期（R3-02）", () => {
  const seedTwoCards = async (): Promise<void> => {
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

  const settleInput = {
    taskId: TASK_ID,
    askId: ASK_ID,
    questions: QUESTIONS,
    noteByQuestion: { q1: "已选择：方案 A" },
    fallbackNote: "已回答",
    hintNote: "done",
  };

  it("没有卡 → 占坑释放（可重试）、终态视图保留、重试能重新占坑", async () => {
    const {
      getAskCardSettledView,
      isAskCardSettled: settled,
    } = await import("@/lib/server/feishu-bridge/ask-settle-state");

    expect(await settleAskCards(settleInput)).toBe(0);
    expect(settled(TASK_ID, ASK_ID)).toBe(false);
    expect(getAskCardSettledView(TASK_ID, ASK_ID)).toMatchObject({
      noteByQuestion: { q1: "已选择：方案 A" },
      hintNote: "done",
    });

    // 卡索引后来落盘了：重试能占上、置态成功
    await seedTwoCards();
    expect(await settleAskCards(settleInput)).toBe(2);
    expect(settled(TASK_ID, ASK_ID)).toBe(true);
  });

  it("dropAskCardSettledView：只丢视图；已占坑的继续挡重复置态，没占坑的整条删掉", async () => {
    const {
      __askCardSettleSizeForTest,
      claimAskCardSettle,
      dropAskCardSettledView,
      getAskCardSettledView,
    } = await import("@/lib/server/feishu-bridge/ask-settle-state");

    // 已占坑 + 有视图
    await seedTwoCards();
    expect(await settleAskCards(settleInput)).toBe(2);
    dropAskCardSettledView(TASK_ID, ASK_ID);
    expect(getAskCardSettledView(TASK_ID, ASK_ID)).toBeNull();
    expect(claimAskCardSettle(TASK_ID, ASK_ID)).toBe(false);

    // 释放过占坑（无卡）+ 有视图 → drop 后整条删除
    __resetAskCardSettleForTest();
    const noCard = { ...settleInput, askId: "ask-nocard" };
    expect(await settleAskCards(noCard)).toBe(0);
    expect(__askCardSettleSizeForTest()).toBe(1);
    dropAskCardSettledView(TASK_ID, "ask-nocard");
    expect(__askCardSettleSizeForTest()).toBe(0);
  });

  it("超过 TTL 的登记（含只剩视图的）在下一次占坑时被清掉", async () => {
    const { __askCardSettleSizeForTest, claimAskCardSettle } = await import(
      "@/lib/server/feishu-bridge/ask-settle-state"
    );
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
      expect(await settleAskCards(settleInput)).toBe(0); // 无卡：只剩视图
      expect(__askCardSettleSizeForTest()).toBe(1);

      vi.setSystemTime(new Date("2026-10-15T00:00:01Z")); // > 24h
      expect(claimAskCardSettle("other-task", "other-ask")).toBe(true);
      expect(__askCardSettleSizeForTest()).toBe(1); // 旧的被扫掉、只剩新占的
    } finally {
      vi.useRealTimers();
    }
  });
});
