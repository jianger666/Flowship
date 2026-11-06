/**
 * /api/tasks/[id]/requirement-group/streaming
 *
 * PUT：设置本任务「群答疑回复是否流式」的任务级覆盖（需求群弹窗里的开关）。
 *   Body: { streaming: boolean | null }
 *     true / false = 这个任务自己的选择，盖过设置页的全局「流式回复」；
 *     null = 清掉覆盖、跟随全局。
 *   成功: { ok: true, task }（hydrate 后的最新任务，调用方直接刷 UI）
 *   400 body 不对（streaming 必须是布尔或 null，缺省 / 其它类型一律拒——不猜）；404 任务不存在。
 *
 * 只管群里的回复；飞书私聊（单聊）的流式只看全局开关。
 */

import { setTaskGroupStreaming } from "@/lib/server/task-fs";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const PUT = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON", 400, { code: "invalid_input" });
  }
  const streaming = (body as { streaming?: unknown } | null)?.streaming;
  if (streaming !== true && streaming !== false && streaming !== null) {
    return errorResponse("streaming 必须是 true / false / null", 400, {
      code: "invalid_input",
    });
  }
  try {
    const task = await setTaskGroupStreaming(id, streaming);
    if (!task) return errorResponse("not_found", 404);
    return new Response(JSON.stringify({ ok: true, task }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`[requirement-group/streaming] task=${id} 失败:`, err);
    return errorResponse(err instanceof Error ? err.message : String(err), 500);
  }
};
