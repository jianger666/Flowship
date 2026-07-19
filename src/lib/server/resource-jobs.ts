/**
 * R28-1 / R29-2 / R30-2 / R31-2 / R32-3 / R32-4：per-task resource job 登记
 * （与 startingTasks 同形、独立模块避环）。
 *
 * R29-2：每个 job 可挂「当前在跑子进程」的 abort；stop/finalize/DELETE 终态 owner
 * 调 revokeResourceJobs 主动终止，再 join 等计数归零。
 *
 * R30-2：join 超时 **fail-closed**——不再开闸放行删/复用工作区；改为
 * quarantine 隔离，后继 `ensureTaskWorktrees` 拒绝入场。HTTP 可先返回，资源 gate 不放行。
 *
 * R31-2 quarantine 双条件契约（jobs==0 ≠ terminal cleanup 完成）：
 * - `resourceJobs==0`：旧资源事务已退出，**可以开始**终态 cleanup，但不等于 cleanup 已完成
 * - `terminalCleanup` reservation：finalize 延迟 `removeTaskWorktrees` 的独立代际持有
 * - quarantine **仅当**「jobs 归零」且「无在飞 terminal cleanup」两者都满足时才解除
 * - `endResourceJob` 归零时只通知 waiter + 尝试 maybeClear；**不得**无条件清 quarantine
 *
 * R32-3：reservation 分 `waiting | executing` 两阶段——
 * - waiting：reopen 可 invalidate 作废（旧 cleanup 让位）
 * - executing：贯穿整个 `removeTaskWorktrees`；reopen 只能 409 busy，不得解除 quarantine
 *
 * R32-4：generation / job 发号器与 Map 同挂 globalThis——防 route-chunk / HMR /
 * `vi.resetModules` 后模块局部计数从零复用旧代际（ABA）。
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

/** R32-3：终态 cleanup reservation 阶段 */
export type TerminalCleanupPhase = "waiting" | "executing";

/**
 * R31-2 / R32-3：quarantine 条目——带单调代际 + 可选的终态 cleanup reservation。
 * generation 在 mark 时分配；cleanup 持有时记下当时的 gen + phase，提交前校验。
 */
interface QuarantineEntry {
  /** 进程单调代际（本 task 内） */
  generation: number;
  /**
   * 终态 cleanup 持有的 generation；null = 无在飞 terminal cleanup。
   * 与 generation 相等时 reservation 有效；reopen 作废 waiting 后旧 gen 失效。
   */
  terminalCleanupGen: number | null;
  /**
   * R32-3：waiting=可被 reopen 作废；executing=已入 remove、reopen 只能 busy。
   * 无 reservation 时为 null。
   */
  terminalCleanupPhase: TerminalCleanupPhase | null;
}

/** R32-4：发号器与 Map 同寿命（换 key 防 hot-reload 读到旧形状） */
const RESOURCE_JOBS_GLOBAL_KEY = "__feAiFlowResourceJobsV2__";
const QUARANTINE_GLOBAL_KEY = "__feAiFlowQuarantinedWorkspacesV3__";
const JOB_CLEARED_WAITERS_KEY = "__feAiFlowResourceJobClearedWaitersV1__";
/** R32-4：jobSeq + quarantineGen 单调计数器（与 Map 同挂 globalThis） */
const RESOURCE_COUNTERS_GLOBAL_KEY = "__feAiFlowResourceCountersV1__";

type JobsByTask = Map<string, Map<string, JobEntry>>;
type QuarantineByTask = Map<string, QuarantineEntry>;
type JobClearedWaiters = Map<string, Set<() => void>>;

interface ResourceCounters {
  nextJobSeq: number;
  nextQuarantineGen: number;
}

const getResourceJobsMap = (): JobsByTask => {
  const g = globalThis as unknown as Record<string, JobsByTask | undefined>;
  if (!g[RESOURCE_JOBS_GLOBAL_KEY]) {
    g[RESOURCE_JOBS_GLOBAL_KEY] = new Map();
  }
  return g[RESOURCE_JOBS_GLOBAL_KEY]!;
};

const getQuarantineMap = (): QuarantineByTask => {
  const g = globalThis as unknown as Record<
    string,
    QuarantineByTask | undefined
  >;
  if (!g[QUARANTINE_GLOBAL_KEY]) {
    g[QUARANTINE_GLOBAL_KEY] = new Map();
  }
  return g[QUARANTINE_GLOBAL_KEY]!;
};

