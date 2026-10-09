/**
 * 前端流畅度采集器（纯逻辑：无 DOM、无 IO，便于单测；浏览器 API 的接线在 hooks/use-ui-perf-reporter.ts）。
 *
 * 为什么要有：服务端已有每个 run 的耗时分解，但「流式渲染卡不卡」只能在渲染进程里量——
 * 长任务（主线程被占 ≥50ms）、慢交互（敲字 / 点击到下一次绘制 ≥200ms）、
 * 从后台回前台时的追赶（后台积压的事件一口气渲染）。这里把一个窗口（默认 30s）的这些信号
 * 压成一条样本，由 /api/perf/ui 落到 ui-perf.jsonl，scripts/perf-report.mjs 读。
 *
 * 上报策略（观测不能成为负担）：
 * - 只在「有信号」时上报：单个长任务 ≥150ms、或有 ≥250ms 的、或有 ≥200ms 的慢交互、
 *   或回前台 3s 内长任务累计 ≥300ms
 * - 没信号时每 N 个（默认 10 个 = 5 分钟）可见窗口抽一条「健康心跳」——「没卡」本身也是数据
 * - 页面全程不可见的窗口不上报、也不推进心跳
 * - 页面规模探针（JS 堆 / DOM 节点数）只在决定上报时才调：全量数 DOM 节点不便宜
 *
 * 时钟：所有时间戳统一用 performance.now() 同一时钟（longtask 的 startTime 也是它）。
 */

export type UiPerfReason = "interval" | "hidden" | "pagehide" | "switch";

/**
 * 流式代码块「限频高亮」的统计（自上次上报以来；见 lib/throttled-code-plugin）。
 * 不是触发上报的信号——高亮占满主线程一定会表现为长任务、已被上面的信号覆盖；
 * 它只在上报时顺带带上，用来回答「摊薄了多少次高亮 / 单次高亮多贵」。
 */
export interface UiPerfHighlight {
  /** highlight() 调用总数（流式中的代码块） */
  requests: number;
  /** 短代码直通 */
  passthrough: number;
  /** 命中结果缓存、同步返回 */
  cacheHits: number;
  /** 真正交给 Shiki 的次数 */
  submitted: number;
  /** 被摊薄（窗口内改用「旧色 + 无色增量」）的次数 */
  throttled: number;
  /** 窗口到期（trailing）触发的次数 */
  flushed: number;
  /** 同前缀分叉导致提前落地的次数 */
  forks: number;
  /** 单次高亮耗时（提交→回调）累计 / 窗口内最大 / 样本数，毫秒 */
  costSumMs: number;
  costMaxMs: number;
  costCount: number;
  /** 当前同时在跟踪的流式代码块数 */
  slots: number;
}

export interface UiPerfSample {
  v: 1;
  reason: UiPerfReason;
  /** 本窗口时长 ms */
  windowMs: number;
  /** 窗口内页面可见的时长 ms */
  visibleMs: number;
  longTasks: {
    n: number;
    sumMs: number;
    maxMs: number;
    /** ≥100ms 的个数 */
    n100: number;
    /** ≥250ms 的个数 */
    n250: number;
  };
  /** 交互到下一次绘制的耗时（INP 口径：只算真实交互） */
  inputs: { n: number; p50Ms: number; maxMs: number; n200: number };
  /** 回前台后 3s 内长任务累计 ms（后台积压追赶的代理指标）；窗口内没回过前台则省略 */
  afterShowMs?: number;
  /** 无异常信号、仅作「没卡」的抽样心跳 */
  heartbeat?: true;
  heapMB?: number;
  domNodes?: number;
  /** 窗口内没有任何流式代码块高亮请求时省略 */
  highlight?: UiPerfHighlight;
}

export interface UiPerfProbe {
  heapMB?: number;
  domNodes?: number;
  highlight?: UiPerfHighlight;
}

/** 单个长任务达到这个时长就算信号 */
const LONG_TASK_SIGNAL_MS = 150;
const SLOW_INPUT_MS = 200;
const AFTER_SHOW_SIGNAL_MS = 300;
const AFTER_SHOW_WINDOW_MS = 3000;
/** 长任务可能在 visibilitychange 回调之前就已开始：给一点时钟容差 */
const AFTER_SHOW_TOLERANCE_MS = 50;
/** 单窗口保留的交互时长样本数上限（只用于算中位数；计数 / 最大值 / 慢交互数另外累计、不受限） */
const MAX_INPUT_SAMPLES = 256;
/**
 * 默认每 10 个「可见且无信号」的 interval 窗口出一条心跳。
 * scripts/lib/perf-report.mjs 据此估算「卡顿窗口占比」（一条心跳 ≈ 10 个没卡的窗口），
 * 两处常量由 tests/perf-report.test.ts 锁一致。
 */
export const DEFAULT_HEARTBEAT_EVERY = 10;

const validMs = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;

const HIGHLIGHT_KEYS = [
  "requests",
  "passthrough",
  "cacheHits",
  "submitted",
  "throttled",
  "flushed",
  "forks",
  "costSumMs",
  "costMaxMs",
  "costCount",
  "slots",
] as const;

/** 全字段合法才收；窗口内没有请求（requests=0）说明没在流式渲染代码块，省略 */
const cleanHighlight = (h: unknown): UiPerfHighlight | undefined => {
  if (typeof h !== "object" || h === null) return undefined;
  const src = h as Record<string, unknown>;
  const out = {} as UiPerfHighlight;
  for (const k of HIGHLIGHT_KEYS) {
    const v = src[k];
    if (!validMs(v)) return undefined;
    out[k] = Math.round(v);
  }
  return out.requests > 0 ? out : undefined;
};

