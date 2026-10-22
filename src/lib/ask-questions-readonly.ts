/**
 * 失效 / 断线的提问卡：只读题干的取数（第二轮 review V6-01）
 *
 * 为什么要有：失效态的答题卡 / 「已失效」的回放行原先只剩一行灰字，
 * 却叫用户「在底部输入条说句话，AI 会读历史（含这组问题）继续」——用户看不到 AI 问了什么。
 * 这里只负责「拿什么给用户看」，题目的解析仍走 `extractAskQuestions`（单一源，不自己再写一份）。
 *
 * 纯函数（client / server 都能 import、不依赖 React）。
 */

import { extractAskQuestions } from "./ask-pending";
import type { TaskEvent } from "./types";

/** 展开钮文案：固定，不拼题数（题数卡头已经写了「AI 提过 N 个问题」） */
export const ASK_QUESTIONS_READONLY_LABEL = "查看这组问题";

export interface ReadonlyAskQuestion {
  /** React key */
  key: string;
  /** 题号标签（`Q1`）；退回事件原文时为空串（原文自带 `Q1:` 前缀、不重复加） */
  label: string;
  text: string;
}

export interface ReadonlyAskQuestionsView {
  items: ReadonlyAskQuestion[];
  /** true = 来自结构化的 meta.questions；false = meta 丢了、退回事件原文 */
  fromMeta: boolean;
}

/**
 * 取只读题干。
 * - meta.questions 有可用题目：按序号列出（脏条目由 extractAskQuestions 跳过，序号只数留下来的）
 * - 没有（老事件 / 脏数据）：退回事件原文整段当一项——总比什么都没有强
 * - 两边都没内容：items 为空，组件据此什么都不画（不留一个点开是空的展开钮）
 */
export const readonlyAskQuestions = (
  meta: TaskEvent["meta"],
  fallbackText: string | undefined,
): ReadonlyAskQuestionsView => {
  const questions = extractAskQuestions(meta);
  if (questions.length > 0) {
    return {
      fromMeta: true,
      items: questions.map((q, idx) => ({
        key: q.id,
        label: `Q${idx + 1}`,
        text: q.question,
      })),
    };
  }
  const text = fallbackText?.trim() ?? "";
  return {
    fromMeta: false,
    items: text ? [{ key: "fallback", label: "", text }] : [],
  };
};
