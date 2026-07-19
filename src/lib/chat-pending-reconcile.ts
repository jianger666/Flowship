/**
 * R31-1 / R32-1 / R33-1 / R35-2 / R36-2/3/4：前端 pending / Operation 对账纯函数。
 * 抽出来便于单测，避免拉 chat-view 客户端组件进 node 环境。
 *
 * R35-2：pending 升级为完整 Operation（itemId + payloadFingerprint + phase）；
 * R36-2：只消费明确 phase——user_reply=persisted（非终态）；成功终态仅 handedOff/delivered；
 * R36-3：outcome 走 message-op-schema 表驱动 decoder，未知 fail-closed；
 * R36-4：ghost → uncertain/unknown，绝不写 delivered。
 */

import type { ChatSkillRef } from "@/lib/chat-payload-fingerprint";
import {
  decodeMessageOpOutcome,
  isMessageOpActivePhase,
  normalizeWireOutcomeToLedger,
  type ClientLedgerOutcome,
  type MessageOpSnapshotEntry,
} from "@/lib/message-op-schema";

/**
 * R38-1：uncertain 成因——禁止再用 outcomes 缺键同时表达「没见过」与「见过未知终态」。
 * - network：响应丢失 / fetch reject，晚到 202 可回 sending
 * - unknown_terminal：已见未知 wire 终态，晚到 202/direct 不得清草稿、不得抹 uncertain
 */
export type UncertainCause = "network" | "unknown_terminal";

export type PendingLocalReplyLike = {
  itemId: string;
  displayText: string;
  /**
   * R34-4：HTTP 结果不确定（网络断开 / 响应丢失）——保留占位，
   * 等 bootstrap active+recentSettled 对账或同 id 重试。
   * @deprecated R35-2 起用 phase；保留以兼容旧测试 / event-stream
   */
  uncertain?: boolean;
  /** R35-2：payload 指纹（retry identity，不靠文案） */
  payloadFingerprint?: string;
  /**
   * R35-2 / R36-2：sending | uncertain | persisted。
   * persisted = 已有持久气泡、非终态（等待 handedOff / failed）。
   */
  phase?: "sending" | "uncertain" | "persisted";
  /** R38-1：uncertain 成因 marker（known terminal 收敛时随 pending 移除一并清掉） */
  uncertainCause?: UncertainCause;
};

/**
 * R35-2 / R36-2：完整 client Operation（pending 条目）
 * terminal 不在 pending 内——记入 settled + outcomes。
 * persisted 仍留 pending（ledger 跟踪），UI 层过滤不渲染占位。
 */
export type ChatOperation = {
  itemId: string;
  payloadFingerprint: string;
  phase: "sending" | "uncertain" | "persisted";
  displayText: string;
  text: string;
  images?: unknown[];
  attachments?: string[];
  skillRefs?: ChatSkillRef[];
  /** 与 itemId 对齐的 UI 行 key */
  id?: string;
  /** R38-1：见 UncertainCause */
  uncertainCause?: UncertainCause;
};

/** R36-3：client ledger 终态（unknown = 未知 wire / ghost，可同 id 重试） */
export type OpTerminalOutcome = ClientLedgerOutcome;

/** R35-2：Operation ledger——pending + 终态 id + outcome */
export type ChatOpState = {
  pending: ChatOperation[];
  settled: string[];
  outcomes: Record<string, OpTerminalOutcome>;
};

/** R32-1：早到终态记账上限（FIFO 淘汰最老） */
export const SETTLED_ITEM_IDS_MAX = 200;

/**
 * R33-1：客户端预生成短 itemId（crypto.randomUUID 去横线后取前 12）。
 * 在 POST 前登记 pending，消除「202 晚到插入幽灵」。
 */
export const allocClientChatQueueItemId = (): string => {
  const raw = crypto.randomUUID().replace(/-/g, "");
  return `cq_${raw.slice(0, 12)}`;
};

/**
 * R32-1：把 itemIds 记入 settled（已有则跳过）；超 max 时 FIFO 丢最老。
 * 用于 SSE 终态早于 202、202 回来时禁止再插 pending。
 * R37-5：仅裁 settled 数组；需要同步裁 outcomes 时走 rememberKnownTerminals。
 */
