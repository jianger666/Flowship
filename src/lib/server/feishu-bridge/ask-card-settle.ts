/**
 * ask 卡片终态置态（p2p 流式卡 + 需求群答题卡的**唯一**收口点）
 *
 * # 为什么要有它（欠账根因）
 *
 * 原来「答完把按钮换成一句话」只写在 card-action 的两个按钮分支里——也就是只有
 * 「**从这张卡点按钮**答的」才置态。从别处了结（app 答题卡答完 / 群里打字作答 /
 * 用户直接发新消息跳过）时，群里那张橙色「待确认」卡原样挂着，看着还像待答。
 *
 * 收敛办法：了结这组 ask 的每条链都调本模块一次，本模块按 `(taskId, askId)` 反查
 * **所有**承载卡（card-map 的 ask 索引）挨个 patch。谁了结的不重要、卡片状态只有一份真相。
 *
 * # 幂等
 *
 * 一组 ask 只置一次态（`claimAskCardSettle` 同步占坑、中间零 await）：先到先得，
 * 后到的直接返回。**一张都没发成功才退坑**（部分成功不退——退了会把已置态的卡再刷一遍）。
 *
 * # 绝不抛
 *
 * 置态是答题 / 跳过之后的增强动作，任何一步失败只 warn。调用方不需要处理返回值。
 */

import type { AskUserQuestion } from "@/lib/types";

import { findAskCards } from "./card-map";
import { nextCardSequence } from "./card-seq";
import { askOptionElementId, askQuestionElementId } from "./card-stream";
import { GROUP_ASK_HINT_ELEMENT_ID } from "./group-ask-card";
import { batchUpdateCard } from "./lark-api";

const LOG = "[feishu-bridge/ask-card-settle]";

// ----------------- 幂等占坑（挂 globalThis、对齐 group-shared 的防重表） -----------------

/** 占坑保留时长——只为「同一组 ask 别置两次态」，无需长期留存 */
const SETTLE_TTL_MS = 24 * 60 * 60 * 1000;

const SETTLE_KEY = "__flowshipAskCardSettledV1__";

const getSettleMap = (): Map<string, number> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, number> | undefined
  >;
  if (!g[SETTLE_KEY]) g[SETTLE_KEY] = new Map();
  return g[SETTLE_KEY]!;
};

const settleKey = (taskId: string, askId: string): string =>
  `${taskId}\0${askId}`;

/**
 * 同步原子占坑：这组 ask 的卡片还没人置过态才占上、返 true。
 * 「先占再 patch」而不是「patch 完再记」——并发两次调用第二次必然被挡。
 */
export const claimAskCardSettle = (taskId: string, askId: string): boolean => {
  if (!taskId || !askId) return false;
  const now = Date.now();
  const m = getSettleMap();
  // 顺手清过期条目——置态是低频动作，随调随清足够，不另起定时器
  for (const [k, at] of m) {
    if (now - at > SETTLE_TTL_MS) m.delete(k);
  }
  const k = settleKey(taskId, askId);
  if (m.has(k)) return false;
  m.set(k, now);
  return true;
};

/** 一张卡都没 patch 成功时退坑——下一条了结链该允许再试 */
const releaseAskCardSettle = (taskId: string, askId: string): void => {
  getSettleMap().delete(settleKey(taskId, askId));
};

/** 这组 ask 的卡片已经置过终态了吗（失效分支据此跳过多余的单按钮 patch） */
export const isAskCardSettled = (taskId: string, askId: string): boolean =>
  getSettleMap().has(settleKey(taskId, askId));

/** 单测重置占坑表 */
export const __resetAskCardSettleForTest = (): void => {
  getSettleMap().clear();
};

// ----------------- 置态 -----------------

