/** 全屏控件自动隐藏的规则：什么时候显示、什么样的指针事件算「动了」。 */
import { describe, expect, it } from "vitest";

import { IDLE_HIDE_MS, chromeVisible, isRealPointerMove } from "@/lib/media/media-chrome";

const base = { fullscreen: true, paused: false, idle: true, pinned: false };

describe("chromeVisible", () => {
  it("全屏 + 播放中 + 静止够久：隐藏", () => {
    expect(chromeVisible(base)).toBe(false);
  });

  it("全屏 + 播放中 + 刚动过：显示", () => {
    expect(chromeVisible({ ...base, idle: false })).toBe(true);
  });

  it("暂停 / 已结束时一直显示（哪怕静止很久）", () => {
    expect(chromeVisible({ ...base, paused: true })).toBe(true);
  });

  it("菜单展开 / 帮助 / 报错提示这类需要看着的东西：不隐藏", () => {
    expect(chromeVisible({ ...base, pinned: true })).toBe(true);
  });

  it("非全屏永远显示：窗口模式不自动隐藏", () => {
    expect(chromeVisible({ ...base, fullscreen: false })).toBe(true);
  });

  it("静止阈值是几秒量级（不是 0 也不是半分钟）", () => {
    expect(IDLE_HIDE_MS).toBeGreaterThanOrEqual(2000);
    expect(IDLE_HIDE_MS).toBeLessThanOrEqual(5000);
  });
});

describe("isRealPointerMove", () => {
  it("第一次事件算动", () => {
    expect(isRealPointerMove(null, { x: 1, y: 1 })).toBe(true);
  });

  it("坐标变了才算动", () => {
    expect(isRealPointerMove({ x: 10, y: 10 }, { x: 11, y: 10 })).toBe(true);
    expect(isRealPointerMove({ x: 10, y: 10 }, { x: 10, y: 9 })).toBe(true);
  });

  it("布局变化补发的同坐标 pointermove 不算动（否则控件隐藏后立刻又弹出来）", () => {
    expect(isRealPointerMove({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false);
  });
});
