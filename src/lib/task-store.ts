/**
 * 客户端任务存取（V0.6 重构）
 *
 * 这层只做 fetch + 错误归一、不带状态机逻辑（那归 task-fs.ts / task-runner.ts）。
 *
 * V0.5 → V0.6 主要变化：
 * - `startWorkflow` / `sendChatReply` 合并为 `advanceTask`（按 actionType 切分支）
 * - `submitPhaseAck` → `submitActionAck`（参数 phase → actionId）
 * - `fetchArtifactRevisions` / `fetchArtifactDiff` → `fetchActionRevisions` / `fetchActionDiff`
 * - `watchChatStream` → `watchTaskStream`（路由 watch-chat → watch-task）
 * - `appendEvent` 入参 phase → actionId
 * - 新增 `finalizeTask`（用户标 task 终态）
 */

import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import { bootArgsForTask } from "./agent-provider";
import { getSettings } from "./local-store";
import {
  type ActionRecord,
  type ArtifactRevision,
  type AskUserAnswer,
  type GitBranchState,
  type McpHealth,
  type NewTaskInput,
  type PreviewSlotStatus,
  type Task,
  type TaskEvent,
  type TaskSummary,
} from "./types";

/**
 * 带 HTTP status 的业务拒绝——客户端据此区分「明确 4xx」与网络不确定。
 * 可选 code（如 payload_mismatch）供 Operation 仲裁。
 */
export class ApiRequestError extends Error {
  readonly status: number;
  /** 服务端稳定错误码（如 payload_mismatch） */
  readonly code?: string;
  constructor(
    message: string,
    status: number,
    options?: { code?: string },
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = options?.code;
  }
}

const handleJson = async <T>(res: Response): Promise<T> => {
  const data = await res.json();
  if (!res.ok) {
    const msg =
      typeof data === "object" &&
      data &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    // 服务端稳定错误码（如 ask_in_flight）透传、供调用方做非文案的分支判定
    const code =
      typeof data === "object" &&
      data &&
      "code" in data &&
      typeof (data as { code: unknown }).code === "string"
        ? (data as { code: string }).code
        : undefined;
    throw new ApiRequestError(msg, res.status, { code });
  }
  return data as T;
};

// ----------------- 列表 / 详情 -----------------

export const fetchTasks = async (): Promise<TaskSummary[]> => {
  const res = await fetch("/api/tasks", { cache: "no-store" });
  const data = await handleJson<{ tasks: TaskSummary[] }>(res);
  return data.tasks;
};

export const fetchTask = async (
  id: string,
  opts?: { tail?: number },
): Promise<Task | null> => {
  const qs = opts?.tail && opts.tail > 0 ? `?tail=${opts.tail}` : "";
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}${qs}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  const data = await handleJson<{ task: Task }>(res);
  return data.task;
};

/**
 * v1.0.x 事件懒加载：拉「某条事件之前」的更早历史（上拉分页）
 */
