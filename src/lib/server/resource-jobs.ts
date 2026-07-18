/**
 * R28-1 / R29-2：per-task resource job 登记（与 startingTasks 同形、独立模块避环）。
 *
 * R29-2：每个 job 可挂「当前在跑子进程」的 abort；stop/finalize/DELETE 终态 owner
 * 调 revokeResourceJobs 主动终止，再 join 等计数归零——不再只靠 30s 空等让
 * checkout / `cp -Rc`（可达 600s）继续改物理工作区。
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

type JobsByTask = Map<string, Map<string, JobEntry>>;

const getResourceJobsMap = (): JobsByTask => {
  const g = globalThis as unknown as Record<string, JobsByTask | undefined>;
  if (!g[RESOURCE_JOBS_GLOBAL_KEY]) {
    g[RESOURCE_JOBS_GLOBAL_KEY] = new Map();
  }
  return g[RESOURCE_JOBS_GLOBAL_KEY]!;
};

let nextJobSeq = 0;

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

/** 资源段结束：按 handle 删条目；归零删 task 键 */
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
  if (jobs.size === 0) m.delete(taskId);
};

/** finalize / stop / DELETE join：是否仍有在飞的资源操作 */
export const hasResourceJobs = (taskId: string): boolean =>
  (getResourceJobsMap().get(taskId)?.size ?? 0) > 0;

/** 测试 / 异常清理：强制清零某 task 的 resource job */
export const clearResourceJobs = (taskId: string): void => {
  getResourceJobsMap().delete(taskId);
};
