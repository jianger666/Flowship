import { describe, expect, it } from "vitest";

import {
  formatShellFailureText,
  resolveShellTimeoutMs,
} from "../src/lib/server/pi-coding-tools";

describe("resolveShellTimeoutMs", () => {
  it("未传 / 非法值用默认 60 秒", () => {
    expect(resolveShellTimeoutMs(undefined)).toBe(60_000);
    expect(resolveShellTimeoutMs(null)).toBe(60_000);
    expect(resolveShellTimeoutMs(0)).toBe(60_000);
    expect(resolveShellTimeoutMs(-1)).toBe(60_000);
    expect(resolveShellTimeoutMs(Number.NaN)).toBe(60_000);
  });

  it("小于 1000 当秒（模型常传 15 / 30 / 60）", () => {
    expect(resolveShellTimeoutMs(15)).toBe(15_000);
    expect(resolveShellTimeoutMs(30)).toBe(30_000);
    expect(resolveShellTimeoutMs(60)).toBe(60_000);
  });

  it("大于等于 1000 当毫秒", () => {
    expect(resolveShellTimeoutMs(15_000)).toBe(15_000);
    expect(resolveShellTimeoutMs(60_000)).toBe(60_000);
  });

  it("夹到 5 秒 ~ 10 分钟，避免再出现 15ms 秒杀", () => {
    expect(resolveShellTimeoutMs(1)).toBe(5_000);
    expect(resolveShellTimeoutMs(4)).toBe(5_000);
    expect(resolveShellTimeoutMs(999)).toBe(10 * 60 * 1000);
    expect(resolveShellTimeoutMs(20 * 60 * 1000)).toBe(10 * 60 * 1000);
  });
});

describe("formatShellFailureText", () => {
  it("超时被杀时明确说可以出网，避免模型误判环境隔离", () => {
    expect(
      formatShellFailureText({ timeoutMs: 15_000, killed: true }),
    ).toContain("可以访问外网");
    expect(
      formatShellFailureText({
        timeoutMs: 15_000,
        killed: true,
        stdout: "partial",
      }),
    ).toMatch(/可以访问外网[\s\S]*partial/);
  });

  it("普通失败仍优先 stdout/stderr", () => {
    expect(
      formatShellFailureText({
        timeoutMs: 60_000,
        stdout: "oops",
        message: "Command failed",
      }),
    ).toBe("oops");
  });
});
