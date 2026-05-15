/**
 * DELETE /api/tasks/[id]/context-docs/[docId]
 *
 * 删一条上下文文档。
 *
 * 行为：
 *   - 找不到对应 docId 不报错、返回最新 task（idempotent）
 *   - 不主动改 task.status、不通知 agent
 */

import { removeContextDoc } from "@/lib/server/task-fs";

interface Ctx {
  params: Promise<{ id: string; docId: string }>;
}

const errorResponse = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const runtime = "nodejs";

export const DELETE = async (_req: Request, { params }: Ctx) => {
  const { id, docId } = await params;
  if (!id || !docId) return errorResponse("缺少 id / docId");
  try {
    const updated = await removeContextDoc(id, docId);
    if (!updated) return errorResponse("not_found", 404);
    return new Response(JSON.stringify({ ok: true, task: updated }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(msg, 400);
  }
};