export const fetchEarlierEvents = async (
  id: string,
  before: string,
  limit = 300,
): Promise<{ events: TaskEvent[]; hasMore: boolean }> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(id)}/events?before=${encodeURIComponent(before)}&limit=${limit}`,
    { cache: "no-store" },
  );
  return await handleJson<{ events: TaskEvent[]; hasMore: boolean }>(res);
};

/**
 * v1.0.x：把服务端来的 task 快照合并进本地 state、**本地事件列表只增不换**。
 *
 * 背景：事件懒加载后、task 快照的 events 可能是空（SSE 中途帧）/ 尾部切片（GET ?tail）/
 * 全量（mutation 响应等旧路径）——而本地是「尾部 + 已上拉分页的部分」。规则（蓝军 P0 修）：
 *   - 只吸收「本地末尾之后」的新增事件（SSE 漏发时靠 mutation 响应兜底对齐）
 *   - **更早的回灌一律丢弃**——mutation 响应带全量 events 会把懒加载一次打穿
 *     （发条消息就灌进上万条、打开秒开白做）；更早历史只归上拉分页管
 * 事件日志 append-only（supersede 等都是追加新 info、从不改写旧事件）、丢弃早段无信息损失。
 */
export const mergeTaskEvents = (prev: Task | null, next: Task): Task => {
  if (!prev || prev.id !== next.id || prev.events.length === 0) return next;
  const prevIds = new Set(prev.events.map((e) => e.id));
  const lastTs = prev.events[prev.events.length - 1].ts;
  // >=：同毫秒新事件不漏（id 去重兜住同一条）
  // 顺带挡 ephemeral（防御：误写入 next.events 时不进本地持久 rows）
  const newer = next.events.filter(
    (e) =>
      !e.id.startsWith("ephemeral_") &&
      e.kind !== "tool_output_delta" &&
      !prevIds.has(e.id) &&
      e.ts >= lastTs,
  );
  return {
    ...next,
    events: newer.length > 0 ? [...prev.events, ...newer] : prev.events,
    eventsTruncated: next.eventsTruncated ?? prev.eventsTruncated,
  };
};

// ----------------- 创建 / 删除 / 配置 patch -----------------

export const createTask = async (input: NewTaskInput): Promise<Task> => {
  const res = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await handleJson<{ task: Task }>(res);
  return data.task;
};

/** 删除结果：ok=已删；not_found=服务端已无（二次删除幂等成功，不当错） */
export type DeleteTaskResult = "ok" | "not_found";

export const deleteTask = async (id: string): Promise<DeleteTaskResult> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  // 404 = 已不存在：调用方当幂等成功，勿 toast「任务不存在」
  if (res.status === 404) return "not_found";
  await handleJson<{ ok: true }>(res);
  return "ok";
};

// V0.8 侧栏：置顶 / 取消置顶（PATCH /api/tasks/[id]）
export const setTaskPinned = async (
  id: string,
  pinned: boolean,
): Promise<Task> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  const data = await handleJson<{ task: Task }>(res);
  return data.task;
};

export const setTaskDisabledMcpServers = async (
  id: string,
  disabled: string[] | null,
): Promise<Task> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disabledMcpServers: disabled }),
  });
  const data = await handleJson<{ task: Task }>(res);
  return data.task;
};

export const setTaskUiLayout = async (
  id: string,
  uiLayout: { artifactPanelSize?: number } | null,
): Promise<void> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uiLayout }),
  });
  await handleJson<{ ok: true }>(res);
};

/**
 * V0.6.6：编辑任务的「建任务字段」（详情页编辑弹窗用）
 *
 * 走 PATCH /api/tasks/[id]、字段语义：不传 = 不改、传值 = 改、传 null = 显式清空（仅可空字段）。
 * 可改：title / feishuStoryUrl / repoFeatureBranches；mode / model 不在此改
 *（model 是 SDK Run 启动时绑定的硬约束、改了只能换新 agent、走推进 dialog 的模型选择）。
 * V0.6.28：+ addRepoPaths 追加仓库（只增不删、生效于下一个 action）、新仓的
 * per-repo 快照（分支 / 模板 / check 命令）由调用方从 settings 取好随行传。
 */
export const updateTaskFields = async (
  id: string,
  patch: {
    title?: string;
    feishuStoryUrl?: string | null;
    /** wk 需求编号：传值 = 改、传 null / 空串 = 清空回退派生值 */
    reqId?: string | null;
    repoFeatureBranches?: Record<string, string> | null;
    addRepoPaths?: string[];
    addRepoBaseBranches?: Record<string, string>;
    addRepoTestBranches?: Record<string, string>;
    addRepoDevBranches?: Record<string, string>;
    addRepoBranchTemplates?: Record<string, string>;
  },
): Promise<Task> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await handleJson<{ task: Task }>(res);
  return data.task;
};

/**
 * V0.6.24：chat 模式「切模型」——持久化 task.model（PATCH /api/tasks/[id]）
 *
 * 只改落盘字段、下一个 run 启动时生效、不影响正在跑的 run（SDK 把模型锁死在 run 上）。
 * 调用方在 runStatus=running 时应禁用入口、避免误导用户以为当前轮会换。
 */
export const setTaskModel = async (
  id: string,
  model: ModelSelection,
): Promise<Task> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  const data = await handleJson<{ task: Task }>(res);
  return data.task;
};

/** 本窗口切提供方（可同时改写默认模型） */
export const setTaskProvider = async (
  id: string,
  provider: string,
  model?: ModelSelection,
): Promise<Task> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, ...(model ? { model } : {}) }),
  });
  const data = await handleJson<{ task: Task }>(res);
  return data.task;
};

/**
 * V0.8：chat 模式「选工作目录」——替换 task.repoPaths（PATCH /api/tasks/[id]）
 *
 * 自由对话用原生 picker 选文件夹当 agent cwd、重选即替换、空数组 = 不绑（agent 起在 Flowship 项目本身）。
 * 跟切模型同款：下一个 run 启动生效、不影响正在跑的 run、调用方 running 时禁用入口。
 */
export const setTaskRepoPaths = async (
  id: string,
  repoPaths: string[],
): Promise<Task> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPaths }),
  });
  const data = await handleJson<{ task: Task }>(res);
  return data.task;
};

/**
 * V0.8：读某仓工作目录的本地 git 分支状态（GET /api/tasks/[id]/branches）
 * 带 repoPath = task 模式按仓；缺省 = chat 单仓。非 git 仓返回 isRepo=false。
 */
export const fetchTaskBranches = async (
  id: string,
  repoPath?: string,
): Promise<GitBranchState> => {
  const q = repoPath
    ? `?repoPath=${encodeURIComponent(repoPath)}`
    : "";
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(id)}/branches${q}`,
  );
  const data = await handleJson<{ state: GitBranchState }>(res);
  return data.state;
};

/**
 * V0.8：切某仓工作目录的 git 分支（POST /api/tasks/[id]/branches、body {branch, repoPath?}）
 * 带 repoPath = task 模式按仓切；缺省 = chat 单仓。成功返回切换后的最新分支状态。
 */
export const checkoutTaskBranch = async (
  id: string,
  branch: string,
  repoPath?: string,
): Promise<GitBranchState> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/branches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, ...(repoPath ? { repoPath } : {}) }),
  });
  const data = await handleJson<{ ok: true; state: GitBranchState }>(res);
  return data.state;
};

// ----------------- MCP 配置读取（V0.13 独立化：servers = fe 自管有效集） -----------------

export interface CursorMcpInfo {
  /** 运行时有效 MCP（= fe 自管配置、黑名单候选 / 健康探测用） */
  servers: Record<string, McpServerConfig>;
  /** Cursor ~/.cursor/mcp.json（仅「从 Cursor 导入」dialog 展示挑选用） */
  cursor: Record<string, McpServerConfig>;
  dirs: string[];
}

export const fetchCursorMcp = async (): Promise<CursorMcpInfo> => {
  const res = await fetch("/api/cursor-mcp", { cache: "no-store" });
  const data = await handleJson<{
    ok: true;
    servers: Record<string, McpServerConfig>;
    cursor: Record<string, McpServerConfig>;
    dirs: string[];
  }>(res);
  return {
    servers: data.servers,
    cursor: data.cursor,
    dirs: data.dirs,
  };
};

/**
 * 探测 MCP server 连通性（设置页 / 任务面板状态展示用、V0.6.11；V0.6.13 加 servers 子集）
 * @param servers 只探这几个（前端传「已开启」的 / 单个）；不传探全部
 */
