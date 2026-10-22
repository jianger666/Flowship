/**
 * 推进（advance）失败时「要不要由路由补写一条 error 事件」的判定（纯函数、可单测）
 *
 * 背景：`advanceTask` 在推进前会 `ensureTaskWorktrees` 建 / 复用隔离工作区。它抛错
 * （主仓不可达 / 线上分支找不到 / git worktree add 失败……）时 runner 只写过一条
 * 「正在准备工作区…」info，随后异常直接冒到路由、只回了 400——事件流里没有任何失败记录，
 * 用户关掉弹窗后只剩一条转瞬即逝的 toast，事后无从排查。
 *
 * 为什么放在路由层而不是 runner：runner 的 ensure 段不在本轮改动范围，且路由是所有
 * 「推进抛错」的唯一汇合点；这里补写即可覆盖，runner 以后自己写了也会被下面的去重识别。
 *
 * 判定刻意保守——写事件会进事件流、有「重试」按钮，误写比漏写更扰人：
 *  - 让位（stop / 任务已变更）：用户主动停的，不是推进失败
 *  - 准入条件不满足：前置校验拒绝，什么都没开始，弹窗 / toast 已完整给出原因
 *  - 任务正在 running / 已终态：多半是并发撞车或终态拒绝，agent 其实在正常跑，
 *    再往事件流塞一条红色「失败」会误导
 *  - runner 已写过同文案 error（wk 门禁 / 测试任务切分支都是这样）：不重复写
 */

import type { EventKind, RepoStatus, RunStatus } from "@/lib/types";

/** `advanceTask` 准入拒绝的固定文案前缀（task-runner 抛 `准入条件不满足：${reason}`） */
export const ADVANCE_ADMISSION_REJECT_PREFIX = "准入条件不满足";

/** 判定只需要的事件字段（避免依赖完整 TaskEvent） */
export interface AdvanceFailureEventLike {
  kind: EventKind | string;
  text: string;
  ts: number;
}

export interface AdvanceFailureContext {
  /** 路由即将回给客户端的错误文案（完整、不截断） */
  message: string;
  /** 让位文案（task-runner 的 TASK_OP_STALE_HTTP_MESSAGE）——由调用方注入，保持本模块纯净 */
  staleMessage: string;
  /** 路由收到本次请求的时刻（ms）：只认此后写入的事件，更早的 error 不算「本次已写」 */
  startedAt: number;
  /** 失败后读到的任务尾部事件 */
  recentEvents: readonly AdvanceFailureEventLike[];
  /** 失败后重读的 task 状态 */
  runStatus?: RunStatus;
  repoStatus?: RepoStatus;
}

/** 路由 catch 里调用：true = 需要补写一条 error 事件 */
export const shouldRecordAdvanceFailure = (
  ctx: AdvanceFailureContext,
): boolean => {
  const message = ctx.message.trim();
  if (!message) return false;
  if (message === ctx.staleMessage.trim()) return false;
  if (message.startsWith(ADVANCE_ADMISSION_REJECT_PREFIX)) return false;
  if (ctx.runStatus === "running") return false;
  if (ctx.repoStatus === "merged" || ctx.repoStatus === "abandoned") return false;
  const alreadyRecorded = ctx.recentEvents.some(
    (ev) =>
      ev.kind === "error" &&
      ev.ts >= ctx.startedAt &&
      ev.text.trim() === message,
  );
  return !alreadyRecorded;
};
