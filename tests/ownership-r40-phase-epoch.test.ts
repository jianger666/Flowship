/**
 * R40：Codex 第三十九轮 R39-1 / R39-2 退出矩阵
 *
 * R39-1：operation phase 单调 join——persisted 不被 late 202/direct/reject 降级
 * R39-2：watchTaskStream 首个合法 task bootstrap 发 connection-established，
 *        hook 镜像控制流当场清 transient/unavailable（不等流 EOF）
 *        ——R14 B6-1（Q16-01）起改为：建连只记时刻，连接结束时按「撑过稳定窗口才清零」结算（settleWatchBudget）。
 *        R40-② 的镜像已同步成同源：liveMs 默认刚好撑过窗口、原有用例语义不变；
 *        「没撑过」的对照用例见 R40-② 里新增的那条，以及真跑 hook 的 tests/watch-stable-connection.test.ts
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
  joinPendingProductState,
  joinProductState,
  reduceChatOperation,
  type ChatOperation,
  type PendingProductState,
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
  WATCH_STABLE_CONNECTION_MS,
} from "@/lib/task-terminal";
import type { Task } from "@/lib/types";
import { settleWatchBudget } from "@/lib/watch-reconnect";

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

type Counters = {
  unavailableAttempts: number;
  transientFailures: number;
  unavailableNotified: boolean;
};

/**
 * 镜像 hook 在一条连接结束时的结算（R14 B6-1 / Q16-01；与 hook 同源：settleWatchBudget）：
 * 建连只记时刻（establishedAt），连接结束时看建连后撑过稳定窗口没有——撑过才清零、没撑过原样累计。
 * liveMs = 建连后这条连接活了多久，默认刚好撑过稳定窗口（= 正常长连接后断开）。
 */
const settleCounters = (
  counters: Counters,
  establishedAt: number | null,
  liveMs: number = WATCH_STABLE_CONNECTION_MS,
): Counters => {
  const next = { ...counters };
  settleWatchBudget(
    next,
    establishedAt,
    establishedAt === null ? Date.now() : establishedAt + liveMs,
  );
  return next;
};

