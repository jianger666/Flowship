/**
 * POST /api/tasks/[id]/stop
 *
 * V0.6.x「停止」——中断当前正在跑 / 等 ack 的 action。
 *
 * 用户选错 action 起跑了、或不想继续当前 action 时点「停止」。
 * 收尾逻辑在共享的 `stopTaskAgent`（`lib/server/stop-task.ts`、与 action-exclude
 * 的自动停止共用单一源）：abort Run + 关会话 + 清 ask + action 标 cancelled + idle。
 *
 * 停止 ≠ 删除：action 记录 / artifact 都还在（chip 显示已取消）、需要再「划除」(/action-exclude)。
 *
 * # 错误语义
 * - task 不存在 → 404
 * - 没有活 agent 也允许（幂等：照样把状态归位到 idle）、返回 hadAgent=false
 */

import { getTask } from "@/lib/server/task-fs";
import { stopTaskAgent } from "@/lib/server/stop-task";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const POST = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  const { hadAgent, task: fresh } = await stopTaskAgent(task);

  return new Response(JSON.stringify({ ok: true, hadAgent, task: fresh }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
