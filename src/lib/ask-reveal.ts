/**
 * 「新提问出现时，把被放大遮住的那栏还原」的纯判定（审核 R8-05 ①）。
 *
 * 背景：浏览器「放大」会把聊天页的对话栏盖住（inert、宽 0）/ 把任务页的事件流栏折叠，而 ask_user 的答题卡就在那一栏里。
 * 系统通知在「窗口聚焦且正看着这个任务」时静音（见 task-attention-watcher），头部虽有「待回答」徽标但不显眼——
 * AI 停下来等人、人却在看浏览器，卡片被藏着没人答。所以新提问出现的那一刻，把放大造成的遮挡还原。
 *
 * 只认「上升沿」（出现一条**新的**待回答提问）：用户看到提问后又自己放大浏览器，不会被反复拉回来；
 * 页面打开时就已经在等的提问也不算新（此时本来就没有遮挡）。纯函数、client / server 都能用，有单测。
 */

import { findPendingAskEvent } from "./ask-pending";
import type { TaskEvent } from "./types";

/** 当前待回答提问的 askId（没有 = null）。同一条提问在事件继续增长时 id 不变，所以拿它做「是不是新的」判据 */
export const pendingAskIdOf = (events: readonly TaskEvent[] | null | undefined): string | null => {
  if (!events) return null;
  const askId = findPendingAskEvent(events as TaskEvent[])?.meta?.askId;
  return typeof askId === "string" ? askId : null;
};

/**
 * 这一次变化要不要还原被遮住的栏：出现了一条与上一次不同的待回答提问，且它所在的栏此刻被遮住。
 * （上一条被答掉 → 新提问：prev 先变 null 再变新 id；上一条被作废、直接换成新提问：id 直接变——都算新的。）
 */
export const shouldRevealForNewAsk = (
  prevAskId: string | null,
  nextAskId: string | null,
  hidden: boolean,
): boolean => nextAskId !== null && nextAskId !== prevAskId && hidden;
