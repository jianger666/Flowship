/**
 * 飞书撤回同步出队（决策 #20）
 *
 * 订阅 im.message.recalled_v1：消息还在 chat 队列 → 移除 + 撤 Typing 回执 + bot 回「已撤回该消息」。
 * 已注入 / 未知 messageId → 忽略（不发回执）。
 *
 * review P0#1：
 * - 出队谓词按 extraMeta.feishuMessageId 精确匹配（不再文本匹配，避免同文案误删）
 * - 订阅队列 flush 钩子清 queuedByMessageId，避免已注入后撤回仍误报「已撤回」
 * - removeQueued 空结果 → 静默 return
 * - Map FIFO 上限 500
 *
 * 官方事件体（schema 2.0）：
 *   { schema, header: { event_type: "im.message.recalled_v1", … },
 *     event: { message_id, chat_id, recall_time, recall_type } }
 * lark-cli 1.0.58 event list 尚未收录该 key，但仍按官方类型名消费（升级 CLI 后即可就绪）。
 */

import {
  onQueuedMessageFlushed,
  removeQueuedChatMessages,
  type QueuedChatMsg,
} from "@/lib/server/chat-queue";

import {
  addInjectResultListener,
  type InjectResultPayload,
} from "./router";
import {
  getBotAppInfo,
  sendTextMessage,
} from "./lark-api";
import { tryRemoveStoredReaction } from "./reactions";

type QueuedInjectEntry = {
  messageId: string;
  taskId: string;
  text: string;
};

const QUEUED_MAP_MAX = 500;

/** messageId → 仍在队列的注入（flush / sent 后删） */
const queuedByMessageId = new Map<string, QueuedInjectEntry>();
/** FIFO 顺序，超上限淘汰最旧 */
const queuedOrder: string[] = [];

const REG_KEY = "__feAiFlowFeishuRecallHandlingV1__";

type RecallGlobal = {
  registered: boolean;
  unsubInject: (() => void) | null;
  unsubFlush: (() => void) | null;
};

const getReg = (): RecallGlobal => {
  const g = globalThis as unknown as Record<string, RecallGlobal | undefined>;
  if (!g[REG_KEY]) {
    g[REG_KEY] = { registered: false, unsubInject: null, unsubFlush: null };
  }
  return g[REG_KEY]!;
};

const rememberQueued = (entry: QueuedInjectEntry): void => {
  if (!entry.messageId) return;
  if (queuedByMessageId.has(entry.messageId)) {
    const idx = queuedOrder.indexOf(entry.messageId);
    if (idx >= 0) queuedOrder.splice(idx, 1);
  }
  queuedByMessageId.set(entry.messageId, entry);
  queuedOrder.push(entry.messageId);
  while (queuedOrder.length > QUEUED_MAP_MAX) {
    const old = queuedOrder.shift();
    if (old) queuedByMessageId.delete(old);
  }
};

const forgetQueued = (messageId: string): void => {
  if (!queuedByMessageId.delete(messageId)) return;
  const idx = queuedOrder.indexOf(messageId);
  if (idx >= 0) queuedOrder.splice(idx, 1);
};

/**
 * 宽容解析 recalled_v1 的 message_id。
 * 兼容：官方嵌套 event.message_id / 扁平 message_id / lark-cli 可能的顶层字段。
 */
export const parseRecalledMessageId = (raw: unknown): string | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nested =
    o.event && typeof o.event === "object"
      ? (o.event as Record<string, unknown>)
      : null;
  const candidates = [
    nested && typeof nested.message_id === "string" ? nested.message_id : "",
    typeof o.message_id === "string" ? o.message_id : "",
    nested && typeof nested.messageId === "string" ? nested.messageId : "",
    typeof o.messageId === "string" ? o.messageId : "",
  ];
  for (const id of candidates) {
    if (id.trim()) return id.trim();
  }
  return null;
};

/** 谓词：队列条目的飞书 message_id 精确匹配（review P0#1） */
const matchFeishuMessageId =
  (messageId: string) =>
  (m: QueuedChatMsg): boolean =>
    m.extraMeta?.feishuMessageId === messageId;

const onInjectResultForQueue = (payload: InjectResultPayload): void => {
  if (payload.kind === "queued" && payload.messageId && payload.taskId) {
    rememberQueued({
      messageId: payload.messageId,
      taskId: payload.taskId,
      text: payload.text ?? "",
    });
    return;
  }
  // sent / failed / skipped：不再算「队列中」
  if (payload.messageId) {
    forgetQueued(payload.messageId);
  }
};

/** flush 成功注入 → 清残留（决策 #20：已注入不处理） */
const onQueueFlushed = (_taskId: string, msg: QueuedChatMsg): void => {
  const mid = msg.extraMeta?.feishuMessageId;
  if (typeof mid === "string" && mid) {
    forgetQueued(mid);
  }
};

/**
 * inbound CONSUMER_SPECS 挂的撤回 handler。
 * 未命中队列 → 静默忽略（已注入无法撤）。
 */
export const handleRecallEvent = async (raw: unknown): Promise<void> => {
  const messageId = parseRecalledMessageId(raw);
  if (!messageId) return;

  const entry = queuedByMessageId.get(messageId);
  if (!entry) return;

  // 先按 feishuMessageId 精确出队；空结果 = 已 flush / 无匹配 → 静默（不发「已撤回」）
  const removed = removeQueuedChatMessages(
    entry.taskId,
    matchFeishuMessageId(messageId),
  );
  forgetQueued(messageId);

  if (removed.length === 0) {
    // review P0#1：队列里已无此条（flush 竞态 / 残留 Map）→ 不误报
    return;
  }

  // 撤掉排队时点的 Typing（失败静默）
  await tryRemoveStoredReaction(messageId);

  try {
    const info = await getBotAppInfo();
    await sendTextMessage(info.ownerOpenId, "已撤回该消息");
  } catch (err) {
    console.warn(
      "[feishu-bridge/recall] 撤回回执发送失败:",
      err instanceof Error ? err.message : err,
    );
  }
};

/** 挂 inject + flush 监听；consumer 已在 inbound CONSUMER_SPECS 声明 */
export const ensureRecallHandlingRegistered = (): void => {
  const reg = getReg();
  if (reg.registered) return;
  reg.unsubInject = addInjectResultListener(onInjectResultForQueue);
  reg.unsubFlush = onQueuedMessageFlushed(onQueueFlushed);
  reg.registered = true;
};

/** 单测重置 */
export const __resetRecallForTest = (): void => {
  const reg = getReg();
  reg.unsubInject?.();
  reg.unsubInject = null;
  reg.unsubFlush?.();
  reg.unsubFlush = null;
  reg.registered = false;
  queuedByMessageId.clear();
  queuedOrder.length = 0;
};

/** 单测窥探 queuedMap */
export const __queuedMapForTest = (): Map<string, QueuedInjectEntry> =>
  queuedByMessageId;

/** 单测窥探 FIFO 长度 */
export const __queuedOrderForTest = (): string[] => [...queuedOrder];
