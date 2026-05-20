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

import fs from "node:fs/promises";

import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import { getPhaseArtifactPath, getTask, patchPhase } from "@/lib/server/task-fs";
import { isPlanRunning, runPlanWorkflow } from "@/lib/server/plan-runner";
import type { PhaseId, Task } from "@/lib/types";
import { WORKFLOWS } from "@/lib/types";

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

  // 拼 RESUME prompt 给 agent
  // V0.5.1：先**实际检查** currentPhase 对应的 artifact 是否在硬盘上、根据存在性分两条路：
  //   - artifact 在 → wait-ack 长连接断了、agent 重新调 wait_for_user 续接 ack 即可
  //   - artifact 不在 → 之前 run error 中途退出（如网络断在写 artifact 之前）、
  //                     agent 必须**继续/重做**当前 phase 的工作、写完 artifact 再调 wait_for_user
  //
  // 老版本（V0.3.5）resume 不检查、一律告诉 agent「artifact 已经在硬盘上、直接 wait_for_user」、
  // 结果 agent 信以为真、跑去 wait_for_user 阻塞 + 告诉用户「已产出」、用户硬盘上空着。
  const currentPhase = (task.currentPhase ?? "plan") as PhaseId;
  const workflowDef = WORKFLOWS[task.workflowId ?? "feishu-story-impl"];
  const phaseIdx = workflowDef?.phases.indexOf(currentPhase) ?? -1;
  const artifactPath =
    phaseIdx >= 0 ? getPhaseArtifactPath(task.id, currentPhase, phaseIdx) : "";

  let artifactExists = false;
  if (artifactPath) {
    try {
      const stat = await fs.stat(artifactPath);
      artifactExists = stat.isFile() && stat.size > 0;
    } catch {
      // 文件不存在 / stat 失败 → artifactExists = false
    }
  }

  const resumePromptLines = artifactExists
    ? [
        `[RESUME_WAITING]`,
        ``,
        `上一段 wait-ack 长连接异常断开（curl 失败 / 服务重启 / 网络断）、用户在 fe-ai-flow 看板上点了「继续监听」、由本路由用 Agent.resume 把你叫醒。`,
        ``,
        `当前 task=${task.id}、phase=${currentPhase}、task 状态：${task.status}。`,
        `服务端**已确认 artifact 在硬盘上**：\`${artifactPath}\``,
        ``,
        `**你接下来只做一件事**：再次调用 \`wait_for_user(task_id="${task.id}", phase="${currentPhase}", artifact="${artifactPath}")\` 重新拿一个 [SHELL_WAIT_GUIDE]、然后按引导调 shell + curl 续接 wait-ack 长连接。`,
        ``,
        `**不要**重新执行已经做过的工作（artifact 已经在硬盘上、不要重写）、**不要**重新走 super-prompt 流程、**不要** emit 任何元叙述 assistant_message——直接调 wait_for_user 续接即可。`,
      ]
    : [
        `[RESUME_INCOMPLETE]`,
        ``,
        `上一轮 agent run 提前 error 退出（典型：网络断 / SDK retry 用完 / 工具调用失败）、用户在 fe-ai-flow 看板上点了「继续监听」、由本路由用 Agent.resume 把你叫醒。`,
        ``,
        `当前 task=${task.id}、phase=${currentPhase}、task 状态：${task.status}。`,
        `服务端检查后**没找到** ${currentPhase} phase 的 artifact 文件（路径：\`${artifactPath}\`）——说明上一轮你**还没写完当前 phase**就退出了。`,
        ``,
        `**你接下来必须做的事**：`,
        ``,
        `1. **继续执行 ${currentPhase} phase 的工作**——按 super-prompt 里对应 phase 的指令做完该 phase 的产出动作（读 contextDocs / 扫仓库 / 改代码 / ……）`,
        `2. **用 \`write\` 工具把 artifact 写到**：\`${artifactPath}\``,
        `   args 形如 \`{ path: "${artifactPath}", fileText: "<完整 markdown>" }\``,
        `   **不是 \`edit\`**——artifact 文件目前不存在、edit 会失败`,
        `3. 写完 artifact **再**调 \`wait_for_user(task_id="${task.id}", phase="${currentPhase}", artifact="${artifactPath}")\` 拿 [SHELL_WAIT_GUIDE]、按引导调 shell + curl 等 ack`,
        ``,
        `**绝对不要**：`,
        `- 跳过实际工作直接调 wait_for_user 喊「已完成」（artifact 没写 = 没完成）`,
        `- emit assistant_message 说「我已经把 ${currentPhase} 做完了」之类的总结——用户看的是硬盘上的 artifact、不是你的话`,
        `- 编造工作完成状态——服务端会比对硬盘 artifact 文件大小、骗不过去`,
        ``,
        `上一轮你做到哪里了、上下文应该在你的会话历史里、按历史接着做即可。如果历史信息不够、就重新做一遍 ${currentPhase} phase。`,
      ];
  const resumePrompt = resumePromptLines.join("\n");

  console.log(
    `[resume-waiting] task=${task.id} phase=${currentPhase} artifactExists=${artifactExists} path=${artifactPath}`,
  );

  // V0.5.5：先同步把 task.status 切回 running、再 fire-and-forget runPlanWorkflow——
  // 不然客户端拿到的还是 failed、马上发起的 watch-chat 请求会被服务端 bootstrap 完直接 close、
  // 用户体感就是「点了继续监听但页面没动、必须刷新才能看到」(plan-runner 内部第二步 patchPhase 太晚)
  const running = (await patchPhase(task.id, { taskStatus: "running" })) ?? task;

  void runPlanWorkflow({
    task: running,
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

  return okResponse({ task: running, already: false });
};
