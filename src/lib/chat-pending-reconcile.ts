/**
 * R31-1 / R32-1 / R33-1：前端 pending 对账纯函数（按 queue itemId，displayText 仅兜底旧事件）。
 * 抽出来便于单测，避免拉 chat-view 客户端组件进 node 环境。
 */

export type PendingLocalReplyLike = {
  itemId: string;
  displayText: string;
  /**
   * R34-4：HTTP 结果不确定（网络断开 / 响应丢失）——保留占位，
   * 等 bootstrap active+recentSettled 对账或同 id 重试。
   */
  uncertain?: boolean;
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
    p.itemId === itemId ? { ...p, uncertain: true } : p,
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
    // 仍在服务端存活集合 → 保留；R34-4：曾 uncertain 则确认已受理
    if (serverSet.has(p.itemId)) {
      nextPending.push(p.uncertain ? { ...p, uncertain: false } : p);
      continue;
    }
    // R33-1：ledger / 本地已 settled → 清 pending（终态可重放）
    if (ledgerSet.has(p.itemId) || settledSet.has(p.itemId)) {
      continue;
    }
    // R34-4：uncertain 且服务端重启后既无 active 也无 ledger →
    // 保留占位让用户同 id 重试（不得当幽灵清掉）
    if (p.uncertain) {
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
