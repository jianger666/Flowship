/**
 * 预热触发的去抖 + 节流（纯逻辑、无 React / DOM 依赖，便于单测）。
 *
 * 用户「回到窗口」往往同时触发 window focus、visibilitychange、再点输入框（focusin）好几个信号，
 * 只想发一次请求：
 * - 去抖：debounceMs 内的重复请求合并成一次，以最后一次请求的 task 为准
 * - 不可见（窗口在后台）不发
 * - 同一 task 在 minIntervalMs 内不重复发；换 task 不受限（服务端另有 20s 节流兜底）
 * 发送失败（send 抛错）不影响后续——预热是尽力而为。
 */

export interface WarmupSchedulerOptions {
  send: (taskId: string) => void;
  isVisible: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  debounceMs?: number;
  minIntervalMs?: number;
}

export interface WarmupScheduler {
  /** 请求一次预热（去抖后才真正发送） */
  request: (taskId: string) => void;
  /** 取消尚未发出的请求（切 task / 卸载时调） */
  cancel: () => void;
}

export const createWarmupScheduler = (
  opts: WarmupSchedulerOptions,
): WarmupScheduler => {
  const now = opts.now ?? (() => Date.now());
  const setTimer =
    opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ??
    ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const debounceMs = opts.debounceMs ?? 400;
  const minIntervalMs = opts.minIntervalMs ?? 30_000;

  let pending: { handle: unknown } | null = null;
  let last: { taskId: string; at: number } | null = null;

  const fire = (taskId: string): void => {
    pending = null;
    if (!opts.isVisible()) return;
    const t = now();
    if (last && last.taskId === taskId && t - last.at < minIntervalMs) return;
    last = { taskId, at: t };
    try {
      opts.send(taskId);
    } catch {
      // 预热是尽力而为：发送失败不影响用户
    }
  };

  return {
    request(taskId) {
      if (pending) clearTimer(pending.handle);
      pending = { handle: setTimer(() => fire(taskId), debounceMs) };
    },
    cancel() {
      if (pending) {
        clearTimer(pending.handle);
        pending = null;
      }
    },
  };
};
