/**
 * R31-1 / R32-1：前端 pending 对账纯函数（按 queue itemId，displayText 仅兜底旧事件）。
 * 抽出来便于单测，避免拉 chat-view 客户端组件进 node 环境。
 */

export type PendingLocalReplyLike = {
  itemId: string;
  displayText: string;
};

/** R32-1：早到终态记账上限（FIFO 淘汰最老） */
export const SETTLED_ITEM_IDS_MAX = 200;

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

/** 收到落盘 user_reply → 按 meta.queueItemId 清 pending；无 id 时按 displayText 兜底 */
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
 */
export const shouldInsertPendingAfter202 = (
  settled: readonly string[],
  itemId: string,
): boolean => !isItemSettled(settled, itemId);

/**
 * R32-2：SSE 重连 bootstrap 的 queue_state 对账。
 * 本地 pending 不在 server 存活集合、且无终态 → 幽灵，清除并记入 settled（防迟到 202 再插）。
 */
export const reconcilePendingWithQueueState = <T extends PendingLocalReplyLike>(
  pending: T[],
  settled: readonly string[],
  serverItemIds: readonly string[],
): { pending: T[]; settled: string[]; ghostIds: string[] } => {
  const serverSet = new Set(serverItemIds);
  const settledSet = new Set(settled);
  const ghostIds: string[] = [];
  const nextPending = pending.filter((p) => {
    if (serverSet.has(p.itemId) || settledSet.has(p.itemId)) return true;
    ghostIds.push(p.itemId);
    return false;
  });
  return {
    pending: nextPending,
    settled: rememberSettledItemIds(settled, ghostIds),
    ghostIds,
  };
};
