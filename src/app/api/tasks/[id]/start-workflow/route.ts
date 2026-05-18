/**
 * POST /api/tasks/[id]/start-workflow
 *
 * plan 模式任务专用：启动 workflow agent run（V0.5 起 plan → build → review 共 3 phase、一次 SDK Run 跑全程）。
 *
 * Body: { apiKey: string; model: ModelSelection; mcpServers?: Record<string, McpServerConfig> }
 *
 * 「启动 / 订阅拆开」设计：
 *   - 本路由只管启动 + 立即返回最新 task
 *   - SSE 订阅走 GET /watch-chat（plan 模式也复用同一条流、watch-chat 已放开 mode 校验）
 *   - 已经在跑 → 200 already=true（幂等、刷新页面随便点不报错）
 *
 * 备注：chat 模式没有专门的 start 路由（V0.4 已删 /start-chat）、启动职责合到 /chat-reply。
 */

import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import { getTask } from "@/lib/server/task-fs";
import { isPlanRunning, runPlanWorkflow } from "@/lib/server/plan-runner";
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

  if (task.mode !== "plan") {
    return errorResponse(
      `任务 mode=${task.mode}、不是 plan 模式、chat 模式走 /chat-reply`,
      409,
    );
  }

  // 已在跑 → 幂等
  if (isPlanRunning(task.id)) {
    return okResponse({ task, already: true });
  }

  // fire-and-forget：后台跑、事件 publish 给 SSE 订阅者
  void runPlanWorkflow({
    task,
    apiKey,
    model,
    userMcpServers,
  }).catch((err) => {
    console.error(
      `[start-workflow] task=${task.id} runPlanWorkflow threw:`,
      err,
    );
  });

  return okResponse({ task, already: false });
};
