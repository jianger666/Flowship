/**
 * 事件流「行视图状态」存档的 key 构造（纯函数、可单测）。
 *
 * 为什么单独一个文件：key 的三个组成部分——taskId / 行身份 / 字段——写错任何一个都是**静默**的
 * （换成常量 = 所有行共用一份状态；taskId 写空 = 跨任务共享；用 ev.ts 当行身份 = 同秒两行串状态），
 * 而「grep 源码里有没有调 useRowViewState」的契约测试一个都抓不到（第三轮 review R4 §3 的三个 mutation 全存活）。
 * 所以各行组件一律经这里的 helper 拿 key：helper 有行为测试（tests/row-view-keys.test.ts、
 * tests/row-id-stability.test.ts 用真事件 + 真分组管线逐前缀验证身份稳定），组件侧只剩
 * 「实参必须恰好是 (taskId, 行对象, ROW_VIEW_FIELD.xxx)」这一条源码契约。
 *
 * 行身份 = {@link streamItemStableId}：工具块取 callId 派生的稳定身份（孤儿 tool_result 与 call 到场后的块一致、
 * 连续待办合并后不随最新 call 变），verb 组取首成员身份，其余事件取事件 id。
 */

import { rowViewStateKey } from "@/lib/event-row-view-state";
import {
  streamItemStableId,
  type ToolBlock,
  type ToolVerbGroup,
} from "@/lib/tool-display";

/** 字段名：全仓唯一登记处（值各不相同，有测试守着；新增行视图状态在这里加一项） */
export const ROW_VIEW_FIELD = {
  // 工具块
  toolManualCollapsed: "tool:manualCollapsed",
  toolOutputOpen: "tool:outputOpen",
  toolDiffCollapsed: "tool:diffCollapsed",
  toolFullText: "tool:fullText",
  // 待办卡
  todoCollapsed: "todo:collapsed",
  // 动词组（连续读 / 搜类工具收成一行）
  verbCollapsed: "verb:collapsed",
  // 工作过程组
  workManual: "work:manual",
  workPinned: "work:pinned",
  // 思考 / info 过程行
  eventManualCollapsed: "event:manualCollapsed",
  // 用户消息原地编辑：是否在编辑 + 草稿（R4-05）
  userEditing: "user:editing",
  userEditDraft: "user:editDraft",
} as const;

export type RowViewField = (typeof ROW_VIEW_FIELD)[keyof typeof ROW_VIEW_FIELD];

/** 工具块 / 待办卡：行身份是块的稳定身份，不是 block.id（见 streamItemStableId） */
export const toolRowViewKey = (
  taskId: string,
  block: Pick<ToolBlock, "kind" | "id" | "callId" | "stableId">,
  field: RowViewField,
): string => rowViewStateKey(taskId, streamItemStableId(block as ToolBlock), field);

/** 动词组：行身份 = 首个成员的稳定身份（后面追加成员不变；孤儿 result 开头的组补页后也不变） */
export const verbGroupViewKey = (
  taskId: string,
  group: Pick<ToolVerbGroup, "kind" | "id" | "firstEventId" | "members">,
  field: RowViewField,
): string => rowViewStateKey(taskId, streamItemStableId(group as ToolVerbGroup), field);

/** 工作过程组：组 id 已由 buildWorkGroup 取首成员的稳定身份，这里原样用 */
export const workGroupViewKey = (
  taskId: string,
  group: { id: string },
  field: RowViewField,
): string => rowViewStateKey(taskId, group.id, field);

/** 普通事件行（思考 / info 等）：事件 id */
export const eventRowViewKey = (
  taskId: string,
  eventId: string,
  field: RowViewField,
): string => rowViewStateKey(taskId, eventId, field);

/** 用户消息原地编辑的两个状态 key（是否在编辑、草稿） */
export const userEditViewKeys = (
  taskId: string,
  eventId: string,
): { editing: string; draft: string } => ({
  editing: eventRowViewKey(taskId, eventId, ROW_VIEW_FIELD.userEditing),
  draft: eventRowViewKey(taskId, eventId, ROW_VIEW_FIELD.userEditDraft),
});
