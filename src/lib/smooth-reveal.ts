/**
 * 「匀速吐字」：把一批一批到达的文本，摊成逐帧均匀吐出的位置推进。纯逻辑、无 DOM、无 React。
 *
 * 为什么有（2026-10-12 用户反馈「正文吐字很丝滑，思考吐字很机械」）：
 * 正文的 SSE 帧很碎（SDK 原生约 30 条/秒），use-smooth-streaming 的「每帧追 12%」几乎是透明的；
 * 思考不一样——服务端为了少发帧，每 250ms 才合并推一批（一批几十字），前端又整批替换，
 * 视觉上就是「一顿一顿」：0.25s 一次整块跳变。
 *
 * 第二轮（同日，用户反馈「现在很丝滑，但速度时快时慢，像开车加速又刹车又加速」）：
 * 第一版用「指数追赶」——速度 = 积压 / τ（τ = 300ms）。它消掉了整块跳变，却把批次节奏换成了
 * 速度的锯齿：每来一批积压阶跃 +N，速度跟着阶跃 +N/τ，然后随吐字指数回落，直到下一批——
 * 速度每 250ms 一个「猛加速 → 慢慢减速」的循环（实测 100ms 窗口里速度 70–220 字/秒，峰谷 3 倍，
 * 4Hz 纹波 ±15%）。根因是**速度由积压决定，而积压本身是被批次打碎的**。
 *
 * 现在的算法（视频播放器 jitter buffer 的做法：速度跟「到达速率」走，积压只用来微调）：
 *   1. 估计到达速率 λ（字/秒）：每批到达时按「这批字数 / 距上一批多久」做时间加权的指数平均
 *      （τ = 3s，前几批按样本均值快速收敛）。批的大小与间隔都会抖，3s 的平均把抖动抹平；
 *   2. 以 λ 的速度放字——不随批次起伏；
 *   3. 积压偏离「目标缓冲」（λ × 650ms：比批间隔 250ms 大得多，批晚到也不会吐空）时，
 *      用很小的增益（τ = 1.8s）把速度往回拉；缓冲偏低（快吐空）时增益翻倍——偏低比偏高危险，会停。
 *      这一项是「缓慢的修正」，不是「对每批的反应」，所以不会再画出批次的锯齿。
 * 结果（模拟，120 字/秒、250ms 一批、批大小 ±40%、到达时刻有抖动）：100ms 窗口速度的变异系数
 * 0.35 → 0.18，加加速度（相邻窗口速度变化率）p95 0.43 → 0.18，4Hz 纹波 ±17% → ±4%；
 * 代价是显示落后到达约 0.65s（之前 0.3s）——用户看不到「到达」，只看得到匀不匀。
 *
 * 几个必须有的例外（都是「平时不起作用」的兜底）：
 *  - 追赶：积压 > 稳态缓冲的 3 倍（标签页后台回来 / 重连补发几千字）才启用，速度 = 积压 / τc，
 *    积压越大 τc 越小（600ms → 250ms）。稳态下一批最多让积压涨一两倍缓冲，碰不到这个阈值，
 *    所以不会把「大块一口气喷出来」又画回机械（这是第一轮试过的「积压越大放越快」的坑）；
 *  - 排空：超过 600ms 没有新批到达 = 后面暂时没数据了（思考中途停顿 / 段将结束），
 *    不再留缓冲，把剩下的尽快放完（至少 60 字/秒）；
 *  - 突发不计入速率：一批字数远超「按当前速率该有的量」（补发 / 后台积压），不代表模型变快，
 *    不进 λ 的估计；批间隔超过 1.2s（模型停顿）的样本同理；
 *  - 保底速度、dt 钳制（标签页被节流后一帧可能是几秒，不钳的话会一步跳到底）。
 *
 * 位置用浮点：低速时（比如 20 字/秒 ≈ 每帧 0.33 字）靠小数累积，每三帧左右出一个字，均匀；
 * 取整数的话要么每帧至少 1 字（吐完就停）、要么永远不动。显示长度 = floor(位置)。
 *
 * 不做的事：速度**不**随「模型写的内容」变化（标点处停顿之类）——那是另一种拟人化，会引入新的不均匀。
 */

