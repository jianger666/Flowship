/**
 * 客户端任务存取（V1·走 /api/tasks/* + 服务端 fs）
 *
 * 历史包袱：早期版本走 localStorage、为了零依赖 / 调试方便。
 * 切到 fs 是因为：
 *  - localStorage 单 key 5MB 上限
 *  - 跨标签页 / 重启浏览器都不丢
 *  - 文件可以人 cat / git diff / 编辑器开
 *
 * 这层只做 fetch + 错误归一、不带任何状态机逻辑（那归 task-fs.ts）。
 *
 * 接口设计：所有函数返回 Promise；调用方负责 try/catch + toast。
 */

import type { McpServerConfig, ModelSelection } from "@cursor/sdk";
import type {
  AskUserAnswer,
  NewTaskInput,
  PhaseId,
  Task,
  TaskEvent,
} from "./types";

// V0.5.3：原来的 `FEISHU_WORKFLOW_NEXT_PHASE` 静态表已删——
// 它只有定义、没人 import（漏网死代码）；下一 phase 计算改走 `getNextPhase(workflowDef, current)`
// helper（在 types.ts、跟 WORKFLOWS 同源、扩 phase 时只需改 workflow.phases）

/**
 * 从设置页存的 mcpServersJson 字符串解析出 SDK 能直接用的 mcpServers 对象
 *
 * 输入约定：
 *   - 空串 / undefined → undefined（agent 不接 MCP）
 *   - 必须带外层 `mcpServers` wrapper（与 Cursor IDE ~/.cursor/mcp.json 一致）
 *   - 不深校验单 server schema、留给 SDK 报错（更准）
 *
 * 失败场景统一抛 Error、由调用方 toast 出去
 */
