/**
 * Worker 隔离翻转开关（v3.1 接线层，默认关闭 = 零行为变化）。
 *
 * - 关（默认）：现行为逐字节不变，所有 worker 模块只做 additive 存在；
 * - 开：task-runner Agent 生命周期经 WorkerManager + worker-ipc 进 worker，
 *   意图恢复走 worker-flip.recoverWithWorker，探针走 maybeFireWorkerRotation。
 * - 翻转的验证状态记「待联调」（真机验收见 LIVE_CHECKLIST.md），
 *   代码先行、默认关，暖刀不 cold cut。
 */

export const WORKER_ISOLATION_ENV = "FLOWSHIP_WORKER_ISOLATION" as const;

/** 仅显式 `1` / `true` 开启，其余一律关闭（含缺失）。 */
export const isWorkerIsolationEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => {
  const v = (env[WORKER_ISOLATION_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
};
