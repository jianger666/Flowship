/**
 * R38-client-dispatch：第三十七轮验收 R37-1 / R37-2 / R37-4 / R37-5 退出矩阵
 *
 * ① 生产 sendChatReply 解码 + 提交控制器：仅 delivered 清草稿
 * ② message_op failed 先到 → 202/200 HTTP 晚到：不得清草稿
 * ③ A fetch deferred → 切 B → 两序 resolve：ledger / 提交锁 / task 快照不串
 * ④ unknown → known：保留 retry identity，后到 known 恰好一次收敛
 * ⑤ 500 terminal 后 settled∩outcomes 同为 200；active/persisted 保留；切 A→B→A 不变
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetChatOpLedgerForTests,
  dispatchChatOp,
  getChatOpLedger,
  setChatOpLedger,
} from "@/lib/chat-op-ledger";
import { fingerprintFromChatSendArgs } from "@/lib/chat-payload-fingerprint";
import {
  SETTLED_ITEM_IDS_MAX,
  emptyChatOpState,
  findReusableUncertainOperation,
  reduceChatOperation,
  type ChatOperation,
} from "@/lib/chat-pending-reconcile";
import {
  commitHttpChatReply,
  shouldApplyTaskUpdateForOperation,
  shouldClearDraftForOutcome,
  shouldReleaseSubmitLock,
} from "@/lib/chat-submit-controller";
import { MESSAGE_OP_FAILURE_OUTCOMES } from "@/lib/message-op-schema";
import { sendChatReply } from "@/lib/task-store";
import type { Task } from "@/lib/types";

afterEach(() => {
  __resetChatOpLedgerForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const op = (
  partial: Partial<ChatOperation> &
    Pick<ChatOperation, "itemId" | "payloadFingerprint" | "displayText">,
): ChatOperation => ({
  text: partial.text ?? partial.displayText,
  phase: partial.phase ?? "sending",
  ...partial,
});

const stubTask = (id: string): Task =>
  ({
    id,
    title: id,
    mode: "chat",
    runStatus: "idle",
    repoStatus: "idle",
    events: [],
    repoPaths: [],
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as Task;

const mockSettledResponse = (body: {
  settled: true;
  itemId: string;
  outcome?: string;
  task?: Task;
}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("R38-① sendChatReply + 提交控制器清草稿契约", () => {
  it("仅 settled delivered 返回 true；10 失败枚举 / 缺 outcome / 未知 outcome 保留草稿", async () => {
    const cases: Array<{
      label: string;
      body: { settled: true; itemId: string; outcome?: string };
      expectClear: boolean;
    }> = [
      {
        label: "delivered",
        body: {
          settled: true,
          itemId: "cq_ok",
          outcome: "delivered",
        },
        expectClear: true,
      },
      ...MESSAGE_OP_FAILURE_OUTCOMES.map((outcome) => ({
        label: outcome,
        body: {
          settled: true as const,
          itemId: `cq_${outcome}`,
          outcome,
        },
        expectClear: false,
      })),
      {
        label: "missing_outcome",
        body: { settled: true, itemId: "cq_missing" },
        expectClear: false,
      },
      {
        label: "unknown_outcome",
        body: {
          settled: true,
          itemId: "cq_weird",
          outcome: "future_failure_reason",
        },
        expectClear: false,
      },
    ];

    expect(cases).toHaveLength(1 + MESSAGE_OP_FAILURE_OUTCOMES.length + 2);

    for (const c of cases) {
      __resetChatOpLedgerForTests();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => mockSettledResponse(c.body)),
      );

      const decoded = await sendChatReply(
        "task_decode",
        "hi",
        undefined,
        undefined,
        undefined,
        undefined,
        c.body.itemId,
        "fp",
      );
      expect("settled" in decoded && decoded.settled, c.label).toBe(true);
      if (!("settled" in decoded) || !decoded.settled) continue;

      // R37-1：生产解码不得合成 delivered
      if (c.label === "missing_outcome") {
        expect(decoded.outcome, c.label).toBeUndefined();
      }

      dispatchChatOp("task_decode", {
        type: "register",
        op: op({
          itemId: c.body.itemId,
          payloadFingerprint: "fp",
          displayText: "hi",
        }),
      });
      const committed = commitHttpChatReply({
        operationTaskId: "task_decode",
        clientItemId: c.body.itemId,
        result: decoded,
      });
      expect(committed.clearDraft, c.label).toBe(c.expectClear);
      expect(
        shouldClearDraftForOutcome(
          committed.reduceResult.state.outcomes[c.body.itemId],
        ),
        c.label,
      ).toBe(c.expectClear);
    }
  });
});

describe("R38-② message_op failed 先到 → HTTP 晚到", () => {
  it.each(["queued", "direct", "settled_delivered"] as const)(
    "%s 晚到不得清草稿",
    (kind) => {
      const taskId = "task_sse_first";
      const itemId = "cq_sse_fail";
      dispatchChatOp(taskId, {
        type: "register",
        op: op({
          itemId,
          payloadFingerprint: "fp",
          displayText: "x",
        }),
      });
      // SSE 失败终态先到
      dispatchChatOp(taskId, {
        type: "message_op",
        itemId,
        outcome: "startup_failed",
      });
      expect(getChatOpLedger(taskId).outcomes[itemId]).toBe("failed");

      if (kind === "queued") {
        const committed = commitHttpChatReply({
          operationTaskId: taskId,
          clientItemId: itemId,
          result: {
            queued: true,
            queuedCount: 1,
            itemId,
            task: stubTask(taskId),
          },
        });
        expect(committed.clearDraft).toBe(false);
      } else if (kind === "direct") {
        const committed = commitHttpChatReply({
          operationTaskId: taskId,
          clientItemId: itemId,
          result: {
            task: stubTask(taskId),
            autoStarted: false,
          },
        });
        expect(committed.clearDraft).toBe(false);
      } else {
        // 晚到的 HTTP 甚至宣称 delivered——first-outcome-wins 仍 failed，不得清草稿
        const committed = commitHttpChatReply({
          operationTaskId: taskId,
          clientItemId: itemId,
          result: {
            settled: true,
            itemId,
            outcome: "delivered",
            task: stubTask(taskId),
          },
        });
        expect(committed.clearDraft).toBe(false);
        expect(getChatOpLedger(taskId).outcomes[itemId]).toBe("failed");
      }
    },
  );
});

describe("R38-③ 跨任务 dispatch / 提交锁 / task 快照隔离", () => {
  it("A→B 与 B→A 两序 resolve：ledger / 锁 / onTaskUpdate 不串；切回 A 复用原 id", () => {
    const taskA = "task_A";
    const taskB = "task_B";
    const fpA = fingerprintFromChatSendArgs({ text: "from-A" });
    const itemA = "cq_from_a";
    const itemB = "cq_from_b";

    // A 发起：捕获不可变 owner + 提交 token
    let currentTaskId = taskA;
    let submitToken: string | null = "tok_A";
    let isSubmitting = true;
    const taskUpdates: string[] = [];

    dispatchChatOp(taskA, {
      type: "register",
      op: op({
        itemId: itemA,
        payloadFingerprint: fpA,
        displayText: "from-A",
        phase: "uncertain",
      }),
    });

    // 切 B：作废 A 的 UI 锁（与 ChatView effect 一致）
    currentTaskId = taskB;
    submitToken = null;
    isSubmitting = false;

    // B 再发一条
    const tokB = "tok_B";
    submitToken = tokB;
    isSubmitting = true;
    dispatchChatOp(taskB, {
      type: "register",
      op: op({
        itemId: itemB,
        payloadFingerprint: "fp_b",
        displayText: "from-B",
      }),
    });

    const applyHttp = (
      order: "A_then_B" | "B_then_A",
    ): void => {
      const applyA = () => {
        const committed = commitHttpChatReply({
          operationTaskId: taskA,
          clientItemId: itemA,
          result: {
            queued: true,
            queuedCount: 1,
            itemId: itemA,
            task: stubTask(taskA),
          },
        });
        // A 的 finally 不得释放 B 的锁
        if (shouldReleaseSubmitLock(submitToken, "tok_A")) {
          submitToken = null;
          isSubmitting = false;
        }
        if (
          committed.task &&
          shouldApplyTaskUpdateForOperation(currentTaskId, taskA)
        ) {
          taskUpdates.push(committed.task.id);
        }
        void committed.clearDraft;
      };
      const applyB = () => {
        const committed = commitHttpChatReply({
          operationTaskId: taskB,
          clientItemId: itemB,
          result: {
            settled: true,
            itemId: itemB,
            outcome: "delivered",
            task: stubTask(taskB),
          },
        });
        if (shouldReleaseSubmitLock(submitToken, tokB)) {
          submitToken = null;
          isSubmitting = false;
        }
        if (
          committed.task &&
          shouldApplyTaskUpdateForOperation(currentTaskId, taskB)
        ) {
          taskUpdates.push(committed.task.id);
        }
      };
      if (order === "A_then_B") {
        applyA();
        applyB();
      } else {
        applyB();
        applyA();
      }
    };

    // 两种到达顺序各跑一遍（第二次先重置 B 终态相关）
    for (const order of ["A_then_B", "B_then_A"] as const) {
      __resetChatOpLedgerForTests();
      taskUpdates.length = 0;
      currentTaskId = taskB;
      submitToken = tokB;
      isSubmitting = true;

      dispatchChatOp(taskA, {
        type: "register",
        op: op({
          itemId: itemA,
          payloadFingerprint: fpA,
          displayText: "from-A",
          phase: "uncertain",
        }),
      });
      dispatchChatOp(taskB, {
        type: "register",
        op: op({
          itemId: itemB,
          payloadFingerprint: "fp_b",
          displayText: "from-B",
        }),
      });

      applyHttp(order);

      // A item 只在 A ledger
      expect(
        getChatOpLedger(taskA).pending.some((p) => p.itemId === itemA) ||
          getChatOpLedger(taskA).settled.includes(itemA),
      ).toBe(true);
      expect(
        getChatOpLedger(taskB).pending.some((p) => p.itemId === itemA),
      ).toBe(false);
      expect(getChatOpLedger(taskB).settled).not.toContain(itemA);

      // B item 只在 B
      expect(getChatOpLedger(taskB).outcomes[itemB]).toBe("delivered");
      expect(getChatOpLedger(taskA).outcomes[itemB]).toBeUndefined();

      // 当前页是 B：A 的 task 快照不得推父级
      expect(taskUpdates).not.toContain(taskA);
      expect(taskUpdates).toContain(taskB);

      // B 的锁由 B 自己释放；A finally 不得提前解开（两序结束后应已释放）
      expect(isSubmitting).toBe(false);
      expect(submitToken).toBeNull();
    }

    // 切回 A：复用原 uncertain id
    currentTaskId = taskA;
    const restored = getChatOpLedger(taskA);
    // A 若走了 queued 仍可能在 pending；标 uncertain 以便复用
    dispatchChatOp(taskA, {
      type: "http_reject_network",
      itemId: itemA,
    });
    const afterNet = getChatOpLedger(taskA);
    expect(
      findReusableUncertainOperation(afterNet.pending, fpA)?.itemId ??
        findReusableUncertainOperation(restored.pending, fpA)?.itemId,
    ).toBe(itemA);
  });

  it("shouldReleaseSubmitLock / shouldApplyTaskUpdate 纯函数边界", () => {
    expect(shouldReleaseSubmitLock("tok_B", "tok_A")).toBe(false);
    expect(shouldReleaseSubmitLock("tok_A", "tok_A")).toBe(true);
    expect(shouldReleaseSubmitLock(null, "tok_A")).toBe(false);
    expect(shouldApplyTaskUpdateForOperation("task_B", "task_A")).toBe(
      false,
    );
    expect(shouldApplyTaskUpdateForOperation("task_A", "task_A")).toBe(
      true,
    );
  });
});

describe("R38-④ unknown → known 可纠正", () => {
  it("unknown → delivered 与每个失败枚举：保留 retry identity，known 恰好一次收敛", () => {
    const targets: Array<"delivered" | (typeof MESSAGE_OP_FAILURE_OUTCOMES)[number]> =
      ["delivered", ...MESSAGE_OP_FAILURE_OUTCOMES];

    for (const known of targets) {
      const itemId = `cq_unk_${known}`;
      const fp = fingerprintFromChatSendArgs({ text: known });
      let state = emptyChatOpState();
      state = reduceChatOperation(state, {
        type: "register",
        op: op({
          itemId,
          payloadFingerprint: fp,
          displayText: known,
        }),
      }).state;

      // 未知 wire 先到
      state = reduceChatOperation(state, {
        type: "message_op",
        itemId,
        outcome: "future_failure_reason",
      }).state;
      expect(state.outcomes[itemId], known).toBeUndefined();
      expect(state.settled, known).not.toContain(itemId);
      expect(state.pending.find((p) => p.itemId === itemId)?.phase, known).toBe(
        "uncertain",
      );
      expect(
        findReusableUncertainOperation(state.pending, fp)?.itemId,
        known,
      ).toBe(itemId);

      // 后到 known 恰好一次收敛
      state = reduceChatOperation(state, {
        type: "message_op",
        itemId,
        outcome: known,
      }).state;
      const expected =
        known === "delivered" ? "delivered" : "failed";
      expect(state.outcomes[itemId], known).toBe(expected);
      expect(state.settled, known).toContain(itemId);
      expect(
        state.pending.find((p) => p.itemId === itemId),
        known,
      ).toBeUndefined();

      // first-outcome-wins：再来反向 known 不得覆盖
      const flip = known === "delivered" ? "stopped" : "delivered";
      state = reduceChatOperation(state, {
        type: "message_op",
        itemId,
        outcome: flip,
      }).state;
      expect(state.outcomes[itemId], known).toBe(expected);
    }
  });

  it("http_settled 缺 outcome / queue_state unknown 同策略", () => {
    const itemId = "cq_http_unk";
    let state = emptyChatOpState();
    state = reduceChatOperation(state, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: "fp",
        displayText: "u",
      }),
    }).state;
    state = reduceChatOperation(state, {
      type: "http_settled",
      itemId,
      // 缺失
    }).state;
    expect(state.outcomes[itemId]).toBeUndefined();
    expect(state.pending[0]?.phase).toBe("uncertain");

    state = reduceChatOperation(state, {
      type: "http_settled",
      itemId,
      outcome: "stopped",
    }).state;
    expect(state.outcomes[itemId]).toBe("failed");

    const item2 = "cq_qs_unk";
    let qs = emptyChatOpState();
    qs = reduceChatOperation(qs, {
      type: "register",
      op: op({
        itemId: item2,
        payloadFingerprint: "fp2",
        displayText: "q",
      }),
    }).state;
    qs = reduceChatOperation(qs, {
      type: "queue_state",
      serverItemIds: [],
      recentSettled: [{ itemId: item2, outcome: "weird" }],
    }).state;
    expect(qs.outcomes[item2]).toBeUndefined();
    expect(qs.settled).not.toContain(item2);
    expect(qs.pending[0]?.phase).toBe("uncertain");

    qs = reduceChatOperation(qs, {
      type: "queue_state",
      serverItemIds: [],
      recentSettled: [{ itemId: item2, outcome: "delivered" }],
    }).state;
    expect(qs.outcomes[item2]).toBe("delivered");
    expect(qs.pending).toHaveLength(0);
  });
});

describe("R38-⑤ settled 与 outcomes 同界淘汰", () => {
  it("500 terminal 后 key 集同为 200；夹入 active/persisted 仍完整；切 A→B→A 不变", () => {
    const taskA = "cap_A";
    const taskB = "cap_B";
    const activeId = "cq_active_keep";
    const persistedId = "cq_persisted_keep";

    dispatchChatOp(taskA, {
      type: "register",
      op: op({
        itemId: activeId,
        payloadFingerprint: "fp_a",
        displayText: "active",
        phase: "sending",
      }),
    });
    dispatchChatOp(taskA, {
      type: "register",
      op: op({
        itemId: persistedId,
        payloadFingerprint: "fp_p",
        displayText: "persisted",
        phase: "persisted",
      }),
    });

    for (let i = 0; i < 500; i++) {
      const itemId = `cq_term_${i}`;
      dispatchChatOp(taskA, {
        type: "register",
        op: op({
          itemId,
          payloadFingerprint: `fp_${i}`,
          displayText: String(i),
        }),
      });
      dispatchChatOp(taskA, {
        type: "message_op",
        itemId,
        outcome: i % 2 === 0 ? "delivered" : "stopped",
      });
    }

    let state = getChatOpLedger(taskA);
    expect(state.settled).toHaveLength(SETTLED_ITEM_IDS_MAX);
    expect(Object.keys(state.outcomes)).toHaveLength(SETTLED_ITEM_IDS_MAX);
    const settledSet = new Set(state.settled);
    expect(Object.keys(state.outcomes).every((k) => settledSet.has(k))).toBe(
      true,
    );
    expect(state.settled.every((k) => k in state.outcomes)).toBe(true);

    // active/persisted 不淘汰
    expect(state.pending.find((p) => p.itemId === activeId)?.phase).toBe(
      "sending",
    );
    expect(state.pending.find((p) => p.itemId === persistedId)?.phase).toBe(
      "persisted",
    );

    // 切 A→B→A 边界不变
    setChatOpLedger(taskB, emptyChatOpState());
    const mid = getChatOpLedger(taskA);
    expect(mid.settled).toHaveLength(SETTLED_ITEM_IDS_MAX);
    expect(Object.keys(mid.outcomes)).toHaveLength(SETTLED_ITEM_IDS_MAX);
    state = getChatOpLedger(taskA);
    expect(state.settled).toEqual(mid.settled);
    expect(state.outcomes).toEqual(mid.outcomes);
    expect(state.pending.map((p) => p.itemId).sort()).toEqual(
      [activeId, persistedId].sort(),
    );
  });
});