export const fetchMcpHealth = async (
  servers?: string[],
): Promise<Record<string, McpHealth>> => {
  const query =
    servers && servers.length > 0
      ? `?servers=${encodeURIComponent(servers.join(","))}`
      : "";
  const res = await fetch(`/api/cursor-mcp/health${query}`, {
    cache: "no-store",
  });
  const data = await handleJson<{
    ok: true;
    health: Record<string, McpHealth>;
  }>(res);
  return data.health;
};

// ----------------- MCP OAuth（V0.6.4 走 OAuth 授权的远程 MCP） -----------------

/** 单个 MCP server 的 OAuth 授权状态（跟 server 端 mcp-oauth.ts 对齐） */
export interface McpOAuthStatus {
  // 探测出该 server 要求 OAuth（本地 / url 自带 token / 公开 MCP 为 false）
  needsOAuth: boolean;
  authorized: boolean;
  // access token 过期绝对时间（ms）；有 refresh 时过期也会自动续
  expiresAt?: number;
  // 有 refresh_token（过期能自动续、无需用户再授权）
  hasRefresh: boolean;
}

/**
 * 发起某 server 的 OAuth 授权（POST /api/mcp-oauth/start）
 * 返回授权 URL（前端开浏览器让用户登录授权）、或 alreadyAuthorized
 */
export const startMcpOAuth = async (
  serverName: string,
): Promise<{ authorizationUrl?: string; alreadyAuthorized?: boolean }> => {
  const res = await fetch("/api/mcp-oauth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverName }),
  });
  return handleJson<{
    ok: true;
    authorizationUrl?: string;
    alreadyAuthorized?: boolean;
  }>(res);
};

/** 拉所有 server 的 OAuth 授权状态（GET /api/mcp-oauth/status） */
export const fetchMcpOAuthStatuses = async (): Promise<
  Record<string, McpOAuthStatus>
> => {
  const res = await fetch("/api/mcp-oauth/status", { cache: "no-store" });
  const data = await handleJson<{
    ok: true;
    statuses: Record<string, McpOAuthStatus>;
  }>(res);
  return data.statuses;
};

/** 撤销某 server 的 OAuth 授权（POST /api/mcp-oauth/revoke） */
export const revokeMcpOAuth = async (serverName: string): Promise<void> => {
  const res = await fetch("/api/mcp-oauth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverName }),
  });
  await handleJson<{ ok: true }>(res);
};

// ----------------- SSE 工具（V0.6 统一任务事件流） -----------------

interface SSEEnvelope {
  type:
    | "event"
    | "artifact"
    | "task"
    | "action"
    | "done"
    | "error"
    | "assistant_delta"
    /** 队列整队失败控制帧 */
    | "queue_failed"
    /** bootstrap 队列存活快照 */
    | "queue_state"
    /** MessageOperation phase / terminal 帧 */
    | "message_op"
    /** 旁路（受限群答疑）run 在飞与否——不写 runStatus，运行态只能靠这一帧 */
    | "restricted_run"
    /** 任务已逻辑删除，客户端应停订阅、勿重连 */
    | "task_deleted";
  event?: TaskEvent;
  content?: string;
  task?: Task;
  action?: ActionRecord;
  ok?: boolean;
  message?: string;
  text?: string;
  itemIds?: string[];
  reason?: string;
  /** bootstrap queue_state 有界终态 ledger */
  recentSettled?: Array<{ itemId: string; outcome: string }>;
  /** 完整 operation snapshot（含 accepting/persisted） */
  operationSnapshot?: Array<{
    itemId: string;
    phase: string;
    fingerprint?: string;
  }>;
  /** message_op 帧字段 */
  itemId?: string;
  phase?: string;
  outcome?: string;
  taskId?: string;
  /** restricted_run 帧：旁路答疑此刻在不在飞 */
  active?: boolean;
}

const parseSseEvent = (frame: string): SSEEnvelope | null => {
  const dataLines = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  try {
    return JSON.parse(raw) as SSEEnvelope;
  } catch {
    return null;
  }
};

/**
 * 订阅 task 事件流（GET SSE）
 *
 * 协议（V0.6）：
 *   - 进来先收一帧 task + 全部历史 events（bootstrap）
 *   - 然后实时推增量事件 / task 变化 / action 状态变化
 *   - 任务终止 → 收一帧 done、流自动关闭
 *
 * 任意时刻可调（task idle 也行、就只 push 当前 task 然后挂着）。
 * 多个 tab 同时 watch 都行、互不干扰。
 */
export interface TaskStreamCallbacks {
  onEvent?: (ev: TaskEvent) => void;
  onTaskUpdate?: (task: Task) => void;
  onActionUpdate?: (action: ActionRecord) => void;
  onDone?: (task: Task, ok: boolean) => void;
  onError?: (message: string) => void;
  /**
   * 流式 chunk 推送、UI 拼接展示打字效果
   * 服务端在每个 SDK assistant chunk 到达时 publish 一次、内容是「新增」chunk
   * 上层维护「当前 streaming text」、收到本回调时累加、收到 onEvent(assistant_message) 时清空
   */
  onAssistantDelta?: (text: string) => void;
  /**
   * 队列整队失败控制帧（strict 落盘 EIO 等）——按 itemIds 清 pending
   */
  onQueueFailed?: (itemIds: string[], reason: string) => void;
  /**
   * watch bootstrap queue_state + operationSnapshot
   */
  onQueueState?: (
    itemIds: string[],
    recentSettled?: Array<{ itemId: string; outcome: string }>,
    operationSnapshot?: Array<{
      itemId: string;
      phase: string;
      fingerprint?: string;
    }>,
  ) => void;
  /**
   * message_op——显式 phase / outcome（handedOff=delivered）
   */
  onMessageOp?: (payload: {
    itemId: string;
    phase?: string;
    outcome?: string;
  }) => void;
  /**
   * restricted_run——旁路（受限群答疑）run 在飞与否。
   * 它刻意不写 task.runStatus（与运行状态机解耦），但事件流里照样有它的工具调用；
   * UI 拿它跟 runStatus 一起算「运行中」，否则那些工具块会被判成脏数据渲染「已中断」。
   */
  onRestrictedRun?: (active: boolean) => void;
  /**
   * task_deleted——任务已删，hook 停重连；可选通知 UI 清详情
   */
  onTaskDeleted?: (taskId: string) => void;
  /**
   * 连接已建立——首个合法 bootstrap `task` 帧解析成功时回调一次。
   * hook 用它在长连接尚未结束时清零 transient/unavailable 计数（不等流 EOF）。
   * 200 空流 / 协议解析前失败不得触发；每次连接至多一次。
   */
  onConnectionEstablished?: () => void;
}

