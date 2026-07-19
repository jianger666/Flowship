/**
 * R31-1 / R32-1 / R33-1 / R35-2 / R36-2/3/4 / R40-1：前端 pending / Operation 对账纯函数。
 *
 * ---------------------------------------------------------------------------
 * R40-1：正交 product-state（取代一维 phase rank）
 * ---------------------------------------------------------------------------
 *
 * 三个事实轴互相独立，禁止再排成线性优先级（persisted > unknown > network）：
 *
 *   persistence:        "sending" | "persisted"
 *     —— 用户气泡是否已落盘（UI 是否隐藏本地占位只看此轴）
 *   terminalKnowledge:  "none" | "unknown"
 *     —— 终态是否可识别；known terminal 直接摘 pending，不进此轴
 *   networkUncertain:   boolean
 *     —— HTTP 响应是否丢失（same-id retry 的依据之一）
 *
 * join 律（`joinProductState` / `joinPendingProductState`）：
 *   - persistence：sending → persisted 只升不降（max）
 *   - terminalKnowledge：none → unknown 只升不降（max）；known 由 reducer 摘除
 *   - networkUncertain：格上为 OR（只升不降）——交换 / 结合 / 幂等
 *
 * networkUncertain 的「清除」不在格 join 内：
 *   同 id 收到新 transport ack（http_queued / http_direct_ok）是**定向**清除当前位，
 *   不是历史证据的交换律运算。原因：新一轮 HTTP 尝试可以再次置位；若把「曾经 ack」
 *   与「后来 reject」做成集合上 clear-wins，会错误吞掉重试失败。故 ack 清除与后续
 *   reject **故意不交换**——注释与 permutation 测试对此分账：格 join 测三轴单调 OR/max；
 *   ack 清除单独测「当前位 → false，且不碰 persistence / terminalKnowledge」。
 *
 * R41-1：bootstrap queue_state / operationSnapshot **没有** attempt generation / wire seq，
 * 不能证明比本地 http_reject_network / unknown terminal 更新——故只能单调 join
 * （可升 persistence、可重建 active），**禁止** clearAllUncertainty / 清 network 位。
 * 本地仍 uncertain 时 UI 继续「发送状态未知」是 fail-closed：无因果版本的 snapshot
 * 不能反驳本地证据；否则 draft 保留 + retry identity 被擦 → 同 payload 换新 id 双送。
 *
 * 四个消费者统一走同一 join：
 *   1) live message_op（unknown → terminalKnowledge；known → 摘 pending；
 *      accepting/persisted 可 clearAllUncertainty——同流 live 证据）
 *   2) bootstrap queue_state（只单调 join；unknown recentSettled 升 terminalKnowledge）
 *   3) HTTP commitHttpChatReply（清草稿看 terminalKnowledge；ack 只清 network）
 *   4) findReusableUncertainOperation（networkUncertain | terminalKnowledge=unknown）
 */

import type { ChatSkillRef } from "@/lib/chat-payload-fingerprint";
import {
  decodeMessageOpOutcome,
  isMessageOpActivePhase,
  normalizeWireOutcomeToLedger,
  type ClientLedgerOutcome,
  type MessageOpSnapshotEntry,
} from "@/lib/message-op-schema";

/** 气泡是否已落盘 */
export type PersistenceAxis = "sending" | "persisted";

/** 终态知识：known 不进轴（直接摘 pending） */
export type TerminalKnowledgeAxis = "none" | "unknown";

/** 三轴 product-state（单一事实源） */
export type PendingProductState = {
  persistence: PersistenceAxis;
  terminalKnowledge: TerminalKnowledgeAxis;
  networkUncertain: boolean;
};

/** @deprecated R40-1 起改用 terminalKnowledge / networkUncertain；保留类型别名供迁移阅读 */
export type UncertainCause = "network" | "unknown_terminal";

