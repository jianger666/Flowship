/**
 * 匀速吐字（src/lib/smooth-reveal.ts）
 *
 * 两轮用户反馈：
 *   1. 「正文吐字很丝滑，思考吐字很机械」——思考的 thinking_delta 由服务端每 250ms 合并推一批，
 *      前端整批替换 → 每 250ms 一次整块跳变；
 *   2. 「现在很丝滑，但速度时快时慢，像开车加速又刹车又加速」——第一版的指数追赶（速度 = 积压 / τ）
 *      把批次节奏换成了速度的锯齿：每批积压阶跃 +N，速度跟着阶跃，再指数回落，4Hz 一个循环。
 *
 * 这里钉死三层：
 *   1. 推进函数自身的不变量（单调 / 不越界 / 必收敛 / 不卡死 / 大积压追赶 / dt 钳制 / 脏输入）；
 *   2. 到达速率估计（收敛 / 不被突发与停顿污染 / 冷启动 / 跟得上模型变速）；
 *   3. 用模拟时钟复现「模型 chunk 泊松到达 → 服务端 250ms 节流 → 网络抖动 → 60fps 渲染」的真实节奏，
 *      量化「速度是否匀」——并与**冻结在本文件里的旧算法**对比：旧算法已不在生产代码里，
 *      但「相对它的改善」才是这条测试要守的东西（数字是模拟出来的，绝对值只当回归守卫、不当体感保证）。
 */
import { describe, expect, it } from "vitest";

import {
  createRevealer,
  createRevealState,
  REVEAL_BUFFER_MS,
  REVEAL_DRAIN_AFTER_MS,
  REVEAL_FIRST_FRAME_MS,
  REVEAL_MAX_DT_MS,
  REVEAL_MIN_CPS,
  REVEAL_PRIOR_CPS,
  revealLength,
  stepReveal,
  type RevealState,
} from "../src/lib/smooth-reveal";

const FRAME = 1000 / 60;

/** 可复现的伪随机（mulberry32），测试不依赖 Math.random */
const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** 推进 n 帧（每帧 FRAME ms），目标固定；返回最后状态与时刻 */
const run = (
  s: RevealState,
  target: number,
  from: number,
  frames: number,
): { s: RevealState; t: number } => {
  let t = from;
  for (let i = 0; i < frames; i++) {
    s = stepReveal(s, target, t);
    t += FRAME;
  }
  return { s, t };
};

/** 稳态：每 250ms 一批、每批 n 字，持续 batches 批；返回最后状态 / 时刻 / 总字数 */
const steadyBatches = (n: number, batches: number, start?: RevealState) => {
  let s = start ?? createRevealState();
  let t = 0;
  let total = start?.seen ?? 0;
  for (let b = 0; b < batches; b++) {
    total += n;
    ({ s, t } = run(s, total, t, 15));
  }
  return { s, t, total };
};

