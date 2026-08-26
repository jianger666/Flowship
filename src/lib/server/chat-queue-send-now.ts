/**
 * 排队消息「立即发送」server 编排
 *
 * 旧客户端路径：promote 置顶 → stopTask 指望 flush 发队首。
 * 但 stopTaskAgent 会 failQueuedItems 清整队（含刚置顶那条）→ 永远发不出去。
 *
 * 正确时序：先 take 出目标条 → 再 stop（清剩余队 + 关会话）→ 用取出条目起新会话。
 * 注入语义对齐 chat-inject 的「队列优先启动」：agentText 已拼好、skipPersistEvent 透传。
 */

import type { ModelSelection } from "@cursor/sdk";

import { getTask, setTaskRunStatus } from "@/lib/server/task-fs";
import {
  captureChatCheckpoint,
  persistCheckpointForReply,
  type CaptureCheckpointResult,
} from "@/lib/server/chat-checkpoint";
import {
  beginChatQueueInFlight,
  endChatQueueInFlight,
  enqueueChatMessageFront,
  getChatQueueGeneration,
  isMessageOperationTerminal,
  markMessagePersisted,
  settleMessageFailed,
  takeQueuedChatMessage,
  type QueuedChatMsg,
} from "@/lib/server/chat-queue";
import {
  getChatLifecycle,
  isChatRewindInProgress,
  isChatStartLeaseValid,
  releaseChatStart,
  tryReserveChatStart,
} from "@/lib/server/chat-gate";
import {
  forceClearChatRun,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
  waitForChatToStop,
} from "@/lib/server/chat-runner";
import { stopTaskAgent } from "@/lib/server/stop-task";
import {
  PERSIST_FAIL_RETRY_MESSAGE,
  publishTaskStreamEvent,
  writeUserEventAndPublishStrict,
} from "@/lib/server/task-stream";
import { checkUpdatePendingRestart } from "@/lib/server/update-pending";
import { errorResponse, isValidModel } from "@/lib/server/route-helpers";
import type { Task } from "@/lib/types";

export type SendNowBootArgs = {
  apiKey: string;
  model: ModelSelection;
};

/** stop 后等旧 Run 异步收尾摘表的窗口；超时强清（对齐 chat-inject 懒重启口径） */
const CHAT_SEND_NOW_STOP_TIMEOUT_MS = 5000;

/**
 * 用已取出的 QueuedChatMsg 起新会话（对齐 chat-inject 队列优先启动）。
 * 调用方须已完成 take + stop；本函数假定 runStatus 已 idle、无存活会话。
 */
