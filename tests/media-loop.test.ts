/** 对比组切换 / 循环模式 / 播放结束去向 / `#t=起,止` 片段到点停：纯规则。 */
import { describe, expect, it } from "vitest";

import {
  SEGMENT_EARLY_SECONDS,
  cycleIndex,
  decideEndAction,
  nextLoopMode,
  segmentStopAt,
} from "@/lib/media/media-loop";

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
  it("单个循环：回开头", () => {
    expect(decideEndAction("one", 0, 3)).toEqual({ type: "restart", to: 0 });
  });

  it("整组循环：下一个（末尾回第一个）；只有一个文件就当单个循环", () => {
    expect(decideEndAction("all", 0, 3)).toEqual({ type: "next-item", index: 1 });
    expect(decideEndAction("all", 2, 3)).toEqual({ type: "next-item", index: 0 });
    expect(decideEndAction("all", 0, 1)).toEqual({ type: "restart", to: 0 });
  });

  it("不循环：停在结尾", () => {
    expect(decideEndAction("off", 0, 3)).toEqual({ type: "stop" });
  });
});

describe("segmentStopAt（#t=起,止 播到终点就停）", () => {
  it("没到终点：不停", () => {
    expect(segmentStopAt(20, 10)).toBeNull();
    expect(segmentStopAt(20, 19.9)).toBeNull();
    expect(segmentStopAt(20, 20 - SEGMENT_EARLY_SECONDS - 0.01)).toBeNull();
  });

  it("到终点（含提前量）：停在终点", () => {
    expect(segmentStopAt(20, 20 - SEGMENT_EARLY_SECONDS)).toBe(20);
    expect(segmentStopAt(20, 20)).toBe(20);
    expect(segmentStopAt(20, 20.2)).toBe(20);
  });

  it("没有片段（end 为空 / 非有限数）：永不停", () => {
    expect(segmentStopAt(null, 999)).toBeNull();
    expect(segmentStopAt(Number.NaN, 999)).toBeNull();
    expect(segmentStopAt(Number.POSITIVE_INFINITY, 999)).toBeNull();
  });
});
