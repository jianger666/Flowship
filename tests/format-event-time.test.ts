/**
 * 事件流时间显示：今天只显示 HH:mm，跨天带日期，跨年再带年份。
 * 用本地时区构造时间（不依赖固定 TZ）。
 */
import { describe, expect, it, vi } from "vitest";

import { formatEventTime } from "@/lib/format-event-time";

// 本地时区的 2026-11-18 18:00
const NOW = new Date(2026, 10, 18, 18, 0, 0).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo - 1, d, h, mi, 0).getTime();

describe("formatEventTime", () => {
  it("今天 → 只有 HH:mm（补零）", () => {
    expect(formatEventTime(at(2026, 11, 18, 16, 55), NOW)).toBe("16:55");
    expect(formatEventTime(at(2026, 11, 18, 0, 5), NOW)).toBe("00:05");
    expect(formatEventTime(at(2026, 11, 18, 9, 3), NOW)).toBe("09:03");
  });

  it("跨天 → MM-DD HH:mm（昨天、更早都带日期）", () => {
    expect(formatEventTime(at(2026, 11, 17, 16, 55), NOW)).toBe("11-17 16:55");
    expect(formatEventTime(at(2026, 3, 2, 9, 3), NOW)).toBe("03-02 09:03");
  });

  it("午夜边界：23:59 与次日 00:01 属于不同的天", () => {
    const justAfterMidnight = at(2026, 11, 19, 0, 1);
    expect(formatEventTime(at(2026, 11, 18, 23, 59), justAfterMidnight)).toBe(
      "11-18 23:59",
    );
    expect(formatEventTime(justAfterMidnight, justAfterMidnight)).toBe("00:01");
  });

  it("跨年 → YYYY-MM-DD HH:mm；同月同日但年份不同也算跨天", () => {
    expect(formatEventTime(at(2025, 12, 31, 23, 30), NOW)).toBe(
      "2025-12-31 23:30",
    );
    expect(formatEventTime(at(2025, 11, 18, 16, 55), NOW)).toBe(
      "2025-11-18 16:55",
    );
  });

  it("未来的时间（时钟偏差）也不是今天，照样带日期", () => {
    expect(formatEventTime(at(2026, 11, 19, 8, 0), NOW)).toBe("11-19 08:00");
  });

  it("非法 / 占位时间戳 → 空串（流式合成事件 ts=0，不能显示成 1970 年）", () => {
    expect(formatEventTime(0, NOW)).toBe("");
    expect(formatEventTime(-1, NOW)).toBe("");
    expect(formatEventTime(Number.NaN, NOW)).toBe("");
    expect(formatEventTime(Number.POSITIVE_INFINITY, NOW)).toBe("");
  });

  it("不传 now 时用当前时间：刚刚发生的事件只显示 HH:mm、昨天的带日期", () => {
    // 钉死系统时间，避免恰好跨午夜时两次取「现在」不一致
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      expect(formatEventTime(NOW - 60_000)).toBe("17:59");
      expect(formatEventTime(at(2026, 11, 17, 17, 59))).toBe("11-17 17:59");
    } finally {
      vi.useRealTimers();
    }
  });
});
