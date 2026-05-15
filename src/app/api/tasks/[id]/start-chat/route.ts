/**
 * POST /api/tasks/[id]/start-chat
 *
 * Body: { apiKey: string; model: ModelSelection; mcpServers?: Record<string, McpServerConfig> }
 *
 * 启动 chat 模式 agent run（仅启动、不推 SSE）。
 *
 * 设计原则：
 *   - **启动** 与 **订阅事件流** 拆开：本路由只管启动、订阅走 GET /watch-chat
 *   - 已经在跑 → 200 already=true（幂等、刷新页面随便点都不报错）
 *   - 立即返回最新 task（前端拿到当下 status）、agent 在后台 fire-and-forget
 *   - agent 全程不依赖客户端连接、关浏览器 / 刷新页面 / 多 tab 都不影响 agent
 *
 * 失败语义：
 *   - 4xx：参数 / 状态错误
 *   - 200：成功启动 / 已在跑
 */

import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import { getTask } from "@/lib/server/task-fs";
import { runChatSession, isChatRunning } from "@/lib/server/chat-runner";
import type { Task } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  apiKey?: string;
  model?: ModelSelection;
  mcpServers?: Record<string, McpServerConfig>;
}

const isValidModel = (m: unknown): m is ModelSelection => {
  if (!m || typeof m !== "object") return false;
  const x = m as Partial<ModelSelection>;
  return typeof x.id === "string" && x.id.length > 0;
};

const isValidMcpServers = (
  v: unknown,
): v is Record<string, McpServerConfig> => {
  if (v == null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every(
    (cfg) => cfg != null && typeof cfg === "object",
  );
};

export const runtime = "nodejs";

const errorResponse = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const okResponse = (payload: { task: Task; already: boolean }) =>
  new Response(JSON.stringify({ ok: true, ...payload }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const apiKey = body.apiKey?.trim();
  if (!apiKey) return errorResponse("缺少 apiKey");
  if (!isValidModel(body.model)) return errorResponse("model 非法");
  if (!isValidMcpServers(body.mcpServers)) {
    return errorResponse("mcpServers 必须是对象（key=server名、value=配置）");
  }
  const model = body.model;
  const userMcpServers = body.mcpServers;

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  if (task.mode !== "chat") {
    return errorResponse(
      `任务 mode=${task.mode}、不是 chat 模式、走 /run-plan`,
      409,
    );
  }

  // 已在跑 → 幂等返回
  if (isChatRunning(task.id)) {
    return okResponse({ task, already: true });
  }

  // fire-and-forget：runChatSession 不 await、agent 在后台跑、事件 publish 给订阅者
  // 这里捕个 unhandledRejection、避免 promise 泄露
  void runChatSession({
    task,
    apiKey,
    model,
    userMcpServers,
  }).catch((err) => {
    console.error(`[start-chat] task=${task.id} runChatSession threw:`, err);
  });

  return okResponse({ task, already: false });
};
