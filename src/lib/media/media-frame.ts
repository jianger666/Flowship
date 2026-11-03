/**
 * 逐帧相关的纯计算。
 *
 * 浏览器的媒体元素不告诉你帧率，所以靠 `requestVideoFrameCallback` 采样相邻两帧的
 * 媒体时间差来估算，再吸附到常见帧率。可变帧率视频会有偏差——界面上要如实标注「估算」。
 */

import { clampNumber } from "@/lib/media/media-time";

export const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120] as const;
export const DEFAULT_FPS = 30;

/** 吸附到常见帧率（误差 3% 以内）；否则取一位小数；离谱的值 → null */
export const snapFps = (raw: number): number | null => {
  if (!Number.isFinite(raw) || raw < 5 || raw > 240) return null;
  let best: number = COMMON_FPS[0];
  let bestErr = Infinity;
  for (const f of COMMON_FPS) {
    const err = Math.abs(f - raw) / f;
    if (err < bestErr) {
      best = f;
      bestErr = err;
    }
  }
  if (bestErr <= 0.03) return best;
  return Math.round(raw * 10) / 10;
};

/**
 * 从相邻帧的媒体时间差估算帧率。
 * 丢帧时某些差值会是帧周期的整数倍，所以取「偏小的那一档」（25% 分位）而不是中位数。
 * 样本不足（< 5 个有效差值）→ null。
 */
export const estimateFpsFromDeltas = (deltas: readonly number[]): number | null => {
  const valid = deltas.filter((d) => Number.isFinite(d) && d > 0.001 && d < 0.5).sort((a, b) => a - b);
  if (valid.length < 5) return null;
  const picked = valid[Math.floor(valid.length * 0.25)]!;
  return snapFps(1 / picked);
};

/**
 * 逐帧的目标时间：落在目标帧的**中点**（`(k + 0.5) / fps`），
 * 避免恰好卡在两帧边界上被浏览器取到相邻那一帧。
 */
export const stepFrameTarget = (
  currentTime: number,
  fps: number,
  dir: 1 | -1,
  duration: number,
): number => {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  const index = Math.floor(currentTime * safeFps + 1e-6);
  const target = (index + dir + 0.5) / safeFps;
  const max = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return clampNumber(target, 0, max);
};
