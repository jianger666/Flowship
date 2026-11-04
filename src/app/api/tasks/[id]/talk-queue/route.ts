/**
 * task 模式待送达队列（与 chat-queue 路由同形：GET 快照 / DELETE 删除 / PUT 编辑 / POST 立即发送）
 *
 * GET    → 快照含 app / group_owner / group_reply（本模块）+ group_question（群模块合并）。
 *          `?full=1` 另带 `texts`：可编辑条目（app 来源）的完整正文 `{ [itemId]: text }`——
 *          快照里的 preview 只有 ≤120 字、拿来编辑会把长消息截断；正文按需取、不塞进每个 SSE 帧。
 * DELETE → 按 itemIds 删除。group_question 的 id 为飞书 message_id，走 removeGroupQuestionFromQueue。
 * PUT    → 原地改一条排队消息的文字（body: { itemId, text }）；位置 / 入队时间 / 附件不变。
 *          只认 app 来源；条目已不在队里（已送出 / 正在送出 / 已删）→ 409 `queue_item_gone`。
 * POST   → action=send_now：立即发送（body: { action: "send_now", itemId }），编排见 task-talk-queue-send-now。
 *          发送所需的 bootArgs（apiKey / model）是入队时随消息存下的，不用再传。
 */

import { getTask } from "@/lib/server/task-fs";
import {
  buildTalkQueueSnapshot,
  listTalkQueueEditTexts,
  removeTalkQueueItems,
  updateTalkQueueItemText,
} from "@/lib/server/task-talk-queue";
import { sendQueuedTalkMessageNow } from "@/lib/server/task-talk-queue-send-now";
import { errorResponse } from "@/lib/server/route-helpers";
import { TALK_QUEUE_EDIT_MAX_CHARS, TALK_QUEUE_GONE_CODE } from "@/lib/talk-queue";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const GET = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  const full = new URL(req.url).searchParams.get("full") === "1";
  return new Response(
    JSON.stringify({
      items: buildTalkQueueSnapshot(id),
      ...(full ? { texts: listTalkQueueEditTexts(id) } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

export const DELETE = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  let itemIds: string[];
  try {
    const body = (await req.json()) as { itemIds?: unknown };
    if (
      !Array.isArray(body.itemIds) ||
      body.itemIds.some((x) => typeof x !== "string")
    ) {
      return errorResponse("itemIds 必须是字符串数组");
    }
    itemIds = body.itemIds as string[];
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  if (itemIds.length === 0) return errorResponse("itemIds 不能为空");

  const removedIds = removeTalkQueueItems(id, itemIds);
  return new Response(
    JSON.stringify({ ok: true, removedIds }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

/** 原地改文字：编辑后仍在原位置排队（body: { itemId, text }）。清空文字只对带图片 / 文件的条允许 */
export const PUT = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  let itemId: string;
  let text: string;
  try {
    const body = (await req.json()) as { itemId?: unknown; text?: unknown };
    if (typeof body.itemId !== "string" || !body.itemId.trim()) {
      return errorResponse("itemId 必须是非空字符串");
    }
    if (typeof body.text !== "string") return errorResponse("text 必须是字符串");
    itemId = body.itemId.trim();
    text = body.text;
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }

  const r = updateTalkQueueItemText(id, itemId, text);
  if (r.ok) {
    return new Response(JSON.stringify({ ok: true, item: r.item }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  switch (r.reason) {
    case "gone":
      return errorResponse("这条消息已经送出或被移除", 409, { code: TALK_QUEUE_GONE_CODE });
    case "not_editable":
      return errorResponse("这类排队消息不支持编辑");
    case "too_long":
      return errorResponse(`text 过长（最多 ${TALK_QUEUE_EDIT_MAX_CHARS} 字）`);
    case "empty":
      return errorResponse("text 不能为空");
  }
};

/** POST send_now：立即发送排队条目（原子编排，见 task-talk-queue-send-now） */
export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  let body: { action?: unknown; itemId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  if (body.action !== "send_now") {
    return errorResponse('action 仅支持 "send_now"');
  }
  if (typeof body.itemId !== "string" || !body.itemId.trim()) {
    return errorResponse("itemId 必须是非空字符串");
  }
  return sendQueuedTalkMessageNow(id, body.itemId);
};