describe("stepReveal：不变量", () => {
  it("fuzz：位置单调不减、不超过目标、始终是有限数；速率估计始终在合理范围（dt 含 0 与远超上限的值、偶尔来一大批）", () => {
    const r = rng(42);
    let s = createRevealState();
    let target = 0;
    let now = 0;
    for (let i = 0; i < 6000; i++) {
      target += r() < 0.05 ? Math.floor(r() * 3000) : Math.floor(r() * 60);
      now += r() < 0.1 ? r() * 5000 : r() * 40;
      const next = stepReveal(s, target, now);
      expect(Number.isFinite(next.pos)).toBe(true);
      expect(next.pos).toBeGreaterThanOrEqual(s.pos);
      expect(next.pos).toBeLessThanOrEqual(target);
      expect(next.rate).toBeGreaterThanOrEqual(1);
      expect(next.rate).toBeLessThanOrEqual(2000);
      expect(next.samples).toBeGreaterThanOrEqual(1);
      s = next;
    }
  });

  it("不卡死：不论之前经历了什么（冷启动 / 稳态 / 停顿后 / 排空 / 大积压），目标没到、dt>0 时每帧严格前进", () => {
    const r = rng(7);
    for (let trial = 0; trial < 40; trial++) {
      let s = createRevealState();
      let t = 0;
      let total = 0;
      const steps = 5 + Math.floor(r() * 60);
      for (let i = 0; i < steps; i++) {
        if (r() < 0.2) total += Math.floor(r() * (r() < 0.1 ? 4000 : 80));
        t += r() < 0.1 ? r() * 3000 : r() * 40;
        s = stepReveal(s, total, t);
      }
      total += 500; // 一定有未放完的
      for (let i = 0; i < 30; i++) {
        t += FRAME;
        const next = stepReveal(s, total, t);
        expect(next.pos).toBeGreaterThan(s.pos);
        s = next;
      }
    }
  });

  it("dt 为 0（同一帧重复调用）不前进、也不后退", () => {
    const s0 = stepReveal(createRevealState(), 100, 1000);
    const s1 = stepReveal(s0, 100, 1000);
    expect(s1.pos).toBe(s0.pos);
  });

  it.each([
    [1, 20],
    [10, 60],
    [100, 90],
    [1000, 150],
    [5000, 200],
    [20_000, 220],
  ])("必收敛：积压 %i 字、目标不再变，%i 帧内追平", (backlog, maxFrames) => {
    let s = createRevealState();
    let t = 0;
    let frames = 0;
    while (s.pos < backlog && frames < maxFrames) {
      s = stepReveal(s, backlog, t);
      t += FRAME;
      frames += 1;
    }
    expect(s.pos).toBe(backlog);
    expect(frames).toBeLessThan(maxFrames);
  });

  it("保底速度：到达速率很低（20 字/秒）、缓冲快吐空时放字速度也不低于保底——否则最后几个字要拖很久；保底又须低于任何真实的到达率，否则把匀速变回「吐完就停」", () => {
    const s: RevealState = {
      ...createRevealState(),
      rate: 20,
      samples: 99,
      pos: 99,
      at: 0,
      seen: 100,
      arrivedAt: FRAME,
    };
    // 缓冲只剩 1 字（目标 13 字）：水位修正会把速度压到 20 − 13 ≈ 6.7 字/秒，保底把它托到 REVEAL_MIN_CPS
    const next = stepReveal(s, 100, FRAME);
    expect((next.pos - 99) / (FRAME / 1000)).toBeGreaterThanOrEqual(REVEAL_MIN_CPS - 1e-9);
    expect(REVEAL_MIN_CPS).toBeLessThan(REVEAL_PRIOR_CPS);
  });

  it("大积压（重连补发 / 窗口从后台切回来）：追赶生效——几千字也在 ~2.7s 内追到只剩个位数，一半在 0.35s 内", () => {
    const target = 5000;
    let s = createRevealState();
    let t = 0;
    s = stepReveal(s, target, t);
    expect(s.pos).toBeGreaterThan(200); // 第一帧就吐了几百字
    let frames = 1;
    let half: number | null = null;
    while (target - s.pos >= 10 && frames < 170) {
      t += FRAME;
      s = stepReveal(s, target, t);
      frames += 1;
      if (half === null && s.pos >= target / 2) half = frames;
    }
    expect(target - s.pos).toBeLessThan(10);
    expect(frames).toBeLessThan(170); // 170 帧 ≈ 2.8s
    expect(half).not.toBeNull();
    expect(half!).toBeLessThanOrEqual(21); // ≈ 0.35s
  });

  it("积压越大、单帧吐得越多（追赶速率与积压成正比，不是固定步长）；稳态大小的积压不触发追赶", () => {
    const small = stepReveal(createRevealState(), 50, 0).pos;
    const big = stepReveal(createRevealState(), 5000, 0).pos;
    expect(big).toBeGreaterThan(small * 20);
    // 稳态：一批 30 字叠在已有缓冲上，速度仍然是「到达速率」量级（≈120 字/秒 ≈ 每帧 2 字），不是追赶的喷射
    const { s, t, total } = steadyBatches(30, 24);
    const before = s.pos;
    const next = stepReveal(s, total + 30, t);
    expect(next.pos - before).toBeLessThan(6);
  });

  it("dt 钳制：标签页被节流后一帧是几秒，与「上限那一帧」结果相同（不会一步跳到底之外的地方）", () => {
    const base: RevealState = { ...createRevealState(), pos: 0, at: 0, seen: 200 };
    // arrivedAt 取「现在」：排除「久没新批 → 排空」这个与 dt 无关的因素，只看 dt 钳制
    const huge = stepReveal({ ...base, arrivedAt: 5000 }, 200, 5000);
    const capped = stepReveal({ ...base, arrivedAt: REVEAL_MAX_DT_MS }, 200, REVEAL_MAX_DT_MS);
    expect(huge.pos).toBe(capped.pos);
    expect(huge.pos).toBeLessThan(200); // 200 字的积压一帧追不平——钳制确实在起作用
  });

  it("脏输入不扩散：时刻非有限当 dt=0；目标非有限回到 0；位置比目标还大时回到目标；位置非有限当作已追平", () => {
    const s: RevealState = { ...createRevealState(), pos: 5, at: 100, seen: 100, arrivedAt: 100 };
    expect(stepReveal(s, 100, Number.NaN).pos).toBe(5);
    expect(stepReveal(s, 100, Number.POSITIVE_INFINITY).pos).toBe(5);
    expect(stepReveal(s, Number.NaN, FRAME).pos).toBe(0);
    expect(stepReveal(s, Number.POSITIVE_INFINITY, FRAME).pos).toBe(0);
    expect(stepReveal({ ...s, pos: 50 }, 10, 120).pos).toBe(10);
    expect(stepReveal({ ...s, pos: Number.NaN }, 100, 120).pos).toBe(100);
    // 时刻倒退（不该发生）：dt 当 0，位置不动
    expect(stepReveal(s, 100, 50).pos).toBe(5);
    // 脏状态里的速率（NaN / 负数）回到先验，不扩散
    expect(stepReveal({ ...s, rate: Number.NaN }, 100, 120).rate).toBe(REVEAL_PRIOR_CPS);
    expect(stepReveal({ ...s, rate: -5 }, 100, 120).rate).toBe(REVEAL_PRIOR_CPS);
  });

  it("时刻非有限：当 dt=0，且时间基准不被污染——下一个正常的帧照常推进", () => {
    const s: RevealState = { ...createRevealState(), pos: 5, at: 100, seen: 100, arrivedAt: 100 };
    const bad = stepReveal(s, 100, Number.NaN);
    expect(bad.pos).toBe(5);
    expect(bad.at).toBe(100);
    const next = stepReveal(bad, 100, 100 + FRAME);
    expect(next.pos).toBeGreaterThan(5);
  });

  it("累计坐标回落（正常不会发生）：已见目标对齐到新的目标，之后的增长仍被认成「新到了一批」", () => {
    let s = stepReveal(createRevealState(), 100, 0);
    s = stepReveal(s, 100, 250);
    const dropped = stepReveal(s, 40, 500);
    expect(dropped.seen).toBe(40);
    const regrown = stepReveal(dropped, 70, 750);
    expect(regrown.seen).toBe(70);
    expect(regrown.arrivedAt).toBe(750);
  });

  it("排空：超过 REVEAL_DRAIN_AFTER_MS 没有新批 = 后面没数据了，不再留缓冲、比稳态更快地放完剩余", () => {
    // 稳态缓冲约 78 字（120 字/秒 × 0.65s）；最后一批到达后不再有新批
    const { s, t, total } = steadyBatches(30, 24);
    let live = s;
    let now = t;
    // 最后一批之后 REVEAL_DRAIN_AFTER_MS 内：缓冲只是慢慢被吃掉、速度随缓冲下降
    const arrivedAt = live.arrivedAt!;
    let drainFrames = 0;
    while (live.pos < total && drainFrames < 400) {
      now += FRAME;
      live = stepReveal(live, total, now);
      drainFrames += 1;
    }
    const finishedAfter = now - arrivedAt;
    expect(live.pos).toBe(total);
    // 从最后一批到全部放完：不超过 1.5s（排空让它不会拖着缓冲慢慢放）
    expect(finishedAfter).toBeLessThan(1500);
    expect(REVEAL_DRAIN_AFTER_MS).toBeGreaterThan(250); // 须大于批间隔，否则稳态里批间的抖动会误触发排空
  });
});

