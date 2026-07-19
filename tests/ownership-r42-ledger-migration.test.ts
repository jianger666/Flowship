/**
 * R42 / R41-2 / R42-1：globalThis ledger 旧一维 shape → 三轴迁移。
 *
 * 决策：key 升为 `__flowshipChatOpLedgerR42`；getStore 每次收割 R36 并合并后删旧 key。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetChatOpLedgerForTests,
  dispatchChatOp,
  getChatOpLedger,
  setChatOpLedger,
  subscribeChatOp,
} from "@/lib/chat-op-ledger";
import { fingerprintFromChatSendArgs } from "@/lib/chat-payload-fingerprint";
import {
  findReusableUncertainOperation,
  projectPendingUncertain,
  reduceChatOperation,
  shouldHideLocalPlaceholder,
  type ChatOpState,
  type ChatOperation,
  type PendingProductState,
} from "@/lib/chat-pending-reconcile";

const LEGACY_KEY = "__flowshipChatOpLedgerR36";
const CURRENT_KEY = "__flowshipChatOpLedgerR42";

type LegacyStore = {
  byTaskId: Map<string, ChatOpState>;
  listeners: Map<string, Set<(s: ChatOpState) => void>>;
};

afterEach(() => {
  __resetChatOpLedgerForTests();
  const g = globalThis as Record<string, unknown>;
  delete g[LEGACY_KEY];
  delete g[CURRENT_KEY];
});

const productOf = (p: ChatOperation | undefined): PendingProductState => ({
  persistence: p?.persistence ?? "sending",
  terminalKnowledge: p?.terminalKnowledge ?? "none",
  networkUncertain: p?.networkUncertain ?? false,
});

/** 直接塞旧 R36 store（绕过 setChatOpLedger 的即时 upgrade） */
const seedLegacyStore = (
  taskId: string,
  pending: Record<string, unknown>[],
  extras?: {
    settled?: string[];
    outcomes?: Record<string, "delivered" | "failed">;
    /** true：不删现行 R42（R42-1 晚到 legacy 窗口） */
    keepCurrent?: boolean;
  },
) => {
  const g = globalThis as Record<string, unknown>;
  if (!extras?.keepCurrent) delete g[CURRENT_KEY];
  const store: LegacyStore = {
    byTaskId: new Map([
      [
        taskId,
        {
          pending: pending as unknown as ChatOperation[],
          settled: extras?.settled ?? [],
          outcomes: extras?.outcomes ?? {},
        },
      ],
    ]),
    listeners: new Map(),
  };
  g[LEGACY_KEY] = store;
  return store;
};

