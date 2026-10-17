/**
 * POST /api/tasks/[id]/wait/skip
 *
 * 「跳过等待」——叫醒这个任务里正在睡的 `wait` 工具（状态行「等待中」旁的按钮）。
 * 模型会收到 `[WAIT_SKIPPED]`，随后继续往下做；不是停止，run 照常进行。
 *
 * 为什么是单独的路由而不是复用 /stop：停止会终止整个 run、取消在飞的一切；
 * 跳过只是让一次睡眠提前结束，模型的上下文和后续步骤都还在。
 *
 * # 错误语义
 * - task 不存在 → 404
 * - 当前没有在睡的 wait 也算成功（幂等）：返回 woken=0。典型是用户点的瞬间它刚好到点自己醒了——
 *   这不是错误、也不该弹提示吓人。
 */

import { getTask } from "@/lib/server/task-fs";
import { interruptWaits } from "@/lib/server/session-wait";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const POST = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  const woken = interruptWaits(id, "skip");

  return new Response(JSON.stringify({ ok: true, woken }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
