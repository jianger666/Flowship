/**
 * 「疑似卡住」判定（纯函数）。
 *
 * UI 提示条在 suspect-stuck-hint.tsx。只看事件流 / 直播有没有停，
 * 不看任务已经跑了多久——task.updatedAt 是列表排序节流字段，不能当活跃信号。
 */

/** 阈值：正常活跃间隙实测最长 ~40s（工具调用），5 分钟余量足够 */
export const SUSPECT_STUCK_MS = 5 * 60 * 1000;

/** 事件流末条 ts。新事件 append 在末尾；上拉历史 prepend 在头部、更旧。 */
export const latestEventTs = (events: readonly { ts: number }[]): number =>
  events.length === 0 ? 0 : events[events.length - 1]!.ts;

/**
 * 跑了很久但事件还在更新 ≠ 卡住；流停了才算。没有任何事件时不亮（刚起步）。
 * 有未答提问也不亮：提问后 runStatus 仍是 running（等答案靠 curl），那是在等你，不是卡死。
 */
export const isSuspectStuck = (
  running: boolean,
  lastEventAt: number,
  lastLiveAt: number,
  now: number,
  opts?: { awaitingAsk?: boolean },
): boolean => {
  if (!running) return false;
  if (opts?.awaitingAsk) return false;
  const activityAt = Math.max(lastEventAt, lastLiveAt);
  if (activityAt <= 0) return false;
  return now - activityAt > SUSPECT_STUCK_MS;
};
