/**
 * Task 流事件底座（V0.9.x 从 task-runner.ts 拆出、纯搬家零逻辑变更）
 *
 * 职责（task-runner / chat-runner / sdk-message-handler 共用的最底层）：
 *   - 流事件协议类型（TaskStreamEvent、跟 watch-task 路由 / use-task-watch hook 对齐）
 *   - 进程全局状态（runningTasks / subscribers / forkPendingTasks / runningChecks、挂 globalThis）
 *   - publish / subscribe（SSE 推送 fanout）
 *   - writeEventAndPublish（events.jsonl 持久化 + publish 一体）
 *   - truncate / stringifyMeta（事件文案截断小工具）
 *
 * 依赖方向（保证无环）：本模块只依赖 task-fs + types、不 import task-runner / chat-runner。
 * 跨进程状态挂 globalThis（避免 Next.js dev hot reload 拆 chunk 时分裂）。
 */

import { appendEvent } from "./task-fs";
import type { Task, TaskEvent, ActionRecord } from "@/lib/types";
import type { TaskFieldsSnapshot } from "./task-prompts";

// ----------------- 工具截断 -----------------

export const truncate = (s: string, max = 500): string =>
  s.length <= max ? s : `${s.slice(0, max)}…(truncated ${s.length - max} chars)`;

export const stringifyMeta = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

// ----------------- 流事件类型（publish/subscribe 协议） -----------------

// V0.6：跟 V0.5 ChatStreamEvent 同结构（避免 watch-task 路由 / use-task-watch hook 同步改）
// kind:
//   - event: events.jsonl 写新事件、UI 增量渲染
//   - task: task 状态变化（meta 更新）、UI 重 hydrate
//   - action: 单条 ActionRecord 更新（V0.6 新、UI 增量刷 timeline）
//   - done: agent run 终止（运行时层、跟 task 业务终态独立）
//   - error: 顶层错误（用于显示 toast）
//   - assistant_delta: assistant_message 流式 chunk、UI 拼接打字效果
export type TaskStreamEvent =
  | { kind: "event"; event: TaskEvent }
  | { kind: "task"; task: Task }
  | { kind: "action"; action: ActionRecord }
  | { kind: "done"; task: Task; ok: boolean }
  | { kind: "error"; message: string }
  | { kind: "assistant_delta"; text: string };

export type TaskStreamListener = (ev: TaskStreamEvent) => void;

// ----------------- 进程全局状态（挂 globalThis） -----------------

export interface RunningTaskRecord {
  /**
   * X3：本 run 登记的进程内实例号（单调发号）。
   * forceClear 后后继 B 会换新 record——旧 consume 收尾必须按 instanceId 门控，
   * 不能只靠 agentId（Agent.resume 可能复用同一持久化 agentId）。
   */
  instanceId: number;
  agentId: string;
  startedAt: number;
  // V0.6.6 热更：agent 启动时的 {title,role,feishuStoryUrl} 快照、reused 推进时 diff 出变更注入 directive
  startSnapshot: TaskFieldsSnapshot;
  cancel: () => void;
}

/**
 * V0.11：跨 run 存活的 agent 会话（wait 协议退役、改「create + 多轮 send」）。
 * run 自然结束后 agent 不 close、记录留在这——用户下一次操作（推进续用 / 再聊聊 /
 * ask 答案）直接 `agent.send()` 续同一会话。stop / error / finalize / 换新 agent 才关。
 * 泛型上不引 SDK 类型（task-stream 保持零 SDK 依赖）、由 task-runner 存取时收窄。
 */
export interface AgentSessionRecord {
  /**
   * R18-3：本会话内存实例号（进程内单调、与 RunningTaskRecord.instanceId 共用发号器）。
   * Agent.resume 会恢复同一持久化 agentId——只靠 agentId 关会话会误关后继 B；
   * 旧 run 收尾必须按 instanceId 精确匹配才 close。
   */
  instanceId: number;
  // Agent 实例（Awaited<ReturnType<typeof Agent.create>>、这里用结构化最小面收窄）
  agent: {
    agentId: string;
    send: (text: string) => Promise<unknown>;
    close: () => void;
  };
  agentId: string;
  /**
   * R24-6：本 agent 实例的 MCP caller token（create/resume 前分配、跨多轮 send 不变）。
   * bridge / MCP URL 用它做身份；B 起新 agent 发新 token 覆盖注册后，旧 A 迟到请求被拒。
   */
  callerToken?: string;
  createdAt: number;
  // V0.11.1：最近活跃时间（run 结束 / send 时刷）——空闲回收 sweeper 按它判 TTL
  lastActiveAt: number;
  // V0.6.6 热更快照（原挂 RunningTaskRecord、会话跨 run 后归会话所有）
  startSnapshot: TaskFieldsSnapshot;
}