/** watch 流结束时是否曾建立（首个合法 task 帧） */
export type WatchTaskStreamResult = {
  established: boolean;
};

/**
 * 订阅任务 SSE（v1.0.x 起 bootstrap 只带尾部 tail 条事件、不是全部历史——
 * 更早的走 fetchEarlierEvents 上拉分页；中途 task/done 帧不带 events）
 *
 * 返回 `{ established }`——bootstrap 前 clean EOF 时 established=false，
 * hook 不得把它当成功清零 epoch。
 */
export const watchTaskStream = async (
  taskId: string,
  callbacks: TaskStreamCallbacks = {},
  signal?: AbortSignal,
): Promise<WatchTaskStreamResult> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/watch-task`,
    {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal,
    },
  );

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg =
      typeof data === "object" && data && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    // 带 status；hook 对 410 与已 hydrate 的 404 走 deletion sink，
    // 503（证据 unknown）当 unavailable 持续重试、不 commit
    throw new ApiRequestError(msg, res.status);
  }
  if (!res.body) {
    throw new Error("响应体缺失（不支持流式？）");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // 首个合法 task 帧才算建连成功；每连接至多通知一次
  let connectionEstablished = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIdx = buffer.indexOf("\n\n");
      while (sepIdx !== -1) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const env = parseSseEvent(frame);
        if (env) {
          if (env.type === "event" && env.event) {
            callbacks.onEvent?.(env.event);
          } else if (env.type === "task" && env.task) {
            // 合法 bootstrap task 帧：先发 connection-established，再转发 task
            if (!connectionEstablished) {
              connectionEstablished = true;
              callbacks.onConnectionEstablished?.();
            }
            callbacks.onTaskUpdate?.(env.task);
          } else if (env.type === "action" && env.action) {
            callbacks.onActionUpdate?.(env.action);
          } else if (env.type === "done" && env.task) {
            callbacks.onDone?.(env.task, !!env.ok);
          } else if (env.type === "error") {
            callbacks.onError?.(env.message ?? "未知错误");
          } else if (
            env.type === "assistant_delta" &&
            typeof env.text === "string"
          ) {
            callbacks.onAssistantDelta?.(env.text);
          } else if (
            env.type === "queue_failed" &&
            Array.isArray(env.itemIds)
          ) {
            // 控制帧——只转发 string[] itemIds
            const ids = env.itemIds.filter(
              (id): id is string => typeof id === "string",
            );
            callbacks.onQueueFailed?.(
              ids,
              typeof env.reason === "string" ? env.reason : "persist_failed",
            );
          } else if (
            env.type === "queue_state" &&
            Array.isArray(env.itemIds)
          ) {
            // 队列快照 + recentSettled + operationSnapshot
            const ids = env.itemIds.filter(
              (id): id is string => typeof id === "string",
            );
            const recentSettled = Array.isArray(env.recentSettled)
              ? env.recentSettled.filter(
                  (e): e is { itemId: string; outcome: string } =>
                    !!e &&
                    typeof e.itemId === "string" &&
                    typeof e.outcome === "string",
                )
              : undefined;
            const operationSnapshot = Array.isArray(env.operationSnapshot)
              ? env.operationSnapshot.filter(
                  (
                    e,
                  ): e is {
                    itemId: string;
                    phase: string;
                    fingerprint?: string;
                  } =>
                    !!e &&
                    typeof e.itemId === "string" &&
                    typeof e.phase === "string",
                )
              : undefined;
            callbacks.onQueueState?.(ids, recentSettled, operationSnapshot);
          } else if (
            env.type === "message_op" &&
            typeof env.itemId === "string"
          ) {
            // 显式 operation phase / terminal
            callbacks.onMessageOp?.({
              itemId: env.itemId,
              phase: typeof env.phase === "string" ? env.phase : undefined,
              outcome:
                typeof env.outcome === "string" ? env.outcome : undefined,
            });
          } else if (
            env.type === "restricted_run" &&
            typeof env.active === "boolean"
          ) {
            // 旁路答疑在飞与否（运行态信号、不进 task.runStatus）
            callbacks.onRestrictedRun?.(env.active);
          } else if (
            env.type === "task_deleted" &&
            typeof env.taskId === "string"
          ) {
            // 逻辑删除已提交——转发后流会由服务端关闭
            callbacks.onTaskDeleted?.(env.taskId);
          }
        }
        sepIdx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
  return { established: connectionEstablished };
};

// ----------------- 图片附件入参 -----------------

export interface ImagePayload {
  data: string; // 纯 base64
  mimeType: string;
  filename?: string;
}

// ----------------- V0.6 推进 / ack / 终态 -----------------

/**
 * V0.6 task 启动 / 续接 时所需的「最小启动参数」
 *
 * - task.runStatus 是 idle/error 时、advance 路由用这套参数启 / 重启 SDK Agent
 * - task.runStatus 是 awaiting_user 时（已有活 agent）、agent 内部直接吃 [NEXT_ACTION ...]、不重启
 *
 * UI 调用方一律传 bootArgs、后端按需取用。
 */
export interface TaskBootArgs {
  apiKey: string;
  model: ModelSelection;
}

/**
 * V0.6.0.1 chat 模式：用户在 ChatView 输入框发一条消息
 *
 * 后端语义（详见 /chat-reply route 顶部注释、V0.11）：
 *   - 有存活会话 → `agent.send` 续接（正常对话循环）
 *   - 无会话（首条 / 已停 / 服务重启过）→ bootArgs 起新会话 + 首条进起手 prompt
 *
 * 调用方简化：无脑传 bootArgs、后端按需取用。
 *
 * images / bootArgs 类型直接复用 ImagePayload / TaskBootArgs、避免重复定义。
 */
export const sendChatReply = async (
  taskId: string,
  text: string,
  images?: ImagePayload[],
  attachments?: string[],
  bootArgs?: TaskBootArgs,
  // skill 引用：服务端拼进 agent 消息、不进 user_reply 事件气泡
  skills?: Array<{ name: string; absPath: string }>,
  /**
   * 客户端预生成的 queue itemId（POST 前登记 pending 用）。
   * 服务端原样采用；缺省时服务端兜底发号。
   */
  clientItemId?: string,
  /**
   * payload 指纹（与 server claim 对齐）。
   * 契约假设：同 id + 不同 fingerprint → 409 `{ error: "payload_mismatch" }`。
   */
  payloadFingerprint?: string,
): Promise<
  | {
      task: Task;
      autoStarted: boolean;
      queued?: false;
      /** send 后落盘失败时服务端带回，UI 须 toast 不可忽略 */
      persistWarning?: string;
    }
  | {
      queued: true;
      queuedCount: number;
      /** 与服务端 queue item 对账的稳定 id */
      itemId: string;
      /** 同 id 幂等命中 active */
      alreadyAccepted?: boolean;
      task?: Task;
      persistWarning?: string;
    }
  | {
      /** 同 id 已在 recentSettled → 终态幂等 */
      settled: true;
      itemId: string;
      /**
       * 缺失时保持 undefined（unknown），绝不合成 delivered。
       * 调用方按 ledger / decoder 仲裁清草稿。
       */
      outcome?: string;
      task?: Task;
      /** 与其它分支对齐，settled 路径不会带此字段 */
      persistWarning?: undefined;
    }
> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/chat-reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        images: images && images.length > 0 ? images : undefined,
        attachments:
          attachments && attachments.length > 0 ? attachments : undefined,
        bootArgs,
        skills: skills && skills.length > 0 ? skills : undefined,
        // 客户端预生成 id，服务端优先采用
        clientItemId: clientItemId || undefined,
        // 供 server claimOperation 比对
        payloadFingerprint: payloadFingerprint || undefined,
      }),
    },
  );
  // P5：agent 忙时 202 入队（不再 409）
  if (res.status === 202) {
    const data = (await res.json()) as {
      ok?: boolean;
      queued?: boolean;
      queuedCount?: number;
      itemId?: string;
      alreadyAccepted?: boolean;
      task?: Task;
      persistWarning?: string;
    };
    return {
      queued: true,
      queuedCount:
        typeof data.queuedCount === "number" ? data.queuedCount : 1,
      // 缺 itemId 时本地兜底（旧服务端兼容；正常路径服务端必返）
      itemId:
        typeof data.itemId === "string" && data.itemId
          ? data.itemId
          : `pending_local_${Date.now()}`,
      ...(data.alreadyAccepted ? { alreadyAccepted: true } : {}),
      task: data.task,
      ...(typeof data.persistWarning === "string"
        ? { persistWarning: data.persistWarning }
        : {}),
    };
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const errCode =
      typeof data === "object" &&
      data &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : undefined;
    // server 实际契约 = 结构化字段 `{ payloadMismatch: true }`（error 是给人读的长文案、
    // 不做字符串匹配）；命中即抛稳定 code 供 Operation 仲裁转新 id 重发
    const isPayloadMismatch =
      res.status === 409 &&
      typeof data === "object" &&
      data !== null &&
      (data as { payloadMismatch?: unknown }).payloadMismatch === true;
    if (isPayloadMismatch) {
      throw new ApiRequestError("payload_mismatch", 409, {
        code: "payload_mismatch",
      });
    }
    const msg = errCode ?? `HTTP ${res.status}`;
    throw new ApiRequestError(msg, res.status, errCode ? { code: errCode } : undefined);
  }
  const data = (await res.json()) as {
    ok?: true;
    settled?: boolean;
    itemId?: string;
    outcome?: string;
    task?: Task;
    autoStarted?: boolean;
    persistWarning?: string;
  };
  // 幂等终态（同 id 已 settled）
  // 缺失 / 非字符串 outcome 不得合成 delivered——保持 undefined → unknown
  if (data.settled === true && typeof data.itemId === "string") {
    return {
      settled: true,
      itemId: data.itemId,
      ...(typeof data.outcome === "string" ? { outcome: data.outcome } : {}),
      task: data.task,
    };
  }
  if (!data.task) {
    throw new ApiRequestError("响应缺少 task", res.status || 500);
  }
  return {
    task: data.task,
    autoStarted: !!data.autoStarted,
    ...(typeof data.persistWarning === "string"
      ? { persistWarning: data.persistWarning }
      : {}),
  };
};

/** P3：回退到带 checkpoint 的 user_reply */
export const rewindChatToEvent = async (
  taskId: string,
  eventId: string,
): Promise<{ task: Task | null; refreshRequired?: boolean }> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/rewind`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId }),
    },
  );
  const data = await handleJson<{
    ok: true;
    task: Task | null;
    restoredRepos?: number;
    truncatedEventCount?: number;
    refreshRequired?: boolean;
  }>(res);
  return {
    task: data.task,
    ...(data.refreshRequired ? { refreshRequired: true } : {}),
  };
};

