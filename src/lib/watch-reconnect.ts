/**
 * useTaskWatch 重连状态机里「预算耗尽 → 休眠待重连 → 唤醒清零」那一段，从 hook 抽成可测的纯逻辑
 * （hook 本体依赖 React / 浏览器，vitest node 环境起不来；这里只依赖注入的 delay / 事件源）。
 *
 * 另含：
 * - 休眠提示 toast 的稳定 id 与「何时该撤」的状态步进（R6-04）
 * - 重连后用服务端快照校准 runActive 的纯函数（R6-01）
 */

import type { RunStatus } from "./types";
import {
  isStableWatchConnection,
  shouldResumeWatch,
  WATCH_DORMANT_RETRY_INTERVAL_MS,
  type WatchReconnectDecision,
  type WatchResumeSignal,
} from "./task-terminal";

// ----------------- 预算 -----------------

/** 重连预算（hook 内三个计数的合体，便于按引用传给 applyReconnectDecision） */
export interface WatchBudget {
  unavailableAttempts: number;
  transientFailures: number;
  unavailableNotified: boolean;
}

export const freshWatchBudget = (): WatchBudget => ({
  unavailableAttempts: 0,
  transientFailures: 0,
  unavailableNotified: false,
});

/**
 * 一条连接结束时结算预算（Q16-01）：建连后撑过稳定窗口才清零，返回是否稳定。
 * 没撑过（建连后立刻被掐断 / 回调立刻抛错 / 从未建连）预算原样不动——失败照常累计，攒到上限才会进入休眠并提示。
 * hook 在 clean EOF 与 reader 抛错两条路径上、算重连策略之前各调一次；建连只记时刻（establishedAt），不再清零。
 */
export const settleWatchBudget = (
  budget: WatchBudget,
  establishedAt: number | null,
  endedAt: number,
): boolean => {
  const stable = isStableWatchConnection(establishedAt, endedAt);
  if (stable) Object.assign(budget, freshWatchBudget());
  return stable;
};

// ----------------- 休眠等待 -----------------

type ListenerTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface DormantEnv {
  win: ListenerTarget;
  doc: ListenerTarget;
  /** 当前页面是否隐藏 / 是否在线（每次信号到来时现读） */
  read: () => { hidden: boolean; online: boolean };
  /** 低频兜底复查间隔 */
  tickMs: number;
}

const browserDormantEnv = (): DormantEnv => ({
  win: window,
  doc: document,
  read: () => ({
    hidden: typeof document !== "undefined" && document.hidden,
    online: typeof navigator === "undefined" || navigator.onLine !== false,
  }),
  tickMs: WATCH_DORMANT_RETRY_INTERVAL_MS,
});

export interface DormantWaiter {
  /** 进入休眠：返回的 promise 在被唤醒时 resolve(true)、被 resume(false) 放弃时 resolve(false) */
  wait: () => Promise<boolean>;
  /** 手动唤醒（用户点「重连」，无条件放行）/ 放弃（卸载） */
  resume: (go: boolean) => void;
}

/**
 * 唤醒源：online / 页面回可见 / 低频兜底定时（仅可见且在线才放行，见 shouldResumeWatch）/ 手动。
 * 同一时刻至多一个等待；wait 之外的 resume 是空操作。
 */
export const createDormantWaiter = (env?: DormantEnv): DormantWaiter => {
  let finish: ((go: boolean) => void) | null = null;
  return {
    wait: () =>
      new Promise<boolean>((resolve) => {
        const e = env ?? browserDormantEnv();
        const onSignal = (signal: WatchResumeSignal) => {
          if (shouldResumeWatch(signal, e.read())) done(true);
        };
        const onOnline = () => onSignal("online");
        const onVisibility = () => onSignal("visible");
        const timer = setInterval(() => onSignal("tick"), e.tickMs);
        const done = (go: boolean) => {
          clearInterval(timer);
          e.win.removeEventListener("online", onOnline);
          e.doc.removeEventListener("visibilitychange", onVisibility);
          finish = null;
          resolve(go);
        };
        e.win.addEventListener("online", onOnline);
        e.doc.addEventListener("visibilitychange", onVisibility);
        finish = done;
      }),
    resume: (go) => finish?.(go),
  };
};

// ----------------- 决策落地 -----------------

