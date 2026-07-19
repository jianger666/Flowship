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
 *
 * # R33-1 QueueOperation 契约
 *
 * - itemId：客户端可预生成（clientItemId）；服务端无则兜底发号
 * - active（队内 + in-flight）+ bounded recentSettled ledger
 * - 所有清队终态只走 failQueuedItems（禁止业务路径直调 clearChatQueue）
 */

import type { ImageAttachmentSaved } from "./task-artifacts";
import type { AttachmentMeta } from "./route-helpers";
import { publish } from "./task-stream";

export const CHAT_QUEUE_MAX = 5;

/** R33-1：recentSettled FIFO 上限（断线重连可重放对账） */
export const RECENT_SETTLED_MAX = 50;

/**
 * R32-2 / R33-1：清队终态 reason（机器可读，经 queue_failed 下发前端）。
 * - persist_failed：strict 落盘 EIO 等
 * - no_session：会话消失、无法按序送达
 * - task_gone：任务目录消失 / 非 chat
 * - flush_error：checkpoint / send / 后置步骤抛错
 * - stopped / cancelled / error / startup_failed / rewound：旁路清队统一 sink
 */
export type FailQueuedItemsReason =
  | "persist_failed"
  | "no_session"
  | "task_gone"
  | "flush_error"
  | "stopped"
  | "cancelled"
  | "error"
  | "startup_failed"
  | "rewound"
  | "deleted";

/** R33-1：ledger 终态 outcome（delivered = user_reply 已落盘） */
export type QueueItemSettleOutcome = "delivered" | FailQueuedItemsReason;

export type RecentSettledEntry = {
  itemId: string;
  outcome: QueueItemSettleOutcome;
};

/**
 * R31-1 / R33-7：进程内单调短 id，供 202 ↔ pending ↔ queue_failed 对账。
 * 发号器挂 globalThis（与 queue state 同对象），防 route-chunk / HMR 撞号。
 * 客户端预生成 UUID 后此发号器只剩兜底。
 */
export const allocChatQueueItemId = (): string => {
  const state = getQueueState();
  const seq = state.nextItemSeq++;
  return `cq_${Date.now().toString(36)}_${seq.toString(36)}`;
};

/** 队列里暂存的待发消息（纯文本 + 已落盘的图 / 附件路径） */
export type QueuedChatMsg = {
  /**
   * R31-1：稳定队列项 id（入队时分配；202 / pending / queue_failed 对账用）。
   * 调用方可不传——enqueue / enqueueFront 会自动补。
   */
  itemId: string;
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
};

/** 入队入参：itemId 可选（缺则自动分配） */
export type QueuedChatMsgInput = Omit<QueuedChatMsg, "itemId"> & {
  itemId?: string;
};

const withItemId = (msg: QueuedChatMsgInput): QueuedChatMsg => ({
  ...msg,
  itemId:
    typeof msg.itemId === "string" && msg.itemId.trim()
      ? msg.itemId.trim()
      : allocChatQueueItemId(),
});

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
  /**
   * R32-2：in-flight 条的 itemId（与 inFlight 同步寿命）。
   * watch bootstrap 的 queue_state 需把「已 dequeue、尚未出路」的条算进服务端存活集合，
   * 否则重连会把正当 in-flight 误判成幽灵 pending。
   */
  inFlightItemIds: Map<string, string>;
  /**
   * R33-1：per-task 有界终态 ledger（FIFO）。
   * failQueuedItems / user_reply delivered 都记；watch bootstrap 重放对账。
   */
  recentSettled: Map<string, RecentSettledEntry[]>;
  /** R33-7：全局 item 发号器（与 Map 同寿命，防 resetModules 撞号） */
  nextItemSeq: number;
}

// V5：相对 V4 增 recentSettled + nextItemSeq（R33-1 / R33-7）；换 key 防 hot-reload 缺字段分裂
const CHAT_QUEUE_GLOBAL_KEY = "__feAiFlowChatQueueV5__";

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
      inFlightItemIds: new Map(),
      recentSettled: new Map(),
      nextItemSeq: 1,
    };
  }
  const state = g[CHAT_QUEUE_GLOBAL_KEY]!;
  // hot-reload：旧 state 可能缺字段
  if (!state.generations) state.generations = new Map();
  if (!state.inFlight) state.inFlight = new Map();
  if (!state.inFlightItemIds) state.inFlightItemIds = new Map();
  if (!state.recentSettled) state.recentSettled = new Map();
  if (typeof state.nextItemSeq !== "number" || state.nextItemSeq < 1) {
    state.nextItemSeq = 1;
  }
  return state;
};