// ----------------- chat 排队可视化（D 批次） -----------------

/** 排队中消息（GET /chat-queue 条目、与 server ChatQueueItemSnapshot 同形） */
export interface ChatQueueItem {
  itemId: string;
  displayText: string;
  enqueuedAt: number;
}

export const fetchChatQueue = async (
  taskId: string,
): Promise<ChatQueueItem[]> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/chat-queue`,
    { cache: "no-store" },
  );
  const data = await handleJson<{ items: ChatQueueItem[] }>(res);
  return data.items;
};

/** 删除排队中的消息；返回实际被移除的 itemIds（已发出的删不到） */
export const removeChatQueueItems = async (
  taskId: string,
  itemIds: string[],
): Promise<string[]> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/chat-queue`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemIds }),
    },
  );
  const data = await handleJson<{ ok: true; removedIds: string[] }>(res);
  return data.removedIds;
};

/**
 * 排队消息「立即发送」：server 原子编排（take → stop 清剩余队 → 用该条起新会话）。
 * 旧路径 promote + stop 会把刚置顶的条一并 failQueuedItems 清掉，永远发不出去。
 * bootArgs 必传（stop 后无会话、要自动启动）。
 */
export const sendQueuedChatMessageNow = async (
  taskId: string,
  itemId: string,
  bootArgs: { apiKey: string; model: ModelSelection },
): Promise<{ task: Task }> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/chat-queue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "send_now",
        itemId,
        bootArgs,
      }),
    },
  );
  const data = await handleJson<{ ok: true; task: Task }>(res);
  return { task: data.task };
};

