/**
 * run.wait() 的「取消逃生口」。
 *
 * 背景：task-runner / chat-runner 在 `for await (run.stream())` 结束后调 `await run.wait()` 拿终态。
 * 这一步以前**没有任何上限**：24h 硬顶计时器在流结束时就被清掉了，之后若 SDK / pi 的 wait 因为
 * checkpoint 落盘挂死、事件丢失等原因永不 settle，整轮 run 会永久占住 runningTasks / runningChats，
 * 界面一直「运行中」——用户点停止也只是对 run 发了 cancel，consume 本身仍挂在 wait 上。
 *
 * 做法：调用方在每个发出 `run.cancel()` 的地方调一次 `arm()`；`wait()` 与「已 arm」两个条件**同时成立**
 * 后再计 `graceMs`，到点还没返回就按「已取消」收尾（返回合成的 cancelled 终态）。
 * 计时从「两者都成立」的那一刻起算，所以：
 * - 没人取消 → 永远不触发（正常慢收尾不受影响，仍由 24h 硬顶兜底）；
 * - 取消发生在流消费期间 → 流结束进入 wait 后才开始计时，不会因为流本身花了时间就立刻判超时；
 * - run 取消后正常很快 settle → 计时器被 dispose 清掉，无副作用。
 *
 * 晚到的真实 wait() 结果被丢弃（只吞掉它的异常，避免 unhandledRejection）。
 */
import type { RunResult } from "@cursor/sdk";

/** 取消后给 wait() 的收尾宽限。正常取消在毫秒~秒级 settle，30s 足够宽松又不会让用户干等 */
export const CANCEL_WAIT_GRACE_MS = 30_000;

export interface CancelEscape {
  /** 每个调用 `run.cancel()` 的地方调一次（幂等） */
  arm(): void;
  /** 取代裸 `run.wait()`：取消后宽限期内仍不 settle → 返回合成的 cancelled 终态 */
  wait(run: { id: string; wait(): Promise<RunResult> }): Promise<RunResult>;
  /** wait 返回 / 抛错后必须调：清计时器，避免日后误触发 */
  dispose(): void;
  /** 观测：是否已经走了逃生口（测试 / 日志用） */
  readonly escaped: boolean;
}

export const createCancelEscape = (
  graceMs: number = CANCEL_WAIT_GRACE_MS,
  onEscape?: () => void,
): CancelEscape => {
  let armed = false;
  let waiting = false;
  let disposed = false;
  let escapedFlag = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fire: (() => void) | null = null;

  const maybeStart = (): void => {
    if (disposed || timer || !armed || !waiting) return;
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      escapedFlag = true;
      onEscape?.();
      fire?.();
    }, graceMs);
    // 不阻止进程退出（Electron 内嵌 server 正常退出时不该被它拖住）
    timer.unref?.();
  };

  return {
    arm() {
      armed = true;
      maybeStart();
    },
    wait(run) {
      waiting = true;
      const real = run.wait();
      const escape = new Promise<RunResult>((resolve) => {
        fire = () => resolve({ id: run.id, status: "cancelled" });
      });
      // 竞速输了的 real 之后若 reject：Promise.race 已订阅它，不会变成 unhandledRejection
      maybeStart();
      return Promise.race([real, escape]);
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    get escaped() {
      return escapedFlag;
    },
  };
};
