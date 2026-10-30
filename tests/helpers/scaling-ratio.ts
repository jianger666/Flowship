/**
 * 「n 与 2n 的耗时比」——判断一个纯函数是线性还是二次型，不依赖机器快慢的绝对阈值。
 *
 * 为什么不用绝对耗时：CI / 高负载机器上同一个线性实现的耗时能差一个数量级，绝对阈值要么误报要么
 * 放过「慢但没到阈值」的二次型。输入翻倍后的耗时比不受机器速度影响：线性 ≈ 2，二次型 ≈ 4，
 * 阈值取中间（默认 3）并用「多次取最小值」压住 GC / 调度抖动。
 *
 * 线性实现在几万字符上只要零点几毫秒，直接计时会被计时器分辨率淹没——所以单次太快就重复若干次
 * 取平均（总耗时累积到 `minMs` 为止）；二次型一次就几十毫秒，不会触发重复，所以红灯时也不会很慢。
 *
 * **计时源是 CPU 时间，不是墙钟**（R14 P1-6 / Q18-01）：墙钟里混着「被别的进程抢占」的时间。
 * 本机 8 核跑 16 个空转进程抢核时，同一个线性函数单轮比值最高量到 6.31（100 次里 10 次 > 3），取 3 轮最小后仍有 1 次 3.05；
 * 真二次型反过来被压到 2.21（30 次里 10 次 ≤ 3，被放过去）——墙钟既会误报线性、也会漏判二次型。
 * CPU 时间只数「这个线程自己真在跑」的时间，抢占不计入：同口径下线性 200 次最大 2.15、真二次型 30 次落在 3.94–3.98。
 * 默认优先 `process.threadCpuUsage()`（Node ≥ 22.19，只算当前线程，不含 V8 并发 GC / JIT / libuv 线程池的 CPU，
 * 将来 vitest 改 threads 池也不会混进别的 worker）；没有就退回 `process.cpuUsage()`（整进程；默认 forks 池一个文件一个子进程，够用）。
 * 边界：CPU 时间消除不了虚拟化的 steal 和同核超线程的争用；被计时的函数必须是同步、纯 CPU 型
 * （睡眠 / 等 IO 的时间不计）；上面的数字只在 macOS 本机量过，Linux CI 上没验证过。
 */

/** 单调不减的计时源，单位毫秒。helper 里所有「现在几点」都从它读（含 budget），自测传虚拟时钟就完全确定、不碰真实时间 */
export type Clock = () => number;

/** 墙钟。只给自测 / 对照用——helper 默认不用它（见文件头） */
export const wallClock: Clock = () => performance.now();

type CpuUsageLike = { user: number; system: number };
/** `process` 里用得到的那两个方法（拆成类型，自测可以传假的 proc 来覆盖「有 / 没有 threadCpuUsage」两条分支） */
type CpuSource = {
  cpuUsage: () => CpuUsageLike;
  threadCpuUsage?: () => CpuUsageLike;
};

/** CPU 时间 = 用户态 + 内核态；Node 给的是微秒，换成毫秒 */
const cpuMsOf = (u: CpuUsageLike): number => (u.user + u.system) / 1000;

/** 从 proc 里挑 CPU 时钟：有线程级的（Node ≥ 22.19）就用线程级，否则退回进程级 */
export const pickCpuClock = (proc: CpuSource): Clock => {
  const threadCpuUsage = proc.threadCpuUsage;
  if (typeof threadCpuUsage === "function") {
    return () => cpuMsOf(threadCpuUsage.call(proc));
  }
  return () => cpuMsOf(proc.cpuUsage());
};

/** 默认计时源：当前线程的 CPU 时间（毫秒） */
export const cpuClock: Clock = pickCpuClock(process);

/** 每次调用的平均耗时（ms）：单次不足 minMs 就把调用次数乘 4 重来，直到总耗时 ≥ minMs（或到上限） */
export const perCallMs = (
  fn: () => unknown,
  minMs = 10,
  maxReps = 4096,
  clock: Clock = cpuClock,
): number => {
  let reps = 1;
  for (;;) {
    const t0 = clock();
    for (let i = 0; i < reps; i++) fn();
    const dt = clock() - t0;
    if (dt >= minMs || reps >= maxReps) return dt / reps;
    reps *= 4;
  }
};

/** 多轮取最小值；累计耗时超过 budgetMs 就提前停（二次型实现一轮就很慢，不陪它跑满轮数） */
export const minPerCallMs = (
  fn: () => unknown,
  trials = 5,
  budgetMs = 400,
  clock: Clock = cpuClock,
): number => {
  let best = Number.POSITIVE_INFINITY;
  const t0 = clock();
  for (let i = 0; i < trials; i++) {
    best = Math.min(best, perCallMs(fn, undefined, undefined, clock));
    if (clock() - t0 > budgetMs) break;
  }
  return best;
};

/** 单次耗时是否可用：有限的正数（0 / 负数 / NaN / Infinity 都不行） */
const isUsableMs = (ms: number): boolean => Number.isFinite(ms) && ms > 0;

/** 两个规模的单次耗时有一个不可用就抛错，说明里带规模和实测值，并指出多半是被计时的函数太快 */
const assertUsableTimings = (n: number, small: number, big: number): void => {
  if (isUsableMs(small) && isUsableMs(big)) return;
  throw new Error(
    `doublingRatio：计时结果不可用——规模 ${n} 的单次耗时 ${small}ms、规模 ${2 * n} 的 ${big}ms，` +
      "都必须是有限的正数。多半是被计时的函数太快、低于计时源的分辨率：调大 n，或让 make(n) 返回的函数多做一点事。",
  );
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
 *
 * `opts.clock`：计时源，默认 CPU 时间（见文件头）；自测传虚拟时钟让比值只取决于规模。
 *
 * 两个规模的单次耗时必须都是有限的正数，否则直接抛带说明的错（见 {@link assertUsableTimings}）：
 * 被计时的函数快到低于计时源分辨率时 small = 0，比值会变成 NaN / Infinity，悄悄掉进 `toBeLessThan` 变成一条看不懂的红；
 * big = 0 则比值是 0，是一条假绿。
 */
export const doublingRatio = (
  make: (n: number) => () => unknown,
  n: number,
  opts: {
    trials?: number;
    rounds?: number;
    threshold?: number;
    clock?: Clock;
  } = {},
): number => {
  const rounds = Math.max(1, opts.rounds ?? DOUBLING_ROUNDS);
  const threshold = opts.threshold ?? LINEAR_RATIO_MAX;
  const clock = opts.clock ?? cpuClock;
  make(Math.max(1, Math.floor(n / 8)))();
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < rounds; r++) {
    const small = minPerCallMs(make(n), opts.trials, undefined, clock);
    const big = minPerCallMs(make(2 * n), opts.trials, undefined, clock);
    assertUsableTimings(n, small, big);
    best = Math.min(best, big / small);
    if (best <= threshold) break;
  }
  return best;
};

/** 线性 ≈ 2、二次型 ≈ 4：取 3 判线性（见文件头说明） */
export const LINEAR_RATIO_MAX = 3;

/** doublingRatio 默认最多测几轮（第十轮：3，独立重测取最小比值） */
export const DOUBLING_ROUNDS = 3;
