/**
 * token 用量纯函数：归一（脏值 / 缺省）、逐字段累加、缩写格式化。
 * 锁住「脏 usage 不落假账」「累计不丢字段」「格式化不出 1.0k 这种」。
 */
import { describe, expect, it } from "vitest";

import {
  accumulateTokenUsage,
  addTurnUsage,
  cacheHitRatio,
  EMPTY_TURN_USAGE,
  formatTokens,
  normalizeTurnUsage,
  turnTotalTokens,
} from "@/lib/token-usage";
import type { TurnTokenUsage } from "@/lib/types";

const turn = (over: Partial<TurnTokenUsage> = {}): TurnTokenUsage => ({
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 800,
  cacheWriteTokens: 150,
  ...over,
});

describe("normalizeTurnUsage", () => {
  it("正常 SDK payload 原样收下、reasoning 有值才写出", () => {
    expect(normalizeTurnUsage(turn())).toEqual(turn());
    expect(normalizeTurnUsage(turn({ reasoningTokens: 42 }))).toEqual(
      turn({ reasoningTokens: 42 }),
    );
    // reasoning=0 视同没有、不写进对象（避免 UI 出「思考 0」这种噪音行）
    expect(
      normalizeTurnUsage(turn({ reasoningTokens: 0 })),
    ).not.toHaveProperty("reasoningTokens");
  });

  it("脏值归 0：NaN / Infinity / 负数 / 字符串 / 小数", () => {
    const got = normalizeTurnUsage({
      inputTokens: Number.NaN,
      outputTokens: Number.POSITIVE_INFINITY,
      cacheReadTokens: -5,
      cacheWriteTokens: "800",
      reasoningTokens: 12.6,
    });
    // 四个主字段全被打成 0 → 整条不落账
    expect(got).toBeNull();

    const partial = normalizeTurnUsage({
      inputTokens: 10.4,
      outputTokens: Number.NaN,
      cacheReadTokens: -1,
      cacheWriteTokens: null,
    });
    expect(partial).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("非对象 / 空 / 全 0 → null（不写一条全零的假记录）", () => {
    expect(normalizeTurnUsage(undefined)).toBeNull();
    expect(normalizeTurnUsage(null)).toBeNull();
    expect(normalizeTurnUsage("nope")).toBeNull();
    expect(normalizeTurnUsage({})).toBeNull();
    expect(
      normalizeTurnUsage({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });
});

describe("addTurnUsage", () => {
  it("逐字段相加", () => {
    expect(addTurnUsage(turn(), turn())).toEqual({
      inputTokens: 2000,
      outputTokens: 200,
      cacheReadTokens: 1600,
      cacheWriteTokens: 300,
    });
  });

  it("reasoning 单边有值也累计上", () => {
    const sum = addTurnUsage(turn(), turn({ reasoningTokens: 7 }));
    expect(sum.reasoningTokens).toBe(7);
    expect(
      addTurnUsage(
        turn({ reasoningTokens: 3 }),
        turn({ reasoningTokens: 7 }),
      ).reasoningTokens,
    ).toBe(10);
  });

  it("零基线相加 = 原值", () => {
    expect(addTurnUsage(EMPTY_TURN_USAGE, turn())).toEqual(turn());
  });
});

describe("accumulateTokenUsage", () => {
  it("首轮：last = total = 本轮、turns=1", () => {
    const got = accumulateTokenUsage(undefined, turn(), 1000);
    expect(got.last).toEqual(turn());
    expect(got.total).toEqual(turn());
    expect(got.turns).toBe(1);
    expect(got.updatedAt).toBe(1000);
  });

  it("第二轮：last 覆盖、total 累加、turns+1", () => {
    const first = accumulateTokenUsage(undefined, turn(), 1000);
    const second = accumulateTokenUsage(
      first,
      turn({ inputTokens: 500, outputTokens: 50 }),
      2000,
    );
    expect(second.last.inputTokens).toBe(500);
    expect(second.total.inputTokens).toBe(1500);
    expect(second.total.outputTokens).toBe(150);
    expect(second.turns).toBe(2);
    expect(second.updatedAt).toBe(2000);
  });

  it("prev 脏（缺 total / turns 非法）时从零重建、不抛", () => {
    const got = accumulateTokenUsage(
      { turns: -3 } as never,
      turn(),
      1000,
    );
    expect(got.total).toEqual(turn());
    expect(got.turns).toBe(1);
  });
});

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [842, "842"],
    [999, "999"],
    [1000, "1k"],
    [1234, "1.2k"],
    [12_345, "12k"],
    [597_928, "598k"],
    [1_000_000, "1M"],
    [5_426_732, "5.4M"],
    [12_400_000, "12M"],
  ])("%i → %s", (input, expected) => {
    expect(formatTokens(input)).toBe(expected);
  });

  it("脏值不炸、归 0", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("turnTotalTokens / cacheHitRatio", () => {
  it("总量 = 输入 + 输出", () => {
    expect(turnTotalTokens(turn())).toBe(1100);
  });

  it("命中率 = cacheRead / input，input=0 时返 null", () => {
    expect(cacheHitRatio(turn())).toBeCloseTo(0.8);
    expect(cacheHitRatio(turn({ inputTokens: 0 }))).toBeNull();
    // cacheRead 是 input 的子集、脏数据超出时夹到 1
    expect(cacheHitRatio(turn({ cacheReadTokens: 99_999 }))).toBe(1);
  });
});