const getJobClearedWaiters = (): JobClearedWaiters => {
  const g = globalThis as unknown as Record<
    string,
    JobClearedWaiters | undefined
  >;
  if (!g[JOB_CLEARED_WAITERS_KEY]) {
    g[JOB_CLEARED_WAITERS_KEY] = new Map();
  }
  return g[JOB_CLEARED_WAITERS_KEY]!;
};

/** R32-4：取（或初始化）全局单调发号器 */
const getResourceCounters = (): ResourceCounters => {
  const g = globalThis as unknown as Record<
    string,
    ResourceCounters | undefined
  >;
  if (!g[RESOURCE_COUNTERS_GLOBAL_KEY]) {
    g[RESOURCE_COUNTERS_GLOBAL_KEY] = {
      nextJobSeq: 0,
      nextQuarantineGen: 0,
    };
  }
  return g[RESOURCE_COUNTERS_GLOBAL_KEY]!;
};

/** R30-2：生产默认 30s；单测可 `setResourceJoinTimeoutMsForTest` 缩短 */
export const DEFAULT_RESOURCE_JOIN_MS = 30_000;

/** 测试专用：覆盖 join 超时；传 null 恢复默认（模块局部即可，不进全局） */
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

/**
 * R31-2：finalize / DELETE 与 `joinResourceJobs` 共用超时（含测试 override）。
 * 显式传 `explicit` 时仍优先生效（生产硬编码场景）；省略则走 override → 默认 30s。
 */
export const getResourceJoinTimeoutMs = (explicit?: number): number =>
  resolveJoinTimeoutMs(explicit);

