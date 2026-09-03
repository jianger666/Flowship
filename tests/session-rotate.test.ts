/**
 * 保命轮换水位判断（2026-09-03 OOM 根治）——纯函数单测
 *
 * 阈值语义：当前 SDK 会话累计 input 200 万（同事实测崩时 278 万）。
 * 只看会话累计、不看单轮——转完后 tokenUsage.last 还是旧值，拿单轮做触发会无限连转。
 * 正常会话（累计几十万）永远撞不上；老任务缺字段 → 用 total 估算，转一次即自愈。
 */
import { describe, expect, it } from "vitest";

import {
  isSessionRotationDue,
  ROTATE_SESSION_INPUT_TOKENS,
  rotationUsageOf,
} from "@/lib/server/session-rotate";

describe("isSessionRotationDue", () => {
  it("空输入不转（老任务 fail-open）", () => {
    expect(isSessionRotationDue({})).toBe(false);
  });

  it("正常会话不转", () => {
    expect(
      isSessionRotationDue({ sessionInputTokens: 300_000 }),
    ).toBe(false);
  });

  it("会话累计超 200 万转（同事崩时 278 万）", () => {
    expect(isSessionRotationDue({ sessionInputTokens: 2_788_972 })).toBe(true);
  });

  it("老任务缺字段时用 total 兜底", () => {
    expect(
      isSessionRotationDue({ totalInputTokens: 2_788_972 }),
    ).toBe(true);
    expect(isSessionRotationDue({ totalInputTokens: 300_000 })).toBe(false);
  });

  it("会话计数优先于 total（转后清零即停，不连转）", () => {
    // 转完：锚点已换新、计数清零 → 即便 total 仍是 278 万也不转
    expect(
      isSessionRotationDue({
        sessionInputTokens: 45_000,
        totalInputTokens: 2_788_972,
      }),
    ).toBe(false);
  });

  it("边界值：恰好等于阈值即转", () => {
    expect(
      isSessionRotationDue({ sessionInputTokens: ROTATE_SESSION_INPUT_TOKENS }),
    ).toBe(true);
    expect(
      isSessionRotationDue({
        sessionInputTokens: ROTATE_SESSION_INPUT_TOKENS - 1,
      }),
    ).toBe(false);
  });
});

describe("rotationUsageOf", () => {
  it("从 Task 取水位，老任务缺字段不断言", () => {
    expect(rotationUsageOf({} as never)).toEqual({
      sessionInputTokens: undefined,
      totalInputTokens: undefined,
    });
    expect(
      isSessionRotationDue(
        rotationUsageOf({
          sessionInputTokens: 100,
          tokenUsage: {
            total: {
              inputTokens: 200,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        } as never),
      ),
    ).toBe(false);
  });
});
