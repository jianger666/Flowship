/**
 * 实时思考窗口的连续滚动（src/lib/live-tail-scroll.ts）
 *
 * 起因：用户反馈思考「速度时快时慢，像开车加速又刹车又加速」。除了文字吐出的速度（见 smooth-reveal.test.ts），
 * 另一半来自窗口——原先换一行就 scrollTo({ behavior: "smooth" }) 一次：每次是一段 ease-in-out，行间纹丝不动，
 * 浏览器实测 82% 的时间窗口不动、其余时间猛滚一下（1.2 次/秒的脉冲）。
 *
 * 现在窗口随文末光标在行内的书写进度连续上移。这里钉死：
 *   1. 几何性质：未溢出不平移 / 行内线性 / 换行连续 / 最新一行始终完整可见 / 脏输入不扩散；
 *   2. 与旧行为（整行阶跃）的对照：逐字书写时位移是「每个字一小步」而不是「每行一大步」，
 *      匀速书写下的速度几乎恒定（旧行为是尖峰）；
 *   3. 偏好「减少动态效果」：continuous=false 只在换行时阶跃、行内纹丝不动。
 *
 * 排版用一个简单模型代替真实 DOM：等宽字符、固定行宽 / 行高、光标是文末的 inline-block
 * （比行盒顶多一个固定的小偏移、左边有 2px 的 margin）——与 live-thinking-tail.tsx 的结构一致。
 */
import { describe, expect, it } from "vitest";

import {
  isLiveTailOverflowing,
  liveTailOffset,
  type LiveTailMetrics,
} from "../src/lib/live-tail-scroll";

const WIDTH = 470;
const LINE = 19.5; // text-xs（12px）× leading-relaxed（1.625）
const VIEWPORT = 112; // max-h-28
const CARET_DY = 1.7; // inline-block 光标比行盒顶多出的固定偏移
const CARET_MARGIN = 2; // ml-0.5

/** 等宽排版：第 n 个字符之后，光标在哪 */
const metricsAt = (n: number, perLine = 60): LiveTailMetrics => {
  const line = Math.floor(n / perLine);
  const col = n % perLine;
  return {
    caretTop: line * LINE + CARET_DY,
    caretLeft: col * (WIDTH / perLine) + CARET_MARGIN,
    width: WIDTH,
    lineHeight: LINE,
    viewport: VIEWPORT,
  };
};

/** 刚好占满窗口 5 行之后再写 */
const FIRST_OVERFLOW = Math.ceil((VIEWPORT / LINE) * 60);
/** 溢出之后的某一行的行首（对齐到整行：每行 60 个字） */
const LINE_START = Math.ceil((FIRST_OVERFLOW + 5 * 60) / 60) * 60;

