/**
 * chat 回退（rewind）标记：服务端在回退后追加的那条 info 事件上带
 * `meta[REWIND_META_KEY] = <被回退到的事件 id>`、`meta[REWIND_KEPT_META_KEY] = <回退后服务端保留的事件条数>`。
 *
 * 为什么需要它：事件日志对客户端是「只追加」的（mergeTaskEvents 只吸收本地末尾之后的新事件、
 * 更早的快照一律丢弃，这条保护用来挡乱序到达的旧快照 / mutation 全量回灌）。
 * 回退是唯一会「删掉服务端后半段」的操作——光靠 ts / 长度 / 序号无法把「过期旧快照」和
 * 「回退后的新快照」区分开，所以用一条显式的、随事件流（SSE / 快照 / 回退 HTTP 响应）一起到达的标记当可靠信号。
 *
 * 客户端怎么用（{@link planRewindTruncation}，**不猜**）：
 * 1. 本地找得到被回退事件 → 从它（含）起截掉，最精确；
 * 2. 找不到（本地只加载了尾部分页 / 已被截过）：
 *    - 本地是**完整窗口**（从日志第 0 条开始）→ 按 keptCount 截前缀（追加式日志，前缀必然一致）；
 *    - 否则本地快照不可信 → 返回 resync，由调用方做一次完整重新拉取，绝不保守地「不截」
 *      （那会让已被删掉的后半段永远留在界面上）。
 *
 * 纯函数、无依赖，服务端 route 与客户端 task-store 共用同一组 key。
 */

/** 回退 info 事件 meta 里存「被回退到的 user_reply 事件 id」的字段名 */
export const REWIND_META_KEY = "rewoundFromEventId";
/** 回退 info 事件 meta 里存「回退后服务端保留的事件条数（不含该 info 本身）」的字段名 */
export const REWIND_KEPT_META_KEY = "rewoundKeptCount";

export interface RewindMarker {
  /** 被回退到的事件 id（该事件及之后全部被服务端删除） */
  fromEventId: string;
  /** 回退后服务端保留的事件条数；旧版本事件没带时为 null */
  keptCount: number | null;
}

/** 构造写进 info 事件 meta 的标记 */
export const buildRewindMeta = (
  marker: RewindMarker,
): Record<string, unknown> => ({
  [REWIND_META_KEY]: marker.fromEventId,
  ...(marker.keptCount != null ? { [REWIND_KEPT_META_KEY]: marker.keptCount } : {}),
});

/** 取事件上的回退标记；不是回退事件返回 null */
export const readRewindMarker = (ev: {
  meta?: Record<string, unknown>;
}): RewindMarker | null => {
  const from = ev.meta?.[REWIND_META_KEY];
  if (typeof from !== "string" || !from) return null;
  const kept = ev.meta?.[REWIND_KEPT_META_KEY];
  return {
    fromEventId: from,
    keptCount:
      typeof kept === "number" && Number.isInteger(kept) && kept >= 0
        ? kept
        : null,
  };
};

export type RewindPlan<T> =
  | { kind: "truncate"; events: T[] }
  | { kind: "resync" };

/**
 * 决定怎么把本地事件列表对齐到一次回退（纯函数）。
 * `complete`：本地是否从日志第 0 条开始的完整窗口（调用方传 `!task.eventsTruncated`）。
 * 无需截断时 events 保持同一数组引用。
 */
export const planRewindTruncation = <T extends { id: string }>(
  events: T[],
  marker: RewindMarker,
  opts: { complete: boolean },
): RewindPlan<T> => {
  const idx = events.findIndex((e) => e.id === marker.fromEventId);
  if (idx >= 0) return { kind: "truncate", events: events.slice(0, idx) };
  if (opts.complete && marker.keptCount != null) {
    return {
      kind: "truncate",
      events:
        events.length > marker.keptCount
          ? events.slice(0, marker.keptCount)
          : events,
    };
  }
  return { kind: "resync" };
};
