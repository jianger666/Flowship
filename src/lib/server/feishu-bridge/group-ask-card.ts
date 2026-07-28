/**
 * 需求群答题卡（第二批 · 跨角色答题）
 *
 * 与 p2p 流式卡里的 ask 区块（card-stream.buildAskElements）同构、两点不同：
 * 1. 按钮 value 用 `kind: "group_ask"`——card-action 分发时**不过** owner 闸，
 *    群里任何人都能替本机任务答题；
 * 2. 是一张独立的静态卡（不是流式卡的一段），发到群 chat_id。
 *
 * element_id 复用 card-stream 的短哈希 helper（CardKit ≤20 字符硬约束单一来源）——
 * 卡片实体不同、id 撞不上；答完置态的 patch 也就能跟 p2p 走同一套 helper。
 */

import { askOptionElementId, askQuestionElementId } from "./card-stream";
import type { CardButtonValue, CardStreamAskQuestion } from "./types";

/** 群答题卡「还能不能答」的说明行 element_id（答完置态时整行替换） */
export const GROUP_ASK_HINT_ELEMENT_ID = "md_gask_hint";

export interface GroupAskCardInput {
  /** 需求名（卡片 header，取工作项名 / task 标题） */
  requirementName: string;
  taskId: string;
  chatId: string;
  askId: string;
  questions: CardStreamAskQuestion[];
  /** 本机用户名（footer 署名，说明这个提问来自谁的 Flowship） */
  senderName: string;
}

/**
 * 构建群答题卡 JSON（纯函数、无副作用）。
 *
 * 多题只渲染 markdown、不出按钮——与 p2p 同口径（review P1#5）：一点即整组提交、
 * 未点题会被填「（未回答）」误推进；多题请群里 @bot 直接打字作答。
 */
export const buildGroupAskCardJson = (
  input: GroupAskCardInput,
): Record<string, unknown> => {
  const elements: unknown[] = [];
  const singleQuestion = input.questions.length === 1;

  for (const q of input.questions) {
    elements.push({
      tag: "markdown",
      element_id: askQuestionElementId(input.askId, q.id),
      content: `**${q.question}**`,
    });
    if (!singleQuestion || !q.options?.length) continue;
    for (const opt of q.options) {
      const value: CardButtonValue = {
        kind: "group_ask",
        taskId: input.taskId,
        askId: input.askId,
        questionId: q.id,
        optionId: opt.id,
        chatId: input.chatId,
      };
      elements.push({
        tag: "button",
        element_id: askOptionElementId(input.askId, q.id, opt.id),
        text: { tag: "plain_text", content: opt.label },
        type: "default",
        size: "medium",
        width: "default",
        behaviors: [{ type: "callback", value }],
      });
    }
  }

  elements.push({
    tag: "markdown",
    element_id: GROUP_ASK_HINT_ELEMENT_ID,
    content: "也可以 @机器人 直接回复文字作答（先答的算数）",
  });
  elements.push({ tag: "hr", element_id: "hr_gask_foot" });
  elements.push({
    tag: "markdown",
    element_id: "md_gask_footer",
    content: `来自 ${input.senderName} · Flowship`,
  });

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: {
        tag: "plain_text",
        content: `${input.requirementName} · 待确认`.slice(0, 50),
      },
      template: "orange",
      subtitle: { tag: "plain_text", content: "疑问" },
    },
    body: { elements },
  };
};
