/**
 * ask 卡结算的网络失败后台重试（M5-02）
 *
 * 核实结论（读代码 + 本测试对账）：
 * - `lark-api.runLark` 的传输层重试只覆盖 GET / 「请求发出前就断了」；`batch_update` 是 POST，
 *   「请求已发出、响应路上断了」那类瞬时失败**不会**被重试 → 抛到 settleAskCards；
 * - 旧实现里 settleAskCards 对每张卡只 patch 一次，失败只 warn、一次即弃：
 *   一张都没成 → 退坑（但没有任何后续链会再来，答题链只有一条）；部分成功 → 失败那张永远不再补。
 *   结果是那张卡停在「等待回答」+ 按钮还能点，直到有人点它才变成「已失效」。
 *
 * 修法：对**瞬时传输失败**做有限（2 次）带退避的**后台**重试，不阻塞调用方。
 * 为什么安全（幂等）：
 * - update_element 是整元素覆盖、天然幂等；
 * - delete_elements 若第一次其实已生效（响应丢了）、重试时目标已不在——最坏是这一批被飞书拒掉
 *  （卡片本来就已是终态）、只多一条 warn，不会把卡改坏；若第一次没生效，重试把它补齐；
 * - 每次重试用 card-seq 分配新的递增 sequence（不复用旧号）。
 *
 * 全部 mock 飞书（batchUpdateCard）+ 注入调度器，不依赖真实网络 / 真实计时。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `ask-card-settle-retry-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const { batchUpdateCard } = vi.hoisted(() => ({
  batchUpdateCard: vi.fn<
    (cardId: string, actions: unknown[], seq: number) => Promise<void>
  >(async () => undefined),
}));

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({ batchUpdateCard }));

const { __setCardMapMaxForTest, rememberAskCard } = await import(
  "@/lib/server/feishu-bridge/card-map"
);
const {
  __resetAskCardSettleForTest,
  __setAskSettleRetryForTest,
  isAskCardSettled,
  settleAskCards,
} = await import("@/lib/server/feishu-bridge/ask-card-settle");
const { LarkApiError } = await import("@/lib/server/feishu-bridge/types");

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

const settleInput = {
  taskId: TASK_ID,
  askId: ASK_ID,
  questions: QUESTIONS,
  noteByQuestion: { q1: "已选择：方案 A" },
  fallbackNote: "（未回答）",
  hintNote: "这组提问已回答、无需再答",
};

/** 注入的调度器：只记录、由测试手动触发——既不真等、也能断言「没有阻塞调用方」 */
type Scheduled = { cb: () => void; ms: number };
let scheduled: Scheduled[] = [];

/** 触发队首的一次重试并等它跑完（重试回调内部是 async、cb 本身同步返回） */
const fireNext = async (): Promise<void> => {
  const next = scheduled.shift();
  if (!next) throw new Error("没有待触发的重试");
  next.cb();
  // 让回调里的 await 链（patchOneCard → batchUpdateCard）跑完
  await new Promise((r) => setTimeout(r, 0));
};

/** 瞬时传输失败：POST 发出后连接被掐（runLark 不会为这类写操作做传输层重试） */
const transientErr = (): Error =>
  new LarkApiError("API call failed: Post ...batch_update: EOF", {
    api: "api POST /open-apis/cardkit/v1/cards/:id/batch_update",
  });

const seedCards = async (ids: Array<[string, string, string]>): Promise<void> => {
  for (const [messageId, cardId, routeTaskId] of ids) {
    await rememberAskCard({
      messageId,
      cardId,
      routeTaskId,
      askTaskId: TASK_ID,
      askId: ASK_ID,
    });
  }
};

const callsOf = (cardId: string) =>
  batchUpdateCard.mock.calls.filter((c) => c[0] === cardId);

beforeEach(async () => {
  vi.clearAllMocks();
  batchUpdateCard.mockReset();
  batchUpdateCard.mockImplementation(async () => undefined);
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  __setCardMapMaxForTest(20);
  __resetAskCardSettleForTest();
  scheduled = [];
  __setAskSettleRetryForTest({
    schedule: (cb, ms) => {
      scheduled.push({ cb, ms });
    },
  });
});