export const rememberSettledItemIds = (
  settled: readonly string[],
  ids: readonly string[],
  max = SETTLED_ITEM_IDS_MAX,
): string[] => {
  if (ids.length === 0) return [...settled];
  const seen = new Set(settled);
  const next = [...settled];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  if (next.length <= max) return next;
  return next.slice(next.length - max);
};

/** R37-5：outcomes 只保留仍在 settled 索引内的 key（与 FIFO 淘汰同一事务） */
const pruneOutcomesToSettled = (
  outcomes: Record<string, OpTerminalOutcome>,
  settled: readonly string[],
): Record<string, OpTerminalOutcome> => {
  const keep = new Set(settled);
  let changed = false;
  const next: Record<string, OpTerminalOutcome> = {};
  for (const [id, outcome] of Object.entries(outcomes)) {
    if (!keep.has(id)) {
      changed = true;
      continue;
    }
    // R37-4：unknown 从不进 outcomes；防御性清掉历史脏值
    if (outcome !== "delivered" && outcome !== "failed") {
      changed = true;
      continue;
    }
    next[id] = outcome;
  }
  return changed ? next : outcomes;
};

/**
 * R37-4 / R37-5：只接受 known terminal（delivered/failed）进 settled + outcomes。
 * unknown 调用方不得传入；first-outcome-wins；裁 settled 时同步删 outcomes key。
 */
export const rememberKnownTerminals = (
  settled: readonly string[],
  outcomes: Record<string, OpTerminalOutcome>,
  entries: readonly { itemId: string; outcome: "delivered" | "failed" }[],
  max = SETTLED_ITEM_IDS_MAX,
): { settled: string[]; outcomes: Record<string, OpTerminalOutcome> } => {
  if (entries.length === 0) {
    return {
      settled: [...settled],
      outcomes: pruneOutcomesToSettled(outcomes, settled),
    };
  }
  const seen = new Set(settled);
  const nextSettled = [...settled];
  const nextOutcomes = { ...outcomes };
  for (const e of entries) {
    if (!e.itemId) continue;
    // R37-4：仅 known 终态占坑；已有 known 不覆盖（first-outcome-wins）
    if (
      nextOutcomes[e.itemId] !== "delivered" &&
      nextOutcomes[e.itemId] !== "failed"
    ) {
      nextOutcomes[e.itemId] = e.outcome;
    }
    if (!seen.has(e.itemId)) {
      seen.add(e.itemId);
      nextSettled.push(e.itemId);
    }
  }
  const trimmed =
    nextSettled.length <= max
      ? nextSettled
      : nextSettled.slice(nextSettled.length - max);
  return {
    settled: trimmed,
    outcomes: pruneOutcomesToSettled(nextOutcomes, trimmed),
  };
};

/** R37-4：wire raw → known ledger outcome；未知/缺失 → null（不占终态） */
export const decodeKnownLedgerOutcome = (
  raw: string | undefined,
): "delivered" | "failed" | null => {
  if (raw == null || raw === "") return null;
  const decoded = decodeMessageOpOutcome(raw);
  if (!decoded.known) return null;
  return decoded.outcome === "delivered" ? "delivered" : "failed";
};

/** R32-1：itemId 是否已有终态（user_reply / queue_failed / queue_state 幽灵清除） */
export const isItemSettled = (
  settled: readonly string[],
  itemId: string,
): boolean => settled.includes(itemId);

/** R35-2：读取终态 outcome（无则 undefined） */
export const getOpTerminalOutcome = (
  outcomes: Record<string, OpTerminalOutcome>,
  itemId: string,
): OpTerminalOutcome | undefined => outcomes[itemId];

/**
 * R36-3：表驱动归一——只认精确 delivered / failure 枚举；未知 → unknown。
 * （旧字符串启发式已删除）
 */
export const normalizeLedgerOutcome = (
  raw: string | undefined,
): OpTerminalOutcome => normalizeWireOutcomeToLedger(raw);

/** R35-2：uncertain 同 fingerprint 才复用 id（改附件/skill/文案 → 新 id） */
export const findReusableUncertainOperation = <T extends PendingLocalReplyLike>(
  pending: readonly T[],
  payloadFingerprint: string,
): T | undefined =>
  pending.find((p) => {
    const phase = p.phase ?? (p.uncertain ? "uncertain" : "sending");
    if (phase !== "uncertain") return false;
    // 无指纹的旧条目：不猜文案，绝不复用
    if (!p.payloadFingerprint) return false;
    return p.payloadFingerprint === payloadFingerprint;
  });

