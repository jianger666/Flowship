/**
 * per-task resource job 登记
 * （与 startingTasks 同形、独立模块避环）。
 *
 * 每个 job 可挂「当前在跑子进程」的 abort；stop/finalize/DELETE 终态 owner
 * 调 revokeResourceJobs 主动终止，再 join 等计数归零。
 *
 * join 超时 **fail-closed**——不再开闸放行删/复用工作区；改为
 * quarantine 隔离，后继 `ensureTaskWorktrees` 拒绝入场。HTTP 可先返回，资源 gate 不放行。
 *
 * quarantine 双条件契约（jobs==0 ≠ terminal cleanup 完成）：
 * - `resourceJobs==0`：旧资源事务已退出，**可以开始**终态 cleanup，但不等于 cleanup 已完成
 * - `terminalCleanup` reservation：finalize `removeTaskWorktrees` 的独立持有（含同步/deferred）
 * - quarantine **仅当**「jobs 归零」且「无在飞 terminal cleanup」两者都满足时才解除
 * - `endResourceJob` 归零时只通知 waiter + 尝试 maybeClear；**不得**无条件清 quarantine
 *
 * reservation 分 `waiting | executing` 两阶段——
 * - waiting：reopen 可 invalidate 作废（旧 cleanup 让位）
 * - executing：贯穿整个 `removeTaskWorktrees`；reopen 只能 409 busy，不得解除 quarantine
 *
 * generation / job 发号器与 Map 同挂 globalThis——防 route-chunk / HMR /
 * `vi.resetModules` 后模块局部计数从零复用旧代际（ABA）。
 *
 * TerminalCleanupCoordinator——per-task 单一 cleanup handle/promise：
 * - `acquireTerminalCleanup`：无在飞 → 唯一 token + 独占 promise；已有在飞 → `{ busy, promise }`
 *   （调用方 join、绝不重写 phase / 复用 token——关重复 finalize 双 holder 破坏序列）
 * - `markExecuting` / `release` 精确匹配 handle.token；任一 join 方拿不到 handle、不能提前 release
 * - 同步 remove 与 deferred 同一互斥；invalidate(waiting) 同时 resolve joiners
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

/** 终态 cleanup reservation 阶段 */
export type TerminalCleanupPhase = "waiting" | "executing";

/**
 * 唯一 cleanup 句柄——token 全局单调、与 mark/release 精确匹配。
 * 注意：token ≠ quarantine.generation（后者是隔离代际；前者是 cleanup 所有权）。
 */
export interface TerminalCleanupHandle {
  taskId: string;
  /** 全局唯一 cleanup token（globalThis 发号） */
  token: number;
}

/** acquire 结果——busy 时调用方只能 join，拿不到可 release 的 handle */
export type AcquireTerminalCleanupResult =
  | { busy: false; handle: TerminalCleanupHandle; promise: Promise<void> }
  | { busy: true; promise: Promise<void> };

/**
 * quarantine 条目——带单调代际 + 可选的终态 cleanup reservation。
 * generation 在 mark 时分配；cleanup 持有唯一 token + phase，提交前校验 token。
 */
interface QuarantineEntry {
  /** 进程单调代际（本 task 内） */
  generation: number;
  /**
   * 终态 cleanup 持有的唯一 token；null = 无在飞 terminal cleanup。
   * reopen 作废 waiting 后旧 token 失效（不再与 generation 相等）。
   */
  terminalCleanupGen: number | null;
  /**
   * waiting=可被 reopen 作废；executing=已入 remove、reopen 只能 busy。
   * 无 reservation 时为 null。
   */
  terminalCleanupPhase: TerminalCleanupPhase | null;
}

/**
 * per-task 单一 cleanup coordinator——与 quarantine reservation 同步寿命。
 * 重复 finalize join 同一 promise；invalidate(waiting) 时 resolve 并摘条目。
 */
interface TerminalCleanupCoordEntry {
  token: number;
  phase: TerminalCleanupPhase;
  promise: Promise<void>;
  resolve: () => void;
}

/** 发号器与 Map 同寿命（换 key 防 hot-reload 读到旧形状） */
const RESOURCE_JOBS_GLOBAL_KEY = "__feAiFlowResourceJobsV2__";
const QUARANTINE_GLOBAL_KEY = "__feAiFlowQuarantinedWorkspacesV3__";
const JOB_CLEARED_WAITERS_KEY = "__feAiFlowResourceJobClearedWaitersV1__";
/** jobSeq + quarantineGen + cleanupToken 单调计数器 */
const RESOURCE_COUNTERS_GLOBAL_KEY = "__feAiFlowResourceCountersV1__";
/** TerminalCleanupCoordinator 条目（与 quarantine 同寿命语义） */
const TERMINAL_CLEANUP_COORD_KEY = "__feAiFlowTerminalCleanupCoordV1__";

type JobsByTask = Map<string, Map<string, JobEntry>>;
type QuarantineByTask = Map<string, QuarantineEntry>;
type JobClearedWaiters = Map<string, Set<() => void>>;
type CleanupCoordByTask = Map<string, TerminalCleanupCoordEntry>;

