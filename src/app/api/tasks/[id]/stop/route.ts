/**
 * POST /api/tasks/[id]/stop
 *
 * V0.6.x「停止」——中断当前正在跑 / 等 ack 的 action。
 *
 * 用户选错 action 起跑了、或不想继续当前 action 时点「停止」：
 *   1) cancelTaskRun：abort SDK Run（agent 进程收到 cancel 信号、自行退出）
 *   2) cleanupChatTaskState：清掉 pending 的 wait-ack long-poll、不留悬挂 promise
 *   3) 当前 running / awaiting_ack 的 action 标 cancelled（endedAt 自动落）
 *   4) runStatus 回 idle——用户可重新「推进」起新 Run
 *
 * 停止 ≠ 删除：action 记录 / artifact 都还在（chip 显示已取消）、需要再「划除」(/action-exclude)。
 *
 * # 错误语义
 * - task 不存在 → 404
 * - 没有活 agent 也允许（幂等：照样把状态归位到 idle）、返回 hadAgent=false
 */

import { ACTION_LABEL } from "@/lib/types";
import {
  appendEvent,
  getTask,
  patchAction,
  setTaskRunStatus,
} from "@/lib/server/task-fs";
import { cancelTaskRun, publishTaskStreamEvent } from "@/lib/server/task-runner";
import { cleanupChatTaskState } from "@/lib/server/chat-mcp";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const POST = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  // 1) abort SDK Run + 清 pending wait-ack（先断 agent 再清 pending）
  const hadAgent = cancelTaskRun(id);
  cleanupChatTaskState(id);

  // 2) 当前 action 若在跑 / 等 ack → 标 cancelled（endedAt 自动落）
  const current = task.currentActionId
    ? task.actions.find((a) => a.id === task.currentActionId) ?? null
    : null;
  if (
    current &&
    (current.status === "running" || current.status === "awaiting_ack")
  ) {
    await patchAction(id, current.id, { status: "cancelled" });
  }

  // 3) runStatus 回 idle
  await setTaskRunStatus(id, "idle");

  // 4) 落事件让用户在事件流看到这次停止
  const labelBit = current ? ` ${ACTION_LABEL[current.type]} action` : "";
  const evented = await appendEvent(id, {
    kind: "info",
    actionId: current?.id,
    text: `用户停止了${labelBit}（agent 已中断、可重新「推进」）`,
  });

  const fresh = evented ?? (await getTask(id)) ?? task;
  publishTaskStreamEvent(id, { kind: "task", task: fresh });
  const last = evented?.events[evented.events.length - 1];
  if (last) publishTaskStreamEvent(id, { kind: "event", event: last });

  return new Response(JSON.stringify({ ok: true, hadAgent, task: fresh }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
