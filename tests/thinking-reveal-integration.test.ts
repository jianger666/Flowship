/**
 * 思考吐字平滑的「整体」行为：真实的累积 + 推进器 + 切片，用模拟时钟驱动（不含 React / rAF）。
 *
 * 各个纯函数都有自己的测试（smooth-reveal / thinking-live）；这里测它们**拼在一起**——
 * 也就是 chat-view 的累积（advanceLiveThinking）加 use-smooth-thinking 的 rAF 回调
 * （stepLiveReveal + revealLiveThinking）除 setState 之外的全部逻辑。
 * 最容易出 bug 的是接缝处：保留窗口（THINKING_TEXT_MAX）截尾后，累计坐标 / 偏移 / 位置跳转怎么联动。
 *
 * 坐标正确性的端到端判据：界面上显示出来的文本，必须恰好等于「全文里对应累计坐标的那一段」。
 */
import { describe, expect, it } from "vitest";

import { createRevealer } from "../src/lib/smooth-reveal";
import {
  advanceLiveThinking,
  liveThinkingOffset,
  liveThinkingTotal,
  revealLiveThinking,
  stepLiveReveal,
  THINKING_TEXT_MAX,
  type LiveThinking,
} from "../src/lib/thinking-live";

const FRAME_MS = 1000 / 60;
const BATCH_MS = 250;

interface Frame {
  /** 这一帧界面上显示的实时思考 */
  shown: LiveThinking;
  /** 这一帧已经到达的实时思考 */
  live: LiveThinking;
  /** stepLiveReveal 给出的累计坐标位置 */
  len: number;
  done: boolean;
}

/** 一个模拟的「界面」：一批批到达、一帧帧推进 */
const makeSim = () => {
  const revealer = createRevealer();
  let live: LiveThinking | null = null;
  let now = 0;
  const frames: Frame[] = [];

  const frame = (): Frame => {
    now += FRAME_MS;
    if (!live) throw new Error("还没有任何一批到达");
    const { len, done } = stepLiveReveal(revealer, live, now);
    const shown = revealLiveThinking(live, len);
    const f: Frame = { shown, live, len, done };
    frames.push(f);
    return f;
  };

  return {
    arrive: (chunk: string, id = "e1") => {
      live = advanceLiveThinking(live, id, chunk, now);
    },
    frame,
    run: (ms: number) => {
      const n = Math.round(ms / FRAME_MS);
      for (let i = 0; i < n; i++) frame();
    },
    /** 标签页在后台：时间在走，但没有帧 */
    skip: (ms: number) => {
      now += ms;
    },
    frames,
    get live(): LiveThinking {
      return live!;
    },
  };
};

/** 一帧里界面上显示到的累计坐标（= 偏移 + 已显示长度） */
const cum = (f: Frame): number => liveThinkingOffset(f.shown) + f.shown.text.length;

/** 可识别的批：第 b 批 = 5 位编号 + 点补足到 40 字，全文里每个位置都能对上号 */
const batch = (b: number): string => String(b).padStart(5, "0").padEnd(40, ".");

