/**
 * 播放器时间工具（media-time）：formatClock / parseClock / formatBytes / clampNumber
 */
import { describe, expect, it } from "vitest";

import {
  clampNumber,
  formatBytes,
  formatClock,
  parseClock,
} from "@/lib/media/media-time";

describe("clampNumber", () => {
  it("区间内原样、两侧夹到边界", () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
    expect(clampNumber(-1, 0, 10)).toBe(0);
    expect(clampNumber(11, 0, 10)).toBe(10);
    expect(clampNumber(0, 0, 10)).toBe(0);
    expect(clampNumber(10, 0, 10)).toBe(10);
  });

  it("NaN / ±Infinity 一律按 min", () => {
    expect(clampNumber(Number.NaN, 2, 10)).toBe(2);
    expect(clampNumber(Number.POSITIVE_INFINITY, 2, 10)).toBe(2);
    expect(clampNumber(Number.NEGATIVE_INFINITY, 2, 10)).toBe(2);
  });
});

describe("formatClock", () => {
  it("不满 1 小时：m:ss；满 1 小时：h:mm:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(5)).toBe("0:05");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(599)).toBe("9:59");
    expect(formatClock(3599)).toBe("59:59");
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(36000 + 61)).toBe("10:01:01");
  });

  it("digits 控制小数位（0–3），小数位补零", () => {
    expect(formatClock(12.4, { digits: 1 })).toBe("0:12.4");
    expect(formatClock(12, { digits: 1 })).toBe("0:12.0");
    expect(formatClock(12.345, { digits: 2 })).toBe("0:12.34");
    expect(formatClock(12.345, { digits: 3 })).toBe("0:12.345");
    expect(formatClock(0.05, { digits: 3 })).toBe("0:00.050");
    expect(formatClock(3725.5, { digits: 1 })).toBe("1:02:05.5");
  });

  it("pad：分钟补零（引用文本用），小时位不受影响", () => {
    expect(formatClock(12.4, { digits: 1, pad: true })).toBe("00:12.4");
    expect(formatClock(0, { pad: true })).toBe("00:00");
    expect(formatClock(754, { pad: true })).toBe("12:34");
    expect(formatClock(3725, { pad: true })).toBe("1:02:05");
  });

  it("不进位：59.96 秒不能显示成 0:60（向下取整到目标精度）", () => {
    expect(formatClock(59.96)).toBe("0:59");
    expect(formatClock(59.96, { digits: 1 })).toBe("0:59.9");
    expect(formatClock(59.999, { digits: 2 })).toBe("0:59.99");
    expect(formatClock(59.9999, { digits: 3 })).toBe("0:59.999");
    // 跨分钟 / 跨小时同理
    expect(formatClock(119.99)).toBe("1:59");
    expect(formatClock(3599.96)).toBe("59:59");
    expect(formatClock(3599.96, { digits: 1 })).toBe("59:59.9");
    expect(formatClock(3599.999, { digits: 3, pad: true })).toBe("59:59.999");
  });

  it("浮点误差不会让「刚好整」的值少 1（0.29 / 1.15 / 12.345）", () => {
    expect(formatClock(0.29, { digits: 2 })).toBe("0:00.29");
    expect(formatClock(1.15, { digits: 2 })).toBe("0:01.15");
    expect(formatClock(0.3, { digits: 1 })).toBe("0:00.3");
    expect(formatClock(0.7, { digits: 1 })).toBe("0:00.7");
    expect(formatClock(2.675, { digits: 3 })).toBe("0:02.675");
  });

  it("负数 / NaN / ±Infinity 一律当 0", () => {
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(-0.4, { digits: 1 })).toBe("0:00.0");
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(formatClock(Number.NEGATIVE_INFINITY, { pad: true })).toBe("00:00");
  });
});

