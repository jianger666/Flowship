/**
 * R31-1 / R32-1 / R33-1 / R35-2：前端 pending / Operation 对账纯函数。
 * 抽出来便于单测，避免拉 chat-view 客户端组件进 node 环境。
 *
 * R35-2：pending 升级为完整 Operation（itemId + payloadFingerprint + phase）；
 * HTTP resolve/reject、user_reply、queue_failed、queue_state 走同一 reducer。
 */

import type { ChatSkillRef } from "@/lib/chat-payload-fingerprint";

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
  /** R35-2：sending | uncertain（terminal 进 settled/outcomes，不留 pending） */
  phase?: "sending" | "uncertain";
};

/**
 * R35-2：完整 client Operation（pending 条目）
 * terminal 不在 pending 内——记入 settled + outcomes。
 */
export type ChatOperation = {
  itemId: string;
  payloadFingerprint: string;
  phase: "sending" | "uncertain";
  displayText: string;
  text: string;
  images?: unknown[];
  attachments?: string[];
  skillRefs?: ChatSkillRef[];
  /** 与 itemId 对齐的 UI 行 key */
  id?: string;
};

export type OpTerminalOutcome = "delivered" | "failed";

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

const rememberOutcome = (
  outcomes: Record<string, OpTerminalOutcome>,
  itemId: string,
  outcome: OpTerminalOutcome,
): Record<string, OpTerminalOutcome> => {
  if (!itemId) return outcomes;
  // first-outcome-wins：已有终态不覆盖（与 server ledger 对齐）
  if (outcomes[itemId]) return outcomes;
  return { ...outcomes, [itemId]: outcome };
};

const rememberOutcomes = (
  outcomes: Record<string, OpTerminalOutcome>,
  entries: readonly { itemId: string; outcome: OpTerminalOutcome }[],
): Record<string, OpTerminalOutcome> => {
  let next = outcomes;
  for (const e of entries) {
    next = rememberOutcome(next, e.itemId, e.outcome);
  }
  return next;
};

const normalizeLedgerOutcome = (
  raw: string | undefined,
): OpTerminalOutcome => {
  if (!raw) return "delivered";
  const lower = raw.toLowerCase();
  if (
    lower === "failed" ||
    lower === "fail" ||
    lower.includes("fail") ||
    lower === "cancelled" ||
    lower === "canceled" ||
    lower === "rejected"
  ) {
    return "failed";
  }
  return "delivered";
};

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

/** R34-4：网络不确定 → 标 uncertain，不删 pending */
export const markPendingUncertain = <T extends PendingLocalReplyLike>(
  pending: T[],
  itemId: string,
): T[] =>
  pending.map((p) =>
    p.itemId === itemId
      ? { ...p, uncertain: true, phase: "uncertain" as const }
      : p,
  );

/**
 * R32-1：user_reply 终态对账——清 pending；无论命中与否都把 queueItemId 记入 settled。
 * 未命中（终态早于 202）靠 settled 挡住后续插 pending。
 */
export const applyUserReplyTerminal = <T extends PendingLocalReplyLike>(
  pending: T[],
  settled: readonly string[],
  ev: { text: string; meta?: Record<string, unknown> | null },
): { pending: T[]; settled: string[] } => {
  const qid =
    typeof ev.meta?.queueItemId === "string" ? ev.meta.queueItemId : null;
  const nextPending = removePendingByUserReply(pending, ev);
  const nextSettled = qid
    ? rememberSettledItemIds(settled, [qid])
    : [...settled];
  return { pending: nextPending, settled: nextSettled };
};

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
 * R33-1：onDone(idle/error) 清 pending 时把清掉的 itemId 记入 settled，
 * 堵住「done 无 id 可记 → 晚到 202 插幽灵」（现 pending 登记先于请求，done 必有 id）。
 */
