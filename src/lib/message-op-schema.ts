/**
 * MessageOperation wire schema（client / server 共享）
 *
 * 单一来源：phase / outcome 只在此定义；client 用 exhaustive decoder，
 * 禁止字符串启发式（含「带 fail 就失败」）。未知值 fail-closed，绝不默认 delivered。
 */

/** 非终态 + 成功终态 phase（失败终态走 MessageOpFailureOutcome） */
export type MessageOpPhase = "accepting" | "persisted" | "handedOff";

/**
 * 与 server FailQueuedItemsReason 全枚举对齐。
 * 任一失败通过 HTTP settled / recentSettled / message_op 到达时都必须精确映射 failed。
 */
export type MessageOpFailureOutcome =
  | "persist_failed"
  | "no_session"
  | "task_gone"
  | "flush_error"
  | "stopped"
  | "cancelled"
  | "error"
  | "startup_failed"
  | "rewound"
  | "deleted";

/** ledger / wire 终态 outcome（handedOff 对外 = delivered） */
export type MessageOpOutcome = "delivered" | MessageOpFailureOutcome;

/** 失败枚举表（表驱动；新增失败值只改这一处） */
export const MESSAGE_OP_FAILURE_OUTCOMES: readonly MessageOpFailureOutcome[] = [
  "persist_failed",
  "no_session",
  "task_gone",
  "flush_error",
  "stopped",
  "cancelled",
  "error",
  "startup_failed",
  "rewound",
  "deleted",
] as const;

/** 全部合法 outcome（含成功） */
export const MESSAGE_OP_OUTCOMES: readonly MessageOpOutcome[] = [
  "delivered",
  ...MESSAGE_OP_FAILURE_OUTCOMES,
] as const;

const FAILURE_SET = new Set<string>(MESSAGE_OP_FAILURE_OUTCOMES);

/**
 * exhaustive decoder——只认精确枚举；未知值 known:false（fail-closed）。
 */
export const decodeMessageOpOutcome = (
  raw: string,
):
  | { known: true; outcome: MessageOpOutcome }
  | { known: false } => {
  if (raw === "delivered") {
    return { known: true, outcome: "delivered" };
  }
  if (FAILURE_SET.has(raw)) {
    return { known: true, outcome: raw as MessageOpFailureOutcome };
  }
  return { known: false };
};

/** 合法非终态 / 成功 phase（snapshot 用） */
export const MESSAGE_OP_ACTIVE_PHASES: readonly MessageOpPhase[] = [
  "accepting",
  "persisted",
] as const;

export const isMessageOpActivePhase = (phase: string): boolean =>
  phase === "accepting" || phase === "persisted";

/**
 * wire outcome → client ledger 三态。
 * - delivered → delivered
 * - 全部 failure 枚举 → failed
 * - 未知 / 空 → unknown（绝不默认 delivered；默认 delivered 会掩盖未知 wire）
 */
export type ClientLedgerOutcome = "delivered" | "failed" | "unknown";

export const normalizeWireOutcomeToLedger = (
  raw: string | undefined,
): ClientLedgerOutcome => {
  if (raw == null || raw === "") return "unknown";
  const decoded = decodeMessageOpOutcome(raw);
  if (!decoded.known) return "unknown";
  if (decoded.outcome === "delivered") return "delivered";
  return "failed";
};

/** bootstrap operation snapshot 条目（server 代理输出） */
export type MessageOpSnapshotEntry = {
  itemId: string;
  phase: string;
  fingerprint?: string;
};
