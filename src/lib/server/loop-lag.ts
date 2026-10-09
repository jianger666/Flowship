/**
 * 事件循环延迟 / 利用率 / GC 暂停采样（每秒一个点，环形缓冲保留最近 10 分钟）。
 *
 * 为什么要有：「UI 卡」有两类完全不同的原因——模型 / 网络慢（服务端空闲在等），
 * 或服务端主线程被占住（JSON.parse 大文件 / 同步 IO / GC，所有请求一起卡）。
 * 没有这个采样，两类在日志里长得一样。run 汇总（run-perf-record）在 run 结束时按
 * 「send 发起 → 结束」的窗口取汇总写进记录，慢秒（max≥500ms）另落一条 loop-lag.jsonl。
 *
 * 开销：一个 1s 的 unref 定时器 + 一个 10ms 分辨率的直方图（Node 内置、C++ 侧采样）。
 * 幂等启动（挂 globalThis，防 dev HMR / 多 chunk 重复起）。
 */
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from "node:perf_hooks";

import { appendPerfRecord } from "./perf-journal";

/** 直方图分辨率：记录的延迟里含这个基线，汇总时扣掉（空闲时 p50≈0） */
const RESOLUTION_MS = 10;
const RING_SECONDS = 600;
/** 单次 GC 暂停 ≥ 这个才计数（小 GC 太频繁、没信息量） */
const GC_MIN_MS = 20;
/** 一秒内最大延迟 ≥ 这个就落一条慢秒记录 */
const SLOW_LOG_MS = 500;
/** 「卡顿秒」判定：max > 这个 */
const SLOW_SECOND_MS = 200;
/** 慢秒记录节流：每分钟最多这么多条 */
const SLOW_LOG_PER_MINUTE = 6;

export interface LoopLagSecond {
  /** 这一秒结束时刻（ms，epoch），样本覆盖 (t-1000, t] */
  t: number;
  p50: number;
  p99: number;
  max: number;
  /** 事件循环利用率 0~1（这一秒里主线程忙了多少） */
  elu: number;
  gcMax: number;
  gcCount: number;
}

export interface LoopLagSummary {
  seconds: number;
  /** 各秒 p99 的最大值 */
  p99Max: number;
  max: number;
  eluAvg: number;
  /** max > 200ms 的秒数 */
  slowSeconds: number;
  gcMax: number;
  gcCount: number;
}

/** 汇总 [fromMs, toMs] 窗口内与之有交集的采样秒（纯函数，便于单测） */
export const summarizeLoopLag = (
  samples: readonly LoopLagSecond[],
  fromMs: number,
  toMs: number,
): LoopLagSummary | null => {
  const hit = samples.filter((s) => s.t > fromMs && s.t - 1000 < toMs);
  if (hit.length === 0) return null;
  let p99Max = 0;
  let max = 0;
  let eluSum = 0;
  let slowSeconds = 0;
  let gcMax = 0;
  let gcCount = 0;
  for (const s of hit) {
    p99Max = Math.max(p99Max, s.p99);
    max = Math.max(max, s.max);
    eluSum += s.elu;
    if (s.max > SLOW_SECOND_MS) slowSeconds++;
    gcMax = Math.max(gcMax, s.gcMax);
    gcCount += s.gcCount;
  }
  return {
    seconds: hit.length,
    p99Max,
    max,
    eluAvg: eluSum / hit.length,
    slowSeconds,
    gcMax,
    gcCount,
  };
};

type SamplerState = {
  ring: LoopLagSecond[];
  stop: () => void;
};

const G = globalThis as unknown as {
  __feLoopLag?: SamplerState;
  /** run-perf 维护的在飞 run 数（慢秒记录里带上，看「卡的时候有几个 run 在跑」） */
  __fePerfActiveRuns?: number;
};

export const startLoopLagSampler = (): void => {
  if (G.__feLoopLag) return;

  const hist = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  hist.enable();

  let gcMax = 0;
  let gcCount = 0;
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration >= GC_MIN_MS) {
          gcCount++;
          gcMax = Math.max(gcMax, e.duration);
        }
      }
    });
    obs.observe({ entryTypes: ["gc"] });
  } catch {
    // 个别运行时不支持 gc 条目：只是少这一项
    obs = null;
  }

  const ring: LoopLagSecond[] = [];
  let prevElu = performance.eventLoopUtilization();
  let slowLogged: number[] = [];

  const ms = (ns: number): number => Math.max(0, ns / 1e6 - RESOLUTION_MS);

  const timer = setInterval(() => {
    const now = Date.now();
    const elu = performance.eventLoopUtilization(prevElu);
    prevElu = performance.eventLoopUtilization();
    const empty = hist.count === 0;
    const sample: LoopLagSecond = {
      t: now,
      p50: empty ? 0 : ms(hist.percentile(50)),
      p99: empty ? 0 : ms(hist.percentile(99)),
      max: empty ? 0 : ms(hist.max),
      elu: elu.utilization,
      gcMax,
      gcCount,
    };
    hist.reset();
    gcMax = 0;
    gcCount = 0;
    ring.push(sample);
    if (ring.length > RING_SECONDS) ring.shift();

    if (sample.max >= SLOW_LOG_MS) {
      slowLogged = slowLogged.filter((t) => now - t < 60_000);
      if (slowLogged.length < SLOW_LOG_PER_MINUTE) {
        slowLogged.push(now);
        appendPerfRecord("loop-lag.jsonl", {
          kind: "slow-second",
          max: Math.round(sample.max),
          p99: Math.round(sample.p99),
          elu: Number(sample.elu.toFixed(2)),
          gcMax: Math.round(sample.gcMax),
          gcCount: sample.gcCount,
          activeRuns: G.__fePerfActiveRuns ?? 0,
          rssMB: Math.round(process.memoryUsage().rss / 1048576),
        });
      }
    }
  }, 1000);
  timer.unref();

  G.__feLoopLag = {
    ring,
    stop: () => {
      clearInterval(timer);
      hist.disable();
      obs?.disconnect();
      G.__feLoopLag = undefined;
    },
  };
};

/** 测试 / 优雅退出用 */
export const stopLoopLagSampler = (): void => {
  G.__feLoopLag?.stop();
};

/** 取 [fromMs, toMs] 窗口的汇总；采样器没起 / 窗口里没有采样点 → null */
export const loopLagWindow = (
  fromMs: number,
  toMs: number,
): LoopLagSummary | null => {
  const st = G.__feLoopLag;
  return st ? summarizeLoopLag(st.ring, fromMs, toMs) : null;
};
