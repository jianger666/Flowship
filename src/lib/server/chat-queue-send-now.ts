/**
 * 排队消息「立即发送」server 编排
 *
 * 两条路径（先试第一条）：
 *
 * 1. **steer 插话**（Cursor 本地 run 支持）：不停止、不重开会话，把消息直接插进正在跑的
 *    这一轮——AI 在当前步骤结束后读到、转向（Codex / Cursor IDE 的行为）。
 *    先落 user_reply 再异步 steer，HTTP 立即 202：`run.steer()` 要等「这一轮真收下」才
 *    resolve，主 AI 卡在长工具里时可能挂很久，结果走 message_op 推送收尾。
 * 2. **打断重发**（回退路径：pi 后端 / 冷启动占位 / 收尾空窗等不能 steer 时）：
 *    旧客户端 promote 置顶 → stopTask 指望 flush 发队首，但 stopTaskAgent 会
 *    failQueuedItems 清整队（含刚置顶那条）→ 永远发不出去。
 *    正确时序：先 take 出目标条 → 再 stop（清剩余队 + 关会话）→ 用取出条目起新会话。
 *    注入语义对齐 chat-inject 的「队列优先启动」：agentText 已拼好、skipPersistEvent 透传。
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
  drainRemainingChatQueue,
  emitQueuedMessageFlushed,
  endChatQueueInFlight,
  enqueueChatMessageFront,
  enqueueChatMessagesFront,
  getChatQueueGeneration,
  getChatSystemCloseMark,
  isMessageOperationTerminal,
  markMessagePersisted,
  settleMessageFailed,
  settleMessageHandedOff,
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
  canSteerChatRun,
  composeChatPrompt,
  detachChatForegroundSubagents,
  flushChatAssistantBuffer,
  flushChatQueue,
  forceClearChatRun,
  hasChatSession,
  isChatRunActive,
  registerInflightSteer,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
  steerChatRun,
  waitForChatToStop,
  type SteerChatOpts,
  type SteerChatResult,
} from "@/lib/server/chat-runner";
import { interruptWaits } from "@/lib/server/session-wait";
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

type PersistReplyResult =
  | { ok: true }
  | { ok: false; reason: "persist_failed" | "task_gone" };

/**
 * 把取出的排队条落成 user_reply（含 checkpoint）——steer 路径专用：
 * 消息要先有气泡、再交给正在跑的 run，对齐 flushChatQueue 的「先落盘再送」。
 * skipPersistEvent（入队方已落过）只推进 operation 到 persisted。
 */
const persistQueuedUserReply = async (
  task: Task,
  head: QueuedChatMsg,
): Promise<PersistReplyResult> => {
  const taskId = task.id;
  if (head.skipPersistEvent) {
    markMessagePersisted(taskId, head.itemId);
    return { ok: true };
  }
  let capture: CaptureCheckpointResult = {
    ok: false,
    repoSnapshots: [],
    elapsedMsByRepo: {},
    warnings: [],
  };
  if (task.repoPaths.length > 0) {
    capture = await captureChatCheckpoint(task.repoPaths);
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
  } catch (err) {
    console.error(`[chat-queue-send-now] steer 落盘失败 task=${taskId}:`, err);
    return { ok: false, reason: "persist_failed" };
  }
  if (!replyEvent) return { ok: false, reason: "task_gone" };
  markMessagePersisted(taskId, head.itemId);
  if (capture.ok) {
    await persistCheckpointForReply(taskId, replyEvent.id, capture);
  }
  return { ok: true };
};