describe("R40-① R39-1：product-state 正交 join（persisted 不被 transport 降级）", () => {
  it("格 join：persisted ⊔ unknown 交换；transport ack 只清 network", () => {
    const persisted: PendingProductState = {
      persistence: "persisted",
      terminalKnowledge: "none",
      networkUncertain: false,
    };
    const unknown: PendingProductState = {
      persistence: "sending",
      terminalKnowledge: "unknown",
      networkUncertain: false,
    };
    const joined = joinProductState(persisted, unknown);
    expect(joinProductState(unknown, persisted)).toEqual(joined);
    expect(joined).toEqual({
      persistence: "persisted",
      terminalKnowledge: "unknown",
      networkUncertain: false,
    });

    expect(
      joinPendingProductState(
        { ...persisted, networkUncertain: true },
        { clearNetworkUncertain: true },
      ),
    ).toEqual({
      persistence: "persisted",
      terminalKnowledge: "none",
      networkUncertain: false,
    });
    expect(
      joinPendingProductState(unknown, { clearNetworkUncertain: true })
        .terminalKnowledge,
    ).toBe("unknown");
    expect(
      joinPendingProductState(
        {
          persistence: "sending",
          terminalKnowledge: "none",
          networkUncertain: true,
        },
        { clearNetworkUncertain: true },
      ).networkUncertain,
    ).toBe(false);
  });

  it("user_reply persisted → late 202 / direct / fetch reject：persistence 保持", () => {
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
          ?.persistence,
      ).toBe("persisted");

      if (mode === "reject") {
        const committed = commitHttpChatReject({
          operationTaskId: taskId,
          clientItemId: itemId,
          kind: "network",
        });
        expect(committed.clearDraft, mode).toBe(false);
        const after = committed.reduceResult.state.pending.find(
          (p) => p.itemId === itemId,
        );
        expect(after?.persistence, mode).toBe("persisted");
        // R40-1：response-lost 置位 network，供 same-id 重试
        expect(after?.networkUncertain, mode).toBe(true);
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
        expect(committed.clearDraft, mode).toBe(true);
        const after = committed.reduceResult.state.pending.find(
          (p) => p.itemId === itemId,
        );
        expect(after?.persistence, mode).toBe("persisted");
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
          ?.networkUncertain,
      ).toBe(true);

      dispatchChatOp(taskId, {
        type: "user_reply",
        ev: {
          text: `net-pers-${mode}`,
          meta: { queueItemId: itemId },
        },
      });
      const mid = getChatOpLedger(taskId).pending.find(
        (p) => p.itemId === itemId,
      );
      expect(mid?.persistence).toBe("persisted");
      expect(mid?.networkUncertain).toBe(true);

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
        const after = committed.reduceResult.state.pending.find(
          (p) => p.itemId === itemId,
        );
        expect(after?.persistence).toBe("persisted");
        expect(after?.networkUncertain).toBe(false);
      } else {
        const committed = commitHttpChatReject({
          operationTaskId: taskId,
          clientItemId: itemId,
          kind: "network",
        });
        expect(committed.clearDraft).toBe(false);
        expect(
          committed.reduceResult.state.pending.find((p) => p.itemId === itemId)
            ?.persistence,
        ).toBe("persisted");
      }
    }
  });

  it("unknown → user_reply persisted → late HTTP → known terminal：证据保留且恰好一次收敛", () => {
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
    expect(
      state.pending.find((p) => p.itemId === itemId)?.terminalKnowledge,
    ).toBe("unknown");

    state = reduceChatOperation(state, {
      type: "user_reply",
      ev: { text: "unk-pers", meta: { queueItemId: itemId } },
    }).state;
    const mid = state.pending.find((p) => p.itemId === itemId);
    expect(mid?.persistence).toBe("persisted");
    expect(mid?.terminalKnowledge).toBe("unknown");

    state = reduceChatOperation(state, {
      type: "http_queued",
      itemId,
    }).state;
    const afterHttp = state.pending.find((p) => p.itemId === itemId);
    expect(afterHttp?.persistence).toBe("persisted");
    expect(afterHttp?.terminalKnowledge).toBe("unknown");

    state = reduceChatOperation(state, {
      type: "http_reject_network",
      itemId,
    }).state;
    expect(
      state.pending.find((p) => p.itemId === itemId)?.persistence,
    ).toBe("persisted");
    expect(
      state.pending.find((p) => p.itemId === itemId)?.terminalKnowledge,
    ).toBe("unknown");

    state = reduceChatOperation(state, {
      type: "message_op",
      itemId,
      outcome: "delivered",
    }).state;
    expect(state.outcomes[itemId]).toBe("delivered");
    expect(state.settled).toContain(itemId);
    expect(state.pending.find((p) => p.itemId === itemId)).toBeUndefined();

    state = reduceChatOperation(state, {
      type: "message_op",
      itemId,
      outcome: "stopped",
    }).state;
    expect(state.outcomes[itemId]).toBe("delivered");
  });
});

