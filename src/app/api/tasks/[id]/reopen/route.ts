/**
 * POST /api/tasks/[id]/reopen
 *
 * V0.6.12 恢复终态 task：把已合入 / 已放弃（merged / abandoned）的 task 拉回 developing、
 * 重新可推进。给「误 abandon」/「想把终结的 task 重新捡起来继续」留出路——
 * 否则一旦终结、详情页所有操作按钮全隐藏（canAdvance / canFinalize 都含 repoStatus !== 终态）、
 * task 锁死只读、没救。
 *
 * # 行为
 *
 * - 只动 repoStatus → developing；runStatus 保持 idle（没有活 agent、用户后续点「推进」才起 Run）
 * - 不动 action 历史 / artifact / MR 记录
 *
 * # 错误语义
 *
 * - task 不存在 → 404
 * - task 不是终态（developing）→ 400（非终态没有「恢复」一说）
 */

import { errorResponse } from "@/lib/server/route-helpers";
import { getTask } from "@/lib/server/task-fs";
import { reopenTask } from "@/lib/server/task-runner";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const POST = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  try {
    await reopenTask(task.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(message, 400);
  }

  const fresh = await getTask(task.id);
  return new Response(JSON.stringify({ ok: true, task: fresh ?? task }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
