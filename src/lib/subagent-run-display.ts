/**
 * 子代理详情面板的展示层纯函数（不碰 React / DOM，可单测）
 *
 * - {@link buildSubagentRunItems}：把子代理的过程记录（TaskEvent[]）走和主事件流**同一条**渲染管线
 *   （thinking 合并 → tool_call / tool_result 配对 → 工作过程分组），面板拿结果直接画。
 * - {@link subagentTargetFromToolBlock}：事件流里的 `task` 卡片 → 详情面板的打开目标（含兜底信息）。
 * - {@link subagentTargetFromJob}：聊天框上方「后台工作」条的一行 → 详情面板的打开目标。
 * - {@link keepsSubagentDrawerOpen}：抽屉外的按下要不要放过（点「开抽屉」的入口 / 抽屉里弹出的二级浮层不关）。
 * - {@link shouldBlockSubagentDrawerClose}：抽屉的关闭请求要不要拦（outside-press 看目标、focus-out 一律拦）。
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
  block: Pick<ToolBlock, "callId" | "args" | "status" | "result" | "backgroundRunning">,
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
      // 后台子代理的卡 status 早已是 success、但它还在跑：记录刚建好 / 刚落盘的瞬间查不到时面板要多等几秒
      running: block.status === "running" || block.backgroundRunning === true,
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
 * 点到这些元素上**不算**「点了抽屉外面」，抽屉保持打开：
 * - `[data-subagent-opener]`：子代理任务条 / 后台工作条这类「开抽屉」的入口。抽屉开着时点另一条 = 换内容、
 *   点同一条 = 不动。若算外部点击，就会先走一遍「关」、再靠入口自己的 click 重新打开——最终开不开取决于
 *   这两次状态更新会不会被合并，不把正确性押在这种时序上；
 * - `role=dialog / alertdialog / menu / listbox`：抽屉里弹出来的二级浮层（图片大图预览、文件链接的右键 / 下拉菜单等），
 *   它们挂在 portal 里、物理上在抽屉外面，但用户是在操作抽屉里的东西，点它们不该把抽屉关掉。
 */
export const SUBAGENT_DRAWER_KEEP_OPEN_SELECTOR = [
  "[data-subagent-opener]",
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(", ");

/**
 * 抽屉外的一次按下（outside-press）要不要放过、不关抽屉。
 * 只收最小形状（有 `closest` 就行），不碰 document，单测可直接喂假对象；拿不到元素（非 Element 目标）= 不放过、照常关。
 */
export const keepsSubagentDrawerOpen = (
  target: { closest?: (selector: string) => unknown } | EventTarget | null | undefined,
): boolean => {
  const el = target as { closest?: (selector: string) => unknown } | null | undefined;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(SUBAGENT_DRAWER_KEEP_OPEN_SELECTOR) != null;
};

/**
 * 抽屉的一次「关闭请求」要不要被拦下（`handleOpenChange` 的 cancel 判据）。
 *
 * base-ui 的 `disablePointerDismissal={false}`（我们要「点抽屉外面关」）会**同时**打开 `closeOnFocusOut`：
 * 非模态抽屉里，焦点只要移到抽屉外、且不在它的浮层树里，就以 `focus-out` 为由请求关闭。
 * 我们要的只是「点外面关」，所以：
 * - `outside-press`：点在入口 / 二级浮层上放过（见 {@link keepsSubagentDrawerOpen}），其余照常关；
 * - `focus-out`：**一律拦**。典型现场：点另一条子代理任务条（先 outside-press 被放过，随后焦点落到那个按钮 →
 *   focus-out 又请求关闭，抽屉关了又靠入口的 click 重开）、抽屉里点大图再点大图上的按钮、键盘 Tab 出抽屉。
 *   这几种都不是「用户想关抽屉」；Esc / 右上角 X / 点外面这三条正式的关闭路径不受影响；
 * - `escape-key`：焦点在**抽屉外面**「自己也吃 Esc」的地方（输入框 / 可编辑区 / 弹出的浮层与菜单）时拦——
 *   base-ui 把 Esc 监听挂在 document 上、不看事件是不是已被处理，于是在 `@` / `/` 菜单、搜索条、
 *   气泡编辑、排队面板编辑里按 Esc「只想关自己那一层」，抽屉也跟着没了（第二轮 review V17-01）。
 *   焦点在抽屉里 / body / 普通按钮上时 Esc 仍照常关抽屉；
 * - 其余原因（X、程序化关闭）照常关。
 */
export const shouldBlockSubagentDrawerClose = (
  reason: string,
  target: Parameters<typeof keepsSubagentDrawerOpen>[0],
): boolean => {
  if (reason === "focus-out") return true;
  if (reason === "outside-press") return keepsSubagentDrawerOpen(target);
  if (reason === "escape-key") return escapeBelongsToSomethingElse(target);
  return false;
};

/** 抽屉自身的内容区（Esc 落在这里 = 用户想关抽屉） */
export const SUBAGENT_DRAWER_CONTENT_SELECTOR = '[data-slot="sheet-content"]';

/**
 * 「自己也吃 Esc」的元素：输入框 / 文本域 / 下拉 / 可编辑区（Lexical 输入条、`@` 菜单所在处）/ 文本框角色，
 * 外加抽屉保持打开的那批浮层（对话框 / 菜单 / 列表框，见 {@link SUBAGENT_DRAWER_KEEP_OPEN_SELECTOR}）。
 */
export const ESCAPE_OWNER_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  SUBAGENT_DRAWER_KEEP_OPEN_SELECTOR,
].join(", ");

/**
 * Esc 是不是该留给别的东西：目标在抽屉外、且落在「自己也吃 Esc」的元素里。
 * 只收最小形状（有 `closest` 就行）；拿不到元素（document / body 以外的非 Element 目标）= 不拦、照常关。
 */
const escapeBelongsToSomethingElse = (
  target: { closest?: (selector: string) => unknown } | EventTarget | null | undefined,
): boolean => {
  const el = target as { closest?: (selector: string) => unknown } | null | undefined;
  if (!el || typeof el.closest !== "function") return false;
  // 焦点在抽屉里：Esc 就是要关抽屉（抽屉内容区是 portal，二级浮层不在它里面，不受影响）
  if (el.closest(SUBAGENT_DRAWER_CONTENT_SELECTOR) != null) return false;
  return el.closest(ESCAPE_OWNER_SELECTOR) != null;
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

/**
 * 子代理任务条的 Tooltip 第二行：「模型 x · 推理强度 y」；两者都没有 → null。
 *
 * 为什么要有它：任务条里的 model / effort 徽标在窄栏（task 事件流栏 ≈307px）里会被让位给标题——
 * 先在徽标容器里被截断、再整体隐藏（V17-04）。隐藏后的徽标没有可悬停的目标，信息只能挂到整条 Tooltip 上；
 * 同时 `high` 这种裸词徽标本来也没说明它是什么，带上字段名反而比徽标多一点信息。
 */
export const subagentBarMetaText = (
  args: { model?: string | null; effort?: string | null } | null | undefined,
): string | null => {
  const model = args?.model?.trim();
  const effort = args?.effort?.trim();
  const parts: string[] = [];
  if (model) parts.push(`模型 ${model}`);
  if (effort) parts.push(`推理强度 ${effort}`);
  return parts.length > 0 ? parts.join(" · ") : null;
};