/** steer 路径的可注入依赖——单测不碰真实 SDK / 落盘 */
export type SteerSendNowDeps = {
  canSteer: (taskId: string) => boolean;
  /** 插话前先把 AI 的半截回复落盘（保事件顺序） */
  flushAssistant: (taskId: string) => Promise<void>;
  persistReply: (task: Task, head: QueuedChatMsg) => Promise<PersistReplyResult>;
  steer: (
    taskId: string,
    prompt: string,
    opts?: SteerChatOpts,
  ) => Promise<SteerChatResult>;
  /**
   * 用户插话时把主 AI 正在前台等的子代理转后台（它阻塞的工具调用立刻返回，steer 才能马上被读到）。
   * 返回转了几个。缺省 = 不转。
   */
  detachForeground?: (taskId: string) => number;
  /**
   * 用户插话时把主 AI 正在睡的 `wait` 叫醒（同理：它阻塞在工具调用里，steer 要等它睡完才读得到）。
   * 返回叫醒了几个。缺省 = 不叫。
   */
  interruptWaits?: (taskId: string) => number;
  isRunActive: (taskId: string) => boolean;
  hasSession: (taskId: string) => boolean;
  flushQueue: (taskId: string) => Promise<void>;
  /**
   * take 之后立刻把这条消息登记成「steer 在飞」（返回注销函数）——覆盖 take → steerChatRun 起手之间的 await 空窗，
   * 让 error 收尾清队时看得见它（第八轮 L5-01）。缺省（旧单测）= 不提前登记，行为与改动前一致。
   */
  registerInflight?: (
    taskId: string,
    item: { itemId: string; displayText: string },
  ) => () => void;
};

const defaultSteerDeps: SteerSendNowDeps = {
  canSteer: canSteerChatRun,
  flushAssistant: flushChatAssistantBuffer,
  persistReply: persistQueuedUserReply,
  registerInflight: registerInflightSteer,
  steer: steerChatRun,
  detachForeground: detachChatForegroundSubagents,
  interruptWaits: (taskId) => interruptWaits(taskId, "steer"),
  isRunActive: isChatRunActive,
  hasSession: hasChatSession,
  flushQueue: flushChatQueue,
};

/** 可注入依赖——单测验 take → stop → start 顺序，不碰真实 stop/SDK */
export type SendNowDeps = {
  take: typeof takeQueuedChatMessage;
  stop: (task: Task) => Promise<unknown>;
  start: typeof startChatFromQueuedMessage;
  getTask: typeof getTask;
  /** steer 插话路径；缺省（旧单测）= 不 steer、永远走打断重发 */
  steer?: SteerSendNowDeps;
  /** 取剩余队（默认真实实现；单测可 mock 验“其余排队保留”） */
  drainRest?: typeof drainRemainingChatQueue;
  /**
   * 塞回剩余队（默认真实实现；单测可 mock 断言顺序）。
   * afterItemId = 本次「立即发送」的目标条：start 失败时它已被放回队首，其余要跟在它后面
   */
  requeueRest?: (
    taskId: string,
    rest: QueuedChatMsg[],
    afterItemId?: string,
  ) => void;
};

/**
 * 默认塞回：整批按原顺序塞队首（enqueueChatMessagesFront）。
 * 以前逐条 enqueueChatMessage 且无视返回值（BE2-01）：窗口内又来 2 条以上新消息、队列又将满时，
 * 塞回的老消息被 `full` 拒掉——已回 202 的消息静默丢失、留下幽灵「排队中」气泡；
 * 而且是 append，老消息还排到了窗口内新消息后面。
 * afterItemId：start 失败时目标条已放回队首，其余应跟在它后面（见 enqueueChatMessagesFront）。
 */
const defaultRequeueRest = (
  taskId: string,
  rest: QueuedChatMsg[],
  afterItemId?: string,
): void => {
  const { requeued, skipped } = enqueueChatMessagesFront(
    taskId,
    rest.map((m) => ({
      itemId: m.itemId,
      agentText: m.agentText,
      displayText: m.displayText,
      imageAbsPaths: m.imageAbsPaths,
      savedImages: m.savedImages,
      attachmentAbsPaths: m.attachmentAbsPaths,
      attachmentMetas: m.attachmentMetas,
      enqueuedAt: m.enqueuedAt,
      skipPersistEvent: m.skipPersistEvent,
      extraMeta: m.extraMeta,
    })),
    { afterItemId },
  );
  if (skipped > 0) {
    console.warn(
      `[chat-queue-send-now] task=${taskId} 塞回其余排队：${requeued} 条已塞回、${skipped} 条已在队里 / 已终态而跳过`,
    );
  }
};

const defaultDeps: SendNowDeps = {
  take: takeQueuedChatMessage,
  stop: stopTaskAgent,
  start: startChatFromQueuedMessage,
  getTask,
  steer: defaultSteerDeps,
};

