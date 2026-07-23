/**
 * SDK 调用 deadline（Promise.race）
 *
 * 背景：半死 TCP / 代理挂死时 `Agent.create` / `Agent.resume` / `agent.send` 的裸 await
 * 可能卡到 OS 重传超时（常 10~15 分钟）才失败，表现为「接口已成功、事件流长时间无动静」。
 * 本模块给这些 await 点统一加硬上限；超时错误文案含 timeout/deadline，
 * 可被 `isRetryableRunError` 识别并走既有 auto-reconnect。
 *
 * 超时后原 promise 仍在飞（SDK 无取消 API）。本模块在超时路径挂 late 收尸：
 * 迟到 resolve 的 Agent/Run 统一 close/cancel，避免孤儿 agent / 未消费 Run。
 * 调用方不必每处手拷——单一入口见 {@link withSdkDeadline} / {@link reapLateSdkResult}。
 */

/** create / resume：冷启动含建连 + 会话恢复，给足余量 */
export const SDK_CREATE_RESUME_TIMEOUT_MS = 180_000;
/** send：Run 受理应远快于冷启动；挂死多半是死连接 */
export const SDK_SEND_TIMEOUT_MS = 120_000;

/**
 * SDK 调用超时错误。message 必须能被 isRetryableRunError 的网络关键字命中
 *（timeout / deadline），以便走 auto-reconnect 而非永久 give-up。
 */
export class SdkDeadlineError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;
  constructor(operation: string, timeoutMs: number) {
    super(
      `SDK ${operation} 超时（${Math.round(timeoutMs / 1000)}s）— network deadline exceeded`,
    );
    this.name = "SdkDeadlineError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export const isSdkDeadlineError = (err: unknown): err is SdkDeadlineError =>
  err instanceof SdkDeadlineError ||
  (err instanceof Error && err.name === "SdkDeadlineError");

/**
 * 迟到结算收尸（单一入口）：duck-type Agent.close / Run.cancel。
 * 超时后原 promise 仍可能成功——无人收则孤儿 agent / 未消费 Run。
 */
export const reapLateSdkResult = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  const o = value as { cancel?: () => unknown; close?: () => unknown };
  // Run 优先 cancel；Agent 走 close（无 cancel 时跳过）
  if (typeof o.cancel === "function") {
    void Promise.resolve(o.cancel()).catch(() => {
      /* noop */
    });
  }
  if (typeof o.close === "function") {
    void Promise.resolve(o.close()).catch(() => {
      /* noop */
    });
  }
};

export type WithSdkDeadlineOptions<T> = {
  /**
   * 超时后原 promise 迟到 resolve 时的收尸回调。
   * 缺省走 {@link reapLateSdkResult}（Agent.close / Run.cancel）。
   */
  onLate?: (value: T) => void;
};

/**
 * 给 SDK await 加硬 deadline。超时 reject SdkDeadlineError；原 promise 仍在飞
 *（SDK 无取消 API）——超时路径自动挂 late 收尸，避免半死连接 / 孤儿实例继续占位。
 */
export const withSdkDeadline = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
  opts?: WithSdkDeadlineOptions<T>,
): Promise<T> => {
  // 必须在 race 前挂上：超时 reject 后仍要收迟到成功
  let timedOut = false;
  void promise.then(
    (value) => {
      if (!timedOut) return;
      try {
        if (opts?.onLate) opts.onLate(value);
        else reapLateSdkResult(value);
      } catch {
        /* noop */
      }
    },
    () => {
      /* 迟到 reject：忽略 */
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new SdkDeadlineError(operation, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
