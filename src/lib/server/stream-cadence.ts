/**
 * 流式吐字节奏：同一个 run 内「相邻两条同类 delta（text / thinking）」的到达间隔分布。纯逻辑、无 IO。
 *
 * 为什么要有（2026-10-10）：「吐字不流畅」之前没有任何度量，排查全靠猜。后来才查明 SDK 的 run_events
 * 落盘实现每条事件要把整个文件读写一遍（18.5MB 时每条约 250ms），文字被钉在 ~5 条/秒——
 * 而这个节奏恰好能在 run-perf tracker 已有的 onDelta 回调里直接量到：运行时是等事件落盘后才发下一条，
 * 实测 onDelta 间隔与 run.stream() 间隔逐分位一致（p50 都是 197ms）。所以不动三处流循环，只在 tracker 里记。
 *
 * 判读（单个 run 的 text）：
 * - p50 ≈ 30–50ms、over100 / n < 5%：流畅（SDK 原生节奏约 30 条/秒）
 * - p50 ≥ 150ms、over100 / n 接近 100%：整段被钉住了（存储 / 事件循环）——看同条记录的
 *   store.runEvents / evMB / proc.eluAvg
 * - 只有 max / over250 偏大、p50 正常：偶发停顿（GC / 同步重活 / 网络）——对照 proc.eldMax 与 loop-lag.jsonl
 *
 * 口径：
 * - 间隔只在「同类 delta 连续出现」时记。中间夹了工具调用 / 步骤 / 思考与正文切换等其它事件就断开：
 *   那段空窗是模型或工具在忙，不是「吐字不顺」
 * - 分位数取所在桶的上界（保守估计），且不超过实测 max
 * - 热路径不分配对象 / 数组 / 字符串：固定长度 Uint32Array + 若干数字字段；snapshot 只在 run 结束时调一次
 */

/**
 * 间隔直方图的桶上界（ms，含）。20–250ms 内较密——那是「吐字顺不顺」体感最敏感的区间；
 * 末位上界之后还有一个溢出桶（分位落进去时取实测 max）。
 */
const BOUNDS_MS = [
  5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 75, 90, 100, 125, 150, 200, 250, 300,
  400, 500, 750, 1000, 2000, 5000,
] as const;

/** 慢间隔：> 100ms（连续吐字的体感已经是「一顿一顿」） */
const SLOW_GAP_MS = 100;
/** 停顿：> 250ms（明显的卡一下） */
const STALL_GAP_MS = 250;

export interface GapStats {
  /** 记录到的间隔条数（= 该类 delta 条数 − 连续段数） */
  n: number;
  p50: number;
  p95: number;
  max: number;
  /** 间隔 > 100ms 的条数 */
  over100: number;
  /** 间隔 > 250ms 的条数 */
  over250: number;
}

export interface CadenceSnapshot {
  text?: GapStats;
  thinking?: GapStats;
}

class GapHistogram {
  private readonly counts = new Uint32Array(BOUNDS_MS.length + 1);
  private n = 0;
  private max = 0;
  private over100 = 0;
  private over250 = 0;

  add(gapMs: number): void {
    // 时钟回拨 / NaN：丢弃，不污染分布（Date.now 不保证单调）
    if (!(gapMs >= 0)) return;
    let i = 0;
    while (i < BOUNDS_MS.length && gapMs > BOUNDS_MS[i]) i += 1;
    this.counts[i] += 1;
    this.n += 1;
    if (gapMs > this.max) this.max = gapMs;
    if (gapMs > SLOW_GAP_MS) this.over100 += 1;
    if (gapMs > STALL_GAP_MS) this.over250 += 1;
  }

  /** p ∈ (0,1]：第 ceil(n·p) 个样本所在桶的上界；溢出桶取实测 max；不超过 max */
  private quantile(p: number): number {
    const target = Math.ceil(this.n * p);
    let seen = 0;
    for (let i = 0; i < this.counts.length; i += 1) {
      seen += this.counts[i];
      if (seen >= target) {
        const upper = i < BOUNDS_MS.length ? BOUNDS_MS[i] : this.max;
        return Math.min(upper, this.max);
      }
    }
    return this.max;
  }

  stats(): GapStats | undefined {
    if (this.n === 0) return undefined;
    return {
      n: this.n,
      p50: Math.round(this.quantile(0.5)),
      p95: Math.round(this.quantile(0.95)),
      max: Math.round(this.max),
      over100: this.over100,
      over250: this.over250,
    };
  }
}

/** 上一条 delta 的类型：0 = 没有（刚开头 / 被其它事件断开） */
const NONE = 0;
const TEXT = 1;
const THINKING = 2;

export const createStreamCadence = () => {
  const text = new GapHistogram();
  const thinking = new GapHistogram();
  let lastKind: typeof NONE | typeof TEXT | typeof THINKING = NONE;
  let lastAt = 0;

  return {
    /** 一条 text-delta 到达（at = Date.now()）。热路径：只做数值运算 */
    text(at: number): void {
      if (lastKind === TEXT) text.add(at - lastAt);
      lastKind = TEXT;
      lastAt = at;
    },
    /** 一条 thinking-delta 到达。热路径：只做数值运算 */
    thinking(at: number): void {
      if (lastKind === THINKING) thinking.add(at - lastAt);
      lastKind = THINKING;
      lastAt = at;
    },
    /** 其它事件（工具调用 / 步骤 / 轮次…）：断开连续段，之后第一条 delta 不记间隔 */
    breakSegment(): void {
      lastKind = NONE;
    },
    /** run 结束时取一次；一条 delta 都没有（或每段只有一条）时返回 undefined */
    snapshot(): CadenceSnapshot | undefined {
      const t = text.stats();
      const k = thinking.stats();
      if (!t && !k) return undefined;
      return { ...(t ? { text: t } : {}), ...(k ? { thinking: k } : {}) };
    },
  };
};

export type StreamCadence = ReturnType<typeof createStreamCadence>;