describe("R42 ledger migration：四种旧形状", () => {
  it("sending → sending/none/false；UI 不隐藏占位、非 uncertain", () => {
    const taskId = "mig_sending";
    const fp = fingerprintFromChatSendArgs({ text: "s" });
    seedLegacyStore(taskId, [
      {
        itemId: "cq_s",
        payloadFingerprint: fp,
        displayText: "s",
        text: "s",
        phase: "sending",
      },
    ]);
    const ledger = getChatOpLedger(taskId);
    const p = ledger.pending[0];
    expect(productOf(p)).toEqual({
      persistence: "sending",
      terminalKnowledge: "none",
      networkUncertain: false,
    });
    expect(shouldHideLocalPlaceholder(productOf(p))).toBe(false);
    expect(projectPendingUncertain(productOf(p))).toBe(false);
    // 旧 key 已删，现行 key 存在
    const g = globalThis as Record<string, unknown>;
    expect(g[LEGACY_KEY]).toBeUndefined();
    expect(g[CURRENT_KEY]).toBeTruthy();
  });

  it("network uncertain → networkUncertain=true；retry lookup 命中", () => {
    const taskId = "mig_net";
    const fp = fingerprintFromChatSendArgs({ text: "n" });
    seedLegacyStore(taskId, [
      {
        itemId: "cq_n",
        payloadFingerprint: fp,
        displayText: "n",
        text: "n",
        phase: "sending",
        uncertain: true,
        uncertainCause: "network",
      },
    ]);
    const ledger = getChatOpLedger(taskId);
    expect(productOf(ledger.pending[0])).toEqual({
      persistence: "sending",
      terminalKnowledge: "none",
      networkUncertain: true,
    });
    expect(projectPendingUncertain(productOf(ledger.pending[0]))).toBe(true);
    expect(
      findReusableUncertainOperation(ledger.pending, fp)?.itemId,
    ).toBe("cq_n");
  });

  it("persisted → 隐藏本地占位；缺 terminal 不当 unknown", () => {
    const taskId = "mig_persisted";
    const fp = fingerprintFromChatSendArgs({ text: "p" });
    seedLegacyStore(taskId, [
      {
        itemId: "cq_p",
        payloadFingerprint: fp,
        displayText: "p",
        text: "p",
        phase: "persisted",
      },
    ]);
    const p = getChatOpLedger(taskId).pending[0];
    expect(productOf(p)).toEqual({
      persistence: "persisted",
      terminalKnowledge: "none",
      networkUncertain: false,
    });
    expect(shouldHideLocalPlaceholder(productOf(p))).toBe(true);
    expect(projectPendingUncertain(productOf(p))).toBe(false);
  });

  it("persisted + unknown_terminal → 三轴全对；late HTTP 不清草稿；retry 命中", () => {
    const taskId = "mig_unk";
    const fp = fingerprintFromChatSendArgs({ text: "u" });
    seedLegacyStore(taskId, [
      {
        itemId: "cq_u",
        payloadFingerprint: fp,
        displayText: "u",
        text: "u",
        images: [{ n: 1 }],
        attachments: ["/a"],
        skillRefs: [{ name: "sk", absPath: "/sk" }],
        phase: "persisted",
        uncertainCause: "unknown_terminal",
        uncertain: true,
      },
    ], {
      settled: ["cq_old_settled"],
      outcomes: { cq_old_settled: "delivered" },
    });

    const first = getChatOpLedger(taskId);
    const p = first.pending[0];
    expect(productOf(p)).toEqual({
      persistence: "persisted",
      terminalKnowledge: "unknown",
      networkUncertain: false,
    });
    expect(shouldHideLocalPlaceholder(productOf(p))).toBe(true);
    expect(projectPendingUncertain(productOf(p))).toBe(true);
    expect(p?.attachments).toEqual(["/a"]);
    expect(p?.skillRefs).toEqual([{ name: "sk", absPath: "/sk" }]);
    expect(first.settled).toEqual(["cq_old_settled"]);
    expect(first.outcomes).toEqual({ cq_old_settled: "delivered" });
    expect(findReusableUncertainOperation(first.pending, fp)?.itemId).toBe(
      "cq_u",
    );

    // reducer 链：late queued 不清草稿（unknown 保留）
    const afterQueued = reduceChatOperation(first, {
      type: "http_queued",
      itemId: "cq_u",
    });
    expect(
      afterQueued.state.pending.find((x) => x.itemId === "cq_u")
        ?.terminalKnowledge,
    ).toBe("unknown");

    // 幂等：再读一遍结果相同
    const second = getChatOpLedger(taskId);
    expect(productOf(second.pending[0])).toEqual(productOf(p));
    expect(second.settled).toEqual(["cq_old_settled"]);
    expect(second.outcomes).toEqual({ cq_old_settled: "delivered" });
  });
});

