/**
 * ask 答题卡的草稿 key / 清理 / 选择态还原（纯逻辑、可在 node 单测）
 *
 * 背景（丢用户输入）：AskUserInlineCard 渲染在事件流（Virtuoso 虚拟列表）里，用户上滚离开视口
 * 超过 overscan（1500px）该项就被卸载——选项、文字、图片原先全放组件 `useState`，卸载即丢，
 * 滚回来是一张空白卡。
 *
 * 做法：**复用现有草稿机制**（view-memory 的 `DraftScope` + `useRichInput({ draft })`），
 * 不另造一套：每题一个草稿位，正文进 sessionStorage、图进附件快照；本模块补
 *  - key 约定：`${taskId}:${askId}:${questionId}`（按任务 + 提问 + 题目隔离，A 卡的字绝不串进 B 卡）
 *  - 提交成功 / 提问作废后的清理（clear 一张卡、prune 一个任务名下过期的卡）
 *  - 选择态（选项 / 自定义模式）还原时的一致性校验
 */

import {
  clearAskDraftsWhere,
  type AskChoiceDraft,
} from "@/lib/view-memory";

/** 单题草稿位 id（DraftScope="ask" 下的 id） */
export const askDraftId = (
  taskId: string,
  askId: string,
  questionId: string,
): string => `${taskId}:${askId}:${questionId}`;

/** 一张卡（某 ask）名下所有题目的 id 前缀 */
const askCardPrefix = (taskId: string, askId: string): string =>
  `${taskId}:${askId}:`;

/** 提交成功（含「稍后再补充」）后清掉这张卡全部草稿：正文 + 图 + 选择态 */
export const clearAskDrafts = (taskId: string, askId: string): void => {
  const prefix = askCardPrefix(taskId, askId);
  clearAskDraftsWhere((id) => id.startsWith(prefix));
};

/**
 * 回收一个任务名下「已不是当前待答」的答题卡草稿：已答 / 已作废 / 换了新 ask 的都没用了。
 * keepAskId = 当前待答 ask（null = 没有待答，该任务全部清掉）。
 * 只动本任务的草稿，别的任务不碰。
 */
export const pruneAskDrafts = (
  taskId: string,
  keepAskId: string | null,
): void => {
  const taskPrefix = `${taskId}:`;
  const keepPrefix = keepAskId ? askCardPrefix(taskId, keepAskId) : null;
  clearAskDraftsWhere(
    (id) =>
      id.startsWith(taskPrefix) && !(keepPrefix && id.startsWith(keepPrefix)),
  );
};

/**
 * 还原单题的选择态（挂载时算一次初值）。
 *
 * 一致性规则（防「输入框被藏起来、内容却被提交」）：
 *  - 没有选项的纯文本题：恒为自定义模式
 *  - 记着的 optionId 已不在题目选项里（题目变了）：丢弃
 *  - 选了固定选项：不在自定义模式（选项与自定义文本互斥）
 *  - 没选选项：记着「自定义回答」、或草稿里有正文 / 图（如 reload 后内存里的选择态没了、
 *    sessionStorage 里的正文还在）→ 自定义模式，否则输入框是藏着的、正文却被当成答案
 */
export const resolveInitialAskChoice = (
  question: { options?: ReadonlyArray<{ id: string }> },
  saved: AskChoiceDraft | undefined,
  restored: { hasText: boolean; hasImages: boolean },
): AskChoiceDraft => {
  const hasOptions = !!question.options && question.options.length > 0;
  if (!hasOptions) return { optionId: undefined, otherMode: true };
  const optionId =
    saved?.optionId && question.options!.some((o) => o.id === saved.optionId)
      ? saved.optionId
      : undefined;
  if (optionId) return { optionId, otherMode: false };
  return {
    optionId: undefined,
    otherMode:
      saved?.otherMode === true || restored.hasText || restored.hasImages,
  };
};