describe("一批到达之后", () => {
  it("第一帧就有字（不是空等到下一帧），之后逐帧推进到追平", () => {
    const sim = makeSim();
    sim.arrive("0123456789".repeat(8));
    const first = sim.frame();
    expect(first.shown.text.length).toBeGreaterThan(0);
    expect(first.done).toBe(false);

    let guard = 0;
    while (!sim.frames.at(-1)!.done && guard++ < 600) sim.frame();
    expect(sim.frames.at(-1)!.done).toBe(true);
  });

  it("显示始终是已到达文本的前缀、位置单调不减；追平时给回原对象（引用稳定）", () => {
    const sim = makeSim();
    sim.arrive("0123456789".repeat(8));
    let prev = 0;
    for (let i = 0; i < 600; i++) {
      const f = sim.frame();
      expect(sim.live.text.startsWith(f.shown.text)).toBe(true);
      // 显示到的累计坐标恰好等于推进器给出的位置（光有「是前缀」抓不住显示超前 / 落后几个字）
      expect(cum(f)).toBe(f.len);
      expect(cum(f)).toBeGreaterThanOrEqual(prev);
      prev = cum(f);
      if (f.done) break;
    }
    const last = sim.frames.at(-1)!;
    expect(last.done).toBe(true);
    expect(last.shown).toBe(sim.live);
  });

  it("追平后再来一批：继续推进，没有被前一次的「已追平」卡住", () => {
    const sim = makeSim();
    sim.arrive(batch(0));
    sim.run(2000);
    expect(sim.frames.at(-1)!.done).toBe(true);
    const before = cum(sim.frames.at(-1)!);

    sim.arrive(batch(1));
    const f = sim.frame();
    expect(f.done).toBe(false);
    expect(cum(f)).toBeGreaterThan(before);
    sim.run(2000);
    expect(sim.frames.at(-1)!.shown).toBe(sim.live);
  });
});

describe("持续到达（160 字/秒：每 250ms 一批 40 字）", () => {
  it("稳态下显示落后到达约 0.65 秒的量（目标缓冲）、峰值不超过 0.9 秒；每一帧吐的字数几乎一样多——没有「一顿一顿」，也没有「忽快忽慢」", () => {
    const sim = makeSim();
    const cps = 160;
    for (let b = 0; b < 120; b++) {
      sim.arrive(batch(b)); // 30 秒、4800 字，没到保留上限
      sim.run(BATCH_MS);
    }
    // 排除起步的前 2 秒
    const steady = sim.frames.slice(Math.round(2000 / FRAME_MS));
    const lags = steady.map((f) => liveThinkingTotal(f.live) - cum(f));
    const peak = Math.max(...lags);
    const mean = lags.reduce((a, c) => a + c, 0) / lags.length;
    // 有意用延迟换匀速：缓冲得比批间隔（250ms）大得多，批晚到也不会吐空
    expect(peak).toBeLessThan(0.9 * cps);
    expect(mean).toBeGreaterThan(0.45 * cps);
    expect(mean).toBeLessThan(0.85 * cps);
    expect(Math.min(...lags)).toBeGreaterThanOrEqual(0);

    // 逐帧新增字数：160 字/秒 = 每帧 2.67 字，所以每帧是 2 或 3 个字。
    // 旧的指数追赶是「批刚到时一帧吐 5–6 字、批快吃完时一帧吐 0–1 字」，这个极差就是「加速又刹车」
    const deltas: number[] = [];
    for (let i = 1; i < steady.length; i++) {
      deltas.push(cum(steady[i]!) - cum(steady[i - 1]!));
    }
    expect(Math.min(...deltas)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...deltas)).toBeLessThanOrEqual(4);
    expect(Math.max(...deltas) - Math.min(...deltas)).toBeLessThanOrEqual(2);
  });
});