export type PendingLocalReplyLike = {
  itemId: string;
  displayText: string;
  payloadFingerprint?: string;
  /** 缺省按 sending / none / false 归一（测试构造可省略） */
  persistence?: PersistenceAxis;
  terminalKnowledge?: TerminalKnowledgeAxis;
  networkUncertain?: boolean;
  /**
   * UI 投影用（event-stream 占位行）——派生自 networkUncertain | terminalKnowledge，
   * 不是事实源；写入方应走 product-state。
   * 读取时若三轴皆缺且 uncertain=true → 当作 networkUncertain（旧测试构造）。
   */
  uncertain?: boolean;
};

/**
 * 完整 client Operation（pending 条目）
 * terminal 不在 pending 内——记入 settled + outcomes。
 * persisted 仍留 pending（ledger 跟踪），UI 层按 persistence 过滤不渲染占位。
 */
export type ChatOperation = {
  itemId: string;
  payloadFingerprint: string;
  persistence: PersistenceAxis;
  terminalKnowledge: TerminalKnowledgeAxis;
  networkUncertain: boolean;
  displayText: string;
  text: string;
  images?: unknown[];
  attachments?: string[];
  skillRefs?: ChatSkillRef[];
  /** 与 itemId 对齐的 UI 行 key */
  id?: string;
};

/** R36-3：client ledger 终态（unknown = 未知 wire / ghost，可同 id 重试） */
export type OpTerminalOutcome = ClientLedgerOutcome;

/** Operation ledger——pending + 终态 id + outcome */
export type ChatOpState = {
  pending: ChatOperation[];
  settled: string[];
  outcomes: Record<string, OpTerminalOutcome>;
};

/** R32-1：早到终态记账上限（FIFO 淘汰最老） */
export const SETTLED_ITEM_IDS_MAX = 200;

/** 初始 product-state（新登记） */
export const initialProductState = (): PendingProductState => ({
  persistence: "sending",
  terminalKnowledge: "none",
  networkUncertain: false,
});

/** UI：是否渲染「发送状态未知」占位样式 */
export const projectPendingUncertain = (
  p: Pick<PendingProductState, "networkUncertain" | "terminalKnowledge">,
): boolean => p.networkUncertain || p.terminalKnowledge === "unknown";

/** UI：persisted 后隐藏本地占位（正式气泡已在事件流） */
export const shouldHideLocalPlaceholder = (
  p: Pick<PendingProductState, "persistence">,
): boolean => p.persistence === "persisted";

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

/** R37-5：outcomes 只保留仍在 settled 索引内的 key */
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

/** R37-4：wire raw → known ledger outcome；未知/缺失 → null */
export const decodeKnownLedgerOutcome = (
  raw: string | undefined,
): "delivered" | "failed" | null => {
  if (raw == null || raw === "") return null;
  const decoded = decodeMessageOpOutcome(raw);
  if (!decoded.known) return null;
  return decoded.outcome === "delivered" ? "delivered" : "failed";
};

/** R32-1：itemId 是否已有终态 */
export const isItemSettled = (
  settled: readonly string[],
  itemId: string,
): boolean => settled.includes(itemId);

/** R35-2：读取终态 outcome */
export const getOpTerminalOutcome = (
  outcomes: Record<string, OpTerminalOutcome>,
  itemId: string,
): OpTerminalOutcome | undefined => outcomes[itemId];

/** R36-3：表驱动归一——只认精确 delivered / failure 枚举；未知 → unknown */
export const normalizeLedgerOutcome = (
  raw: string | undefined,
): OpTerminalOutcome => normalizeWireOutcomeToLedger(raw);

/**
 * 纯格 join：三轴各自单调，交换 / 结合 / 幂等。
 * 不含 transport-ack 清除（见模块顶注释）。
 */
export const joinProductState = (
  a: PendingProductState,
  b: PendingProductState,
): PendingProductState => ({
  persistence:
    a.persistence === "persisted" || b.persistence === "persisted"
      ? "persisted"
      : "sending",
  terminalKnowledge:
    a.terminalKnowledge === "unknown" || b.terminalKnowledge === "unknown"
      ? "unknown"
      : "none",
  networkUncertain: a.networkUncertain || b.networkUncertain,
});

