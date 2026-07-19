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
 * - finalizing/deleting/stopping 在飞、或 terminal cleanup executing → 409
 *   （route 不写 developing、不 prewarm）
 */

import { errorResponse } from "@/lib/server/route-helpers";
import { getTask } from "@/lib/server/task-fs";
import {
  prewarmTaskWorkspace,
  reopenTask,
  TaskCleanupInProgressError,
} from "@/lib/server/task-runner";

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
    // terminal cleanup executing、或 lifecycle 互斥（含 DELETE deleting）→ 409
    // 注意：此处直接 return，下方 prewarm / 写 developing 都不会执行
    if (err instanceof TaskCleanupInProgressError) {
      return errorResponse(err.message, 409);
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(message, 400);
  }

  // v1.1.x 提速：终结时 worktree 已清、重开后首推进要付重建成本——后台预热（fire-and-forget）
  // 仅 reopenTask 成功后才走；409 路径绝不 prewarm
  prewarmTaskWorkspace(task.id);

  const fresh = await getTask(task.id);
  return new Response(JSON.stringify({ ok: true, task: fresh ?? task }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
