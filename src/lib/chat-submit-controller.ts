/**
 * Chat 提交控制器（纯函数，可单测、不拉 React）
 *
 * - 清草稿只认 ledger 最终 known delivered
 * - HTTP 2xx 落地前先仲裁 SSE 已到的 failed（反序）
 * - operationTaskId / submitToken 由请求发起时捕获，禁止用 current ref 定 owner
 */

import {
  dispatchChatOp,
  getChatOpLedger,
} from "@/lib/chat-op-ledger";
import type { ChatOpReduceResult } from "@/lib/chat-pending-reconcile";
import type { Task } from "@/lib/types";

/** sendChatReply 三分支（与 task-store 对齐；outcome 可选——缺失=unknown） */
export type ChatHttpReplyResult =
  | {
      settled: true;
      itemId: string;
      outcome?: string;
      task?: Task;
      persistWarning?: string;
    }
  | {
      queued: true;
      queuedCount: number;
      itemId: string;
      alreadyAccepted?: boolean;
      task?: Task;
      persistWarning?: string;
    }
  | {
      task: Task;
      autoStarted: boolean;
      queued?: false;
      persistWarning?: string;
    };

/**
 * 仅明确 delivered 才清草稿。
 * failed / unknown / 无 outcome → 保留草稿。
 */
export const shouldClearDraftForOutcome = (
  outcome: string | undefined,
): boolean => outcome === "delivered";

/**
 * 迟到 HTTP 的 task 快照只在「当前页仍是 operation 所属 task」时推父级。
 */
export const shouldApplyTaskUpdateForOperation = (
  currentTaskId: string,
  operationTaskId: string,
): boolean =>
  !!currentTaskId &&
  !!operationTaskId &&
  currentTaskId === operationTaskId;

/**
 * 提交锁绑定 request token——旧 A 的 finally 不得释放 B 的锁。
 */
export const shouldReleaseSubmitLock = (
  currentToken: string | null,
  finishingToken: string,
): boolean => currentToken === finishingToken;

/**
 * 把 HTTP 响应提交进指定 task 的 ledger，返回是否清草稿。
 * 调用方必须传入请求发起时捕获的 operationTaskId（不可变）。
 */
export const commitHttpChatReply = (args: {
  operationTaskId: string;
  /** 请求前登记的 client itemId（direct 分支用） */
  clientItemId: string;
  result: ChatHttpReplyResult;
}): {
  clearDraft: boolean;
  reduceResult: ChatOpReduceResult & { taskId: string };
  task?: Task;
  persistWarning?: string;
} => {
  const { operationTaskId, clientItemId, result } = args;
  const persistWarning =
    "persistWarning" in result && result.persistWarning
      ? result.persistWarning
      : undefined;

  if ("settled" in result && result.settled) {
    const reduceResult = dispatchChatOp(operationTaskId, {
      type: "http_settled",
      itemId: result.itemId,
      outcome: result.outcome,
    });
    return {
      // 仅 ledger 最终 delivered；缺/未知 outcome 不会写入 delivered
      clearDraft: shouldClearDraftForOutcome(
        reduceResult.state.outcomes[result.itemId],
      ),
      reduceResult,
      task: result.task,
      persistWarning,
    };
  }

  if ("queued" in result && result.queued) {
    // 失败 message_op 先到 → 不得因 202 清草稿
    // terminalKnowledge=unknown → 同样保留草稿（与 persistence 正交）
    const ledgerBefore = getChatOpLedger(operationTaskId);
    const prior = ledgerBefore.outcomes[result.itemId];
    const unknownTerminalBefore =
      ledgerBefore.pending.find((p) => p.itemId === result.itemId)
        ?.terminalKnowledge === "unknown";
    const reduceResult = dispatchChatOp(operationTaskId, {
      type: "http_queued",
      itemId: result.itemId,
    });
    const finalOutcome =
      reduceResult.state.outcomes[result.itemId] ?? prior;
    const unknownTerminalAfter =
      reduceResult.state.pending.find((p) => p.itemId === result.itemId)
        ?.terminalKnowledge === "unknown";
    if (unknownTerminalBefore || unknownTerminalAfter) {
      return {
        clearDraft: false,
        reduceResult,
        task: result.task,
        persistWarning,
      };
    }
    return {
      clearDraft:
        finalOutcome !== "failed" && finalOutcome !== "unknown",
      reduceResult,
      task: result.task,
      persistWarning,
    };
  }

  // direct 200：受理中，非终态；若 SSE 终态已失败 / unknown 则保留草稿
  const ledgerBefore = getChatOpLedger(operationTaskId);
  const prior = ledgerBefore.outcomes[clientItemId];
  const unknownTerminalBefore =
    ledgerBefore.pending.find((p) => p.itemId === clientItemId)
      ?.terminalKnowledge === "unknown";
  const reduceResult = dispatchChatOp(operationTaskId, {
    type: "http_direct_ok",
    itemId: clientItemId,
  });
  const finalOutcome =
    reduceResult.state.outcomes[clientItemId] ?? prior;
  const unknownTerminalAfter =
    reduceResult.state.pending.find((p) => p.itemId === clientItemId)
      ?.terminalKnowledge === "unknown";
  if (unknownTerminalBefore || unknownTerminalAfter) {
    return {
      clearDraft: false,
      reduceResult,
      task: "task" in result ? result.task : undefined,
      persistWarning,
    };
  }
  return {
    clearDraft:
      finalOutcome !== "failed" && finalOutcome !== "unknown",
    reduceResult,
    task: "task" in result ? result.task : undefined,
    persistWarning,
  };
};

/**
 * 网络/业务 reject 后的清草稿仲裁（走同一 ledger）。
 */
export const commitHttpChatReject = (args: {
  operationTaskId: string;
  clientItemId: string;
  kind: "biz" | "network";
}): { clearDraft: boolean; reduceResult: ChatOpReduceResult & { taskId: string } } => {
  const reduceResult = dispatchChatOp(args.operationTaskId, {
    type:
      args.kind === "biz" ? "http_reject_biz" : "http_reject_network",
    itemId: args.clientItemId,
  });
  return {
    clearDraft: reduceResult.clearDraft === true,
    reduceResult,
  };
};
