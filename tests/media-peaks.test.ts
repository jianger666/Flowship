/**
 * 音频波形峰值（media-peaks）：computePeaks / shouldComputeWaveform
 */
import { describe, expect, it } from "vitest";

import {
  MAX_WAVEFORM_BYTES,
  MAX_WAVEFORM_SECONDS,
  computePeaks,
  shouldComputeWaveform,
} from "@/lib/media/media-peaks";

const arr = (a: Float32Array) => Array.from(a);

describe("computePeaks", () => {
  it("输出是 Float32Array，长度 = 桶数（向下取整，至少 1）", () => {
    const out = computePeaks([new Float32Array(100)], 8);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out).toHaveLength(8);
    expect(computePeaks([[0.5, 0.2]], 2.9)).toHaveLength(2);
    expect(computePeaks([[0.5, 0.2]], 0)).toHaveLength(1);
    expect(computePeaks([[0.5, 0.2]], -3)).toHaveLength(1);
  });

  it("每个桶取区间内绝对值的最大值（负值按绝对值）", () => {
    // 两个桶：[0.1, -0.4] 和 [0.2, -0.8]；全局最大 0.8 → 归一
    const out = computePeaks([[0.1, -0.4, 0.2, -0.8]], 2);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(1, 6);
  });

  it("多声道：每个桶取所有声道里的最大值", () => {
    const left = [0.1, 0, 0, 0];
    const right = [0, 0, 0, -0.5];
    const out = computePeaks([left, right], 2);
    // 桶 0：max(0.1, 0) = 0.1；桶 1：max(0, 0.5) = 0.5；按 0.5 归一
    expect(out[0]).toBeCloseTo(0.2, 6);
    expect(out[1]).toBeCloseTo(1, 6);
  });

  it("多声道：同一个桶里两个声道都有值，取大的而不是平均 / 求和", () => {
    const out = computePeaks([[0.3, 0.3], [0.6, 0.6]], 1);
    // 只有一个桶，归一后必为 1；用两个桶看相对关系
    expect(out[0]).toBe(1);
    const two = computePeaks([[0.3, 0.1], [0.2, 0.4]], 2);
    expect(two[0]).toBeCloseTo(0.75, 6); // max(0.3, 0.2) / 0.4
    expect(two[1]).toBeCloseTo(1, 6); // max(0.1, 0.4) / 0.4
  });

  it("归一：最大桶 = 1，其余按比例", () => {
    const out = computePeaks([[0.25, -0.5]], 2);
    expect(arr(out)).toEqual([0.5, 1]);
    const quiet = computePeaks([[0.05, 0.1, 0.02, 0.04]], 4);
    expect(quiet[1]).toBeCloseTo(1, 6);
    expect(quiet[0]).toBeCloseTo(0.5, 6);
    expect(quiet[2]).toBeCloseTo(0.2, 6);
  });

  it("爆音（采样值 > 1）：归一后仍不超过 1", () => {
    const out = computePeaks([[0.5, -1.5, 1.2, 0.3]], 4);
    for (const v of out) expect(v).toBeLessThanOrEqual(1);
    expect(out[1]).toBe(1);
    expect(out[0]).toBeCloseTo(0.5 / 1.5, 6);
  });

  it("静音 / 几乎静音（全局峰值 < 0.01）：不放大噪声", () => {
    const silence = computePeaks([new Float32Array(1000)], 10);
    expect(arr(silence)).toEqual(new Array(10).fill(0));
    const hiss = computePeaks([[0.001, -0.002, 0.0005, 0.005]], 4);
    expect(hiss[0]).toBeCloseTo(0.001, 6);
    expect(hiss[1]).toBeCloseTo(0.002, 6);
    expect(hiss[3]).toBeCloseTo(0.005, 6);
    // 没有任何一个被拉到 1
    expect(Math.max(...hiss)).toBeLessThan(0.01);
  });

  it("全局峰值恰好 0.01：开始归一（边界）", () => {
    const out = computePeaks([[0.01, 0.005]], 2);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    const below = computePeaks([[0.0099, 0.005]], 2);
    expect(below[0]).toBeCloseTo(0.0099, 6);
  });

  it("桶数 > 采样数：每个桶至少看一个采样，不出现越界 / 全 0 的尾巴", () => {
    const out = computePeaks([[0.5, -1]], 4);
    expect(arr(out)).toEqual([0.5, 0.5, 1, 1]);
    const one = computePeaks([[0.5]], 5);
    expect(arr(one)).toEqual([1, 1, 1, 1, 1]);
  });

  it("任意（采样数, 桶数）组合下，最后一个采样都不会被浮点误差漏掉", () => {
    for (let length = 1; length <= 200; length++) {
      for (let buckets = 1; buckets <= 70; buckets++) {
        const ch = new Float32Array(length);
        ch[length - 1] = 1;
        const out = computePeaks([ch], buckets);
        expect(out[buckets - 1], `length=${length} buckets=${buckets}`).toBe(1);
      }
    }
  });

  it("桶均匀覆盖整段：最后一个采样一定落在最后一个桶，边界采样只算一次", () => {
    // 长度 10 / 3 个桶：区间 [0,3) [3,6) [6,10)
    const spikeAtEnd = new Array(10).fill(0);
    spikeAtEnd[9] = 1;
    expect(arr(computePeaks([spikeAtEnd], 3))).toEqual([0, 0, 1]);
    const spikeAtBoundary = new Array(10).fill(0);
    spikeAtBoundary[3] = 1;
    expect(arr(computePeaks([spikeAtBoundary], 3))).toEqual([0, 1, 0]);
    const spikeAtStart = new Array(10).fill(0);
    spikeAtStart[0] = 1;
    expect(arr(computePeaks([spikeAtStart], 3))).toEqual([1, 0, 0]);
    const spikeBeforeBoundary = new Array(10).fill(0);
    spikeBeforeBoundary[2] = 1;
    expect(arr(computePeaks([spikeBeforeBoundary], 3))).toEqual([1, 0, 0]);
  });

  it("每个桶都能看到自己区间内的峰值（把唯一尖峰依次放到每个位置）", () => {
    const length = 37;
    const buckets = 5;
    for (let i = 0; i < length; i++) {
      const ch = new Array(length).fill(0);
      ch[i] = 1;
      const out = computePeaks([ch], buckets);
      // 恰好一个桶是 1，其余是 0
      expect(out.filter((v) => v === 1)).toHaveLength(1);
      expect(out.filter((v) => v === 0)).toHaveLength(buckets - 1);
      // 且所在桶符合 [floor(b*per), floor((b+1)*per)) 的划分
      const per = length / buckets;
      const b = out.indexOf(1);
      expect(i).toBeGreaterThanOrEqual(Math.floor(b * per));
      expect(i).toBeLessThan(b === buckets - 1 ? length : Math.floor((b + 1) * per));
    }
  });

  it("声道长度不一致：短声道不越界，长声道多出的部分照常计入", () => {
    const out = computePeaks([[0.1, 0.1], [0, 0, 0, 0, 0, 0, 0, 0.9]], 2);
    expect(out[0]).toBeCloseTo(0.1 / 0.9, 6);
    expect(out[1]).toBeCloseTo(1, 6);
  });

  it("空输入：没有声道 / 声道长度为 0 → 全 0 的 n 个桶", () => {
    expect(arr(computePeaks([], 4))).toEqual([0, 0, 0, 0]);
    expect(arr(computePeaks([[]], 3))).toEqual([0, 0, 0]);
    expect(arr(computePeaks([new Float32Array(0), new Float32Array(0)], 2))).toEqual([0, 0]);
  });

  it("NaN 采样不污染峰值", () => {
    const out = computePeaks([[Number.NaN, 0.5, Number.NaN, 0.25]], 2);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
  });

  it("支持 ArrayLike（Float32Array / 普通数组混用）", () => {
    const out = computePeaks([new Float32Array([0.5, 0]), [0, 1]], 2);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(1, 6);
  });

  it("不改动入参", () => {
    const ch = new Float32Array([0.5, -1, 0.25, 0.1]);
    const copy = Array.from(ch);
    computePeaks([ch], 2);
    expect(Array.from(ch)).toEqual(copy);
  });

  it("所有输出都在 [0, 1] 内", () => {
    const ch = Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) * 3);
    for (const v of computePeaks([ch], 64)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("shouldComputeWaveform", () => {
  it("常规音频：允许", () => {
    expect(shouldComputeWaveform(5 * 1024 * 1024)).toBe(true);
    expect(shouldComputeWaveform(5 * 1024 * 1024, 200)).toBe(true);
  });

  it("文件大小：<= 0 / 非有限 → 不算", () => {
    expect(shouldComputeWaveform(0)).toBe(false);
    expect(shouldComputeWaveform(-1)).toBe(false);
    expect(shouldComputeWaveform(Number.NaN)).toBe(false);
    expect(shouldComputeWaveform(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("大小上限 40MB：恰好允许，多 1 字节不允许", () => {
    expect(MAX_WAVEFORM_BYTES).toBe(40 * 1024 * 1024);
    expect(shouldComputeWaveform(MAX_WAVEFORM_BYTES)).toBe(true);
    expect(shouldComputeWaveform(MAX_WAVEFORM_BYTES + 1)).toBe(false);
    expect(shouldComputeWaveform(1)).toBe(true);
  });

  it("时长上限 20 分钟：恰好允许，超过不允许", () => {
    expect(MAX_WAVEFORM_SECONDS).toBe(20 * 60);
    expect(shouldComputeWaveform(1024, MAX_WAVEFORM_SECONDS)).toBe(true);
    expect(shouldComputeWaveform(1024, MAX_WAVEFORM_SECONDS + 0.5)).toBe(false);
    expect(shouldComputeWaveform(1024, 3600)).toBe(false);
  });

  it("时长未知（缺省 / NaN）不拦：此时只看大小", () => {
    expect(shouldComputeWaveform(1024, undefined)).toBe(true);
    expect(shouldComputeWaveform(1024, Number.NaN)).toBe(true);
    expect(shouldComputeWaveform(1024, 0)).toBe(true);
  });

  it("大小超限即使时长很短也不算", () => {
    expect(shouldComputeWaveform(MAX_WAVEFORM_BYTES + 1, 10)).toBe(false);
  });
});