export const parseMcpServers = (
  json: string | undefined,
): Record<string, McpServerConfig> | undefined => {
  if (!json || !json.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `MCP 配置 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP 配置必须是 JSON 对象");
  }
  const inner = (parsed as { mcpServers?: unknown }).mcpServers;
  if (inner == null) {
    throw new Error('MCP 配置缺少外层 "mcpServers" 键');
  }
  if (typeof inner !== "object" || Array.isArray(inner)) {
    throw new Error('"mcpServers" 必须是对象');
  }
  const obj = inner as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return undefined;
  return obj as Record<string, McpServerConfig>;
};

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

export const fetchTasks = async (): Promise<Task[]> => {
  const res = await fetch("/api/tasks", { cache: "no-store" });
  const data = await handleJson<{ tasks: Task[] }>(res);
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

// ----------------- 创建 / 删除 -----------------

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

/**
 * 更新任务级 MCP 黑名单
 *
 * @param disabled 禁用的 server 名列表；null 或空数组 = 全开
 */
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

/**
 * 按 task.disabledMcpServers 过滤全量 mcpServers
 *
 * 用在 sendChatReply / startWorkflow 调用前：UI 拿全量 mcpServers（从 settings 解析）、
 * 这里按任务黑名单过掉、再传给后端 SDK。
 *
 * - servers undefined：返 undefined（无 MCP 走）
 * - disabled undefined / 空：返原 servers
 * - disabled 列表：删掉这些 server、其它保留
 */
export const filterMcpServersByTask = (
  servers: Record<string, McpServerConfig> | undefined,
  disabled: string[] | undefined,
): Record<string, McpServerConfig> | undefined => {
  if (!servers) return undefined;
  if (!disabled || disabled.length === 0) return servers;
  const next: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!disabled.includes(name)) next[name] = cfg;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

// ----------------- 事件 / 状态推进 -----------------

interface AppendEventInput {
  kind: TaskEvent["kind"];
  phase?: PhaseId;
  text: string;
  meta?: Record<string, unknown>;
  // 可选：在追加事件的同时推进 phase / task 状态（atomic）
  // - phaseId + status 成对出现：改对应 phase 状态
  // - taskStatus：改顶层任务状态
  // - currentPhase：切当前 phase
  // 三组按需组合、不传就只追加事件
  patch?: {
    phaseId?: PhaseId;
    status?: "pending" | "running" | "awaiting_ack" | "ack" | "failed";
    taskStatus?: "draft" | "running" | "awaiting_user" | "completed" | "failed";
    currentPhase?: PhaseId;
  };
}

export const appendEvent = async (
  taskId: string,
  ev: AppendEventInput,
): Promise<Task> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ev),
    },
  );
  const data = await handleJson<{ task: Task }>(res);
  return data.task;
};

// ----------------- SSE 工具（plan / chat 共用） -----------------

interface SSEEnvelope {
  type: "event" | "artifact" | "task" | "done" | "error" | "assistant_delta";
  event?: TaskEvent;
  content?: string;
  task?: Task;
  ok?: boolean;
  message?: string;
  // assistant_delta 帧带的字段：流式 chunk 文本
  // 前端拼到 streamingText、收到 event(assistant_message) 时清空
  text?: string;
}

// SSE 解析：每条消息以 \n\n 结尾、消息内 data: 行的 payload 是 JSON
// 一条消息可以有多行 data: ... 我们走单行简化（后端也只发单行）
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

// ----------------- Chat / Workflow 共享 SSE 订阅 -----------------

/**
 * 订阅 chat 任务的事件流（GET SSE）
 *
 * 协议：
 *   - 进来先收一帧 task + 全部历史 events（bootstrap）
 *   - 然后实时推增量事件 / task 变化
 *   - 任务终止 → 收一帧 done、流自动关闭
 *
 * 任意时刻可调（任务还没启动也行、就只 push 当前 task 然后挂着）。
 * 多个 tab 同时 watch 都行、互不干扰。
 *
 * 返回 Promise 在「流结束」时 resolve（agent 终止 / 客户端 abort）。
 */
export interface ChatStreamCallbacks {
  onEvent?: (ev: TaskEvent) => void;
  onTaskUpdate?: (task: Task) => void;
  onDone?: (task: Task, ok: boolean) => void;
  onError?: (message: string) => void;
  // 流式 chunk 推送、UI 拼接展示打字效果
  // 服务端在每个 SDK assistant chunk 到达时 publish 一次、内容是「新增」chunk（非全量）
  // 上层维护「当前 streaming text」、收到本回调时累加、收到 onEvent(assistant_message) 时清空
  onAssistantDelta?: (text: string) => void;
}

export const watchChatStream = async (
  taskId: string,
  callbacks: ChatStreamCallbacks = {},
  signal?: AbortSignal,
): Promise<void> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/watch-chat`,
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
          // chat 协议不发 artifact、复用 dispatch 时忽略它
          if (env.type === "event" && env.event) {
            callbacks.onEvent?.(env.event);
          } else if (env.type === "task" && env.task) {
            callbacks.onTaskUpdate?.(env.task);
          } else if (env.type === "done" && env.task) {
            callbacks.onDone?.(env.task, !!env.ok);
          } else if (env.type === "error") {
            callbacks.onError?.(env.message ?? "未知错误");
          } else if (env.type === "assistant_delta" && typeof env.text === "string") {
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

// 附图入参：前端通过 FileReader 读出 base64、跟 mimeType / filename 一起 POST
export interface ChatReplyImage {
  // 纯 base64 字符串（不带 data: 前缀、调用方自己 strip）
  data: string;
  mimeType: string;
  // 原始文件名（UI 显示用、可选）
  filename?: string;
}

/**
 * V0.4 chat 自由化：发消息时给后端的「自动启动 agent」配置
 *
 * task.status ∈ {draft, completed, failed} 时、chat-reply 路由会：
 *   1. 写 user_reply 事件
 *   2. 用 bootArgs 启 agent
 *   3. 把这条消息塞进 agent 第一次 wait_for_user
 *
 * task.status === awaiting_user 时这个字段可省（agent 在跑、不需要重新启动）。
 * 调用方为简化逻辑、可以**永远传 bootArgs**、后端按需取用。
 */
export interface ChatReplyBootArgs {
  apiKey: string;
  model: ModelSelection;
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * 给 chat agent 发一条用户消息（V0.4 起兼具「自动启动」职责）
 *
 * @param text         用户消息文本（可为空、但 images / attachments 至少有一个）
 * @param images       可选附图、由后端校验白名单 / size、落盘 + 把绝对路径塞给 wait_for_user
 * @param attachments  可选附路径（文件 / 目录绝对路径数组、来自 FsPickerDialog）、由后端校验存在 +
 *                     拼成 `[ATTACHED_PATHS]` 段塞给 wait_for_user、agent 用 `read` 工具自己读
 * @param bootArgs     V0.4：终态发消息时用来启 agent（apiKey/model/mcpServers）
 *                     调用方建议无脑传、后端自己判断要不要启动
 *
 * 后端语义（详见 chat-reply route 顶部注释）：
 *   - awaiting_user → 走 submitUserMessage（正常对话回合）
 *   - draft/completed/failed → 走自动启动 + 投递首条（V0.4 自由化）
 *
 * 失败语义：
 *   - HTTP 4xx：参数错 / 终态发消息但没传 bootArgs / 图片或路径校验失败
 *   - HTTP 409：状态冲突（如终态但 agent run 还残留）
 *   - HTTP 410：僵尸态、agent 已断开
 *   - 调用方 catch 后用 toast 提示
 */
export const sendChatReply = async (
  taskId: string,
  text: string,
  images?: ChatReplyImage[],
  attachments?: string[],
  bootArgs?: ChatReplyBootArgs,
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

// ----------------- Plan workflow（V0.2） -----------------

/**
 * 启动 plan workflow agent run（一次 SDK Run 跑全程 3 phase：plan → build → review、V0.5）
 *
 * 行为：幂等、立即返回 task；已 spawn 则返 already=true。SSE 订阅走 watchChatStream（路由复用）。
 */
export const startWorkflow = async (
  taskId: string,
  apiKey: string,
  model: ModelSelection,
  mcpServers: Record<string, McpServerConfig> | undefined,
): Promise<{ task: Task; already: boolean }> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/start-workflow`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, model, mcpServers }),
    },
  );
  return await handleJson<{ ok: true; task: Task; already: boolean }>(res);
};

/**
 * V0.3.5：续接 wait-ack 长连接（用户在 UI 点「继续监听」）
 *
 * 触发：wait_for_user → shell + curl 长连接异常断开后、agent 自然结束 run、task status=failed
 * 但 task.lastAgentId 还在、用户可以选择「继续监听」用 Agent.resume 把 agent 叫醒续接
 *
 * 服务端：POST /api/tasks/[id]/resume-waiting
 *   - Agent.resume(lastAgentId) + send 一条 RESUME prompt
 *   - runPlanWorkflow 在 isResume=true 时跳过 phase_start、保留 phase 状态、taskStatus 切 running
 */
export const resumeWaiting = async (
  taskId: string,
  apiKey: string,
  model: ModelSelection,
  mcpServers: Record<string, McpServerConfig> | undefined,
): Promise<{ task: Task; already: boolean }> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/resume-waiting`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, model, mcpServers }),
    },
  );
  return await handleJson<{ ok: true; task: Task; already: boolean }>(res);
};

