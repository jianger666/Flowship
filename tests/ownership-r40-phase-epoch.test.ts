/**
 * R40：Codex 第三十九轮 R39-1 / R39-2 退出矩阵
 *
 * R39-1：operation phase 单调 join——persisted 不被 late 202/direct/reject 降级
 * R39-2：watchTaskStream 首个合法 task bootstrap 发 connection-established，
 *        hook 镜像控制流当场清 transient/unavailable（不等流 EOF）
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetChatOpLedgerForTests,
  dispatchChatOp,
  getChatOpLedger,
} from "@/lib/chat-op-ledger";
import { fingerprintFromChatSendArgs } from "@/lib/chat-payload-fingerprint";
import {
  emptyChatOpState,
  joinPendingPhase,
  pendingPhaseRank,
  reduceChatOperation,
  type ChatOperation,
} from "@/lib/chat-pending-reconcile";
import {
  commitHttpChatReject,
  commitHttpChatReply,
} from "@/lib/chat-submit-controller";
import {
  ApiRequestError,
  watchTaskStream,
} from "@/lib/task-store";
import {
  classifyWatchHttpStatus,
  resolveWatchReconnectPolicy,
  WATCH_MAX_TRANSIENT_FAILURES,
} from "@/lib/task-terminal";
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

const registerOp = (taskId: string, itemId: string, text: string) => {
  const fp = fingerprintFromChatSendArgs({ text });
  dispatchChatOp(taskId, {
    type: "register",
    op: op({
      itemId,
      payloadFingerprint: fp,
      displayText: text,
      text,
    }),
  });
  return fp;
};

const sseFrame = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

/** 合法 bootstrap task 帧 + 随后 reader 抛错的 ReadableStream */
const streamBootstrapThenError = (task: Task, errMsg = "stream dropped") => {
  let step = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (step === 0) {
        step = 1;
        controller.enqueue(
          new TextEncoder().encode(
            sseFrame({ type: "task", task }),
          ),
        );
        return;
      }
      controller.error(new Error(errMsg));
    },
  });
};