describe("R42-1：R42 已存在时仍收割晚到的 R36", () => {
  it("现行有数据 → seed legacy → 合并：legacy 独有进来、同 id 保留现行、legacy key 删除", () => {
    const taskId = "mig_late_harvest";
    const fpCur = fingerprintFromChatSendArgs({ text: "current-wins" });
    const fpLeg = fingerprintFromChatSendArgs({ text: "legacy-only" });

    // 先让新 chunk 建好 R42（模拟 HMR 后任何一次 get/dispatch）
    setChatOpLedger(taskId, {
      pending: [
        {
          itemId: "cq_shared",
          payloadFingerprint: fpCur,
          displayText: "current-wins",
          text: "current-wins",
          persistence: "persisted",
          terminalKnowledge: "none",
          networkUncertain: true,
        },
        {
          itemId: "cq_cur_only",
          payloadFingerprint: fingerprintFromChatSendArgs({ text: "cur-only" }),
          displayText: "cur-only",
          text: "cur-only",
          persistence: "sending",
          terminalKnowledge: "none",
          networkUncertain: false,
        },
      ],
      settled: ["cq_cur_settled"],
      outcomes: { cq_cur_settled: "delivered" },
    });
    expect(
      (globalThis as Record<string, unknown>)[CURRENT_KEY],
    ).toBeTruthy();

    // 旧 chunk 残留闭包晚写 R36（含同 id 旧文案 + legacy 独有 retry identity）
    seedLegacyStore(
      taskId,
      [
        {
          itemId: "cq_shared",
          payloadFingerprint: "stale-fp",
          displayText: "legacy-stale",
          text: "legacy-stale",
          phase: "sending",
        },
        {
          itemId: "cq_leg_only",
          payloadFingerprint: fpLeg,
          displayText: "legacy-only",
          text: "legacy-only",
          phase: "persisted",
          uncertain: true,
          uncertainCause: "network",
        },
      ],
      {
        keepCurrent: true,
        settled: ["cq_leg_settled", "cq_cur_settled"],
        outcomes: {
          cq_leg_settled: "failed",
          cq_cur_settled: "failed", // 同 key：现行 delivered 优先
        },
      },
    );
    expect(
      (globalThis as Record<string, unknown>)[LEGACY_KEY],
    ).toBeTruthy();

    const ledger = getChatOpLedger(taskId);
    const byId = new Map(ledger.pending.map((p) => [p.itemId, p]));

    // 同 id：现行不被覆盖
    expect(productOf(byId.get("cq_shared"))).toEqual({
      persistence: "persisted",
      terminalKnowledge: "none",
      networkUncertain: true,
    });
    expect(byId.get("cq_shared")?.displayText).toBe("current-wins");
    expect(byId.get("cq_shared")?.payloadFingerprint).toBe(fpCur);

    // legacy 独有进来（含三轴升级）
    expect(productOf(byId.get("cq_leg_only"))).toEqual({
      persistence: "persisted",
      terminalKnowledge: "none",
      networkUncertain: true,
    });
    expect(
      findReusableUncertainOperation(ledger.pending, fpLeg)?.itemId,
    ).toBe("cq_leg_only");

    // 现行独有仍在
    expect(byId.get("cq_cur_only")?.displayText).toBe("cur-only");

    // settled 去重合并；outcomes 现行优先
    expect(ledger.settled).toContain("cq_cur_settled");
    expect(ledger.settled).toContain("cq_leg_settled");
    expect(ledger.outcomes.cq_cur_settled).toBe("delivered");
    expect(ledger.outcomes.cq_leg_settled).toBe("failed");

    const g = globalThis as Record<string, unknown>;
    expect(g[LEGACY_KEY]).toBeUndefined();
    expect(g[CURRENT_KEY]).toBeTruthy();
  });
});

describe("R42 ledger migration：幂等 / listener / 旧 phase=uncertain", () => {
  it("migration 跑两遍结果相同；listener 订阅不受影响", () => {
    const taskId = "mig_idem";
    const fp = fingerprintFromChatSendArgs({ text: "i" });
    const store = seedLegacyStore(taskId, [
      {
        itemId: "cq_i",
        payloadFingerprint: fp,
        displayText: "i",
        text: "i",
        phase: "uncertain",
        uncertain: true,
      },
    ]);

    let notifyCount = 0;
    const listener = () => {
      notifyCount += 1;
    };
    store.listeners.set(taskId, new Set([listener]));

    const a = getChatOpLedger(taskId);
    const b = getChatOpLedger(taskId);
    expect(productOf(a.pending[0])).toEqual({
      persistence: "sending",
      terminalKnowledge: "none",
      networkUncertain: true,
    });
    expect(productOf(b.pending[0])).toEqual(productOf(a.pending[0]));

    // 迁移本身不刷 listener；后续 dispatch 仍通知同一订阅者
    expect(notifyCount).toBe(0);
    dispatchChatOp(taskId, {
      type: "http_reject_network",
      itemId: "cq_i",
    });
    expect(notifyCount).toBe(1);

    // 也可经 subscribeChatOp 挂新 listener（现行 store）
    let subCount = 0;
    const unsub = subscribeChatOp(taskId, () => {
      subCount += 1;
    });
    dispatchChatOp(taskId, {
      type: "user_reply",
      ev: { text: "i", meta: { queueItemId: "cq_i" } },
    });
    expect(subCount).toBe(1);
    unsub();
  });
});
