/**
 * POST /api/tasks/[id]/phase-ack
 *
 * V0.2 workflow 任务：用户在 UI 点「通过」或「补意见再跑」、本路由把动作 ack 给阻塞中的 agent。
 *
 * Body: { action: "approve" | "revise"、feedback?: string、phase?: PhaseId }
 *
 * 行为：
 *   - approve：调 submitPhaseAck(approve) + markPhaseAcked(phase) 推进 task.currentPhase
 *   - revise：调 submitPhaseAck(revise, feedback) + 写一条 user_reply 事件（meta.kind=revise）
 *             phase 状态保持 awaiting_ack（按用户拍板：不抖屏、agent 改完再调 wait_for_user）
 *
 * 失败语义：
 *   - task 不存在 → 404
 *   - task.mode !== "plan" → 409
 *   - hasPending=false 且 task.status 在 awaiting_user/running → 410（僵尸态、当场标 failed）
 *   - hasPending=false 但 task.status 已终态 → 409
 *
 * 跟 chat-reply 路由的差异：
 *   - 解码用户动作（approve/revise）、不是裸文本
 *   - approve 时调 markPhaseAcked 推进 currentPhase + 上一 phase 状态
 *   - revise 时不推进 phase、agent 自己改完 artifact 再调 wait_for_user
 */

import {
  appendEvent,
  getTask,
  patchPhase,
} from "@/lib/server/task-fs";
import {
  hasPending,
  submitPhaseAck,
} from "@/lib/server/chat-mcp";
import { markPhaseAcked } from "@/lib/server/plan-runner";
import { publishChatStreamEvent } from "@/lib/server/chat-runner";
import type { PhaseId } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  action?: "approve" | "revise";
  feedback?: string;
  // 可选：用户期望 ack 的 phase id（防止 race 导致 ack 到错的 phase）
  // 不传时按 task.currentPhase 兜底
  phase?: PhaseId;
}

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
  if (action === "revise" && feedback.length === 0) {
    return errorResponse("revise 必须带 feedback 文本");
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
    `[phase-ack] task=${task.id} action=${action} phase=${ackPhase} feedback=${feedback.slice(0, 60)}`,
  );

  // 1) 先写一条事件、让用户视角立刻看到自己点了什么
  if (action === "approve") {
    // approve 事件由 markPhaseAcked 写（kind=phase_ack）、这里不重复写
  } else {
    // revise：写一条 user_reply 事件、meta 里标 kind=revise + 关联 phase
    await appendEvent(task.id, {
      kind: "user_reply",
      phase: ackPhase,
      text: feedback,
      meta: { kind: "revise", phase: ackPhase },
    });
  }

  // 2) ack agent：把消息塞给被阻塞的 wait_for_user
  const ok = submitPhaseAck(
    task.id,
    action,
    action === "revise" ? feedback : undefined,
  );
  if (!ok) {
    return errorResponse(
      "agent 已不在等待 ack（可能并发处理 / keepalive 切换）、稍后重试",
      409,
    );
  }

  // 3) approve 时推进 phase 状态机
  let updated = task;
  if (action === "approve") {
    const newTask = await markPhaseAcked(task.id, ackPhase);
    if (newTask) updated = newTask;
  } else {
    // revise：保持 awaiting_user、agent 改完会再调 wait_for_user 重新触发 awaiting notifier
    // 不在这里 patch、避免抖屏
    const newTask = await getTask(task.id);
    if (newTask) updated = newTask;
  }

  return new Response(
    JSON.stringify({ ok: true, task: updated }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