/**
 * 收到落盘 user_reply → 按 meta.queueItemId 清 pending。
 * R34-6：有 queueItemId 只走 id 对账；displayText 仅留给无 id 的旧历史事件。
 * @deprecated R36-2：user_reply 非终态，请用 markPendingPersistedByUserReply
 */
export const removePendingByUserReply = <T extends PendingLocalReplyLike>(
  prev: T[],
  ev: { text: string; meta?: Record<string, unknown> | null },
): T[] => {
  const qid =
    typeof ev.meta?.queueItemId === "string" ? ev.meta.queueItemId : null;
  // R34-6：新协议事件必带 id；无 id 才按文案兜底（旧历史），避免两 tab 同文案误清
  const idx = qid
    ? prev.findIndex((p) => p.itemId === qid)
    : prev.findIndex((p) => p.displayText === ev.text);
  if (idx < 0) return prev;
  const next = [...prev];
  next.splice(idx, 1);
  return next;
};

/**
 * R36-2：user_reply = persisted 非终态——占位换持久气泡语义，不写 delivered、不进 settled。
 */
export const markPendingPersistedByUserReply = <T extends PendingLocalReplyLike>(
  prev: T[],
  ev: { text: string; meta?: Record<string, unknown> | null },
): T[] => {
  const qid =
    typeof ev.meta?.queueItemId === "string" ? ev.meta.queueItemId : null;
  const idx = qid
    ? prev.findIndex((p) => p.itemId === qid)
    : prev.findIndex((p) => p.displayText === ev.text);
  if (idx < 0) return prev;
  const next = [...prev];
  const cur = next[idx]!;
  next[idx] = {
    ...cur,
    phase: "persisted" as const,
    uncertain: false,
  };
  return next;
};

/**
 * R34-4 / R38-1：标 uncertain，不删 pending。
 * cause 默认 network（fetch reject / 响应丢失）；未知 wire 终态传 unknown_terminal。
 */
export const markPendingUncertain = <T extends PendingLocalReplyLike>(
  pending: T[],
  itemId: string,
  cause: UncertainCause = "network",
): T[] =>
  pending.map((p) =>
    p.itemId === itemId
      ? {
          ...p,
          uncertain: true,
          phase: "uncertain" as const,
          uncertainCause: cause,
        }
      : p,
  );

/**
 * R32-1 / R36-2：user_reply 对账——标 persisted，不记 settled / delivered。
 * （函数名保留兼容旧测试 import；语义已改为非终态）
 */
export const applyUserReplyTerminal = <T extends PendingLocalReplyLike>(
  pending: T[],
  settled: readonly string[],
  ev: { text: string; meta?: Record<string, unknown> | null },
): { pending: T[]; settled: string[] } => ({
  pending: markPendingPersistedByUserReply(pending, ev),
  // R36-2：persisted 不是终态，不进 settled（避免占坑挡后到 failed）
  settled: [...settled],
});

/** 收到 queue_failed 控制帧 → 按 itemIds 精确清除对应 pending */
export const removePendingByQueueFailed = <T extends PendingLocalReplyLike>(
  prev: T[],
  itemIds: string[],
): T[] => {
  if (itemIds.length === 0) return prev;
  const set = new Set(itemIds);
  return prev.filter((p) => !set.has(p.itemId));
};

/**
 * R32-1：queue_failed 终态对账——清 pending + 全量记入 settled（含未命中的早到 id）。
 */
export const applyQueueFailedTerminal = <T extends PendingLocalReplyLike>(
  pending: T[],
  settled: readonly string[],
  itemIds: string[],
): { pending: T[]; settled: string[] } => ({
  pending: removePendingByQueueFailed(pending, itemIds),
  settled: rememberSettledItemIds(settled, itemIds),
});

/**
 * R32-1：202 返回后是否允许插入 pending——已 settled 则禁止（终态已早到）。
 * R33-1：请求前已登记时，202 只做「是否保留」判定（不应再插第二条）。
 */
export const shouldInsertPendingAfter202 = (
  settled: readonly string[],
  itemId: string,
): boolean => !isItemSettled(settled, itemId);

/**
 * R33-1 / R36-2：onDone 清 pending——只清「已有明确终态」的条目；
 * 无终态的保持 / 标 uncertain（不再按 runStatus 猜成功）。
 */
