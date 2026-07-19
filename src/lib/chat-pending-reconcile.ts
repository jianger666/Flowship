/**
 * R31-1：前端 pending 对账纯函数（按 queue itemId，displayText 仅兜底旧事件）。
 * 抽出来便于单测，避免拉 chat-view 客户端组件进 node 环境。
 */

export type PendingLocalReplyLike = {
  itemId: string;
  displayText: string;
};

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

/** 收到 queue_failed 控制帧 → 按 itemIds 精确清除对应 pending */
export const removePendingByQueueFailed = <T extends PendingLocalReplyLike>(
  prev: T[],
  itemIds: string[],
): T[] => {
  if (itemIds.length === 0) return prev;
  const set = new Set(itemIds);
  return prev.filter((p) => !set.has(p.itemId));
};
