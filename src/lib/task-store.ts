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
import type {
  ActionRecord,
  ArtifactRevision,
  AskUserAnswer,
  NewTaskInput,
  Task,
  TaskEvent,
  TaskSummary,
} from "./types";

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
    throw new Error(msg);
  }
  return data as T;
};

// ----------------- 列表 / 详情 -----------------

export const fetchTasks = async (): Promise<TaskSummary[]> => {
  const res = await fetch("/api/tasks", { cache: "no-store" });
  const data = await handleJson<{ tasks: TaskSummary[] }>(res);
  return data.tasks;
};

export const fetchTask = async (id: string): Promise<Task | null> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  const data = await handleJson<{ task: Task }>(res);
  return data.task;
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

export const deleteTask = async (id: string): Promise<boolean> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 404) return false;
  await handleJson<{ ok: true }>(res);
  return true;
};

export const setTaskArchived = async (
  id: string,
  archived: boolean,
): Promise<Task> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
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

// ----------------- Cursor 全局 MCP（只读展示 + task 黑名单候选源） -----------------

export interface CursorMcpInfo {
  // ~/.cursor/mcp.json 里的 mcpServers 原样（含 type/url/command/env...）
  servers: Record<string, McpServerConfig>;
  // 读取候选目录（展示「配置读自哪个 ~/.cursor/」）
  dirs: string[];
}

/**
 * 读 Cursor 全局 MCP 配置（GET /api/cursor-mcp）
 *
 * V0.6.2「跟 Cursor 共用工具」：fe 不再让用户编辑 MCP、统一展示 Cursor 的配置（单一源）。
 * 用在：设置页 mcp-card 只读展示 + new-task / task-mcp-panel 的「黑名单候选源」。
 * MCP 真正注入 agent 在 server 端做（cursor-config.ts）、client 只拿来展示 / 选黑名单。
 */
export const fetchCursorMcp = async (): Promise<CursorMcpInfo> => {
  const res = await fetch("/api/cursor-mcp", { cache: "no-store" });
  const data = await handleJson<{
    ok: true;
    servers: Record<string, McpServerConfig>;
    dirs: string[];
  }>(res);
  return { servers: data.servers, dirs: data.dirs };
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
    | "assistant_delta";
  event?: TaskEvent;
  content?: string;
  task?: Task;
  action?: ActionRecord;
  ok?: boolean;
  message?: string;
  text?: string;
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
}

export const watchTaskStream = async (
  taskId: string,
  callbacks: TaskStreamCallbacks = {},
  signal?: AbortSignal,
): Promise<void> => {
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
    throw new Error(msg);
  }
  if (!res.body) {
    throw new Error("响应体缺失（不支持流式？）");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
 * 后端语义（详见 /chat-reply route 顶部注释）：
 *   - awaiting_user + hasPending → submitUserMessage（正常对话循环）
 *   - idle / error / 上一轮 completed → bootArgs 启 chat agent + 投递首条
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
): Promise<{ task: Task; autoStarted: boolean }> => {
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
      }),
    },
  );
  const data = await handleJson<{
    ok: true;
    task: Task;
    autoStarted?: boolean;
  }>(res);
  return { task: data.task, autoStarted: !!data.autoStarted };
};

/**
 * V0.6 ack 当前 action（approve / revise）
 *
 * @param decision approve：用户「通过」、agent 推进等下一 action 指令
 *                 revise：用户「再聊聊」、agent 按 V0.5.10 二分类铁则处理
 * @param feedback revise 时的反馈文本（带 images 时可空）、approve 时忽略
 * @param images   revise 时携带图片附件（用户截图说改这里）
 * @param forceNewAgent approve 时勾选「换新 agent」、起新 Agent 走下一 action
 * @param agentModel    approve 时切模型（隐含 forceNewAgent=true）
 * @param bootArgs      forceNewAgent / agentModel 提供时必填
 */
export interface ActionAckOptions {
  feedback?: string;
  images?: ImagePayload[];
  forceNewAgent?: boolean;
  agentModel?: ModelSelection;
  bootArgs?: TaskBootArgs;
}

export const submitActionAck = async (
  taskId: string,
  actionId: string,
  decision: "approve" | "revise",
  options?: ActionAckOptions,
): Promise<Task> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/action-ack`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionId,
        decision,
        feedback: options?.feedback,
        images: options?.images,
        forceNewAgent: options?.forceNewAgent,
        agentModel: options?.agentModel,
        bootArgs: options?.bootArgs,
      }),
    },
  );
  const data = await handleJson<{ ok: true; task: Task }>(res);
  return data.task;
};

/**
 * V0.6 任务终态控制（用户在 ack dialog 选「合入」/「abandon」）
 *
 * - merged: 标 repoStatus=merged + write [TASK_DONE] + Agent 退出 + 可触发 learn
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
  taskId: string,
  askId: string,
  answers: AskUserAnswer[],
  options?: { deferred?: boolean },
): Promise<{ ok: true }> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/ask-reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        askId,
        answers,
        ...(options?.deferred ? { deferred: true } : {}),
      }),
    },
  );
  return await handleJson<{ ok: true }>(res);
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