// V0.13.x：submitActionAck 已退役——「再聊聊」并入 submitTaskQuestion 统一消息通道
//（服务端按 awaiting_ack 自动附「重新交卷」上下文）；approve 由推进时自动认可承担。

/**
 * V0.11.9 任务内「跟 AI 说」：消息送给存活会话（疑问就答 / 要改就改、不新建 action、进度不动）。
 * bootArgs 无脑带上（服务重启 / 空闲回收后靠它 Agent.resume 接回会话）。
 */
export const submitTaskQuestion = async (
  task: Task,
  text: string,
  images?: ImagePayload[],
  // 显式指定模型（V0.11.9）：传了 = 不续会话（会话模型换不了）、按后端分流换模型处理
  forceModel?: ModelSelection,
  // 文件 / 目录绝对路径附件（v1.1.x 任务输入条也能附路径）
  attachments?: string[],
  // skill 引用：服务端拼进 agent 消息、不进 user_reply 事件气泡
  skills?: Array<{ name: string; absPath: string }>,
): Promise<{ task: Task; persistWarning?: string }> => {
  const s = getSettings();
  const boot = bootArgsForTask(task, s);
  const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/question`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      images: images && images.length > 0 ? images : undefined,
      attachments:
        attachments && attachments.length > 0 ? attachments : undefined,
      skills: skills && skills.length > 0 ? skills : undefined,
      bootArgs: {
        apiKey: boot.apiKey,
        model: boot.model,
        gitToken: s.gitToken,
      },
      forceModel: forceModel?.id?.trim() ? forceModel : undefined,
    }),
  });
  // 透传 persistWarning，调用方 toast（不可静默丢）
  const data = await handleJson<{
    ok: true;
    task: Task;
    persistWarning?: string;
  }>(res);
  return {
    task: data.task,
    ...(typeof data.persistWarning === "string"
      ? { persistWarning: data.persistWarning }
      : {}),
  };
};

/**
 * V0.6 任务终态控制（用户在 ack dialog 选「合入」/「abandon」）
 *
 * - merged: 标 repoStatus=merged + write [TASK_DONE] + Agent 退出
 * - abandoned: write [TASK_ABANDONED] + Agent 自然退出 + cleanup
 */
export const finalizeTask = async (
  taskId: string,
  finalStatus: "merged" | "abandoned",
): Promise<Task> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/finalize`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ finalStatus }),
    },
  );
  const data = await handleJson<{ ok: true; task: Task }>(res);
  return data.task;
};

/**
 * V0.6.12 恢复终态 task（merged / abandoned → developing）、重新可推进
 * 给「误 abandon」/「想把终结的 task 重新捡起来继续」留出路
 */
export const reopenTask = async (taskId: string): Promise<Task> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/reopen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = await handleJson<{ ok: true; task: Task }>(res);
  return data.task;
};

// ----------------- V0.6.x 停止 / 划除（软删） -----------------

/**
 * 「停止」当前正在跑 / 等 ack 的 action
 * - abort SDK Run + 当前 action 标 cancelled + runStatus 回 idle
 * - 幂等：没有活 agent 也照常归位（返回的 task.runStatus = idle）
 */
export const stopTask = async (taskId: string): Promise<Task> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/stop`, {
    method: "POST",
  });
  const data = await handleJson<{ ok: true; hadAgent: boolean; task: Task }>(
    res,
  );
  return data.task;
};

/**
 * 「划除 / 恢复」单条 action（软删、可逆）
 * - excluded=true：排出 agent 上下文（renderActionHistorySection 跳过、不进 prompt）
 * - excluded=false：恢复
 * - 进行中的 action 不能直接划除（后端返 409）、需先 stopTask
 */
export const setActionExcluded = async (
  taskId: string,
  actionId: string,
  excluded: boolean,
): Promise<Task> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/action-exclude`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId, excluded }),
    },
  );
  const data = await handleJson<{ ok: true; task: Task }>(res);
  return data.task;
};

// ----------------- Context Docs（V0.3、V0.6.0.1 加 images）-----------------

/**
 * 加上下文文档
 *
 * 参数语义（后端校验同步、详见 /context-docs route）：
 *   - title + content：主条目（type 由后端按内容推断）
 *   - images：贴图（每张图作为独立 type=image doc 落盘）
 *   - 至少一个非空、title 和 content 必须一起填或一起省略
 */
