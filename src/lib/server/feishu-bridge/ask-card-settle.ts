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
 * # 失败后台重试（M5-02）
 *
 * `batch_update` 是 POST：lark-api 的传输层重试只覆盖 GET / 「请求发出前就断了」，
 * 「请求已发出、响应路上断了」这类瞬时失败会原样抛到这里。旧实现一次即弃——那张卡停在
 * 「等待回答」且按钮还能点。现在对**瞬时传输失败**做有限（2 次）带退避的**后台**重试：
 * 不阻塞调用方（调用方在答案已送达后才来置态，没必要陪它等）、业务拒绝（权限 / 参数）不重试。
 * 幂等性见 {@link retryPatchInBackground}。
 *
 * # 绝不抛
 *
 * 置态是答题 / 跳过之后的增强动作，任何一步失败只 warn。调用方不需要处理返回值。
 */

import type { AskUserQuestion } from "@/lib/types";

import { findAskCards } from "./card-map";
import { nextCardSequence } from "./card-seq";
import {
  claimAskCardSettle,
  isAskCardPatched,
  markAskCardPatched,
  recordAskCardSettledView,
  releaseAskCardSettle,
} from "./ask-settle-state";
import {
  ASK_HINT_ELEMENT_ID,
  askQuestionElementId,
  askRenderedOptionElementIds,
} from "./card-stream";
import { GROUP_ASK_HINT_ELEMENT_ID } from "./group-ask-card";
import { batchUpdateCard } from "./lark-api";
import { isTransientLarkError, LarkApiError } from "./types";
import type { CardMapEntry } from "./types";

const LOG = "[feishu-bridge/ask-card-settle]";

// 幂等占坑 + 终态视图登记表在 ask-settle-state（card-stream 整包 PUT 也要读它，拆开避免循环依赖）
export {
  __resetAskCardSettleForTest,
  claimAskCardSettle,
  isAskCardSettled,
} from "./ask-settle-state";

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

// ----------------- 失败后台重试（M5-02） -----------------

/**
 * 退避间隔（毫秒）：首次失败后依次等这些时间各重试一次——**共 2 次重试**，之后放弃。
 * 间隔取「够飞书 / 网络缓一口气、又不至于让用户盯着一张没置态的卡太久」的量级；
 * 重试跑在后台、不占调用方的时间，所以不必像同步重试那样抠。
 */
const RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000];

type ScheduleRetry = (cb: () => void, ms: number) => unknown;

/** 默认调度：unref——重试只是锦上添花，不该因为它拖住进程退出 */
const defaultSchedule: ScheduleRetry = (cb, ms) => {
  const t = setTimeout(cb, ms);
  (t as { unref?: () => void }).unref?.();
  return t;
};
let scheduleRetry: ScheduleRetry = defaultSchedule;

/** 单测注入调度器（不真等计时）；传 null 复原 */
export const __setAskSettleRetryForTest = (
  opts: { schedule?: ScheduleRetry } | null,
): void => {
  scheduleRetry = opts?.schedule ?? defaultSchedule;
};

/**
 * 这次失败值不值得重试：只重试「没走完一次完整往返」的瞬时传输失败（判据与 lark-api 的
 * 传输层重试同源：types.isTransientLarkError）+ lark-cli 超时（响应可能只是丢了）。
 * 权限不足 / 参数非法 / 卡不存在这类业务拒绝重试多少次都是同一个结果，直接放弃。
 */
const isRetryableSettleError = (err: unknown): boolean =>
  isTransientLarkError(err) ||
  (err instanceof LarkApiError && err.message.includes("超时"));

const warnFail = (op: string, err: unknown): void => {
  console.warn(`${LOG} ${op} 失败（静默）:`, err instanceof Error ? err.message : err);
};

/**
 * 这张承载卡上「还能怎么答」说明行的 element_id——两种卡各有各的：
 * 私聊流式卡 `md_ask_hint`、群答题卡 `md_gask_hint`。
 *
 * 判据：card-map 条目的路由判据 `taskId`。群答题卡出卡时刻意记**空串**（不参与 p2p 回复锚定，
 * 见 group-outbound.sendAskCardToGroup），私聊流式卡记真实 taskId。
 * 不能「两个 id 都发、让飞书忽略不存在的」：飞书对不存在的 element_id 行为不可靠
 *（可能整批 batch_update 报错 → 这张卡的按钮都删不掉），且旧实现正是只发了群卡的 id，
 * 私聊卡答完后提示行永远是「没有合适选项？直接回复消息作答」。
 * 这条约定由 tests/ask-card-settle-element-contract.test.ts 用两条真实出卡路径对账。
 */
const hintElementIdOf = (card: Pick<CardMapEntry, "taskId">): string =>
  card.taskId ? ASK_HINT_ELEMENT_ID : GROUP_ASK_HINT_ELEMENT_ID;

/**
 * 把一张卡上这组 ask 的问题区全部换成终态：删掉全部选项按钮 + 问题 markdown 附上说明
 * + 把「还能怎么答」说明行换成终态文案（按卡种取各自的提示行 id，见 {@link hintElementIdOf}）。
 * 按钮 / 问题行的 element_id 由 (askId, questionId, optionId) 哈希得出、两种卡共用同一套 helper。
 */
