/**
 * 播放流转规则（纯函数，播放器里的 rAF / 按键 / 播放结束都调这里）：
 * 对比组上一个 / 下一个、循环模式轮换、播放到头的去向、`#t=起,止` 片段到点停。
 */

import type { LoopMode } from "@/lib/media/media-memory";

/** 对比组循环切换：上一个 / 下一个（首尾相接） */
export const cycleIndex = (index: number, size: number, dir: 1 | -1): number =>
  size <= 0 ? 0 : (((index + dir) % size) + size) % size;

/** 循环模式轮换：关 → 单个 → 整组 → 关 */
export const nextLoopMode = (mode: LoopMode): LoopMode =>
  mode === "off" ? "one" : mode === "one" ? "all" : "off";

/** 播放到头之后的去向 */
export type EndAction =
  | { type: "restart"; to: 0 }
  | { type: "next-item"; index: number }
  | { type: "stop" };

export const decideEndAction = (loop: LoopMode, index: number, size: number): EndAction => {
  if (loop === "one") return { type: "restart", to: 0 };
  if (loop === "all") {
    return size > 1 ? { type: "next-item", index: cycleIndex(index, size, 1) } : { type: "restart", to: 0 };
  }
  return { type: "stop" };
};

/** 提前一点停（rAF 一帧 ≈ 16ms，留 30ms 余量，别让片段外的声音漏出来） */
export const SEGMENT_EARLY_SECONDS = 0.03;

/**
 * `path#t=起,止` 这类带终点的引用：从起点播到终点就停。
 * 播放到 `t` 时该不该停——到了（含提前量）就返回要停在的位置（终点），没到返回 null。
 * 用户手动拖进度 / 键盘跳转会直接取消片段（由调用方清掉 `end`），所以这里不用管「拖到终点之后」。
 */
export const segmentStopAt = (end: number | null, t: number): number | null => {
  if (end === null || !Number.isFinite(end)) return null;
  return t >= end - SEGMENT_EARLY_SECONDS ? end : null;
};