describe("R40-① R39-1：persisted 不被 late transport 降级", () => {
  it("precedence 表：known 外 persisted > unknown_terminal > network > sending", () => {
    expect(pendingPhaseRank({ phase: "persisted" })).toBeGreaterThan(
      pendingPhaseRank({
        phase: "uncertain",
        uncertainCause: "unknown_terminal",
      }),
    );
    expect(
      pendingPhaseRank({
        phase: "uncertain",
        uncertainCause: "unknown_terminal",
      }),
    ).toBeGreaterThan(
      pendingPhaseRank({ phase: "uncertain", uncertainCause: "network" }),
    );
    expect(
      pendingPhaseRank({ phase: "uncertain", uncertainCause: "network" }),
    ).toBeGreaterThan(pendingPhaseRank({ phase: "sending" }));

    // transportAck：sending 可清 network，不可清 persisted / unknown
    const persisted = {
      itemId: "a",
      displayText: "x",
      phase: "persisted" as const,
    };
    expect(
      joinPendingPhase(
        persisted,
        { phase: "sending", uncertain: false },
        { transportAck: true },
      ).phase,
    ).toBe("persisted");
    const unknown = {
      itemId: "b",
      displayText: "x",
      phase: "uncertain" as const,
      uncertainCause: "unknown_terminal" as const,
    };
    expect(
      joinPendingPhase(
        unknown,
        { phase: "sending", uncertain: false },
        { transportAck: true },
      ).uncertainCause,
    ).toBe("unknown_terminal");
    const network = {
      itemId: "c",
      displayText: "x",
      phase: "uncertain" as const,
      uncertainCause: "network" as const,
      uncertain: true,
    };
    expect(
      joinPendingPhase(
        network,
        { phase: "sending", uncertain: false },
        { transportAck: true },
      ).phase,
    ).toBe("sending");
  });

  it("user_reply persisted → late 202 / direct / fetch reject：phase 保持 persisted", () => {
    for (const mode of ["queued", "direct", "reject"] as const) {
      const taskId = `r40_pers_${mode}`;
      const itemId = `cq_r40_pers_${mode}`;
      registerOp(taskId, itemId, `pers-${mode}`);

      dispatchChatOp(taskId, {
        type: "user_reply",
        ev: { text: `pers-${mode}`, meta: { queueItemId: itemId } },
      });
      expect(
        getChatOpLedger(taskId).pending.find((p) => p.itemId === itemId)
          ?.phase,
      ).toBe("persisted");

      if (mode === "reject") {
        const committed = commitHttpChatReject({
          operationTaskId: taskId,
          clientItemId: itemId,
          kind: "network",
        });
        // 清草稿契约：无 delivered → false；phase 不回 uncertain
        expect(committed.clearDraft, mode).toBe(false);
        const after = committed.reduceResult.state.pending.find(
          (p) => p.itemId === itemId,
        );
        expect(after?.phase, mode).toBe("persisted");
        expect(after?.uncertainCause, mode).toBeUndefined();
      } else {
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
        // 清草稿契约：普通 accepted 仍清（与 phase 正交）
        expect(committed.clearDraft, mode).toBe(true);
        const after = committed.reduceResult.state.pending.find(
          (p) => p.itemId === itemId,
        );
        expect(after?.phase, mode).toBe("persisted");
      }
    }
  });

  it("network uncertain → user_reply persisted → late 202/reject：最终 persisted", () => {
    for (const mode of ["queued", "reject"] as const) {
      const taskId = `r40_net_pers_${mode}`;
      const itemId = `cq_r40_net_pers_${mode}`;
      registerOp(taskId, itemId, `net-pers-${mode}`);

      dispatchChatOp(taskId, { type: "http_reject_network", itemId });
      expect(
        getChatOpLedger(taskId).pending.find((p) => p.itemId === itemId)
          ?.phase,
      ).toBe("uncertain");

      dispatchChatOp(taskId, {
        type: "user_reply",
        ev: {
          text: `net-pers-${mode}`,
          meta: { queueItemId: itemId },
        },
      });
      expect(
        getChatOpLedger(taskId).pending.find((p) => p.itemId === itemId)
          ?.phase,
      ).toBe("persisted");

      if (mode === "queued") {
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
        expect(
          committed.reduceResult.state.pending.find((p) => p.itemId === itemId)
            ?.phase,
        ).toBe("persisted");
      } else {
        const committed = commitHttpChatReject({
          operationTaskId: taskId,
          clientItemId: itemId,
          kind: "network",
        });
        expect(committed.clearDraft).toBe(false);
        expect(
          committed.reduceResult.state.pending.find((p) => p.itemId === itemId)
            ?.phase,
        ).toBe("persisted");
      }
    }
  });

  it("unknown_terminal → user_reply persisted → late HTTP → known terminal：证据保留且恰好一次收敛", () => {
    const itemId = "cq_r40_unk_pers";
    const fp = fingerprintFromChatSendArgs({ text: "unk-pers" });
    let state = emptyChatOpState();
    state = reduceChatOperation(state, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: fp,
        displayText: "unk-pers",
      }),
    }).state;

    state = reduceChatOperation(state, {
      type: "message_op",
      itemId,
      outcome: "future_failure_reason",
    }).state;
    expect(state.pending.find((p) => p.itemId === itemId)?.uncertainCause).toBe(
      "unknown_terminal",
    );

    state = reduceChatOperation(state, {
      type: "user_reply",
      ev: { text: "unk-pers", meta: { queueItemId: itemId } },
    }).state;
    const mid = state.pending.find((p) => p.itemId === itemId);
    expect(mid?.phase).toBe("persisted");
    // user_reply 不抹 unknown marker（spread 保留）；fail-closed 证据仍在
    expect(mid?.uncertainCause).toBe("unknown_terminal");

    // late 202：不得降为 sending、不得抹 unknown
    state = reduceChatOperation(state, {
      type: "http_queued",
      itemId,
    }).state;
    const afterHttp = state.pending.find((p) => p.itemId === itemId);
    expect(afterHttp?.phase).toBe("persisted");
    expect(afterHttp?.uncertainCause).toBe("unknown_terminal");

    // late reject：同样不降级
    state = reduceChatOperation(state, {
      type: "http_reject_network",
      itemId,
    }).state;
    expect(state.pending.find((p) => p.itemId === itemId)?.phase).toBe(
      "persisted",
    );
    expect(
      state.pending.find((p) => p.itemId === itemId)?.uncertainCause,
    ).toBe("unknown_terminal");

    // known terminal 恰好一次收敛
    state = reduceChatOperation(state, {
      type: "message_op",
      itemId,
      outcome: "delivered",
    }).state;
    expect(state.outcomes[itemId]).toBe("delivered");
    expect(state.settled).toContain(itemId);
    expect(state.pending.find((p) => p.itemId === itemId)).toBeUndefined();

    // first-outcome-wins
    state = reduceChatOperation(state, {
      type: "message_op",
      itemId,
      outcome: "stopped",
    }).state;
    expect(state.outcomes[itemId]).toBe("delivered");
  });
});

