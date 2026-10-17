/**
 * 「回到最新」平滑滚动的纯函数（lib/scroll-follow）：要不要滑、滑多久、第 t 毫秒在哪。
 * 接线（控制器里取消 / 落地 / 终点重读）在 tests/stream-follow-controller.test.ts。
 */
import { describe, expect, it } from "vitest";

import {
  FOLLOW_PIN_THRESHOLD,
  SMOOTH_BOTTOM_MAX_MS,
  SMOOTH_BOTTOM_MAX_VIEWPORTS,
  SMOOTH_BOTTOM_MIN_MS,
  easeOutCubic,
  shouldAnimateScrollToBottom,
  smoothBottomDuration,
  smoothBottomTop,
} from "@/lib/scroll-follow";

describe("shouldAnimateScrollToBottom", () => {
  it("贴底带内不动画（本来就看得见最新）", () => {
    expect(shouldAnimateScrollToBottom(0, 800, false)).toBe(false);
    expect(shouldAnimateScrollToBottom(FOLLOW_PIN_THRESHOLD, 800, false)).toBe(false);
    expect(shouldAnimateScrollToBottom(FOLLOW_PIN_THRESHOLD + 1, 800, false)).toBe(true);
  });

  it("超过 3 个视口高度直接跳（几千像素的滑行本身就是个大动作）", () => {
    const client = 800;
    const limit = client * SMOOTH_BOTTOM_MAX_VIEWPORTS;
    expect(shouldAnimateScrollToBottom(limit, client, false)).toBe(true);
    expect(shouldAnimateScrollToBottom(limit + 1, client, false)).toBe(false);
  });

  it("「减少动态效果」永远不动画", () => {
    expect(shouldAnimateScrollToBottom(400, 800, true)).toBe(false);
  });
});

describe("smoothBottomDuration", () => {
  it("近的快、远的稍慢，夹在 [MIN, MAX]", () => {
    expect(smoothBottomDuration(60, 800)).toBeGreaterThanOrEqual(SMOOTH_BOTTOM_MIN_MS);
    expect(smoothBottomDuration(60, 800)).toBeLessThan(smoothBottomDuration(2000, 800));
    expect(smoothBottomDuration(100000, 800)).toBe(SMOOTH_BOTTOM_MAX_MS);
  });

  it("视口高度为 0 不除零", () => {
    expect(Number.isFinite(smoothBottomDuration(500, 0))).toBe(true);
  });
});

describe("easeOutCubic / smoothBottomTop", () => {
  it("端点 0 → 0、1 → 1，越界夹住，起步比线性快", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.25)).toBeGreaterThan(0.25);
  });

  it("起点 / 终点 / 中途；终点变了（内容在长）同一时刻的位置跟着追", () => {
    expect(smoothBottomTop(100, 500, 0, 200)).toBe(100);
    expect(smoothBottomTop(100, 500, 200, 200)).toBe(500);
    const mid = smoothBottomTop(100, 500, 100, 200);
    expect(mid).toBeGreaterThan(300);
    expect(mid).toBeLessThan(500);
    expect(smoothBottomTop(100, 900, 100, 200)).toBeGreaterThan(mid);
  });

  it("时长为 0 直接到终点", () => {
    expect(smoothBottomTop(100, 500, 0, 0)).toBe(500);
  });
});
