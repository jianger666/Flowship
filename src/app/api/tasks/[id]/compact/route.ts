/**
 * POST /api/tasks/[id]/compact
 *
 * Chat 长会话压缩（P4.2，GB full-replace）：摘要 oneshot → 关旧会话 → 新会话注入摘要。
 *
 * # Body
 * { keepHints?: string }
 *
 * # 成功
 * { ok: true, task }
 *
 * # 错误
 * - 409 run 在跑 / 非 chat
 * - 400 无活会话 / 摘要失败
 */

import {
  compactChatSession,
  CompactChatError,
} from "@/lib/server/chat-runner";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  keepHints?: string;
}

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const keepHints =
    typeof body.keepHints === "string" ? body.keepHints.trim() : undefined;

  try {
    const task = await compactChatSession(id, {
      keepHints: keepHints || undefined,
    });
    return new Response(JSON.stringify({ ok: true, task }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    if (err instanceof CompactChatError) {
      return errorResponse(err.message, err.status);
    }
    console.error(`[compact] task=${id} failed:`, err);
    return errorResponse(
      `压缩失败：${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
};
