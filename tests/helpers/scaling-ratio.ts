/**
 * 「n 与 2n 的耗时比」——判断一个纯函数是线性还是二次型，不依赖机器快慢的绝对阈值。
 *
 * 为什么不用绝对耗时：CI / 高负载机器上同一个线性实现的耗时能差一个数量级，绝对阈值要么误报要么
 * 放过「慢但没到阈值」的二次型。输入翻倍后的耗时比不受机器速度影响：线性 ≈ 2，二次型 ≈ 4，
 * 阈值取中间（默认 3）并用「多次取最小值」压住 GC / 调度抖动。
 *
 * 线性实现在几万字符上只要零点几毫秒，直接计时会被计时器分辨率淹没——所以单次太快就重复若干次
 * 取平均（总耗时累积到 `minMs` 为止）；二次型一次就几十毫秒，不会触发重复，所以红灯时也不会很慢。
 */

/** 每次调用的平均耗时（ms）：单次不足 minMs 就把调用次数乘 4 重来，直到总耗时 ≥ minMs（或到上限） */
export const perCallMs = (
  fn: () => unknown,
  minMs = 10,
  maxReps = 4096,
): number => {
  let reps = 1;
  for (;;) {
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) fn();
    const dt = performance.now() - t0;
    if (dt >= minMs || reps >= maxReps) return dt / reps;
    reps *= 4;
  }
};

/** 多轮取最小值；累计耗时超过 budgetMs 就提前停（二次型实现一轮就很慢，不陪它跑满轮数） */
export const minPerCallMs = (
  fn: () => unknown,
  trials = 5,
  budgetMs = 400,
): number => {
  let best = Number.POSITIVE_INFINITY;
  const t0 = performance.now();
  for (let i = 0; i < trials; i++) {
    best = Math.min(best, perCallMs(fn));
    if (performance.now() - t0 > budgetMs) break;
  }
  return best;
};

/**
 * 输入规模从 n 翻到 2n 的耗时比。`make(n)` 返回「在规模 n 的输入上跑一遍」的函数
 * （输入在 make 里构造，不计入耗时）。先用 n/8 规模预热一次，免得首次 JIT 计入。
 *
 * **多轮、取最小比值**（第十轮复核：单轮「小规模取最小 / 大规模取最小」两个独立的最小值，遇到持续一小段的负载抖动时，
 * 大规模那一侧整个窗口都被拉高，线性实现也能量出 3.16 之类冒过阈值的比——实测同口径 12 次里 11 次在 1.9–2.6、1 次 4.83）：
 * 每一轮重新 make、重新测小 / 大两个规模，轮与轮之间互相独立；**某一轮的比已经 ≤ threshold 就提前停**（线性实现通常第一轮就停）；
 * 跑满 rounds 轮仍都高于 threshold 才返回最小的那个。
 * 真二次型每一轮都接近 4，取最小仍然 > 3、照样红；线性实现被噪声拉高一次，下一轮就回到 ≈ 2，不会误报。
 * 代价：只有「红灯路径」才会跑满 rounds 轮（二次型一轮本来就慢，所以红灯会慢几倍，绿灯不受影响）。
 */
export const doublingRatio = (
  make: (n: number) => () => unknown,
  n: number,
  opts: { trials?: number; rounds?: number; threshold?: number } = {},
): number => {
  const rounds = Math.max(1, opts.rounds ?? DOUBLING_ROUNDS);
  const threshold = opts.threshold ?? LINEAR_RATIO_MAX;
  make(Math.max(1, Math.floor(n / 8)))();
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < rounds; r++) {
    const small = minPerCallMs(make(n), opts.trials);
    const big = minPerCallMs(make(2 * n), opts.trials);
    best = Math.min(best, big / small);
    if (best <= threshold) break;
  }
  return best;
};

/** 线性 ≈ 2、二次型 ≈ 4：取 3 判线性（见文件头说明） */
export const LINEAR_RATIO_MAX = 3;

/** doublingRatio 默认最多测几轮（第十轮：3，独立重测取最小比值） */
export const DOUBLING_ROUNDS = 3;
