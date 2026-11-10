/**
 * 排队条「1 条排队中」点开却「队列已空」的幽灵占位（2026-11-09 用户反馈，见 HANDOFF「已知 Bug」→ 已修）
 *
 * 根因链：
 *   1) 服务端 bootstrap 的 `operationSnapshot` 包含刚 claim 还没入队的 `accepting` 操作；
 *   2) 被 409 软拒绝（定时遇忙 / 停止中 / 队满…）的请求在 finally 里静默 release——不发任何帧；
 *   3) 旧的客户端对账把「本地没有的 active 条目」一律重建成占位（无正文、无指纹），bootstrap 撞在 claim→release 之间就多出一个；
 *   4) 之后它不在 serverSet → 被当「真幽灵」永久保留（networkUncertain），排队条上凭空多一个数、面板拉服务端队列却是空的。
 *
 * 修法（chat-pending-reconcile.reconcilePendingWithQueueState）：
 *   - 重建：`accepting` 只有在服务端队列 / in-flight（serverItemIds）里才重建；`persisted` 照旧；
 *   - 保留：已有的重建占位只有「仍在队列 / in-flight」或「快照里已 persisted」才留。
 * 本窗口真实登记的占位（有指纹）口径不变。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetChatOpLedgerForTests,
  dispatchChatOp,
  getChatOpLedger,
} from "@/lib/chat-op-ledger";
import {
  reconcilePendingWithQueueState,
  shouldHideLocalPlaceholder,
  type ChatOpState,
} from "@/lib/chat-pending-reconcile";
import { effectiveQueueCount } from "@/lib/queue-banner";

const TASK = "t_queue_ghost_placeholder";

const activeCount = (s: ChatOpState) => s.pending.filter((p) => !shouldHideLocalPlaceholder(p)).length;

const bootstrap = (args: {
  queue?: string[];
  snapshot?: Array<{ itemId: string; phase: string }>;
  recentSettled?: Array<{ itemId: string; outcome?: string }>;
}) =>
  dispatchChatOp(TASK, {
    type: "queue_state",
    serverItemIds: args.queue ?? [],
    recentSettled: args.recentSettled ?? [],
    operationSnapshot: args.snapshot ?? [],
  });

const register = (id: string) =>
  dispatchChatOp(TASK, {
    type: "register",
    op: {
      id,
      itemId: id,
      payloadFingerprint: `fp_${id}`,
      persistence: "sending",
      terminalKnowledge: "none",
      networkUncertain: false,
      text: `消息 ${id}`,
      displayText: `消息 ${id}`,
    },
  });

describe("重建占位：accepting 只有真在服务端队列里才重建", () => {
  beforeEach(() => __resetChatOpLedgerForTests());

  it("只在 snapshot 里 accepting、不在队列 / in-flight（刚 claim 未入队，或马上被软拒绝 release）→ 不重建，排队数为 0", () => {
    bootstrap({ queue: [], snapshot: [{ itemId: "sch_x.9.41", phase: "accepting" }] });
    expect(getChatOpLedger(TASK).pending).toEqual([]);
  });

  it("真在队列里的 accepting（别的窗口排上的队）照旧重建：条上显示 N，面板去服务端拉带正文的清单", () => {
    bootstrap({ queue: ["cq_a", "cq_b"], snapshot: [{ itemId: "cq_a", phase: "accepting" }, { itemId: "cq_b", phase: "accepting" }] });
    expect(activeCount(getChatOpLedger(TASK))).toBe(2);
  });

  it("in-flight（已出队、正在送）的 id 也在 serverItemIds 里：照旧重建", () => {
    bootstrap({ queue: ["cq_inflight"], snapshot: [{ itemId: "cq_inflight", phase: "accepting" }] });
    expect(activeCount(getChatOpLedger(TASK))).toBe(1);
  });

  it("persisted 照旧重建（但本地隐藏、不计数）", () => {
    bootstrap({ queue: [], snapshot: [{ itemId: "cq_p", phase: "persisted" }] });
    const s = getChatOpLedger(TASK);
    expect(s.pending.map((p) => p.itemId)).toEqual(["cq_p"]);
    expect(activeCount(s)).toBe(0);
  });
});

describe("已有的重建占位：不再在服务端队列里就丢（修「永久幽灵」）", () => {
  beforeEach(() => __resetChatOpLedgerForTests());

  it("原型：第一次 bootstrap 重建了在队的占位；之后它被释放 / 发出（不在队、不在快照）→ 下次 bootstrap 丢掉，排队数回到 0", () => {
    bootstrap({ queue: ["cq_a"], snapshot: [{ itemId: "cq_a", phase: "accepting" }] });
    expect(activeCount(getChatOpLedger(TASK))).toBe(1);
    // 旧逻辑：走「真幽灵」分支被永久保留（networkUncertain）→ 条上永远是 1
    bootstrap({ queue: [], snapshot: [] });
    expect(activeCount(getChatOpLedger(TASK))).toBe(0);
    expect(getChatOpLedger(TASK).pending).toEqual([]);
  });

  it("重建占位仍在队列 / in-flight 里（SSE 断线重连后第二次 bootstrap）→ 保留，不闪灭", () => {
    bootstrap({ queue: ["cq_a"], snapshot: [{ itemId: "cq_a", phase: "accepting" }] });
    bootstrap({ queue: ["cq_a"], snapshot: [{ itemId: "cq_a", phase: "accepting" }] });
    expect(activeCount(getChatOpLedger(TASK))).toBe(1);
    // 快照里没带（极端：只剩队列里的 id）也不丢——以服务端队列为准
    bootstrap({ queue: ["cq_a"], snapshot: [] });
    expect(activeCount(getChatOpLedger(TASK))).toBe(1);
  });

  it("重建占位在快照里还是 accepting、但已不在队列里（被软拒绝前的最后一瞬）→ 同样丢", () => {
    bootstrap({ queue: ["cq_a"], snapshot: [{ itemId: "cq_a", phase: "accepting" }] });
    bootstrap({ queue: [], snapshot: [{ itemId: "cq_a", phase: "accepting" }] });
    expect(getChatOpLedger(TASK).pending).toEqual([]);
  });

  it("重建占位已在快照里 persisted → 保留并保持隐藏（落盘后的正式气泡由事件流画）", () => {
    bootstrap({ queue: ["cq_a"], snapshot: [{ itemId: "cq_a", phase: "accepting" }] });
    bootstrap({ queue: [], snapshot: [{ itemId: "cq_a", phase: "persisted" }] });
    const s = getChatOpLedger(TASK);
    expect(s.pending.map((p) => p.itemId)).toEqual(["cq_a"]);
    expect(activeCount(s)).toBe(0);
  });

  it("重建占位遇到未知终态 recentSettled（以前走 terminalKnowledge=unknown 保留）→ 也丢：没正文没指纹，留着只会多一个数", () => {
    bootstrap({ queue: ["cq_a"], snapshot: [{ itemId: "cq_a", phase: "accepting" }] });
    bootstrap({ queue: [], snapshot: [], recentSettled: [{ itemId: "cq_a", outcome: "some_future_outcome" }] });
    expect(activeCount(getChatOpLedger(TASK))).toBe(0);
  });

  it("run 空闲时条本来就压成 0；run 在跑时数得对（幽灵不会在下一轮长 run 里冒出来）", () => {
    bootstrap({ queue: [], snapshot: [{ itemId: "sch_x.9.42", phase: "accepting" }] });
    const n = activeCount(getChatOpLedger(TASK));
    expect(effectiveQueueCount({ runActive: true, queuedCount: n > 0 ? n : null })).toBe(0);
  });
});

describe("本窗口真实登记的占位（有指纹）：口径不变", () => {
  beforeEach(() => __resetChatOpLedgerForTests());

  it("自己发的消息，bootstrap 里它只在 snapshot accepting（HTTP 已受理、还没入队）→ 仍保留（关 ghost→delivered 窗口）", () => {
    register("cq_mine");
    bootstrap({ queue: [], snapshot: [{ itemId: "cq_mine", phase: "accepting" }] });
    const p = getChatOpLedger(TASK).pending.find((x) => x.itemId === "cq_mine");
    expect(p).toBeDefined();
    expect(p?.payloadFingerprint).toBe("fp_cq_mine");
  });

  it("自己发的消息，服务端什么证据都没有（也没终态）→ 仍按真幽灵保留、标 networkUncertain（绝不 delivered）", () => {
    register("cq_mine");
    bootstrap({ queue: [], snapshot: [] });
    const p = getChatOpLedger(TASK).pending.find((x) => x.itemId === "cq_mine");
    expect(p).toBeDefined();
    expect(p?.networkUncertain).toBe(true);
  });

  it("自己发的消息 + 别窗口的重建占位混在一起：只丢重建的那个", () => {
    register("cq_mine");
    bootstrap({ queue: ["cq_other"], snapshot: [{ itemId: "cq_other", phase: "accepting" }, { itemId: "cq_mine", phase: "accepting" }] });
    expect(getChatOpLedger(TASK).pending.map((p) => p.itemId).sort()).toEqual(["cq_mine", "cq_other"]);
    bootstrap({ queue: [], snapshot: [{ itemId: "cq_mine", phase: "accepting" }] });
    expect(getChatOpLedger(TASK).pending.map((p) => p.itemId)).toEqual(["cq_mine"]);
  });
});

describe("纯函数 reconcilePendingWithQueueState：手工构造省略指纹但有正文的条目不被当成重建占位", () => {
  it("displayText 非空、无指纹 → 仍走真幽灵口径（保留 + networkUncertain），不被误丢", () => {
    const r = reconcilePendingWithQueueState(
      [{ itemId: "legacy", displayText: "有正文" }],
      [],
      {},
      [],
      [],
      [],
    );
    expect(r.pending.map((p) => p.itemId)).toEqual(["legacy"]);
    expect(r.ghostIds).toEqual(["legacy"]);
  });

  it("displayText 为空且无指纹 = 重建占位：不在队列 / 不在快照 → 丢，且不进 ghostIds", () => {
    const r = reconcilePendingWithQueueState(
      [{ itemId: "rebuilt", displayText: "" }],
      [],
      {},
      [],
      [],
      [],
    );
    expect(r.pending).toEqual([]);
    expect(r.ghostIds).toEqual([]);
  });
});