export const applyDoneClearPending = <T extends PendingLocalReplyLike>(
  pending: T[],
  settled: readonly string[],
  outcomes: Record<string, OpTerminalOutcome> = {},
): { pending: T[]; settled: string[]; clearedIds: string[] } => {
  const clearedIds: string[] = [];
  const nextPending: T[] = [];
  for (const p of pending) {
    const outcome = outcomes[p.itemId];
    // R36-2：仅明确终态（delivered/failed）才清；unknown 与无 outcome 保留
    if (outcome === "delivered" || outcome === "failed") {
      clearedIds.push(p.itemId);
      continue;
    }
    // 无终态：保持 persisted 或标 uncertain（可同 id 对账/重试）
    if (p.phase === "persisted") {
      nextPending.push(p);
    } else {
      nextPending.push({
        ...p,
        uncertain: true,
        phase: "uncertain" as const,
      });
    }
  }
  return {
    pending: nextPending,
    settled: rememberSettledItemIds(settled, clearedIds),
    clearedIds,
  };
};

/**
 * R33-1：HTTP 失败 / 非排队 200 时摘掉请求前登记的 pending（可记 settled 防迟到对账）。
 */
export const dropPendingByItemId = <T extends PendingLocalReplyLike>(
  pending: T[],
  settled: readonly string[],
  itemId: string,
  options?: { rememberSettled?: boolean },
): { pending: T[]; settled: string[] } => {
  const nextPending = pending.filter((p) => p.itemId !== itemId);
  const nextSettled = options?.rememberSettled
    ? rememberSettledItemIds(settled, [itemId])
    : [...settled];
  return { pending: nextPending, settled: nextSettled };
};

/**
 * R32-2 / R33-1 / R36-4：SSE 重连 bootstrap 对账。
 *
 * - serverItemIds ∪ operationSnapshot(accepting|persisted) → 存活，保留
 * - recentSettled：可重放终态 → 清 pending + 记 settled
 * - 既不在 snapshot 也不在终态 → ghost → uncertain/unknown（绝不 delivered）
 */