/** 线性插值分位（p ∈ [0,1]），入参须已升序 */
const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

export interface UiPerfCollectorInit {
  /** 窗口起点（performance.now() 时钟） */
  at: number;
  visible: boolean;
  /** 每多少个「可见且无信号」的 interval 窗口出一条心跳 */
  heartbeatEvery?: number;
}

export type UiPerfCollector = ReturnType<typeof createUiPerfCollector>;

export const createUiPerfCollector = (init: UiPerfCollectorInit) => {
  const heartbeatEvery = Math.max(1, init.heartbeatEvery ?? DEFAULT_HEARTBEAT_EVERY);

  let windowStart = init.at;
  let visible = init.visible;
  let visibleSince: number | undefined = init.visible ? init.at : undefined;
  let visibleAcc = 0;
  /** 最近一次回前台的时刻（跨窗口保留：回前台后 3s 的追赶可能跨过 flush 边界） */
  let showAt: number | undefined;
  let sawAfterShow = false;
  let afterShowMs = 0;

  let ltN = 0;
  let ltSum = 0;
  let ltMax = 0;
  let ltN100 = 0;
  let ltN250 = 0;

  let inputN = 0;
  let inputMax = 0;
  let inputN200 = 0;
  let inputSamples: number[] = [];

  let idleWindows = 0;

  const reset = (at: number): void => {
    windowStart = at;
    visibleAcc = 0;
    visibleSince = visible ? at : undefined;
    sawAfterShow = false;
    afterShowMs = 0;
    ltN = ltSum = ltMax = ltN100 = ltN250 = 0;
    inputN = inputMax = inputN200 = 0;
    inputSamples = [];
  };

  return {
    onLongTask(durationMs: number, at: number): void {
      if (!validMs(durationMs)) return;
      ltN += 1;
      ltSum += durationMs;
      ltMax = Math.max(ltMax, durationMs);
      if (durationMs >= 100) ltN100 += 1;
      if (durationMs >= 250) ltN250 += 1;
      if (showAt !== undefined && Number.isFinite(at)) {
        const since = at - showAt;
        if (since >= -AFTER_SHOW_TOLERANCE_MS && since <= AFTER_SHOW_WINDOW_MS) {
          afterShowMs += durationMs;
          sawAfterShow = true;
        }
      }
    },

    onInput(durationMs: number): void {
      if (!validMs(durationMs)) return;
      inputN += 1;
      inputMax = Math.max(inputMax, durationMs);
      if (durationMs >= SLOW_INPUT_MS) inputN200 += 1;
      inputSamples.push(durationMs);
      if (inputSamples.length > MAX_INPUT_SAMPLES) inputSamples.shift();
    },

    setVisible(next: boolean, at: number): void {
      if (next === visible) return;
      if (next) {
        visibleSince = at;
        showAt = at;
        sawAfterShow = true;
      } else if (visibleSince !== undefined) {
        visibleAcc += Math.max(0, at - visibleSince);
        visibleSince = undefined;
      }
      visible = next;
    },

    /**
     * 结算当前窗口并复位。返回 null = 这个窗口不需要上报。
     * probe 只在决定上报时才调。
     */
    flush(
      at: number,
      reason: UiPerfReason,
      probe?: () => UiPerfProbe,
    ): UiPerfSample | null {
      const visibleMs = Math.round(
        visibleAcc + (visibleSince !== undefined ? Math.max(0, at - visibleSince) : 0),
      );
      const windowMs = Math.round(Math.max(0, at - windowStart));
      const sample: UiPerfSample = {
        v: 1,
        reason,
        windowMs,
        visibleMs,
        longTasks: {
          n: ltN,
          sumMs: Math.round(ltSum),
          maxMs: Math.round(ltMax),
          n100: ltN100,
          n250: ltN250,
        },
        inputs: {
          n: inputN,
          p50Ms: Math.round(percentile([...inputSamples].sort((a, b) => a - b), 0.5)),
          maxMs: Math.round(inputMax),
          n200: inputN200,
        },
      };
      if (sawAfterShow) sample.afterShowMs = Math.round(afterShowMs);
      const hasSignal =
        ltMax >= LONG_TASK_SIGNAL_MS ||
        ltN250 > 0 ||
        inputN200 > 0 ||
        afterShowMs >= AFTER_SHOW_SIGNAL_MS;

      reset(at);

      // 页面全程不可见：后台没有数据意义，也不推进心跳
      if (visibleMs <= 0) return null;

      let heartbeat = false;
      if (hasSignal) {
        idleWindows = 0;
      } else if (reason === "interval") {
        idleWindows += 1;
        if (idleWindows >= heartbeatEvery) {
          idleWindows = 0;
          heartbeat = true;
        }
      }
      if (!hasSignal && !heartbeat) return null;
      if (heartbeat) sample.heartbeat = true;

      if (probe) {
        try {
          const p = probe();
          if (validMs(p.heapMB)) sample.heapMB = Math.round(p.heapMB * 10) / 10;
          if (validMs(p.domNodes)) sample.domNodes = Math.round(p.domNodes);
          const hl = cleanHighlight(p.highlight);
          if (hl) sample.highlight = hl;
        } catch {
          /* 探针失败只是少这几个字段 */
        }
      }
      return sample;
    },
  };
};