interface ResourceCounters {
  nextJobSeq: number;
  nextQuarantineGen: number;
  /** cleanup handle token 发号（与 Map 同挂、防 ABA） */
  nextCleanupToken: number;
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

/** 取（或初始化）全局单调发号器 */
const getResourceCounters = (): ResourceCounters => {
  const g = globalThis as unknown as Record<
    string,
    ResourceCounters | undefined
  >;
  if (!g[RESOURCE_COUNTERS_GLOBAL_KEY]) {
    g[RESOURCE_COUNTERS_GLOBAL_KEY] = {
      nextJobSeq: 0,
      nextQuarantineGen: 0,
      nextCleanupToken: 0,
    };
  }
  const counters = g[RESOURCE_COUNTERS_GLOBAL_KEY]!;
  // hot-reload / 旧 chunk 缺字段时补齐——避免 NaN token
  if (typeof counters.nextCleanupToken !== "number") {
    counters.nextCleanupToken = 0;
  }
  return counters;
};

/** per-task cleanup coordinator Map */
const getCleanupCoordMap = (): CleanupCoordByTask => {
  const g = globalThis as unknown as Record<
    string,
    CleanupCoordByTask | undefined
  >;
  if (!g[TERMINAL_CLEANUP_COORD_KEY]) {
    g[TERMINAL_CLEANUP_COORD_KEY] = new Map();
  }
  return g[TERMINAL_CLEANUP_COORD_KEY]!;
};

/** 生产默认 30s；单测可 `setResourceJoinTimeoutMsForTest` 缩短 */
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
 * finalize / DELETE 与 `joinResourceJobs` 共用超时（含测试 override）。
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
 * 登记（或更新）该 job 当前在跑子进程的终止函数。
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
 * 终态 owner（stop / finalize / DELETE）调用——触发所有已登记 abort。
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
        `[resource-jobs] revoke abort 抛错（忽略）task=${taskId}`,
        err,
      );
    }
  }
};

/**
 * 标记 workspace quarantine，返回当前 generation（单调号）。
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

/** 是否仍在 quarantine（ensure 入口拒绝复用同路径） */
export const isWorkspaceQuarantined = (taskId: string): boolean =>
  getQuarantineMap().has(taskId);

/** 强制清 quarantine（测试 / clearResourceJobs）；连同 cleanup reservation */
export const clearWorkspaceQuarantine = (taskId: string): void => {
  getQuarantineMap().delete(taskId);
};

/** 是否有在飞的终态 cleanup reservation */
export const hasTerminalCleanup = (taskId: string): boolean => {
  const cur = getQuarantineMap().get(taskId);
  return cur?.terminalCleanupGen != null;
};

/** 当前 cleanup 阶段；无 reservation → null */
export const getTerminalCleanupPhase = (
  taskId: string,
): TerminalCleanupPhase | null => {
  const cur = getQuarantineMap().get(taskId);
  if (cur?.terminalCleanupGen == null) return null;
  return cur.terminalCleanupPhase;
};

/**
 * try-acquire per-task 单一 TerminalCleanupCoordinator。
 *
 * - 无在飞 → 发唯一 token、phase=waiting、建独占 promise；同步/deferred remove 共用
 * - 已有在飞 → `{ busy: true, promise }`——调用方 join，**绝不**重写 phase / 复用 token
 *   （关 重复 finalize 复用 gen 降级 executing、或另一 holder 提前 release）
 */
export const acquireTerminalCleanup = (
  taskId: string,
): AcquireTerminalCleanupResult => {
  const coords = getCleanupCoordMap();
  const existing = coords.get(taskId);
  if (existing) {
    return { busy: true, promise: existing.promise };
  }

  const counters = getResourceCounters();
  const token = ++counters.nextCleanupToken;
  const m = getQuarantineMap();
  let cur = m.get(taskId);
  if (!cur) {
    markWorkspaceQuarantined(taskId);
    cur = m.get(taskId)!;
  }
  m.set(taskId, {
    generation: cur.generation,
    terminalCleanupGen: token,
    terminalCleanupPhase: "waiting",
  });

  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  coords.set(taskId, {
    token,
    phase: "waiting",
    promise,
    resolve,
  });
  return {
    busy: false,
    handle: { taskId, token },
    promise,
  };
};

/**
 * 兼容包装：无在飞时等价 acquire；已有在飞时抛错（禁止复用 token）。
 * 新代码请直接 `acquireTerminalCleanup`。
 */
export const holdTerminalCleanup = (taskId: string): number => {
  const acq = acquireTerminalCleanup(taskId);
  if (acq.busy) {
    throw new Error(
      "terminal cleanup already in flight; use acquireTerminalCleanup to join",
    );
  }
  return acq.handle.token;
};

/** cleanup token 是否仍是当前有效 reservation（reopen 作废 waiting 后为 false） */
export const isTerminalCleanupGenValid = (
  taskId: string,
  gen: number,
): boolean => {
  const cur = getQuarantineMap().get(taskId);
  return cur?.terminalCleanupGen === gen;
};

