/**
 * task 模式排队消息「立即发送」server 编排（对齐 chat 的 chat-queue-send-now，但只有「打断重发」一条路径）
 *
 * 为什么只有打断、没有 chat 那条「steer 插话」：
 * task 模式的 agent 跑在 task-runner 的 run 里，其中没有 chat-runner 那套 `run.steer` 的登记表
 * （`rec.currentRun`、canSteerChatRun / registerInflightSteer / message_op 回执），要插话得先给 task-runner
 * 补一整套「当前 run 句柄 + 收下回执 + 失败回退」的基础设施，且 action 状态机（running / awaiting_ack /
 * ackContext）与 steer 的交互没有现成语义（插话算不算「用户在审阅中改需求」？）。这次不做，见 HANDOFF。
 *
 * 流程（乐观注入，先试再停）：
 * 1. 同步取出目标条 + 把 stop 会清掉的来源（app）的**其余排队救出来**（进暂存区、快照里仍显示并标 held，
 *    条数不跳变），并占住该任务的 drain 锁（{@link beginTalkQueueSendNow}）。必须在 stop 之前取：
 *    stop 的清队会把 app 来源整队清掉；
 * 2. **先直接注入**（与 drain 重放同一套选项）。任务空闲 / 在等收尾 / 有未答提问时这一步就成功，**不用停任何东西**；
 * 3. 注入回「agent 还在跑」（task_busy）才 stopTaskAgent，再注入一次（与用户手动「停止 → 再发一句」同一条链路：
 *    action 被标 cancelled、会话关闭，注入端走唤醒续跑）；
 * 4. 无论成败，finally 里把没送出去的（目标条放回队首）+ 救出来的其余条放回队列（{@link endTalkQueueSendNow}）。
 *
 * 撞上**别人**发起的 stop（注入回 phase=stopping）：app 来源的条目按 stop 的清队语义处理——不放回、落「未送达」卡；
 * 群来源（group_owner）照常放回，stop 结束后送达。
 */

import { getChatLifecycle } from "@/lib/server/chat-gate";
import { errorResponse } from "@/lib/server/route-helpers";
import { stopTaskAgent } from "@/lib/server/stop-task";
import {
  TASK_INJECT_BUSY_CODE,
} from "@/lib/server/task-inject-shared";
import { getTask } from "@/lib/server/task-fs";
import {
  handleTaskQuestionInject,
  lifecycleBlockedResponse,
  type TaskQuestionInjectOptions,
} from "@/lib/server/task-question-inject";
import {
  beginTalkQueueSendNow,
  buildReplayOptions,
  classifyReplayConflict,
  endTalkQueueSendNow,
  isStopClearedTalkSource,
  noticeTalkQueueSendNowDropped,
  type TalkQueueStoredItem,
} from "@/lib/server/task-talk-queue";
import { TALK_QUEUE_GONE_CODE } from "@/lib/talk-queue";
import type { ChatLifecyclePhase } from "@/lib/server/chat-gate";
import type { Task } from "@/lib/types";

/** drain 锁被占（定时 drain 正在重放另一条）时，最多等多久再放弃；一次 drain 在忙时只占几十毫秒的读盘 */
export const TALK_SEND_NOW_LOCK_WAIT_MS = 3000;
const LOCK_POLL_MS = 50;

