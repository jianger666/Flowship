/**
 * R32-5：任务列表 refresh 提交闸（纯函数）
 *
 * 从 use-task-list 抽出，便于 Node 侧单测（vitest 不解析 hook 的 JSX）。
 * DELETE 200 推进 epoch 后，任何更早启动的 refresh 不得 setTasks；
 * successfulDeletedIds 再过滤迟到响应里的已删 id（双保险）。
 */

import type { TaskSummary } from "@/lib/types";

/** 进程内已成功删除 id 上限（Set 插入序淘汰最旧） */
export const SUCCESSFUL_DELETED_IDS_MAX = 256;

/** refresh 提交闸——发起时 epoch 若已被 DELETE 推进，丢弃迟到响应 */
export const canCommitTaskListRefresh = (
  startEpoch: number,
  currentEpoch: number,
): boolean => startEpoch === currentEpoch;

/** 过滤 pendingDeletes + successfulDeletedIds */
export const filterTaskListAfterRefresh = (
  list: TaskSummary[],
  pendingDeletes: ReadonlySet<string>,
  successfulDeletedIds: ReadonlySet<string>,
): TaskSummary[] => {
  if (pendingDeletes.size === 0 && successfulDeletedIds.size === 0) return list;
  return list.filter(
    (t) => !pendingDeletes.has(t.id) && !successfulDeletedIds.has(t.id),
  );
};

/** 有界记住已成功删除的 id（防进程内无限涨） */
export const rememberSuccessfulDeletedId = (
  set: Set<string>,
  id: string,
  maxSize: number = SUCCESSFUL_DELETED_IDS_MAX,
): void => {
  set.add(id);
  while (set.size > maxSize) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
};
