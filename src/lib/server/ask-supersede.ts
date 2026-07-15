/**
 * 作废未了结的 ask_user_request（task / chat runner 共用）
 *
 * 为什么需要（用户实测踩坑、断线重启「多弹窗并发」根因）：
 *   旧 agent 被 cancel / 断线后、它发起的那组 ask 的 token 已失效、永远不会再被 resolve。
 *   但前端只看「ask_user_request 有没有配对的 ask_user_reply / superseded 标记」——
 *   不作废孤儿 ask、会永久 pending：重启后反复复活答题卡。
 *
 * 作废方式：写 info 事件 `meta.supersededAskId=askId`（不补 ask_user_reply——那会让
 *   事件流显示成「你的回答」、语义不对）。
 */

import type { AskUserQuestion } from "@/lib/types";
import { isAskSettled } from "@/lib/ask-pending";
import { getTask } from "./task-fs";
import { writeEventAndPublish } from "./task-stream";

/**
 * 作废 task 下「当前还没被回答的 ask_user_request」。
 *
 * @returns 最近一条被作废的 ask 的 questions（供重启时断点续传）、没有则空数组。
 */
export const supersedePendingAsks = async (
  taskId: string,
  reason: string,
): Promise<AskUserQuestion[]> => {
  const task = await getTask(taskId);
  if (!task) return [];
  // 最近一条未答 ask 的问题（events 正序遍历、后命中的覆盖前面的 = 时间上最近的那组）
  let latestQuestions: AskUserQuestion[] = [];
  for (const ev of task.events) {
    if (ev.kind !== "ask_user_request") continue;
    const askId = typeof ev.meta?.askId === "string" ? ev.meta.askId : null;
    if (!askId) continue;
    // 已被回答 / 已被作废过的跳过（幂等：重复重启不重复写标记）
    if (isAskSettled(task.events, askId)) continue;
    await writeEventAndPublish(taskId, {
      kind: "info",
      actionId: ev.actionId,
      text: `上一组提问因${reason}失效、无需再回答。`,
      meta: { supersededAskId: askId },
    });
    if (Array.isArray(ev.meta?.questions)) {
      latestQuestions = ev.meta.questions as AskUserQuestion[];
    }
  }
  return latestQuestions;
};
