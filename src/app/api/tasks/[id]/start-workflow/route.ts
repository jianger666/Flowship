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

import { getTask, patchPhase } from "@/lib/server/task-fs";
import {
  cancelPlan,
  isPlanRunning,
  markPlanForFork,
  runPlanWorkflow,
  waitForPlanToStop,
} from "@/lib/server/plan-runner";
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

  // 已在跑 + 不是 awaiting_user 状态 → 幂等返回
  // V0.5.5：awaiting_user 状态（agent 等 ack 中）虽然 isPlanRunning=true、但用户点重启的意图明确——
  //   想 cancel 旧 agent + 起新 agent 从 plan 重头跑（测试新 prompt / 切模型场景）、不能简单返 already=true
  //   走 fork 路径：markPlanForFork + cancelPlan + waitForPlanToStop、然后从 firstPhase 起新 run
  if (isPlanRunning(task.id)) {
    if (task.status !== "awaiting_user") {
      return okResponse({ task, already: true });
    }
    console.log(
      `[start-workflow] task=${task.id} awaiting_user + isPlanRunning、走 cancel-and-restart`,
    );
    markPlanForFork(task.id);
    cancelPlan(task.id);
    const stopped = await waitForPlanToStop(task.id, 10000);
    if (!stopped) {
      console.warn(
        `[start-workflow] task=${task.id} waitForPlanToStop timeout 10s、旧 agent 没干净退出`,
      );
      return errorResponse(
        "旧 agent 收尾超时、未能重启、请稍后重试",
        503,
      );
    }
  }

  // V0.5.5：先同步把 task.status 切到 running、再 fire-and-forget——
  // 之前任务终态（failed/completed）后点重启、route 立刻返 still-failed 的 task、
  // 前端 SSE 重连 watch-chat 时服务端看到 failed 直接 bootstrap+close、
  // 用户体感「页面没反应、必须刷新」(plan-runner 自己 patchPhase 在异步流程里太晚)
  const running = (await patchPhase(task.id, { taskStatus: "running" })) ?? task;

  void runPlanWorkflow({
    task: running,
    apiKey,
    model,
    userMcpServers,
  }).catch((err) => {
    console.error(
      `[start-workflow] task=${task.id} runPlanWorkflow threw:`,
      err,
    );
  });

  return okResponse({ task: running, already: false });
};