export const reconcilePendingWithQueueState = <T extends PendingLocalReplyLike>(
  pending: T[],
  settled: readonly string[],
  outcomes: Record<string, OpTerminalOutcome>,
  serverItemIds: readonly string[],
  recentSettled: readonly { itemId: string; outcome?: string }[] = [],
  operationSnapshot: readonly MessageOpSnapshotEntry[] = [],
): {
  pending: T[];
  settled: string[];
  outcomes: Record<string, OpTerminalOutcome>;
  ghostIds: string[];
} => {
  const activeFromSnapshot = operationSnapshot
    .filter((e) => e.itemId && isMessageOpActivePhase(e.phase))
    .map((e) => e.itemId);
  const serverSet = new Set([...serverItemIds, ...activeFromSnapshot]);
  const snapshotById = new Map(
    operationSnapshot
      .filter((e) => e.itemId)
      .map((e) => [e.itemId, e] as const),
  );

  // R37-4：只有 known outcome 才进 terminal；unknown recentSettled 不摘 pending、不占 outcomes
  const knownTerminalEntries: {
    itemId: string;
    outcome: "delivered" | "failed";
  }[] = [];
  const unknownLedgerIds = new Set<string>();
  for (const e of recentSettled) {
    if (!e.itemId) continue;
    const known = decodeKnownLedgerOutcome(e.outcome);
    if (known) {
      knownTerminalEntries.push({ itemId: e.itemId, outcome: known });
    } else {
      unknownLedgerIds.add(e.itemId);
    }
  }
  const { settled: nextSettled, outcomes: nextOutcomes } =
    rememberKnownTerminals(settled, outcomes, knownTerminalEntries);
  const knownLedgerSet = new Set(knownTerminalEntries.map((e) => e.itemId));
  const settledSet = new Set(nextSettled);
  const ghostIds: string[] = [];
  const nextPending: T[] = [];
  const seenPending = new Set<string>();

  for (const p of pending) {
    const phase = p.phase ?? (p.uncertain ? "uncertain" : "sending");
    // 仍在服务端存活集合 → 保留；snapshot phase 可升级为 persisted
    if (serverSet.has(p.itemId)) {
      const snap = snapshotById.get(p.itemId);
      let nextPhase = phase;
      if (snap?.phase === "persisted") {
        nextPhase = "persisted";
      } else if (phase === "uncertain") {
        // 仍在 server active → 正证据覆盖旧 uncertain（含 unknown_terminal）
        nextPhase = "sending";
      }
      nextPending.push(
        nextPhase !== phase || phase === "uncertain"
          ? {
              ...p,
              uncertain: nextPhase === "uncertain",
              phase: nextPhase as "sending" | "uncertain" | "persisted",
              // 回 sending 时清 marker，避免后续 HTTP 误判
              ...(nextPhase === "sending"
                ? { uncertainCause: undefined }
                : {}),
            }
          : p,
      );
      seenPending.add(p.itemId);
      continue;
    }
    // R33-1 / R37-4：仅 known ledger / 本地已 settled → 清 pending
    if (knownLedgerSet.has(p.itemId) || settledSet.has(p.itemId)) {
      seenPending.add(p.itemId);
      continue;
    }
    // R37-4 / R38-1：unknown recentSettled → uncertain + unknown_terminal（可被后到 known 纠正）
    if (unknownLedgerIds.has(p.itemId)) {
      nextPending.push({
        ...p,
        uncertain: true,
        phase: "uncertain" as const,
        uncertainCause: "unknown_terminal" as const,
      });
      seenPending.add(p.itemId);
      continue;
    }
    // R34-4 / R36-4：uncertain 且服务端重启丢 ledger → 保留可同 id 重试
    if (phase === "uncertain") {
      nextPending.push(p);
      seenPending.add(p.itemId);
      continue;
    }
    // R36-4：真幽灵——无 snapshot 证据也无终态 → uncertain，绝不 delivered
    ghostIds.push(p.itemId);
    nextPending.push({
      ...p,
      uncertain: true,
      phase: "uncertain" as const,
    });
    seenPending.add(p.itemId);
  }

  // R36-10：bootstrap snapshot 重建本地没有的 active/persisted 条目
  for (const snap of operationSnapshot) {
    if (!snap.itemId || !isMessageOpActivePhase(snap.phase)) continue;
    if (seenPending.has(snap.itemId) || settledSet.has(snap.itemId)) continue;
    if (knownLedgerSet.has(snap.itemId)) continue;
    nextPending.push({
      itemId: snap.itemId,
      displayText: "",
      payloadFingerprint: snap.fingerprint ?? "",
      phase: snap.phase === "persisted" ? "persisted" : "sending",
      uncertain: false,
    } as T);
  }

  // R36-4：ghost 不进 settled（settled 曾被当 delivered 证据）
  return {
    pending: nextPending,
    settled: nextSettled,
    outcomes: nextOutcomes,
    ghostIds,
  };
};

// ---------------------------------------------------------------------------
// R35-2 / R36-2：统一 Operation reducer
// ---------------------------------------------------------------------------

export type ChatOpAction =
  | { type: "register"; op: ChatOperation }
  | {
      type: "user_reply";
      ev: { text: string; meta?: Record<string, unknown> | null };
    }
  | { type: "queue_failed"; itemIds: string[] }
  | {
      type: "queue_state";
      serverItemIds: readonly string[];
      recentSettled?: readonly { itemId: string; outcome?: string }[];
      /** R36-4：完整 operation snapshot（含 accepting/persisted） */
      operationSnapshot?: readonly MessageOpSnapshotEntry[];
    }
  /** R36-2：显式 operation phase / terminal 帧（成功终态唯一来源之一） */
  | {
      type: "message_op";
      itemId: string;
      phase?: string;
      outcome?: string;
    }
  | { type: "http_queued"; itemId: string }
  | { type: "http_direct_ok"; itemId: string }
  | { type: "http_settled"; itemId: string; outcome?: string }
  | { type: "http_reject_biz"; itemId: string }
  | { type: "http_reject_network"; itemId: string }
  | { type: "done_clear" }
  | { type: "clear_all" }
  | {
      type: "payload_mismatch";
      itemId: string;
    };

export type ChatOpReduceResult = {
  state: ChatOpState;
  /**
   * R35-2：http_reject_network 仲裁——
   * true = 已 delivered，调用方清草稿返回 true；
   * false = failed / uncertain / unknown，保留草稿。
   */
  clearDraft?: boolean;
  ghostIds?: string[];
  clearedIds?: string[];
};