const queues = () => getQueueState().queues;
const generations = () => getQueueState().generations;
const inFlightMap = () => getQueueState().inFlight;
const inFlightItemIdsMap = () => getQueueState().inFlightItemIds;
const recentSettledMap = () => getQueueState().recentSettled;

/**
 * R33-1：把 item 记入 per-task recentSettled（已有则跳过；超上限 FIFO 丢最老）。
 * delivered（user_reply 落盘）与 failQueuedItems 共用。
 */
export const recordQueueItemSettled = (
  taskId: string,
  itemId: string,
  outcome: QueueItemSettleOutcome,
): void => {
  if (!itemId) return;
  const map = recentSettledMap();
  const cur = map.get(taskId) ?? [];
  if (cur.some((e) => e.itemId === itemId)) return;
  const next = [...cur, { itemId, outcome }];
  map.set(
    taskId,
    next.length > RECENT_SETTLED_MAX
      ? next.slice(next.length - RECENT_SETTLED_MAX)
      : next,
  );
};

/** R33-1：只读快照——bootstrap queue_state.recentSettled */
export const listRecentSettled = (taskId: string): RecentSettledEntry[] => [
  ...(recentSettledMap().get(taskId) ?? []),
];

/** 入队结果：ok + 当前条数 + itemId；满了返回 full */
export type EnqueueResult =
  | { ok: true; queuedCount: number; itemId: string }
  | { ok: false; reason: "full"; queuedCount: number };

/**
 * 纯函数：在现有列表上尝试追加（不碰 Map）。
 * 满了（已有 >= max）返 full；否则返新列表。
 * 注意：Map 侧 enqueue 另计入 in-flight（见 enqueueChatMessage）。
 */
export const tryEnqueueMsg = (
  current: QueuedChatMsg[],
  msg: QueuedChatMsgInput,
  max = CHAT_QUEUE_MAX,
): { ok: true; next: QueuedChatMsg[] } | { ok: false; reason: "full" } => {
  if (current.length >= max) return { ok: false, reason: "full" };
  return { ok: true, next: [...current, withItemId(msg)] };
};

/** 当前 task 的 in-flight 占位数（无记录返 0） */
export const getChatQueueInFlight = (taskId: string): number =>
  inFlightMap().get(taskId) ?? 0;

/**
 * flush 成功 dequeue 后占位：计入容量，直到 send 成功 / 塞回 / 作废丢弃。
 * 幂等设为 1（同 task 同时只会有一条 in-flight）。
 * R32-2：可选 itemId 一并挂上，供 queue_state bootstrap 对账。
 */
export const beginChatQueueInFlight = (
  taskId: string,
  itemId?: string,
): void => {
  inFlightMap().set(taskId, 1);
  if (itemId) inFlightItemIdsMap().set(taskId, itemId);
};

/** 清零 in-flight 占位（send 出路 / finally / clear 共用） */
export const endChatQueueInFlight = (taskId: string): void => {
  inFlightMap().delete(taskId);
  inFlightItemIdsMap().delete(taskId);
};

/** 入队；超上限返 full（调用方 409「排队已满」）。容量 = 队列长 + in-flight */
export const enqueueChatMessage = (
  taskId: string,
  msg: QueuedChatMsgInput,
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
  const itemId = result.next[result.next.length - 1]!.itemId;
  return { ok: true, queuedCount: result.next.length, itemId };
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
  msg: QueuedChatMsgInput,
): void => {
  const map = queues();
  const cur = map.get(taskId) ?? [];
  const next = [withItemId(msg), ...cur];
  if (next.length > CHAT_QUEUE_MAX) {
    console.error(
      `[chat-queue] task=${taskId} 塞回队首后短暂超上限（${next.length} > ${CHAT_QUEUE_MAX}）、` +
        `保留全部已接受消息（允许 MAX+1），绝不丢队尾`,
    );
  }
  map.set(taskId, next);
};