describe("水位修正：缓冲偏低比偏高修得更积极", () => {
  // 构造一个稳态状态：速率 120 字/秒、缓冲目标 = 120 × 0.65 = 78 字、刚到过一批（idle = 0，不触发排空）
  const RATE = 120;
  const WANT = (RATE * REVEAL_BUFFER_MS) / 1000;
  /** 积压为 backlog 时，这一帧的放字速度（字/秒） */
  const speedAt = (backlog: number): number => {
    const target = 1000;
    const s: RevealState = {
      ...createRevealState(),
      rate: RATE,
      samples: 99,
      pos: target - backlog,
      at: 0,
      seen: target,
      arrivedAt: FRAME,
    };
    const next = stepReveal(s, target, FRAME);
    return (next.pos - s.pos) / (FRAME / 1000);
  };

  it("缓冲正好在目标上：速度就是到达速率（不随批次起伏）", () => {
    expect(speedAt(WANT)).toBeCloseTo(RATE, 6);
  });

  it("缓冲偏高：略微加快；偏低：减慢——且偏低的修正量是偏高的 2 倍（快吐空比积压多一点危险得多，要更早减速）", () => {
    const delta = 30;
    const up = speedAt(WANT + delta) - RATE;
    const down = RATE - speedAt(WANT - delta);
    expect(up).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(0);
    expect(down / up).toBeCloseTo(2, 6);
  });

  it("修正是「缓慢」的：缓冲偏离目标 30 字（≈ 25%）只让速度变 14–28%，不是对单批的猛烈反应", () => {
    const delta = 30;
    expect(speedAt(WANT + delta) / RATE - 1).toBeLessThan(0.15);
    expect(1 - speedAt(WANT - delta) / RATE).toBeLessThan(0.3);
  });
});

