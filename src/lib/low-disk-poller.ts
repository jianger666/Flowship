/**
 * 低磁盘读数的轮询调度（R14 B2-4c）——纯逻辑、依赖全部注入，可用假定时器直接单测（手法同 warmup-scheduler.ts）。
 * `useLowDisk` 只是把它接到 fetch / window 事件 / React state 上。
 *
 * 行为：
 *  - start()：立刻取一次，之后每 intervalMs 取一次（从「上一次取完」算起，不是固定网格——取数慢也不会叠请求）；
 *  - 定时到点时页面不可见（最小化 / 切到别的标签）：这一次不取、仍排下一次；回到前台由 nudge() 补；
 *  - nudge()（窗口聚焦 / 变可见）：距上次开始取数 ≥ minGapMs 才取（防抖），取完同样重排下一次；
 *  - 同一时刻最多一个请求在飞；
 *  - fetchReading 返回 null（网络错 / 非 2xx / 形状不对）= 没取到：不动状态、照常排下一次；
 *  - stop() 之后：定时器清掉、在飞请求迟到的结果丢弃、nudge 无效。
 */
import {
  LOW_DISK_MIN_GAP_MS,
  LOW_DISK_POLL_INTERVAL_MS,
  type DiskReading,
} from "@/lib/low-disk";

export interface LowDiskPollerDeps {
  /** 取一次读数；约定不抛（失败返回 null），再兜一层 try/catch 防被打穿 */
  fetchReading: () => Promise<DiskReading | null>;
  onReading: (reading: DiskReading) => void;
  isVisible: () => boolean;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  intervalMs?: number;
  minGapMs?: number;
}

export interface LowDiskPoller {
  start: () => void;
  nudge: () => void;
  stop: () => void;
}

export const createLowDiskPoller = (deps: LowDiskPollerDeps): LowDiskPoller => {
  const intervalMs = deps.intervalMs ?? LOW_DISK_POLL_INTERVAL_MS;
  const minGapMs = deps.minGapMs ?? LOW_DISK_MIN_GAP_MS;
  let timer: unknown = null;
  let stopped = false;
  let inflight = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  const schedule = (): void => {
    if (stopped) return;
    if (timer !== null) deps.clearTimer(timer);
    timer = deps.setTimer(() => {
      timer = null;
      void run(false);
    }, intervalMs);
  };

  const run = async (force: boolean): Promise<void> => {
    if (stopped) return;
    if (inflight || (!force && !deps.isVisible())) {
      schedule();
      return;
    }
    inflight = true;
    lastStartedAt = deps.now();
    try {
      const reading = await deps.fetchReading();
      if (!stopped && reading) deps.onReading(reading);
    } catch {
      // fetchReading 本不该抛；真抛了也只当这次没取到
    } finally {
      inflight = false;
      schedule();
    }
  };

  return {
    start: () => {
      stopped = false;
      void run(true);
    },
    nudge: () => {
      if (stopped || inflight || !deps.isVisible()) return;
      if (deps.now() - lastStartedAt < minGapMs) return;
      void run(true);
    },
    stop: () => {
      stopped = true;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    },
  };
};
