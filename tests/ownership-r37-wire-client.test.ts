/**
 * R37-wire-client：共享 wire schema + client reducer 只消费明确 phase
 *
 * ① outcome 全枚举表驱动：除 delivered 全 failed；未知 fail-closed
 * ② user_reply 后注入失败 → 未送达 / 后到 failed 生效
 * ③ 只有 handedOff/delivered 终态清成功
 * ④ claim/persisted/handoff 前重连 → 保持 active（不 ghost 不 delivered）
 * ⑤ server 重启丢 ledger → uncertain 不 clearDraft
 * ⑥ 切 A→B→A 后同 payload 重试复用原 id
 * ⑦ watch 503/404 不 commit deleted；410/task_deleted 才 sticky
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetChatOpLedgerForTests,
  clearChatOpLedger,
  getChatOpLedger,
  setChatOpLedger,
} from "@/lib/chat-op-ledger";
import { fingerprintFromChatSendArgs } from "@/lib/chat-payload-fingerprint";
import {
  emptyChatOpState,
  findReusableUncertainOperation,
  normalizeLedgerOutcome,
  reduceChatOperation,
  type ChatOperation,
} from "@/lib/chat-pending-reconcile";
import {
  MESSAGE_OP_FAILURE_OUTCOMES,
  MESSAGE_OP_OUTCOMES,
  decodeMessageOpOutcome,
  normalizeWireOutcomeToLedger,
} from "@/lib/message-op-schema";
import {
  __resetTaskTerminalForTests,
  classifyWatchHttpStatus,
  commitTaskDeleted,
  isTaskTerminalDeleted,
} from "@/lib/task-terminal";

afterEach(() => {
  __resetChatOpLedgerForTests();
  __resetTaskTerminalForTests();
});

const op = (
  partial: Partial<ChatOperation> &
    Pick<ChatOperation, "itemId" | "payloadFingerprint" | "displayText">,
): ChatOperation => ({
  text: partial.text ?? partial.displayText,
  phase: partial.phase ?? "sending",
  ...partial,
});

describe("R37-① outcome 全枚举表驱动 server→JSON→client", () => {
  it("除 delivered 外全部 failed；未知 fail-closed", () => {
    for (const outcome of MESSAGE_OP_OUTCOMES) {
      // 模拟 server→JSON→client
      const wire = JSON.parse(JSON.stringify({ outcome })) as {
        outcome: string;
      };
      const decoded = decodeMessageOpOutcome(wire.outcome);
      expect(decoded.known).toBe(true);
      if (!decoded.known) continue;
      const ledger = normalizeWireOutcomeToLedger(wire.outcome);
      if (outcome === "delivered") {
        expect(ledger).toBe("delivered");
      } else {
        expect(MESSAGE_OP_FAILURE_OUTCOMES).toContain(outcome);
        expect(ledger).toBe("failed");
      }
      // HTTP settled / queue_state 同入口
      let state = emptyChatOpState();
      state = reduceChatOperation(state, {
        type: "register",
        op: op({
          itemId: `cq_${outcome}`,
          payloadFingerprint: "fp",
          displayText: outcome,
        }),
      }).state;
      state = reduceChatOperation(state, {
        type: "http_settled",
        itemId: `cq_${outcome}`,
        outcome: wire.outcome,
      }).state;
      expect(state.outcomes[`cq_${outcome}`]).toBe(
        outcome === "delivered" ? "delivered" : "failed",
      );
    }

    // Codex 6/6 反例：曾被启发式当成 delivered
    for (const bad of [
      "stopped",
      "error",
      "no_session",
      "task_gone",
      "rewound",
      "deleted",
      "flush_error",
    ] as const) {
      expect(normalizeLedgerOutcome(bad)).toBe("failed");
    }

    // 未知值绝不默认 delivered
    expect(decodeMessageOpOutcome("weird_new_reason").known).toBe(false);
    expect(normalizeLedgerOutcome("weird_new_reason")).toBe("unknown");
    expect(normalizeLedgerOutcome(undefined)).toBe("unknown");
    expect(normalizeLedgerOutcome("")).toBe("unknown");
  });

  it("queue_state recentSettled 与 http_settled 同结果", () => {
    const itemId = "cq_qs_align";
    let viaHttp = emptyChatOpState();
    viaHttp = reduceChatOperation(viaHttp, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: "fp",
        displayText: "x",
      }),
    }).state;
    viaHttp = reduceChatOperation(viaHttp, {
      type: "http_settled",
      itemId,
      outcome: "stopped",
    }).state;

    let viaQs = emptyChatOpState();
    viaQs = reduceChatOperation(viaQs, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: "fp",
        displayText: "x",
      }),
    }).state;
    viaQs = reduceChatOperation(viaQs, {
      type: "queue_state",
      serverItemIds: [],
      recentSettled: [{ itemId, outcome: "stopped" }],
    }).state;

    expect(viaHttp.outcomes[itemId]).toBe("failed");
    expect(viaQs.outcomes[itemId]).toBe("failed");
  });
});

describe("R37-② user_reply 后失败可纠正", () => {
  it.each([
    "startup_failed",
    "stopped",
    "deleted",
    "error",
  ] as const)("user_reply 后 %s → 未送达且 failed 生效", (reason) => {
    const itemId = `cq_ur_${reason}`;
    let state = emptyChatOpState();
    state = reduceChatOperation(state, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: "fp",
        displayText: "hello",
        text: "hello",
      }),
    }).state;

    // 仅落盘 → persisted，非终态
    state = reduceChatOperation(state, {
      type: "user_reply",
      ev: { text: "hello", meta: { queueItemId: itemId } },
    }).state;
    expect(state.pending.find((p) => p.itemId === itemId)?.phase).toBe(
      "persisted",
    );
    expect(state.outcomes[itemId]).toBeUndefined();
    expect(state.settled).not.toContain(itemId);

    // 后到失败（queue_failed / message_op / settled）
    if (reason === "deleted") {
      state = reduceChatOperation(state, {
        type: "message_op",
        itemId,
        outcome: reason,
      }).state;
    } else if (reason === "error") {
      state = reduceChatOperation(state, {
        type: "http_settled",
        itemId,
        outcome: reason,
      }).state;
    } else {
      state = reduceChatOperation(state, {
        type: "queue_failed",
        itemIds: [itemId],
      }).state;
    }

    expect(state.outcomes[itemId]).toBe("failed");
    expect(state.pending.find((p) => p.itemId === itemId)).toBeUndefined();

    // 网络 reject 不得 clearDraft
    const rejected = reduceChatOperation(state, {
      type: "http_reject_network",
      itemId,
    });
    expect(rejected.clearDraft).toBe(false);
  });
});

describe("R37-③ 只有 handedOff/delivered 清成功", () => {
  it("done_clear 不猜成功；message_op handedOff 才 delivered", () => {
    const itemId = "cq_done_phase";
    let state = emptyChatOpState();
    state = reduceChatOperation(state, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: "fp",
        displayText: "m",
      }),
    }).state;
    state = reduceChatOperation(state, {
      type: "user_reply",
      ev: { text: "m", meta: { queueItemId: itemId } },
    }).state;

    // idle done_clear：无终态 → 保留 persisted
    const afterDone = reduceChatOperation(state, { type: "done_clear" });
    expect(afterDone.clearedIds ?? []).toHaveLength(0);
    expect(afterDone.state.pending[0]?.phase).toBe("persisted");
    expect(afterDone.state.outcomes[itemId]).toBeUndefined();

    // 成功终态唯一来源：message_op handedOff / delivered
    state = reduceChatOperation(afterDone.state, {
      type: "message_op",
      itemId,
      phase: "handedOff",
    }).state;
    expect(state.outcomes[itemId]).toBe("delivered");
    expect(state.pending).toHaveLength(0);

    const net = reduceChatOperation(state, {
      type: "http_reject_network",
      itemId,
    });
    expect(net.clearDraft).toBe(true);
  });
});

describe("R37-④ claim/persisted 重连保持 active", () => {
  it("operationSnapshot accepting/persisted → 不 ghost 不 delivered", () => {
    const itemId = "cq_snap_alive";
    let state = emptyChatOpState();
    state = reduceChatOperation(state, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: "fp_snap",
        displayText: "s",
      }),
    }).state;

    // claim 后：仅在 snapshot accepting，不在旧 queue itemIds
    state = reduceChatOperation(state, {
      type: "queue_state",
      serverItemIds: [],
      recentSettled: [],
      operationSnapshot: [
        { itemId, phase: "accepting", fingerprint: "fp_snap" },
      ],
    }).state;
    expect(state.pending).toHaveLength(1);
    expect(state.outcomes[itemId]).toBeUndefined();
    expect(state.settled).not.toContain(itemId);

    // persisted 后、handoff 前
    state = reduceChatOperation(state, {
      type: "user_reply",
      ev: { text: "s", meta: { queueItemId: itemId } },
    }).state;
    state = reduceChatOperation(state, {
      type: "queue_state",
      serverItemIds: [],
      recentSettled: [],
      operationSnapshot: [
        { itemId, phase: "persisted", fingerprint: "fp_snap" },
      ],
    }).state;
    expect(state.pending[0]?.phase).toBe("persisted");
    expect(state.outcomes[itemId]).toBeUndefined();
  });
});

describe("R37-⑤ server 重启丢 ledger → uncertain", () => {
  it("空 snapshot + 空 recentSettled → uncertain，clearDraft=false", () => {
    const itemId = "cq_restart_unc";
    const fp = fingerprintFromChatSendArgs({ text: "u" });
    let state = emptyChatOpState();
    state = reduceChatOperation(state, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: fp,
        displayText: "u",
      }),
    }).state;

    const recon = reduceChatOperation(state, {
      type: "queue_state",
      serverItemIds: [],
      recentSettled: [],
      operationSnapshot: [],
    });
    expect(recon.state.pending[0]?.phase).toBe("uncertain");
    // ghost 不写 outcomes（避免占坑挡后到真终态）
    expect(recon.state.outcomes[itemId]).toBeUndefined();
    expect(recon.state.settled).not.toContain(itemId);

    const rejected = reduceChatOperation(recon.state, {
      type: "http_reject_network",
      itemId,
    });
    expect(rejected.clearDraft).toBe(false);
    expect(
      findReusableUncertainOperation(rejected.state.pending, fp)?.itemId,
    ).toBe(itemId);
  });
});

describe("R37-⑥ 跨路由 ledger 存活", () => {
  it("切 A→B→A 后同 fingerprint 复用原 id", () => {
    const taskA = "task_a";
    const taskB = "task_b";
    const fp = fingerprintFromChatSendArgs({ text: "retry-me" });
    const itemId = "cq_route_reuse";

    let stateA = emptyChatOpState();
    stateA = reduceChatOperation(stateA, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: fp,
        displayText: "retry-me",
        phase: "uncertain",
      }),
    }).state;
    setChatOpLedger(taskA, stateA);

    // 切 B
    setChatOpLedger(taskB, emptyChatOpState());
    expect(getChatOpLedger(taskB).pending).toHaveLength(0);

    // 切回 A：store 仍有原条目
    const restored = getChatOpLedger(taskA);
    expect(
      findReusableUncertainOperation(restored.pending, fp)?.itemId,
    ).toBe(itemId);

    clearChatOpLedger(taskA);
    expect(getChatOpLedger(taskA).pending).toHaveLength(0);
  });
});

describe("R37-⑦ watch 410 vs 503/404", () => {
  it("503/404 不 commit；410/task_deleted 才 sticky", () => {
    expect(classifyWatchHttpStatus(503)).toBe("unavailable");
    expect(classifyWatchHttpStatus(404)).toBe("unavailable");
    expect(classifyWatchHttpStatus(410)).toBe("deleted");
    expect(classifyWatchHttpStatus(500)).toBe("retryable");

    const taskId = "t_r37_watch";
    // 模拟 unavailable：不调用 commit
    if (classifyWatchHttpStatus(404) === "deleted") {
      commitTaskDeleted(taskId);
    }
    if (classifyWatchHttpStatus(503) === "deleted") {
      commitTaskDeleted(taskId);
    }
    expect(isTaskTerminalDeleted(taskId)).toBe(false);

    // 410 → sticky
    if (classifyWatchHttpStatus(410) === "deleted") {
      commitTaskDeleted(taskId);
    }
    expect(isTaskTerminalDeleted(taskId)).toBe(true);

    // task_deleted 帧同 sink
    const task2 = "t_r37_frame";
    commitTaskDeleted(task2);
    expect(isTaskTerminalDeleted(task2)).toBe(true);
  });
});