/** 进入 ensure / workspace 资源段前同步登记；返回 handle 供 abort 接线 */
export const beginResourceJob = (taskId: string): ResourceJobHandle => {
  const m = getResourceJobsMap();
  let jobs = m.get(taskId);
  if (!jobs) {
    jobs = new Map();
    m.set(taskId, jobs);
  }
  const counters = getResourceCounters();
  const jobId = `rj-${++counters.nextJobSeq}-${Date.now().toString(36)}`;
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

/**
 * R31-2：标记 workspace quarantine，返回当前 generation（单调号）。
 * 已在 quarantine 时幂等保留 generation / cleanup reservation（重复 mark 不作废 hold）。
 * 作废旧 cleanup 走 `invalidateTerminalCleanupForReopen`（显式 bump/删除）。
 */
export const markWorkspaceQuarantined = (taskId: string): number => {
  const m = getQuarantineMap();
  const prev = m.get(taskId);
  if (prev) return prev.generation;
  const counters = getResourceCounters();
  const generation = ++counters.nextQuarantineGen;
  m.set(taskId, {
    generation,
    terminalCleanupGen: null,
    terminalCleanupPhase: null,
  });
  return generation;
};

/** R30-2 / R31-2：是否仍在 quarantine（ensure 入口拒绝复用同路径） */
export const isWorkspaceQuarantined = (taskId: string): boolean =>
  getQuarantineMap().has(taskId);

/** R30-2：强制清 quarantine（测试 / clearResourceJobs）；连同 cleanup reservation */
export const clearWorkspaceQuarantine = (taskId: string): void => {
  getQuarantineMap().delete(taskId);
};

/** R31-2：是否有在飞的终态 cleanup reservation */
export const hasTerminalCleanup = (taskId: string): boolean => {
  const cur = getQuarantineMap().get(taskId);
  return cur?.terminalCleanupGen != null;
};

/** R32-3：当前 cleanup 阶段；无 reservation → null */
export const getTerminalCleanupPhase = (
  taskId: string,
): TerminalCleanupPhase | null => {
  const cur = getQuarantineMap().get(taskId);
  if (cur?.terminalCleanupGen == null) return null;
  return cur.terminalCleanupPhase;
};

/**
 * R31-2 / R32-3：终态 owner 进入 deferred cleanup 时持有 reservation（phase=waiting）。
 * 若尚未 quarantine 则先 mark；返回 cleanup gen（转 executing / 提交删除前必须仍 valid）。
 */
export const holdTerminalCleanup = (taskId: string): number => {
  const m = getQuarantineMap();
  let cur = m.get(taskId);
  if (!cur) {
    markWorkspaceQuarantined(taskId);
    cur = m.get(taskId)!;
  }
  const gen = cur.generation;
  m.set(taskId, {
    generation: gen,
    terminalCleanupGen: gen,
    terminalCleanupPhase: "waiting",
  });
  return gen;
};

/** R31-2：cleanup gen 是否仍是当前有效 reservation（reopen 作废 waiting 后为 false） */
export const isTerminalCleanupGenValid = (
  taskId: string,
  gen: number,
): boolean => {
  const cur = getQuarantineMap().get(taskId);
  return cur?.terminalCleanupGen === gen;
};

/**
 * R32-3：原子将 reservation 从 waiting → executing（gen 匹配才转）。
 * @returns true=已持有 executing（含幂等已 executing）；false=已被 reopen 作废 / gen 不匹配
 */
export const markTerminalCleanupExecuting = (
  taskId: string,
  gen: number,
): boolean => {
  const m = getQuarantineMap();
  const cur = m.get(taskId);
  if (!cur || cur.terminalCleanupGen !== gen) return false;
  if (cur.terminalCleanupPhase === "executing") return true;
  if (cur.terminalCleanupPhase !== "waiting") return false;
  m.set(taskId, {
    generation: cur.generation,
    terminalCleanupGen: gen,
    terminalCleanupPhase: "executing",
  });
  return true;
};

/**
 * R31-2：terminal cleanup 完成 → 释放 reservation；
 * 若 jobs 已归零则解除 quarantine（双条件第二段）。
 * gen 不匹配（已被 reopen 作废）→ no-op。
 */
export const releaseTerminalCleanup = (taskId: string, gen: number): void => {
  const m = getQuarantineMap();
  const cur = m.get(taskId);
  if (!cur || cur.terminalCleanupGen !== gen) return;
  m.set(taskId, {
    generation: cur.generation,
    terminalCleanupGen: null,
    terminalCleanupPhase: null,
  });
  maybeClearQuarantine(taskId);
};

/** R32-3：reopen 尝试作废 cleanup 的结果 */
export type InvalidateCleanupResult = "invalidated" | "busy" | "none";

/**
 * R31-2 / R32-3：reopen 作废在飞 terminal cleanup——
 * - waiting：删掉 reservation + 立即解除 quarantine（旧后台转 executing 失败让位）
 * - executing：返 busy（贯穿 remove，不得放行 prewarm）
 * @returns invalidated | busy | none
 */
export const invalidateTerminalCleanupForReopen = (
  taskId: string,
): InvalidateCleanupResult => {
  const m = getQuarantineMap();
  const cur = m.get(taskId);
  if (!cur || cur.terminalCleanupGen == null) return "none";
  // R32-3：executing 期间 reopen 进不来——返回 busy，由 route 映射 409
  if (cur.terminalCleanupPhase === "executing") return "busy";
  // waiting：整条删掉 = 立即解除 quarantine；旧 gen 再也 valid 不了
  m.delete(taskId);
  return "invalidated";
};

/**
 * R31-2：双条件清 quarantine——jobs==0 且无 terminal cleanup reservation。
 * endResourceJob 归零 / releaseTerminalCleanup 都会走到这里。
 */
const maybeClearQuarantine = (taskId: string): void => {
  if (hasResourceJobs(taskId)) return;
  const cur = getQuarantineMap().get(taskId);
  if (!cur) return;
  if (cur.terminalCleanupGen != null) return;
  getQuarantineMap().delete(taskId);
};

const notifyResourceJobsCleared = (taskId: string): void => {
  const waiters = getJobClearedWaiters().get(taskId);
  if (!waiters || waiters.size === 0) return;
  getJobClearedWaiters().delete(taskId);
  for (const resolve of waiters) {
    try {
      resolve();
    } catch {
      /* ignore */
    }
  }
};

/**
 * R31-2：等 jobs 归零（deferred cleanup 用；已归零则立刻 resolve）。
 * endResourceJob 归零时通知，避免只靠轮询。
 */
export const waitUntilResourceJobsCleared = (taskId: string): Promise<void> => {
  if (!hasResourceJobs(taskId)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const m = getJobClearedWaiters();
    let set = m.get(taskId);
    if (!set) {
      set = new Set();
      m.set(taskId, set);
    }
    set.add(resolve);
    // 登记后复查——防 end 与 wait 交错漏通知
    if (!hasResourceJobs(taskId)) {
      set.delete(resolve);
      if (set.size === 0) m.delete(taskId);
      resolve();
    }
  });
};

/** 资源段结束：按 handle 删条目；归零删 task 键 + 通知 waiter + maybeClear quarantine */
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
  // R31-2：归零只通知 waiter + 条件清 quarantine——有 terminal cleanup 在飞则保留隔离
  if (jobs.size === 0) {
    m.delete(taskId);
    notifyResourceJobsCleared(taskId);
    maybeClearQuarantine(taskId);
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

/** 测试 / 异常清理：强制清零某 task 的 resource job + quarantine + waiter */
export const clearResourceJobs = (taskId: string): void => {
  getResourceJobsMap().delete(taskId);
  clearWorkspaceQuarantine(taskId);
  notifyResourceJobsCleared(taskId);
};
