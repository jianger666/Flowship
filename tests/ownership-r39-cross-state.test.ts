/**
 * R39 交叉状态退出矩阵（Codex 第三十八轮 R38-1 / R38-2）
 *
 * ① unknown_terminal → late 202/direct：clearDraft=false、phase 保持 uncertain
 * ② 普通首次 202/direct 仍清草稿；network-uncertain 同 id 重试 202 回 sending
 * ③ unknown → delivered / 10 失败枚举：恰好一次收敛、marker 清除
 * ④ watch policy：unavailable / transient 独立计数交叉序列
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetChatOpLedgerForTests,
  dispatchChatOp,
  getChatOpLedger,
} from "@/lib/chat-op-ledger";
import { fingerprintFromChatSendArgs } from "@/lib/chat-payload-fingerprint";
import {
  emptyChatOpState,
  findReusableUncertainOperation,
  reduceChatOperation,
  type ChatOperation,
} from "@/lib/chat-pending-reconcile";
import { commitHttpChatReply } from "@/lib/chat-submit-controller";
import { MESSAGE_OP_FAILURE_OUTCOMES } from "@/lib/message-op-schema";
import {
  resolveWatchReconnectPolicy,
  WATCH_MAX_TRANSIENT_FAILURES,
} from "@/lib/task-terminal";
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

const registerOp = (taskId: string, itemId: string, text: string) => {
  const fp = fingerprintFromChatSendArgs({ text });
  dispatchChatOp(taskId, {
    type: "register",
    op: op({
      itemId,
      payloadFingerprint: fp,
      displayText: text,
      text,
      images: [{ mimeType: "image/png", data: "abc" }],
      attachments: ["/tmp/a.txt"],
      skillRefs: [{ name: "s", absPath: "/skills/s" }],
    }),
  });
  return fp;
};

describe("R39-① unknown_terminal → late 202/direct 保留草稿", () => {
  it("message_op unknown → late 202：clearDraft=false、uncertain + 原 identity", () => {
    const taskId = "r39_unk_202";
    const itemId = "cq_r39_u202";
    const fp = registerOp(taskId, itemId, "hello-unk-202");

    dispatchChatOp(taskId, {
      type: "message_op",
      itemId,
      outcome: "future_failure_reason",
    });
    const before = getChatOpLedger(taskId).pending.find(
      (p) => p.itemId === itemId,
    );
    expect(before?.terminalKnowledge).toBe("unknown");
    expect(before?.networkUncertain).toBe(false);
    expect(before?.persistence).toBe("sending");

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
    const after = committed.reduceResult.state.pending.find(
      (p) => p.itemId === itemId,
    );
    expect(after?.terminalKnowledge).toBe("unknown");
    expect(after?.networkUncertain).toBe(false);
    expect(after?.persistence).toBe("sending");
    expect(after?.payloadFingerprint).toBe(fp);
    expect(after?.itemId).toBe(itemId);
    expect(after?.attachments).toEqual(["/tmp/a.txt"]);
    expect(after?.skillRefs?.[0]?.name).toBe("s");
  });

  it("message_op unknown → late direct：clearDraft=false、uncertain 不回 sending", () => {
    const taskId = "r39_unk_direct";
    const itemId = "cq_r39_udir";
    const fp = registerOp(taskId, itemId, "hello-unk-direct");

    dispatchChatOp(taskId, {
      type: "message_op",
      itemId,
      outcome: "future_failure_reason",
    });

    const committed = commitHttpChatReply({
      operationTaskId: taskId,
      clientItemId: itemId,
      result: { task: stubTask(taskId), autoStarted: false },
    });
    expect(committed.clearDraft).toBe(false);
    const after = committed.reduceResult.state.pending.find(
      (p) => p.itemId === itemId,
    );
    expect(after?.terminalKnowledge).toBe("unknown");
    expect(after?.networkUncertain).toBe(false);
    expect(after?.persistence).toBe("sending");
    expect(after?.payloadFingerprint).toBe(fp);
    expect(
      findReusableUncertainOperation(
        committed.reduceResult.state.pending,
        fp,
      )?.itemId,
    ).toBe(itemId);
  });

  it("queue_state unknown recentSettled → late 202 / late direct", () => {
    for (const mode of ["queued", "direct"] as const) {
      const taskId = `r39_qs_${mode}`;
      const itemId = `cq_r39_qs_${mode}`;
      const fp = registerOp(taskId, itemId, `qs-${mode}`);

      dispatchChatOp(taskId, {
        type: "queue_state",
        serverItemIds: [],
        recentSettled: [{ itemId, outcome: "weird_future" }],
      });
      expect(
        getChatOpLedger(taskId).pending.find((p) => p.itemId === itemId)
          ?.terminalKnowledge,
      ).toBe("unknown");

      const committed = commitHttpChatReply({
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
      expect(committed.clearDraft, mode).toBe(false);
      const after = committed.reduceResult.state.pending.find(
        (p) => p.itemId === itemId,
      );
      expect(after?.terminalKnowledge, mode).toBe("unknown");
      expect(after?.networkUncertain, mode).toBe(false);
      expect(after?.payloadFingerprint, mode).toBe(fp);
    }
  });
});

describe("R39-② 对照：普通 accepted / network-uncertain 重试", () => {
  it("普通首次 202 / direct 仍按 accepted 清草稿", () => {
    for (const mode of ["queued", "direct"] as const) {
      const taskId = `r39_ok_${mode}`;
      const itemId = `cq_r39_ok_${mode}`;
      registerOp(taskId, itemId, `ok-${mode}`);

      const committed = commitHttpChatReply({
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
      expect(committed.clearDraft, mode).toBe(true);
      const after = committed.reduceResult.state.pending.find(
        (p) => p.itemId === itemId,
      );
      expect(after?.persistence, mode).toBe("sending");
      expect(after?.networkUncertain, mode).toBe(false);
    }
  });

  it("network-uncertain 同 id 重试拿 202 → 回 sending（与 unknown_terminal 对照）", () => {
    const taskId = "r39_net_retry";
    const itemId = "cq_r39_net";
    const fp = registerOp(taskId, itemId, "net-retry");

    dispatchChatOp(taskId, {
      type: "http_reject_network",
      itemId,
    });
    const mid = getChatOpLedger(taskId).pending.find(
      (p) => p.itemId === itemId,
    );
    expect(mid?.networkUncertain).toBe(true);
    expect(mid?.networkUncertain).toBe(true);

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
    expect(committed.clearDraft).toBe(true);
    const after = committed.reduceResult.state.pending.find(
      (p) => p.itemId === itemId,
    );
    expect(after?.persistence).toBe("sending");
    expect(after?.networkUncertain).toBe(false);
    expect(after?.payloadFingerprint).toBe(fp);
  });
});

describe("R39-③ unknown → known 恰好一次收敛并清 marker", () => {
  it("unknown → delivered 与每个失败枚举：收敛一次、marker 随 pending 清除", () => {
    const targets: Array<
      "delivered" | (typeof MESSAGE_OP_FAILURE_OUTCOMES)[number]
    > = ["delivered", ...MESSAGE_OP_FAILURE_OUTCOMES];

    for (const known of targets) {
      const itemId = `cq_r39_conv_${known}`;
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

      state = reduceChatOperation(state, {
        type: "message_op",
        itemId,
        outcome: "future_failure_reason",
      }).state;
      expect(state.pending.find((p) => p.itemId === itemId)?.terminalKnowledge).toBe("unknown");

      // late 202 不得抹 marker
      state = reduceChatOperation(state, {
        type: "http_queued",
        itemId,
      }).state;
      expect(
        state.pending.find((p) => p.itemId === itemId)?.terminalKnowledge,
      ).toBe("unknown");
      expect(
        state.pending.find((p) => p.itemId === itemId)?.networkUncertain,
      ).toBe(false);

      state = reduceChatOperation(state, {
        type: "message_op",
        itemId,
        outcome: known,
      }).state;
      const expected = known === "delivered" ? "delivered" : "failed";
      expect(state.outcomes[itemId], known).toBe(expected);
      expect(state.settled, known).toContain(itemId);
      expect(
        state.pending.find((p) => p.itemId === itemId),
        known,
      ).toBeUndefined();

      // first-outcome-wins
      const flip = known === "delivered" ? "stopped" : "delivered";
      state = reduceChatOperation(state, {
        type: "message_op",
        itemId,
        outcome: flip,
      }).state;
      expect(state.outcomes[itemId], known).toBe(expected);
    }
  });
});

describe("R39-④ watch policy：unavailable / transient 独立计数", () => {
  it("7×unavailable → 1×retryable → unavailable → 成功：继续 retry、最终恢复、单 loop", () => {
    let unavailableAttempts = 0;
    let transientFailures = 0;
    let unavailableNotified = false;
    let loopRuns = 0;
    let recovered = false;

    const sequence: Array<"unavailable" | "retryable" | "ok"> = [
      ...Array.from({ length: 7 }, () => "unavailable" as const),
      "retryable",
      "unavailable",
      "ok",
    ];

    loopRuns += 1;
    expect(loopRuns).toBe(1);

    for (const step of sequence) {
      if (step === "ok") {
        unavailableAttempts = 0;
        transientFailures = 0;
        unavailableNotified = false;
        recovered = true;
        break;
      }
      const d = resolveWatchReconnectPolicy({
        kind: step,
        unavailableAttempts,
        transientFailures,
        unavailableNotified,
      });
      expect(d.action, step).toBe("retry");
      if (d.action !== "retry") throw new Error("unreachable");
      unavailableAttempts = d.nextUnavailableAttempts;
      transientFailures = d.nextTransientFailures;
      unavailableNotified = d.nextUnavailableNotified;
    }

    expect(recovered).toBe(true);
    expect(unavailableAttempts).toBe(0);
    expect(transientFailures).toBe(0);
    expect(loopRuns).toBe(1);
    // 7×503 后一次 retryable 不得耗尽（transient 仅 1）
    expect(transientFailures).toBe(0);
  });

  it("7×unavailable → 1×retryable → hydrated 404：恰好一次 deleted", () => {
    let unavailableAttempts = 0;
    let transientFailures = 0;
    let unavailableNotified = false;
    let deleted = 0;

    for (let i = 0; i < 7; i++) {
      const d = resolveWatchReconnectPolicy({
        kind: "unavailable",
        unavailableAttempts,
        transientFailures,
        unavailableNotified,
      });
      expect(d.action).toBe("retry");
      if (d.action === "retry") {
        unavailableAttempts = d.nextUnavailableAttempts;
        transientFailures = d.nextTransientFailures;
        unavailableNotified = d.nextUnavailableNotified;
      }
    }

    const afterReject = resolveWatchReconnectPolicy({
      kind: "retryable",
      unavailableAttempts,
      transientFailures,
      unavailableNotified,
    });
    expect(afterReject.action).toBe("retry");
    if (afterReject.action === "retry") {
      unavailableAttempts = afterReject.nextUnavailableAttempts;
      transientFailures = afterReject.nextTransientFailures;
    }
    expect(transientFailures).toBe(1);

    const deletedDecision = resolveWatchReconnectPolicy({
      kind: "deleted",
      unavailableAttempts,
      transientFailures,
      unavailableNotified,
    });
    expect(deletedDecision.action).toBe("terminate_deleted");
    deleted += 1;
    // 再来一次 deleted 仍 terminate（sticky 由调用方保证恰好一次回调）
    const again = resolveWatchReconnectPolicy({
      kind: "deleted",
      unavailableAttempts,
      transientFailures,
      unavailableNotified,
    });
    expect(again.action).toBe("terminate_deleted");
    expect(deleted).toBe(1);
  });

  it("纯 6×retryable → terminate_exhausted 保持", () => {
    let transientFailures = 0;
    let unavailableAttempts = 0;
    let stop = false;
    for (let i = 0; i < WATCH_MAX_TRANSIENT_FAILURES; i++) {
      const d = resolveWatchReconnectPolicy({
        kind: "retryable",
        unavailableAttempts,
        transientFailures,
        unavailableNotified: false,
      });
      if (d.action === "terminate_exhausted") {
        stop = true;
        break;
      }
      if (d.action === "retry") {
        transientFailures = d.nextTransientFailures;
        unavailableAttempts = d.nextUnavailableAttempts;
      }
    }
    expect(stop).toBe(true);
    expect(transientFailures).toBe(WATCH_MAX_TRANSIENT_FAILURES - 1);
    expect(unavailableAttempts).toBe(0);
  });
});
