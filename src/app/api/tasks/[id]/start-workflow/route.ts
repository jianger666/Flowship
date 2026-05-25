/**
 * POST /api/tasks/[id]/start-workflow
 *
 * plan 模式任务专用：启动 workflow agent run（V0.5 起 plan → build → review 共 3 phase、一次 SDK Run 跑全程）。
 *
 * # V0.5.7 重构：统一推进入口（合并原 /resume-waiting）
 *
 * 历史：原来分两个路由——/start-workflow（从 plan 重头跑）+ /resume-waiting（Agent.resume 续接）
 * 用户视角分两个按钮：「重启 workflow」与「继续监听」、技术细节硬塞给用户、且「重启」只能从 plan 头。
 * V0.5.7 合并为一个入口、用 mode + fromPhase 让用户/后端显式选「推进方式」：
 *
 *   mode = "resume" : Agent.resume(lastAgentId)、保留对话历史
 *                     resume 失败（ENHANCE_YOUR_CALM / agentId 过期）→ plan-runner 内部自动降级 fork
 *                     用户视角：「让原 agent 继续推进」、没失败成本最低
 *
 *   mode = "fork"   : Agent.create 新 agent + super-prompt 顶部 fork banner、从 fromPhase 起跑
 *                     fromPhase 必填、可选 plan / build / review、上游 artifact 复用
 *                     用户视角：「起新 agent、从 Phase X 重启」
 *
 *   mode = "restart": Agent.create 新 agent + 从 plan 重头跑（老路径、覆盖所有 artifact）
 *                     用户视角：「完全重头跑」、不希望复用任何旧产物
 *
 *   缺省 mode       : "restart"（向后兼容；老 UI / 老调用 → 行为不变）
 *
 * # Body
 *
 * {
 *   apiKey: string;
 *   model: ModelSelection;
 *   mcpServers?: Record<string, McpServerConfig>;
 *   mode?: "resume" | "fork" | "restart";  // V0.5.7
 *   fromPhase?: PhaseId;                    // V0.5.7、mode=fork 必填
 * }
 *
 * 「启动 / 订阅拆开」设计：
 *   - 本路由只管启动 + 立即返回最新 task
 *   - SSE 订阅走 GET /watch-chat
 *   - 已在跑 → 200 already=true（幂等）
 */

import fs from "node:fs/promises";

import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import {
  errorResponse,
  isValidMcpServers,
  isValidModel,
} from "@/lib/server/route-helpers";
import { getPhaseArtifactPath, getTask, patchPhase } from "@/lib/server/task-fs";
import {
  cancelPlan,
  forceClearStaleRunnerState,
  isPlanRunning,
  markPlanForFork,
  runPlanWorkflow,
  waitForPlanToStop,
} from "@/lib/server/plan-runner";
import type { PhaseId, Task } from "@/lib/types";
import { PHASE_IDS, WORKFLOWS } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

// V0.5.7：start-workflow 的三种推进模式
type StartMode = "resume" | "fork" | "restart";

const isValidPhase = (v: unknown): v is PhaseId =>
  typeof v === "string" && (PHASE_IDS as readonly string[]).includes(v);

const isValidMode = (v: unknown): v is StartMode =>
  v === "resume" || v === "fork" || v === "restart";

interface PostBody {
  apiKey?: string;
  model?: ModelSelection;
  mcpServers?: Record<string, McpServerConfig>;
  mode?: StartMode;
  fromPhase?: PhaseId;
  // V0.5.7.1：fork 时用户填的「想修什么 / 重启原因」（自由文本、可空）
  // 透传到 plan-runner 的 fork.reason、forkBanner 会拼到 super-prompt 顶部
  // 让 AI 知道「这次是 fix 模式、按 reason 增量改、不 rewrite」
  reason?: string;
}

export const runtime = "nodejs";