// V0.8.18：一个 action 正在后台跑的后置 check 句柄（见 task-runner 的 runActionPostCheck）
export interface RunningCheck {
  // 这个 check 属于哪个 action（结果有效性判定 + 去重用）
  actionId: string;
  // 停止 / 推进新 action / 被新一轮 wait 顶替时 abort、杀 lint/typecheck 子进程
  controller: AbortController;
}

interface TaskRunnerGlobalState {
  // taskId → 运行中的 task 控制对象
  runningTasks: Map<string, RunningTaskRecord>;
  // V0.11：taskId → 跨 run 存活的 agent 会话（见 AgentSessionRecord）
  agentSessions: Map<string, AgentSessionRecord>;
  // taskId → 订阅者集合（watch-task 路由 subscribe）
  subscribers: Map<string, Set<TaskStreamListener>>;
  // V0.6：标记 task 即将被 force new agent（advanceTask forceNewAgent=true）
  // cancel 旧 run 时命中跳过 done、保留 SSE 通道给新 agent 用
  forkPendingTasks: Set<string>;
  // V0.8.18：taskId → 正在后台跑的后置 check（一个 task 同时只一个、新的顶旧的）
  runningChecks: Map<string, RunningCheck>;
  // 启动窗口「停止」竞态：Agent.create → 首条 send 返回并 runningTasks.set 之前，
  // cancelTaskRun 查不到活 run（rec.cancel 没人调）、closeTaskSession 也杀不掉飞行中的
  // send——若不记标记，UI 已标 cancelled/idle 但 agent 仍会注册进 runningTasks 继续跑
  // （线上实锤停后又跑数分钟）。只在「无 runningTasks entry」时由 cancelTaskRun 写入；
  // 新推进起跑时清掉（旧停止意图作废）；create 后 / consume 前各查一次消费。
  pendingStopRequests: Set<string>;
  /**
   * V2：internalStartAgent / sendToTaskSession / startOneShotQuestion 飞行窗口引用计数。
   * 用 Map 而非 Set——两个并发 sender 同 key 时，先返回者 end 不得把第二个「抹成不可见」，
   * 否则 stop 会误判无飞行消费者、清掉 pending，迟到的 send resolve 后复活 Agent。
   */
  startingTasks: Map<string, number>;
  /**
   * V12：per-task ownership（gen + currentOpId 合并）。
   * - gen：stop / DELETE / finalize 的 revoke 写入进程单调号（tombstone 不清除、W1 防 ABA）
   * - currentOpId：当前启动/运行链的 owner op id；后继 claim 覆盖 = 换主；null = 无人持有
   *
   * 旧 taskOpGenerations / taskStartOwners 两字段已删（gen 迁入本结构）。
   */
  taskOwnership: Map<string, TaskOwnershipState>;
  /**
   * W1：进程级单调 token（从 1 起）。revoke 时分配给 gen、永不重复、永不回到 0。
   * 与「无键默认 0」永远不相等 → DELETE 后旧 snap=0 恒 stale。
   */
  nextTaskOpToken: number;
  /**
   * X3 / R18-3：RunningTaskRecord + AgentSessionRecord.instanceId 共用发号器（进程内单调）。
   * 每次 runningTasks.set / agentSessions.set 取号；旧 run 被强清后后继 B 拿新号，
   * 迟到收尾靠号比对让位（resume 同 agentId 时只能靠 instanceId 区分）。
   *
   * V12：TaskOpHandle.opId 也复用本发号器——同 action 双唤醒靠 opId 区分。
   */
  nextTaskRunInstanceId: number;
}

/**
 * V12：单个 task 的 ownership 内存态（不持久化——Electron 单进程内权威源）。
 */
