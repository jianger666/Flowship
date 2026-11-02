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
 * - 读任务 / 收尾内部抛错（落盘 EIO / 权限 / 内部状态）→ 500 + JSON 体 `{ error, code: "stop_failed" }`
 *   （不是 Next 默认的空 500，前端能弹出原因）；停止本身幂等、用户可以直接再点一次
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

  try {
    const task = await getTask(id);
    if (!task) return errorResponse("not_found", 404);

    const { hadAgent, task: fresh } = await stopTaskAgent(task);

    return new Response(JSON.stringify({ ok: true, hadAgent, task: fresh }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // 不把原始 err.message 回给前端（可能带本机路径）；细节进服务端日志
    console.error(`[POST /api/tasks/${id}/stop] failed`, err);
    return errorResponse("停止失败，请稍后重试（停止是幂等的，可以再点一次）", 500, {
      code: "stop_failed",
    });
  }
};