/** 稳态目标缓冲（ms）：显示比到达晚这么久。须明显大于服务端的批间隔（250ms），批晚到也不吐空 */
export const REVEAL_BUFFER_MS = 650;
/** 到达速率估计的时间常数（ms）：越大越平稳，但对「模型真的变快 / 变慢」跟得越慢 */
export const REVEAL_RATE_TAU_MS = 3000;
/** 缓冲偏离目标时的修正时间常数（ms）：越大越柔和 */
const CORRECT_TAU_MS = 1800;
/** 缓冲偏低（快吐空）时修正增益的倍数：偏低会停、偏高只是慢一点，所以偏低修得更积极 */
const LOW_BUFFER_GAIN = 2;
/** 保底速度（字/秒）：保证最后几个字有限时间内放完；须低于任何真实到达率，否则把匀速又变回「吐完就停」 */
export const REVEAL_MIN_CPS = 10;
/** 冷启动的速率先验（字/秒）：第一批到达前对「这个模型多快」一无所知 */
export const REVEAL_PRIOR_CPS = 60;
/** 速率估计的上限（字/秒），只防脏输入 */
const MAX_RATE_CPS = 2000;

/** 积压超过「稳态缓冲」的几倍算异常大积压 → 启用追赶 */
const CATCH_FACTOR = 3;
/** 追赶阈值里稳态缓冲的下限（字）：慢速思考时缓冲只有几个字，别因为多了十几个字就算「大积压」 */
const CATCH_MIN_BUFFER = 20;
/** 追赶时间常数（ms）= 600 − 积压 × 0.1，夹在 [250, 600]：积压越大追得越快，几千字也在 ~2s 内追到只剩个位数 */
const CATCH_TAU_MAX_MS = 600;
const CATCH_TAU_MIN_MS = 250;
const CATCH_TAU_SLOPE = 0.1;

/** 超过这么久没有新批到达（ms）：认为后面暂时没数据了，进入排空 */
export const REVEAL_DRAIN_AFTER_MS = 600;
/** 排空时间常数（ms）与速度下限（字/秒） */
const DRAIN_TAU_MS = 400;
const DRAIN_MIN_CPS = 60;

/** 批间隔超过这个值（ms）的样本不进速率估计：那是模型停顿，不代表速率 */
const GAP_IGNORE_MS = 1200;
/** 一批字数超过「当前速率 × 间隔」的这个倍数（再加 SLACK）算突发，不进速率估计 */
const BURST_FACTOR = 4;
const BURST_SLACK = 60;
/** 首批没有「上一批」可比：当它是 250ms 的量（服务端的批间隔） */
const FIRST_BATCH_WINDOW_S = 0.25;

/** 单帧 dt 上限（ms） */
export const REVEAL_MAX_DT_MS = 100;
/** 首帧没有「上一帧」可比时按 60fps 一帧算 */
export const REVEAL_FIRST_FRAME_MS = 1000 / 60;

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(Math.max(x, lo), hi);

/** 推进器的全部状态（不可变：stepReveal 每帧返回新对象，测试可以直接比对） */
export interface RevealState {
  /** 当前位置（浮点，单位：字符数） */
  pos: number;
  /** 上一帧的时刻；null = 还没走过帧 */
  at: number | null;
  /** 到达速率估计（字/秒） */
  rate: number;
  /** 已纳入速率估计的批数（含先验算一批）：前期靠它做样本均值式的快速收敛 */
  samples: number;
  /** 已见到的目标（累计字符数）：用来认出「新到了一批」 */
  seen: number;
  /** 最近一批到达的时刻；null = 还没来过 */
  arrivedAt: number | null;
}

export const createRevealState = (): RevealState => ({
  pos: 0,
  at: null,
  rate: REVEAL_PRIOR_CPS,
  samples: 1,
  seen: 0,
  arrivedAt: null,
});

/**
 * 推进一帧（纯函数）。
 *
 * @param s 上一帧的状态
 * @param target 目标位置（已到达的累计字符数；新的一批到达 = 它变大了）
 * @param now 现在的时刻（ms，须单调；rAF 时间戳即可）
 * @returns 新状态。保证：pos 不超过 target；target 不变时 pos 单调不减；
 *   target 没到且 dt > 0 时 pos 严格前进（保底速度）；
 *   target 比 pos 还小（正常不会出现）直接回到 target——宁可回退也不越界；
 *   脏输入（NaN / Infinity）不扩散：目标非有限回到 0，位置非有限当作已追平，时刻非有限当作 dt = 0。
 */
