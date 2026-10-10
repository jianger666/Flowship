/**
 * 吐字节奏直方图（stream-cadence.ts）单测。
 *
 * 钉死的语义（每条都对应一个「不钉就会悄悄出错」的坑）：
 * - 间隔只在「同类 delta 连续」时记；被其它事件断开 / 正文与思考切换时，那一段空窗不算「吐字不顺」
 * - 分位数 = 所在桶的上界（保守），且不超过实测 max；溢出桶取 max
 * - 慢间隔 / 停顿的阈值是严格大于（100ms / 250ms）
 * - 时钟回拨 / NaN 的间隔丢弃，不污染分布
 * - 内存有界：一条 delta 不留任何痕迹，只累计数字（百万条后快照仍是固定大小）
 */
import { describe, expect, it } from "vitest";

import { createStreamCadence } from "@/lib/server/stream-cadence";

/** 按给定的相邻间隔序列喂 text-delta（第一条在 t0） */
const feedText = (
  c: ReturnType<typeof createStreamCadence>,
  gaps: number[],
  t0 = 1_000,
): number => {
  let t = t0;
  c.text(t);
  for (const g of gaps) {
    t += g;
    c.text(t);
  }
  return t;
};

describe("createStreamCadence：基本统计", () => {
  it("一条 delta 都没有 / 每段只有一条 → 没有可记的间隔，快照为 undefined", () => {
    const c = createStreamCadence();
    expect(c.snapshot()).toBeUndefined();
    c.text(100);
    expect(c.snapshot()).toBeUndefined();
  });

  it("匀速 33ms：n = delta 条数 − 1；桶上界是 35，但分位不超过实测 max → 报 33", () => {
    const c = createStreamCadence();
    feedText(c, [33, 33, 33, 33]);
    expect(c.snapshot()).toEqual({
      text: { n: 4, p50: 33, p95: 33, max: 33, over100: 0, over250: 0 },
    });
  });

  it("分位数取桶上界、但不超过实测 max（max 比上界小时以 max 为准）", () => {
    const c = createStreamCadence();
    // 33ms 落在 (30,35] 桶、上界 35；但实测 max 只有 33 → 报 33，不虚高
    feedText(c, [33]);
    expect(c.snapshot()?.text?.p50).toBe(33);
    // 再来一个 34：同桶，max=34，p95 → min(35,34)=34
    const c2 = createStreamCadence();
    feedText(c2, [33, 34]);
    expect(c2.snapshot()?.text).toMatchObject({ p50: 34, p95: 34, max: 34 });
  });

  it("90 个 10ms + 10 个 300ms：p50 = 10、p95 = 300、over100 = 10、over250 = 10", () => {
    const c = createStreamCadence();
    const gaps = [...Array.from({ length: 90 }, () => 10), ...Array.from({ length: 10 }, () => 300)];
    feedText(c, gaps);
    expect(c.snapshot()?.text).toEqual({
      n: 100,
      p50: 10,
      p95: 300,
      max: 300,
      over100: 10,
      over250: 10,
    });
  });

  it("溢出桶（> 5000ms）：分位取实测 max；over100 / over250 都计", () => {
    const c = createStreamCadence();
    feedText(c, [9_000]);
    expect(c.snapshot()?.text).toEqual({
      n: 1,
      p50: 9_000,
      p95: 9_000,
      max: 9_000,
      over100: 1,
      over250: 1,
    });
  });

  it("阈值是严格大于：100 不算慢、101 算；250 不算停顿、251 算", () => {
    const c = createStreamCadence();
    feedText(c, [100, 250]);
    expect(c.snapshot()?.text).toMatchObject({ over100: 1, over250: 0 });
    const c2 = createStreamCadence();
    feedText(c2, [101, 251]);
    expect(c2.snapshot()?.text).toMatchObject({ over100: 2, over250: 1 });
  });

  it("时钟回拨 / NaN 的间隔丢弃，不污染分布", () => {
    const c = createStreamCadence();
    c.text(1_000);
    c.text(900); // 回拨 → 丢弃
    c.text(Number.NaN); // NaN → 丢弃
    c.text(1_040); // 上一条是 NaN：40 - NaN = NaN → 丢弃
    c.text(1_080); // 正常 40ms
    expect(c.snapshot()?.text).toMatchObject({ n: 1, max: 40 });
  });
});

