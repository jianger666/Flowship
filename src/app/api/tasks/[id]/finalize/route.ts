/**
 * POST /api/tasks/[id]/finalize
 *
 * V0.6 终态控制：用户在 ack dialog（或 task 详情页菜单）选「task 合入」/「abandon」、本路由把 task 关掉。
 *
 * # Body
 *
 * ```
 * {
 *   finalStatus: "merged" | "abandoned",
 *   reason?: string,    // 附加文本（事件流留痕、给 agent 看的提示）
 * }
 * ```
 *
 * # 行为
 *
 * - finalStatus=merged: agent 拿 [TASK_DONE] 退出、repoStatus=merged + runStatus=idle
 * - finalStatus=abandoned: agent 拿 [TASK_ABANDONED] 退出、repoStatus=abandoned + runStatus=idle
 *
 * # 错误语义
 *
 * - task 不存在 → 404
 * - finalStatus 非法 → 400
 * - 已合入再 abandoned / 已放弃再 merged（陈旧标签页误点）→ 409；同目标重复 finalize 不拦（幂等补清理）
 * - 没活 agent pending：不算错、直接 patch（用户从终态 abandon 用、agent 早已退）
 */

import { errorResponse } from "@/lib/server/route-helpers";
import { getTask } from "@/lib/server/task-fs";
import { finalizeTask, TaskTerminalConflictError } from "@/lib/server/task-runner";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  finalStatus?: "merged" | "abandoned";
  reason?: string;
}

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const finalStatus = body.finalStatus;
  if (finalStatus !== "merged" && finalStatus !== "abandoned") {
    return errorResponse("finalStatus 必须是 'merged' / 'abandoned'");
  }
  const reason = (body.reason ?? "").trim() || undefined;

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  console.log(
    `[finalize] task=${task.id} finalStatus=${finalStatus} reason=${reason ?? "<none>"}`,
  );

  try {
    await finalizeTask(task.id, finalStatus, reason);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 已合入 / 已放弃又收到相反的终态（陈旧标签页误点）= 状态冲突，不是请求格式错 → 409（R14 Q7a-01）
    return errorResponse(message, err instanceof TaskTerminalConflictError ? 409 : 400);
  }

  const fresh = await getTask(task.id);
  return new Response(
    JSON.stringify({ ok: true, task: fresh ?? task }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
