/**
 * POST /api/tasks/[id]/phase-ack
 *
 * V0.2 workflow 任务：用户在 UI 点「通过」或「再聊聊」（V0.5.2 文案、协议名沿用 revise）、本路由把动作 ack 给阻塞中的 agent。
 *
 * Body: {
 *   action: "approve" | "revise",
 *   feedback?: string,
 *   phase?: PhaseId,
 *   // V0.5：approve 时可选「换新 agent / 切模型」
 *   forkAgent?: boolean,
 *   nextModel?: ModelSelection,
 *   bootArgs?: { apiKey: string; mcpServers?: Record<string, McpServerConfig> }
 * }
 *
 * 行为：
 *   - approve（默认）：调 submitPhaseAck(approve) + markPhaseAcked(phase) 推进 task.currentPhase
 *     旧 agent 在同一 SDK Run 内继续跑下一 phase、不消耗新 send 配额
 *   - approve + (forkAgent || nextModel)：cancel 旧 agent + 起新 Agent.create run、可切模型
 *     消耗 1 次新 send 配额、但用户主动选了
 *   - revise：调 submitPhaseAck(revise, feedback) + 写一条 user_reply 事件
 *
 * 失败语义：
 *   - task 不存在 → 404
 *   - task.mode !== "plan" → 409
 *   - hasPending=false 且 task.status 在 awaiting_user/running → 410（僵尸态、当场标 failed）
 *   - hasPending=false 但 task.status 已终态 → 409
 *   - fork 时缺 bootArgs → 400
 *
 * 跟 chat-reply 路由的差异：
 *   - 解码用户动作（approve/revise）、不是裸文本
 *   - approve 时调 markPhaseAcked 推进 currentPhase + 上一 phase 状态
 *   - revise 时不推进 phase、agent 自己改完 artifact 再调 wait_for_user
 */

import type { McpServerConfig, ModelSelection } from "@cursor/sdk";

import {
  appendEvent,
  getTask,
  patchPhase,
  saveImageAttachments,
  type ImageAttachmentInput,
} from "@/lib/server/task-fs";
import {
  hasPending,
  submitPhaseAck,
} from "@/lib/server/chat-mcp";
import {
  cancelPlan,
  markPhaseAcked,
  markPlanForFork,
  runPlanWorkflow,
  waitForPlanToStop,
} from "@/lib/server/plan-runner";
import { publishChatStreamEvent } from "@/lib/server/chat-runner";
import { getNextPhase, WORKFLOWS, type PhaseId } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  action?: "approve" | "revise";
  feedback?: string;
  // V0.5.4：revise 可携带图片附件（用户截图 + 说改这里）、approve 时忽略
  // 跟 chat-reply 的 images 同款入参：纯 base64 + mimeType + filename
  images?: Array<{
    data?: string;
    mimeType?: string;
    filename?: string;
  }>;
  // 可选：用户期望 ack 的 phase id（防止 race 导致 ack 到错的 phase）
  // 不传时按 task.currentPhase 兜底
  phase?: PhaseId;
  // V0.5：approve 时可选「换新 agent / 切模型」
  forkAgent?: boolean;
  nextModel?: ModelSelection;
  bootArgs?: {
    apiKey: string;
    mcpServers?: Record<string, McpServerConfig>;
  };
}

// 整批上传 size 上限（跟 chat-reply 同款、防一次发 N 张超大图把服务端 / agent context 撑爆）
const MAX_TOTAL_UPLOAD_BYTES = 30 * 1024 * 1024;
// 单次最多附图数（跟 chat-reply 同款）
const MAX_IMAGES_PER_REVISE = 6;

const isValidModel = (m: unknown): m is ModelSelection => {
  if (!m || typeof m !== "object") return false;
  const x = m as Partial<ModelSelection>;
  return typeof x.id === "string" && x.id.length > 0;
};