describe("createStreamCadence：连续段", () => {
  it("被其它事件（工具调用等）断开：断开前后的空窗不计，只记段内间隔", () => {
    const c = createStreamCadence();
    c.text(1_000);
    c.text(1_030);
    c.breakSegment(); // 模型去调工具了
    c.text(61_000); // 一分钟后才继续——这不是「吐字不顺」
    c.text(61_030);
    expect(c.snapshot()?.text).toEqual({
      n: 2,
      p50: 30,
      p95: 30,
      max: 30,
      over100: 0,
      over250: 0,
    });
  });

  it("正文 / 思考交替：切换那一下不记；各自只记自己的连续间隔", () => {
    const c = createStreamCadence();
    c.thinking(1_000);
    c.thinking(1_100);
    c.text(5_000); // 思考结束开始正文：切换，不记
    c.text(5_030);
    c.thinking(9_000); // 正文又回到思考：切换，不记
    expect(c.snapshot()).toEqual({
      text: { n: 1, p50: 30, p95: 30, max: 30, over100: 0, over250: 0 },
      thinking: { n: 1, p50: 100, p95: 100, max: 100, over100: 0, over250: 0 },
    });
  });

  it("只有思考时快照里没有 text 键（记录里不出现空对象）", () => {
    const c = createStreamCadence();
    c.thinking(0);
    c.thinking(100);
    const s = c.snapshot();
    expect(s).toBeDefined();
    expect("text" in (s ?? {})).toBe(false);
  });
});

describe("判读：与 2026-10-10 A/B 实测同形态的序列", () => {
  it("SDK 落盘实现（18.5MB）：约 197ms 一条 → p50 在 200 档、全部间隔 > 100ms", () => {
    const c = createStreamCadence();
    // 约 197ms 为主，夹杂少量 250ms+ 的停顿（实测 over250 = 33/484）
    const gaps = Array.from({ length: 484 }, (_, i) => (i % 15 === 0 ? 300 : 197));
    feedText(c, gaps);
    const s = c.snapshot()?.text;
    expect(s?.p50).toBe(200); // 197 落在 (150,200] 桶，分位取桶上界
    expect(s?.over100).toBe(484);
    expect(s?.over250).toBeGreaterThan(20);
  });

  it("内存实现：约 33ms 一条 → p50 ≈ 33、慢间隔极少", () => {
    const c = createStreamCadence();
    const gaps = Array.from({ length: 470 }, (_, i) => (i % 80 === 0 ? 130 : 33));
    feedText(c, gaps);
    const s = c.snapshot()?.text;
    expect(s?.p50).toBe(35); // 33 落在 (30,35] 桶；max 是 130，所以报桶上界 35
    expect(s?.over100).toBeLessThan(10);
    expect(s?.over250).toBe(0);
  });
});

describe("createStreamCadence：内存有界", () => {
  it("一百万条 delta 之后快照仍是固定大小的统计（不随条数增长）", () => {
    const c = createStreamCadence();
    let t = 0;
    for (let i = 0; i < 1_000_000; i += 1) {
      t += 20 + (i % 7);
      c.text(t);
    }
    const s = c.snapshot()?.text;
    expect(s?.n).toBe(999_999);
    expect(Object.keys(s ?? {}).sort()).toEqual(
      ["max", "n", "over100", "over250", "p50", "p95"].sort(),
    );
    expect(JSON.stringify(c.snapshot()).length).toBeLessThan(200);
  });
});
