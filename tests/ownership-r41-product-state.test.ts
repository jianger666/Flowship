/**
 * R41：Codex 第四十轮 R40-1 / R40-2 退出矩阵
 *
 * R40-1：正交 product-state + 可交换 join（取代一维 phase rank）
 * R40-2：clean EOF 只有 established 后才清 epoch（见 ownership-r41-eof-epoch）
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
  joinPendingProductState,
  joinProductState,
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

const productOf = (p: ChatOperation | undefined): PendingProductState => ({
  persistence: p?.persistence ?? "sending",
  terminalKnowledge: p?.terminalKnowledge ?? "none",
  networkUncertain: p?.networkUncertain ?? false,
});

/** 证据 → 格上的 product patch（transport ack 的 clear 单独测） */
type EvidenceKind =
  | "message_op_unknown"
  | "user_reply_persisted"
  | "http_reject_network"
  | "queue_state_unknown";

const evidenceToState = (kind: EvidenceKind): PendingProductState => {
  switch (kind) {
    case "message_op_unknown":
    case "queue_state_unknown":
      return {
        persistence: "sending",
        terminalKnowledge: "unknown",
        networkUncertain: false,
      };
    case "user_reply_persisted":
      return {
        persistence: "persisted",
        terminalKnowledge: "none",
        networkUncertain: false,
      };
    case "http_reject_network":
      return {
        persistence: "sending",
        terminalKnowledge: "none",
        networkUncertain: true,
      };
  }
};

const permutations = <T>(items: T[]): T[][] => {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const head = items[i]!;
    const rest = items.filter((_, j) => j !== i);
    for (const p of permutations(rest)) out.push([head, ...p]);
  }
  return out;
};

const combinations = <T>(items: T[], k: number): T[][] => {
  if (k === 0) return [[]];
  if (k > items.length) return [];
  const out: T[][] = [];
  const rec = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      acc.push(items[i]!);
      rec(i + 1, acc);
      acc.pop();
    }
  };
  rec(0, []);
  return out;
};

describe("R41-① product-state join 律（交换 / 结合 / 幂等）", () => {
  const atoms: PendingProductState[] = [
    {
      persistence: "sending",
      terminalKnowledge: "none",
      networkUncertain: false,
    },
    {
      persistence: "persisted",
      terminalKnowledge: "none",
      networkUncertain: false,
    },
    {
      persistence: "sending",
      terminalKnowledge: "unknown",
      networkUncertain: false,
    },
    {
      persistence: "sending",
      terminalKnowledge: "none",
      networkUncertain: true,
    },
    {
      persistence: "persisted",
      terminalKnowledge: "unknown",
      networkUncertain: true,
    },
  ];

  it("idempotent：a ⊔ a = a", () => {
    for (const a of atoms) {
      expect(joinProductState(a, a), JSON.stringify(a)).toEqual(a);
    }
  });

  it("commutative：a ⊔ b = b ⊔ a（全部 pairwise）", () => {
    for (const a of atoms) {
      for (const b of atoms) {
        expect(joinProductState(a, b)).toEqual(joinProductState(b, a));
      }
    }
  });

  it("associative：(a ⊔ b) ⊔ c = a ⊔ (b ⊔ c)", () => {
    for (const a of atoms) {
      for (const b of atoms) {
        for (const c of atoms) {
          expect(joinProductState(joinProductState(a, b), c)).toEqual(
            joinProductState(a, joinProductState(b, c)),
          );
        }
      }
    }
  });

  it("evidence 两两 / 三三排列：fold join 与顺序无关", () => {
    const kinds: EvidenceKind[] = [
      "message_op_unknown",
      "user_reply_persisted",
      "http_reject_network",
      "queue_state_unknown",
    ];
    let pairCount = 0;
    let tripleCount = 0;

    for (const combo of combinations(kinds, 2)) {
      const expected = combo
        .map(evidenceToState)
        .reduce((acc, s) => joinProductState(acc, s));
      for (const order of permutations(combo)) {
        const got = order
          .map(evidenceToState)
          .reduce((acc, s) => joinProductState(acc, s));
        expect(got, order.join(">")).toEqual(expected);
        pairCount += 1;
      }
    }

    for (const combo of combinations(kinds, 3)) {
      const expected = combo
        .map(evidenceToState)
        .reduce((acc, s) => joinProductState(acc, s));
      for (const order of permutations(combo)) {
        const got = order
          .map(evidenceToState)
          .reduce((acc, s) => joinProductState(acc, s));
        expect(got, order.join(">")).toEqual(expected);
        tripleCount += 1;
      }
    }

    // C(4,2)*2! = 12；C(4,3)*3! = 24
    expect(pairCount).toBe(12);
    expect(tripleCount).toBe(24);
  });

  it("transport ack 定向清 network：不碰 persistence / terminalKnowledge", () => {
    const base: PendingProductState = {
      persistence: "persisted",
      terminalKnowledge: "unknown",
      networkUncertain: true,
    };
    const cleared = joinPendingProductState(base, {
      clearNetworkUncertain: true,
    });
    expect(cleared).toEqual({
      persistence: "persisted",
      terminalKnowledge: "unknown",
      networkUncertain: false,
    });
    // 与「后到 reject」不交换：ack 后再 reject 可再置位（新一轮 HTTP）
    expect(
      joinPendingProductState(cleared, { networkUncertain: true })
        .networkUncertain,
    ).toBe(true);
  });
});