const isValidMcpServers = (
  v: unknown,
): v is Record<string, McpServerConfig> | undefined => {
  if (v == null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every(
    (cfg) => cfg != null && typeof cfg === "object",
  );
};

const errorResponse = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const runtime = "nodejs";

// hasPending 瞬时 false 时 200ms 后再查一次（细节见 chat-reply/route.ts 同名常量注释）
// V0.3.5 shell + curl long-poll 下 race 窗口已大幅缩小、仍保留作防御
const KEEPALIVE_RACE_RETRY_MS = 200;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const action = body.action;
  if (action !== "approve" && action !== "revise") {
    return errorResponse("action 必须是 'approve' / 'revise'");
  }
  const feedback = (body.feedback ?? "").trim();
  // V0.5.4：revise 可只发图片不带文本（如「就改成这样」+ 截图）
  // 但 approve 不接受 images（语义上没必要）
  const rawImages =
    action === "revise" && Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > MAX_IMAGES_PER_REVISE) {
    return errorResponse(
      `单次最多附 ${MAX_IMAGES_PER_REVISE} 张图（你传了 ${rawImages.length}）`,
    );
  }
  if (action === "revise" && feedback.length === 0 && rawImages.length === 0) {
    return errorResponse("revise 必须带 feedback 文本或图片");
  }
  if (action === "approve" && rawImages.length > 0) {
    return errorResponse("approve 不接受 images（如要带图请改用 revise）");
  }

  // V0.5.4：校验 images 入参格式（不校验内容、内容校验放 saveImageAttachments 里抛错）
  const images: ImageAttachmentInput[] = [];
  let totalBytes = 0;
  for (const img of rawImages) {
    if (typeof img?.data !== "string" || !img.data.trim()) {
      return errorResponse("images[].data 必须是非空 base64 字符串");
    }
    if (typeof img.mimeType !== "string" || !img.mimeType.trim()) {
      return errorResponse("images[].mimeType 必填");
    }
    // 粗略估算 base64 → bytes（实际字节数 ≈ b64长度 * 3 / 4 - padding）
    totalBytes += Math.floor((img.data.length * 3) / 4);
    images.push({
      data: img.data,
      mimeType: img.mimeType,
      filename:
        typeof img.filename === "string" && img.filename.trim()
          ? img.filename.trim()
          : undefined,
    });
  }
  if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
    return errorResponse(
      `本次上传图片总大小约 ${(totalBytes / 1024 / 1024).toFixed(2)} MB、超过上限 ${MAX_TOTAL_UPLOAD_BYTES / 1024 / 1024} MB`,
    );
  }

  // V0.5：approve 时检测 fork 意图（forkAgent=true 或 nextModel 提供时都视为 fork）
  // revise 时如果带了 fork 参数、明确拒绝（fork 只对 approve 有意义）
  if (action === "revise" && (!!body.forkAgent || !!body.nextModel)) {
    return errorResponse("revise 不允许 fork、请改用 approve + fork");
  }
  const wantsFork =
    action === "approve" && (!!body.forkAgent || !!body.nextModel);
  if (wantsFork) {
    if (body.nextModel != null && !isValidModel(body.nextModel)) {
      return errorResponse("nextModel 非法");
    }
    if (body.bootArgs == null) {
      return errorResponse("fork 时缺 bootArgs（需 apiKey）");
    }
    if (!body.bootArgs.apiKey || typeof body.bootArgs.apiKey !== "string") {
      return errorResponse("fork 时 bootArgs.apiKey 不能为空");
    }
    if (!isValidMcpServers(body.bootArgs.mcpServers)) {
      return errorResponse("bootArgs.mcpServers 必须是对象（key=server名）");
    }
  }

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);
  if (task.mode !== "plan") {
    return errorResponse(`任务 mode=${task.mode}、phase-ack 仅适用 plan 模式`, 409);
  }

  // 校验 phase（容错）：未传时用 currentPhase 兜底
  const ackPhase: PhaseId = body.phase ?? task.currentPhase;

  // hasPending 检测 + keepalive race 兜底（跟 chat-reply 同款）
  let pending = hasPending(task.id);
  if (!pending) {
    await sleep(KEEPALIVE_RACE_RETRY_MS);
    pending = hasPending(task.id);
  }

  if (!pending) {
    // 没 pending：分两种情况
    if (task.status === "awaiting_user" || task.status === "running") {
      // 僵尸态：进程重启 / agent 崩溃
      console.warn(
        `[phase-ack] task=${task.id} 僵尸态 status=${task.status} hasPending=false、当场标 failed`,
      );
      const errorTask = await appendEvent(task.id, {
        kind: "error",
        text: "Workflow agent 已断开（进程重启或异常退出）、本次 ack 没送到。请回首页重启该任务。",
      });
      if (errorTask) {
        const lastEvent = errorTask.events[errorTask.events.length - 1];
        if (lastEvent) {
          publishChatStreamEvent(task.id, { kind: "event", event: lastEvent });
        }
      }
      const failedTask = await patchPhase(task.id, { taskStatus: "failed" });
      if (failedTask) {
        publishChatStreamEvent(task.id, { kind: "task", task: failedTask });
        publishChatStreamEvent(task.id, {
          kind: "done",
          task: failedTask,
          ok: false,
        });
      }
      return errorResponse("agent 已断开、请回首页重启该任务", 410);
    }
    return errorResponse(
      `agent 当前没在等用户 ack（task.status=${task.status}）`,
      409,
    );
  }

  console.log(
    `[phase-ack] task=${task.id} action=${action} phase=${ackPhase} wantsFork=${wantsFork} feedback=${feedback.slice(0, 60)} images=${images.length}`,
  );

  // 0) revise 带图：先落盘、拿到绝对路径数组（meta 写事件 + 传给 agent）
  // 失败：mimeType 不白名单 / size 超 / base64 损坏 → 400
  let savedImages: Awaited<ReturnType<typeof saveImageAttachments>> = [];
  if (images.length > 0) {
    try {
      savedImages = await saveImageAttachments(task.id, images);
    } catch (err) {
      return errorResponse(
        `图片处理失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 1) 先写一条事件、让用户视角立刻看到自己点了什么
  if (action === "approve") {
    // approve 事件由 markPhaseAcked 写（kind=phase_ack）、这里不重复写
  } else {
    // revise：写一条 user_reply 事件、meta 里标 kind=revise + 关联 phase
    // 带图时 meta.images 形状跟 chat-reply 同款、UI 复用 extractUserReplyImages
    const meta: Record<string, unknown> = { kind: "revise", phase: ackPhase };
    if (savedImages.length > 0) {
      meta.images = savedImages.map((s) => ({
        absPath: s.absPath,
        relPath: s.relPath,
        mimeType: s.mimeType,
        bytes: s.bytes,
        filename: s.filename,
      }));
    }
    // 纯图无文本场景给个 fallback、让事件流摘要不空
    const fallbackText = savedImages.length > 0 ? "(用户附了图片)" : "";
    await appendEvent(task.id, {
      kind: "user_reply",
      phase: ackPhase,
      text: feedback || fallbackText,
      meta,
    });
  }

  // 2a) 非 fork 路径：把动作塞给阻塞中的 wait_for_user、旧 agent 继续跑
  if (!wantsFork) {
    const imagePathsArg =
      savedImages.length > 0 ? savedImages.map((s) => s.absPath) : undefined;
    const ok = submitPhaseAck(
      task.id,
      action,
      action === "revise" ? feedback : undefined,
      imagePathsArg,
    );
    if (!ok) {
      return errorResponse(
        "agent 已不在等待 ack（可能并发处理 / keepalive 切换）、稍后重试",
        409,
      );
    }

    let updated = task;
    if (action === "approve") {
      const newTask = await markPhaseAcked(task.id, ackPhase);
      if (newTask) updated = newTask;
    } else {
      const newTask = await getTask(task.id);
      if (newTask) updated = newTask;
    }

    return new Response(
      JSON.stringify({ ok: true, task: updated }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // 2b) V0.5 fork 路径：cancel 旧 agent + 起新 Agent.create run
  //
  // 标准步骤：
  //   i.   markPlanForFork：让旧 run 收尾时跳过 done 发送（保留 SSE 给新 agent）
  //   ii.  cancelPlan：让旧 agent 拿到 [CANCELLED]、自然 stream 结束 + run.cancel
  //   iii. waitForPlanToStop：等 runningPlans delete（防止新 run 启动时被幂等保护拦截）
  //   iv.  markPhaseAcked：patch 数据库到 phase=ack、currentPhase=下一phase（不调 submitPhaseAck）
  //   v.   runPlanWorkflow(fork={...})：起新 agent、super-prompt 顶部提示「从下一 phase 接力」
  //
  // 计费影响：消耗 1 次新 Agent.create + send 配额（明确告知用户、由用户主动选）
  const workflowDef = WORKFLOWS[task.workflowId ?? "feishu-story-impl"];
  if (!workflowDef) {
    return errorResponse(`workflow ${task.workflowId} 未注册`, 500);
  }
  const nextPhase = getNextPhase(workflowDef, ackPhase);
  if (!nextPhase) {
    // 最后一个 phase 已 ack、没下一 phase 可跑、直接当普通 approve 走
    // （走到这说明用户在最后一个 phase 选了 fork、其实没必要、按普通 approve 兜底）
    const ok = submitPhaseAck(task.id, "approve");
    if (!ok) {
      return errorResponse(
        "agent 已不在等待 ack（可能并发处理 / keepalive 切换）、稍后重试",
        409,
      );
    }
    const newTask = await markPhaseAcked(task.id, ackPhase);
    return new Response(
      JSON.stringify({ ok: true, task: newTask ?? task, fork: false }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // 模型：用户传了就用、没传按旧 model 续（这种走 forkAgent=true 但不换模型也合法、相当于「就想要新 agent」）
  // 但实际上用户没换模型也没换 agent 是默认路径、走到这里说明 forkAgent 显式 true、需要 model
  // 旧 task 不存 model（避免 token 落盘），所以用户必须提供 nextModel 或前端用 settings.model 兜底
  if (!body.nextModel) {
    return errorResponse(
      "fork 时必须提供 nextModel（前端默认用 settings.model）",
      400,
    );
  }
  const newModel = body.nextModel;
  const newApiKey = body.bootArgs!.apiKey;
  const newMcp = body.bootArgs!.mcpServers;

  // i. 标记 fork 中
  markPlanForFork(task.id);
  // ii. cancel 旧 agent
  cancelPlan(task.id);
  // iii. 等旧 run 退出
  const stopped = await waitForPlanToStop(task.id, 10000);
  if (!stopped) {
    // 8 秒内没退出、保险起见标 failed
    console.warn(
      `[phase-ack] task=${task.id} fork: waitForPlanToStop timeout 10s、旧 agent 没干净退出`,
    );
    return errorResponse(
      "旧 agent 收尾超时、未能 fork、请稍后重试或重启任务",
      503,
    );
  }
  // iv. patch 数据库（用 markPhaseAcked 推进 currentPhase 到 nextPhase）
  await markPhaseAcked(task.id, ackPhase);
  const refreshed = await getTask(task.id);
  if (!refreshed) return errorResponse("task 丢失", 500);

  // v. 异步启动新 agent（fire-and-forget、跟 start-workflow 一样）
  void runPlanWorkflow({
    task: refreshed,
    apiKey: newApiKey,
    model: newModel,
    userMcpServers: newMcp,
    fork: {
      fromPhase: nextPhase,
      reason: `用户在 phase ${ackPhase} ack 时选择 fork 新 agent`,
    },
  }).catch((err) => {
    console.error(
      `[phase-ack] task=${task.id} fork: runPlanWorkflow threw:`,
      err,
    );
  });

  // 等一小会让新 run 把 phase_start / phase 状态 patch 到 fs、给前端立刻看到 currentPhase 切了
  // 不 await 启动完成（启动是长 IO、客户端自己通过 SSE 拿）
  return new Response(
    JSON.stringify({ ok: true, task: refreshed, fork: true }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