describe("到达速率估计", () => {
  it("稳态（250ms 一批、每批 30 字 = 120 字/秒）：6s 后估计在真值 ±8% 内", () => {
    const { s } = steadyBatches(30, 24);
    expect(s.rate).toBeGreaterThan(120 * 0.92);
    expect(s.rate).toBeLessThan(120 * 1.08);
  });

  it("批大小与到达时刻都有抖动（±50% / ±25ms）：估计稳定在真值附近，不随单批起伏", () => {
    const r = rng(11);
    let s = createRevealState();
    let t = 0;
    let total = 0;
    const rates: number[] = [];
    for (let b = 0; b < 100; b++) {
      total += Math.round(30 * (0.5 + r()));
      const jitter = (r() - 0.5) * 50;
      const frames = Math.round((250 + jitter) / FRAME);
      ({ s, t } = run(s, total, t, frames));
      if (b >= 32) rates.push(s.rate);
    }
    expect(Math.min(...rates)).toBeGreaterThan(95);
    expect(Math.max(...rates)).toBeLessThan(145);
  });

  it("冷启动：首批只有几个字，之后每 250ms 30 字——2s（8 批）内估计就爬到真值的 80% 以上", () => {
    let s = createRevealState();
    let t = 0;
    let total = 0;
    const rates: number[] = [];
    for (let b = 0; b < 8; b++) {
      total += b === 0 ? 7 : 30;
      ({ s, t } = run(s, total, t, 15));
      rates.push(s.rate);
    }
    expect(rates[0]).toBeLessThan(80); // 第一批什么也说明不了，估计还很低
    expect(rates[7]).toBeGreaterThan(120 * 0.8);
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1]!); // 单调爬升
  });

  it("首批就是巨大的一块（重连补发整段文本）：不代表速率，保持先验", () => {
    const s = stepReveal(createRevealState(), 5000, 0);
    expect(s.rate).toBe(REVEAL_PRIOR_CPS);
    expect(s.samples).toBe(1);
  });

  it("突发不污染：稳态之后一次涌入 3000 字（后台标签页回来），估计纹丝不动", () => {
    const { s, t, total } = steadyBatches(30, 24);
    const { s: after } = run(s, total + 3000, t, 15);
    expect(after.rate).toBe(s.rate);
  });

  it("模型停顿（批间隔 > 1.2s）之后的那一批不进估计：它的「字数 / 间隔」不是速率", () => {
    const { s, t, total } = steadyBatches(30, 24);
    // rAF 在追平后休眠：醒来时 now 已经过了 2s
    const after = stepReveal(s, total + 30, t + 2000);
    expect(after.rate).toBe(s.rate);
    expect(after.arrivedAt).toBe(t + 2000); // 但「新到了一批」本身要记（排空判定靠它）
  });

  it("模型真的变快（60 → 240 字/秒）：跟得上，但不是一批就跳——6s 后到新值的 75% 以上，且变化前纹丝不动", () => {
    let s = createRevealState();
    let t = 0;
    let total = 0;
    const history: Array<{ at: number; rate: number }> = [];
    for (let b = 0; b < 80; b++) {
      total += b < 24 ? 15 : 60;
      ({ s, t } = run(s, total, t, 15));
      history.push({ at: t, rate: s.rate });
    }
    const beforeChange = history.filter((h) => h.at > 2000 && h.at <= 6000).map((h) => h.rate);
    expect(Math.min(...beforeChange)).toBeGreaterThan(55);
    expect(Math.max(...beforeChange)).toBeLessThan(65);
    const sixAfter = history.find((h) => h.at >= 12_000)!;
    expect(sixAfter.rate).toBeGreaterThan(60 + 0.75 * 180);
    // 变化后第一秒还远没到新值：是缓慢跟随、不是对单批的反应
    const oneAfter = history.find((h) => h.at >= 7000)!;
    expect(oneAfter.rate).toBeLessThan(60 + 0.5 * 180);
  });
});

describe("revealLength：切点不落在代理对（emoji）中间", () => {
  it("普通文本：floor 后钳到 [0, 长度]", () => {
    expect(revealLength(3.9, "abcdef")).toBe(3);
    expect(revealLength(-5, "abcdef")).toBe(0);
    expect(revealLength(99, "abcdef")).toBe(6);
  });

  it("切点正好落在 emoji 中间：把低代理项一并带上，不闪 �", () => {
    // "a😀b" = a, \ud83d, \ude00, b；显示 2 个 code unit 会停在 \ud83d 之后
    const text = "a😀b";
    expect(revealLength(2, text)).toBe(3);
    expect(text.slice(0, revealLength(2, text))).toBe("a😀");
  });

  it("目标末尾恰好是孤立的高代理项（chunk 把 emoji 切成两半、后半还没到）：先不显示它", () => {
    const text = `ab${"😀".charAt(0)}`; // 末尾是孤立高代理
    expect(revealLength(3, text)).toBe(2);
    expect(text.slice(0, revealLength(3, text))).toBe("ab");
  });

  it("任何整数切点的结果都不以孤立高代理项结尾", () => {
    const text = "x😀y😀😀z";
    for (let p = 0; p <= text.length; p++) {
      const shown = text.slice(0, revealLength(p, text));
      expect(shown).not.toMatch(/[\ud800-\udbff]$/);
    }
  });
});