export const startChatFromQueuedMessage = async (
  taskId: string,
  head: QueuedChatMsg,
  bootArgs: SendNowBootArgs,
): Promise<Response> => {
  const task = await getTask(taskId);
  if (!task) return errorResponse("not_found", 404);
  if (task.mode !== "chat") {
    return errorResponse(
      `task.mode=${task.mode ?? "task"} 不是 chat、本路由仅服务 chat 模式`,
      409,
    );
  }

  if (isChatRewindInProgress(taskId)) {
    // 取出的条还没发出——塞回，避免用户消息丢
    enqueueChatMessageFront(taskId, head);
    return errorResponse("正在回退到检查点、完成后再发", 409);
  }

  const lifecycle = getChatLifecycle(taskId);
  if (lifecycle === "stopping") {
    enqueueChatMessageFront(taskId, head);
    return errorResponse("正在停止对话、请稍后重发", 409);
  }
  if (lifecycle === "deleting") {
    settleMessageFailed(taskId, head.itemId, "deleted");
    return errorResponse("任务正在删除", 409);
  }

  const pendingRestartMsg = await checkUpdatePendingRestart();
  if (pendingRestartMsg) {
    enqueueChatMessageFront(taskId, head);
    return errorResponse(pendingRestartMsg, 409);
  }

  // stop 后理论上无会话；若仍有（race）→ 塞回等 flush，勿双开
  if (hasChatSession(taskId)) {
    enqueueChatMessageFront(taskId, head);
    return errorResponse("会话仍在、请稍后重试立即发送", 409);
  }

  const startToken = tryReserveChatStart(taskId);
  if (startToken === null) {
    enqueueChatMessageFront(taskId, head);
    return errorResponse("正在启动会话、请稍后重试", 409);
  }

  const leaseAbortedResponse = (): Response =>
    errorResponse("对话已被停止或任务已删除、本条消息未发送，请重新发送", 409);

  let agentStarted = false;
  beginChatQueueInFlight(taskId, head.itemId);
  const genAtStart = getChatQueueGeneration(taskId);

  /** generation 未变才塞回；已清队 / 已终态则只收尾 in-flight */
  const requeueIfSameGen = (): void => {
    if (getChatQueueGeneration(taskId) !== genAtStart) {
      endChatQueueInFlight(taskId);
      return;
    }
    if (isMessageOperationTerminal(taskId, head.itemId)) {
      endChatQueueInFlight(taskId);
      return;
    }
    enqueueChatMessageFront(taskId, head);
    endChatQueueInFlight(taskId);
  };

  const failOrRequeue = (): void => {
    if (
      getChatQueueGeneration(taskId) !== genAtStart &&
      !isMessageOperationTerminal(taskId, head.itemId)
    ) {
      settleMessageFailed(taskId, head.itemId, "stopped");
      endChatQueueInFlight(taskId);
      return;
    }
    requeueIfSameGen();
  };

  try {
    if (!isChatStartLeaseValid(taskId, startToken)) {
      requeueIfSameGen();
      return leaseAbortedResponse();
    }

    let firstMessageEventId: string | undefined;
    let replyEventPersisted = false;

    if (head.skipPersistEvent) {
      // 入队方已落过 user_reply：不落事件、不打 checkpoint，直接以其内容起会话
      markMessagePersisted(taskId, head.itemId);
      replyEventPersisted = true;
    } else {
      let capture: CaptureCheckpointResult = {
        ok: false,
        repoSnapshots: [],
        elapsedMsByRepo: {},
        warnings: [],
      };
      if (task.repoPaths.length > 0) {
        capture = await captureChatCheckpoint(task.repoPaths);
      }
      if (!isChatStartLeaseValid(taskId, startToken)) {
        requeueIfSameGen();
        return leaseAbortedResponse();
      }

      const meta: Record<string, unknown> = { ...(head.extraMeta ?? {}) };
      if (head.savedImages && head.savedImages.length > 0) {
        meta.images = head.savedImages;
      }
      if (head.attachmentMetas && head.attachmentMetas.length > 0) {
        meta.attachments = head.attachmentMetas;
      }
      if (capture.ok) meta.checkpointed = true;
      meta.queueItemId = head.itemId;

      let replyEvent;
      try {
        replyEvent = await writeUserEventAndPublishStrict(taskId, {
          kind: "user_reply",
          text: head.displayText,
          meta,
        });
      } catch (persistErr) {
        console.error(
          `[chat-queue-send-now] 落盘失败 task=${taskId}:`,
          persistErr,
        );
        requeueIfSameGen();
        return errorResponse(PERSIST_FAIL_RETRY_MESSAGE, 500);
      }
      if (!replyEvent) {
        requeueIfSameGen();
        return leaseAbortedResponse();
      }
      replyEventPersisted = true;
      markMessagePersisted(taskId, head.itemId);
      if (capture.ok) {
        await persistCheckpointForReply(taskId, replyEvent.id, capture);
      }
      firstMessageEventId = replyEvent.id;
    }

    // skipPersist 路径也要在 fire 前复查 lease
    if (!isChatStartLeaseValid(taskId, startToken)) {
      if (replyEventPersisted) failOrRequeue();
      else requeueIfSameGen();
      return leaseAbortedResponse();
    }

    const runningTask = await setTaskRunStatus(taskId, "running");
    if (!runningTask || !isChatStartLeaseValid(taskId, startToken)) {
      failOrRequeue();
      return leaseAbortedResponse();
    }
    publishTaskStreamEvent(taskId, { kind: "task", task: runningTask });

    if (!isChatStartLeaseValid(taskId, startToken)) {
      failOrRequeue();
      return leaseAbortedResponse();
    }

    // P0：落盘锚点还在 → 优先 Agent.resume 续接原会话（停止 / 立即发送不丢上下文），
    // 失败（无锚点 / 提供方不一致 / resume 抛错）降级下面既有新会话路径。
    // 复用本链 startToken——resume 内部不再自行预约、也不代释放（finally 统一放）。
    if (task.sessionAgentId && !hasChatSession(taskId)) {
      const claimedInstanceId = await resumeChatSession(runningTask, bootArgs, {
        claimRun: true,
        startToken,
      });
      if (claimedInstanceId !== null) {
        const sent = await sendChatMessage(
          runningTask,
          head.agentText,
          head.imageAbsPaths,
          head.attachmentAbsPaths?.length ? head.attachmentAbsPaths : undefined,
          { ownerInstanceId: claimedInstanceId },
        );
        if (sent === "sent") {
          agentStarted = true;
          endChatQueueInFlight(taskId);
          const fresh = await getTask(taskId);
          return new Response(
            JSON.stringify({
              ok: true,
              sentNow: true,
              resumed: true,
              itemId: head.itemId,
              task: fresh ?? runningTask,
            }),
            { status: 202, headers: { "Content-Type": "application/json" } },
          );
        }
        // cancelled / owner_invalid：claim 又被用户停止摘除 / 实例被换——终态，
        // 消息按 stopped 收尾、绝不降级新会话重放（AI 会在「已停止」后复述）。
        if (sent === "cancelled" || sent === "owner_invalid") {
          settleMessageFailed(taskId, head.itemId, "stopped");
          endChatQueueInFlight(taskId);
          return leaseAbortedResponse();
        }
        // busy / no_session / send_failed → 降级起新会话。owner 场景的 busy
        // 实际只可能来自 rewind 门闩（resume 成功返回时 rec.agent 必已就位、
        // 无冷启动占位记录）；无论哪种原因，只要会话仍挂在表内就必须强清（保锚点）——
        // 否则下面 runChatSession 入口见 runningChats.has 会把消息改入队自吞、
        // 且无人在跑永久悬空（rewind 竞态下入口门闩会拒绝、消息走 failOrRequeue 兜底）。
        // send_failed 内部已关会话，此处幂等。
        if (hasChatSession(taskId)) {
          forceClearChatRun(taskId, { keepPersisted: true });
        }
      }
    }

    // agentText 已是拼装好的最终文本（含 skill 指引）——不再套一层拼装
    const sessionPromise = runChatSession({
      task: runningTask,
      apiKey: bootArgs.apiKey,
      model: bootArgs.model,
      firstMessage: {
        text: head.agentText,
        imagePaths: head.imageAbsPaths,
        attachmentPaths: head.attachmentAbsPaths,
      },
      firstMessageEventId,
      startToken,
      clientItemId: head.itemId,
    });
    sessionPromise.catch((err) => {
      console.error(
        `[chat-queue-send-now] runChatSession task=${taskId} failed:`,
        err,
      );
    });

    await Promise.resolve();
    if (isMessageOperationTerminal(taskId, head.itemId)) {
      endChatQueueInFlight(taskId);
      return leaseAbortedResponse();
    }
    if (isChatRunActive(taskId)) {
      agentStarted = true;
      endChatQueueInFlight(taskId);
    } else {
      failOrRequeue();
      return leaseAbortedResponse();
    }

    const fresh = await getTask(taskId);
    return new Response(
      JSON.stringify({
        ok: true,
        sentNow: true,
        itemId: head.itemId,
        task: fresh ?? runningTask,
      }),
      { status: 202, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    if (!agentStarted) failOrRequeue();
    throw err;
  } finally {
    releaseChatStart(taskId, startToken);
  }
};

/** 可注入依赖——单测验 take → stop → start 顺序，不碰真实 stop/SDK */
export type SendNowDeps = {
  take: typeof takeQueuedChatMessage;
  stop: (task: Task) => Promise<unknown>;
  start: typeof startChatFromQueuedMessage;
  getTask: typeof getTask;
};

const defaultDeps: SendNowDeps = {
  take: takeQueuedChatMessage,
  stop: stopTaskAgent,
  start: startChatFromQueuedMessage,
  getTask,
};

/**
 * 「立即发送」完整编排：校验 bootArgs → take → stop → 注入起会话。
 */
export const sendQueuedChatMessageNow = async (
  taskId: string,
  itemId: string,
  bootArgs: { apiKey?: string; model?: ModelSelection } | undefined,
  deps: SendNowDeps = defaultDeps,
): Promise<Response> => {
  // 缺凭据先于取队——避免无意义改队列状态
  if (!bootArgs || typeof bootArgs.apiKey !== "string") {
    return errorResponse("缺 bootArgs.apiKey、起新会话必传");
  }
  if (!isValidModel(bootArgs.model)) {
    return errorResponse("bootArgs.model 非法");
  }
  const validated: SendNowBootArgs = {
    apiKey: bootArgs.apiKey,
    model: bootArgs.model,
  };

  const trimmedId = typeof itemId === "string" ? itemId.trim() : "";
  if (!trimmedId) {
    return errorResponse("itemId 必须是非空字符串");
  }

  const task = await deps.getTask(taskId);
  if (!task) return errorResponse("not_found", 404);
  if (task.mode !== "chat") {
    return errorResponse(
      `task.mode=${task.mode ?? "task"} 不是 chat、本路由仅服务 chat 模式`,
      409,
    );
  }

  // 关键：取出必须在 stop 之前，否则 failQueuedItems 会把目标条一起作废
  const taken = deps.take(taskId, trimmedId);
  if (!taken) return errorResponse("队列中找不到该消息", 404);

  try {
    await deps.stop(task);
  } catch (err) {
    // stop 失败：塞回，避免「已取出却未发出」
    enqueueChatMessageFront(taskId, taken);
    throw err;
  }

  // stop 的 cancel 对活跃 Run 是 fire-and-forget、旧 Run 异步收尾才摘表——
  // 不等它真退，start 里的 hasChatSession 防御检查必然撞 409「会话仍在」
  // （pi 后端 abort→settle 链路更长、必现）。对齐 chat-inject 懒重启：等真退、
  // 超时强清继续。keepPersisted：锚点留给下面的 resume 续接路径。
  const stoppedCleanly = await waitForChatToStop(
    taskId,
    CHAT_SEND_NOW_STOP_TIMEOUT_MS,
  );
  if (!stoppedCleanly) {
    console.warn(
      `[chat-queue-send-now] task=${taskId} 旧会话没在 ${CHAT_SEND_NOW_STOP_TIMEOUT_MS}ms 内退、强清继续`,
    );
    forceClearChatRun(taskId, { keepPersisted: true });
  }

  return deps.start(taskId, taken, validated);
};
