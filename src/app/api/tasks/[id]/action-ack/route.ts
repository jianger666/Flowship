/**
 * POST /api/tasks/[id]/action-ack
 *
 * V0.6 ack 入口：用户在 ack dialog 选 approve / revise 当前 action。
 *
 * 替代 V0.5 路由：phase-ack
 *
 * # Body
 *
 * ```
 * {
 *   actionId: string,            // 必填：要 ack 的 action id
 *   decision: "approve" | "revise",
 *   feedback?: string,            // revise 时的修改意见
 *   images?: [{data, mimeType, filename}],  // revise 可携带图片附件
 * }
 * ```
 *
 * # 行为
 *
 * - approve：调 acknowledgeAction(approve)、agent 拿 [ACTION_ACK approve]
 *   → action.status 转 completed
 *   → agent 立刻调 wait_for_user(待命态) 等下一 action
 * - revise：先 snapshotActionArtifact 旧版本、再 acknowledgeAction(revise, feedback)
 *   action.status 保持 running、agent 接着改
 *
 * # 错误语义
 *
 * - task 不存在 → 404
 * - action 不存在 / 已 completed / cancelled → 409
 * - agent 不在等 ack（has no pending）→ 409 / 410
 */

import { hasPending } from "@/lib/server/chat-pending";
import {
  appendEvent,
  getTask,
  setTaskRunStatus,
} from "@/lib/server/task-fs";
import { saveImageAttachments } from "@/lib/server/task-artifacts";
import { acknowledgeAction } from "@/lib/server/task-runner";
import { publishTaskStreamEvent } from "@/lib/server/task-stream";
import {
  errorResponse,
  KEEPALIVE_RACE_RETRY_MS,
  parseAndValidateImages,
  sleep,
} from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  actionId?: string;
  decision?: "approve" | "revise";
  feedback?: string;
  images?: Array<{ data?: string; mimeType?: string; filename?: string }>;
}

const MAX_IMAGES_PER_REVISE = 6;

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const actionId = (body.actionId ?? "").trim();
  if (!actionId) return errorResponse("actionId 必填");

  const decision = body.decision;
  if (decision !== "approve" && decision !== "revise") {
    return errorResponse("decision 必须是 'approve' / 'revise'");
  }
  const feedback = (body.feedback ?? "").trim();

  // approve 不接受 images
  const hasImages = Array.isArray(body.images) && body.images.length > 0;
  if (decision === "approve" && hasImages) {
    return errorResponse("approve 不接受 images（如要带图请改用 revise）");
  }
  const imagesResult = parseAndValidateImages(
    decision === "revise" ? body.images : [],
    MAX_IMAGES_PER_REVISE,
  );
  if (!imagesResult.ok) return imagesResult.errorResponse;
  const images = imagesResult.images;

  if (decision === "revise" && feedback.length === 0 && images.length === 0) {
    return errorResponse("revise 必须带 feedback 文本或图片");
  }

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  // hasPending 检测（V0.3.5 race 兜底、200ms 内 retry 一次）
  let pending = hasPending(task.id);
  if (!pending) {
    await sleep(KEEPALIVE_RACE_RETRY_MS);
    pending = hasPending(task.id);
  }
  if (!pending) {
    if (task.runStatus === "awaiting_user" || task.runStatus === "running") {
      console.warn(
        `[action-ack] task=${task.id} 僵尸态 runStatus=${task.runStatus}、当场标 error`,
      );
      const errorEvent = await appendEvent(task.id, {
        kind: "error",
        actionId,
        text: "Agent 已断开（进程重启或异常退出）、本次 ack 没送到。请点「推进」起新 agent。",
      });
      if (errorEvent) {
        publishTaskStreamEvent(task.id, { kind: "event", event: errorEvent });
      }
      const updated = await setTaskRunStatus(task.id, "error");
      if (updated) publishTaskStreamEvent(task.id, { kind: "task", task: updated });
      return errorResponse("agent 已断开、请点「推进」起新 agent", 410);
    }
    return errorResponse(
      `agent 当前没在等 ack（task.runStatus=${task.runStatus}）`,
      409,
    );
  }

  // revise 带图：先落盘
  // - imageAbsPaths：给 agent（绝对路径）
  // - savedImages：完整 meta、写进 user_reply 事件给前端渲染缩略图
  let imageAbsPaths: string[] | undefined;
  let savedImages:
    | Awaited<ReturnType<typeof saveImageAttachments>>
    | undefined;
  if (images.length > 0) {
    try {
      savedImages = await saveImageAttachments(task.id, images);
      imageAbsPaths = savedImages.map((s) => s.absPath);
    } catch (err) {
      return errorResponse(
        `图片处理失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    `[action-ack] task=${task.id} actionId=${actionId} decision=${decision} feedback=${feedback.slice(0, 60)} images=${imageAbsPaths?.length ?? 0}`,
  );

  // revise 时先写一条 user_reply 事件（让用户视角立刻看到自己的反馈）
  if (decision === "revise") {
    const meta: Record<string, unknown> = { kind: "revise" };
    // 图存 meta.images（完整对象）——前端读 meta.images 渲染缩略图、不是 imagePaths（V0.6.12 修）
    if (savedImages && savedImages.length > 0) {
      meta.images = savedImages;
    }
    const fallbackText = imageAbsPaths && imageAbsPaths.length > 0 ? "(用户附了图片)" : "";
    const replyEvent = await appendEvent(task.id, {
      kind: "user_reply",
      actionId,
      text: feedback || fallbackText,
      meta,
    });
    if (replyEvent) {
      publishTaskStreamEvent(task.id, { kind: "event", event: replyEvent });
    }
  }

  try {
    await acknowledgeAction(task.id, actionId, decision, feedback, imageAbsPaths);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(message, 409);
  }

  const fresh = await getTask(task.id);
  return new Response(
    JSON.stringify({ ok: true, task: fresh ?? task }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