afterEach(async () => {
  __setAskSettleRetryForTest(null);
  __setCardMapMaxForTest(null);
  __resetAskCardSettleForTest();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("M5-02 结算失败的后台重试", () => {
  it("瞬时失败：settle 先正常返回（不阻塞调用方）、随后后台重试把卡补成终态", async () => {
    await seedCards([["om_p2p", "card_p2p", TASK_ID]]);
    batchUpdateCard.mockRejectedValueOnce(transientErr());

    // 返回值语义不变：首轮没成功的卡数为 0——调用方不需要等重试
    expect(await settleAskCards(settleInput)).toBe(0);
    expect(batchUpdateCard).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBeGreaterThan(0);

    await fireNext();
    expect(batchUpdateCard).toHaveBeenCalledTimes(2);
    // 重试带的是同一份终态内容（删按钮 + 问题区说明 + 提示行），不是别的东西
    const [first, second] = callsOf("card_p2p");
    expect(JSON.stringify(second![1])).toBe(JSON.stringify(first![1]));
    // sequence 是新分配的、严格递增（不复用失败那次的号）
    expect(second![2]).toBeGreaterThan(first![2]);
    // 补成功后不再有后续重试
    expect(scheduled).toHaveLength(0);
  });

  it("有限重试：连续瞬时失败最多再试 2 次、之后放弃（不无限重试）", async () => {
    await seedCards([["om_p2p", "card_p2p", TASK_ID]]);
    batchUpdateCard.mockRejectedValue(transientErr());

    await settleAskCards(settleInput);
    const delays: number[] = [scheduled[0]!.ms];
    await fireNext();
    expect(scheduled).toHaveLength(1);
    delays.push(scheduled[0]!.ms);
    await fireNext();

    // 首次 + 2 次重试 = 3 次调用，之后不再调度
    expect(batchUpdateCard).toHaveBeenCalledTimes(3);
    expect(scheduled).toHaveLength(0);
    // 退避：后一次等得比前一次久
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
  });

  it("业务拒绝（权限 / 参数 / 卡不存在）不重试——重试多少次都是同一个结果", async () => {
    await seedCards([["om_p2p", "card_p2p", TASK_ID]]);
    batchUpdateCard.mockRejectedValueOnce(
      new LarkApiError("no permission", { code: 99991672 }),
    );
    await settleAskCards(settleInput);
    expect(scheduled).toHaveLength(0);
    expect(batchUpdateCard).toHaveBeenCalledTimes(1);
  });

  it("lark-cli 超时也算瞬时失败（响应可能丢了、重试安全）", async () => {
    await seedCards([["om_p2p", "card_p2p", TASK_ID]]);
    batchUpdateCard.mockRejectedValueOnce(
      new LarkApiError("lark-cli 超时（30000ms）", {}),
    );
    await settleAskCards(settleInput);
    expect(scheduled).toHaveLength(1);
  });

  it("两张卡一成一败：只重试失败那张、成功那张不重复 patch；占坑保持", async () => {
    await seedCards([
      ["om_p2p", "card_p2p", TASK_ID],
      ["om_group", "card_group", ""],
    ]);
    // findAskCards 的顺序 = 登记顺序：第一张（p2p）成功、第二张（群）瞬时失败
    batchUpdateCard.mockImplementation(async (cardId: string) => {
      if (cardId === "card_group" && callsOf("card_group").length === 1) {
        throw transientErr();
      }
    });

    expect(await settleAskCards(settleInput)).toBe(1);
    expect(isAskCardSettled(TASK_ID, ASK_ID)).toBe(true);
    expect(scheduled).toHaveLength(1);

    await fireNext();
    expect(callsOf("card_p2p")).toHaveLength(1);
    expect(callsOf("card_group")).toHaveLength(2);
  });

  it("全失败退坑后别的链先把这张卡置好了：重试回调发现已置好、直接跳过（不重复 patch）", async () => {
    await seedCards([["om_p2p", "card_p2p", TASK_ID]]);
    batchUpdateCard.mockRejectedValueOnce(transientErr());
    expect(await settleAskCards(settleInput)).toBe(0);
    // 占坑已退：下一条了结链（比如用户随后跳过）能重新占上、并置成功
    expect(isAskCardSettled(TASK_ID, ASK_ID)).toBe(false);
    expect(
      await settleAskCards({ ...settleInput, noteByQuestion: undefined }),
    ).toBe(1);
    expect(batchUpdateCard).toHaveBeenCalledTimes(2);

    // 后台重试醒来：这张卡已被别的链置好——不能再盖一遍（会把后到的文案覆盖掉、还白发一次）
    await fireNext();
    expect(batchUpdateCard).toHaveBeenCalledTimes(2);
  });

  it("全失败退坑后重试成功：占坑补回（后续了结链不再重复置态、点旧卡的单按钮 patch 也会跳过）", async () => {
    await seedCards([["om_p2p", "card_p2p", TASK_ID]]);
    batchUpdateCard.mockRejectedValueOnce(transientErr());
    expect(await settleAskCards(settleInput)).toBe(0);
    expect(isAskCardSettled(TASK_ID, ASK_ID)).toBe(false);

    await fireNext();
    // 卡已经是终态了：占坑状态要如实反映，否则 patchSingleButtonStale 会去 patch 一颗早被删掉的按钮
    expect(isAskCardSettled(TASK_ID, ASK_ID)).toBe(true);
    batchUpdateCard.mockClear();
    expect(await settleAskCards(settleInput)).toBe(0);
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });

  it("重试期间依旧绝不抛：重试回调里的任何失败都只 warn", async () => {
    await seedCards([["om_p2p", "card_p2p", TASK_ID]]);
    batchUpdateCard.mockRejectedValue(transientErr());
    await settleAskCards(settleInput);
    await expect(fireNext()).resolves.toBeUndefined();
  });
});