const patchOneCard = async (
  card: Pick<CardMapEntry, "cardId" | "taskId">,
  input: AskCardSettleInput,
): Promise<void> => {
  const cardId = card.cardId;
  const hintId = hintElementIdOf(card);
  const actions: unknown[] = [];
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
      element_id: hintId,
      element: {
        tag: "markdown",
        element_id: hintId,
        content: input.hintNote,
      },
    },
  });
  // 删按钮**必须排在所有 update_element 之后**：飞书 batch_update 是否原子 / 遇错是否中止没有
  // 证据，按最坏情形设计——若请求中途断线（前几个 action 已生效、响应丢了），重试时已删掉的按钮
  // 不在了，delete 会被拒；delete 在前就会把后面的 update（问题区说明 / 提示行）一并拦下，
  // 卡片没了按钮却还写着「等待回答」。update 是整元素覆盖、重做幂等，排前面则无论哪种语义都能收敛。
  // 顺序由 tests/ask-card-settle-element-contract.test.ts 的「重试收敛」用例钉死。
  //
  // 只删「这张卡实际渲染过的」按钮：多题卡压根不出按钮（review P1#5），照着题目的 options
  // 推 id 去删会命中不存在的元素——飞书对此行为不可靠、可能整批报错（M5-01）。
  // 「渲染了哪些按钮」的唯一来源是 card-stream.askRenderedOptionElementIds（构造器同源判据）
  const buttonIds = askRenderedOptionElementIds(input.askId, input.questions);
  if (buttonIds.length > 0) {
    actions.push({
      action: "delete_elements",
      params: { element_ids: buttonIds },
    });
  }
  await batchUpdateCard(cardId, actions, nextCardSequence(cardId));
};

/**
 * 一张卡 patch 瞬时失败后，在后台按退避重试（不阻塞调用方、最多 {@link RETRY_DELAYS_MS} 次）。
 *
 * 为什么重试安全（幂等）：
 * - `update_element`（问题区 / 提示行）是整元素覆盖，天然幂等；
 * - `delete_elements`：若上一次其实已生效（只是响应丢了），重试时目标已不在——这一批可能被
 *   飞书拒掉，多一条 warn。它在 patchOneCard 里**排在所有 update_element 之后**：即便飞书非原子、
 *   遇错即中止，被拒的也只剩这最后一步（因「目标已不在」被拒就说明按钮早已删掉），
 *   前面的 update 都已先执行、不会被它拖下水；若上一次没生效，重试把它补齐；
 * - 每次重试都向 card-seq 要**新的**递增 sequence，不复用失败那次的号。
 * 醒来时若这张卡已被别的链（占坑退掉后重新占坑的那条）置好，就跳过：既省一次飞书调用，
 * 也不让陈旧文案盖掉后到那条链的终态。
 */
const retryPatchInBackground = (
  card: Pick<CardMapEntry, "cardId" | "taskId">,
  input: AskCardSettleInput,
  attempt: number,
): void => {
  const delay = RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    console.warn(
      `${LOG} patch 卡片 card=${card.cardId} 重试 ${RETRY_DELAYS_MS.length} 次仍失败、放弃` +
        "（卡片按钮仍可能残留，点击会走失效分支）",
    );
    return;
  }
  scheduleRetry(() => {
    void (async () => {
      const { taskId, askId } = input;
      if (isAskCardPatched(taskId, askId, card.cardId)) return;
      try {
        await patchOneCard(card, input);
        markAskCardPatched(taskId, askId, card.cardId);
        // 首轮全失败时占坑已退；卡现在确实是终态了，把占坑补回来：之后的了结链别再重复置态、
        // 点旧卡的单按钮 patch（isAskCardSettled）也该跳过一颗早已删掉的按钮。
        // 已被别的链占着就是 false、不动它
        claimAskCardSettle(taskId, askId);
      } catch (err) {
        warnFail(`重试 patch 卡片 card=${card.cardId}（第 ${attempt + 1} 次）`, err);
        if (isRetryableSettleError(err)) {
          retryPatchInBackground(card, input, attempt + 1);
        }
      }
    })();
  }, delay);
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
  // 同步补终态视图（零 await）：卡片流式整包 PUT 据此渲染「已了结」、不把按钮带回来
  recordAskCardSettledView(taskId, askId, {
    noteByQuestion: input.noteByQuestion,
    fallbackNote: input.fallbackNote,
    hintNote: input.hintNote,
  });

  let cards: Awaited<ReturnType<typeof findAskCards>> = [];
  try {
    cards = await findAskCards(taskId, askId);
  } catch (err) {
    warnFail("findAskCards", err);
  }

  let patched = 0;
  for (const card of cards) {
    try {
      await patchOneCard(card, input);
      markAskCardPatched(taskId, askId, card.cardId);
      patched += 1;
    } catch (err) {
      warnFail(`patch 卡片 card=${card.cardId}`, err);
      if (isRetryableSettleError(err)) retryPatchInBackground(card, input, 0);
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

/**
 * 「取消 / 被新提问顶替 / 任务被停止 / 重启 / 会话失效」的终态文案（M5-03）。
 * 这些路径没有人答、也不是用户主动跳过——卡上不能冒充「已回答」，也不能继续挂着按钮。
 */
export const ASK_CARD_VOID_NOTE = "（已失效：这组提问已被取消或被新的提问取代）";
export const ASK_CARD_VOID_HINT = "这组提问已失效、无需再回答";

/** 「等待超过 24 小时、本轮已结束」的终态文案 */
export const ASK_CARD_EXPIRED_NOTE = "（已过期：等待超过 24 小时）";
export const ASK_CARD_EXPIRED_HINT = "这组提问已过期、无需再回答";
