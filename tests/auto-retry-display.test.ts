/**
 * 自定义 pi 内层自动重试的展示契约（R14 Q11-02）：
 * 重试开始时在时间线上落一行说明——业务口径、带「第 n/m 次」、不漏内部名词，次数异常时退化而不是显示 NaN。
 */
import { describe, expect, it } from "vitest";

import {
  AUTO_RETRY_META_KIND,
  autoRetryEventMeta,
  autoRetryEventText,
} from "@/lib/auto-retry-display";

describe("autoRetryEventText", () => {
  it("带第 n/m 次", () => {
    expect(autoRetryEventText({ attempt: 1, max: 3 })).toBe(
      "连接中断，已自动重试（第 1/3 次）",
    );
    expect(autoRetryEventText({ attempt: 3, max: 3 })).toBe(
      "连接中断，已自动重试（第 3/3 次）",
    );
  });

  it.each([
    ["次数为 0", { attempt: 0, max: 3 }],
    ["次数为负", { attempt: -1, max: 3 }],
    ["次数是小数", { attempt: 1.5, max: 3 }],
    ["次数是 NaN", { attempt: Number.NaN, max: 3 }],
    ["次数是 Infinity", { attempt: Number.POSITIVE_INFINITY, max: 3 }],
    ["次数是字符串", { attempt: "1", max: 3 }],
    ["上限缺失", { attempt: 1, max: undefined }],
    ["上限为 0", { attempt: 1, max: 0 }],
    ["两个都没有", {}],
  ])("%s → 退化成不带次数的短句，不显示 NaN / undefined / 0/0", (_name, input) => {
    const text = autoRetryEventText(input);
    expect(text).toBe("连接中断，已自动重试");
    expect(text).not.toMatch(/NaN|undefined|Infinity|0\/0|\//);
  });

  it("文案卫生：中文业务口径，不漏内部名词 / 状态码 / 英文词", () => {
    for (const text of [
      autoRetryEventText({ attempt: 1, max: 3 }),
      autoRetryEventText({}),
    ]) {
      expect(text).toMatch(/[\u4e00-\u9fa5]/);
      expect(text).not.toMatch(/auto_retry|retry_start|\bpi\b|HTTP|\b[1-5]\d\d\b/i);
      // 数字只允许出现在「第 n/m 次」里：去掉它之后不应再有任何英文字母
      expect(text.replace(/（第 \d+\/\d+ 次）/, "")).not.toMatch(/[A-Za-z]/);
    }
  });
});

describe("autoRetryEventMeta", () => {
  it("kind 固定为 auto_retry，带上合法的次数", () => {
    expect(AUTO_RETRY_META_KIND).toBe("auto_retry");
    expect(autoRetryEventMeta({ attempt: 2, max: 3 })).toEqual({
      kind: "auto_retry",
      attempt: 2,
      max: 3,
    });
  });

  it("非法次数不写进 meta，只保留合法的那个字段", () => {
    expect(autoRetryEventMeta({ attempt: 1, max: 0 })).toEqual({
      kind: "auto_retry",
      attempt: 1,
    });
    expect(autoRetryEventMeta({ attempt: Number.NaN, max: 3 })).toEqual({
      kind: "auto_retry",
      max: 3,
    });
    expect(autoRetryEventMeta({})).toEqual({ kind: "auto_retry" });
  });

  it("meta 里不带 pi 的原始错误文案（可能含接口地址 / 请求 id）", () => {
    const meta = autoRetryEventMeta({
      attempt: 1,
      max: 3,
      // 即使调用方多塞了字段，也不会被带进去
      errorMessage: "503 upstream https://example.invalid/v1 req_abc",
    } as never);
    expect(Object.keys(meta).sort()).toEqual(["attempt", "kind", "max"]);
  });
});
