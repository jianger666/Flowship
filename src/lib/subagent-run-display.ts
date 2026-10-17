/**
 * 子代理详情面板的展示层纯函数（不碰 React / DOM，可单测）
 *
 * - {@link buildSubagentRunItems}：把子代理的过程记录（TaskEvent[]）走和主事件流**同一条**渲染管线
 *   （thinking 合并 → tool_call / tool_result 配对 → 工作过程分组），面板拿结果直接画。
 * - {@link subagentTargetFromToolBlock}：事件流里的 `task` 卡片 → 详情面板的打开目标（含兜底信息）。
 * - {@link subagentTargetFromJob}：聊天框上方「后台工作」条的一行 → 详情面板的打开目标。
 */

import type { BackgroundSubagentJobView } from "@/lib/background-subagents";
import { groupChatRenderItems, type WorkGroupItem } from "@/lib/chat-turns";
import { coalesceAdjacentThinking } from "@/lib/merge-thinking";
import type { SubagentDetailTarget, SubagentRunStatus } from "@/lib/subagent-run";
import type { SubagentRunPhase } from "@/lib/subagent-run-client";
import {
  coerceStaleRunningTools,
  mergeToolDisplayEvents,
  parseTaskToolArgs,
  type StreamRenderItem,
  type ToolBlock,
} from "@/lib/tool-display";
import type { TaskEvent } from "@/lib/types";

/**
 * 过程记录 → 面板要画的渲染项。
 *
 * `running` = 子代理还在跑：false 时把仍挂转圈的工具块改成「已中断」
 * （子代理被取消 / 应用重启，记录里有只发了调用、没等到结果的工具——不能一直转）。
 * 与主流的 buildStreamItems 同口径，所以子代理的过程看起来和主 AI 的一模一样。
 */
export const buildSubagentRunItems = (
  events: readonly TaskEvent[],
  running: boolean,
): Array<StreamRenderItem | WorkGroupItem> => {
  const merged = mergeToolDisplayEvents(coalesceAdjacentThinking([...events]));
  const tools = running ? merged : coerceStaleRunningTools(merged);
  return groupChatRenderItems(tools);
};

/**
 * 事件流里的 `task` 卡片 → 详情目标。
 * 按 callId 找服务端的过程记录；找不到（功能上线前的历史卡片 / 记录被清）时，
 * 面板退回展示卡片自己手上的任务书（可能被截断）和产出。
 */
export const subagentTargetFromToolBlock = (
  block: Pick<ToolBlock, "callId" | "args" | "status" | "result">,
): SubagentDetailTarget => {
  const args = parseTaskToolArgs(block.args);
  const output = block.result?.output;
  return {
    ref: { by: "callId", callId: block.callId },
    title: args?.description ?? undefined,
    fallback: {
      description: args?.description ?? undefined,
      prompt: args?.prompt ?? undefined,
      model: args?.model ?? undefined,
      effort: args?.effort ?? undefined,
      output: output?.trim() ? output : undefined,
      running: block.status === "running",
    },
  };
};

/**
 * 「后台工作」条里的一行 → 详情目标。
 * 没有 runKey（没配过程记录器 / 记录没起来）= 点不开，返回 null，调用方就不画可点样式。
 */
export const subagentTargetFromJob = (
  job: Pick<BackgroundSubagentJobView, "runKey" | "description">,
): SubagentDetailTarget | null => {
  if (!job.runKey) return null;
  return {
    ref: { by: "key", key: job.runKey },
    title: job.description,
    // 条上的行都是还在跑的：记录刚建好 / 刚落盘的瞬间查不到时，面板多等几秒再下结论
    fallback: { description: job.description, running: true },
  };
};

/**
 * 详情面板内容更新后要不要贴底。
 *
 * - 用户没往上翻（`following`）才可能贴底；
 * - 子代理还在跑（`running`）：每来一批新内容就贴；
 * - **刚跑完的那一帧**（`wasRunning` 且现在已终态）也要贴一次：终态快照会在过程下面追加「产出 / 失败原因 /
 *   取消说明」，只在运行中贴底的话，这最后一帧新增的内容就留在折叠线下面，用户得自己再往下划才看得到结论；
 * - 一打开就是终态的（历史记录）不贴：用户该从任务书开始读，别一进来就被甩到最底。
 */
export const shouldStickToBottom = (o: {
  following: boolean;
  running: boolean;
  wasRunning: boolean;
}): boolean => o.following && (o.running || o.wasRunning);

/**
 * 面板一打开，要不要把跟随控制器的「正在跟随」放掉。
 *
 * 控制器初值是 `following = true`，而它有一条**不经过 {@link shouldStickToBottom}** 的路径：滚动区高度一变
 * （缩放窗口、快照到达后头部徽标长出来把滚动区挤矮……）只要还在 following 就贴底。所以「一打开就是终态的
 * 历史记录」光靠 `shouldStickToBottom` 返回 false 还不够——不放掉 following，缩一下窗口就被拽到最底，
 * 而这类记录该从任务书读起。
 *
 * 返回：
 * - `true`：放掉（调 `follow.setFollowing(false)`）——首个快照就是终态，或确认没有过程记录（只有卡片自带的任务书）；
 * - `false`：保持跟随——首个快照是运行中；
 * - `undefined`：判据还没到（还在加载 / 在等记录建好 / 请求失败待重试），先别动。
 *
 * 只认**首个**判据：跑着的子代理后来变终态，不走这里（那是「刚跑完那一帧」贴底的事，见 `shouldStickToBottom`）。
 */
export const releaseFollowOnOpen = (o: {
  status: SubagentRunStatus | undefined;
  phase: SubagentRunPhase;
}): boolean | undefined => {
  if (o.status !== undefined) return o.status !== "running";
  if (o.phase === "missing") return true;
  return undefined;
};