/**
 * 把增量证据合入当前 product-state。
 * - 轴提升走格 join
 * - clearNetworkUncertain：定向清 network 位（仅同一次 HTTP queued/direct ack）
 * - clearAllUncertainty：仅 live message_op accepting/persisted（同流正证据）；
 *   bootstrap queue_state **不得**走此入口（无因果版本，见模块顶 R41-1）
 */
export type ProductStateIncoming = {
  persistence?: PersistenceAxis;
  terminalKnowledge?: TerminalKnowledgeAxis;
  networkUncertain?: boolean;
  clearNetworkUncertain?: boolean;
  clearAllUncertainty?: boolean;
};

export const joinPendingProductState = (
  current: PendingProductState,
  incoming: ProductStateIncoming,
): PendingProductState => {
  let next = joinProductState(current, {
    persistence: incoming.persistence ?? "sending",
    terminalKnowledge: incoming.terminalKnowledge ?? "none",
    networkUncertain: incoming.networkUncertain ?? false,
  });
  // 定向清除：不进入格 join，避免与「后到的新一轮 reject」伪交换
  if (incoming.clearAllUncertainty) {
    next = {
      ...next,
      terminalKnowledge: "none",
      networkUncertain: false,
    };
  } else if (incoming.clearNetworkUncertain) {
    next = { ...next, networkUncertain: false };
  }
  return next;
};

const readProduct = (
  p: Pick<
    PendingLocalReplyLike,
    "persistence" | "terminalKnowledge" | "networkUncertain" | "uncertain"
  >,
): PendingProductState => ({
  persistence: p.persistence ?? "sending",
  terminalKnowledge: p.terminalKnowledge ?? "none",
  // 旧测试只写 uncertain:true 时当作 network 轴置位
  networkUncertain:
    p.networkUncertain ??
    (p.persistence == null &&
    p.terminalKnowledge == null &&
    p.uncertain === true
      ? true
      : false),
});

const applyProductJoin = <T extends PendingLocalReplyLike>(
  p: T,
  incoming: ProductStateIncoming,
): T => {
  const joined = joinPendingProductState(readProduct(p), incoming);
  return {
    ...p,
    ...joined,
    uncertain: projectPendingUncertain(joined),
  };
};

/**
 * uncertain / unknown 同 fingerprint 才复用 id（改附件/skill/文案 → 新 id）。
 * R40-1：覆盖 persisted-but-response-lost（persistence=persisted 且 networkUncertain）。
 */
export const findReusableUncertainOperation = <T extends PendingLocalReplyLike>(
  pending: readonly T[],
  payloadFingerprint: string,
): T | undefined =>
  pending.find((p) => {
    const product = readProduct(p);
    const retryable =
      product.networkUncertain || product.terminalKnowledge === "unknown";
    if (!retryable) return false;
    if (!p.payloadFingerprint) return false;
    return p.payloadFingerprint === payloadFingerprint;
  });

/**
 * 收到落盘 user_reply → 按 meta.queueItemId 清 pending。
 * @deprecated R36-2：user_reply 非终态，请用 markPendingPersistedByUserReply
 */
export const removePendingByUserReply = <T extends PendingLocalReplyLike>(
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
  next.splice(idx, 1);
  return next;
};

/**
 * R36-2 / R40-1：user_reply = persistence 提升为 persisted，不写 delivered、不进 settled。
 * 经 join：不降级、不吞 terminalKnowledge / networkUncertain。
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
  next[idx] = applyProductJoin(next[idx]!, { persistence: "persisted" });
  return next;
};

/**
 * 标 network / unknown_terminal 不确定——走 product-state join，不硬写、不降 persistence。
 */