/**
 * steer 一条排队消息进正在跑的这一轮。调用方已确认 canSteer。
 *
 * 同步段（HTTP 内）：take → 冲半截回复 → 落 user_reply → 202。
 * 异步段（fire-and-forget）：steer 落定后收尾 message_op——
 *   delivered → handedOff；followup → 排回队首（skipPersistEvent、气泡已在）等下一轮；
 *   replaced（系统摘会话、用户没停：自动重连 / 懒重启）→ 同样排回队首，「至少一次」不丢消息；
 *   error 收尾 → 与队里其它消息同命运：由 error 收尾经 inflightSteers 一并判 failed(error)、计入「未送达」提示
 *     （take 之后就提前登记，覆盖落盘 / 检查点的 await 空窗，第八轮 L5-01）；
 *   take 之后、steer 起手之前就被系统摘会话（restart / forceClear / 重连）→ 标记序号变大，同样按 replaced 重排，不记 stopped / no_session；
 *   cancelled / 摘表之后队列又被作废（用户停止 / 回退 / 删除）→ failed(stopped)。
 * 刻意**不占 in-flight 槽**：steer 可能挂很久（主 AI 卡在长工具里），期间 run 收尾的
 * 链式 flush 要能照常 dequeue / 占槽；在途靠 operation 的 persisted 相位表达。
 */
