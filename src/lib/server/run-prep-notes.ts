/**
 * 「受理前」观测笔记 + 每个 task 的跨 run 状态（上次 run 结束 / 上次预热的时刻）。
 *
 * 为什么存在：run 汇总记录（run-perf-record）想把「回车 → 首 token」整条链路放在一行里，
 * 但受理前的数据（resume / MCP 探活 / checkpoint 快照 / create 耗时）散在更上游的函数里，
 * 而 9 个 agent.send 调用点的签名各不相同——逐个透传要改一堆接口。
 * 改成：调用点按 taskId 记笔记（notePrep），createRunPerfTracker 创建时取走（takePrep）。
 *
 * 取走即清：一份笔记只属于紧随其后的那一个 run。超过 2 分钟没人取视为陈旧丢弃——
 * 否则「resume 之后 send 失败、根本没创建 tracker」的笔记会串到下一个 run 里。
 * 全部挂 globalThis（各 route 是不同 chunk，module 级 Map 会各持一份），条目数封顶 200。
 */
import type { McpProbeStats } from "./mcp-probe";

export interface PrepNotes {
  /** 各阶段耗时 ms：resume / mcp / create / prompt / checkpoint#send 等（键由调用点定，保持稳定即可） */
  stages?: Record<string, number>;
  /** 起 agent 前 MCP 探活的命中 / 等待统计（调用方用 `stats?.` 读，mock 里可能没有） */
  mcp?: McpProbeStats;
  /** 其它标量标记（如 path=resume / via=chat-inject）。只放枚举值，别放用户内容。 */
  tags?: Record<string, string | number | boolean>;
}

const NOTE_TTL_MS = 2 * 60_000;
const MAX_TASKS = 200;

type Stored = { at: number; notes: PrepNotes };

const G = globalThis as unknown as {
  __fePrepNotes?: Map<string, Stored>;
  __feLastRunEnd?: Map<string, number>;
  __feLastWarm?: Map<string, number>;
};

const prepMap = (): Map<string, Stored> => (G.__fePrepNotes ??= new Map());
const runEndMap = (): Map<string, number> => (G.__feLastRunEnd ??= new Map());
const warmMap = (): Map<string, number> => (G.__feLastWarm ??= new Map());

/** 写入并刷新插入序（最近写入的排最后）；超限删最旧 */
const setCapped = <V>(m: Map<string, V>, key: string, value: V): void => {
  m.delete(key);
  m.set(key, value);
  while (m.size > MAX_TASKS) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
};

/** 记笔记：与同 task 尚未过期的旧笔记合并（stages / tags 浅合并，mcp 以新的为准） */
export const notePrep = (
  taskId: string,
  add: PrepNotes,
  now: number = Date.now(),
): void => {
  const m = prepMap();
  const prev = m.get(taskId);
  const live = prev && now - prev.at < NOTE_TTL_MS ? prev.notes : undefined;
  setCapped(m, taskId, {
    at: now,
    notes: {
      stages: { ...live?.stages, ...add.stages },
      tags: { ...live?.tags, ...add.tags },
      mcp: add.mcp ?? live?.mcp,
    },
  });
};

/** 取走该 task 的笔记（取走即清）；没有 / 已陈旧 → null */
export const takePrep = (
  taskId: string,
  now: number = Date.now(),
): PrepNotes | null => {
  const m = prepMap();
  const hit = m.get(taskId);
  if (!hit) return null;
  m.delete(taskId);
  return now - hit.at < NOTE_TTL_MS ? hit.notes : null;
};

/** run 结束时调（idle 间隔的起点） */
export const noteRunEnded = (taskId: string, at: number = Date.now()): void =>
  setCapped(runEndMap(), taskId, at);

/**
 * 距该 task 上一个 run 结束过去多久（ms）。本进程内没见过这个 task → null
 * （进程重启后的第一个 run 就是这种情况，分析时按「未知」处理，别当 0）。
 */
export const idleSinceLastRun = (
  taskId: string,
  now: number = Date.now(),
): number | null => {
  const t = runEndMap().get(taskId);
  return t === undefined ? null : Math.max(0, now - t);
};

/** 预热完成时调（用来在汇总里区分「预热过的 run」和「没预热过的」） */
export const noteWarmed = (taskId: string, at: number = Date.now()): void =>
  setCapped(warmMap(), taskId, at);

/** 距该 task 最近一次预热过去多久；没预热过 → null */
export const warmedAgo = (
  taskId: string,
  now: number = Date.now(),
): number | null => {
  const t = warmMap().get(taskId);
  return t === undefined ? null : Math.max(0, now - t);
};

/** 仅测试：清空全部状态 */
export const __resetRunPrepStateForTests = (): void => {
  prepMap().clear();
  runEndMap().clear();
  warmMap().clear();
};
