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
 * # 行为（V0.11：wait 协议退役、send 送达）
 *
 * - approve：acknowledgeAction(approve) 纯服务端落状态（action → completed）、agent 不需要收信号
 * - revise：先 snapshotActionArtifact 旧版本、再 `agent.send([ACTION_ACK revise] + feedback)`
 *   续同一会话让 agent 处理；没有可续接的会话 → 409（用户点重启 / 推进）
 *
 * # 错误语义
 *
 * - task 不存在 → 404
 * - action 不存在 / 已 completed / cancelled / 会话不在 → 409
 */

import { appendEvent, getTask } from "@/lib/server/task-fs";
import { saveImageAttachments } from "@/lib/server/task-artifacts";
import { acknowledgeAction } from "@/lib/server/task-runner";
import { publishTaskStreamEvent } from "@/lib/server/task-stream";
import {
  errorResponse,
  parseAndValidateImages,
} from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  actionId?: string;
  decision?: "approve" | "revise";
  feedback?: string;
  images?: Array<{ data?: string; mimeType?: string; filename?: string }>;
  // V0.11.1：会话恢复凭据（服务重启 / 空闲回收后 revise 靠它 Agent.resume 接回会话）
  bootArgs?: {
    apiKey?: string;
    model?: { id?: string; params?: Array<{ id: string; value: string }> };
    gitHost?: string;
    gitToken?: string;
  };
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

  // V0.11：不再依赖「agent 挂起等待」——approve 纯服务端落状态、revise 由
  // acknowledgeAction 内部校验会话存活（没会话 → 抛错 → 409 提示重启 / 推进）

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
    await acknowledgeAction(task.id, actionId, decision, feedback, imageAbsPaths, {
      apiKey: body.bootArgs?.apiKey?.trim() || undefined,
      model:
        body.bootArgs?.model && typeof body.bootArgs.model.id === "string"
          ? { id: body.bootArgs.model.id, params: body.bootArgs.model.params }
          : undefined,
      gitHost: body.bootArgs?.gitHost?.trim() || undefined,
      gitToken: body.bootArgs?.gitToken?.trim() || undefined,
    });
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
