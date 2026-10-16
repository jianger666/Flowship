/**
 * ask 卡「作废」语义（M5-03）：作废标记 → 卡片终态 / 点旧卡时的反馈文案
 *
 * # 为什么单独成一个模块
 *
 * 一组 ask 的了结有四种出口：**答**、**跳过**、**取消 / 顶替 / 停止 / 重启 / 会话失效**、**过期**。
 * 前两种各有调用方在了结时置卡（card-action / ask-inject / ask-reply 路由 / ask-skip）；
 * 后两种历史上从不置卡——卡片原样挂着、按钮还能点，点了之后文案还一律说「已经有人回答了」。
 *
 * 这些作废路径都会经 `supersedePendingAsks` 写一条 `info` 事件（`meta.supersededAskId`），
 * 并经 `writeEventAndPublish` fanout 到全局 task 流 tap。所以不必去改 chat-pending / runner
 *（原子摄取 `takePendingAskIf` / `restorePendingAskIf` 与 ask-settle-state 的占位 / 终态
 * 刚修过、状态机不动）：在飞书桥接已订阅的 tap 里认出作废标记、调同一个置态收口点即可。
 *
 * 点旧卡的反馈同理：真相在事件流里（答 = `ask_user_reply`、跳过 / 过期 / 作废 = 标记事件），
 * 内存里的登记（pendingAsks / takenAsks）区分不了「答了」与「取消了」——两者都会把登记摘走。
 *
 * # 判定口径单一来源
 *
 * 事件级判定（isAskReplied / isAskSkipped / isAskExpired / isAskSuperseded）与题目解析
 *（extractAskQuestions）都复用 `@/lib/ask-pending`——前端回放行、ask-skip、ask-reply 用的就是这一套。
 */

import {
  ASK_EXPIRED_META_KEY,
  ASK_SKIPPED_META_KEY,
  extractAskQuestions,
  isAskExpired,
  isAskReplied,
  isAskSkipped,
  isAskSuperseded,
} from "@/lib/ask-pending";
import type { Task, TaskEvent } from "@/lib/types";

import {
  ASK_CARD_EXPIRED_HINT,
  ASK_CARD_EXPIRED_NOTE,
  ASK_CARD_SKIPPED_HINT,
  ASK_CARD_SKIPPED_NOTE,
  ASK_CARD_VOID_HINT,
  ASK_CARD_VOID_NOTE,
  settleAskCards,
} from "./ask-card-settle";

const LOG = "[feishu-bridge/ask-stale]";

/** 读 task（只用 events）——注入式，调用方各自传自己已有的 getTask（测试好换） */
export type LoadTaskEvents = (
  taskId: string,
) => Promise<Pick<Task, "events"> | null>;

// ----------------- 点旧卡：原因分流 -----------------

/**
 * 旧卡为什么点不了：
 * - answered：已有人答了（app / 飞书 / 群里打字）——**唯一**允许说「已经有人回答了」的情形
 * - skipped：用户没答、直接在 Flowship 发了新消息
 * - expired：等待超过 24 小时被收口
 * - voided：被取消 / 被新提问顶替 / 任务停止 / 重启 / 会话失效（标记已写，或槽位里已是别的 askId）
 * - unknown：没有任何了结证据（登记丢了、标记事件还没落盘、答题链正在投递）——说中性的「已失效」
 */
export type StaleAskReason =
  | "answered"
  | "skipped"
  | "expired"
  | "voided"
  | "unknown";

/**
 * 按事件流真相分类。优先级：已回答 > 跳过 > 过期 > 作废标记 > 槽位被别的 ask 占着 > 未知。
 *
 * 「已回答」排最前：答完后 agent 立刻抛新提问是常态，此时槽位里已是别的 askId，
 * 不能因此把一组真被答掉的提问说成「被取代」。
 *
 * @param currentPendingAskId 点击当下槽位里的 askId（空 = 没有登记）
 */
export const classifyStaleAsk = (
  events: TaskEvent[],
  askId: string,
  currentPendingAskId?: string | null,
): StaleAskReason => {
  if (isAskReplied(events, askId)) return "answered";
  if (isAskSkipped(events, askId)) return "skipped";
  if (isAskExpired(events, askId)) return "expired";
  if (isAskSuperseded(events, askId)) return "voided";
  if (currentPendingAskId && currentPendingAskId !== askId) return "voided";
  return "unknown";
};

/**
 * 读 task 事件并分类。读不到 / 读盘失败一律降级成 unknown——文案只是反馈，
 * 绝不能因为读盘失败让「点旧卡」整条分支抛出去。
 */
export const resolveStaleAskReason = async (
  loadTask: LoadTaskEvents,
  taskId: string,
  askId: string,
  currentPendingAskId?: string | null,
): Promise<StaleAskReason> => {
  try {
    const task = await loadTask(taskId);
    if (!task) return "unknown";
    return classifyStaleAsk(task.events, askId, currentPendingAskId);
  } catch (err) {
    console.warn(
      `${LOG} 读事件判定失效原因失败（降级成中性文案）:`,
      err instanceof Error ? err.message : err,
    );
    return "unknown";
  }
};