describe("createRevealer：带状态的推进器", () => {
  it("首帧没有上一帧可比，按 60fps 一帧算（与手算一致）", () => {
    const rv = createRevealer();
    const pos = rv.advance(100, 5000);
    expect(pos).toBe(stepReveal(createRevealState(), 100, 5000).pos);
    expect(stepReveal(createRevealState(), 100, 5000).at).toBe(5000);
    expect(REVEAL_FIRST_FRAME_MS).toBeCloseTo(FRAME, 6);
  });

  it("之后按真实间隔推进：两次调用间隔多久，dt 就是多久", () => {
    const rv = createRevealer();
    rv.advance(100, 1000);
    const before = rv.position;
    const pos = rv.advance(100, 1050);
    const manual = stepReveal(stepReveal(createRevealState(), 100, 1000), 100, 1050);
    expect(pos).toBe(manual.pos);
    expect(pos).toBeGreaterThan(before);
  });

  it("reset：位置、时间基准、速率估计都清零，状态与全新的一模一样；下一帧又按首帧算", () => {
    const rv = createRevealer();
    for (let i = 0; i < 100; i++) rv.advance(300 + i * 30, i * FRAME); // 把状态推离初始值
    expect(rv.state).not.toEqual(createRevealState());
    rv.reset();
    expect(rv.state).toEqual(createRevealState());
    expect(rv.position).toBe(0);
    expect(rv.advance(100, 99_999)).toBe(stepReveal(createRevealState(), 100, 99_999).pos);
  });

  it("seek：只改位置，其余（时间基准、速率估计、已见目标）原样保留——保留窗口起点前移到了位置前面时用", () => {
    const rv = createRevealer();
    // 先走一阵稳态，让速率估计离开先验
    let total = 0;
    let t = 0;
    for (let b = 0; b < 24; b++) {
      total += 30;
      for (let f = 0; f < 15; f++) {
        rv.advance(total, t);
        t += FRAME;
      }
    }
    const before = rv.state;
    expect(before.rate).toBeGreaterThan(100); // 估计已经离开先验（60）
    rv.seek(total - 20);
    expect(rv.position).toBe(total - 20);
    expect(rv.state).toEqual({ ...before, pos: total - 20 });
    const pos = rv.advance(total, t);
    expect(pos).toBeGreaterThan(total - 20);
    expect(pos).toBeLessThanOrEqual(total);
  });

  it("state 是只读快照：外面改它不影响推进器（状态对象不可变，每帧换新对象）", () => {
    const rv = createRevealer();
    rv.advance(100, 0);
    const snap = rv.state;
    const frozenPos = snap.pos;
    rv.advance(100, FRAME);
    expect(snap.pos).toBe(frozenPos); // 旧快照没被改
    expect(rv.state).not.toBe(snap);
  });
});

// ---------------------------------------------------------------------------
// 模拟：模型 chunk 泊松到达 → 服务端 leading+trailing 250ms 节流 → 网络抖动 → 60fps
// ---------------------------------------------------------------------------

interface Arrival {
  t: number;
  total: number;
}

/**
 * 服务端 + 网络。模型每秒 ~17 个 chunk、间隔指数分布、每个 chunk 字数 ±60% 浮动；
 * 服务端首帧零延迟、其后 250ms 节流只合并不丢字；到达前端有 25–40ms 的延迟，8% 的帧再晚 60–180ms。
 * stalls：模型停顿（这段时间没有 chunk）；endAt：这之后模型不再产生 chunk（思考结束前的收尾）。
 */
const genArrivals = (opts: {
  seed: number;
  cps?: number;
  seconds?: number;
  modulate?: number;
  stalls?: Array<{ at: number; len: number }>;
  endAt?: number;
}): Arrival[] => {
  const r = rng(opts.seed);
  const cps = opts.cps ?? 120;
  const seconds = opts.seconds ?? 30;
  const chunkRate = 17;
  const chunks: Array<{ t: number; n: number }> = [];
  let t = 0;
  while (t < (opts.endAt ?? seconds * 1000)) {
    const rate = chunkRate * (1 + (opts.modulate ?? 0) * Math.sin((2 * Math.PI * t) / 5000));
    t += (-Math.log(1 - r()) / rate) * 1000;
    const stall = opts.stalls?.find((s) => t >= s.at && t < s.at + s.len);
    if (stall) t = stall.at + stall.len;
    chunks.push({ t, n: Math.max(1, Math.round((cps / chunkRate) * (0.4 + 1.2 * r()))) });
  }
  const frames: Arrival[] = [];
  let total = 0;
  let lastSend = -Infinity;
  let timer: number | null = null;
  const flush = (at: number) => {
    frames.push({ t: at, total });
    lastSend = at;
    timer = null;
  };
  for (const c of chunks) {
    while (timer !== null && timer <= c.t) flush(timer);
    total += c.n;
    if (timer === null) {
      if (c.t - lastSend >= 250) flush(c.t);
      else timer = lastSend + 250;
    }
  }
  if (timer !== null) flush(timer);
  const arrivals: Arrival[] = [];
  let lastArr = 0;
  for (const f of frames) {
    let lat = 25 + 15 * r();
    if (r() < 0.08) lat += 60 + 120 * r();
    const at = Math.max(f.t + lat, lastArr + 0.1);
    lastArr = at;
    arrivals.push({ t: at, total: f.total });
  }
  return arrivals;
};

