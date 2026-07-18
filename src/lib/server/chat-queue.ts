/**
 * Chat 运行中消息排队（P5.1）
 *
 * agent 正在回时 chat-reply 不再 409，消息入 per-task 队列；
 * consumeChatRun 自然结束后 dequeue 依序 send（user_reply 在实际发送时才落）。
 * 纯函数便于单测；Map 挂 globalThis 防 dev hot reload 拆分。
 *
 * # 容量协议（S4 / 十二轮）
 *
 * 上限 CHAT_QUEUE_MAX 计入「队列长度 + in-flight」：
 *   - in-flight = flush 已 dequeue、尚未 send 成功 / 塞回 / 作废丢弃的那条
 *   - enqueue 判满：length + inflight >= MAX → full（HTTP 409，诚实拒绝新消息）
 *   - 已 202 的消息绝不因塞回超限被丢队尾；理论短暂 MAX+1 可接受（打 error 日志）
 */

import type { ImageAttachmentSaved } from "./task-artifacts";
import type { AttachmentMeta } from "./route-helpers";

export const CHAT_QUEUE_MAX = 5;

/** 队列里暂存的待发消息（纯文本 + 已落盘的图 / 附件路径） */
export type QueuedChatMsg = {
  /** 进 agent 的文本（可含 skill 指引） */
  agentText: string;
  /** 落 user_reply 气泡的用户原文 */
  displayText: string;
  imageAbsPaths?: string[];
  /** 写进 user_reply.meta.images 的完整 meta */
  savedImages?: ImageAttachmentSaved[];
  attachmentAbsPaths?: string[];
  /** 写进 user_reply.meta.attachments */
  attachmentMetas?: AttachmentMeta[];
  enqueuedAt: number;
  /**
   * 消息对应的 user_reply 事件已由入队方落盘（如并发起会话被吞后改入队、
   * chat-reply 模式 2 已 persistReplyAndCheckpoint）。flush 发出后不要再落一条重复气泡。
   */
  skipPersistEvent?: boolean;
  /**
   * 额外并进 user_reply.meta 的字段（如飞书桥接的 `{ source: "feishu" }`）。
   * flush 落事件时浅合并；缺省 = 不合并、对既有调用方零行为变化。
   */
  extraMeta?: Record<string, unknown>;
};

interface ChatQueueGlobalState {
  queues: Map<string, QueuedChatMsg[]>;
  /**
   * per-task 单调递增「作废世代」：clearChatQueue（stop / rewind / 删任务）时 +1。
   * flush drain 从 dequeue 到塞回队首之间若 generation 变了，说明中途已清队、
   * 该消息已被判定作废，不得 enqueueFront 复活（否则会带着回退前旧上下文再发）。
   */
  generations: Map<string, number>;
  /**
   * S4（十二轮）：per-task in-flight 计数（通常 0|1）。
   * flush 成功 dequeue 后 +1，send 成功 / 塞回 / generation 作废 / 异常清队后归零。
   * 计入容量，避免 dequeue 空出窗口时新消息 202 再塞满、塞回时静默丢已接受消息。
   */
  inFlight: Map<string, number>;
}

// V3：相对 V2 增 inFlight；换 key 避免 hot-reload 后读到缺字段的旧 state 分裂
const CHAT_QUEUE_GLOBAL_KEY = "__feAiFlowChatQueueV3__";

const getQueueState = (): ChatQueueGlobalState => {
  const g = globalThis as unknown as Record<
    string,
    ChatQueueGlobalState | undefined
  >;
  if (!g[CHAT_QUEUE_GLOBAL_KEY]) {
    g[CHAT_QUEUE_GLOBAL_KEY] = {
      queues: new Map(),
      generations: new Map(),
      inFlight: new Map(),
    };
  }
  // hot-reload：旧 state 可能缺 generations / inFlight
  if (!g[CHAT_QUEUE_GLOBAL_KEY]!.generations) {
    g[CHAT_QUEUE_GLOBAL_KEY]!.generations = new Map();
  }
  if (!g[CHAT_QUEUE_GLOBAL_KEY]!.inFlight) {
    g[CHAT_QUEUE_GLOBAL_KEY]!.inFlight = new Map();
  }
  return g[CHAT_QUEUE_GLOBAL_KEY]!;
};

const queues = () => getQueueState().queues;
const generations = () => getQueueState().generations;
const inFlightMap = () => getQueueState().inFlight;

/** 入队结果：ok + 当前条数；满了返回 full */
export type EnqueueResult =
  | { ok: true; queuedCount: number }
  | { ok: false; reason: "full"; queuedCount: number };

/**
 * 纯函数：在现有列表上尝试追加（不碰 Map）。
 * 满了（已有 >= max）返 full；否则返新列表。
 * 注意：Map 侧 enqueue 另计入 in-flight（见 enqueueChatMessage）。
 */
