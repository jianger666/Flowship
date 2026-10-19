/**
 * 任务列表里「后台还在跑」的判定（纯函数，侧栏 / 会话管理页 / 列表轮询共用）
 *
 * 背景：主 AI 说完一轮后 `runStatus` 回 awaiting_user / idle，但它派到后台的子代理可能还在干活。
 * 列表行如果只认 `runStatus === "running"`，就会把这种会话画成「空闲」——和事件流里
 * 「子代理卡片打勾但其实还在跑」是同一类问题（2026-10-19 用户要求全面排查）。
 * 服务端在 `GET /api/tasks` 里给这类任务补 `backgroundSubagentCount`（纯内存读数，见 TaskSummary 注释）。
 */

import type { TaskSummary } from "@/lib/types";

/** 这个任务此刻有没有后台子代理在跑（缺省 / 0 / 非法值都算没有） */
export const hasBackgroundSubagents = (
  task: Pick<TaskSummary, "backgroundSubagentCount">,
): boolean => {
  const n = task.backgroundSubagentCount;
  return typeof n === "number" && Number.isFinite(n) && n > 0;
};

/**
 * 列表行「在不在忙」：主 AI 在跑 或 后台子代理在跑。
 * 只用来决定要不要转圈 / 要不要继续轮询；停止键、归档确认等「主 run」语义仍只认 runStatus。
 */
export const isTaskBusy = (
  task: Pick<TaskSummary, "runStatus" | "backgroundSubagentCount">,
): boolean => task.runStatus === "running" || hasBackgroundSubagents(task);

/**
 * 用一份**不带**后台读数的新摘要（任务详情页经 `upsertTask` 回灌的完整 Task 派生出来的）
 * 覆盖列表里的旧行时，把旧行的后台读数留着。
 *
 * 为什么：读数只有列表接口才有。详情页的 SSE / 轮询回灌（比如 done 帧里的 task）不带它，
 * 直接覆盖会让转圈闪回「空闲」，直到下一次列表轮询（≤ 2s）才又转起来。
 * 留旧值的代价只是「后台刚好结束的那一瞬」多转 ≤ 一个轮询周期——轮询在有读数期间一直开着
 * （见 use-task-list 的 hasRunning），会很快用服务端真值纠正。
 * 新摘要自己带了字段（哪怕是 0）= 它就是真值，原样采用。
 */
export const keepBackgroundSubagentCount = (
  prev: TaskSummary | undefined,
  next: TaskSummary,
): TaskSummary => {
  if ("backgroundSubagentCount" in next) return next;
  if (!prev || !hasBackgroundSubagents(prev)) return next;
  return { ...next, backgroundSubagentCount: prev.backgroundSubagentCount };
};

/** 「忙 → 不忙」边沿之后补刷一次列表的延迟（略长于服务端把新派出的后台子代理登记进读数所需的一瞬） */
export const BUSY_TAIL_REFRESH_MS = 1500;

/**
 * 列表轮询只在「有任务忙」时开着，「忙 → 不忙」的那一刻它就关了。
 * 但这个翻转可能来自详情页 `upsertTask` 回灌（done 帧里的 task：runStatus 已回等待态、不带后台读数），
 * 而不是来自一次真正的列表读数——主 AI 在最后 ≤ 2s 里才派出后台子代理的话，列表里留着的是旧读数（无 / 0），
 * 轮询关掉后就没人再去读，侧栏的转圈要等下次窗口聚焦才出现。
 * 所以每次「忙 → 不忙」都再补刷一次：真没有后台就什么都不变，有就把读数拉回来、轮询随之重新打开。
 */
export const shouldTailRefreshAfterBusy = (
  wasBusy: boolean,
  busyNow: boolean,
): boolean => wasBusy && !busyNow;