export interface TaskOwnershipState {
  /** 进程单调 generation：revoke 作废所有在飞 op 的准入；tombstone 语义保留（W1） */
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

// V12：2026-07-18 ownership 收敛——taskOpGenerations + taskStartOwners → taskOwnership
// V11：2026-07-18 R20-1——taskStartOwners（per-start owner token，同 action 双唤醒）
// V10：2026-07-18 R18-3——AgentSessionRecord.instanceId（与 run 共用发号器）
// V9：2026-07-18 X3——nextTaskRunInstanceId（run owner 门控）
// V8：2026-07-18 W1——nextTaskOpToken 进程级单调 + 删 clear（tombstone 防 ABA）
// V7：2026-07-18 加 taskOpGenerations + startingTasks 改 refcount Map（V1/V2）
// V6：2026-07-18 加 startingTasks Set（stop/DELETE 与 Agent.create 飞行窗口竞态）
// V5：2026-07-15 加 pendingStopRequests（停止按钮 vs 启动窗口竞态）
// V4：2026-07-07 V0.11 加 agentSessions（wait 退役、agent 会话跨 run 存活）
// V3：2026-06-22 V0.8.18 加 runningChecks（后置 check 异步化、bump 防 dev hot reload 拿到旧 state 缺字段）
// V2：2026-05-27 V0.6 上线、bump 版本号防 dev hot reload 拿到 V0.5 残留 state
const TASK_RUNNER_GLOBAL_KEY = "__feAiFlowTaskRunnerStateV12__";

const coerceStartingMap = (
  raw: Map<string, number> | Set<string> | undefined,
): Map<string, number> => {
  if (raw instanceof Map) return raw;
  // hot-reload 可能仍挂着 V6 的 Set——转成计数 1，避免起飞中任务突然「不可见」
  if (raw instanceof Set) {
    const m = new Map<string, number>();
    for (const id of raw) m.set(id, 1);
    return m;
  }
  return new Map();
};

const getRunnerState = (): TaskRunnerGlobalState => {
  const g = globalThis as unknown as Record<
    string,
    TaskRunnerGlobalState | undefined
  >;
  if (!g[TASK_RUNNER_GLOBAL_KEY]) {
    g[TASK_RUNNER_GLOBAL_KEY] = {
      runningTasks: new Map(),
      agentSessions: new Map(),
      subscribers: new Map(),
      forkPendingTasks: new Set(),
      runningChecks: new Map(),
      pendingStopRequests: new Set(),
      startingTasks: new Map(),
      taskOwnership: new Map(),
      nextTaskOpToken: 1,
      nextTaskRunInstanceId: 1,
    };
  }
  const state = g[TASK_RUNNER_GLOBAL_KEY]!;
  // hot-reload 兜底：旧 chunk 可能写出缺字段 / Set 形态的半残 state
  state.startingTasks = coerceStartingMap(
    state.startingTasks as Map<string, number> | Set<string> | undefined,
  );
  if (!state.pendingStopRequests) state.pendingStopRequests = new Set();
  if (!(state.taskOwnership instanceof Map)) {
    state.taskOwnership = new Map();
  }
  if (typeof state.nextTaskOpToken !== "number" || state.nextTaskOpToken < 1) {
    state.nextTaskOpToken = 1;
  }
  if (
    typeof state.nextTaskRunInstanceId !== "number" ||
    state.nextTaskRunInstanceId < 1
  ) {
    state.nextTaskRunInstanceId = 1;
  }
  return state;
};

export const runningTasks = getRunnerState().runningTasks;
export const agentSessions = getRunnerState().agentSessions;
const subscribers = getRunnerState().subscribers;
export const forkPendingTasks = getRunnerState().forkPendingTasks;
export const runningChecks = getRunnerState().runningChecks;
export const pendingStopRequests = getRunnerState().pendingStopRequests;

const startingTasksMap = (): Map<string, number> => getRunnerState().startingTasks;
const taskOwnershipMap = (): Map<string, TaskOwnershipState> =>
  getRunnerState().taskOwnership;

/** 启动飞行窗 +1（须在第一个 await 前同步调用） */
export const beginTaskStarting = (taskId: string): void => {
  const m = startingTasksMap();
  m.set(taskId, (m.get(taskId) ?? 0) + 1);
};

/** 启动飞行窗 -1；归零删键 */
export const endTaskStarting = (taskId: string): void => {
  const m = startingTasksMap();
  const n = (m.get(taskId) ?? 0) - 1;
  if (n <= 0) m.delete(taskId);
  else m.set(taskId, n);
};

export const isTaskStarting = (taskId: string): boolean =>
  (startingTasksMap().get(taskId) ?? 0) > 0;

/** 测试 / 异常清理：强制清零某 task 的 starting 计数 */
export const clearTaskStarting = (taskId: string): void => {
  startingTasksMap().delete(taskId);
};

/**
 * 准入快照（路由入场同步取；语义 = 旧 getTaskOpGeneration）。
 * 无记录返 0——与 revoke 写入的进程单调 token（≥1）永不相等（W1 防 ABA）。
 */
export const getTaskOpGeneration = (taskId: string): number =>
  taskOwnershipMap().get(taskId)?.gen ?? 0;

/**
 * X3 / R18-3：为 RunningTaskRecord / AgentSessionRecord / TaskOpHandle.opId
 * 分配进程内唯一 instanceId。共用发号器——resume 同 agentId 时靠号区分新旧。
 */
export const allocTaskRunInstanceId = (): number => {
  const s = getRunnerState();
  return s.nextTaskRunInstanceId++;
};

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
  const opId = allocTaskRunInstanceId();
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

/**
 * V12 stop/DELETE/finalize：bump gen + currentOpId 置 null
 * （所有在飞 op / 快照立即失效）。W1：tombstone 保留、永不 clear 键。
 */
export const revokeTaskOps = (taskId: string): void => {
  const s = getRunnerState();
  const cur = s.taskOwnership.get(taskId);
  s.taskOwnership.set(taskId, {
    gen: s.nextTaskOpToken++,
    currentOpId: null,
    claimSeq: cur?.claimSeq ?? 0,
  });
};

// ----------------- publish / subscribe -----------------

/**
 * 全局 tap（飞书桥接 outbound 等旁路用）：publish 时无论有无 per-task SSE 订阅者都会 fanout。
 * 与 per-task subscribers 分 key 挂 globalThis——热重载不丢、也不污染 TaskRunnerGlobalState 形状。
 */
export type AllTaskStreamListener = (
  taskId: string,
  ev: TaskStreamEvent,
) => void;

const ALL_STREAM_LISTENERS_KEY = "__feAiFlowAllTaskStreamListenersV1__";

const getAllStreamListeners = (): Set<AllTaskStreamListener> => {
  const g = globalThis as unknown as Record<
    string,
    Set<AllTaskStreamListener> | undefined
  >;
  if (!g[ALL_STREAM_LISTENERS_KEY]) {
    g[ALL_STREAM_LISTENERS_KEY] = new Set();
  }
  return g[ALL_STREAM_LISTENERS_KEY]!;
};

/** 订阅所有 task 的流事件；返取消函数。dev HMR 下调用方须自做幂等（见 feishu-bridge/outbound）。 */
export const subscribeAllTaskStreams = (
  listener: AllTaskStreamListener,
): (() => void) => {
  const set = getAllStreamListeners();
  set.add(listener);
  return () => {
    set.delete(listener);
  };
};

export const publish = (taskId: string, ev: TaskStreamEvent): void => {
  const set = subscribers.get(taskId);
  if (set && set.size > 0) {
    for (const listener of set) {
      try {
        listener(ev);
      } catch (err) {
        console.error("[task-stream] subscriber listener threw:", err);
      }
    }
  }
  // 全局 tap：无 SSE 订阅时也要喂给旁路（outbound 不能依赖有人开着 watch）
  const all = getAllStreamListeners();
  if (all.size === 0) return;
  for (const listener of all) {
    try {
      listener(taskId, ev);
    } catch (err) {
      console.error("[task-stream] all-stream listener threw:", err);
    }
  }
};

/**
 * R26-5：envelope sink 唯一入口——同步执行 lease，true 才 publish。
 * 线性化：无 await；失主不得清掉新主的 streaming UI / 发迟到 envelope。
 * 本波先导出 + 单测；下一波业务调用点接线。
 */
export const publishIfCurrent = (
  taskId: string,
  lease: () => boolean,
  ev: TaskStreamEvent,
): boolean => {
  if (!lease()) return false;
  publish(taskId, ev);
  return true;
};

export const publishTaskStreamEvent = (
  taskId: string,
  ev: TaskStreamEvent,
): void => publish(taskId, ev);

export const subscribeTaskStream = (
  taskId: string,
  listener: TaskStreamListener,
): (() => void) => {
  let set = subscribers.get(taskId);
  if (!set) {
    set = new Set();
    subscribers.set(taskId, set);
  }
  set.add(listener);
  return () => {
    const cur = subscribers.get(taskId);
    if (!cur) return;
    cur.delete(listener);
    if (cur.size === 0) subscribers.delete(taskId);
  };
};

// 持久化 + publish 一体（防御性吞错、不让 IO 抖动挡 SDK 主流程）
// V0.6.27：appendEvent 改返回 event 本身（轻量路径、不再 hydrate 全量 Task）
/**
 * 持久化 + publish 一体（防御性吞错）。
 *
 * R27-6：owner 语境请改用 {@link writeOwnedEventAndPublish}（lease 必填）。
 * 本函数保留可选 lease 以兼容存量接线；无 lease = 用户操作 / 终态 owner 无条件语义。
 * R27-7：append 返 null（含 ENOENT）时不 publish。
 */
export const writeEventAndPublish = async (
  taskId: string,
  ev: Omit<TaskEvent, "id" | "ts">,
  lease?: () => boolean,
): Promise<TaskEvent | null> => {
  try {
    const event = await appendEvent(taskId, ev, lease);
    // R27-7：null = 未写入（lease 拒 / ENOENT）→ 不向 SSE 发幽灵事件
    if (event) publish(taskId, { kind: "event", event });
    return event;
  } catch (err) {
    console.warn(
      `[task-stream] writeEventAndPublish 失败 task=${taskId} kind=${ev.kind}：`,
      err,
    );
    return null;
  }
};

/**
 * R27-6：owned 事件 sink——lease 必填，缺省即编译失败。
 * 内部走带 lease 的 appendEvent；失主 / ENOENT 不写盘、不 publish。
 */
export const writeOwnedEventAndPublish = async (
  taskId: string,
  lease: () => boolean,
  ev: Omit<TaskEvent, "id" | "ts">,
): Promise<TaskEvent | null> => {
  try {
    const event = await appendEvent(taskId, ev, lease);
    if (event) publish(taskId, { kind: "event", event });
    return event;
  } catch (err) {
    console.warn(
      `[task-stream] writeOwnedEventAndPublish 失败 task=${taskId} kind=${ev.kind}：`,
      err,
    );
    return null;
  }
};

// ----------------- runner 状态小工具 -----------------

// 等某 task 的 run 真正退出（cancel 后 runningTasks entry 由 run 的 finally 清）
export const waitForTaskToStop = async (
  taskId: string,
  timeoutMs = 8000,
): Promise<boolean> => {
  const rec = runningTasks.get(taskId);
  if (!rec) return true;
  const start = Date.now();
  while (runningTasks.has(taskId)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
};

/**
 * V0.5.7 沿用：强制清除 in-memory runner state（dev hot reload / 手改 meta.json 后用）
 * 调用方负责对 task 当前是否真的活做判断、本函数不验证。
 *
 * X3：仍删 forkPendingTasks——强清的调用方（advance 等满 5s）紧接着起 B，
 * 「B 等 A」标记语义已耗尽。旧 A 迟到收尾不再依赖 fork 标记识别后继，
 * 改靠 RunningTaskRecord.instanceId 门控（见 consumeSessionRun）。
 */
export const forceClearStaleRunnerState = (taskId: string): void => {
  runningTasks.delete(taskId);
  forkPendingTasks.delete(taskId);
  pendingStopRequests.delete(taskId);
  // V0.11：连会话一起强清（agent close 尽力而为）
  const session = agentSessions.get(taskId);
  if (session) {
    agentSessions.delete(taskId);
    try {
      session.agent.close();
    } catch {
      /* noop */
    }
  }
};
