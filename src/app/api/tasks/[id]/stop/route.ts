/**
 * POST /api/tasks/[id]/stop
 *
 * V0.6.x「停止」——中断当前正在跑 / 等 ack 的 action。
 *
 * 用户选错 action 起跑了、或不想继续当前 action 时点「停止」：
 *   1) cancelTaskRun：abort SDK Run（agent 进程收到 cancel 信号、自行退出）
 *   2) cleanupChatTaskState：清掉未答的 ask 登记等进程级状态
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
import {
  abortRunningCheck,
  cancelTaskRun,
  supersedePendingAsks,
} from "@/lib/server/task-runner";
import { publishTaskStreamEvent } from "@/lib/server/task-stream";
import { cancelChatRun } from "@/lib/server/chat-runner";
import { reapTaskOrphans } from "@/lib/server/kill-orphans";
import { cleanupChatTaskState } from "@/lib/server/chat-pending";
import { errorResponse } from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export const POST = async (_req: Request, { params }: Ctx) => {
  const { id } = await params;

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  // 1) abort SDK Run + 关会话 + 清 ask 登记（先断 agent 再清状态）
  // chat task 的 run 在 chat-runner 的 runningChats、正经 task 在 task-runner 的 runningTasks、
  // 一个 task 只落其一、两个都试、命中即停（cancelTaskRun 命中即短路、不会误触发 cancelChatRun）
  const hadAgent = cancelTaskRun(id) || cancelChatRun(id);
  cleanupChatTaskState(id);
  // V0.8.18：取消正在后台跑的后置 check（杀 lint/typecheck 子进程、丢弃结果、不让它在停止后冒「产出完成」）
  abortRunningCheck(id);

  // V0.6.8：run.cancel() 杀不到 agent 用 shell 拉起的孙子进程（如 `npm run lint`=`ng lint --fix`、
  // 会 orphan 后继续改写整个仓库）。这里主动清理落在本 task repoPaths 里的孤儿 / agent-shell 进程树。
  reapTaskOrphans(task.repoPaths);

  // 2) 所有卡在非终态（running / awaiting_ack）的 action → 标 cancelled（endedAt 自动落）
  //    不只看 currentActionId——它可能已被清成 null（agent error / abandon 后）、导致漏收尾
  const stale = task.actions.filter(
    (a) => a.status === "running" || a.status === "awaiting_ack",
  );
  for (const a of stale) {
    await patchAction(id, a.id, { status: "cancelled" });
  }
  // 作废旧 agent 没答完的孤儿 ask（停止后旧 agent 已断、不清掉前端会弹失效的旧问题弹窗、
  // 用户答了必报错）。停止 = 主动中断、不续传旧问题、只清孤儿。
  await supersedePendingAsks(id, "用户停止");
  // 事件文案用「当前 / 最近一个」非终态 action
  const current =
    (task.currentActionId
      ? task.actions.find((a) => a.id === task.currentActionId)
      : null) ??
    stale[stale.length - 1] ??
    null;

  // 3) runStatus 回 idle
  await setTaskRunStatus(id, "idle");

  // 4) 落事件让用户在事件流看到这次停止
  // chat task 无 action、文案走「对话」语境（「再发消息」不是「推进」）
  const stopText =
    task.mode === "chat"
      ? "用户停止了对话（agent 已中断、可继续发消息）"
      : `用户停止了${
          current ? ` ${ACTION_LABEL[current.type] ?? current.type} action` : ""
        }（agent 已中断、可重新「推进」）`;
  const stopEvent = await appendEvent(id, {
    kind: "info",
    actionId: current?.id,
    text: stopText,
  });

  const fresh = (await getTask(id)) ?? task;
  publishTaskStreamEvent(id, { kind: "task", task: fresh });
  if (stopEvent) publishTaskStreamEvent(id, { kind: "event", event: stopEvent });

  return new Response(JSON.stringify({ ok: true, hadAgent, task: fresh }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
