/**
 * POST /api/tasks/[id]/context-docs
 *
 * 给任务加一条上下文文档（详情页面板使用）。
 *
 * Body: { title: string; content: string }
 *   - title：用户取的标题、必须 trim 后非空
 *   - content：URL / 路径 / 自由文本、必须 trim 后非空、type 由后端按内容自动推断
 *
 * 返回最新 task（含完整 contextDocs）。
 *
 * 不做的事：
 *   - 不主动改 task.status（用户加上下文不算业务进展、但会 bump updatedAt）
 *   - 不通知 agent run（节奏同步问题暂时由 UI 提示「下次启动 / revise 时生效」处理）
 */

import { addContextDoc } from "@/lib/server/task-fs";
import type { AddContextDocInput } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

const errorResponse = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: Partial<AddContextDocInput>;
  try {
    body = (await req.json()) as Partial<AddContextDocInput>;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";

  if (title.length === 0) return errorResponse("title 不能为空");
  if (content.length === 0) return errorResponse("content 不能为空");
  if (title.length > 100) return errorResponse("title 不能超过 100 字");
  if (content.length > 50_000) {
    // 50K 上限主要防止用户误粘整篇巨长文档进文本框、避免 JSON 持久化负担过大
    return errorResponse("content 不能超过 50000 字");
  }

  try {
    const updated = await addContextDoc(id, { title, content });
    if (!updated) return errorResponse("not_found", 404);
    return new Response(JSON.stringify({ ok: true, task: updated }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(msg, 400);
  }
};
