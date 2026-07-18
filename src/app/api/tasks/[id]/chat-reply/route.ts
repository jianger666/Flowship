/**
 * POST /api/tasks/[id]/chat-reply
 *
 * 业务逻辑在 `chat-inject.ts`（飞书桥接复用同一入口，行为零漂移）。
 */

import { handleChatReplyInject } from "@/lib/server/chat-inject";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  return handleChatReplyInject(id, body as Parameters<typeof handleChatReplyInject>[1]);
};