describe("R41-② live persisted ↔ unknown 两种顺序", () => {
  const runOrder = (order: "persisted_first" | "unknown_first") => {
    const itemId = `cq_r41_${order}`;
    const fp = fingerprintFromChatSendArgs({ text: order });
    let state = emptyChatOpState();
    state = reduceChatOperation(state, {
      type: "register",
      op: op({ itemId, payloadFingerprint: fp, displayText: order }),
    }).state;

    const applyPersisted = () => {
      state = reduceChatOperation(state, {
        type: "user_reply",
        ev: { text: order, meta: { queueItemId: itemId } },
      }).state;
    };
    const applyUnknown = () => {
      state = reduceChatOperation(state, {
        type: "message_op",
        itemId,
        outcome: "future_failure_reason",
      }).state;
    };

    if (order === "persisted_first") {
      applyPersisted();
      applyUnknown();
    } else {
      applyUnknown();
      applyPersisted();
    }
    return { state, itemId, fp, product: productOf(state.pending[0]) };
  };

  it("两种到达顺序得到同一 product-state", () => {
    const a = runOrder("persisted_first");
    const b = runOrder("unknown_first");
    expect(a.product).toEqual(b.product);
    expect(a.product).toEqual({
      persistence: "persisted",
      terminalKnowledge: "unknown",
      networkUncertain: false,
    });
    // UI：persisted 隐藏本地占位，不双气泡
    expect(shouldHideLocalPlaceholder(a.product)).toBe(true);
  });

  it("再接 late queued/direct/network reject：保留 unknown、不清草稿；known 一次收敛", () => {
    for (const order of ["persisted_first", "unknown_first"] as const) {
      for (const mode of ["queued", "direct", "reject"] as const) {
        const { state: start, itemId } = runOrder(order);
        let state = start;
        if (mode === "reject") {
          const r = reduceChatOperation(state, {
            type: "http_reject_network",
            itemId,
          });
          expect(r.clearDraft, `${order}/${mode}`).toBe(false);
          state = r.state;
        } else {
          state = reduceChatOperation(state, {
            type: mode === "queued" ? "http_queued" : "http_direct_ok",
            itemId,
          }).state;
        }
        const p = productOf(state.pending.find((x) => x.itemId === itemId));
        expect(p.persistence, `${order}/${mode}`).toBe("persisted");
        expect(p.terminalKnowledge, `${order}/${mode}`).toBe("unknown");

        const taskId = `ctl_${order}_${mode}`;
        setChatOpLedger(taskId, state);
        if (mode === "reject") {
          const c = commitHttpChatReject({
            operationTaskId: taskId,
            clientItemId: itemId,
            kind: "network",
          });
          expect(c.clearDraft).toBe(false);
        } else {
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
        }

        state = reduceChatOperation(state, {
          type: "message_op",
          itemId,
          outcome: "delivered",
        }).state;
        expect(state.outcomes[itemId]).toBe("delivered");
        expect(state.pending.find((x) => x.itemId === itemId)).toBeUndefined();
      }
    }
  });
});

describe("R41-③ bootstrap persisted ↔ queue_state unknown", () => {
  it("两种顺序：不降 persistence、隐藏本地占位", () => {
    const run = (order: "persisted_first" | "unknown_first") => {
      const itemId = `cq_boot_${order}`;
      const fp = fingerprintFromChatSendArgs({ text: "boot" });
      let state = emptyChatOpState();
      state = reduceChatOperation(state, {
        type: "register",
        op: op({ itemId, payloadFingerprint: fp, displayText: "boot" }),
      }).state;
      const persisted = () => {
        state = reduceChatOperation(state, {
          type: "user_reply",
          ev: { text: "boot", meta: { queueItemId: itemId } },
        }).state;
      };
      const unknownQs = () => {
        state = reduceChatOperation(state, {
          type: "queue_state",
          serverItemIds: [],
          recentSettled: [{ itemId, outcome: "weird_future" }],
        }).state;
      };
      if (order === "persisted_first") {
        persisted();
        unknownQs();
      } else {
        unknownQs();
        persisted();
      }
      return productOf(state.pending.find((p) => p.itemId === itemId));
    };
    const a = run("persisted_first");
    const b = run("unknown_first");
    expect(a).toEqual(b);
    expect(a).toEqual({
      persistence: "persisted",
      terminalKnowledge: "unknown",
      networkUncertain: false,
    });
    expect(shouldHideLocalPlaceholder(a)).toBe(true);
  });
});

describe("R41-④ persisted → fetch reject → same fingerprint 复用 id", () => {
  it("同 fingerprint 复用；文本/附件/skill 变化 → 新 id", () => {
    const taskId = "r41_retry";
    const text = "retry-me";
    const itemId = "cq_r41_retry";
    const fp = registerOp(taskId, itemId, text);

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
    const after = rejected.reduceResult.state.pending.find(
      (p) => p.itemId === itemId,
    );
    expect(after?.persistence).toBe("persisted");
    expect(after?.networkUncertain).toBe(true);

    expect(
      findReusableUncertainOperation(
        getChatOpLedger(taskId).pending,
        fp,
      )?.itemId,
    ).toBe(itemId);

    const fpText = fingerprintFromChatSendArgs({ text: "retry-me!" });
    const fpAtt = fingerprintFromChatSendArgs({
      text,
      attachments: ["/tmp/x"],
    });
    const fpSkill = fingerprintFromChatSendArgs({
      text,
      skills: [{ name: "s", absPath: "/s" }],
    });
    expect(
      findReusableUncertainOperation(getChatOpLedger(taskId).pending, fpText),
    ).toBeUndefined();
    expect(
      findReusableUncertainOperation(getChatOpLedger(taskId).pending, fpAtt),
    ).toBeUndefined();
    expect(
      findReusableUncertainOperation(getChatOpLedger(taskId).pending, fpSkill),
    ).toBeUndefined();
  });
});
