/**
 * 飞书注入结果 emoji 回执（决策 #16）
 *
 * - sent → Get（用户指定 GET；实测键名大小写敏感，GET 非法）
 * - queued → Get（T8 用户拍板：不要 Typing 敲键盘动画、两态统一 Get）
 * - failed → CrossMark（❌）
 * - skipped → 不点
 *
 * reaction 失败静默降级（锦上添花、不影响注入）。
 *
 * queued/sent 两态同表情后 flush 升级逻辑已删（无需换表情）；
 * rememberReaction / tryRemoveStoredReaction 保留——撤回同步恢复时按 messageId 撤表情用。
 */

import {
  addInjectResultListener,
  type InjectResultPayload,
} from "./router";
import { addReaction, removeReaction } from "./lark-api";

/** 实测可用的 emoji_type（2026-07-18 lark-cli 试点） */
export const EMOJI_SENT = "Get";
export const EMOJI_QUEUED = "Get";
export const EMOJI_FAILED = "CrossMark";

const REACTION_MAP_MAX = 500;

type ReactionEntry = {
  messageId: string;
  reactionId: string;
  emojiType: string;
};

const REG_KEY = "__flowshipFeishuReactionReceiptsV1__";
/** R1-16：内存表挂 globalThis，避免 dev HMR 后「已注册但表空」、Typing→Get 丢上下文 */
const STATE_KEY = "__flowshipFeishuReactionStateV1__";

type ReactionsGlobal = {
  registered: boolean;
  unsubInject: (() => void) | null;
};

type ReactionsState = {
  /** messageId → 最近一次 bot 点的表情（撤回时撤 Typing 用） */
  byMessageId: Map<string, ReactionEntry>;
  /** FIFO 顺序，超上限淘汰最旧 */
  order: string[];
};

const getReg = (): ReactionsGlobal => {
  const g = globalThis as unknown as Record<string, ReactionsGlobal | undefined>;
  if (!g[REG_KEY]) {
    g[REG_KEY] = { registered: false, unsubInject: null };
  }
  return g[REG_KEY]!;
};

const getState = (): ReactionsState => {
  const g = globalThis as unknown as Record<string, ReactionsState | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      byMessageId: new Map(),
      order: [],
    };
  }
  return g[STATE_KEY]!;
};

const rememberReaction = (
  messageId: string,
  reactionId: string,
  emojiType: string,
): void => {
  if (!messageId || !reactionId) return;
  const { byMessageId, order } = getState();
  if (byMessageId.has(messageId)) {
    // 同 message 覆盖：从 FIFO 里摘掉旧位
    const idx = order.indexOf(messageId);
    if (idx >= 0) order.splice(idx, 1);
  }
  byMessageId.set(messageId, { messageId, reactionId, emojiType });
  order.push(messageId);
  while (order.length > REACTION_MAP_MAX) {
    const old = order.shift();
    if (old) byMessageId.delete(old);
  }
};

/** 查内存里 bot 点过的 reaction（Typing→Get 升级时撤旧表情用） */
export const getStoredReaction = (
  messageId: string,
): ReactionEntry | null => getState().byMessageId.get(messageId) ?? null;

/** 从内存忘掉（撤表情成功后 / 单测清理） */
export const forgetStoredReaction = (messageId: string): void => {
  const { byMessageId, order } = getState();
  if (!byMessageId.delete(messageId)) return;
  const idx = order.indexOf(messageId);
  if (idx >= 0) order.splice(idx, 1);
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

/** 挂上 inject 监听（globalThis 幂等）；启动链由主线调 */
export const ensureReactionReceiptsRegistered = (): void => {
  const reg = getReg();
  if (reg.registered) return;
  reg.unsubInject = addInjectResultListener((p) => {
    void handleInjectResult(p);
  });
  reg.registered = true;
};

/** 单测重置 */
export const __resetReactionsForTest = (): void => {
  const reg = getReg();
  reg.unsubInject?.();
  reg.unsubInject = null;
  reg.registered = false;
  const state = getState();
  state.byMessageId.clear();
  state.order.length = 0;
};

/** 单测窥探 FIFO 顺序 */
export const __reactionOrderForTest = (): string[] => [...getState().order];