export interface TalkSendNowDeps {
  getTask: (id: string) => Promise<Task | null>;
  inject: (
    id: string,
    rawBody: unknown,
    options: TaskQuestionInjectOptions,
  ) => Promise<Response>;
  stop: (task: Task) => Promise<unknown>;
  getLifecycle: (id: string) => ChatLifecyclePhase | null;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: TalkSendNowDeps = {
  getTask: (id) => getTask(id),
  inject: (id, rawBody, options) => handleTaskQuestionInject(id, rawBody, options),
  stop: (task) => stopTaskAgent(task),
  getLifecycle: (id) => getChatLifecycle(id),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const goneResponse = (): Response =>
  errorResponse("这条消息已经送出或被移除", 409, { code: TALK_QUEUE_GONE_CODE });

const okResponse = (itemId: string): Response =>
  new Response(JSON.stringify({ ok: true, itemId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/**
 * 「立即发送」完整编排。返回：
 * - 200 `{ ok, itemId }`：已送出（可能没停任何东西）；
 * - 409 `code: queue_item_gone`：这条已不在队里（已被 drain 送出 / 被删 / 正在送出）——客户端静默对齐列表；
 * - 其余：注入端的原样错误（目标条已放回队首，其余已放回），客户端弹出原因。
 */
export const sendQueuedTalkMessageNow = async (
  taskId: string,
  itemId: string,
  deps: TalkSendNowDeps = defaultDeps,
): Promise<Response> => {
  const trimmedId = typeof itemId === "string" ? itemId.trim() : "";
  if (!trimmedId) return errorResponse("itemId 必须是非空字符串");

  const task = await deps.getTask(taskId);
  if (!task) return errorResponse("not_found", 404);
  if (task.mode === "chat") {
    return errorResponse("chat 任务的排队走 chat-queue、本路由仅服务 task 模式", 409);
  }
  // 收尾窗口里别动队列：begin 会改队列、finally 再放回，纯属无谓的快照抖动
  const life = deps.getLifecycle(taskId);
  if (life !== null) return lifecycleBlockedResponse(life);

  // 拿 drain 锁：定时 drain 在任务忙时每秒读一次 meta、占锁几十毫秒；撞上了就短等，别让用户为这点巧合重点
  const deadline = Date.now() + TALK_SEND_NOW_LOCK_WAIT_MS;
  let begun = beginTalkQueueSendNow(taskId, trimmedId);
  while (!begun.ok && begun.reason === "drain_busy" && Date.now() < deadline) {
    await deps.sleep(LOCK_POLL_MS);
    begun = beginTalkQueueSendNow(taskId, trimmedId);
  }
  if (!begun.ok) {
    if (begun.reason === "gone") return goneResponse();
    if (begun.reason === "not_allowed") {
      return errorResponse("这类排队消息不支持立即发送", 400);
    }
    return errorResponse("上一条排队消息正在送出、请稍后再点", 409, {
      code: TASK_INJECT_BUSY_CODE,
    });
  }

  const { item, rest } = begun;
  // 放回名单：默认全放回；确认送出 / 被 stop 语义清掉的从这里摘
  let putBack: TalkQueueStoredItem | undefined = item;
  let restToPutBack: readonly TalkQueueStoredItem[] = rest;
  try {
    const attempt = (): Promise<Response> =>
      deps.inject(taskId, item.rawBody, buildReplayOptions(item));

    let res = await attempt();
    if (res.ok) {
      putBack = undefined;
      return okResponse(item.itemId);
    }

    let conflict = await classifyReplayConflict(res);
    if (conflict === "busy") {
      // agent 真在跑：停掉它再发（与手动「停止 → 再发一句」同链路）
      const fresh = await deps.getTask(taskId);
      if (!fresh) return errorResponse("not_found", 404);
      await deps.stop(fresh);
      res = await attempt();
      if (res.ok) {
        putBack = undefined;
        return okResponse(item.itemId);
      }
      conflict = await classifyReplayConflict(res);
    }

    if (conflict === "stopping") {
      // 别人（用户点了停止）正在收尾：app 来源的按 stop 清队语义落「未送达」，不放回
      const dropped: TalkQueueStoredItem[] = [
        ...(isStopClearedTalkSource(item.source) ? [item] : []),
        ...rest.filter((e) => isStopClearedTalkSource(e.source)),
      ];
      if (isStopClearedTalkSource(item.source)) putBack = undefined;
      restToPutBack = rest.filter((e) => !isStopClearedTalkSource(e.source));
      if (dropped.length > 0) await noticeTalkQueueSendNowDropped(taskId, dropped);
    }
    return res;
  } finally {
    endTalkQueueSendNow(taskId, { putBack, rest: restToPutBack });
  }
};
