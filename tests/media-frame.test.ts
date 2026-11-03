/**
 * 逐帧计算（media-frame）：帧率吸附 / 估算 / 逐帧目标时间
 */
import { describe, expect, it } from "vitest";

import {
  COMMON_FPS,
  DEFAULT_FPS,
  estimateFpsFromDeltas,
  snapFps,
  stepFrameTarget,
} from "@/lib/media/media-frame";

describe("snapFps", () => {
  it("常见帧率原值返回（逐个覆盖表）", () => {
    for (const f of COMMON_FPS) expect(snapFps(f)).toBe(f);
  });

  it("3% 以内吸附到最近的常见帧率", () => {
    expect(snapFps(23.98)).toBe(23.976);
    expect(snapFps(24.05)).toBe(24);
    expect(snapFps(29.9)).toBe(29.97);
    expect(snapFps(30.2)).toBe(30);
    expect(snapFps(30.8)).toBe(30);
    expect(snapFps(59.5)).toBe(59.94);
    expect(snapFps(60.4)).toBe(60);
    expect(snapFps(119)).toBe(120);
  });

  it("两个常见值都在 3% 内时取更近的那个（24 与 25 之间）", () => {
    expect(snapFps(24.4)).toBe(24);
    expect(snapFps(24.6)).toBe(25);
  });

  it("23.976 / 24 与 29.97 / 30 / 59.94 / 60 能区分开，不被互相吞掉", () => {
    expect(snapFps(23.976)).toBe(23.976);
    expect(snapFps(24)).toBe(24);
    expect(snapFps(29.97)).toBe(29.97);
    expect(snapFps(30)).toBe(30);
    expect(snapFps(59.94)).toBe(59.94);
    expect(snapFps(60)).toBe(60);
  });

  it("离所有常见值都超过 3%：保留一位小数", () => {
    expect(snapFps(27)).toBe(27);
    expect(snapFps(27.04)).toBe(27);
    expect(snapFps(35.06)).toBe(35.1);
    expect(snapFps(15.04)).toBe(15);
    expect(snapFps(10)).toBe(10);
    expect(snapFps(90)).toBe(90);
  });

  it("离谱的值 → null：< 5、> 240、NaN、Infinity、负数", () => {
    expect(snapFps(4.99)).toBeNull();
    expect(snapFps(0)).toBeNull();
    expect(snapFps(-30)).toBeNull();
    expect(snapFps(240.1)).toBeNull();
    expect(snapFps(Number.NaN)).toBeNull();
    expect(snapFps(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("边界：5 和 240 本身有效", () => {
    expect(snapFps(5)).toBe(5);
    expect(snapFps(240)).toBe(240);
  });
});

describe("estimateFpsFromDeltas", () => {
  const fill = (d: number, n: number) => Array.from({ length: n }, () => d);

  it("样本不足（< 5 个有效差值）→ null", () => {
    expect(estimateFpsFromDeltas([])).toBeNull();
    expect(estimateFpsFromDeltas(fill(1 / 30, 4))).toBeNull();
    expect(estimateFpsFromDeltas(fill(1 / 30, 5))).toBe(30);
  });

  it("无效样本不计入：0 / 负数 / NaN / 过小 / 过大（>= 0.5 秒）", () => {
    const junk = [0, -0.03, Number.NaN, Number.POSITIVE_INFINITY, 0.001, 0.0005, 0.5, 2];
    expect(estimateFpsFromDeltas([...junk, ...fill(1 / 30, 4)])).toBeNull();
    expect(estimateFpsFromDeltas([...junk, ...fill(1 / 30, 5)])).toBe(30);
  });

  it("常见帧率：24 / 25 / 29.97 / 30 / 60 / 23.976 / 59.94", () => {
    expect(estimateFpsFromDeltas(fill(1 / 24, 20))).toBe(24);
    expect(estimateFpsFromDeltas(fill(1 / 25, 20))).toBe(25);
    expect(estimateFpsFromDeltas(fill(1001 / 30000, 20))).toBe(29.97);
    expect(estimateFpsFromDeltas(fill(1 / 30, 20))).toBe(30);
    expect(estimateFpsFromDeltas(fill(1 / 60, 20))).toBe(60);
    expect(estimateFpsFromDeltas(fill(1001 / 24000, 20))).toBe(23.976);
    expect(estimateFpsFromDeltas(fill(1001 / 60000, 20))).toBe(59.94);
  });

  it("带时间戳抖动（±1%）仍吸附到正确帧率", () => {
    const jitter = (base: number) =>
      Array.from({ length: 30 }, (_, i) => base * (1 + (((i * 7) % 5) - 2) * 0.005));
    expect(estimateFpsFromDeltas(jitter(1 / 24))).toBe(24);
    expect(estimateFpsFromDeltas(jitter(1 / 30))).toBe(30);
    expect(estimateFpsFromDeltas(jitter(1 / 60))).toBe(60);
  });

  it("丢帧：差值是帧周期整数倍的样本不能把帧率拉低", () => {
    // 24fps，30 个样本里 8 个是 2 倍周期（丢了一帧）、1 个是 3 倍
    const deltas = [...fill(1 / 24, 21), ...fill(2 / 24, 8), 3 / 24];
    expect(estimateFpsFromDeltas(deltas)).toBe(24);
  });

  it("丢帧很严重（60% 是 2 倍周期）也取到真实帧率——取偏小分位而不是中位数", () => {
    const deltas = [...fill(1 / 30, 4), ...fill(2 / 30, 6)];
    expect(estimateFpsFromDeltas(deltas)).toBe(30);
  });

  it("取的是 25% 分位：8 个有效样本取排序后的第 3 个（下标 2）", () => {
    // 排序后：60,60,30,30,30,30,30,30 → 下标 2 是 1/30
    expect(estimateFpsFromDeltas([...fill(1 / 60, 2), ...fill(1 / 30, 6)])).toBe(30);
    // 排序后：60,60,60,30,... → 下标 2 是 1/60
    expect(estimateFpsFromDeltas([...fill(1 / 60, 3), ...fill(1 / 30, 5)])).toBe(60);
  });

  it("与样本顺序无关，也不改动入参", () => {
    const deltas = [2 / 30, 1 / 30, 1 / 30, 3 / 30, 1 / 30, 1 / 30, 2 / 30, 1 / 30];
    const copy = [...deltas];
    const a = estimateFpsFromDeltas(deltas);
    expect(deltas).toEqual(copy);
    expect(estimateFpsFromDeltas([...deltas].reverse())).toBe(a);
    expect(a).toBe(30);
  });

  it("估出来的帧率离谱（> 240 或 < 5）→ null", () => {
    // 间隔 0.002s = 500fps
    expect(estimateFpsFromDeltas(fill(0.002, 10))).toBeNull();
    // 间隔 0.4s = 2.5fps（仍在有效差值范围内，但不是视频帧率）
    expect(estimateFpsFromDeltas(fill(0.4, 10))).toBeNull();
  });
});

describe("stepFrameTarget", () => {
  /** 目标时间对应第几帧（0 起） */
  const frameOf = (t: number, fps: number) => Math.floor(t * fps + 1e-6);
  /** 目标在所在帧里的相对位置（0..1） */
  const phase = (t: number, fps: number) => t * fps - Math.floor(t * fps + 1e-6);

  it("向前一帧：落在下一帧的中点", () => {
    expect(stepFrameTarget(0, 30, 1, 100)).toBeCloseTo(1.5 / 30, 9);
    expect(stepFrameTarget(1, 25, 1, 100)).toBeCloseTo(26.5 / 25, 9);
  });

  it("向后一帧：落在上一帧的中点", () => {
    expect(stepFrameTarget(1, 30, -1, 100)).toBeCloseTo(29.5 / 30, 9);
    expect(stepFrameTarget(2.5, 24, -1, 100)).toBeCloseTo(59.5 / 24, 9);
  });

  it("目标总在帧中点（不卡在两帧边界上）", () => {
    for (const fps of [24, 25, 29.97, 30, 59.94, 60]) {
      for (const t of [0.3, 1, 2.77, 10.5]) {
        for (const dir of [1, -1] as const) {
          expect(phase(stepFrameTarget(t, fps, dir, 1000), fps)).toBeCloseTo(0.5, 6);
        }
      }
    }
  });

  it("连续向前踏步：每步恰好前进一帧，不跳帧、不重帧", () => {
    for (const fps of [23.976, 24, 25, 29.97, 30, 59.94, 60]) {
      let t = 0;
      let prev = frameOf(t, fps);
      for (let i = 0; i < 300; i++) {
        t = stepFrameTarget(t, fps, 1, 1000);
        const f = frameOf(t, fps);
        expect(f, `fps=${fps} step=${i}`).toBe(prev + 1);
        prev = f;
      }
    }
  });

  it("连续向后踏步：每步恰好后退一帧", () => {
    for (const fps of [24, 29.97, 30, 60]) {
      let t = (300.5) / fps;
      let prev = frameOf(t, fps);
      expect(prev).toBe(300);
      for (let i = 0; i < 300; i++) {
        t = stepFrameTarget(t, fps, -1, 1000);
        const f = frameOf(t, fps);
        expect(f, `fps=${fps} step=${i}`).toBe(prev - 1);
        prev = f;
      }
      expect(prev).toBe(0);
    }
  });

  it("前进再后退回到同一帧", () => {
    for (const fps of [24, 29.97, 60]) {
      const start = 12.34;
      const f0 = frameOf(start, fps);
      const forward = stepFrameTarget(start, fps, 1, 1000);
      const back = stepFrameTarget(forward, fps, -1, 1000);
      expect(frameOf(back, fps)).toBe(f0);
    }
  });

  it("当前时间恰好踩在帧边界（k/fps）时不受浮点误差影响", () => {
    // 29.97 / 59.94 / 23.976 的 k/fps 乘回去常常是 k - 1e-15，不加容差会少算一帧
    for (const fps of [23.976, 29.97, 59.94, 30, 25]) {
      for (let k = 1; k <= 400; k++) {
        const t = k / fps;
        expect(frameOf(stepFrameTarget(t, fps, 1, 1e6), fps), `fps=${fps} k=${k} →`).toBe(k + 1);
        expect(frameOf(stepFrameTarget(t, fps, -1, 1e6), fps), `fps=${fps} k=${k} ←`).toBe(k - 1);
      }
    }
  });

  it("夹在 0 与 duration 之间", () => {
    // 开头往回：停在 0
    expect(stepFrameTarget(0, 30, -1, 10)).toBe(0);
    expect(stepFrameTarget(0.01, 30, -1, 10)).toBe(0);
    // 结尾往前：停在 duration
    expect(stepFrameTarget(10, 30, 1, 10)).toBe(10);
    expect(stepFrameTarget(9.99, 30, 1, 10)).toBe(10);
    // 倒数第二帧往前不越界，最后一帧中点之内照常落点
    expect(stepFrameTarget(9.9, 30, 1, 10)).toBeCloseTo(298.5 / 30, 9);
    expect(stepFrameTarget(9.9, 30, 1, 10)).toBeLessThanOrEqual(10);
  });

  it("到达 duration 后再往回一帧：回到最后一帧的中点", () => {
    expect(stepFrameTarget(10, 30, -1, 10)).toBeCloseTo(299.5 / 30, 9);
  });

  it("帧率非法 → 用默认 30", () => {
    expect(DEFAULT_FPS).toBe(30);
    const expected = stepFrameTarget(1, 30, 1, 100);
    expect(stepFrameTarget(1, 0, 1, 100)).toBe(expected);
    expect(stepFrameTarget(1, -24, 1, 100)).toBe(expected);
    expect(stepFrameTarget(1, Number.NaN, 1, 100)).toBe(expected);
    expect(stepFrameTarget(1, Number.POSITIVE_INFINITY, 1, 100)).toBe(expected);
  });

  it("duration 未知（0 / NaN / Infinity / 负数）→ 不设上限，只保证不小于 0", () => {
    expect(stepFrameTarget(100, 30, 1, 0)).toBeCloseTo(3001.5 / 30, 9);
    expect(stepFrameTarget(100, 30, 1, Number.NaN)).toBeCloseTo(3001.5 / 30, 9);
    expect(stepFrameTarget(100, 30, 1, Number.POSITIVE_INFINITY)).toBeCloseTo(3001.5 / 30, 9);
    expect(stepFrameTarget(100, 30, 1, -5)).toBeCloseTo(3001.5 / 30, 9);
    expect(stepFrameTarget(0, 30, -1, 0)).toBe(0);
  });

  it("currentTime 非法（NaN）→ 0，不抛", () => {
    expect(stepFrameTarget(Number.NaN, 30, 1, 10)).toBe(0);
  });
});