export const tryEnqueueMsg = (
  current: QueuedChatMsg[],
  msg: QueuedChatMsg,
  max = CHAT_QUEUE_MAX,
): { ok: true; next: QueuedChatMsg[] } | { ok: false; reason: "full" } => {
  if (current.length >= max) return { ok: false, reason: "full" };
  return { ok: true, next: [...current, msg] };
};

/** 当前 task 的 in-flight 占位数（无记录返 0） */
export const getChatQueueInFlight = (taskId: string): number =>
  inFlightMap().get(taskId) ?? 0;

/**
 * flush 成功 dequeue 后占位：计入容量，直到 send 成功 / 塞回 / 作废丢弃。
 * 幂等设为 1（同 task 同时只会有一条 in-flight）。
 */
export const beginChatQueueInFlight = (taskId: string): void => {
  inFlightMap().set(taskId, 1);
};

/** 清零 in-flight 占位（send 出路 / finally / clear 共用） */
export const endChatQueueInFlight = (taskId: string): void => {
  inFlightMap().delete(taskId);
};

/** 入队；超上限返 full（调用方 409「排队已满」）。容量 = 队列长 + in-flight */
export const enqueueChatMessage = (
  taskId: string,
  msg: QueuedChatMsg,
): EnqueueResult => {
  const map = queues();
  const cur = map.get(taskId) ?? [];
  const inflight = getChatQueueInFlight(taskId);
  // S4（十二轮）：in-flight 占容量，dequeue 窗口内新消息诚实 409，不靠塞回丢尾
  if (cur.length + inflight >= CHAT_QUEUE_MAX) {
    return {
      ok: false,
      reason: "full",
      queuedCount: cur.length + inflight,
    };
  }
  const result = tryEnqueueMsg(cur, msg);
  if (!result.ok) {
    return { ok: false, reason: "full", queuedCount: cur.length + inflight };
  }
  map.set(taskId, result.next);
  return { ok: true, queuedCount: result.next.length };
};

/** 取出队首；空队列返 null */
export const dequeueChatMessage = (taskId: string): QueuedChatMsg | null => {
  const map = queues();
  const cur = map.get(taskId);
  if (!cur || cur.length === 0) return null;
  const [head, ...rest] = cur;
  if (rest.length === 0) map.delete(taskId);
  else map.set(taskId, rest);
  return head;
};

/**
 * 塞回队首（send 失败 / run 又占上时保序）。
 * S4（十二轮）：容量已预留 in-flight，正常不会超限；若理论超限仍保留塞回
 *（旧条已 202 优先），允许短暂 MAX+1 并打 error——绝不可静默丢已接受消息。
 */
export const enqueueChatMessageFront = (
  taskId: string,
  msg: QueuedChatMsg,
): void => {
  const map = queues();
  const cur = map.get(taskId) ?? [];
  const next = [msg, ...cur];
  if (next.length > CHAT_QUEUE_MAX) {
    console.error(
      `[chat-queue] task=${taskId} 塞回队首后短暂超上限（${next.length} > ${CHAT_QUEUE_MAX}）、` +
        `保留全部已接受消息（允许 MAX+1），绝不丢队尾`,
    );
  }
  map.set(taskId, next);
};

/** 当前排队条数（不含 in-flight） */
export const getChatQueueCount = (taskId: string): number =>
  queues().get(taskId)?.length ?? 0;

/**
 * 当前 task 的队列 generation（无记录返 0）。
 * drain 侧：dequeue 前记下 gen，塞回前比对——变了说明中途 clear，消息已作废。
 */
export const getChatQueueGeneration = (taskId: string): number =>
  generations().get(taskId) ?? 0;

/**
 * stop / 删任务 / rewind 时清队列，并递增 generation。
 * generation +1 = 一次「作废整队」事件：已 dequeue、尚在 checkpoint/send 途中的消息
 * 不得再被 flush 塞回队首（否则消息「复活」）。
 * 同时清零 in-flight，避免占位残留导致后续误判满。
 */
export const clearChatQueue = (taskId: string): void => {
  queues().delete(taskId);
  endChatQueueInFlight(taskId);
  const gens = generations();
  gens.set(taskId, (gens.get(taskId) ?? 0) + 1);
};

/**
 * 删任务收尾：队列 + generation + in-flight 记录一起清（复审 11 轮：generations 只增不删、
 * 长跑进程积键）。必须在 clearChatQueue（作废在途 drain）且活跃 drain 退出后调用。
 */
export const cleanupChatQueueState = (taskId: string): void => {
  queues().delete(taskId);
  generations().delete(taskId);
  endChatQueueInFlight(taskId);
};