interface Sample {
  t: number;
  pos: number;
  arrived: number;
}

/**
 * 前端：60fps rAF（帧间隔有 ±0.8ms 抖动、1% 的帧掉一帧）；追平后休眠、新批到达唤醒（与 use-smooth-thinking 一致：
 * 不空转，休眠期间不更新时间基准）。advance(target, now) 返回新的浮点位置。
 */
const runFrontend = (
  arrivals: Arrival[],
  advance: (target: number, now: number) => number,
  opts: { seconds?: number; seed: number; extra?: Arrival[] },
): Sample[] => {
  const r = rng(opts.seed);
  const seconds = opts.seconds ?? 30;
  const all = [...arrivals, ...(opts.extra ?? [])].sort((a, b) => a.t - b.t);
  let target = 0;
  let ai = 0;
  let asleep = false;
  let pos = 0;
  const samples: Sample[] = [];
  let t = 0;
  while (t < seconds * 1000) {
    let changed = false;
    while (ai < all.length && all[ai]!.t <= t) {
      if (all[ai]!.total !== target) changed = true;
      target = all[ai]!.total;
      ai += 1;
    }
    if (!asleep || changed) {
      asleep = false;
      pos = advance(target, t);
      if (!(pos < target)) asleep = true;
    }
    samples.push({ t, pos, arrived: target });
    t += FRAME + (r() - 0.5) * 1.6;
    if (r() < 0.01) t += FRAME;
  }
  return samples;
};

/** 冻结的旧算法（第一版：指数追赶 τ=300ms、保底 15 字/秒）。生产代码已不是它；留在这里只做对照基线 */
const legacyAdvance = () => {
  let pos = 0;
  let lastAt: number | null = null;
  return (target: number, now: number): number => {
    const dt = lastAt === null ? FRAME : now - lastAt;
    lastAt = now;
    if (!Number.isFinite(target)) return (pos = 0);
    if (!(target > pos)) return (pos = target);
    const d = Math.min(Math.max(dt, 0), 100);
    const eased = (target - pos) * (1 - Math.exp(-d / 300));
    pos = Math.min(target, pos + Math.max(eased, (15 * d) / 1000));
    return pos;
  };
};

const currentAdvance = () => {
  const rv = createRevealer();
  return (target: number, now: number) => rv.advance(target, now);
};

const posAt = (samples: Sample[], t: number): number => {
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return Math.floor(samples[lo]!.pos);
};

/** 窗口速度序列（字/秒）：[from, to] 内每 step ms 取一个 win ms 窗口里新增的字数 */
const speeds = (s: Sample[], from: number, to: number, win: number, step: number): number[] => {
  const v: number[] = [];
  for (let t = from; t + win <= to; t += step) v.push(((posAt(s, t + win) - posAt(s, t)) / win) * 1000);
  return v;
};

const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
const quantile = (v: number[], p: number): number => {
  const sorted = [...v].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};
const cvOf = (v: number[]): number => {
  const m = mean(v);
  return Math.sqrt(mean(v.map((x) => (x - m) ** 2))) / m;
};
/** Goertzel：序列里 hz 频率分量的振幅（相对均值） */
const toneAmp = (v: number[], stepMs: number, hz: number): number => {
  const m = mean(v);
  const w = (2 * Math.PI * hz * stepMs) / 1000;
  let re = 0;
  let im = 0;
  v.forEach((x, i) => {
    re += (x - m) * Math.cos(w * i);
    im += (x - m) * Math.sin(w * i);
  });
  return (2 * Math.hypot(re, im)) / v.length / m;
};

interface Metrics {
  /** 100ms 窗口速度的变异系数（越小越匀） */
  cv: number;
  /** 100ms 窗口速度 p95 / p5（峰谷比） */
  spread: number;
  /** 相邻 50ms 的窗口速度变化 / 均值 的 p95（「急加速 / 急刹车」的幅度） */
  jerk: number;
  /** 批节奏（4Hz）在速度里的纹波幅度（相对均值）——旧算法的锯齿就在这里 */
  ripple4: number;
  /** 稳态里最长连续没有新字的时长（ms） */
  stall: number;
  /** 稳态里没有新字的帧占比 */
  zeroFrames: number;
  /** 稳态里显示落后到达多久（秒） */
  lagSec: number;
}