export const emptyChatOpState = (): ChatOpState => ({
  pending: [],
  settled: [],
  outcomes: {},
});

const asOperations = <T extends PendingLocalReplyLike>(
  pending: T[],
): ChatOperation[] =>
  pending.map((p) => ({
    itemId: p.itemId,
    payloadFingerprint: p.payloadFingerprint ?? "",
    phase: (p.phase ??
      (p.uncertain ? "uncertain" : "sending")) as
      | "sending"
      | "uncertain"
      | "persisted",
    displayText: p.displayText,
    text: p.displayText,
    id: p.itemId,
    uncertainCause: p.uncertainCause,
  }));

/**
 * R35-2 / R36-2：HTTP / SSE / queue 全量提交到同一 reducer。
 * fetch reject 时查终态：仅明确 delivered → clearDraft；其余保留草稿。
 */
export const reduceChatOperation = (
  state: ChatOpState,
  action: ChatOpAction,
): ChatOpReduceResult => {
  switch (action.type) {
    case "register": {
      // 已有同 id pending → 替换；否则追加
      const without = state.pending.filter(
        (p) => p.itemId !== action.op.itemId,
      );
      return {
        state: {
          ...state,
          pending: [
            ...without,
            { ...action.op, phase: action.op.phase ?? "sending" },
          ],
        },
      };
    }
    case "user_reply": {
      // R36-2：只标 persisted，不写 delivered、不进 settled
      const pending = markPendingPersistedByUserReply(
        state.pending,
        action.ev,
      );
      return { state: { ...state, pending } };
    }
    case "queue_failed": {
      const pending = removePendingByQueueFailed(
        state.pending,
        action.itemIds,
      );
      const { settled, outcomes } = rememberKnownTerminals(
        state.settled,
        state.outcomes,
        action.itemIds
          .filter(Boolean)
          .map((itemId) => ({ itemId, outcome: "failed" as const })),
      );
      return { state: { pending, settled, outcomes } };
    }
    case "message_op": {
      // R36-2：显式 phase / outcome 帧
      const { itemId } = action;
      if (!itemId) return { state };

      // 非终态 phase
      if (action.phase === "accepting" || action.phase === "persisted") {
        const pending = state.pending.map((p) =>
          p.itemId === itemId
            ? {
                ...p,
                phase:
                  action.phase === "persisted"
                    ? ("persisted" as const)
                    : ("sending" as const),
                uncertain: false,
                // 正证据覆盖：清 unknown_terminal / network marker
                uncertainCause: undefined,
              }
            : p,
        );
        // 本地尚无条目时（跨路由恢复前）——仅 phase 更新不凭空建（等 snapshot）
        return { state: { ...state, pending } };
      }

      // handedOff 或 outcome → 终态；R37-4：unknown 不进 settled/outcomes
      const rawOutcome =
        action.outcome ??
        (action.phase === "handedOff" ? "delivered" : undefined);
      if (rawOutcome == null && action.phase !== "handedOff") {
        return { state };
      }
      const known = decodeKnownLedgerOutcome(
        rawOutcome ?? (action.phase === "handedOff" ? "delivered" : undefined),
      );
      if (!known) {
        // R38-1：未知 wire → unknown_terminal；outcomes 缺键不再兼表「见过未知」
        return {
          state: {
            ...state,
            pending: markPendingUncertain(
              state.pending,
              itemId,
              "unknown_terminal",
            ),
          },
        };
      }
      const pending = state.pending.filter((p) => p.itemId !== itemId);
      const { settled, outcomes } = rememberKnownTerminals(
        state.settled,
        state.outcomes,
        [{ itemId, outcome: known }],
      );
      return { state: { pending, settled, outcomes } };
    }
    case "queue_state": {
      // R37-4/5：known recentSettled 与 outcomes 在 reconcile 内同一事务写入/淘汰
      const { pending, settled, outcomes, ghostIds } =
        reconcilePendingWithQueueState(
          state.pending,
          state.settled,
          state.outcomes,
          action.serverItemIds,
          action.recentSettled,
          action.operationSnapshot,
        );
      // R36-4：ghost 只标 uncertain，不写 outcomes——绝不 delivered
      return { state: { pending, settled, outcomes }, ghostIds };
    }
    case "http_queued": {
      // 幂等 202：清 network-uncertain；若终态已早到则摘掉 pending
      if (!shouldInsertPendingAfter202(state.settled, action.itemId)) {
        const { pending, settled } = dropPendingByItemId(
          state.pending,
          state.settled,
          action.itemId,
        );
        return { state: { ...state, pending, settled } };
      }
      return {
        state: {
          ...state,
          pending: state.pending.map((p) => {
            if (p.itemId !== action.itemId) return p;
            // R38-1：已见 unknown 终态 → 晚到 202 不得把 uncertain 重置为 sending
            if (p.uncertainCause === "unknown_terminal") return p;
            return {
              ...p,
              phase: "sending" as const,
              uncertain: false,
              uncertainCause: undefined,
            };
          }),
        },
      };
    }
    case "http_direct_ok": {
      // R36-2：200 非 queued 仅表示受理中——保留 pending 等 user_reply/message_op
      // （旧逻辑摘 pending 会丢 ledger，导致 persisted 无法对账）
      return {
        state: {
          ...state,
          pending: state.pending.map((p) => {
            if (p.itemId !== action.itemId) return p;
            // R38-1：同上——unknown_terminal 证据不被 late direct 抹掉
            if (p.uncertainCause === "unknown_terminal") return p;
            return {
              ...p,
              phase: "sending" as const,
              uncertain: false,
              uncertainCause: undefined,
            };
          }),
        },
      };
    }
    case "http_settled": {
      // R37-1/4：缺失/未知 outcome 不合成 delivered、不进 settled；标 uncertain 可纠正
      const known = decodeKnownLedgerOutcome(action.outcome);
      if (!known) {
        return {
          state: {
            ...state,
            // R38-1：HTTP settled 未知 outcome 同属 unknown_terminal
            pending: markPendingUncertain(
              state.pending,
              action.itemId,
              "unknown_terminal",
            ),
          },
        };
      }
      const pending = state.pending.filter((p) => p.itemId !== action.itemId);
      const { settled, outcomes } = rememberKnownTerminals(
        state.settled,
        state.outcomes,
        [{ itemId: action.itemId, outcome: known }],
      );
      return { state: { pending, settled, outcomes } };
    }
    case "http_reject_biz": {
      const { pending, settled } = dropPendingByItemId(
        state.pending,
        state.settled,
        action.itemId,
      );
      return {
        state: { ...state, pending, settled },
        clearDraft: false,
      };
    }
    case "http_reject_network": {
      // R36-2/3：仅明确 delivered 才清草稿；settled 无 outcome / unknown 不得当成功
      const outcome = state.outcomes[action.itemId];
      if (outcome === "failed" || outcome === "unknown") {
        return { state, clearDraft: false };
      }
      if (outcome === "delivered") {
        const pending = state.pending.filter(
          (p) => p.itemId !== action.itemId,
        );
        return {
          state: { ...state, pending },
          clearDraft: true,
        };
      }
      return {
        state: {
          ...state,
          pending: markPendingUncertain(state.pending, action.itemId),
        },
        clearDraft: false,
      };
    }
    case "payload_mismatch": {
      // R35-2：同 id 内容不同 → 丢掉旧 pending，调用方转新 id 重发
      const { pending, settled } = dropPendingByItemId(
        state.pending,
        state.settled,
        action.itemId,
      );
      return { state: { ...state, pending, settled }, clearDraft: false };
    }
    case "done_clear": {
      // R36-2：按已有 outcome 对账，不猜每条成功
      const { pending, settled, clearedIds } = applyDoneClearPending(
        state.pending,
        state.settled,
        state.outcomes,
      );
      // R37-5：settled FIFO 裁剪时同步 outcomes key
      const { settled: nextSettled, outcomes } = rememberKnownTerminals(
        settled,
        state.outcomes,
        [],
      );
      return {
        state: { pending, settled: nextSettled, outcomes },
        clearedIds,
      };
    }
    case "clear_all": {
      return { state: emptyChatOpState() };
    }
    default: {
      return { state };
    }
  }
};

/**
 * R35-2：从旧 pending + settled 拼 ledger（chat-view 迁移期便利）。
 */
export const ledgerFromParts = <T extends PendingLocalReplyLike>(
  pending: T[],
  settled: readonly string[],
  outcomes: Record<string, OpTerminalOutcome> = {},
): ChatOpState => ({
  pending: asOperations(pending),
  settled: [...settled],
  outcomes: { ...outcomes },
});