const steerQueuedMessage = async (
  taskId: string,
  itemId: string,
  task: Task,
  sd: SteerSendNowDeps,
  deps: SendNowDeps,
): Promise<Response> => {
  const taken = deps.take(taskId, itemId);
  if (!taken) return errorResponse("队列中找不到该消息", 404);

  if (isChatRewindInProgress(taskId)) {
    enqueueChatMessageFront(taskId, taken);
    return errorResponse("正在回退到检查点、完成后再发", 409);
  }
  const lifecycle = getChatLifecycle(taskId);
  if (lifecycle === "stopping") {
    enqueueChatMessageFront(taskId, taken);
    return errorResponse("正在停止对话、请稍后重发", 409);
  }
  if (lifecycle === "deleting") {
    settleMessageFailed(taskId, taken.itemId, "deleted");
    return errorResponse("任务正在删除", 409);
  }

  // generation 在落盘之前记：期间用户 stop / rewind 清队会 +1，之后据此判定消息已作废
  const genAtStart = getChatQueueGeneration(taskId);
  // 同一时刻记「系统关闭序号」：之后序号变大 = take 之后发生过系统关闭（第八轮 L5-01，见 ChatSystemCloseMark.seq）
  const closeSeqAtStart = getChatSystemCloseMark(taskId)?.seq ?? 0;
  // take 之后立刻登记成「steer 在飞」：下面的 flush / 落盘 / 检查点都是 await，这段空窗里 error 收尾清队要看得见这条
  // （此前登记要等 steerChatRun 起手；空窗里被 error 收尾遇上会记成 failed(stopped)、不进「未送达」提示）。
  // 有了定论（送达 / 重排 / 记终态 / 提前返回 / 抛错）一律注销。
  const releaseInflight =
    sd.registerInflight?.(taskId, {
      itemId: taken.itemId,
      displayText: taken.displayText,
    }) ?? (() => {});

  let persisted: PersistReplyResult;
  try {
    await sd.flushAssistant(taskId);
    persisted = await sd.persistReply(task, taken);
  } catch (err) {
    releaseInflight();
    throw err;
  }
  if (!persisted.ok) {
    releaseInflight();
    // 空窗里 error 收尾可能已把这条判成终态（failed(error)）：终态的不能再塞回队首 / 再记一次终态
    const alreadySettled = isMessageOperationTerminal(taskId, taken.itemId);
    if (persisted.reason === "persist_failed") {
      // 还没有气泡、没交给任何人：放回队首，用户重试即可
      if (!alreadySettled) enqueueChatMessageFront(taskId, taken);
      return errorResponse(PERSIST_FAIL_RETRY_MESSAGE, 500);
    }
    if (!alreadySettled) settleMessageFailed(taskId, taken.itemId, "task_gone");
    return errorResponse("not_found", 404);
  }

  const prompt = composeChatPrompt(
    taken.agentText || taken.displayText,
    taken.imageAbsPaths,
    taken.attachmentAbsPaths?.length ? taken.attachmentAbsPaths : undefined,
  );

  /**
   * 一条消息最多重排一次：steer 的结果只会被处理一次，这里再加一道闩，
   * 防日后有人把重排接到自动重试上形成「重排 → 再 steer → 又被换掉 → 再重排」的死循环。
   * 重排后的条目走的是普通 flush（sendChatMessage），从不再 steer——这是结构上的保证。
   */
  let requeued = false;

  /**
   * 这条消息已有气泡、没被这一轮收下——排队等下一轮（或判作废）。
   * @param replacedByReconnect 实例被自动重连换掉（用户没停）：重连链正在退避 / resume，
   *   这几秒表里没有会话是常态，不能按「会话没了」记 no_session 把用户的话丢掉。
   */
  const requeueAsFollowup = (replacedByReconnect = false): void => {
    if (requeued) return;
    requeued = true;
    if (isMessageOperationTerminal(taskId, taken.itemId)) return;
    // 「队列被清过」是谁干的：
    //   - 系统自己摘会话（replaced）：取消 / error 收尾总是「先清队（generation + 1）→ 同一同步段内摘表」，
    //     标记（markChatSystemClose）同时记了系统清队**前**与摘表时的 generation。两个条件都满足才算用户没介入：
    //       · 清队前 == genAtStart：系统动手之前，用户（停止 / 回退）没清过队（第七轮 K1-01：
    //         只比摘表时的值会把这次先到的用户清队吸收掉，用户已撤销的消息被重排回来）；
    //       · 当前 == 摘表时：摘表之后用户也没再清（停止 / 回退 / 删除仍判作废）。
    //     不能只用 steer 开始时的值比——系统自己的这次清队会被误当成用户停止（第六轮必修 1）。
    //   - 其余（followup 等）：steer 开始后任何清队都是用户意图，基线就是 genAtStart。
    // 标记属于「这条消息 take 之后」的系统关闭的判据：序号比 take 时记下的大（第八轮 L5-01；
    // 此前靠 preClearGeneration >= genAtStart 猜，只对 replaced 才看标记）。更早一次关闭留下的陈旧标记序号不会变大，
    // 被排除、退回 genAtStart 基线。
    //   两条来路都算「系统关闭了会话」：
    //   · steer 在飞时被摘（replaced：replacedByReconnect=true）；
    //   · steer 还没起手（take 与 steerChatRun 之间的 await 空窗）就被摘——steer 起手读到「没有会话」降成 followup，
    //     replacedByReconnect=false，但标记序号已变大。此前这条被记成 failed(stopped)（restart / error 清了队）或
    //     failed(no_session)（forceClear / 重连没清队），与上面「摘表时在飞」的终态表不一致。
    const mark = getChatSystemCloseMark(taskId);
    const sysClose = mark !== undefined && mark.seq > closeSeqAtStart ? mark : undefined;
    const currentGeneration = getChatQueueGeneration(taskId);
    // 注意 error 收尾一般不会走到这里：它已把在飞（含空窗里）steer 的这一条连同队列一起判了失败（reason=error，
    // 经 RunningChatRecord.inflightSteers 提前登记），上面的终态检查会拦下。
    const userUntouched = sysClose
      ? sysClose.preClearGeneration === genAtStart &&
        currentGeneration === sysClose.generation
      : currentGeneration === genAtStart;
    if (!userUntouched) {
      settleMessageFailed(taskId, taken.itemId, "stopped");
      return;
    }
    if (!replacedByReconnect && !sysClose && !sd.hasSession(taskId)) {
      settleMessageFailed(taskId, taken.itemId, "no_session");
      return;
    }
    enqueueChatMessageFront(taskId, { ...taken, skipPersistEvent: true });
    // 重连替换且当下无会话：不能主动 flush（flushChatQueue 见无会话会按 no_session 清整队），
    // 由重连链接手——成功则新 run 收尾的链式 flush 发出；放弃则 finalizeReconnectGaveUp 清队并提示「未送达」；
    // 懒重启（restart）同理：换新会话的那条消息起 run、run 收尾的链式 flush 把它发出（至少一次，可能与旧会话已读到的重复）；
    // 用户期间停止则 generation 已变、上面已判 stopped。
    // 其余：run 还在跑 → 收尾的链式 flush 会接手；已空闲 → 这里主动推一把
    if (sd.hasSession(taskId) && !sd.isRunActive(taskId)) {
      void sd.flushQueue(taskId).catch((err) => {
        console.warn(
          `[chat-queue-send-now] steer 后补 flush 失败 task=${taskId}:`,
          err,
        );
      });
    }
  };

  void (async () => {
    // 有了定论（含抛错）就注销提前登记的 steer 在飞记录：放在 finally 里、与各 settle 同一同步段，
    // 不留「已送达 / 已重排却还登记着」的微任务空档（那会让并发的 error 收尾把已送达的这条误判失败）
    try {
      let outcome: SteerChatResult;
      try {
        // 先把主 AI 前台等着的子代理转后台：不然它卡在那个阻塞的工具调用里，
        // 这条插话要等所有子代理跑完才到得了它（同步段内、steer 之前，保证先后顺序）
        const detached = sd.detachForeground?.(taskId) ?? 0;
        if (detached > 0) {
          console.log(
            `[chat-queue-send-now] task=${taskId} 插话：${detached} 个前台子代理已转后台`,
          );
        }
        // 同理叫醒在睡的 wait：它返回 [WAIT_INTERRUPTED]、主 AI 随即读到这条插话
        const wokenWaits = sd.interruptWaits?.(taskId) ?? 0;
        if (wokenWaits > 0) {
          console.log(
            `[chat-queue-send-now] task=${taskId} 插话：${wokenWaits} 个 wait 已提前结束`,
          );
        }
        // item：在飞期间登记到会话记录上——error 收尾要把这一条也算进「未送达」（它不在队里、也不占 in-flight 槽）；
        // 已在 take 之后提前登记过的，steerChatRun 不会重复登记 / 替我们注销
        outcome = await sd.steer(taskId, prompt, {
          item: { itemId: taken.itemId, displayText: taken.displayText },
        });
      } catch (err) {
        console.warn(
          `[chat-queue-send-now] steer 抛错、降级排队 task=${taskId}:`,
          err,
        );
        outcome = "followup";
      }
      if (outcome === "delivered") {
        settleMessageHandedOff(taskId, taken.itemId);
        // 飞书桥接钩子：与 flush 成功同口径（升级 Typing→Get 回执、清撤回 Map）
        emitQueuedMessageFlushed(taskId, taken);
        return;
      }
      if (outcome === "cancelled") {
        if (!isMessageOperationTerminal(taskId, taken.itemId)) {
          settleMessageFailed(taskId, taken.itemId, "stopped");
        }
        return;
      }
      // 「至少一次」：重连换掉了实例、steer 没确认送达，用户并没有停止——重排队，
      // 宁可在新实例上重复一条，也不静默丢（重排条在排队条里可见，用户可自己删）
      requeueAsFollowup(outcome === "replaced");
    } finally {
      releaseInflight();
    }
  })().catch((err) => {
    console.error(
      `[chat-queue-send-now] steer 收尾异常 task=${taskId}:`,
      err,
    );
  });

  const fresh = await deps.getTask(taskId);
  return new Response(
    JSON.stringify({
      ok: true,
      sentNow: true,
      steered: true,
      itemId: taken.itemId,
      task: fresh ?? task,
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
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

  // 能插话就插话：不停止、不重开会话（Codex / Cursor IDE 口径）。
  // 不能（pi 后端 / 冷启动占位 / 收尾空窗 / 无 run 在跑）回退到下面的打断重发。
  if (deps.steer?.canSteer(taskId)) {
    return steerQueuedMessage(taskId, trimmedId, task, deps.steer, deps);
  }

  // 关键：取出必须在 stop 之前，否则 failQueuedItems 会把目标条一起作废
  const taken = deps.take(taskId, trimmedId);
  if (!taken) return errorResponse("队列中找不到该消息", 404);

  // 其余排队先救出来（stop 清队不波及它们，start 后原样塞回继续排）
  const drainRest = deps.drainRest ?? drainRemainingChatQueue;
  const requeueRest = deps.requeueRest ?? defaultRequeueRest;
  const rest = drainRest(taskId);

  try {
    await deps.stop(task);
  } catch (err) {
    // stop 失败：目标条放回队首、其余按原顺序跟回，一条不丢
    enqueueChatMessageFront(taskId, taken);
    requeueRest(taskId, rest, taken.itemId);
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

  // start 成败都把其余排队塞回：成功→跟在目标条后面继续 flush；
  // 失败→start 内部已把目标条放回队首，其余跟在后面，一条不丢。
  try {
    return await deps.start(taskId, taken, validated);
  } finally {
    requeueRest(taskId, rest, taken.itemId);
  }
};