const measure = (s: Sample[], from = 4000, to = 26_000): Metrics => {
  const v = speeds(s, from, to, 100, 10);
  const m = mean(v);
  const k = 5; // 50ms / step(10ms)
  const jerks: number[] = [];
  for (let i = k; i < v.length; i++) jerks.push(Math.abs(v[i]! - v[i - k]!) / m);
  let lag = 0;
  let n = 0;
  let stall = 0;
  let longest = 0;
  let zero = 0;
  let frames = 0;
  let prev = posAt(s, from);
  for (const x of s) {
    if (x.t < from || x.t > to) continue;
    lag += x.arrived - x.pos;
    n += 1;
    const d = Math.floor(x.pos);
    frames += 1;
    if (d === prev) {
      zero += 1;
      stall += FRAME;
      longest = Math.max(longest, stall);
    } else {
      stall = 0;
    }
    prev = d;
  }
  return {
    cv: cvOf(v),
    spread: quantile(v, 0.95) / Math.max(quantile(v, 0.05), 1),
    jerk: quantile(jerks, 0.95),
    ripple4: toneAmp(v, 10, 4),
    stall: longest,
    zeroFrames: zero / frames,
    lagSec: lag / n / m,
  };
};

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** 多个种子取平均：单个种子的泊松到达有运气成分 */
const evaluate = (
  make: () => (target: number, now: number) => number,
  opts: { cps: number; modulate?: number },
): Metrics => {
  const all = SEEDS.map((seed) =>
    measure(
      runFrontend(genArrivals({ seed, cps: opts.cps, modulate: opts.modulate }), make(), {
        seed: seed + 100,
      }),
    ),
  );
  const out = {} as Metrics;
  for (const key of Object.keys(all[0]!) as Array<keyof Metrics>) {
    out[key] = mean(all.map((m) => m[key]));
  }
  return out;
};

describe("模拟：速度是否匀（对比冻结的旧算法）", () => {
  const base = evaluate(legacyAdvance, { cps: 120 });
  const now = evaluate(currentAdvance, { cps: 120 });

  it("对照组确实有问题（否则这组测试什么也没证明）：旧算法在 120 字/秒下速度峰谷 3 倍以上、4Hz 纹波 ±10% 以上", () => {
    expect(base.spread).toBeGreaterThan(2.8);
    expect(base.ripple4).toBeGreaterThan(0.1);
    expect(base.cv).toBeGreaterThan(0.3);
  });

  it("速度的变异系数（100ms 窗口）：比旧算法小一半左右，绝对值 < 0.25", () => {
    expect(now.cv).toBeLessThan(0.25);
    expect(now.cv).toBeLessThan(base.cv * 0.65);
  });

  it("峰谷比（p95 / p5）：旧算法 3 倍以上，现在 < 2.3、且不到旧算法的 75%", () => {
    expect(now.spread).toBeLessThan(2.3);
    expect(now.spread).toBeLessThan(base.spread * 0.75);
  });

  it("急加速 / 急刹车幅度（相邻 50ms 窗口速度变化的 p95）：不到旧算法的 60%", () => {
    expect(now.jerk).toBeLessThan(base.jerk * 0.6);
    expect(now.jerk).toBeLessThan(0.3);
  });

  it("批节奏（4Hz）的纹波：旧算法的锯齿就在这里——现在 < 8%、不到旧算法的一半", () => {
    expect(now.ripple4).toBeLessThan(0.08);
    expect(now.ripple4).toBeLessThan(base.ripple4 * 0.5);
  });

  it("没有「吐完就停」：最长停顿不超过 3 帧（50ms），几乎每一帧都有新字", () => {
    expect(now.stall).toBeLessThanOrEqual(3 * FRAME + 1);
    expect(now.zeroFrames).toBeLessThan(0.05);
  });

  it("代价有界：显示落后到达约 0.65s（目标缓冲），不超过 0.9s——用户看不到「到达」，只看得到匀不匀", () => {
    expect(now.lagSec).toBeGreaterThan(0.4);
    expect(now.lagSec).toBeLessThan(0.9);
  });

  it("模型自己速度在起伏（±50%、5s 周期）：不匀的部分由输入决定，但不会被放大——变异系数仍明显低于旧算法、也没有停顿", () => {
    const b = evaluate(legacyAdvance, { cps: 120, modulate: 0.5 });
    const n = evaluate(currentAdvance, { cps: 120, modulate: 0.5 });
    expect(n.cv).toBeLessThan(b.cv * 0.75);
    expect(n.stall).toBeLessThanOrEqual(4 * FRAME + 1);
  });

  it.each([160, 300])("%i 字/秒（快的思考）：同样匀、同样没有停顿", (cps) => {
    const m = evaluate(currentAdvance, { cps });
    const b = evaluate(legacyAdvance, { cps });
    expect(m.cv).toBeLessThan(0.25);
    expect(m.cv).toBeLessThan(b.cv * 0.7);
    expect(m.stall).toBeLessThanOrEqual(2 * FRAME + 1);
    expect(m.zeroFrames).toBeLessThan(0.05);
  });

  it.each([20, 40])(
    "%i 字/秒（很慢的思考）：字本身稀疏，停顿由整数取整决定——仍不超过 6 帧（100ms），不比旧算法差",
    (cps) => {
      const m = evaluate(currentAdvance, { cps });
      const b = evaluate(legacyAdvance, { cps });
      expect(m.stall).toBeLessThanOrEqual(6 * FRAME + 1);
      expect(m.stall).toBeLessThanOrEqual(b.stall + FRAME);
    },
  );
});