describe("liveTailOffset：几何性质", () => {
  it("内容还没把窗口撑满：不平移（窗口随内容长高，顶部不能被裁）", () => {
    for (let n = 0; n < 5 * 60 - 1; n++) {
      expect(liveTailOffset(metricsAt(n))).toBe(0);
      expect(liveTailOffset(metricsAt(n), false)).toBe(0);
    }
  });

  it("溢出之后：偏移 > 0 且不小于「让最新一行底边贴窗口底边」所需的量", () => {
    for (let n = FIRST_OVERFLOW + 60; n < FIRST_OVERFLOW + 1000; n++) {
      const m = metricsAt(n);
      const offset = liveTailOffset(m);
      expect(offset).toBeGreaterThan(0);
      expect(offset).toBeGreaterThanOrEqual(m.caretTop + m.lineHeight - m.viewport - 1e-9);
    }
  });

  it("最新一行始终完整可见：行底边在窗口之内、行顶边也在窗口之内（任意书写进度）", () => {
    for (let n = 0; n < 3000; n++) {
      for (const continuous of [true, false]) {
        const m = metricsAt(n);
        const offset = liveTailOffset(m, continuous);
        const rowTop = m.caretTop - CARET_DY - offset;
        const rowBottom = m.caretTop - CARET_DY + m.lineHeight - offset;
        // 窗口高度 = min(内容高度, 上限)：未溢出时窗口随内容，此时 offset = 0、行一定在里面
        const windowHeight = Math.min(m.caretTop - CARET_DY + m.lineHeight, m.viewport);
        expect(rowTop).toBeGreaterThanOrEqual(-1e-9);
        expect(rowBottom).toBeLessThanOrEqual(windowHeight + 1e-9);
      }
    }
  });

  it("行内线性：同一行里光标从行首写到行尾，偏移单调增加、总增量恰好一整行高", () => {
    const base = LINE_START;
    let prev = liveTailOffset(metricsAt(base));
    const first = prev;
    for (let col = 1; col < 60; col++) {
      const cur = liveTailOffset(metricsAt(base + col));
      expect(cur).toBeGreaterThan(prev);
      prev = cur;
    }
    // 59 个字之后：已经写了 59/60 行，再写一个字就换行
    expect(prev - first).toBeCloseTo(((WIDTH / 60) * 59 / WIDTH) * LINE, 6);
    expect(liveTailOffset(metricsAt(base + 60)) - first).toBeCloseTo(LINE, 6);
  });

  it("换行连续：行尾写满、换到下一行行首，偏移只多一个字的量（不是一整行）", () => {
    const base = LINE_START;
    const lastOfLine = liveTailOffset(metricsAt(base + 59));
    const firstOfNext = liveTailOffset(metricsAt(base + 60));
    const jump = firstOfNext - lastOfLine;
    expect(jump).toBeGreaterThan(0);
    expect(jump).toBeLessThan(LINE / 60 + 0.05);
  });

  it("越界的书写进度被夹住：光标 offsetLeft 超过行宽 / 为负，也不会多滚或倒着滚", () => {
    const m = metricsAt(FIRST_OVERFLOW + 100);
    const atLeft = liveTailOffset({ ...m, caretLeft: 0 });
    const atRight = liveTailOffset({ ...m, caretLeft: WIDTH });
    expect(liveTailOffset({ ...m, caretLeft: -50 })).toBe(atLeft);
    expect(liveTailOffset({ ...m, caretLeft: WIDTH * 3 })).toBe(atRight);
    expect(atRight - atLeft).toBeCloseTo(LINE, 6);
  });

  it("窗口上限越大偏移越小（上限够高时不需要平移）", () => {
    const m = metricsAt(400);
    expect(liveTailOffset({ ...m, viewport: 112 })).toBeGreaterThan(liveTailOffset({ ...m, viewport: 200 }));
    expect(liveTailOffset({ ...m, viewport: 10_000 })).toBe(0);
  });

  it("脏输入不扩散：非有限数 / 宽度或行高或上限 ≤ 0 → 0，不平移", () => {
    const m = metricsAt(500);
    for (const key of ["caretTop", "caretLeft", "width", "lineHeight", "viewport"] as const) {
      expect(liveTailOffset({ ...m, [key]: Number.NaN })).toBe(0);
      expect(liveTailOffset({ ...m, [key]: Number.POSITIVE_INFINITY })).toBe(0);
    }
    expect(liveTailOffset({ ...m, width: 0 })).toBe(0);
    expect(liveTailOffset({ ...m, lineHeight: 0 })).toBe(0);
    expect(liveTailOffset({ ...m, viewport: 0 })).toBe(0);
    expect(liveTailOffset({ ...m, width: -1 })).toBe(0);
  });

  it("fuzz：偏移始终是有限的非负数", () => {
    let seed = 99;
    const r = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 2000; i++) {
      const offset = liveTailOffset(
        {
          caretTop: r() * 5000 - 100,
          caretLeft: r() * 1000 - 200,
          width: r() * 800,
          lineHeight: r() * 40,
          viewport: r() * 300,
        },
        r() < 0.5,
      );
      expect(Number.isFinite(offset)).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("isLiveTailOverflowing：只在最新一行底边超出窗口上限时才渐隐", () => {
  it("边界：底边 = 上限 + 1px 以内都不算溢出（避免亚像素抖动让渐隐一闪一闪）", () => {
    const m: LiveTailMetrics = { caretTop: 0, caretLeft: 0, width: WIDTH, lineHeight: LINE, viewport: VIEWPORT };
    expect(isLiveTailOverflowing({ ...m, caretTop: VIEWPORT - LINE })).toBe(false);
    expect(isLiveTailOverflowing({ ...m, caretTop: VIEWPORT - LINE + 1 })).toBe(false);
    expect(isLiveTailOverflowing({ ...m, caretTop: VIEWPORT - LINE + 1.01 })).toBe(true);
  });

  it("随书写：前 5 行不溢出，第 6 行起溢出；脏输入一律不溢出", () => {
    expect(isLiveTailOverflowing(metricsAt(0))).toBe(false);
    expect(isLiveTailOverflowing(metricsAt(4 * 60 + 59))).toBe(false);
    expect(isLiveTailOverflowing(metricsAt(5 * 60 + 5))).toBe(true);
    expect(isLiveTailOverflowing({ ...metricsAt(900), width: Number.NaN })).toBe(false);
    expect(isLiveTailOverflowing({ ...metricsAt(900), viewport: 0 })).toBe(false);
  });
});

describe("对照旧行为（整行阶跃）：连续滚动把「每行一大步」变成「每个字一小步」", () => {
  const steps = (continuous: boolean, from: number, to: number): number[] => {
    const out: number[] = [];
    let prev = liveTailOffset(metricsAt(from), continuous);
    for (let n = from + 1; n <= to; n++) {
      const cur = liveTailOffset(metricsAt(n), continuous);
      out.push(cur - prev);
      prev = cur;
    }
    return out;
  };

  it("逐字书写 1000 字：连续模式每个字最多挪 0.5px（≈ 一行高 / 每行字数）；整行阶跃模式每行挪一大步（19.5px）", () => {
    const from = FIRST_OVERFLOW + 60;
    const smooth = steps(true, from, from + 1000);
    const stepwise = steps(false, from, from + 1000);
    expect(Math.max(...smooth)).toBeLessThan(0.5);
    expect(Math.min(...smooth)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...stepwise)).toBeCloseTo(LINE, 6);
    // 整行阶跃：绝大多数字不动（1000 字 ≈ 16 行 → 只有 16 次跳变）
    expect(stepwise.filter((d) => d === 0).length).toBeGreaterThan(900);
    // 连续：每个字都在动
    expect(smooth.filter((d) => d === 0).length).toBe(0);
  });

  it("匀速书写（每帧 2–3 个字）下 100ms 窗口里的滚动速度几乎恒定；整行阶跃是尖峰（变异系数相差一个数量级以上）", () => {
    const speedCv = (continuous: boolean): number => {
      // 160 字/秒 ≈ 每帧 2.67 个字：每三帧写 8 个字
      const positions: number[] = [];
      let chars = FIRST_OVERFLOW + 60;
      for (let frame = 0; frame < 600; frame++) {
        chars += frame % 3 === 2 ? 2 : 3;
        positions.push(liveTailOffset(metricsAt(chars), continuous));
      }
      const win = 6; // 6 帧 ≈ 100ms
      const v: number[] = [];
      for (let i = 0; i + win < positions.length; i++) v.push(positions[i + win]! - positions[i]!);
      const mean = v.reduce((a, c) => a + c, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, c) => a + (c - mean) ** 2, 0) / v.length);
      return sd / mean;
    };
    const smooth = speedCv(true);
    const stepwise = speedCv(false);
    expect(smooth).toBeLessThan(0.12);
    expect(stepwise).toBeGreaterThan(1);
    expect(stepwise).toBeGreaterThan(smooth * 10);
  });
});

describe("偏好「减少动态效果」（continuous = false）：只在换行时阶跃", () => {
  it("同一行内偏移纹丝不动，换行时恰好多一整行高", () => {
    const base = LINE_START;
    const atLineStart = liveTailOffset(metricsAt(base), false);
    for (let col = 1; col < 60; col++) {
      expect(liveTailOffset(metricsAt(base + col), false)).toBe(atLineStart);
    }
    expect(liveTailOffset(metricsAt(base + 60), false) - atLineStart).toBeCloseTo(LINE, 6);
  });

  it("阶跃模式下最新一行底边正好贴窗口底边（与旧行为一致：最新的字总在窗口最底下）", () => {
    for (let n = FIRST_OVERFLOW + 60; n < FIRST_OVERFLOW + 600; n += 7) {
      const m = metricsAt(n);
      const offset = liveTailOffset(m, false);
      // 行盒底边 = caretTop − CARET_DY + LINE；相对窗口：减去 offset，应等于 viewport 减去光标那一点固定偏移
      expect(m.caretTop + m.lineHeight - offset).toBeCloseTo(m.viewport, 6);
    }
  });
});
