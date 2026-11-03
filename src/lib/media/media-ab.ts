/**
 * A-B 区间循环与切换规则（纯函数，播放器里的 rAF / 按键 / 播放结束都调这里）。
 */

import type { LoopMode } from "@/lib/media/media-memory";

export interface AbRange {
  a: number | null;
  b: number | null;
  /** A、B 都设了且 B 在 A 之后：才会真的循环 */
  enabled: boolean;
}

export const EMPTY_AB: AbRange = Object.freeze({ a: null, b: null, enabled: false }) as AbRange;

/** 回跳判定的「刚到终点」窗口：超过 B 这么远还没被拉回，说明用户是拖进度条跳到区间之后看别处，不拦 */
export const AB_PASS_WINDOW_SECONDS = 0.6;
/** 提前一点回跳（rAF 一帧 ≈ 16ms，留 30ms 余量不让声音漏进区间外） */
export const AB_EARLY_SECONDS = 0.03;

/** 设 A / B：两点都有时自动排好先后（用户先点了靠后的 A 再点靠前的 B 也不出错） */
export const makeAb = (a: number | null, b: number | null): AbRange => {
  const lo = a !== null && b !== null ? Math.min(a, b) : a;
  const hi = a !== null && b !== null ? Math.max(a, b) : b;
  return { a: lo, b: hi, enabled: lo !== null && hi !== null && hi > lo };
};

/** 播放到 t：该不该回跳。返回回跳目标（A 点），不用回跳返回 null */
export const abLoopJump = (ab: AbRange, t: number): number | null => {
  if (!ab.enabled || ab.a === null || ab.b === null) return null;
  if (t >= ab.b - AB_EARLY_SECONDS && t < ab.b + AB_PASS_WINDOW_SECONDS) return ab.a;
  return null;
};

/** 对比组循环切换：上一个 / 下一个（首尾相接） */
export const cycleIndex = (index: number, size: number, dir: 1 | -1): number =>
  size <= 0 ? 0 : (((index + dir) % size) + size) % size;

/** 循环模式轮换：关 → 单个 → 整组 → 关 */
export const nextLoopMode = (mode: LoopMode): LoopMode =>
  mode === "off" ? "one" : mode === "one" ? "all" : "off";

/** 播放到头之后的去向 */
export type EndAction =
  | { type: "restart-ab"; to: number }
  | { type: "restart"; to: 0 }
  | { type: "next-item"; index: number }
  | { type: "stop" };

export const decideEndAction = (ab: AbRange, loop: LoopMode, index: number, size: number): EndAction => {
  if (ab.enabled && ab.a !== null) return { type: "restart-ab", to: ab.a };
  if (loop === "one") return { type: "restart", to: 0 };
  if (loop === "all") {
    return size > 1 ? { type: "next-item", index: cycleIndex(index, size, 1) } : { type: "restart", to: 0 };
  }
  return { type: "stop" };
};