export const addContextDoc = async (
  taskId: string,
  input: {
    title?: string;
    content?: string;
    images?: ImagePayload[];
  },
): Promise<Task> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/context-docs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        content: input.content,
        images:
          input.images && input.images.length > 0 ? input.images : undefined,
      }),
    },
  );
  const data = await handleJson<{ ok: true; task: Task }>(res);
  return data.task;
};

export const removeContextDoc = async (
  taskId: string,
  docId: string,
): Promise<Task> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/context-docs/${encodeURIComponent(docId)}`,
    { method: "DELETE" },
  );
  const data = await handleJson<{ ok: true; task: Task }>(res);
  return data.task;
};

// ----------------- ask_user 回复（V0.3.2 + V0.5.6 deferred、V0.6 不变） -----------------

export const submitAskReply = async (
  task: Task,
  askId: string,
  answers: AskUserAnswer[],
  // V0.8.3：imagesByQuestion key=questionId、每题各自绑各自的图（图-only 也算已答）
  // signal：答题卡 30s 超时解锁时 abort，避免旧请求迟到与重试撞重复回答
  options?: {
    deferred?: boolean;
    imagesByQuestion?: Record<string, ImagePayload[]>;
    // v1.1.x：答题框 `/` 引用到的 skill（各题合并去重后传一份、指引只进 agent 消息）
    skills?: Array<{ name: string; absPath: string }>;
    signal?: AbortSignal;
  },
): Promise<{ ok: true; persistWarning?: string }> => {
  // 只发非空的题图、避免 body 里塞一堆空数组
  const imagesByQuestion = options?.imagesByQuestion
    ? Object.fromEntries(
        Object.entries(options.imagesByQuestion).filter(
          ([, imgs]) => imgs.length > 0,
        ),
      )
    : undefined;
  // V0.11.1：随手带会话恢复凭据——服务重启 / 空闲回收后答案靠它 Agent.resume 接回会话送达
  const s = getSettings();
  const boot = bootArgsForTask(task, s);
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(task.id)}/ask-reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: options?.signal,
      body: JSON.stringify({
        askId,
        answers,
        ...(options?.deferred ? { deferred: true } : {}),
        ...(imagesByQuestion && Object.keys(imagesByQuestion).length > 0
          ? { imagesByQuestion }
          : {}),
        ...(options?.skills && options.skills.length > 0
          ? { skills: options.skills }
          : {}),
        bootArgs: {
          apiKey: boot.apiKey,
          model: boot.model,
          gitToken: s.gitToken,
        },
      }),
    },
  );
  // 透传 persistWarning
  const data = await handleJson<{ ok: true; persistWarning?: string }>(res);
  return {
    ok: true as const,
    ...(typeof data.persistWarning === "string"
      ? { persistWarning: data.persistWarning }
      : {}),
  };
};

// ----------------- Action Revisions（V0.5.12 → V0.6 action 维度） -----------------

/**
 * V0.6：拉某 action 的修订历史 + 当前正文
 */
export const fetchActionRevisions = async (
  taskId: string,
  actionId: string,
): Promise<{
  revisions: ArtifactRevision[];
  current: { content: string; filename: string } | null;
}> =>
  await handleJson<{
    revisions: ArtifactRevision[];
    current: { content: string; filename: string } | null;
  }>(
    await fetch(
      `/api/tasks/${encodeURIComponent(taskId)}/action-revisions?actionId=${encodeURIComponent(actionId)}`,
      { cache: "no-store" },
    ),
  );

/**
 * V0.6：拉两个时刻的 action artifact 正文做对比
 *
 * @param from  必填、revision timestamp
 * @param to    可选、revision timestamp 或 "current"、默认 "current"
 */
export const fetchActionDiff = async (
  taskId: string,
  actionId: string,
  from: number,
  to: number | "current" = "current",
): Promise<{
  from: { content: string; timestamp: number };
  to: { content: string; timestamp: number | null };
}> => {
  const params = new URLSearchParams({
    actionId,
    from: String(from),
    to: to === "current" ? "current" : String(to),
  });
  return await handleJson<{
    from: { content: string; timestamp: number };
    to: { content: string; timestamp: number | null };
  }>(
    await fetch(
      `/api/tasks/${encodeURIComponent(taskId)}/action-diff?${params.toString()}`,
      { cache: "no-store" },
    ),
  );
};

// ----------------- 按仓多预览位 -----------------

export const fetchPreviewStatus = async (): Promise<PreviewSlotStatus[]> => {
  const data = await handleJson<{ slots: PreviewSlotStatus[] }>(
    await fetch("/api/preview", { cache: "no-store" }),
  );
  return data.slots;
};

/**
 * 起预览（按仓单位：只顶掉同仓旧位）。返回被顶掉的同仓别的任务标题（没有则 null）。
 * CR-01：不再传 command——命令由 server 按 repoPath 从权威 config.json 查（防注入）。
 */
export const startTaskPreview = async (
  taskId: string,
  repoPath: string,
): Promise<{ slot: PreviewSlotStatus; replacedTaskTitle: string | null }> =>
  await handleJson<{ slot: PreviewSlotStatus; replacedTaskTitle: string | null }>(
    await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, repoPath }),
    }),
  );

/** 停预览：带 repoPath = 停该仓、不带 = 全停 */
export const stopTaskPreview = async (repoPath?: string): Promise<void> => {
  await handleJson<{ ok: true }>(
    await fetch("/api/preview", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(repoPath ? { repoPath } : {}),
    }),
  );
};

// ----------------- 分享到需求群 -----------------

/** 分享内容类型（与 POST /share-to-group body.kind 对齐） */
export type ShareToGroupKind = "artifact" | "message" | "question";

export type ShareToGroupLink = { label: string; url: string };

export type ShareToGroupInput = {
  kind: ShareToGroupKind;
  title?: string;
  content: string;
  links?: ShareToGroupLink[];
  /**
   * 用户在「你已不在原需求群」引导里确认重建时回传的那条失效 chatId：
   * 服务端跳过复用、重建群并覆盖工作项绑定。只有用户确认过才带。
   */
  recreateFrom?: string;
};

/** 成功 / 业务失败（含两类引导）统一结果；网络层失败仍抛 ApiRequestError */
export type ShareToGroupResult =
  | {
      ok: true;
      chatId: string;
      /** 群名（服务端读到才有）——toast 说清发到哪个群了 */
      chatName?: string;
      messageId: string;
      created: boolean;
      /** 「本人还在不在群」没查出来（scope / 网络）——已照常发出 */
      membershipUnknown?: boolean;
    }
  | {
      ok: false;
      error: string;
      needManualBotAdd?: boolean;
      /** needManualBotAdd 时的机器人准确名称（引导弹窗让用户搜这个名字加） */
      botLabel?: string;
      /** 死绑定（本人已退群 / 群没了）——调用方引导用户重建需求群 */
      needGroupRebuild?: boolean;
      /** needGroupRebuild 时那条失效的 chatId（确认重建后原样回传） */
      chatId?: string;
      /** needGroupRebuild 时的群名（读到才有）——弹窗里点名是哪个群 */
      chatName?: string;
    };

/** 死绑定两码：本人已不在群 / 群已不可达，补救动作都是「重建需求群」 */
const GROUP_REBUILD_CODES = new Set(["owner_not_in_group", "group_unreachable"]);

/**
 * 分享到飞书需求群。
 * 业务失败（ok:false，含需手动加机器人 / 需重建群）不抛、由调用方按
 * needManualBotAdd / needGroupRebuild 分流 UI；HTTP / 解析失败仍抛 ApiRequestError。
 */
export const shareToGroup = async (
  taskId: string,
  body: ShareToGroupInput,
): Promise<ShareToGroupResult> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/share-to-group`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiRequestError(`HTTP ${res.status}`, res.status);
  }
  // 业务失败：server 返 { error, code?, ... }（4xx 结构化错误，无 ok 字段）。
  // 两类有引导可走：bot_not_in_group → 弹「手动加机器人」；
  // owner_not_in_group / group_unreachable → 弹「重新建群」
  if (
    typeof data === "object" &&
    data !== null &&
    !res.ok &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
  ) {
    const err = data as {
      error: string;
      code?: unknown;
      botLabel?: unknown;
      chatId?: unknown;
      chatName?: unknown;
    };
    return {
      ok: false,
      error: err.error.trim() || `分享失败（HTTP ${res.status}）`,
      needManualBotAdd: err.code === "bot_not_in_group",
      botLabel: typeof err.botLabel === "string" ? err.botLabel : undefined,
      needGroupRebuild: GROUP_REBUILD_CODES.has(String(err.code ?? "")),
      chatId: typeof err.chatId === "string" ? err.chatId : undefined,
      chatName: typeof err.chatName === "string" ? err.chatName : undefined,
    };
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new ApiRequestError(msg, res.status);
  }
  const ok = data as {
    ok?: unknown;
    chatId?: unknown;
    chatName?: unknown;
    messageId?: unknown;
    created?: unknown;
    membershipUnknown?: unknown;
  };
  if (ok.ok !== true) {
    throw new ApiRequestError("分享响应异常", res.status || 500);
  }
  return {
    ok: true,
    chatId: typeof ok.chatId === "string" ? ok.chatId : "",
    chatName: typeof ok.chatName === "string" ? ok.chatName : undefined,
    messageId: typeof ok.messageId === "string" ? ok.messageId : "",
    created: ok.created === true,
    membershipUnknown: ok.membershipUnknown === true,
  };
};