const okResponse = (payload: { task: Task; already: boolean }) =>
  new Response(JSON.stringify({ ok: true, ...payload }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// resume 模式专用：拼 RESUME prompt（沿用原 /resume-waiting 路由的两条路径）
//   - artifact 在硬盘 → wait-ack 长连接断了、agent 重新调 wait_for_user 续接 ack
//   - artifact 不在 → 上轮 agent 跑到一半 error 退出、agent 必须继续/重做当前 phase 工作、写完 artifact 再 wait_for_user
const buildResumePrompt = async (task: Task): Promise<string> => {
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

  console.log(
    `[start-workflow] task=${task.id} mode=resume phase=${currentPhase} artifactExists=${artifactExists} path=${artifactPath}`,
  );

  const lines = artifactExists
    ? [
        `[RESUME_WAITING]`,
        ``,
        `上一段 wait-ack 长连接异常断开（curl 失败 / 服务重启 / 网络断）、用户在 fe-ai-flow 看板上点了「推进 / 让原 agent 继续」、由本路由用 Agent.resume 把你叫醒。`,
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
        `上一轮 agent run 提前 error 退出（典型：网络断 / SDK retry 用完 / 工具调用失败）、用户在 fe-ai-flow 看板上点了「推进 / 让原 agent 继续」、由本路由用 Agent.resume 把你叫醒。`,
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
  return lines.join("\n");
};

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

  // V0.5.7：mode 校验 + 缺省回 restart（向后兼容老 UI）
  if (body.mode !== undefined && !isValidMode(body.mode)) {
    return errorResponse(
      `mode 非法（只能是 resume / fork / restart、传了 ${JSON.stringify(body.mode)}）`,
    );
  }
  const mode: StartMode = body.mode ?? "restart";
  if (body.fromPhase !== undefined && !isValidPhase(body.fromPhase)) {
    return errorResponse(
      `fromPhase 非法（只能是 ${PHASE_IDS.join(" / ")}、传了 ${JSON.stringify(body.fromPhase)}）`,
    );
  }
  if (mode === "fork" && !body.fromPhase) {
    return errorResponse("mode=fork 时必须传 fromPhase");
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

  // 已在跑 → 幂等返回（不区分 mode、所有模式都遵循「一次只跑一个 run」）
  // 三类情况：
  //   1. task.status=running：真正有 agent 在跑、直接返 already=true（幂等）
  //   2. task.status=awaiting_user：agent 等 ack 中、用户点重启意图明确、走 cancel-and-restart
  //   3. task.status 是终态（draft / failed / completed）：in-memory state 不一致——
  //      实际 agent 已死或从未真存在（dev hot reload / 手改 meta.json / 老 bug）。
  //      `cancelPlan + waitForPlanToStop` 等不到 finally 清 entry、得暴力 forceClear 自愈
  if (isPlanRunning(task.id)) {
    if (task.status === "running") {
      return okResponse({ task, already: true });
    }
    if (task.status === "awaiting_user") {
      console.log(
        `[start-workflow] task=${task.id} awaiting_user + isPlanRunning、走 cancel-and-restart（mode=${mode}）`,
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
    } else {
      // V0.5.7：task.status 是终态但 in-memory entry 还在 —— stale state、暴力清
      console.log(
        `[start-workflow] task=${task.id} stale in-memory runner state（task.status=${task.status}、不应该有运行中的 agent）、forceClear 自愈`,
      );
      forceClearStaleRunnerState(task.id);
    }
  }

  // V0.5.7：resume 模式需要 lastAgentId、缺则降级到 fork（fromPhase=currentPhase）
  let effectiveMode = mode;
  let effectiveFromPhase = body.fromPhase;
  if (mode === "resume" && !task.lastAgentId) {
    console.log(
      `[start-workflow] task=${task.id} mode=resume but no lastAgentId、自动降级 fork`,
    );
    effectiveMode = "fork";
    effectiveFromPhase = (task.currentPhase ?? "plan") as PhaseId;
  }

  // V0.5.5：先同步把 task.status 切到 running、再 fire-and-forget——
  // 之前任务终态（failed/completed）后点重启、route 立刻返 still-failed 的 task、
  // 前端 SSE 重连 watch-chat 时服务端看到 failed 直接 bootstrap+close
  const running = (await patchPhase(task.id, { taskStatus: "running" })) ?? task;

  if (effectiveMode === "resume") {
    // Agent.resume(lastAgentId) + send RESUME prompt
    const resumePrompt = await buildResumePrompt(running);
    void runPlanWorkflow({
      task: running,
      apiKey,
      model,
      userMcpServers,
      resume: {
        agentId: running.lastAgentId!,
        prompt: resumePrompt,
      },
    }).catch((err) => {
      console.error(
        `[start-workflow] task=${task.id} runPlanWorkflow(resume) threw:`,
        err,
      );
    });
  } else if (effectiveMode === "fork") {
    // Agent.create 新 agent + super-prompt 顶部 fork banner
    // V0.5.7.1：用户 textarea 填的 reason（bug 描述等）拼到默认 reason 后面、
    // 让 AI 在 fork banner 里看到具体「想修什么」、定向增量改、不 rewrite。
    // 留空时只带默认 reason、AI 自己看 git diff 判断
    const userReason = body.reason?.trim();
    const finalReason = userReason
      ? `用户主动 fork 从 phase ${effectiveFromPhase} 重启、想修：${userReason}`
      : `用户主动 fork 从 phase ${effectiveFromPhase} 重启`;
    void runPlanWorkflow({
      task: running,
      apiKey,
      model,
      userMcpServers,
      fork: {
        fromPhase: effectiveFromPhase!,
        reason: finalReason,
      },
    }).catch((err) => {
      console.error(
        `[start-workflow] task=${task.id} runPlanWorkflow(fork) threw:`,
        err,
      );
    });
  } else {
    // restart（老路径）：Agent.create 新 agent + 从 plan 重头跑
    void runPlanWorkflow({
      task: running,
      apiKey,
      model,
      userMcpServers,
    }).catch((err) => {
      console.error(
        `[start-workflow] task=${task.id} runPlanWorkflow(restart) threw:`,
        err,
      );
    });
  }

  return okResponse({ task: running, already: false });
};