export interface ApplyDecisionCtx {
  /** 可变预算：retry 时写入 next*，休眠被唤醒后清零 */
  budget: WatchBudget;
  error: Error;
  isCancelled: () => boolean;
  delay: (ms: number) => Promise<void>;
  waiter: DormantWaiter;
  /** 调用方提示；resume 仅在「已休眠」时给（挂「重连」按钮） */
  notify: (err: Error, resume?: () => void) => void;
  /** 进入休眠那一刻（早于等待） */
  onDormant?: () => void;
}

/**
 * 落地一次「非 deleted」的重连决策：
 * - retry：更新预算、按需提示、退避等待
 * - terminate_exhausted：提示一次（带 resume）→ 休眠等唤醒 → 预算清零
 * 返回 "continue" = 回到 loop 顶部重连；"stop" = 已取消 / 休眠被放弃，loop 应退出。
 */
export const applyReconnectDecision = async (
  decision: Exclude<WatchReconnectDecision, { action: "terminate_deleted" }>,
  ctx: ApplyDecisionCtx,
): Promise<"continue" | "stop"> => {
  if (decision.action === "terminate_exhausted") {
    // 已卸载就别挂监听 / 定时器（没人会再来 resume(false) 收它）
    if (ctx.isCancelled()) return "stop";
    // 先挂上等待再通知：notify 里拿到的 resume 一点就能生效
    const woken = ctx.waiter.wait();
    ctx.onDormant?.();
    if (!ctx.isCancelled() && decision.notifyException) {
      ctx.notify(ctx.error, () => ctx.waiter.resume(true));
    }
    const go = await woken;
    if (!go || ctx.isCancelled()) return "stop";
    Object.assign(ctx.budget, freshWatchBudget());
    return "continue";
  }
  ctx.budget.unavailableAttempts = decision.nextUnavailableAttempts;
  ctx.budget.transientFailures = decision.nextTransientFailures;
  ctx.budget.unavailableNotified = decision.nextUnavailableNotified;
  if (!ctx.isCancelled() && decision.notifyException) ctx.notify(ctx.error);
  await ctx.delay(decision.delayMs);
  return ctx.isCancelled() ? "stop" : "continue";
};

// ----------------- 休眠提示 toast -----------------

/** 同任务同范围一条：重复休眠只会原位更新，不叠加 */
export const watchDormantToastId = (
  scope: "task" | "chat",
  taskId: string,
): string => `watch-dormant:${scope}:${taskId}`;

export type DormantNoticeEvent = "enter" | "connected" | "teardown";

/**
 * 休眠提示的生命周期（纯函数）：enter 之后，连接重新建立（自动 / 手动唤醒成功）
 * 或 hook 卸载 / 切换任务（teardown）都要撤掉提示；没在休眠时什么都不用撤。
 */
export const stepDormantNotice = (
  dormant: boolean,
  event: DormantNoticeEvent,
): { dormant: boolean; dismiss: boolean } => {
  if (event === "enter") return { dormant: true, dismiss: false };
  return { dormant: false, dismiss: dormant };
};

// ----------------- runActive 校准 -----------------

/**
 * 重连成功 / 拿到服务端快照后校准前端 runActive latch。
 * latch 本来只靠 `done` 事件释放，SSE 断线期间漏了 done 就会一直卡在「运行中」、输入框被锁。
 * 服务端快照（权威）说不是 running → 释放；是 running → 保持 / 置位；缺失 → 不动。
 * 只应对「新连接的 bootstrap 快照」调用：运行中途的 task 帧里 runStatus 会先于流式尾巴结束变成
 * awaiting_user，用它释放会破坏 latch 原本的用途。
 */
export const reconcileRunActive = (
  prevActive: boolean,
  serverRunStatus: RunStatus | undefined,
): boolean => {
  if (serverRunStatus === undefined) return prevActive;
  return serverRunStatus === "running";
};

/**
 * 包装 onTaskUpdate：每个连接的**第一帧** task（= bootstrap 快照）额外回调 onBootstrap。
 * 每次重连（含休眠唤醒后的重连）都会重新建一个，所以「第一帧」天然是该连接的 bootstrap。
 */
export const withBootstrapNotice = <T>(
  forward: (t: T) => void,
  onBootstrap: (t: T) => void,
): ((t: T) => void) => {
  let seen = false;
  return (t) => {
    forward(t);
    if (!seen) {
      seen = true;
      onBootstrap(t);
    }
  };
};