describe("parseClock", () => {
  it("纯秒：整数 / 小数", () => {
    expect(parseClock("12")).toBe(12);
    expect(parseClock("12.5")).toBe(12.5);
    expect(parseClock("0")).toBe(0);
    expect(parseClock("0.033")).toBe(0.033);
    expect(parseClock("  7  ")).toBe(7);
  });

  it("冒号：分:秒", () => {
    expect(parseClock("1:02")).toBe(62);
    expect(parseClock("0:05")).toBe(5);
    expect(parseClock("1:02.5")).toBe(62.5);
    expect(parseClock("12:34")).toBe(754);
    expect(parseClock("0:5")).toBe(5);
    // 分钟允许三位（> 99 分钟的音频）
    expect(parseClock("125:00")).toBe(7500);
  });

  it("冒号：时:分:秒", () => {
    expect(parseClock("1:02:03")).toBe(3723);
    expect(parseClock("01:02:03.25")).toBe(3723.25);
    expect(parseClock("0:00:10")).toBe(10);
    expect(parseClock("10:59:59")).toBe(10 * 3600 + 59 * 60 + 59);
  });

  it("单位写法：1m30s / 90s / 1h2m3s / 大小写不敏感 / 小数", () => {
    expect(parseClock("1m30s")).toBe(90);
    expect(parseClock("90s")).toBe(90);
    expect(parseClock("5m")).toBe(300);
    expect(parseClock("2h")).toBe(7200);
    expect(parseClock("1h2m3s")).toBe(3723);
    expect(parseClock("1H2M3S")).toBe(3723);
    expect(parseClock("1.5m")).toBe(90);
    expect(parseClock("1h30s")).toBe(3630);
    expect(parseClock("0.5s")).toBe(0.5);
  });

  it("秒数 >= 60 一律非法（1:75 / 1:60 / 0:99）", () => {
    expect(parseClock("1:75")).toBeNull();
    expect(parseClock("1:60")).toBeNull();
    expect(parseClock("0:99")).toBeNull();
    expect(parseClock("1:02:60")).toBeNull();
    expect(parseClock("1:00:75.5")).toBeNull();
    // 边界：59 合法、59.99 合法
    expect(parseClock("1:59")).toBe(119);
    expect(parseClock("1:59.99")).toBeCloseTo(119.99, 6);
  });

  it("带小时时，分钟 >= 60 非法", () => {
    expect(parseClock("1:60:00")).toBeNull();
    expect(parseClock("1:75:00")).toBeNull();
    expect(parseClock("1:59:59")).toBe(3600 + 59 * 60 + 59);
  });

  it("非法输入 → null：乱码 / 空串 / 空白 / 负数 / 残缺格式", () => {
    for (const bad of [
      "abc",
      "",
      "   ",
      "-5",
      "-1:30",
      "1:",
      ":30",
      "1::30",
      "12.",
      ".5",
      "1:2:3:4",
      "1m 30s",
      "m",
      "1x",
      "30s1m",
      "1.2.3",
      "NaN",
      "Infinity",
      "1e3",
    ]) {
      expect(parseClock(bad), `输入 ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("与 formatClock 往返：解析 formatClock 的输出等于向下取整后的原值", () => {
    for (const v of [0, 5, 59, 60, 61, 599, 3599, 3600, 3723, 7325, 36061]) {
      expect(parseClock(formatClock(v))).toBe(v);
      expect(parseClock(formatClock(v, { pad: true }))).toBe(v);
    }
    for (const v of [0.5, 12.4, 59.9, 62.3, 3599.9, 3725.5]) {
      expect(parseClock(formatClock(v, { digits: 1 }))).toBeCloseTo(v, 6);
      expect(parseClock(formatClock(v, { digits: 1, pad: true }))).toBeCloseTo(v, 6);
    }
    // 向下取整：59.96 → "0:59.9" → 59.9（不会变成 60）
    expect(parseClock(formatClock(59.96, { digits: 1 }))).toBeCloseTo(59.9, 6);
    expect(parseClock(formatClock(12.345, { digits: 3 }))).toBeCloseTo(12.345, 6);
  });
});

describe("formatBytes", () => {
  it("B / KB / MB / GB 分档", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(500 * 1024)).toBe("500 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.5 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(123 * 1024 * 1024)).toBe("123 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.00 GB");
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.50 GB");
  });

  it("负数 / NaN / Infinity → 空串（卡片上不显示）", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("临界值不能进位出「1024 KB / 1024 MB」这种非规范写法", () => {
    expect(formatBytes(1024 * 1024 - 1)).not.toMatch(/^1024 /);
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3 - 1)).not.toMatch(/^1024 /);
    expect(formatBytes(1024 ** 3 - 1)).toBe("1.00 GB");
    // 同一档里的大值不受影响
    expect(formatBytes(1024 * 1024 - 1024)).toBe("1023 KB");
    expect(formatBytes(1024 ** 3 - 1024 * 1024)).toBe("1023 MB");
  });
});
