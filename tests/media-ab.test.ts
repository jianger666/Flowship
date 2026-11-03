/** A-B 区间循环 / 对比组切换 / 播放结束去向：纯规则。 */
import { describe, expect, it } from "vitest";

import {
  AB_EARLY_SECONDS,
  AB_PASS_WINDOW_SECONDS,
  EMPTY_AB,
  abLoopJump,
  cycleIndex,
  decideEndAction,
  makeAb,
  nextLoopMode,
} from "@/lib/media/media-ab";

describe("makeAb", () => {
  it("A、B 先后颠倒时自动排序", () => {
    expect(makeAb(20, 10)).toEqual({ a: 10, b: 20, enabled: true });
  });

  it("只设了一个点：不生效（不会循环）", () => {
    expect(makeAb(5, null)).toEqual({ a: 5, b: null, enabled: false });
    expect(makeAb(null, 8)).toEqual({ a: null, b: 8, enabled: false });
    expect(makeAb(null, null)).toEqual({ a: null, b: null, enabled: false });
  });

  it("A、B 重合：不生效（避免在同一个点无限回跳）", () => {
    expect(makeAb(7, 7).enabled).toBe(false);
  });
});

describe("abLoopJump", () => {
  const ab = makeAb(10, 20);

  it("到 B 点附近回到 A", () => {
    expect(abLoopJump(ab, 20)).toBe(10);
    expect(abLoopJump(ab, 20 - AB_EARLY_SECONDS)).toBe(10);
    expect(abLoopJump(ab, 20.3)).toBe(10);
  });

  it("区间内不动", () => {
    expect(abLoopJump(ab, 10)).toBeNull();
    expect(abLoopJump(ab, 15)).toBeNull();
    expect(abLoopJump(ab, 19.9)).toBeNull();
  });

  it("用户拖到区间之后看别处：不被拉回", () => {
    expect(abLoopJump(ab, 20 + AB_PASS_WINDOW_SECONDS)).toBeNull();
    expect(abLoopJump(ab, 60)).toBeNull();
  });

  it("区间之前（用户拖到开头）：不拦", () => {
    expect(abLoopJump(ab, 2)).toBeNull();
  });

  it("没生效的区间 / 空区间：永不回跳", () => {
    expect(abLoopJump(EMPTY_AB, 5)).toBeNull();
    expect(abLoopJump(makeAb(10, null), 99)).toBeNull();
  });
});

describe("cycleIndex / nextLoopMode", () => {
  it("首尾相接", () => {
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(1, 3, 1)).toBe(2);
  });

  it("空组不越界", () => {
    expect(cycleIndex(0, 0, 1)).toBe(0);
  });

  it("循环模式：关 → 单个 → 整组 → 关", () => {
    expect(nextLoopMode("off")).toBe("one");
    expect(nextLoopMode("one")).toBe("all");
    expect(nextLoopMode("all")).toBe("off");
  });
});

describe("decideEndAction", () => {
  it("A-B 生效时优先回 A（压过循环模式）", () => {
    expect(decideEndAction(makeAb(4, 8), "off", 0, 1)).toEqual({ type: "restart-ab", to: 4 });
    expect(decideEndAction(makeAb(4, 8), "all", 0, 3)).toEqual({ type: "restart-ab", to: 4 });
  });

  it("单个循环：回开头", () => {
    expect(decideEndAction(EMPTY_AB, "one", 0, 3)).toEqual({ type: "restart", to: 0 });
  });

  it("整组循环：下一个（末尾回第一个）；只有一个文件就当单个循环", () => {
    expect(decideEndAction(EMPTY_AB, "all", 0, 3)).toEqual({ type: "next-item", index: 1 });
    expect(decideEndAction(EMPTY_AB, "all", 2, 3)).toEqual({ type: "next-item", index: 0 });
    expect(decideEndAction(EMPTY_AB, "all", 0, 1)).toEqual({ type: "restart", to: 0 });
  });

  it("不循环：停在结尾", () => {
    expect(decideEndAction(EMPTY_AB, "off", 0, 3)).toEqual({ type: "stop" });
  });
});
