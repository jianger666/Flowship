/**
 * R28-1：per-task resource job 引用计数（与 startingTasks 同形、独立 Map）。
 *
 * 为何独立小模块：ensureTaskWorktrees（task-worktrees）与 finalize（task-runner /
 * task-stream）都要登记/查询；若放进 task-stream 再被 task-worktrees import，
 * 会形成 task-worktrees → task-stream → task-fs → task-worktrees 环。
 *
 * 正确性仍靠 lease + revoke；finalize 的 join 只缩窗（超时 warn 后继续），
 * 不是互斥证明。
 */

const RESOURCE_JOBS_GLOBAL_KEY = "__feAiFlowResourceJobsV1__";

const getResourceJobsMap = (): Map<string, number> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, number> | undefined
  >;
  if (!g[RESOURCE_JOBS_GLOBAL_KEY]) {
    g[RESOURCE_JOBS_GLOBAL_KEY] = new Map();
  }
  return g[RESOURCE_JOBS_GLOBAL_KEY]!;
};

/** 进入 ensure / workspace 资源段前 +1（须在第一个 await 前同步调用） */
export const beginResourceJob = (taskId: string): void => {
  const m = getResourceJobsMap();
  m.set(taskId, (m.get(taskId) ?? 0) + 1);
};

/** 资源段结束 -1；归零删键 */
export const endResourceJob = (taskId: string): void => {
  const m = getResourceJobsMap();
  const n = (m.get(taskId) ?? 0) - 1;
  if (n <= 0) m.delete(taskId);
  else m.set(taskId, n);
};

/** finalize join：是否仍有在飞的资源操作 */
export const hasResourceJobs = (taskId: string): boolean =>
  (getResourceJobsMap().get(taskId) ?? 0) > 0;

/** 测试 / 异常清理：强制清零某 task 的 resource job 计数 */
export const clearResourceJobs = (taskId: string): void => {
  getResourceJobsMap().delete(taskId);
};
