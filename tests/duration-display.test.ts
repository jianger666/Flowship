/**
 * 事件流耗时文案（lib/duration-display 单一来源）
 *
 * 两种口径各有理由，别互相「统一」掉：
 *   - precise：单步耗时（工具执行 / 一段思考），毫秒级要能看出「这步很快」
 *   - coarse：聚合耗时（工作过程组头），秒级密度、<1s 不显示（组头不该出现「0s」）
 */
import { describe, expect, it } from "vitest";

import {
  formatDurationCoarse,
  formatDurationPrecise,
} from "../src/lib/duration-display";

describe("formatDurationPrecise", () => {
  it("毫秒 / 秒 / 分秒三档", () => {
    expect(formatDurationPrecise(0)).toBe("0ms");
    expect(formatDurationPrecise(820)).toBe("820ms");
    expect(formatDurationPrecise(999)).toBe("999ms");
    expect(formatDurationPrecise(1000)).toBe("1.0s");
    expect(formatDurationPrecise(12_340)).toBe("12.3s");
    expect(formatDurationPrecise(59_900)).toBe("59.9s");
    expect(formatDurationPrecise(60_000)).toBe("1m0s");
    expect(formatDurationPrecise(134_000)).toBe("2m14s");
  });

  it("脏 meta（缺失 / 字符串 / NaN / 负数）一律返 null、调用方直接不渲染", () => {
    expect(formatDurationPrecise(undefined)).toBeNull();
    expect(formatDurationPrecise(null)).toBeNull();
    expect(formatDurationPrecise("1200")).toBeNull();
    expect(formatDurationPrecise(Number.NaN)).toBeNull();
    expect(formatDurationPrecise(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatDurationPrecise(-5)).toBeNull();
  });
});

describe("formatDurationCoarse", () => {
  it("秒级密度、分秒进位", () => {
    expect(formatDurationCoarse(1000)).toBe("1s");
    expect(formatDurationCoarse(12_000)).toBe("12s");
    expect(formatDurationCoarse(59_000)).toBe("59s");
    expect(formatDurationCoarse(60_000)).toBe("1m0s");
    expect(formatDurationCoarse(134_000)).toBe("2m14s");
  });

  it("同秒完成（<1s）返 null——组头不显示没信息量的「0s」", () => {
    expect(formatDurationCoarse(0)).toBeNull();
    expect(formatDurationCoarse(400)).toBeNull();
    // 499ms 四舍五入到 0s 也不显示；500ms 起进位成 1s
    expect(formatDurationCoarse(499)).toBeNull();
    expect(formatDurationCoarse(500)).toBe("1s");
  });

  it("脏值返 null", () => {
    expect(formatDurationCoarse(undefined)).toBeNull();
    expect(formatDurationCoarse(Number.NaN)).toBeNull();
    expect(formatDurationCoarse(-1)).toBeNull();
  });
});
