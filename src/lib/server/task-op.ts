/**
 * per-task ownership 原子操作（V12）——叶子模块。
 *
 * 从 `task-stream.ts` 抽出：`task-worktrees` 需要 `snapshotTaskOp`，
 * 但静态 import task-stream 会形成
 * task-worktrees → task-stream → task-fs → task-worktrees 环。
 * 之前用 `await import("./task-stream")` 动态躲环，在 Turbopack dev
 * （尤其 HMR 重排模块求值顺序后）会拿到缺 `snapshotTaskOp` 的半初始化
 * namespace → `snapshotTaskOp is not a function` → 每次 resume 都 500
 * （2026-09-24 花果任务实锤）。
 *
 * 本模块零运行时依赖（只读 globalThis 单例），任何方向 import 都不构环。
 * 状态与 task-stream 共用同一个 globalThis key
 * （`__flowshipTaskRunnerStateV12__`），行为零漂移。
 */

/** V12：单个 task 的 ownership 内存态（不持久化——单进程内权威源）。 */
export interface TaskOwnershipState {
  /** 进程单调 generation：revoke 作废所有在飞 op 的准入；tombstone 语义保留 */
  gen: number;
  /** 当前启动/运行链的 owner op id；后继 claim 覆盖 = 换主；null = 无人持有 */
  currentOpId: number | null;
  /**
   * claim 计数（release 不动）：防 observer 的 null-opId ABA——
   * 「快照时无人持有 → 期间 claim → owner 正常 release 清回 null」会让
   * 只比 currentOpId 的 observer 判定重新变 true、迟到写复活。
   * observer 判定改比 claimSeq：期间有过任何 claim 即失效。
   */
  claimSeq: number;
}

/**
 * V12：启动/接管操作句柄。
 * - owner：claim 换主拿到的自己 opId
 * - observer：入场快照的 currentOpId（可能 null）——只用于「之后有没有人接管」判定、
 *   自己不持有所有权、release 对它是 no-op（防 observer 误释 owner 的号）
 */
export interface TaskOpHandle {
  taskId: string;
  kind: "owner" | "observer";
  opId: number | null;
  /** claim / snapshot 时快照的 generation */
  gen: number;
  /** claim / snapshot 时快照的 claim 计数（observer 判定用、见 TaskOwnershipState.claimSeq） */
  claimSeq: number;
}

// 与 task-stream.ts 的 TASK_RUNNER_GLOBAL_KEY 同值——同一进程单例，不可改。
// 铁律：两边都只能 Map.set 原地改，禁止替换整个 Map 对象——
// task-stream 在模块顶层缓存了 runningTasks/agentSessions 等引用，替换即分叉
// （Turbopack 下表现为部分调用读到半初始化 namespace，同类事故见 task-worktrees）。
const TASK_RUNNER_GLOBAL_KEY = "__flowshipTaskRunnerStateV12__";

interface TaskOpGlobals {
  taskOwnership?: unknown;
  nextTaskRunInstanceId?: unknown;
  runningTasks?: unknown;
  agentSessions?: unknown;
}

const opGlobals = (): TaskOpGlobals => {
  const g = globalThis as unknown as Record<string, unknown>;
  const cur = g[TASK_RUNNER_GLOBAL_KEY];
  if (typeof cur !== "object" || cur === null) {
    const fresh: TaskOpGlobals = {};
    g[TASK_RUNNER_GLOBAL_KEY] = fresh;
    return fresh;
  }
  return cur as TaskOpGlobals;
};

/** 只补缺失字段、永不重置已有 Map（与 task-stream 的 getRunnerState 共存）。 */
const taskOwnershipMap = (): Map<string, TaskOwnershipState> => {
  const r = opGlobals();
  if (!(r.taskOwnership instanceof Map)) r.taskOwnership = new Map();
  return r.taskOwnership as Map<string, TaskOwnershipState>;
};

/** 发号器：与 task-stream 的 allocTaskRunInstanceId 同一计数器。 */
const nextOpId = (): number => {
  const r = opGlobals();
  if (typeof r.nextTaskRunInstanceId !== "number" || r.nextTaskRunInstanceId < 1) {
    r.nextTaskRunInstanceId = 1;
  }
  const id = r.nextTaskRunInstanceId as number;
  r.nextTaskRunInstanceId = id + 1;
  return id;
};

