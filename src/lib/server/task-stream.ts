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
  // Agent 实例（Awaited<ReturnType<typeof Agent.create>>、这里用结构化最小面收窄）
  agent: {
    agentId: string;
    send: (text: string) => Promise<unknown>;
    close: () => void;
  };
  agentId: string;
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
}

// V4：2026-07-07 V0.11 加 agentSessions（wait 退役、agent 会话跨 run 存活）
// V3：2026-06-22 V0.8.18 加 runningChecks（后置 check 异步化、bump 防 dev hot reload 拿到旧 state 缺字段）
// V2：2026-05-27 V0.6 上线、bump 版本号防 dev hot reload 拿到 V0.5 残留 state
const TASK_RUNNER_GLOBAL_KEY = "__feAiFlowTaskRunnerStateV4__";

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
    };
  }
  return g[TASK_RUNNER_GLOBAL_KEY]!;
};

export const runningTasks = getRunnerState().runningTasks;
export const agentSessions = getRunnerState().agentSessions;
const subscribers = getRunnerState().subscribers;
export const forkPendingTasks = getRunnerState().forkPendingTasks;
export const runningChecks = getRunnerState().runningChecks;

// ----------------- publish / subscribe -----------------

export const publish = (taskId: string, ev: TaskStreamEvent): void => {
  const set = subscribers.get(taskId);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener(ev);
    } catch (err) {
      console.error("[task-stream] subscriber listener threw:", err);
    }
  }
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
export const writeEventAndPublish = async (
  taskId: string,
  ev: Omit<TaskEvent, "id" | "ts">,
): Promise<TaskEvent | null> => {
  try {
    const event = await appendEvent(taskId, ev);
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
 * 调用方负责对 task 当前是否真的活做判断、本函数不验证
 */
export const forceClearStaleRunnerState = (taskId: string): void => {
  runningTasks.delete(taskId);
  forkPendingTasks.delete(taskId);
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