export const stepReveal = (
  s: RevealState,
  target: number,
  now: number,
): RevealState => {
  if (!Number.isFinite(target)) {
    return { ...createRevealState(), at: Number.isFinite(now) ? now : null };
  }
  const t = Number.isFinite(now) ? now : (s.at ?? 0);
  const rawDt = s.at === null ? REVEAL_FIRST_FRAME_MS : t - s.at;
  const dt = Number.isFinite(rawDt) ? clamp(rawDt, 0, REVEAL_MAX_DT_MS) : 0;

  let { rate, samples, seen, arrivedAt } = s;
  if (!Number.isFinite(rate) || rate <= 0) rate = REVEAL_PRIOR_CPS;

  // 认出「新到了一批」并更新速率估计。到达时刻取「看到它的这一帧」，误差 ≤ 一帧
  if (target < seen) seen = target; // 累计坐标回落（正常不会）：对齐，免得之后把差值当成一批
  if (target > seen) {
    const n = target - seen;
    if (arrivedAt === null) {
      // 首批：没有间隔可算。很大的一批（重连补发的整段文本）不代表速率，保持先验
      if (n <= BURST_FACTOR * REVEAL_PRIOR_CPS * FIRST_BATCH_WINDOW_S + BURST_SLACK) {
        rate = (REVEAL_PRIOR_CPS + n / FIRST_BATCH_WINDOW_S) / 2;
        samples += 1;
      }
    } else {
      const gap = Math.max(t - arrivedAt, 1);
      const burst = n > BURST_FACTOR * rate * (gap / 1000) + BURST_SLACK;
      if (gap <= GAP_IGNORE_MS && !burst) {
        const a = Math.max(
          1 - Math.exp(-gap / REVEAL_RATE_TAU_MS),
          1 / (samples + 1),
        );
        rate += a * ((n / gap) * 1000 - rate);
        samples += 1;
      }
    }
    seen = target;
    arrivedAt = t;
  }
  rate = clamp(rate, 1, MAX_RATE_CPS);
  const next = { at: t, rate, samples, seen, arrivedAt };

  const pos = Number.isFinite(s.pos) ? s.pos : target;
  if (!(target > pos)) return { ...next, pos: target };

  const backlog = target - pos;
  const want = (rate * REVEAL_BUFFER_MS) / 1000;
  const dev = backlog - want;
  // 速度 = 到达速率 + 对缓冲偏差的缓慢修正（偏低时增益翻倍）
  let v = rate + (dev / (CORRECT_TAU_MS / 1000)) * (dev < 0 ? LOW_BUFFER_GAIN : 1);
  if (backlog > CATCH_FACTOR * Math.max(want, CATCH_MIN_BUFFER)) {
    const catchTau = clamp(
      CATCH_TAU_MAX_MS - backlog * CATCH_TAU_SLOPE,
      CATCH_TAU_MIN_MS,
      CATCH_TAU_MAX_MS,
    );
    v = Math.max(v, backlog / (catchTau / 1000));
  }
  const draining = arrivedAt !== null && t - arrivedAt > REVEAL_DRAIN_AFTER_MS;
  if (draining) v = Math.max(v, backlog / (DRAIN_TAU_MS / 1000), DRAIN_MIN_CPS);
  v = Math.max(v, draining ? DRAIN_MIN_CPS : REVEAL_MIN_CPS);
  return { ...next, pos: Math.min(target, pos + (v * dt) / 1000) };
};

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;

/**
 * 浮点位置 → 文本里实际显示的长度（整数）。
 * 切点不落在代理对（emoji 等）中间：落在中间就多带上低代理项；
 * 已经到末尾、末尾恰好是孤立的高代理项（chunk 把 emoji 切成两半、后半还没到）就先不显示它。
 * 否则会闪出一帧 �。
 */
export const revealLength = (pos: number, text: string): number => {
  let n = Math.max(0, Math.min(text.length, Math.floor(pos)));
  if (n > 0 && isHighSurrogate(text.charCodeAt(n - 1))) {
    n = n < text.length ? n + 1 : n - 1;
  }
  return n;
};

/**
 * 带状态的推进器：状态放在闭包里，调用方每帧只给「目标」和「现在」。
 * 抽成独立对象是为了不起 DOM 也能用模拟时钟测（见 tests/smooth-reveal.test.ts）；
 * hook 只是它外面一层 rAF + setState 的薄壳。
 */
export const createRevealer = () => {
  let state = createRevealState();
  return {
    /** 推进到 now 时刻，返回新的浮点位置 */
    advance(target: number, now: number): number {
      state = stepReveal(state, target, now);
      return state.pos;
    },
    /** 位置直接跳到 p（保留时间基准与速率估计）：前端保留窗口的起点前移到了位置前面时用 */
    seek(p: number): void {
      state = { ...state, pos: p };
    },
    /** 新的一段开始：位置、时间基准、速率估计都清零 */
    reset(): void {
      state = createRevealState();
    },
    /** 当前浮点位置 */
    get position(): number {
      return state.pos;
    },
    /** 完整状态（只读快照，状态对象不可变）：测试与调试用 */
    get state(): RevealState {
      return state;
    },
  };
};

export type Revealer = ReturnType<typeof createRevealer>;
