/**
 * 停止 task 的共享收尾（单一源）：
 *   1) cancelTaskRun / cancelChatRun：abort SDK Run + 关跨 run 会话
 *   2) cleanupChatTaskState / abortRunningCheck / reapTaskOrphans：清进程级状态与孤儿
 *   3) 非终态（running / awaiting_ack）action 标 cancelled、作废未答 ask
 *   4) runStatus 回 idle + 落停止事件 + publish
 *
 * 调用方：
 *   - /api/tasks/[id]/stop 路由（用户点「停止」按钮）
 *   - /api/tasks/[id]/action-exclude（awaiting_user 态划除时自动收尾——该态顶栏
 *     没有「停止」按钮、409 让用户先停止是死胡同、划除即隐含「这个 action 不要了」）
 */

import { ACTION_LABEL, type Task } from "@/lib/types";
import {
  appendEvent,
  getTask,
  patchAction,
  setTaskRunStatus,
} from "./task-fs";
import {
  abortRunningCheck,
  cancelTaskRun,
  supersedePendingAsks,
} from "./task-runner";
import { pendingStopRequests, publishTaskStreamEvent } from "./task-stream";
import { cancelChatRun } from "./chat-runner";
import { reapTaskOrphans } from "./kill-orphans";
import { cleanupChatTaskState } from "./chat-pending";
import { getTaskWorkRepoPaths } from "./task-worktrees";

/**
 * 停止 task 的活 agent 并把状态归位到 idle（没有活 agent 也幂等）。
 * @param opts.trigger 事件流文案语境：stop=用户点「停止」（默认）；exclude=划除时自动收尾
 * @returns hadAgent = 是否真有活的 run / 会话被停掉；task = 收尾后的最新快照
 */
export const stopTaskAgent = async (
  task: Task,
  opts: { trigger?: "stop" | "exclude" } = {},
): Promise<{ hadAgent: boolean; task: Task }> => {
  const id = task.id;

  // 1) abort SDK Run + 关会话 + 清 ask 登记（先断 agent 再清状态）
  // chat task 的 run 在 chat-runner 的 runningChats、正经 task 在 task-runner 的 runningTasks、
  // 一个 task 只落其一、两个都试、命中即停（cancelTaskRun 命中即短路、不会误触发 cancelChatRun）
  const hadAgent = cancelTaskRun(id) || cancelChatRun(id);
  // 审查发现：idle/awaiting 点停止时 cancelTaskRun 会写入 pendingStopRequests（启动窗口自裁），
  // 若此处不清、标记粘住 → 下次 oneshot 答疑被误当「启动期间停止」杀掉。对齐 DELETE 路由。
  pendingStopRequests.delete(id);
  cleanupChatTaskState(id);
  // V0.8.18：取消正在后台跑的后置 check（杀 lint/typecheck 子进程、丢弃结果、不让它在停止后冒「产出完成」）
  abortRunningCheck(id);

  // V0.6.8：run.cancel() 杀不到 agent 用 shell 拉起的孙子进程（如 `npm run lint`=`ng lint --fix`、
  // 会 orphan 后继续改写整个仓库）。传实际工作目录（隔离 worktree 任务 cwd 在 worktrees/ 下、
  // 不是原仓 repoPaths——审查发现 stop 漏杀孤儿）。
  reapTaskOrphans(getTaskWorkRepoPaths(task));

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
  // chat task 无 action、文案走「对话」语境（「再发消息」不是「推进」）；
  // 划除触发的自动收尾按实际操作措辞、别写成用户点了「停止」（review 提出）
  const actionLabel = current
    ? ` ${ACTION_LABEL[current.type] ?? current.type} action`
    : "";
  const stopText =
    task.mode === "chat"
      ? "用户停止了对话（agent 已中断、可继续发消息）"
      : opts.trigger === "exclude"
        ? `划除时自动停止了${actionLabel}（agent 已中断、可重新「推进」）`
        : `用户停止了${actionLabel}（agent 已中断、可重新「推进」）`;
  const stopEvent = await appendEvent(id, {
    kind: "info",
    actionId: current?.id,
    text: stopText,
  });

  const fresh = (await getTask(id)) ?? task;
  publishTaskStreamEvent(id, { kind: "task", task: fresh });
  if (stopEvent) publishTaskStreamEvent(id, { kind: "event", event: stopEvent });

  return { hadAgent, task: fresh };
};
