/**
 * 后台子代理的「在飞快照」——服务端推给界面、界面画「子代理在后台干活」条用（纯函数，客户端 / 服务端共用）
 *
 * # 为什么需要它
 * 主 AI 用 `run_in_background` 把活派给子代理（或用户插话把前台子代理转后台）后，主 AI 这一轮会正常说完——
 * 事件流里没有任何东西还在转：runStatus 回 idle、状态行消失、输入框恢复成「发送」。
 * 可子代理其实还在干活，用户完全不知道（2026-10-17 用户反馈「聊天框就呈现了结束的状态，但是其实还有
 * 子代理在干活我根本不知道」）。
 *
 * # 为什么不从事件流推断
 * 事件流里能看到的只有「派出去」（`subagent` 调用的工具结果）和「做完了」（一行 info）两头，
 * 取消 / 会话被关 / 应用重启 / 超时被杀都不一定留下对应的行；靠字符串匹配拼出来的「在跑」必然漂移。
 * 所以由服务端把「此刻还在跑的后台子代理」整份快照下发（SSE `background_subagents` 帧，
 * 纯内存、不落盘；每次连接 bootstrap 补发当前值——断线重连 / 切走再切回都不会停在旧状态）。
 *
 * # 范围
 * 只有后台运行（chat 会话里的 Cursor 路径）才有；前台子代理主 AI 被卡在工具调用里，状态行本来就在说「子代理工作中」。
 */

import { formatDurationCoarse } from "@/lib/duration-display";

/** 一个在后台跑的子代理（界面视图） */
export interface BackgroundSubagentJobView {
  /** link 内的后台任务 id（`bg_xxxxxxxx`）；同一个任务在整个生命周期里不变，当 React key 用 */
  id: string;
  /** 3-5 个词的任务摘要（模型给的，没给时服务端取 prompt 开头） */
  description: string;
  /** 开始时间（ms，服务端 Date.now()；本机应用、与界面同一时钟） */
  startedAt: number;
  /** true = 一开始是前台、用户插话时转到后台的；false = 主 AI 一开始就派到后台 */
  detached: boolean;
  /**
   * 子代理过程记录的 key（`sa_…`）：点开详情（任务书 + 子代理的工作过程）按它去取。
   * 没配过程记录器 / 记录起不来时没有——此时条只能展示、点不开。
   */
  runKey?: string;
}

/** 防御性上限：服务端并发上限只有个位数，超出的一定是脏数据；别让一帧脏数据把界面撑爆 */
export const BACKGROUND_SUBAGENT_VIEW_MAX = 50;

/** 摘要为空 / 缺失时界面的兜底文案（与服务端 describeJob 的兜底一致） */
export const BACKGROUND_SUBAGENT_FALLBACK_DESCRIPTION = "子任务";

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * 解析 SSE 帧里的 jobs 字段（按「不可信输入」逐项校验）：
 *  - 不是数组 → undefined（无效帧，调用方丢弃、不动本地状态——宁可不更新，也别拿脏数据覆盖）；
 *  - 数组里 id 非空串、startedAt 有限数的才留，其余条目丢掉；摘要缺失 / 全空白 → 兜底文案；
 *  - 同 id 去重（后者覆盖前者）、按开始时间升序（同刻按 id，顺序稳定、列表不跳）、最多 {@link BACKGROUND_SUBAGENT_VIEW_MAX} 条。
 */
export const parseBackgroundSubagentJobs = (
  raw: unknown,
): BackgroundSubagentJobView[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const byId = new Map<string, BackgroundSubagentJobView>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.length === 0) continue;
    if (!isFiniteNumber(o.startedAt)) continue;
    const description =
      typeof o.description === "string" && o.description.trim()
        ? o.description.trim()
        : BACKGROUND_SUBAGENT_FALLBACK_DESCRIPTION;
    byId.set(o.id, {
      id: o.id,
      description,
      startedAt: o.startedAt,
      detached: o.detached === true,
      ...(typeof o.runKey === "string" && o.runKey ? { runKey: o.runKey } : {}),
    });
  }
  return [...byId.values()]
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
    .slice(0, BACKGROUND_SUBAGENT_VIEW_MAX);
};

/**
 * 两份快照是否一样（逐项比 id / 摘要 / 开始时间 / 来源）。
 * bootstrap 补发的当前值与刚收到的实时帧经常是同一份——相同就别 setState，省一次整个聊天视图的重渲染。
 */
export const backgroundSubagentJobsEqual = (
  a: readonly BackgroundSubagentJobView[],
  b: readonly BackgroundSubagentJobView[],
): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return (
      x.id === y.id &&
      x.description === y.description &&
      x.startedAt === y.startedAt &&
      x.detached === y.detached &&
      x.runKey === y.runKey
    );
  });
};

/** 条上的一行说明 */
export interface BackgroundSubagentSummary {
  /** 主文案：`子代理「查资料」在后台工作` / `3 个子代理在后台工作` */
  title: string;
  /** 次文案：多个时列出摘要（`查资料、跑测试`）；单个时 null（标题里已经有了） */
  names: string | null;
}

/** 条的主 / 次文案；jobs 为空返回 null（调用方不画条） */
export const summarizeBackgroundSubagents = (
  jobs: readonly BackgroundSubagentJobView[],
): BackgroundSubagentSummary | null => {
  if (jobs.length === 0) return null;
  if (jobs.length === 1) {
    return {
      title: `子代理「${jobs[0]!.description}」在后台工作`,
      names: null,
    };
  }
  return {
    title: `${jobs.length} 个子代理在后台工作`,
    names: jobs.map((j) => j.description).join("、"),
  };
};

/**
 * 已运行多久（`12s` / `2m14s`）；不到 1 秒返回 null（别显示「0s」）。
 * 容许时钟轻微回拨：now 早于 startedAt 钳成 0。
 */
export const formatBackgroundElapsed = (
  startedAt: number,
  now: number,
): string | null => formatDurationCoarse(Math.max(0, now - startedAt));

/** 最早开始的那个已经跑了多久（条上的计时 = 「最久的一个」）；空列表返回 null */
export const oldestBackgroundStartedAt = (
  jobs: readonly BackgroundSubagentJobView[],
): number | null =>
  jobs.length === 0 ? null : Math.min(...jobs.map((j) => j.startedAt));
