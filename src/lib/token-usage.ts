/**
 * token 用量的归一 / 累加 / 展示格式化（前后端共用纯函数、无 IO 无 React）
 *
 * 数据来源：SDK `turn-ended` update 的 usage（run-perf.ts 消费）。
 *
 * ## 为什么这里没有「上下文占用百分比」
 * 两个必要条件都拿不到：
 * 1. **分母拿不到**——`@cursor/sdk` 1.0.24 的 `ModelListItem`（models.list 返回）
 *    只有 id / displayName / description / aliases / parameters / variants，
 *    全 SDK 没有任何 contextWindow / maxTokens 字段；
 * 2. **分子也不是「当前上下文」**——`inputTokens` 是一轮内**所有模型调用**的
 *    prompt token 之和（实测单轮 542 万），不是某一次调用送进去的上下文长度。
 *
 * 所以这里只提供绝对值展示，绝不编一个假的窗口大小去算百分比。
 * 「上下文真的满了」这个信号另有权威来源：SDK 自动压缩会话时会落一条 info 事件
 * （shell-output-bridge.createSdkSummaryDeltaPublisher）。
 */

import type { TokenUsageRollup, TurnTokenUsage } from "./types";

/** 全零用量（累加起点） */
export const EMPTY_TURN_USAGE: TurnTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** 非负有限整数才收，其余（NaN / Infinity / 负数 / 非数字）一律归 0 */
const safeCount = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.round(v);
};

/**
 * 把 SDK 原始 usage（或磁盘上的旧数据）归一成 TurnTokenUsage。
 * 全字段缺失 / 脏值 → 返 null，调用方据此跳过落账（不写一条全 0 的假记录）。
 */
export const normalizeTurnUsage = (raw: unknown): TurnTokenUsage | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const usage: TurnTokenUsage = {
    inputTokens: safeCount(o.inputTokens),
    outputTokens: safeCount(o.outputTokens),
    cacheReadTokens: safeCount(o.cacheReadTokens),
    cacheWriteTokens: safeCount(o.cacheWriteTokens),
  };
  const reasoning = safeCount(o.reasoningTokens);
  if (reasoning > 0) usage.reasoningTokens = reasoning;
  // 四个主字段全 0 = 这轮压根没上报有效用量（SDK usage 缺省 / 脏值），不落账
  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0 &&
    usage.cacheWriteTokens === 0
  ) {
    return null;
  }
  return usage;
};

/** 逐字段相加；reasoningTokens 只在两边至少一边有值时才写出 */
export const addTurnUsage = (
  a: TurnTokenUsage,
  b: TurnTokenUsage,
): TurnTokenUsage => {
  const reasoning = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  const sum: TurnTokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
  if (reasoning > 0) sum.reasoningTokens = reasoning;
  return sum;
};

/**
 * 落一轮账：last 覆盖、total 累加、turns +1。
 * prev 为空 / 脏（老数据缺 total 之类）时从零重建，不抛。
 */
export const accumulateTokenUsage = (
  prev: TokenUsageRollup | undefined,
  turn: TurnTokenUsage,
  now: number = Date.now(),
): TokenUsageRollup => {
  const prevTotal = normalizeTurnUsage(prev?.total) ?? EMPTY_TURN_USAGE;
  const prevTurns =
    typeof prev?.turns === "number" && Number.isFinite(prev.turns) && prev.turns > 0
      ? Math.round(prev.turns)
      : 0;
  return {
    last: turn,
    total: addTurnUsage(prevTotal, turn),
    turns: prevTurns + 1,
    updatedAt: now,
  };
};

/**
 * token 数缩写：842 / 12k / 1.2k / 5.4M。
 * 小数只留一位、整数位 >= 10 时不留小数（避免「12.3k」这种没信息量的精度）。
 */
export const formatTokens = (n: number): string => {
  const v = safeCount(n);
  if (v < 1000) return String(v);
  const unit = v >= 1_000_000 ? { div: 1_000_000, suffix: "M" } : { div: 1000, suffix: "k" };
  const scaled = v / unit.div;
  const text = scaled >= 10 ? String(Math.round(scaled)) : scaled.toFixed(1);
  // 1.0k → 1k
  return `${text.replace(/\.0$/, "")}${unit.suffix}`;
};

/** 一轮总共过了多少 token（输入 + 输出）——chip 上那个数 */
export const turnTotalTokens = (u: TurnTokenUsage): number =>
  u.inputTokens + u.outputTokens;

/**
 * 缓存命中率 = cacheRead / input（cacheRead 是 input 的子集）。
 * input 为 0 时返 null（没法算、UI 不显示这行）。
 */
export const cacheHitRatio = (u: TurnTokenUsage): number | null => {
  if (u.inputTokens <= 0) return null;
  return Math.min(1, u.cacheReadTokens / u.inputTokens);
};