describe("R40-② R39-2：connection-established 重置 retry epoch", () => {
  it("前一轮 fetch reject 后、成功 bootstrap 并撑过稳定窗口再 reader error → transient=#1（非 #2）", async () => {
    const taskId = "r40_epoch_reset";
    const task = stubTask(taskId);
    let unavailableAttempts = 0;
    let transientFailures = 0;
    let unavailableNotified = false;
    let established = 0;
    let establishedAt = null as number | null;

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
          establishedAt = Date.now();
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
          establishedAt = Date.now();
        },
      });
    } catch (err) {
      // 撑过稳定窗口才断：先清零 → 本轮从 0 起算 → #1（建连当场不再清零，见文件头说明）
      ({ unavailableAttempts, transientFailures, unavailableNotified } =
        settleCounters(
          { unavailableAttempts, transientFailures, unavailableNotified },
          establishedAt,
        ));
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

  it("连续 6 轮成功 bootstrap→（每轮都撑过稳定窗口）reader error 不 exhausted；6 次建连前失败仍终止", async () => {
    const taskId = "r40_six_ok_drop";
    const task = stubTask(taskId);

    // 6× 成功建连、撑过稳定窗口后断流
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
        let establishedAt = null as number | null;
        try {
          await watchTaskStream(taskId, {
            onConnectionEstablished: () => {
              establishedAt = Date.now();
            },
          });
        } catch {
          // 每轮连接都撑过了稳定窗口：先清零，再记成新一轮的 #1
          ({ unavailableAttempts, transientFailures, unavailableNotified } =
            settleCounters(
              { unavailableAttempts, transientFailures, unavailableNotified },
              establishedAt,
            ));
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
      // 每轮撑过稳定窗口、清零后断流只记 1，循环结束时仍为 1
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

  it("连续 6 轮「成功 bootstrap 后立刻 reader error」（没撑过稳定窗口）→ exhausted，不再静默无限重连", async () => {
    const taskId = "r40_six_short_drop";
    const task = stubTask(taskId);
    let counters: Counters = {
      unavailableAttempts: 0,
      transientFailures: 0,
      unavailableNotified: false,
    };
    let exhausted = false;
    let rounds = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(streamBootstrapThenError(task), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    // 上限 20 轮只是防旧写法下的死循环：旧写法（建连即清零）每轮都清零再记 #1，永远不会 exhausted、会把 20 轮跑满
    for (let i = 0; i < 20 && !exhausted; i++) {
      rounds += 1;
      let establishedAt = null as number | null;
      try {
        await watchTaskStream(taskId, {
          onConnectionEstablished: () => {
            establishedAt = Date.now();
          },
        });
      } catch {
        // 建连后立刻断（liveMs=0）：没撑过稳定窗口 → 预算原样、失败照常累计
        counters = settleCounters(counters, establishedAt, 0);
        const d = resolveWatchReconnectPolicy({
          kind: "retryable",
          ...counters,
        });
        if (d.action === "terminate_exhausted") {
          exhausted = true;
        } else if (d.action === "retry") {
          counters = {
            unavailableAttempts: d.nextUnavailableAttempts,
            transientFailures: d.nextTransientFailures,
            unavailableNotified: d.nextUnavailableNotified,
          };
        }
      }
    }
    expect(exhausted).toBe(true);
    expect(rounds).toBe(WATCH_MAX_TRANSIENT_FAILURES);
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
      // 每轮新连接：建连只记时刻，连接结束时按「撑过稳定窗口才清零」结算（本用例里建连后的连接都视为撑过了窗口）
      let establishedAt = null as number | null;
      try {
        const { established } = await watchTaskStream(taskId, {
          onConnectionEstablished: () => {
            establishedAt = Date.now();
          },
        });
        // R40-2：仅 established（且撑过稳定窗口）后 clean EOF 清 epoch
        if (established) {
          ({ unavailableAttempts, transientFailures, unavailableNotified } =
            settleCounters(
              { unavailableAttempts, transientFailures, unavailableNotified },
              establishedAt,
            ));
          done = true;
        } else {
          const d = resolveWatchReconnectPolicy({
            kind: "retryable",
            unavailableAttempts,
            transientFailures,
            unavailableNotified,
          });
          if (d.action === "retry") {
            transientFailures = d.nextTransientFailures;
            unavailableAttempts = d.nextUnavailableAttempts;
          }
        }
      } catch (err) {
        // bootstrap_drop 阶段：建连后撑过稳定窗口再断 → 先清零；建连前失败（503 / reject）establishedAt 为 null、原样累计
        ({ unavailableAttempts, transientFailures, unavailableNotified } =
          settleCounters(
            { unavailableAttempts, transientFailures, unavailableNotified },
            establishedAt,
          ));
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
