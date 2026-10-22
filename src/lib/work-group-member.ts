/**
 * 工作过程组成员行的 memo 比较（D5-01，第三轮 review）。
 *
 * 展开的运行中尾组每来一个事件，宿主传下来的 `task`（事件追加就换新对象）与 `liveToolOutputs`
 * （每个输出增量都换新对象）整体都变；原先成员行把它们整个透传 → 几百个成员每事件整组重渲。
 * 成员行 `memo` 时用这里的比较：只在「这一行真会读到的东西」变了才重渲。
 *
 * 纯函数、无 React 依赖——行为可单测；接线由 work-group.tsx 的 `memo(WorkGroupMemberImpl, workGroupMemberPropsEqual)`。
 */
import { isToolBlock, isToolVerbGroup, type StreamRenderItem } from "@/lib/tool-display";
import type { Task } from "@/lib/types";

/**
 * 事件类成员（thinking / 启动链 info）经 `EventRow` 真会读的 task 字段：
 * `actions`（归属标 / 该 action 的 cwd）、`workCwd`（markdown 相对链接基准目录）、`repoPaths` / `eventsTruncated`
 * （错误卡，组成员里不会出现，留着是防以后）、`feishuStoryUrl`（`isLightweightDailyTask`：日常任务隐藏分享）。
 * **不含 `events`**：EventRow 只在 ask 回执 / 错误卡里读它，这两种都不是组成员；而它恰恰是「每来一个事件就变」的那个字段。
 * 以后给 EventRow 加了新的 `task.xxx` 读取，必须同步这里（tests/work-group-member-memo.test.ts 有契约测试拦）。
 */
export const EVENT_MEMBER_TASK_FIELDS = [
  "actions",
  "workCwd",
  "repoPaths",
  "eventsTruncated",
  "feishuStoryUrl",
] as const satisfies ReadonlyArray<keyof Task>;

export type WorkGroupMemberCmpProps = {
  member: StreamRenderItem;
  taskId: string;
  task: Task;
  variant: "log" | "chat";
  /** 仅工具块成员：自己那一条（callId 对应的）直播输出；其余成员恒 undefined */
  liveOutput?: string;
};

export const workGroupMemberPropsEqual = (
  prev: WorkGroupMemberCmpProps,
  next: WorkGroupMemberCmpProps,
): boolean => {
  if (
    prev.member !== next.member ||
    prev.taskId !== next.taskId ||
    prev.variant !== next.variant ||
    prev.liveOutput !== next.liveOutput
  ) {
    return false;
  }
  // 工具 / verb 成员完全不读 task
  if (isToolBlock(next.member) || isToolVerbGroup(next.member)) return true;
  if (prev.task === next.task) return true;
  return EVENT_MEMBER_TASK_FIELDS.every((k) => prev.task[k] === next.task[k]);
};
