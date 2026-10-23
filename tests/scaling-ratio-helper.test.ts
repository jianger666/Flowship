/**
 * 第十轮：`tests/helpers/scaling-ratio.ts` 的 `doublingRatio` 多轮取最小比值——本身的行为测试。
 *
 * 背景：n → 2n 的耗时比用「小规模取最小 / 大规模取最小」两个独立的最小值，遇到持续一小段的负载抖动时，
 * 大规模那一侧整个窗口都被拉高，线性实现也能量出 3.16 之类冒过阈值 3 的比（第九轮全量跑里 `group-reply-protocol-r7` 红过一次）。
 * 改成：多轮（默认 3）、每轮重新 make 重新测、某轮 ≤ 阈值就提前停、跑满仍高才返回最小比。
 *
 * 这里钉三件事（都用「在 make 里按调用次序造出确定的抖动」，不靠真实负载碰运气）：
 *  ① 真线性 → 绿；
 *  ② **真二次型 → 仍然红**（取最小比值不能把二次型放过去——这是这个改动唯一的风险；用虚拟时钟，见该用例里的说明）；
 *  ③ 第一轮被抖动拉高、第二轮恢复 → 绿（修前的单轮行为在这里是红的：`rounds: 1` 对照）。
 */
import { describe, expect, it, vi } from "vitest";

import { doublingRatio, LINEAR_RATIO_MAX } from "./helpers/scaling-ratio";

/** 防止被 JIT 当成死代码消掉 */
let sink = 0;
const burn = (iters: number): void => {
  let s = 0;
  for (let i = 0; i < iters; i++) s = (s + i * 31) | 0;
  sink ^= s;
};

const N = 4000;
/** 线性：耗时 ∝ n */
const linear = (n: number) => () => burn(n * 120);

describe("doublingRatio（多轮取最小比值）", () => {
  it("① 真线性：比值 < 阈值", () => {
    expect(doublingRatio(linear, N)).toBeLessThan(LINEAR_RATIO_MAX);
  });

  it("② 真二次型：多轮取最小之后仍然 > 阈值（不会把二次型放过去）——虚拟时钟，比值只取决于规模、不受机器忙闲影响", () => {
    // 为什么不测真实计时：二次型期望比 4、阈值 3，余量只有 1.33 倍，而且「多轮取最小」对「期望比值偏高」的断言天然不利——
    // 任何一轮被调度抢占压到 3 以下，整条就红。实测同一份二次型实现：Linux CI（2 核）上量出过 2.83；
    // 本机 8 核被 8 个空转进程抢占时，十次里有五到八次 ≤ 3（换二次型的写法也一样，是噪声压过了形状）。
    // 红灯只取决于「当时机器忙不忙」，当不了门禁。
    // helper 的逻辑（取最小 / 提前停）与时钟从哪来无关：把时钟换成确定的——fn 每被调一次，时钟前进 cost(n) 毫秒，
    // 比值就精确等于 cost(2n) / cost(n)：二次型恰好 4、线性恰好 2。上面的「真线性」（期望 2、对阈值有 1.5 倍余量）仍用真实计时。
    let now = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const timed = (cost: (n: number) => number) => (n: number) => () => {
        now += cost(n);
      };
      const ratio = doublingRatio(
        timed((n) => (n * n) / 1e4),
        600,
      );
      expect(ratio).toBeCloseTo(4, 10);
      expect(ratio).toBeGreaterThan(LINEAR_RATIO_MAX);
      // 同一套虚拟时钟下线性恰好 2、被判为线性：证明上面的 4 来自「二次型」本身，不是时钟造出的假象
      expect(
        doublingRatio(
          timed((n) => n / 50),
          600,
        ),
      ).toBeCloseTo(2, 10);
    } finally {
      spy.mockRestore();
    }
    // 时钟已还原：不能把虚拟的 performance.now 漏给后面的用例
    expect(vi.isMockFunction(performance.now)).toBe(false);
  });

  /** 第 1 次造「2n 规模」函数时让它多干 8 倍活（模拟「大规模那一侧整个窗口都被抖动拉高」），之后恢复正常 */
  const spikeOnFirstBig = () => {
    let bigCalls = 0;
    const make = (n: number) => {
      if (n !== 2 * N) return linear(n); // 小规模与预热：正常
      bigCalls += 1;
      return bigCalls === 1 ? () => burn(n * 120 * 8) : linear(n);
    };
    return { make, bigCalls: () => bigCalls };
  };

  it("③ 第一轮被抖动拉高、第二轮恢复：多轮返回最小比 → 绿，且确实重测了（make 大规模至少 2 次）", () => {
    const s = spikeOnFirstBig();
    const ratio = doublingRatio(s.make, N);
    expect(s.bigCalls()).toBeGreaterThanOrEqual(2);
    expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
  });

  it("③ 对照：rounds: 1（修前的单轮行为）在同样的抖动下是红的 → 证明上一条测的是多轮、不是碰巧", () => {
    const s = spikeOnFirstBig();
    const ratio = doublingRatio(s.make, N, { rounds: 1 });
    expect(s.bigCalls()).toBe(1);
    expect(ratio).toBeGreaterThan(LINEAR_RATIO_MAX);
  });

  it("threshold 可调：某轮比值 ≤ threshold 就提前停（不多测）", () => {
    // 阈值给到很宽（100）：第一轮必然 ≤ 100，只会 make 大规模 1 次
    let bigCalls = 0;
    const make = (n: number) => {
      if (n === 2 * N) bigCalls += 1;
      return linear(n);
    };
    doublingRatio(make, N, { threshold: 100 });
    expect(bigCalls).toBe(1);
  });

  it("sink 被用到（防止 burn 被优化掉后整个文件测的是空转）", () => {
    burn(1000);
    expect(typeof sink).toBe("number");
  });
});