/** handle 是否仍持有有效 reservation */
export const isTerminalCleanupHandleValid = (
  handle: TerminalCleanupHandle,
): boolean => isTerminalCleanupGenValid(handle.taskId, handle.token);

/**
 * 原子将 reservation 从 waiting → executing（token 精确匹配）。
 * 支持 `(handle)` 或旧 `(taskId, gen)` 签名。
 * @returns true=已持有 executing（含同 token 幂等）；false=已被 reopen 作废 / token 不匹配
 */
export const markTerminalCleanupExecuting = (
  taskIdOrHandle: string | TerminalCleanupHandle,
  gen?: number,
): boolean => {
  const taskId =
    typeof taskIdOrHandle === "string" ? taskIdOrHandle : taskIdOrHandle.taskId;
  const token =
    typeof taskIdOrHandle === "string" ? gen! : taskIdOrHandle.token;
  const m = getQuarantineMap();
  const cur = m.get(taskId);
  if (!cur || cur.terminalCleanupGen !== token) return false;
  if (cur.terminalCleanupPhase === "executing") return true;
  if (cur.terminalCleanupPhase !== "waiting") return false;
  m.set(taskId, {
    generation: cur.generation,
    terminalCleanupGen: token,
    terminalCleanupPhase: "executing",
  });
  const coord = getCleanupCoordMap().get(taskId);
  if (coord && coord.token === token) {
    coord.phase = "executing";
  }
  return true;
};

/**
 * terminal cleanup 完成 → 释放 reservation + resolve joiners；
 * 若 jobs 已归零则解除 quarantine（双条件第二段）。
 * token 不匹配（已被 reopen 作废 / 非本 handle）→ no-op（关 提前 release）。
 * 支持 `(handle)` 或旧 `(taskId, gen)` 签名。
 */
export const releaseTerminalCleanup = (
  taskIdOrHandle: string | TerminalCleanupHandle,
  gen?: number,
): void => {
  const taskId =
    typeof taskIdOrHandle === "string" ? taskIdOrHandle : taskIdOrHandle.taskId;
  const token =
    typeof taskIdOrHandle === "string" ? gen! : taskIdOrHandle.token;
  const m = getQuarantineMap();
  const cur = m.get(taskId);
  if (!cur || cur.terminalCleanupGen !== token) return;
  m.set(taskId, {
    generation: cur.generation,
    terminalCleanupGen: null,
    terminalCleanupPhase: null,
  });
  const coords = getCleanupCoordMap();
  const coord = coords.get(taskId);
  if (coord && coord.token === token) {
    coords.delete(taskId);
    coord.resolve();
  }
  maybeClearQuarantine(taskId);
};

/** reopen 尝试作废 cleanup 的结果 */
export type InvalidateCleanupResult = "invalidated" | "busy" | "none";

/**
 * reopen 作废在飞 terminal cleanup——
 * - waiting：删掉 reservation + 立即解除 quarantine + resolve joiners（旧后台转 executing 失败让位）
 * - executing：返 busy（贯穿 remove，不得放行 prewarm）
 * @returns invalidated | busy | none
 */
export const invalidateTerminalCleanupForReopen = (
  taskId: string,
): InvalidateCleanupResult => {
  const m = getQuarantineMap();
  const cur = m.get(taskId);
  if (!cur || cur.terminalCleanupGen == null) return "none";
  // executing 期间 reopen 进不来——返回 busy，由 route 映射 409
  if (cur.terminalCleanupPhase === "executing") return "busy";
  const token = cur.terminalCleanupGen;
  // waiting：整条删掉 = 立即解除 quarantine；旧 token 再也 valid 不了
  m.delete(taskId);
  // 作废时 resolve joiners，避免重复 finalize 永远挂在 promise 上
  const coords = getCleanupCoordMap();
  const coord = coords.get(taskId);
  if (coord && coord.token === token) {
    coords.delete(taskId);
    coord.resolve();
  }
  return "invalidated";
};

/**
 * 双条件清 quarantine——jobs==0 且无 terminal cleanup reservation。
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
 * 等 jobs 归零（deferred cleanup 用；已归零则立刻 resolve）。
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
    // 测试兼容：只传 taskId 时删任意一条
    const first = jobs.keys().next().value;
    if (first !== undefined) jobs.delete(first);
  }
  // 归零只通知 waiter + 条件清 quarantine——有 terminal cleanup 在飞则保留隔离
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
 * revoke 后轮询等 resourceJobs 归零。
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
      `[resource-jobs] join 超时、workspace quarantine（fail-closed）task=${taskId} timeoutMs=${timeoutMs}`,
    );
    return "timeout";
  }
  return "cleared";
};

/** 测试 / 异常清理：强制清零某 task 的 resource job + quarantine + waiter + cleanup coord */
export const clearResourceJobs = (taskId: string): void => {
  getResourceJobsMap().delete(taskId);
  clearWorkspaceQuarantine(taskId);
  // 顺带清 coordinator，避免测试残留 promise 挂死后续用例
  const coords = getCleanupCoordMap();
  const coord = coords.get(taskId);
  if (coord) {
    coords.delete(taskId);
    coord.resolve();
  }
  notifyResourceJobsCleared(taskId);
};