/**
 * R31-1：同步取出并清空剩余排队条目的 itemId（不含已 dequeue 的 in-flight 条）。
 * 不碰 generation / in-flight——调用方随后 clearChatQueue 统一收尾。
 */
export const takeRemainingChatQueueItemIds = (taskId: string): string[] => {
  const map = queues();
  const cur = map.get(taskId) ?? [];
  map.delete(taskId);
  return cur.map((m) => m.itemId);
};

/**
 * R32-2：只读快照——当前服务端仍「存活」的 queue itemId（队内 + in-flight）。
 * 供 watch-task bootstrap 的 queue_state；不改 generation / 不消费队列。
 */
export const listChatQueueItemIds = (taskId: string): string[] => {
  const queued = (queues().get(taskId) ?? []).map((m) => m.itemId);
  const inflightId = inFlightItemIdsMap().get(taskId);
  if (inflightId && !queued.includes(inflightId)) {
    return [inflightId, ...queued];
  }
  return queued;
};

/**
 * R32-2 / R33-1：唯一清队终态提交入口（QueueOperation sink）。
 *
 * 契约：
 * 1. 取出剩余队内 itemIds + in-flight（未显式传 currentItemId 时自动纳入）
 * 2. 可选 currentItemId：已 dequeue 的当前条；若 currentReplyPersisted=true
 *    （user_reply 已落盘 → 已有终态）则记 delivered，不进 failed
 * 3. clear（+generation、清 in-flight）——业务路径禁止直调 clearChatQueue
 * 4. failedIds 记入 recentSettled 并纯内存 publish `queue_failed`
 * 5. 返回实际 failed 的 itemIds（供调用方写 info 文案）
 */
export const failQueuedItems = (
  taskId: string,
  options: {
    reason: FailQueuedItemsReason;
    currentItemId?: string;
    /** 当前条 user_reply 已落盘 → 不算 failed */
    currentReplyPersisted?: boolean;
  },
): string[] => {
  const remaining = takeRemainingChatQueueItemIds(taskId);
  // R33-1：stop/cancelled 等旁路常不传 currentItemId——自动纳入 in-flight
  const inflightId = inFlightItemIdsMap().get(taskId);
  const currentId = options.currentItemId ?? inflightId;

  const failedIds: string[] = [];
  if (currentId && !options.currentReplyPersisted) {
    failedIds.push(currentId);
  } else if (currentId && options.currentReplyPersisted) {
    // 当前条已有 user_reply 终态 → ledger 记 delivered（重连可对账）
    recordQueueItemSettled(taskId, currentId, "delivered");
  }
  for (const id of remaining) {
    if (!failedIds.includes(id)) failedIds.push(id);
  }

  // R33-1：clear 仅允许经本 sink（内部私有语义；导出留给 DELETE/测试）
  clearChatQueue(taskId);

  for (const id of failedIds) {
    recordQueueItemSettled(taskId, id, options.reason);
  }
  if (failedIds.length > 0) {
    publish(taskId, {
      kind: "queue_failed",
      itemIds: failedIds,
      reason: options.reason,
    });
  }
  return failedIds;
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
 * 清空队列 + 递增 generation（不做终态 publish / 不写 ledger）。
 *
 * ⚠️ R33-1：业务清队必须走 failQueuedItems。本函数仅供：
 * - failQueuedItems 内部
 * - DELETE / rewind 门闩路径（另代理范围或已有门闩、评估清单见验收报告）
 * - 单测清理
 */
export const clearChatQueue = (taskId: string): void => {
  queues().delete(taskId);
  endChatQueueInFlight(taskId);
  const gens = generations();
  gens.set(taskId, (gens.get(taskId) ?? 0) + 1);
};

/**
 * 删任务收尾：队列 + generation + in-flight + recentSettled 一起清（复审 11 轮：
 * generations 只增不删、长跑进程积键）。必须在 clearChatQueue（作废在途 drain）
 * 且活跃 drain 退出后调用。
 */
export const cleanupChatQueueState = (taskId: string): void => {
  queues().delete(taskId);
  generations().delete(taskId);
  endChatQueueInFlight(taskId);
  recentSettledMap().delete(taskId);
};
