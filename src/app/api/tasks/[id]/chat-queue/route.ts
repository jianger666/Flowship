/**
 * chat 排队消息的可视化薄路由（D 批次、grok P1「队列可视化」）
 *
 * GET    → 当前排队中的消息列表（不含 in-flight——已交给发送流程、删了也拦不住）
 * DELETE → 按 itemIds 删除还在队里的消息（body: { itemIds: string[] }）
 * PATCH  → 把指定条目置顶到队首（body: { itemId: string }）；保留给单测 / 潜在调用方
 * POST   → action=send_now：取出条目 → stop 清剩余队 → 用该条目起新会话（修「立即发送」）
 *
 * 删除走既有 removeQueuedChatMessages：内部会 settle failed(cancelled) +
 * publish queue_failed——客户端 ledger 经 SSE 自动清对应 pending 占位、无需额外通知。
 */

import { getTask } from "@/lib/server/task-fs";
import {
  listQueuedChatMessages,
  promoteQueuedChatMessage,
  removeQueuedChatMessages,
} from "@/lib/server/chat-queue";
import { sendQueuedChatMessageNow } from "@/lib/server/chat-queue-send-now";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const GET = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  return new Response(
    JSON.stringify({ items: listQueuedChatMessages(id) }),
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

  const idSet = new Set(itemIds);
  const removed = removeQueuedChatMessages(id, (m) => idSet.has(m.itemId));
  return new Response(
    JSON.stringify({ ok: true, removedIds: removed.map((m) => m.itemId) }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

/** 置顶：条目不在队里 → 404（多半刚被 flush 发出） */
export const PATCH = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  let itemId: string;
  try {
    const body = (await req.json()) as { itemId?: unknown };
    if (typeof body.itemId !== "string" || !body.itemId.trim()) {
      return errorResponse("itemId 必须是非空字符串");
    }
    itemId = body.itemId.trim();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }

  const ok = promoteQueuedChatMessage(id, itemId);
  if (!ok) return errorResponse("队列中找不到该消息", 404);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

/**
 * POST send_now：立即发送排队条目（原子编排，见 chat-queue-send-now）。
 * body: { action: "send_now", itemId, bootArgs: { apiKey, model } }
 */
export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  let body: {
    action?: unknown;
    itemId?: unknown;
    bootArgs?: { apiKey?: string; model?: import("@cursor/sdk").ModelSelection };
  };
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

  return sendQueuedChatMessageNow(id, body.itemId, body.bootArgs);
};
