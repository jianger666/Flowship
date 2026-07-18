/**
 * 飞书撤回同步出队（决策 #20）
 *
 * 订阅 im.message.recalled_v1：消息还在 chat 队列 → 移除 + 撤 Typing 回执 + bot 回「已撤回该消息」。
 * 已注入 / 未知 messageId → 忽略。
 *
 * 官方事件体（schema 2.0）：
 *   { schema, header: { event_type: "im.message.recalled_v1", … },
 *     event: { message_id, chat_id, recall_time, recall_type } }
 * lark-cli 1.0.58 event list 尚未收录该 key，但仍按官方类型名消费（升级 CLI 后即可就绪）。
 */

import { removeQueuedChatMessages } from "@/lib/server/chat-queue";

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

/** messageId → 仍在队列的注入（sent 后删） */
const queuedByMessageId = new Map<string, QueuedInjectEntry>();

const REG_KEY = "__feAiFlowFeishuRecallHandlingV1__";

type RecallGlobal = {
  registered: boolean;
  unsubInject: (() => void) | null;
};

const getReg = (): RecallGlobal => {
  const g = globalThis as unknown as Record<string, RecallGlobal | undefined>;
  if (!g[REG_KEY]) g[REG_KEY] = { registered: false, unsubInject: null };
  return g[REG_KEY]!;
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

const onInjectResultForQueue = (payload: InjectResultPayload): void => {
  if (payload.kind === "queued" && payload.messageId && payload.taskId) {
    queuedByMessageId.set(payload.messageId, {
      messageId: payload.messageId,
      taskId: payload.taskId,
      text: payload.text ?? "",
    });
    return;
  }
  // sent / failed / skipped：不再算「队列中」
  if (payload.messageId) {
    queuedByMessageId.delete(payload.messageId);
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

  queuedByMessageId.delete(messageId);

  const text = entry.text;
  // 按入队时记下的 text 匹配；无文本则尽量撤空文案条目
  removeQueuedChatMessages(entry.taskId, (m) => {
    if (!text) return !m.displayText && !m.agentText;
    return m.displayText === text || m.agentText === text;
  });

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

/** 挂 inject 监听（记 queuedMap）；consumer 已在 inbound CONSUMER_SPECS 声明 */
export const ensureRecallHandlingRegistered = (): void => {
  const reg = getReg();
  if (reg.registered) return;
  reg.unsubInject = addInjectResultListener(onInjectResultForQueue);
  reg.registered = true;
};

/** 单测重置 */
export const __resetRecallForTest = (): void => {
  const reg = getReg();
  reg.unsubInject?.();
  reg.unsubInject = null;
  reg.registered = false;
  queuedByMessageId.clear();
};

/** 单测窥探 queuedMap */
export const __queuedMapForTest = (): Map<string, QueuedInjectEntry> =>
  queuedByMessageId;