export const applyDoneClearPending = <T extends PendingLocalReplyLike>(
  pending: T[],
  settled: readonly string[],
): { pending: T[]; settled: string[]; clearedIds: string[] } => {
  const clearedIds = pending.map((p) => p.itemId).filter(Boolean);
  return {
    pending: [],
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
 * R32-2 / R33-1：SSE 重连 bootstrap 的 queue_state 对账。
 *
 * - serverItemIds：仍存活（队内 + in-flight）→ 保留 pending
 * - recentSettled：可重放终态 → 清 pending + 记 settled（关闭「重连空 state、202 未返」窗口）
 * - 既不在 server 也不在终态 → 幽灵，清除并记 settled（防迟到 202 再插）
 */
export const reconcilePendingWithQueueState = <T extends PendingLocalReplyLike>(
  pending: T[],
  settled: readonly string[],
  serverItemIds: readonly string[],
  recentSettled: readonly { itemId: string; outcome?: string }[] = [],
): { pending: T[]; settled: string[]; ghostIds: string[] } => {
  const serverSet = new Set(serverItemIds);
  const ledgerIds = recentSettled.map((e) => e.itemId).filter(Boolean);
  const ledgerSet = new Set(ledgerIds);
  let nextSettled = rememberSettledItemIds(settled, ledgerIds);
  const settledSet = new Set(nextSettled);
  const ghostIds: string[] = [];
  const nextPending: T[] = [];
  for (const p of pending) {
    const phase = p.phase ?? (p.uncertain ? "uncertain" : "sending");
    // 仍在服务端存活集合 → 保留；R34-4：曾 uncertain 则确认已受理
    if (serverSet.has(p.itemId)) {
      nextPending.push(
        phase === "uncertain"
          ? { ...p, uncertain: false, phase: "sending" as const }
          : p,
      );
      continue;
    }
    // R33-1：ledger / 本地已 settled → 清 pending（终态可重放）
    if (ledgerSet.has(p.itemId) || settledSet.has(p.itemId)) {
      continue;
    }
    // R34-4：uncertain 且服务端重启后既无 active 也无 ledger →
    // 保留占位让用户同 id 重试（不得当幽灵清掉）
    if (phase === "uncertain") {
      nextPending.push(p);
      continue;
    }
    // 真幽灵（断线丢终态且 ledger 也无）
    ghostIds.push(p.itemId);
  }
  nextSettled = rememberSettledItemIds(nextSettled, ghostIds);
  return {
    pending: nextPending,
    settled: nextSettled,
    ghostIds,
  };
};

// ---------------------------------------------------------------------------
// R35-2：统一 Operation reducer
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
   * false = failed / uncertain，保留草稿。
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
      (p.uncertain ? "uncertain" : "sending")) as "sending" | "uncertain",
    displayText: p.displayText,
    text: p.displayText,
    id: p.itemId,
  }));

/**
 * R35-2：HTTP / SSE / queue 全量提交到同一 reducer。
 * fetch reject 时查终态：delivered → clearDraft；failed → 保留草稿；无 → uncertain。
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
      const qid =
        typeof action.ev.meta?.queueItemId === "string"
          ? action.ev.meta.queueItemId
          : null;
      const { pending, settled } = applyUserReplyTerminal(
        state.pending,
        state.settled,
        action.ev,
      );
      const outcomes = qid
        ? rememberOutcome(state.outcomes, qid, "delivered")
        : state.outcomes;
      return { state: { pending, settled, outcomes } };
    }
    case "queue_failed": {
      const { pending, settled } = applyQueueFailedTerminal(
        state.pending,
        state.settled,
        action.itemIds,
      );
      const outcomes = rememberOutcomes(
        state.outcomes,
        action.itemIds.map((itemId) => ({ itemId, outcome: "failed" as const })),
      );
      return { state: { pending, settled, outcomes } };
    }
    case "queue_state": {
      const { pending, settled, ghostIds } = reconcilePendingWithQueueState(
        state.pending,
        state.settled,
        action.serverItemIds,
        action.recentSettled,
      );
      let outcomes = state.outcomes;
      for (const e of action.recentSettled ?? []) {
        if (!e.itemId) continue;
        outcomes = rememberOutcome(
          outcomes,
          e.itemId,
          normalizeLedgerOutcome(e.outcome),
        );
      }
      // 幽灵按 delivered 记（挡迟到 202；与旧 rememberSettled 语义一致）
      for (const id of ghostIds) {
        outcomes = rememberOutcome(outcomes, id, "delivered");
      }
      return { state: { pending, settled, outcomes }, ghostIds };
    }
    case "http_queued": {
      // 幂等 202：清 uncertain；若终态已早到则摘掉 pending
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
          pending: state.pending.map((p) =>
            p.itemId === action.itemId ? { ...p, phase: "sending" as const } : p,
          ),
        },
      };
    }
    case "http_direct_ok": {
      // 200 非 queued：摘预登记；真实气泡走 SSE（可能已 settled）
      const { pending, settled } = dropPendingByItemId(
        state.pending,
        state.settled,
        action.itemId,
      );
      return { state: { ...state, pending, settled } };
    }
    case "http_settled": {
      const outcome = normalizeLedgerOutcome(action.outcome);
      const { pending, settled } = dropPendingByItemId(
        state.pending,
        state.settled,
        action.itemId,
        { rememberSettled: true },
      );
      const outcomes = rememberOutcome(
        state.outcomes,
        action.itemId,
        outcome,
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
      // R35-2：SSE 终态先到时不得误标 uncertain / 保留草稿
      const outcome = state.outcomes[action.itemId];
      if (outcome === "failed") {
        return { state, clearDraft: false };
      }
      if (outcome === "delivered" || isItemSettled(state.settled, action.itemId)) {
        // settled 但无显式 outcome → 按 delivered（user_reply / ghost）
        const outcomes = rememberOutcome(
          state.outcomes,
          action.itemId,
          "delivered",
        );
        const pending = state.pending.filter(
          (p) => p.itemId !== action.itemId,
        );
        return {
          state: { ...state, pending, outcomes },
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
      const { pending, settled, clearedIds } = applyDoneClearPending(
        state.pending,
        state.settled,
      );
      let outcomes = state.outcomes;
      for (const id of clearedIds) {
        outcomes = rememberOutcome(outcomes, id, "delivered");
      }
      return { state: { pending, settled, outcomes }, clearedIds };
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
