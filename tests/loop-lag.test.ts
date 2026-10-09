/**
 * loop-lag（src/lib/server/loop-lag.ts）单测
 *
 * 汇总是纯函数、直接钉；采样器本身用真实时间做一次集成：故意把事件循环堵住 150ms，
 * 窗口汇总里的 max 必须看得到——这是「服务端主线程被占住」能被观测到的最小保证。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  loopLagWindow,
  startLoopLagSampler,
  stopLoopLagSampler,
  summarizeLoopLag,
  type LoopLagSecond,
} from "@/lib/server/loop-lag";

const sec = (t: number, over: Partial<LoopLagSecond> = {}): LoopLagSecond => ({
  t,
  p50: 1,
  p99: 5,
  max: 10,
  elu: 0.2,
  gcMax: 0,
  gcCount: 0,
  ...over,
});

describe("summarizeLoopLag（纯函数）", () => {
  it("窗口选择：采样点覆盖 (t-1000, t]，与 [from,to] 有交集才纳入", () => {
    const samples = [sec(1000), sec(2000), sec(3000), sec(4000)];
    // [1500, 2500]：覆盖 (1000,2000] 和 (2000,3000] 两秒
    expect(summarizeLoopLag(samples, 1500, 2500)?.seconds).toBe(2);
    // 刚好在边界之外：to=1000 不含 (1000,2000]；from=4000 不含 t=4000（那秒在 4000 结束）
    expect(summarizeLoopLag(samples, 0, 1000)?.seconds).toBe(1);
    expect(summarizeLoopLag(samples, 4000, 9000)).toBeNull();
  });

  it("汇总口径：p99Max / max 取最大、elu 取均值、max>200ms 的秒数、gc 累加", () => {
    const samples = [
      sec(1000, { p99: 8, max: 20, elu: 0.1 }),
      sec(2000, { p99: 120, max: 450, elu: 0.9, gcMax: 35, gcCount: 2 }),
      sec(3000, { p99: 30, max: 250, elu: 0.5, gcMax: 60, gcCount: 1 }),
    ];
    const s = summarizeLoopLag(samples, 0, 3000)!;
    expect(s.seconds).toBe(3);
    expect(s.p99Max).toBe(120);
    expect(s.max).toBe(450);
    expect(s.eluAvg).toBeCloseTo(0.5, 5);
    expect(s.slowSeconds).toBe(2); // 450 和 250
    expect(s.gcMax).toBe(60);
    expect(s.gcCount).toBe(3);
  });

  it("窗口里没有采样 → null（调用方据此省略 proc 字段、不写 0 冒充『很健康』）", () => {
    expect(summarizeLoopLag([], 0, 9999)).toBeNull();
  });
});

describe("采样器（真实时间集成）", () => {
  afterEach(() => stopLoopLagSampler());

  it("没启动 → loopLagWindow 返回 null", () => {
    expect(loopLagWindow(0, Date.now())).toBeNull();
  });

  it("堵住事件循环 150ms，窗口汇总的 max 必须看得到；启动幂等", async () => {
    startLoopLagSampler();
    startLoopLagSampler(); // 幂等：不应起第二个
    const from = Date.now();
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    while (Date.now() - t0 < 150) {
      // busy-wait：模拟同步重活占住主线程
    }
    await new Promise((r) => setTimeout(r, 1300)); // 等至少一次采样落点
    const s = loopLagWindow(from, Date.now());
    expect(s).not.toBeNull();
    expect(s!.max).toBeGreaterThanOrEqual(100);
    expect(s!.slowSeconds).toBeGreaterThanOrEqual(0);
    expect(s!.eluAvg).toBeGreaterThan(0);
  }, 10_000);

  it("stop 之后窗口为空（状态被清掉、可重新 start）", async () => {
    startLoopLagSampler();
    stopLoopLagSampler();
    expect(loopLagWindow(0, Date.now())).toBeNull();
    startLoopLagSampler();
    stopLoopLagSampler();
  });
});
