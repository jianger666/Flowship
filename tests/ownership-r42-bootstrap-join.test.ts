/**
 * R42 / R41-1：bootstrap active 只能单调 join，不得 clearAllUncertainty。
 *
 * 退出矩阵：
 * 1) persisted → network reject → active bootstrap → same fingerprint 复用原 id
 * 2) unknown↔active 两种顺序保持 unknown；late queued/direct 不清草稿；known 收敛
 * 3) queue_state active 不执行格外 destructive clear（与 r41 排列互补）
 * 4) submit-controller + reducer：fetch reject 留 draft → reconnect active → 重发复用 id
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetChatOpLedgerForTests,
  dispatchChatOp,
  getChatOpLedger,
  setChatOpLedger,
} from "@/lib/chat-op-ledger";
import { fingerprintFromChatSendArgs } from "@/lib/chat-payload-fingerprint";
import {
  emptyChatOpState,
  findReusableUncertainOperation,
  projectPendingUncertain,
  reduceChatOperation,
  shouldHideLocalPlaceholder,
  type ChatOperation,
  type PendingProductState,
} from "@/lib/chat-pending-reconcile";
import {
  commitHttpChatReject,
  commitHttpChatReply,
} from "@/lib/chat-submit-controller";
import type { Task } from "@/lib/types";

afterEach(() => {
  __resetChatOpLedgerForTests();
});

const op = (
  partial: Partial<ChatOperation> &
    Pick<ChatOperation, "itemId" | "payloadFingerprint" | "displayText">,
): ChatOperation => ({
  text: partial.text ?? partial.displayText,
  persistence: "sending",
  terminalKnowledge: "none",
  networkUncertain: false,
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

const productOf = (p: ChatOperation | undefined): PendingProductState => ({
  persistence: p?.persistence ?? "sending",
  terminalKnowledge: p?.terminalKnowledge ?? "none",
  networkUncertain: p?.networkUncertain ?? false,
});

describe("R42-① persisted → network reject → active bootstrap → retry 复用", () => {
  it("同 fingerprint 保留原 itemId；payload 变化换新 id", () => {
    const taskId = "r42_boot_retry";
    const text = "boot-retry";
    const itemId = "cq_r42_boot_retry";
    const fp = fingerprintFromChatSendArgs({ text });

    dispatchChatOp(taskId, {
      type: "register",
      op: op({ itemId, payloadFingerprint: fp, displayText: text, text }),
    });
    dispatchChatOp(taskId, {
      type: "user_reply",
      ev: { text, meta: { queueItemId: itemId } },
    });
    const rejected = commitHttpChatReject({
      operationTaskId: taskId,
      clientItemId: itemId,
      kind: "network",
    });
    expect(rejected.clearDraft).toBe(false);
    expect(
      productOf(
        rejected.reduceResult.state.pending.find((p) => p.itemId === itemId),
      ),
    ).toEqual({
      persistence: "persisted",
      terminalKnowledge: "none",
      networkUncertain: true,
    });

    // watch 重连：server 仍 active/persisted——不得擦 network 位
    dispatchChatOp(taskId, {
      type: "queue_state",
      serverItemIds: [itemId],
      recentSettled: [],
      operationSnapshot: [
        { itemId, phase: "persisted", fingerprint: fp },
      ],
    });
    const afterBoot = getChatOpLedger(taskId).pending.find(
      (p) => p.itemId === itemId,
    );
    expect(productOf(afterBoot)).toEqual({
      persistence: "persisted",
      terminalKnowledge: "none",
      networkUncertain: true,
    });
    // fail-closed：UI 仍投影「发送状态未知」；persisted 仍隐藏本地占位
    expect(projectPendingUncertain(productOf(afterBoot))).toBe(true);
    expect(shouldHideLocalPlaceholder(productOf(afterBoot))).toBe(true);

    expect(
      findReusableUncertainOperation(getChatOpLedger(taskId).pending, fp)
        ?.itemId,
    ).toBe(itemId);

    expect(
      findReusableUncertainOperation(
        getChatOpLedger(taskId).pending,
        fingerprintFromChatSendArgs({ text: "boot-retry!" }),
      ),
    ).toBeUndefined();
  });
});

describe("R42-② unknown terminal ↔ active bootstrap 交换律", () => {
  const runOrder = (order: "unknown_first" | "active_first") => {
    const itemId = `cq_r42_${order}`;
    const fp = fingerprintFromChatSendArgs({ text: order });
    let state = emptyChatOpState();
    state = reduceChatOperation(state, {
      type: "register",
      op: op({ itemId, payloadFingerprint: fp, displayText: order }),
    }).state;

    const applyUnknown = () => {
      state = reduceChatOperation(state, {
        type: "http_settled",
        itemId,
        outcome: "future_failure_reason",
      }).state;
    };
    const applyActive = () => {
      state = reduceChatOperation(state, {
        type: "queue_state",
        serverItemIds: [itemId],
        operationSnapshot: [
          { itemId, phase: "accepting", fingerprint: fp },
        ],
      }).state;
    };

    if (order === "unknown_first") {
      applyUnknown();
      applyActive();
    } else {
      applyActive();
      applyUnknown();
    }
    return { state, itemId, product: productOf(state.pending[0]) };
  };

  it("两种顺序结果一致并保持 unknown", () => {
    const a = runOrder("unknown_first");
    const b = runOrder("active_first");
    expect(a.product).toEqual(b.product);
    expect(a.product).toEqual({
      persistence: "sending",
      terminalKnowledge: "unknown",
      networkUncertain: false,
    });
    expect(projectPendingUncertain(a.product)).toBe(true);
  });

  it("late queued/direct 不清草稿；known terminal 才收敛", () => {
    for (const order of ["unknown_first", "active_first"] as const) {
      for (const mode of ["queued", "direct"] as const) {
        const { state: start, itemId } = runOrder(order);
        const taskId = `r42_${order}_${mode}`;
        setChatOpLedger(taskId, start);
        const c = commitHttpChatReply({
          operationTaskId: taskId,
          clientItemId: itemId,
          result:
            mode === "queued"
              ? {
                  queued: true,
                  queuedCount: 1,
                  itemId,
                  task: stubTask(taskId),
                }
              : { task: stubTask(taskId), autoStarted: false },
        });
        expect(c.clearDraft, `${order}/${mode}`).toBe(false);
        const p = productOf(
          getChatOpLedger(taskId).pending.find((x) => x.itemId === itemId),
        );
        expect(p.terminalKnowledge, `${order}/${mode}`).toBe("unknown");

        dispatchChatOp(taskId, {
          type: "message_op",
          itemId,
          outcome: "delivered",
        });
        expect(getChatOpLedger(taskId).outcomes[itemId]).toBe("delivered");
        expect(
          getChatOpLedger(taskId).pending.find((x) => x.itemId === itemId),
        ).toBeUndefined();
      }
    }
  });
});

describe("R42-③ queue_state active 无格外 destructive clear", () => {
  it("network + unknown 后 active bootstrap 两轴仍保留", () => {
    const itemId = "cq_r42_no_clear";
    const fp = fingerprintFromChatSendArgs({ text: "no-clear" });
    let state = emptyChatOpState();
    state = reduceChatOperation(state, {
      type: "register",
      op: op({ itemId, payloadFingerprint: fp, displayText: "no-clear" }),
    }).state;
    state = reduceChatOperation(state, {
      type: "user_reply",
      ev: { text: "no-clear", meta: { queueItemId: itemId } },
    }).state;
    state = reduceChatOperation(state, {
      type: "http_reject_network",
      itemId,
    }).state;
    state = reduceChatOperation(state, {
      type: "message_op",
      itemId,
      outcome: "weird_future",
    }).state;
    expect(productOf(state.pending[0])).toEqual({
      persistence: "persisted",
      terminalKnowledge: "unknown",
      networkUncertain: true,
    });

    state = reduceChatOperation(state, {
      type: "queue_state",
      serverItemIds: [itemId],
      operationSnapshot: [
        { itemId, phase: "persisted", fingerprint: fp },
      ],
    }).state;
    expect(productOf(state.pending[0])).toEqual({
      persistence: "persisted",
      terminalKnowledge: "unknown",
      networkUncertain: true,
    });
  });
});

describe("R42-④ submit 链：reject 留 draft → reconnect → 重发复用", () => {
  it("commitHttpChatReject → queue_state active → findReusable 原 id", () => {
    const taskId = "r42_submit_chain";
    const text = "submit-chain";
    const itemId = "cq_r42_submit";
    const fp = fingerprintFromChatSendArgs({ text });

    dispatchChatOp(taskId, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: fp,
        displayText: text,
        text,
        images: [{ name: "a.png" }],
        attachments: ["/tmp/a"],
        skillRefs: [{ name: "s", absPath: "/s" }],
      }),
    });
    dispatchChatOp(taskId, {
      type: "user_reply",
      ev: { text, meta: { queueItemId: itemId } },
    });

    // 模拟 ChatView catch：HTTP 丢失 → network reject，composer 留草稿
    const rejected = commitHttpChatReject({
      operationTaskId: taskId,
      clientItemId: itemId,
      kind: "network",
    });
    expect(rejected.clearDraft).toBe(false);

    // 模拟 useTaskWatch 重连 onQueueState → dispatch queue_state
    dispatchChatOp(taskId, {
      type: "queue_state",
      serverItemIds: [itemId],
      operationSnapshot: [
        { itemId, phase: "persisted", fingerprint: fp },
      ],
    });

    // 用户点发送：同 payload → 复用原 id（服务端幂等靠既有 server 测）
    const reused = findReusableUncertainOperation(
      getChatOpLedger(taskId).pending,
      fp,
    );
    expect(reused?.itemId).toBe(itemId);
    expect(reused?.attachments).toEqual(["/tmp/a"]);
    expect(reused?.skillRefs).toEqual([{ name: "s", absPath: "/s" }]);
  });
});
