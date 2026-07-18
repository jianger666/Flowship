/**
 * R28-1 / R29-2 / R30-2：per-task resource job 登记（与 startingTasks 同形、独立模块避环）。
 *
 * R29-2：每个 job 可挂「当前在跑子进程」的 abort；stop/finalize/DELETE 终态 owner
 * 调 revokeResourceJobs 主动终止，再 join 等计数归零。
 *
 * R30-2：join 超时 **fail-closed**——不再开闸放行删/复用工作区；改为
 * `quarantinedWorkspaces` 隔离，后继 `ensureTaskWorktrees` 拒绝入场，直到 job 归零
 * （`endResourceJob` 清 quarantine）。HTTP 可先返回，资源 gate 不放行。
 *
 * 正确性：lease 让位路径只抛错、不 abort 别人的 job；每个 job 只 abort 自己登记的。
 */

/** beginResourceJob 返回的句柄——register / end 都靠 jobId 定位 */
export interface ResourceJobHandle {
  taskId: string;
  jobId: string;
}

interface JobEntry {
  /** 当前子进程终止函数；无在跑命令时为 null */
  abort: (() => void) | null;
}

const RESOURCE_JOBS_GLOBAL_KEY = "__feAiFlowResourceJobsV2__";
/** R30-2：join 超时后的 workspace 隔离标记（与 jobs Map 同形 globalThis） */
const QUARANTINE_GLOBAL_KEY = "__feAiFlowQuarantinedWorkspaces__";

type JobsByTask = Map<string, Map<string, JobEntry>>;

const getResourceJobsMap = (): JobsByTask => {
  const g = globalThis as unknown as Record<string, JobsByTask | undefined>;
  if (!g[RESOURCE_JOBS_GLOBAL_KEY]) {
    g[RESOURCE_JOBS_GLOBAL_KEY] = new Map();
  }
  return g[RESOURCE_JOBS_GLOBAL_KEY]!;
};

const getQuarantineSet = (): Set<string> => {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  if (!g[QUARANTINE_GLOBAL_KEY]) {
    g[QUARANTINE_GLOBAL_KEY] = new Set();
  }
  return g[QUARANTINE_GLOBAL_KEY]!;
};

let nextJobSeq = 0;

/** R30-2：生产默认 30s；单测可 `setResourceJoinTimeoutMsForTest` 缩短 */
export const DEFAULT_RESOURCE_JOIN_MS = 30_000;

/** 测试专用：覆盖 join 超时；传 null 恢复默认 */
let joinTimeoutOverrideMs: number | null = null;

export const setResourceJoinTimeoutMsForTest = (
  ms: number | null,
): void => {
  joinTimeoutOverrideMs = ms;
};

const resolveJoinTimeoutMs = (explicit?: number): number => {
  if (explicit != null) return explicit;
  if (joinTimeoutOverrideMs != null) return joinTimeoutOverrideMs;
  return DEFAULT_RESOURCE_JOIN_MS;
};

/** 进入 ensure / workspace 资源段前同步登记；返回 handle 供 abort 接线 */
export const beginResourceJob = (taskId: string): ResourceJobHandle => {
  const m = getResourceJobsMap();
  let jobs = m.get(taskId);
  if (!jobs) {
    jobs = new Map();
    m.set(taskId, jobs);
  }
  const jobId = `rj-${++nextJobSeq}-${Date.now().toString(36)}`;
  jobs.set(jobId, { abort: null });
  return { taskId, jobId };
};

/**
 * R29-2：登记（或更新）该 job 当前在跑子进程的终止函数。
 * 命令开始时挂上、结束时传 null / 空函数清掉；可多次更新（串行多条长命令）。
 */
export const registerJobAbort = (
  taskId: string,
  jobId: string,
  abort: (() => void) | null,
): void => {
  const entry = getResourceJobsMap().get(taskId)?.get(jobId);
  if (!entry) return;
  entry.abort = abort;
};

/**
 * R29-2：终态 owner（stop / finalize / DELETE）调用——触发所有已登记 abort。
 * ⚠️ 仅终态路径调用；lease 让位不得 revoke（避免误杀并行无关 job）。
 */
export const revokeResourceJobs = (taskId: string): void => {
  const jobs = getResourceJobsMap().get(taskId);
  if (!jobs) return;
  for (const entry of jobs.values()) {
    const fn = entry.abort;
    if (!fn) continue;
    try {
      fn();
    } catch (err) {
      console.warn(
        `[resource-jobs] R29-2：revoke abort 抛错（忽略）task=${taskId}`,
        err,
      );
    }
  }
};

/** R30-2：标记 workspace quarantine（join 超时 / 测试注入） */
export const markWorkspaceQuarantined = (taskId: string): void => {
  getQuarantineSet().add(taskId);
};

/** R30-2：是否仍在 quarantine（ensure 入口拒绝复用同路径） */
export const isWorkspaceQuarantined = (taskId: string): boolean =>
  getQuarantineSet().has(taskId);

/** R30-2：清 quarantine（job 归零 / 测试清理） */
export const clearWorkspaceQuarantine = (taskId: string): void => {
  getQuarantineSet().delete(taskId);
};

/** 资源段结束：按 handle 删条目；归零删 task 键 + 清 quarantine */
export const endResourceJob = (
  taskIdOrHandle: string | ResourceJobHandle,
  jobId?: string,
): void => {
  const taskId =
    typeof taskIdOrHandle === "string" ? taskIdOrHandle : taskIdOrHandle.taskId;
  const id =
    typeof taskIdOrHandle === "string" ? jobId : taskIdOrHandle.jobId;
  const m = getResourceJobsMap();
  const jobs = m.get(taskId);
  if (!jobs) return;
  if (id) {
    jobs.delete(id);
  } else {
    // 测试兼容：只传 taskId 时删任意一条（R29-A② 等）
    const first = jobs.keys().next().value;
    if (first !== undefined) jobs.delete(first);
  }
  // R30-2：旧事务真正退出（job 归零）才解除隔离——后继方可 ensure 同路径
  if (jobs.size === 0) {
    m.delete(taskId);
    clearWorkspaceQuarantine(taskId);
  }
};

/** finalize / stop / DELETE join：是否仍有在飞的资源操作 */
export const hasResourceJobs = (taskId: string): boolean =>
  (getResourceJobsMap().get(taskId)?.size ?? 0) > 0;

/**
 * R30-2：revoke 后轮询等 resourceJobs 归零。
 * - cleared：归零，可安全放行后续资源操作
 * - timeout：超时 → 置 quarantine（fail-closed），调用方 HTTP 可返回但不得删/复用工作区
 */
export type JoinResourceJobsResult = "cleared" | "timeout";

export const joinResourceJobs = async (
  taskId: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<JoinResourceJobsResult> => {
  const timeoutMs = resolveJoinTimeoutMs(options?.timeoutMs);
  const pollMs = options?.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (hasResourceJobs(taskId) && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
  if (hasResourceJobs(taskId)) {
    markWorkspaceQuarantined(taskId);
    console.error(
      `[resource-jobs] R30-2：join 超时、workspace quarantine（fail-closed）task=${taskId} timeoutMs=${timeoutMs}`,
    );
    return "timeout";
  }
  return "cleared";
};

/** 测试 / 异常清理：强制清零某 task 的 resource job + quarantine */
export const clearResourceJobs = (taskId: string): void => {
  getResourceJobsMap().delete(taskId);
  clearWorkspaceQuarantine(taskId);
};