export const markPendingUncertain = <T extends PendingLocalReplyLike>(
  pending: T[],
  itemId: string,
  cause: UncertainCause = "network",
): T[] =>
  pending.map((p) => {
    if (p.itemId !== itemId) return p;
    if (cause === "unknown_terminal") {
      return applyProductJoin(p, { terminalKnowledge: "unknown" });
    }
    return applyProductJoin(p, { networkUncertain: true });
  });

/**
 * R32-1 / R36-2：user_reply 对账——标 persisted，不记 settled / delivered。
 */
export const applyUserReplyTerminal = <T extends PendingLocalReplyLike>(
  pending: T[],
  settled: readonly string[],
  ev: { text: string; meta?: Record<string, unknown> | null },
): { pending: T[]; settled: string[] } => ({
  pending: markPendingPersistedByUserReply(pending, ev),
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
 * R32-1：queue_failed 终态对账——清 pending + 全量记入 settled。
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
 * R32-1：202 返回后是否允许插入 pending——已 settled 则禁止。
 */
export const shouldInsertPendingAfter202 = (
  settled: readonly string[],
  itemId: string,
): boolean => !isItemSettled(settled, itemId);

/**
 * R33-1 / R36-2：onDone 清 pending——只清「已有明确终态」的条目；
 * 无终态的保持 / 标 networkUncertain（不再按 runStatus 猜成功）。
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
    if (outcome === "delivered" || outcome === "failed") {
      clearedIds.push(p.itemId);
      continue;
    }
    // 无终态：persisted 保持；否则标 network uncertain 可同 id 对账/重试
    if (readProduct(p).persistence === "persisted") {
      nextPending.push(p);
    } else {
      nextPending.push(applyProductJoin(p, { networkUncertain: true }));
    }
  }
  return {
    pending: nextPending,
    settled: rememberSettledItemIds(settled, clearedIds),
    clearedIds,
  };
};

/**
 * R33-1：HTTP 失败 / 非排队 200 时摘掉请求前登记的 pending。
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
 * R32-2 / R33-1 / R36-4 / R40-1 / R41-1：SSE 重连 bootstrap 对账。
 * unknown recentSettled 走同一 product join——不得硬写降 persistence。
 * active 分支只单调 join：可升 persistence，不得清 network / unknown（无因果版本）。
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
    const cur = readProduct(p);
    // 仍在服务端存活集合 → 保留；snapshot 只可提升 persistence（单调 join）。
    // R41-1：不得 clearAllUncertainty——bootstrap 无 attempt generation，不能反驳
    // 本地 network reject / unknown terminal；保留 uncertain 投影是 fail-closed。
    if (serverSet.has(p.itemId)) {
      const snap = snapshotById.get(p.itemId);
      let next = applyProductJoin(p, {});
      if (snap?.phase === "persisted") {
        next = applyProductJoin(next, { persistence: "persisted" });
      }
      nextPending.push(next);
      seenPending.add(p.itemId);
      continue;
    }
    if (knownLedgerSet.has(p.itemId) || settledSet.has(p.itemId)) {
      seenPending.add(p.itemId);
      continue;
    }
    // R40-1：unknown recentSettled → join terminalKnowledge，不硬写、不降 persistence
    if (unknownLedgerIds.has(p.itemId)) {
      nextPending.push(
        applyProductJoin(p, { terminalKnowledge: "unknown" }),
      );
      seenPending.add(p.itemId);
      continue;
    }
    // uncertain 且服务端重启丢 ledger → 保留可同 id 重试
    if (cur.networkUncertain || cur.terminalKnowledge === "unknown") {
      nextPending.push(applyProductJoin(p, {}));
      seenPending.add(p.itemId);
      continue;
    }
    // 真幽灵——无 snapshot 证据也无终态 → networkUncertain，绝不 delivered
    ghostIds.push(p.itemId);
    nextPending.push(applyProductJoin(p, { networkUncertain: true }));
    seenPending.add(p.itemId);
  }

  // bootstrap snapshot 重建本地没有的 active/persisted 条目
  for (const snap of operationSnapshot) {
    if (!snap.itemId || !isMessageOpActivePhase(snap.phase)) continue;
    if (seenPending.has(snap.itemId) || settledSet.has(snap.itemId)) continue;
    if (knownLedgerSet.has(snap.itemId)) continue;
    const product = initialProductState();
    const withPers =
      snap.phase === "persisted"
        ? joinPendingProductState(product, { persistence: "persisted" })
        : product;
    nextPending.push({
      itemId: snap.itemId,
      displayText: "",
      payloadFingerprint: snap.fingerprint ?? "",
      ...withPers,
      uncertain: projectPendingUncertain(withPers),
    } as T);
  }

  return {
    pending: nextPending,
    settled: nextSettled,
    outcomes: nextOutcomes,
    ghostIds,
  };
};

// ---------------------------------------------------------------------------
// 统一 Operation reducer
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
      operationSnapshot?: readonly MessageOpSnapshotEntry[];
    }
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
   * http_reject_network 仲裁——
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
  pending.map((p) => {
    const product = readProduct(p);
    return {
      itemId: p.itemId,
      payloadFingerprint: p.payloadFingerprint ?? "",
      ...product,
      displayText: p.displayText,
      text: p.displayText,
      id: p.itemId,
    };
  });

/**
 * HTTP / SSE / queue 全量提交到同一 reducer。
 * fetch reject 时查终态：仅明确 delivered → clearDraft；其余保留草稿。
 */
export const reduceChatOperation = (
  state: ChatOpState,
  action: ChatOpAction,
): ChatOpReduceResult => {
  switch (action.type) {
    case "register": {
      const without = state.pending.filter(
        (p) => p.itemId !== action.op.itemId,
      );
      const base = initialProductState();
      const product = {
        persistence: action.op.persistence ?? base.persistence,
        terminalKnowledge:
          action.op.terminalKnowledge ?? base.terminalKnowledge,
        networkUncertain:
          action.op.networkUncertain ?? base.networkUncertain,
      };
      return {
        state: {
          ...state,
          pending: [
            ...without,
            {
              ...action.op,
              ...product,
            },
          ],
        },
      };
    }
    case "user_reply": {
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
      const { itemId } = action;
      if (!itemId) return { state };

      // live message_op 非终态：同流正证据——可升 persistence 并清不确定轴
      // （与 bootstrap queue_state 不同：live 有因果次序，bootstrap 没有）
      if (action.phase === "accepting" || action.phase === "persisted") {
        const pending = state.pending.map((p) => {
          if (p.itemId !== itemId) return p;
          return applyProductJoin(p, {
            ...(action.phase === "persisted"
              ? { persistence: "persisted" as const }
              : {}),
            clearAllUncertainty: true,
          });
        });
        return { state: { ...state, pending } };
      }

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
      const { pending, settled, outcomes, ghostIds } =
        reconcilePendingWithQueueState(
          state.pending,
          state.settled,
          state.outcomes,
          action.serverItemIds,
          action.recentSettled,
          action.operationSnapshot,
        );
      return { state: { pending, settled, outcomes }, ghostIds };
    }
    case "http_queued": {
      // transport ack：只清 networkUncertain；persisted / unknown 不动
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
            p.itemId === action.itemId
              ? applyProductJoin(p, { clearNetworkUncertain: true })
              : p,
          ),
        },
      };
    }
    case "http_direct_ok": {
      return {
        state: {
          ...state,
          pending: state.pending.map((p) =>
            p.itemId === action.itemId
              ? applyProductJoin(p, { clearNetworkUncertain: true })
              : p,
          ),
        },
      };
    }
    case "http_settled": {
      const known = decodeKnownLedgerOutcome(action.outcome);
      if (!known) {
        return {
          state: {
            ...state,
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
        state.outcomes,
      );
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
 * 从旧 pending + settled 拼 ledger（chat-view 迁移期便利）。
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
