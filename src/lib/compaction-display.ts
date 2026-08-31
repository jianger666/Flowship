/**
 * 压缩上下文的展示契约。
 *
 * 两条上游，同一套过程行：
 *   - 自定义 pi：`compaction_start` / `compaction_end`
 *   - Cursor SDK：`onDelta` 的 `summary-started` / `summary` / `summary-completed`
 *     （SDK 叫 summarization，语义就是压缩）
 *
 * 压缩发生时字可能已经在屏上，但这一轮还没结束。过程行跟重连同档
 * （spinner + 粘性状态），不要走普通 info 灰细线。
 * 不提前 flush assistant_message：压缩本身代表对话还没结束。
 */

export const COMPACTION_META_KIND = "compaction" as const;
/** 旧 Cursor SDK 落盘用过这个 kind，展示仍当压缩完成行 */
export const LEGACY_SDK_SUMMARY_META_KIND = "sdk_summary" as const;

export const COMPACTION_RUNNING_LABEL = "正在压缩上下文…";
export const COMPACTION_DONE_LABEL = "已压缩上下文";
export const COMPACTION_ABORTED_LABEL = "压缩已取消";

export type CompactionStatus = "running" | "done" | "aborted";

type CompactionLike = {
  kind?: string;
  meta?: Record<string, unknown>;
};

export const isCompactionInfo = (ev: CompactionLike): boolean => {
  if (ev.kind !== "info") return false;
  const kind = ev.meta?.kind;
  return kind === COMPACTION_META_KIND || kind === LEGACY_SDK_SUMMARY_META_KIND;
};

export const isCompactionRunning = (ev: CompactionLike): boolean =>
  isCompactionInfo(ev) && ev.meta?.status === "running";

export const compactionEventText = (input: {
  start: boolean;
  aborted?: boolean;
}): string => {
  if (input.start) return COMPACTION_RUNNING_LABEL;
  if (input.aborted) return COMPACTION_ABORTED_LABEL;
  return COMPACTION_DONE_LABEL;
};

export const compactionEventMeta = (input: {
  start: boolean;
  aborted?: boolean;
  reason?: string;
}): {
  kind: typeof COMPACTION_META_KIND;
  status: CompactionStatus;
  reason?: string;
} => ({
  kind: COMPACTION_META_KIND,
  status: input.start ? "running" : input.aborted ? "aborted" : "done",
  ...(input.reason ? { reason: input.reason } : {}),
});

/**
 * 把流式气泡插到尾部连续 compaction 之前。
 * items 管线默认把 `__streaming__` 拼在末尾，压缩 info 会跑到回复上面；
 * 视觉上应该是「回复 → 正在压缩」。
 */
export const insertBeforeTrailingCompaction = <T extends CompactionLike>(
  items: readonly T[],
  item: T,
): T[] => {
  let insertAt = items.length;
  while (insertAt > 0 && isCompactionInfo(items[insertAt - 1]!)) {
    insertAt--;
  }
  const next = items.slice();
  next.splice(insertAt, 0, item);
  return next;
};
