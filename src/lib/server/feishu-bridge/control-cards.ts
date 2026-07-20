/**
 * 静态交互卡（对话清理卡 / 控制面板卡）的纯构建函数 + element_id 基建
 *
 * 与 card-stream 的流式卡不同：这两张卡一次成型、不走 streaming_mode；
 * 按钮回调由 card-action 按 CardButtonValue.kind 分发。
 * 构建函数无副作用——commands（出卡）与 card-action（patch 终态）共用、
 * 单测不需要 mock 本模块。
 */

import { shortHash } from "./card-stream";
import type { CardButtonValue, PanelCommand } from "./types";

// ----------------- element_id（CardKit ≤20 字符硬约束、短哈希基建同 ask 按钮） -----------------

/** 清理卡某对话行（标题 + 状态）的 element_id */
export const endChatRowElementId = (taskId: string): string =>
  `r${shortHash(taskId)}`;

/** 清理卡某对话「结束」按钮的 element_id */
export const endChatButtonElementId = (taskId: string): string =>
  `e${shortHash(taskId)}`;

/** 清理卡「全部结束」按钮的 element_id */
export const END_ALL_BUTTON_ELEMENT_ID = "btn_end_all";

// ----------------- 展示文案 -----------------

/** runStatus → 中文（清理卡行内状态） */
const RUN_STATUS_ZH: Record<string, string> = {
  running: "跑步中",
  awaiting_user: "等你回复",
  idle: "空闲",
  error: "出错",
};

export const zhRunStatus = (s: string): string => RUN_STATUS_ZH[s] ?? s;

// ----------------- 清理卡 -----------------

/** 清理卡需要的最小 task 信息（避免 control-cards 依赖 task 类型全量） */
export interface CleanupCardTask {
  id: string;
  title: string;
  runStatus: string;
}

const cardShell = (
  title: string,
  elements: unknown[],
): Record<string, unknown> => ({
  schema: "2.0",
  config: { update_multi: true },
  header: {
    title: { tag: "plain_text", content: title },
    template: "blue",
  },
  body: { elements },
});

/**
 * 对话清理卡：每行「标题（状态）[← 当前]」+「结束」按钮，底部「全部结束」。
 * currentTaskId = 当前对话指针（标注用、可空串）。
 */
export const buildCleanupCardJson = (
  tasks: CleanupCardTask[],
  currentTaskId: string,
): Record<string, unknown> => {
  const elements: unknown[] = [];
  for (const t of tasks) {
    const mark = t.id === currentTaskId ? " ← 当前" : "";
    elements.push({
      tag: "markdown",
      element_id: endChatRowElementId(t.id),
      content: `**${t.title || t.id}**（${zhRunStatus(t.runStatus)}）${mark}`,
    });
    const value: CardButtonValue = { kind: "end_chat", taskId: t.id };
    elements.push({
      tag: "button",
      element_id: endChatButtonElementId(t.id),
      text: { tag: "plain_text", content: "结束" },
      type: "default",
      size: "medium",
      behaviors: [{ type: "callback", value }],
    });
  }
  elements.push({ tag: "hr", element_id: "hr_end_all" });
  const endAllValue: CardButtonValue = { kind: "end_all" };
  elements.push({
    tag: "button",
    element_id: END_ALL_BUTTON_ELEMENT_ID,
    text: { tag: "plain_text", content: "全部结束" },
    type: "danger",
    size: "medium",
    behaviors: [{ type: "callback", value: endAllValue }],
  });
  return cardShell("进行中的对话", elements);
};

/** 「全部结束」点击后的整卡终态（updateCardEntity 全量替换） */
export const buildCleanupCardEndedAllJson = (
  count: number,
): Record<string, unknown> =>
  cardShell("进行中的对话", [
    {
      tag: "markdown",
      element_id: "md_ended_all",
      content: `已全部结束（${count} 个）`,
    },
  ]);

// ----------------- 控制面板卡（/help） -----------------

/** 面板快捷按钮的 element_id（固定三颗、无需哈希） */
const PANEL_BUTTON_IDS: Record<PanelCommand, string> = {
  new: "btn_cmd_new",
  clean: "btn_cmd_clean",
  status: "btn_cmd_status",
};

const panelButton = (command: PanelCommand, label: string): unknown => {
  const value: CardButtonValue = { kind: "cmd", command };
  return {
    tag: "button",
    element_id: PANEL_BUTTON_IDS[command],
    text: { tag: "plain_text", content: label },
    type: "default",
    size: "medium",
    behaviors: [{ type: "callback", value }],
  };
};

/** 控制面板卡：命令说明 + 三个快捷按钮（helpText = 命令清单文本版） */
export const buildHelpPanelCardJson = (
  helpText: string,
): Record<string, unknown> =>
  cardShell("Flowship 控制面板", [
    {
      tag: "markdown",
      element_id: "md_help",
      content: helpText,
    },
    { tag: "hr", element_id: "hr_help" },
    panelButton("new", "开新对话"),
    panelButton("clean", "清理对话"),
    panelButton("status", "桥接状态"),
  ]);
