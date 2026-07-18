/**
 * 飞书注入结果 emoji 回执（决策 #16）
 *
 * - sent → Get（用户指定 GET；实测键名大小写敏感，GET 非法）
 * - queued → Typing（⏳ 无官方键；Typing = 等待中最接近）
 * - failed → CrossMark（❌）
 * - skipped → 不点
 *
 * reaction 失败静默降级（锦上添花、不影响注入）。
 * MVP：queued→sent 升级（撤 Typing 改 Get）不做——flush 链路无 messageId 回调。
 */

import {
  addInjectResultListener,
  type InjectResultPayload,
} from "./router";
import { addReaction, removeReaction } from "./lark-api";

/** 实测可用的 emoji_type（2026-07-18 lark-cli 试点） */
export const EMOJI_SENT = "Get";
export const EMOJI_QUEUED = "Typing";
export const EMOJI_FAILED = "CrossMark";

const REACTION_MAP_MAX = 500;

type ReactionEntry = {
  messageId: string;
  reactionId: string;
  emojiType: string;
};

/** messageId → 最近一次 bot 点的表情（撤回时撤 Typing 用） */
const reactionByMessageId = new Map<string, ReactionEntry>();
/** FIFO 顺序，超上限淘汰最旧 */
const reactionOrder: string[] = [];

const REG_KEY = "__feAiFlowFeishuReactionReceiptsV1__";

type ReactionsGlobal = { registered: boolean; unsub: (() => void) | null };

const getReg = (): ReactionsGlobal => {
  const g = globalThis as unknown as Record<string, ReactionsGlobal | undefined>;
  if (!g[REG_KEY]) g[REG_KEY] = { registered: false, unsub: null };
  return g[REG_KEY]!;
};

const rememberReaction = (
  messageId: string,
  reactionId: string,
  emojiType: string,
): void => {
  if (!messageId || !reactionId) return;
  if (reactionByMessageId.has(messageId)) {
    // 同 message 覆盖：从 FIFO 里摘掉旧位
    const idx = reactionOrder.indexOf(messageId);
    if (idx >= 0) reactionOrder.splice(idx, 1);
  }
  reactionByMessageId.set(messageId, { messageId, reactionId, emojiType });
  reactionOrder.push(messageId);
  while (reactionOrder.length > REACTION_MAP_MAX) {
    const old = reactionOrder.shift();
    if (old) reactionByMessageId.delete(old);
  }
};

/** 查内存里 bot 点过的 reaction（recall 撤 Typing 用） */
export const getStoredReaction = (
  messageId: string,
): ReactionEntry | null => reactionByMessageId.get(messageId) ?? null;

/** 从内存忘掉（撤表情成功后 / 单测清理） */
export const forgetStoredReaction = (messageId: string): void => {
  if (!reactionByMessageId.delete(messageId)) return;
  const idx = reactionOrder.indexOf(messageId);
  if (idx >= 0) reactionOrder.splice(idx, 1);
};

/** 尝试撤掉 bot 点过的表情；失败静默 */
export const tryRemoveStoredReaction = async (
  messageId: string,
): Promise<void> => {
  const entry = getStoredReaction(messageId);
  if (!entry) return;
  try {
    await removeReaction(messageId, entry.reactionId);
  } catch (err) {
    console.warn(
      "[feishu-bridge/reactions] 撤表情失败:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    forgetStoredReaction(messageId);
  }
};

const emojiForKind = (kind: InjectResultPayload["kind"]): string | null => {
  if (kind === "sent") return EMOJI_SENT;
  if (kind === "queued") return EMOJI_QUEUED;
  if (kind === "failed") return EMOJI_FAILED;
  return null;
};

const handleInjectResult = async (
  payload: InjectResultPayload,
): Promise<void> => {
  const emoji = emojiForKind(payload.kind);
  if (!emoji || !payload.messageId) return;
  try {
    const { reaction_id } = await addReaction(payload.messageId, emoji);
    rememberReaction(payload.messageId, reaction_id, emoji);
  } catch (err) {
    // 回执失败不影响注入主路径
    console.warn(
      "[feishu-bridge/reactions] 点表情失败:",
      err instanceof Error ? err.message : err,
    );
  }
};

/** 挂上 inject 结果监听（globalThis 幂等）；启动链由主线调 */
export const ensureReactionReceiptsRegistered = (): void => {
  const reg = getReg();
  if (reg.registered) return;
  reg.unsub = addInjectResultListener((p) => {
    void handleInjectResult(p);
  });
  reg.registered = true;
};

/** 单测重置 */
export const __resetReactionsForTest = (): void => {
  const reg = getReg();
  reg.unsub?.();
  reg.unsub = null;
  reg.registered = false;
  reactionByMessageId.clear();
  reactionOrder.length = 0;
};

/** 单测窥探 FIFO 顺序 */
export const __reactionOrderForTest = (): string[] => [...reactionOrder];