const runningTasksMap = (): Map<string, unknown> | null => {
  const r = opGlobals().runningTasks;
  return r instanceof Map ? (r as Map<string, unknown>) : null;
};

const agentSessionsMap = (): Map<string, unknown> | null => {
  const r = opGlobals().agentSessions;
  return r instanceof Map ? (r as Map<string, unknown>) : null;
};

/**
 * 准入快照（路由入场同步取；语义 = 旧 getTaskOpGeneration）。
 * 无记录返 0——与 revoke 写入的进程单调 token（≥1）永不相等。
 */
export const getTaskOpGeneration = (taskId: string): number =>
  taskOwnershipMap().get(taskId)?.gen ?? 0;

/**
 * 为 RunningTaskRecord / AgentSessionRecord / TaskOpHandle.opId
 * 分配进程内唯一 instanceId。共用发号器——resume 同 agentId 时靠号区分新旧。
 */
export const allocTaskRunInstanceId = (): number => nextOpId();

/**
 * V12 owner 模式：原子换主（覆盖前任 currentOpId）。
 * admissionGen 必须等于当前 gen（路由入场同步快照）——不等说明 claim 前已有
 * stop/DELETE revoke、返 null（关闭「快照→claim」窗口；语义同 abortIfTaskOpStale）。
 */
export const claimTaskOp = (
  taskId: string,
  admissionGen: number,
): TaskOpHandle | null => {
  const m = taskOwnershipMap();
  const cur = m.get(taskId);
  const currentGen = cur?.gen ?? 0;
  if (currentGen !== admissionGen) return null;
  const opId = nextOpId();
  const claimSeq = (cur?.claimSeq ?? 0) + 1;
  m.set(taskId, { gen: currentGen, currentOpId: opId, claimSeq });
  return { taskId, kind: "owner", opId, gen: currentGen, claimSeq };
};

/**
 * V12 observer 模式：快照当前 { currentOpId, gen }、**不夺主**。
 * one-shot / ask-consume 用——后继 claim / stop revoke 后快照失效；
 * 自己绝不 dethrone 在飞的启动链（claim 会——那是「答问答把在飞推进顶死」的倒挂）。
 */
export const snapshotTaskOp = (taskId: string): TaskOpHandle => {
  const cur = taskOwnershipMap().get(taskId);
  return {
    taskId,
    kind: "observer",
    opId: cur?.currentOpId ?? null,
    gen: cur?.gen ?? 0,
    claimSeq: cur?.claimSeq ?? 0,
  };
};

/**
 * V12 唯一判定（不含 lifecycle——组合版见 task-runner 的 isOpOwner）。
 * - owner：currentOpId 仍是自己 + gen 未 revoke（release 后 currentOpId=null ≠ 自己、自然失效）
 * - observer：gen 未 revoke + **claimSeq 未变**（期间任何 claim 都作废快照；不比 currentOpId——
 *   否则「快照时 null → claim → owner release 清回 null」的 ABA 会让迟到写复活）
 */
export const isTaskOpCurrent = (h: TaskOpHandle): boolean => {
  const cur = taskOwnershipMap().get(h.taskId);
  const currentGen = cur?.gen ?? 0;
  if (currentGen !== h.gen) return false;
  if (h.kind === "owner") {
    return (cur?.currentOpId ?? null) === h.opId;
  }
  return (cur?.claimSeq ?? 0) === h.claimSeq;
};

/**
 * V12 owner 收尾释放：匹配才清 currentOpId（防误删接管者）；
 * observer handle 调它是 no-op（observer 的 opId 可能恰好等于在飞 owner）。
 */
export const releaseTaskOpIf = (h: TaskOpHandle): void => {
  if (h.kind !== "owner" || h.opId === null) return;
  const m = taskOwnershipMap();
  const cur = m.get(h.taskId);
  if (!cur || cur.currentOpId !== h.opId) return;
  // 只清 currentOpId、不动 claimSeq（observer 判定依赖它记住「有过 claim」）
  m.set(h.taskId, { ...cur, currentOpId: null });
};

/** 该 task 是否有在飞 run（替代读 task-stream 的 runningTasks，避免构环）。 */
export const isTaskRunning = (taskId: string): boolean =>
  runningTasksMap()?.has(taskId) ?? false;

/** 该 task 是否有存活 agent 会话（替代读 task-stream 的 agentSessions，避免构环）。 */
export const hasTaskAgentSession = (taskId: string): boolean =>
  agentSessionsMap()?.has(taskId) ?? false;
