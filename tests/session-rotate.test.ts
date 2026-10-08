/**
 * 保命轮换水位判断（2026-09-03 OOM 根治）——纯函数单测
 *
 * 阈值语义：当前 SDK 会话累计 input 200 万（同事实测崩时 278 万）。
 * 只看会话累计、不看单轮——转完后 tokenUsage.last 还是旧值，拿单轮做触发会无限连转。
 * 正常会话（累计几十万）永远撞不上；老任务缺字段 → 用 total 估算，转一次即自愈。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isPerfRotationDue,
  isSessionRotationDue,
  isTokenWatermarkEnabled,
  ROTATE_HEAP_FLOOR,
  ROTATE_PERF_INPUT_TOKENS,
  ROTATE_SESSION_INPUT_TOKENS,
  rotationUsageOf,
  shouldRotateSession,
  TOKEN_WATERMARK_ENV,
} from "@/lib/server/session-rotate";

// 2026-10-08 起 token 水位默认关闭。阈值语义的用例都在「总开关开启」下跑（回滚路径的行为锁）；
// 默认关闭的行为见文件末尾专门的 describe（内层 beforeEach 会把开关覆盖回关）。
beforeEach(() => {
  vi.stubEnv(TOKEN_WATERMARK_ENV, "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe("shouldRotateSession 双条件（水位 + 堆过半）", () => {
  const FAT = { sessionInputTokens: 2_788_972 };
  const THIN = { sessionInputTokens: 300_000 };

  it("超线 + 堆高 → 转", () => {
    expect(shouldRotateSession(FAT, 0.6)).toBe(true);
    expect(shouldRotateSession(FAT, ROTATE_HEAP_FLOOR)).toBe(true);
  });

  it("超线 + 堆低 → 不转（防过矫：堆不吃紧不折腾用户）", () => {
    expect(shouldRotateSession(FAT, 0.2)).toBe(false);
    expect(shouldRotateSession(FAT, ROTATE_HEAP_FLOOR - 0.01)).toBe(false);
  });

  it("没超线 → 堆再高也不转", () => {
    expect(shouldRotateSession(THIN, 0.9)).toBe(false);
  });

  it("缺省读实时堆（不注入也能调）", () => {
    expect(typeof shouldRotateSession(THIN)).toBe("boolean");
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

describe("isPerfRotationDue（速度水位 50 万，开关开启时）", () => {
  it("只认 sessionInputTokens；缺字段不转（不拿 total 兜底）", () => {
    expect(isPerfRotationDue({})).toBe(false);
    expect(isPerfRotationDue({ totalInputTokens: 99_000_000 })).toBe(false);
    expect(
      isPerfRotationDue({ sessionInputTokens: ROTATE_PERF_INPUT_TOKENS }),
    ).toBe(true);
    expect(
      isPerfRotationDue({ sessionInputTokens: ROTATE_PERF_INPUT_TOKENS - 1 }),
    ).toBe(false);
  });
});

describe("token 水位总开关（2026-10-08 起默认关闭）", () => {
  beforeEach(() => {
    vi.stubEnv(TOKEN_WATERMARK_ENV, ""); // 覆盖顶层的开启
  });
  const HUGE = { sessionInputTokens: 50_000_000, totalInputTokens: 90_000_000 };

  it("isTokenWatermarkEnabled：仅显式 1 / true 开启", () => {
    expect(isTokenWatermarkEnabled({})).toBe(false);
    expect(isTokenWatermarkEnabled({ [TOKEN_WATERMARK_ENV]: "" })).toBe(false);
    expect(isTokenWatermarkEnabled({ [TOKEN_WATERMARK_ENV]: "0" })).toBe(false);
    expect(isTokenWatermarkEnabled({ [TOKEN_WATERMARK_ENV]: "off" })).toBe(false);
    expect(isTokenWatermarkEnabled({ [TOKEN_WATERMARK_ENV]: "yes" })).toBe(false);
    expect(isTokenWatermarkEnabled({ [TOKEN_WATERMARK_ENV]: "1" })).toBe(true);
    expect(isTokenWatermarkEnabled({ [TOKEN_WATERMARK_ENV]: " TRUE " })).toBe(true);
  });

  it("阈值常量不变：开关打开后与改造前一致（速度 50 万 / 保命 200 万 / 堆 50%）", () => {
    // 用字面量锁死：边界测试引用常量本身是自洽的，抓不住「常量值被悄悄改了」
    expect(ROTATE_PERF_INPUT_TOKENS).toBe(500_000);
    expect(ROTATE_SESSION_INPUT_TOKENS).toBe(2_000_000);
    expect(ROTATE_HEAP_FLOOR).toBe(0.5);
  });

  it("默认关闭：累计再大也不触发保命水位 / 速度水位 / 双条件", () => {
    expect(isSessionRotationDue(HUGE)).toBe(false);
    expect(isPerfRotationDue(HUGE)).toBe(false);
    expect(shouldRotateSession(HUGE, 0.99)).toBe(false);
  });

  it("设 FLOWSHIP_TOKEN_WATERMARK=1 即恢复原行为（回滚手段）", () => {
    vi.stubEnv(TOKEN_WATERMARK_ENV, "1");
    expect(isSessionRotationDue(HUGE)).toBe(true);
    expect(isPerfRotationDue(HUGE)).toBe(true);
    expect(shouldRotateSession(HUGE, 0.99)).toBe(true);
  });
});
