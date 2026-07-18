/**
 * GET /api/tasks/[id]/context
 *
 * Chat token 透视（P4.1，对标 GB /context）。
 * 数据来自 run-perf turn-ended 写入的内存表；进程重启后无数据 → totalTokens: null。
 *
 * # 成功
 * { ok: true, context: { totalTokens, breakdown, turnCount, lastTurnAt, compactRecommended } }
 */

import { getTask } from "@/lib/server/task-fs";
import { buildChatContextPayload } from "@/lib/server/chat-context-usage";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const GET = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);
  if (task.mode !== "chat") {
    return errorResponse("仅 chat 模式支持 /context", 409);
  }

  const context = buildChatContextPayload(id);
  return new Response(JSON.stringify({ ok: true, context }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