describe("长思考越过前端保留上限（截尾）", () => {
  it("显示的永远是「全文里对应坐标的那一段」；位置不倒退、不出现 NaN；最终追平", () => {
    const sim = makeSim();
    let full = "";
    let prev = 0;
    for (let b = 0; b < 700; b++) {
      // 700 批 × 40 = 28000 字 > THINKING_TEXT_MAX
      const chunk = batch(b);
      full += chunk;
      sim.arrive(chunk);
      for (let i = 0; i < Math.round(BATCH_MS / FRAME_MS); i++) {
        const f = sim.frame();
        const offset = liveThinkingOffset(f.shown);
        expect(Number.isFinite(f.len)).toBe(true);
        expect(f.shown.text).toBe(full.slice(offset, offset + f.shown.text.length));
        // 显示到的累计坐标恰好等于推进器给出的位置：「是全文对应段的前缀」抓不住显示超前几十字
        expect(cum(f)).toBe(f.len);
        expect(cum(f)).toBeGreaterThanOrEqual(prev);
        prev = cum(f);
      }
    }
    // 确实发生过截尾，否则这条测试什么也没证明
    expect(full.length).toBeGreaterThan(THINKING_TEXT_MAX);
    expect(liveThinkingOffset(sim.live)).toBeGreaterThan(0);
    expect(sim.live.text.length).toBeLessThanOrEqual(THINKING_TEXT_MAX);

    sim.run(5000);
    const last = sim.frames.at(-1)!;
    expect(last.done).toBe(true);
    expect(last.shown).toBe(sim.live);
    // 追平后界面上看到的就是保留窗口里的全部内容，且恰好是全文的尾部
    expect(last.shown.text).toBe(full.slice(liveThinkingOffset(sim.live)));
  });

  it("标签页在后台时一口气来了很多字、把还没显示到的头部截掉了：回来后位置直接落到窗口里，不倒退、不去「吐」不存在的字", () => {
    const sim = makeSim();
    sim.arrive(batch(0));
    sim.run(500); // 位置在 40 字附近

    // 积压要大到「追赶一帧也跨不过窗口起点」才能体现这步保护的必要性：一帧约追 28%，
    // 积压 > ~28000 字才行。后台标签页里 SSE 照常在到，几分钟的思考轻松超过（每秒 160 字）
    const big = "y".repeat(THINKING_TEXT_MAX + 30000);
    const full = batch(0) + big;
    sim.arrive(big); // 窗口截尾：偏移 ≈ 30040，远在当前位置前面
    sim.skip(8000); // 后台 8 秒，没有帧

    const offset = liveThinkingOffset(sim.live);
    expect(offset).toBeGreaterThan(30000);

    const f = sim.frame();
    expect(f.len).toBeGreaterThanOrEqual(offset);
    expect(f.len).toBeLessThanOrEqual(liveThinkingTotal(sim.live));
    expect(cum(f)).toBe(f.len);
    expect(f.shown.text.length).toBeGreaterThan(0);
    expect(f.shown.text).toBe(full.slice(offset, offset + f.shown.text.length));

    sim.run(8000);
    expect(sim.frames.at(-1)!.shown).toBe(sim.live);
  });

  it("没有「位置跳到起点」这一步会怎样（证明这条保护是必要的）：窗口起点在位置前面时，显示会是空的", () => {
    // 手搓同样的场景但绕过 stepLiveReveal：直接拿旧位置去切
    const revealer = createRevealer();
    let live = advanceLiveThinking(null, "e1", batch(0), 0);
    revealer.advance(liveThinkingTotal(live), 16);
    live = advanceLiveThinking(live, "e1", "y".repeat(THINKING_TEXT_MAX + 5000), 1);
    const naive = revealLiveThinking(live, Math.floor(revealer.position));
    expect(naive.text).toBe(""); // 位置还停在窗口起点前面：界面上一个字也没有
    const guarded = revealLiveThinking(live, stepLiveReveal(revealer, live, 32).len);
    expect(guarded.text.length).toBeGreaterThan(0);
  });
});

describe("stepLiveReveal 的边界", () => {
  it("目标是累计总数、不是 text.length：截尾后 text.length 回落，位置不能跟着倒退", () => {
    const revealer = createRevealer();
    const full = "x".repeat(THINKING_TEXT_MAX + 3000);
    const live = advanceLiveThinking(null, "e1", full, 0);
    expect(live.text.length).toBeLessThan(liveThinkingTotal(live));
    // 一直推到追平
    let r = stepLiveReveal(revealer, live, 0);
    for (let i = 1; i < 2000 && !r.done; i++) r = stepLiveReveal(revealer, live, i * FRAME_MS);
    expect(r.done).toBe(true);
    expect(r.len).toBe(liveThinkingTotal(live));
  });

  it("脏位置（NaN）：被推进器规范化到目标、视为追平，循环停下不空转", () => {
    const revealer = createRevealer();
    revealer.seek(Number.NaN);
    const live = advanceLiveThinking(null, "e1", "abc", 0);
    const r = stepLiveReveal(revealer, live, 16);
    expect(r.done).toBe(true);
  });
});