describe("模拟：非稳态场景", () => {
  const speedsAround = (
    make: () => (target: number, now: number) => number,
    seed: number,
    opts: Parameters<typeof genArrivals>[0],
    from: number,
    to: number,
  ) => speeds(runFrontend(genArrivals(opts), make(), { seed: seed + 100 }), from, to, 200, 25);

  it("冷启动：前 1.5s 速度单调爬升（先慢后快的「起步」），不出现「加速 → 刹车 → 加速」", () => {
    // 多个种子取平均：单个种子的前几批是随机的
    const avg: number[] = [];
    for (const seed of SEEDS) {
      const v = speedsAround(currentAdvance, seed, { seed, cps: 120, seconds: 6 }, 0, 1700);
      v.forEach((x, i) => (avg[i] = (avg[i] ?? 0) + x / SEEDS.length));
    }
    // 每 250ms 取一个窗口（25ms 步长，隔 10 个取一个）
    const picks = [0, 10, 20, 30, 40, 50].map((i) => avg[i]!);
    for (let i = 1; i < picks.length; i++) expect(picks[i]!).toBeGreaterThanOrEqual(picks[i - 1]! * 0.95);
    expect(picks[0]!).toBeLessThan(picks[5]! * 0.5); // 起步确实是慢的
  });

  it("模型停顿 2s 后恢复：重启后的速度峰值不超过稳态的 1.5 倍（旧算法 ≈ 1.7 倍，是又一次「猛加速」）", () => {
    const peakRatio = (make: () => (target: number, now: number) => number) =>
      mean(
        SEEDS.map((seed) => {
          const s = runFrontend(
            genArrivals({ seed, cps: 120, stalls: [{ at: 12_000, len: 2000 }] }),
            make(),
            { seed: seed + 100 },
          );
          const steady = mean(speeds(s, 6000, 11_500, 200, 25));
          const after = speeds(s, 14_000, 17_500, 200, 25);
          return Math.max(...after) / steady;
        }),
      );
    const now = peakRatio(currentAdvance);
    const base = peakRatio(legacyAdvance);
    expect(base).toBeGreaterThan(1.5); // 对照组确实有尖峰
    expect(now).toBeLessThan(1.5);
    expect(now).toBeLessThan(base);
  });

  it("思考结束前的收尾（模型在 15s 停止产出）：最后一批到达后 1.5s 内放完，期间速度只降不升（没有「又猛追一下」）", () => {
    for (const seed of SEEDS) {
      const arrivals = genArrivals({ seed, cps: 120, endAt: 15_000 });
      const last = arrivals[arrivals.length - 1]!;
      const s = runFrontend(arrivals, currentAdvance(), { seed: seed + 100 });
      const done = s.find((x) => x.t >= last.t && last.total - x.pos < 2);
      expect(done, `seed=${seed}`).toBeDefined();
      expect(done!.t - last.t, `seed=${seed}`).toBeLessThan(1500);
      // 收尾曲线：相邻 250ms 窗口的速度（容许 20% + 5 字/秒的取整波动）不回升
      const from = Math.ceil(last.t / 250) * 250;
      const tail = speeds(s, from, from + 1500, 250, 250);
      for (let i = 1; i < tail.length; i++) {
        expect(tail[i]!, `seed=${seed} 窗口 ${i}：${tail.map(Math.round).join(" ")}`).toBeLessThanOrEqual(
          tail[i - 1]! * 1.2 + 5,
        );
      }
    }
  });

  it("大积压（t=10s 一次涌入 3000 字，如标签页后台回来）：0.5s 内追完一半、3s 内只剩个位数，且不污染之后的速率", () => {
    for (const seed of SEEDS) {
      const arrivals = genArrivals({ seed, cps: 120, seconds: 12 });
      const last = arrivals[arrivals.length - 1]!.total;
      const goal = last + 3000;
      const s = runFrontend(
        arrivals.filter((a) => a.t < 10_000),
        currentAdvance(),
        { seed: seed + 100, extra: [{ t: 10_000, total: goal }] },
      );
      const half = s.find((x) => x.t > 10_000 && goal - x.pos < 1500);
      const done = s.find((x) => x.t > 10_000 && goal - x.pos < 10);
      expect(half, `seed=${seed}`).toBeDefined();
      expect(done, `seed=${seed}`).toBeDefined();
      expect(half!.t - 10_000, `seed=${seed}`).toBeLessThan(500);
      expect(done!.t - 10_000, `seed=${seed}`).toBeLessThan(3000);
    }
  });
});