/**
 * 点旧卡后发给点击人的那句话。
 * @param audience owner = 私聊里回属主；group = 群里 @ 点击人
 */
export const staleAskReplyText = (
  reason: StaleAskReason,
  audience: "owner" | "group",
): string => {
  switch (reason) {
    case "answered":
      return audience === "group"
        ? "这个问题已经有人回答了"
        : "该问题已回答（可能已在 app / 飞书另一侧提交），无需再答。";
    case "skipped":
      return "这组提问已跳过（用户在 Flowship 里继续了对话），无需再答。";
    case "expired":
      return "这组提问已过期（等待超过 24 小时），无需再答。";
    case "voided":
      return "这组提问已失效（已被取消、或被新的提问取代），无需再答。";
    case "unknown":
      return audience === "group"
        ? "这个问题已失效或已被回答，无需再答。"
        : "该问题已失效或已回答（可能已在 app / 飞书另一侧提交），无需再答。";
  }
};

/** 被点的那颗按钮替换成的提示（卡片上的反馈，与 {@link staleAskReplyText} 同一分类） */
export const staleAskButtonText = (reason: StaleAskReason): string => {
  switch (reason) {
    case "answered":
      return "⚠️ 该问题已回答";
    case "skipped":
      return "⚠️ 该问题已跳过";
    case "expired":
      return "⚠️ 该问题已过期";
    case "voided":
      return "⚠️ 该问题已失效";
    case "unknown":
      return "⚠️ 该问题已失效或已回答";
  }
};

// ----------------- 作废标记 → 卡片终态 -----------------

export type AskVoidKind = "skipped" | "expired" | "voided";

/**
 * 这条事件是不是「某组 ask 被作废」的标记（info + meta.supersededAskId）。
 * 判据与 ask-pending 的了结判定同源；跳过 / 过期是它的子集，靠额外的布尔位区分。
 */
export const parseAskVoidMarker = (
  event: Pick<TaskEvent, "kind" | "meta">,
): { askId: string; kind: AskVoidKind } | null => {
  if (event.kind !== "info") return null;
  const askId = event.meta?.supersededAskId;
  if (typeof askId !== "string" || !askId) return null;
  const kind: AskVoidKind =
    event.meta?.[ASK_SKIPPED_META_KEY] === true
      ? "skipped"
      : event.meta?.[ASK_EXPIRED_META_KEY] === true
        ? "expired"
        : "voided";
  return { askId, kind };
};

const NOTES_BY_KIND: Record<AskVoidKind, { note: string; hint: string }> = {
  // 与 ask-skip.commitAskSkip 自己置态用的是同一份文案——两条链谁先到都是同一个结果
  skipped: { note: ASK_CARD_SKIPPED_NOTE, hint: ASK_CARD_SKIPPED_HINT },
  expired: { note: ASK_CARD_EXPIRED_NOTE, hint: ASK_CARD_EXPIRED_HINT },
  voided: { note: ASK_CARD_VOID_NOTE, hint: ASK_CARD_VOID_HINT },
};

/**
 * 作废标记 → 把这组 ask 的所有承载卡（私聊流式卡 + 需求群答题卡）置成终态。
 * 非作废标记直接返回 0。**绝不抛**；幂等靠 settleAskCards 的占坑（先到先得，
 * 已被「答」置过态的不会被覆盖成「已失效」）。
 *
 * 题目从 task 事件里的 `ask_user_request` 取（settle 要按题目算问题区 element_id）；
 * 取不到就放手——宁可不动卡，也不能凭空造题目去 patch。
 */
export const settleAskCardsOnVoidMarker = async (
  taskId: string,
  event: Pick<TaskEvent, "kind" | "meta">,
  loadTask: LoadTaskEvents,
): Promise<number> => {
  const marker = parseAskVoidMarker(event);
  if (!marker) return 0;
  try {
    const task = await loadTask(taskId);
    if (!task) return 0;
    // 同一 askId 理论上只有一条请求事件；倒序找以防脏数据重复
    const request = [...task.events]
      .reverse()
      .find(
        (e) =>
          e.kind === "ask_user_request" &&
          typeof e.meta?.askId === "string" &&
          e.meta.askId === marker.askId,
      );
    const questions = request ? extractAskQuestions(request.meta) : [];
    if (questions.length === 0) return 0;
    const notes = NOTES_BY_KIND[marker.kind];
    return await settleAskCards({
      taskId,
      askId: marker.askId,
      questions,
      fallbackNote: notes.note,
      hintNote: notes.hint,
    });
  } catch (err) {
    console.warn(
      `${LOG} 作废标记置卡失败 task=${taskId} ask=${marker.askId}（静默）:`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
};