export interface AskCardSettleInput {
  taskId: string;
  askId: string;
  /** 本组题目（含 options：按钮 element_id 要按它算出来删） */
  questions: AskUserQuestion[];
  /**
   * 每题的终态说明（key=questionId）。
   * 「已选择：X」这类具体文案由调用方给；没给的题用 {@link fallbackNote}。
   */
  noteByQuestion?: Record<string, string>;
  /** 兜底说明（没有逐题文案时用）——如「已跳过」/「已在 Flowship 里回答」 */
  fallbackNote: string;
  /** 群答题卡的说明行（「也可以 @机器人 直接回复文字作答」）换成这句 */
  hintNote: string;
}

const warnFail = (op: string, err: unknown): void => {
  console.warn(`${LOG} ${op} 失败（静默）:`, err instanceof Error ? err.message : err);
};

/**
 * 把一张卡上这组 ask 的问题区全部换成终态：删掉全部选项按钮 + 问题 markdown 附上说明。
 * 群答题卡多一步——把「还能怎么答」的说明行也换掉（p2p 卡没有这个 element、
 * 飞书会忽略不存在的 element_id，两种卡共用同一份 actions 不必分叉）。
 */
const patchOneCard = async (
  cardId: string,
  input: AskCardSettleInput,
): Promise<void> => {
  const actions: unknown[] = [];
  const buttonIds: string[] = [];
  for (const q of input.questions) {
    for (const opt of q.options ?? []) {
      buttonIds.push(askOptionElementId(input.askId, q.id, opt.id));
    }
  }
  if (buttonIds.length > 0) {
    actions.push({
      action: "delete_elements",
      params: { element_ids: buttonIds },
    });
  }
  for (const q of input.questions) {
    const elementId = askQuestionElementId(input.askId, q.id);
    const note = input.noteByQuestion?.[q.id] ?? input.fallbackNote;
    actions.push({
      action: "update_element",
      params: {
        element_id: elementId,
        element: {
          tag: "markdown",
          element_id: elementId,
          content: `**${q.question}**\n\n${note}`,
        },
      },
    });
  }
  actions.push({
    action: "update_element",
    params: {
      element_id: GROUP_ASK_HINT_ELEMENT_ID,
      element: {
        tag: "markdown",
        element_id: GROUP_ASK_HINT_ELEMENT_ID,
        content: input.hintNote,
      },
    },
  });
  await batchUpdateCard(cardId, actions, nextCardSequence(cardId));
};

/**
 * 把这组 ask 的所有承载卡置成终态。**绝不抛**、幂等（重复调直接跳过）。
 *
 * @returns 实际 patch 成功的卡片数（单测断言用；调用方不需要消费）
 */
export const settleAskCards = async (
  input: AskCardSettleInput,
): Promise<number> => {
  const { taskId, askId } = input;
  if (!taskId || !askId || input.questions.length === 0) return 0;
  if (!claimAskCardSettle(taskId, askId)) return 0;

  let cards: Awaited<ReturnType<typeof findAskCards>> = [];
  try {
    cards = await findAskCards(taskId, askId);
  } catch (err) {
    warnFail("findAskCards", err);
  }

  let patched = 0;
  for (const card of cards) {
    try {
      await patchOneCard(card.cardId, input);
      patched += 1;
    } catch (err) {
      warnFail(`patch 卡片 card=${card.cardId}`, err);
    }
  }
  // 一张都没置成（含「压根没记上卡」：桥接没开 / 卡没发出去 / 索引还没落盘）→ 退坑。
  // 留着坑等于把「还没置过态」记成「已置态」，后面真有卡时反而不会再置
  if (patched === 0) releaseAskCardSettle(taskId, askId);
  return patched;
};

/** 「用户直接发了新消息、这组提问被跳过」的终态文案（p2p / 群共用一份） */
export const ASK_CARD_SKIPPED_NOTE = "（已跳过：用户在 Flowship 里继续了对话）";
export const ASK_CARD_SKIPPED_HINT = "这组提问已跳过、无需再回答";

/** 「在别处答掉了」的兜底文案（app 答题卡 / 群里打字作答都用它） */
export const ASK_CARD_ANSWERED_HINT = "这组提问已回答、无需再答";
