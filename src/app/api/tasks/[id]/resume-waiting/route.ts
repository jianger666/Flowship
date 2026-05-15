/**
 * POST /api/tasks/[id]/resume-waiting
 *
 * # V0.3.5 新增：wait-ack 长连接异常断开后、用户手动续接 agent
 *
 * 触发场景：
 *   1. agent 调 wait_for_user → 拿 [SHELL_WAIT_GUIDE] → 调 shell + curl 长连接
 *   2. curl 连接异常断（网络断 / 服务重启 / max-time 超）→ agent 拿到 stderr / exit 非 0
 *   3. 按 super-prompt 引导、agent emit 简短 assistant_message 后自然结束 run
 *   4. UI 上检测到任务 status=running 但 lastAgentId 存在、显示「继续监听」按钮
 *   5. 用户点按钮 → 调本路由 → Agent.resume + send 一条 RESUME prompt → agent 醒过来
 *      → agent 重新调 wait_for_user → 新 SHELL_WAIT_GUIDE → 新 shell + curl 续接
 *
 * 成本：每次 resume 扣 1 次 send 配额（用户老套餐 500 次月、不频繁断不痛）
 *
 * # 入参
 *
 * 跟 start-workflow 同款：apiKey + model + mcpServers
 *   - apiKey / model：localStorage 里、前端透传
 *   - mcpServers：localStorage 里、前端透传（保持跟启动时配置一致）
 *
 * # 失败兜底
 *
 * - lastAgentId 不存在（老任务、agent 没启动过）→ 409、提示用户「请走重启 workflow 而不是续接」
 * - task 状态不对（不在 awaiting_user / running 这种「半途」状态）→ 409
 * - Agent.resume 失败（agentId 已过期 / Cursor backend 拒绝）→ 让 plan-runner 内部抛错、写 error 事件
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
      `任务 mode=${task.mode}、不是 plan 模式、无法 resume`,
      409,
    );
  }

  // 已经在跑 → 幂等（用户连点按钮 / 前端重试不应该报错）
  if (isPlanRunning(task.id)) {
    return okResponse({ task, already: true });
  }

  if (!task.lastAgentId) {
    return errorResponse(
      "本任务没有 lastAgentId（可能是老任务、或 agent 从未启动过）。请走『重启 workflow』而不是续接。",
      409,
    );
  }

  // 拼一条简短 RESUME prompt 给 agent、告诉它「上次 wait-ack 断了、请重新调 wait_for_user 续接」
  // 不重发 super-prompt（Agent.resume 自动恢复上下文）、只补一句操作指令
  const currentPhase = task.currentPhase ?? "plan";
  const resumePrompt = [
    `[RESUME_WAITING]`,
    ``,
    `上一段 wait-ack 长连接异常断开（curl 失败 / 服务重启 / 网络断）、用户在 fe-ai-flow 看板上点了「继续监听」、由本路由用 Agent.resume 把你叫醒。`,
    ``,
    `当前 task=${task.id}、phase=${currentPhase}、task 状态：${task.status}。`,
    ``,
    `**你接下来只做一件事**：再次调用 \`wait_for_user(task_id="${task.id}", phase="${currentPhase}", artifact="<刚才写过的 artifact 路径>")\` 重新拿一个 [SHELL_WAIT_GUIDE]、然后按引导调 shell + curl 续接 wait-ack 长连接。`,
    ``,
    `**不要**重新执行已经做过的工作（artifact 已经在硬盘上、不要重写）、**不要**重新走 super-prompt 流程、**不要** emit 任何元叙述 assistant_message——直接调 wait_for_user 续接即可。`,
  ].join("\n");

  // fire-and-forget：runPlanWorkflow 在 isResume=true 时跳过 phase_start、走 Agent.resume + send
  void runPlanWorkflow({
    task,
    apiKey,
    model,
    userMcpServers,
    resume: {
      agentId: task.lastAgentId,
      prompt: resumePrompt,
    },
  }).catch((err) => {
    console.error(
      `[resume-waiting] task=${task.id} runPlanWorkflow(resume) threw:`,
      err,
    );
  });

  return okResponse({ task, already: false });
};
