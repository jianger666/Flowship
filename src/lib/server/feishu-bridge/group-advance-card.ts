/**
 * 需求群「推进」action 选择卡（群内推进第二形态）
 *
 * 群里只发「推进」（不带 action 名）时回这张卡：按组列出该任务当前可推进的
 * action 按钮（数据源 = server 复算的推进弹窗同款清单、见 advance-options.ts）。
 * 属主点按钮 → card.action.trigger 回调（kind: "group_advance"）→ 开跑该 action。
 *
 * 与群答题卡（group-ask-card）同族：独立静态卡、发到群 chat_id；
 * 按钮 value 自带 taskId / chatId / actionKey / pickId，回调侧不依赖 card-map。
 * 属主校验在回调侧做（非属主点了要回群提示、不是静默丢弃）。
 */

import type { AdvanceOptionGroup } from "@/lib/server/advance-options";

import type { CardButtonValue } from "./types";

/** 按钮上限——飞书卡片不宜堆太多按钮，超出的提示去应用内选 */
export const GROUP_ADVANCE_MAX_BUTTONS = 20;

/** 超出按钮上限时的提示行（单测按字面断言） */
export const GROUP_ADVANCE_OVERFLOW_HINT =
  "action 较多、只列出前 20 个，更多请在 Flowship 推进弹窗里选";

export interface GroupAdvanceCardInput {
  /** 需求名（卡片 header，取 task 标题） */
  requirementName: string;
  taskId: string;
  chatId: string;
  /** 本张卡的一次性标识（防同卡重复点击、见 group-shared 占坑表） */
  pickId: string;
  /** 分组后的可推进项（advance-options 的输出、空组已滤掉） */
  groups: AdvanceOptionGroup[];
  /** 本机用户名（footer 署名） */
  senderName: string;
}

/**
 * 构建推进选择卡 JSON（纯函数、无副作用）。
 * 组头 markdown + 组内按钮；按钮总数超过 GROUP_ADVANCE_MAX_BUTTONS 截断并加提示行。
 */
export const buildGroupAdvanceCardJson = (
  input: GroupAdvanceCardInput,
): Record<string, unknown> => {
  const elements: unknown[] = [];
  let buttonCount = 0;
  let truncated = false;

  for (const group of input.groups) {
    if (group.options.length === 0) continue;
    if (buttonCount >= GROUP_ADVANCE_MAX_BUTTONS) {
      truncated = true;
      break;
    }
    elements.push({
      tag: "markdown",
      // element_id ≤20 字符硬约束——组 key 最长 "builtin"（7），拼出来 ≤13
      element_id: `md_gadv_${group.key}`,
      content: `**${group.label}**`,
    });
    for (const opt of group.options) {
      if (buttonCount >= GROUP_ADVANCE_MAX_BUTTONS) {
        truncated = true;
        break;
      }
      buttonCount += 1;
      const value: CardButtonValue = {
        kind: "group_advance",
        taskId: input.taskId,
        chatId: input.chatId,
        pickId: input.pickId,
        actionKey: opt.key,
        label: opt.label,
      };
      elements.push({
        tag: "button",
        element_id: `gadv_b${buttonCount}`,
        text: { tag: "plain_text", content: opt.label.slice(0, 20) || "推进" },
        type: "default",
        size: "medium",
        width: "default",
        behaviors: [{ type: "callback", value }],
      });
    }
  }

  if (truncated) {
    elements.push({
      tag: "markdown",
      element_id: "md_gadv_more",
      content: GROUP_ADVANCE_OVERFLOW_HINT,
    });
  }

  elements.push({
    tag: "markdown",
    element_id: "md_gadv_hint",
    content: "点一个开始跑（仅任务所有者可推进）；也可以 @机器人 发「推进 <名字>」",
  });
  elements.push({ tag: "hr", element_id: "hr_gadv_foot" });
  elements.push({
    tag: "markdown",
    element_id: "md_gadv_footer",
    content: `来自 ${input.senderName} · Flowship`,
  });

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: {
        tag: "plain_text",
        content: `${input.requirementName} · 选择推进`.slice(0, 50),
      },
      template: "blue",
      subtitle: { tag: "plain_text", content: "推进" },
    },
    body: { elements },
  };
};