describe("R40-② R39-2：connection-established 重置 retry epoch", () => {
  it("前一轮 fetch reject 后、成功 bootstrap 再 reader error → transient=#1（非 #2）", async () => {
    const taskId = "r40_epoch_reset";
    const task = stubTask(taskId);
    let unavailableAttempts = 0;
    let transientFailures = 0;
    let unavailableNotified = false;
    let established = 0;

    // round 1：fetch reject
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    try {
      await watchTaskStream(taskId, {
        onConnectionEstablished: () => {
          established += 1;
          unavailableAttempts = 0;
          transientFailures = 0;
          unavailableNotified = false;
        },
      });
    } catch (err) {
      const d = resolveWatchReconnectPolicy({
        kind: "retryable",
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
      void err;
    }
    expect(transientFailures).toBe(1);
    expect(established).toBe(0);

    // round 2：200 + task bootstrap → reader error
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(streamBootstrapThenError(task), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    try {
      await watchTaskStream(taskId, {
        onConnectionEstablished: () => {
          established += 1;
          unavailableAttempts = 0;
          transientFailures = 0;
          unavailableNotified = false;
        },
      });
    } catch (err) {
      // 建连已清零 → 本轮从 0 起算 → #1
      const d = resolveWatchReconnectPolicy({
        kind: "retryable",
        unavailableAttempts,
        transientFailures,
        unavailableNotified,
      });
      expect(d.action).toBe("retry");
      if (d.action === "retry") {
        transientFailures = d.nextTransientFailures;
      }
      void err;
    }
    expect(established).toBe(1);
    expect(transientFailures).toBe(1);
    expect(unavailableAttempts).toBe(0);
    expect(unavailableNotified).toBe(false);
  });

  it("连续 6 轮成功 bootstrap→reader error 不 exhausted；6 次建连前失败仍终止", async () => {
    const taskId = "r40_six_ok_drop";
    const task = stubTask(taskId);

    // 6× 成功建连后断流
    {
      let unavailableAttempts = 0;
      let transientFailures = 0;
      let unavailableNotified = false;
      let exhausted = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(streamBootstrapThenError(task), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }),
      );
      for (let i = 0; i < 6; i++) {
        try {
          await watchTaskStream(taskId, {
            onConnectionEstablished: () => {
              unavailableAttempts = 0;
              transientFailures = 0;
              unavailableNotified = false;
            },
          });
        } catch {
          const d = resolveWatchReconnectPolicy({
            kind: "retryable",
            unavailableAttempts,
            transientFailures,
            unavailableNotified,
          });
          if (d.action === "terminate_exhausted") {
            exhausted = true;
            break;
          }
          if (d.action === "retry") {
            transientFailures = d.nextTransientFailures;
            unavailableAttempts = d.nextUnavailableAttempts;
          }
        }
      }
      expect(exhausted).toBe(false);
      // 每轮建连清零后断流只记 1，循环结束时仍为 1
      expect(transientFailures).toBe(1);
    }

    // 6× 建连前失败（fetch reject）→ exhausted
    {
      let unavailableAttempts = 0;
      let transientFailures = 0;
      let unavailableNotified = false;
      let exhausted = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fail before connect");
        }),
      );
      for (let i = 0; i < WATCH_MAX_TRANSIENT_FAILURES; i++) {
        try {
          await watchTaskStream(taskId, {
            onConnectionEstablished: () => {
              unavailableAttempts = 0;
              transientFailures = 0;
              unavailableNotified = false;
            },
          });
        } catch {
          const d = resolveWatchReconnectPolicy({
            kind: "retryable",
            unavailableAttempts,
            transientFailures,
            unavailableNotified,
          });
          if (d.action === "terminate_exhausted") {
            exhausted = true;
            break;
          }
          if (d.action === "retry") {
            transientFailures = d.nextTransientFailures;
            unavailableAttempts = d.nextUnavailableAttempts;
            unavailableNotified = d.nextUnavailableNotified;
          }
        }
      }
      expect(exhausted).toBe(true);
    }
  });

  it("7×503 → fetch reject → 200 bootstrap → reader error → reconnect 成功：单 loop、无 sticky deleted、计数重置", async () => {
    const taskId = "r40_combo_reset";
    const task = stubTask(taskId);
    let unavailableAttempts = 0;
    let transientFailures = 0;
    let unavailableNotified = false;
    let loopRuns = 0;
    let deleted = false;
    let phase:
      | "unavailable"
      | "reject"
      | "bootstrap_drop"
      | "reconnect_ok" = "unavailable";
    let unavailableLeft = 7;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (phase === "unavailable") {
          return new Response(JSON.stringify({ error: "busy" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (phase === "reject") {
          throw new TypeError("fetch failed");
        }
        if (phase === "bootstrap_drop") {
          return new Response(streamBootstrapThenError(task), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        // reconnect_ok：合法 task 后 clean EOF
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(sseFrame({ type: "task", task })),
            );
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    // 单 loop：while 直到成功 clean resolve
    loopRuns += 1;
    let done = false;
    while (!done) {
      try {
        await watchTaskStream(taskId, {
          onConnectionEstablished: () => {
            unavailableAttempts = 0;
            transientFailures = 0;
            unavailableNotified = false;
          },
        });
        // clean resolve
        unavailableAttempts = 0;
        transientFailures = 0;
        unavailableNotified = false;
        done = true;
      } catch (err) {
        const status =
          err instanceof ApiRequestError
            ? err.status
            : (err as { status?: number }).status;
        const kind =
          typeof status === "number"
            ? classifyWatchHttpStatus(status, { hydratedWatcher: true })
            : "retryable";
        const decision = resolveWatchReconnectPolicy({
          kind,
          unavailableAttempts,
          transientFailures,
          unavailableNotified,
        });
        if (decision.action === "terminate_deleted") {
          deleted = true;
          break;
        }
        if (decision.action === "terminate_exhausted") {
          break;
        }
        unavailableAttempts = decision.nextUnavailableAttempts;
        transientFailures = decision.nextTransientFailures;
        unavailableNotified = decision.nextUnavailableNotified;

        // 推进测试序列相位
        if (phase === "unavailable") {
          unavailableLeft -= 1;
          if (unavailableLeft <= 0) phase = "reject";
        } else if (phase === "reject") {
          phase = "bootstrap_drop";
        } else if (phase === "bootstrap_drop") {
          phase = "reconnect_ok";
        }
      }
    }

    expect(loopRuns).toBe(1);
    expect(deleted).toBe(false);
    expect(done).toBe(true);
    expect(unavailableAttempts).toBe(0);
    expect(transientFailures).toBe(0);
    expect(unavailableNotified).toBe(false);
    expect(phase).toBe("reconnect_ok");
  });

  it("200 空流 / 非法帧不触发 onConnectionEstablished", async () => {
    const taskId = "r40_no_false_establish";
    let established = 0;

    // 200 但 body 立即 close（无 task 帧）
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    await watchTaskStream(taskId, {
      onConnectionEstablished: () => {
        established += 1;
      },
    });
    expect(established).toBe(0);

    // 非法 JSON 帧 + 无 task
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode("data: {not-json\n\n"),
            );
            controller.enqueue(
              new TextEncoder().encode(
                sseFrame({ type: "queue_state", itemIds: [] }),
              ),
            );
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    await watchTaskStream(taskId, {
      onConnectionEstablished: () => {
        established += 1;
      },
    });
    expect(established).toBe(0);
  });
});