/** 只建/取需求群（不发卡片）；死绑定同 share 走 needGroupRebuild */
export type EnsureRequirementGroupResult =
  | {
      ok: true;
      chatId: string;
      chatName?: string;
      created: boolean;
      membershipUnknown?: boolean;
    }
  | {
      ok: false;
      error: string;
      needGroupRebuild?: boolean;
      chatId?: string;
      chatName?: string;
    };

/**
 * 确保需求群存在（可建可复用）。业务失败不抛；HTTP / 解析失败抛 ApiRequestError。
 */
export const ensureRequirementGroup = async (
  taskId: string,
  opts: { recreateFrom?: string } = {},
): Promise<EnsureRequirementGroupResult> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/requirement-group`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        opts.recreateFrom ? { recreateFrom: opts.recreateFrom } : {},
      ),
    },
  );
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiRequestError(`HTTP ${res.status}`, res.status);
  }
  if (
    typeof data === "object" &&
    data !== null &&
    !res.ok &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
  ) {
    const err = data as {
      error: string;
      code?: unknown;
      chatId?: unknown;
      chatName?: unknown;
    };
    return {
      ok: false,
      error: err.error.trim() || `打开需求群失败（HTTP ${res.status}）`,
      needGroupRebuild: GROUP_REBUILD_CODES.has(String(err.code ?? "")),
      chatId: typeof err.chatId === "string" ? err.chatId : undefined,
      chatName: typeof err.chatName === "string" ? err.chatName : undefined,
    };
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new ApiRequestError(msg, res.status);
  }
  const ok = data as {
    ok?: unknown;
    chatId?: unknown;
    chatName?: unknown;
    created?: unknown;
    membershipUnknown?: unknown;
  };
  if (ok.ok !== true) {
    throw new ApiRequestError("需求群响应异常", res.status || 500);
  }
  return {
    ok: true,
    chatId: typeof ok.chatId === "string" ? ok.chatId : "",
    chatName: typeof ok.chatName === "string" ? ok.chatName : undefined,
    created: ok.created === true,
    membershipUnknown: ok.membershipUnknown === true,
  };
};