/**
 * V0.5 phase-ack 选项（approve 时可选用）
 *
 * 默认：旧 agent 继续跑下一 phase（同一 SDK Run、不再计费）。
 *
 * 用户主动选「换新 agent」/「切模型」时：
 *   - forkAgent=true：cancel 旧 agent + 起一个新 Agent.create run（消耗 1 次新 send 配额）
 *   - nextModel 提供时隐含 forkAgent=true（旧 agent 已经用旧模型跑、模型不可中途切）
 *   - bootArgs 必填（apiKey + mcpServers 用于 Agent.create 新 agent）
 *
 * 默认值约定：UI 默认 forkAgent=false 且 nextModel 未传、即「同 agent 继续」
 */
export interface PhaseAckForkOptions {
  forkAgent?: boolean;
  nextModel?: ModelSelection;
  bootArgs?: {
    apiKey: string;
    mcpServers?: Record<string, McpServerConfig>;
  };
}

/**
 * 用户在 plan 任务详情页点「通过」或「再聊聊」、把动作 ack 给阻塞中的 workflow agent
 *
 * @param action   approve / revise
 * @param feedback revise 必填（用户的修改意见）、approve 可空
 * @param phase    可选、防 race 用 currentPhase 兜底
 * @param fork     V0.5：approve 时可选「换新 agent / 切模型」、详见 PhaseAckForkOptions
 */
export const submitPhaseAck = async (
  taskId: string,
  action: "approve" | "revise",
  feedback?: string,
  phase?: PhaseId,
  fork?: PhaseAckForkOptions,
): Promise<Task> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/phase-ack`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        feedback,
        phase,
        forkAgent: fork?.forkAgent,
        nextModel: fork?.nextModel,
        bootArgs: fork?.bootArgs,
      }),
    },
  );
  const data = await handleJson<{ ok: true; task: Task }>(res);
  return data.task;
};

// ----------------- Context Docs（V0.3） -----------------

/**
 * 给任务加一条上下文文档（详情页面板里点「添加」时调）
 *
 * 后端会按内容自动推断 type（url / path / text）、UI 不用手动选。
 * 成功返回最新 task、调用方刷新面板列表即可。
 */
export const addContextDoc = async (
  taskId: string,
  input: { title: string; content: string },
): Promise<Task> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/context-docs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const data = await handleJson<{ ok: true; task: Task }>(res);
  return data.task;
};

/**
 * 删一条上下文文档
 *
 * idempotent：删一个不存在的 docId 也不报错、返回当前 task。
 */
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

// ----------------- ask_user 回复（V0.3.2） -----------------

/**
 * 用户在 AskUserDialog 答完所有问题后提交答案
 *
 * 服务端：POST /api/tasks/[id]/ask-reply
 *   - 写 ask_user_reply 事件、resolve agent
 * 抽到 task-store 是为了让 ask-user-dialog 不直接裸 fetch、错误归一走 handleJson
 */
export const submitAskReply = async (
  taskId: string,
  askId: string,
  answers: AskUserAnswer[],
): Promise<{ ok: true }> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/ask-reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ askId, answers }),
    },
  );
  return await handleJson<{ ok: true }>(res);
};
