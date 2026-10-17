/**
 * 会话级「可中断等待」：Flowship 自有 `wait` 工具的运行时（Cursor SDK 与 pi 共用）
 *
 * 叶子模块——不 import chat-pending / chat-runner 等任何会话模块，它们都只 import 这里，避免循环依赖。
 *
 * # 为什么要自己做
 * Cursor SDK 里模型想「等一会儿」只有两条路：shell 的 `sleep`（会占住一个终端、UI 上是个没头没尾的命令），
 * 或原生 `await`——后者对我们**完全不可见**（2026-10-16 实测：模型睡 12s，SDK 流里 0 条 `tool_call`，
 * 事件流一片空白，状态行只能说「思考中」）。自己做一个等待工具，等待就成了事件流里一个看得见、
 * 带参数（秒数 / 原因）、能被用户跳过的普通工具调用。
 *
 * # 三种提前结束，口径各不相同
 * - `skip`：用户在 UI 点了「跳过等待」→ 模型继续往下做，不要再为同一件事重复等；
 * - `steer`：有新消息要送进当前这一轮——用户插话（「立即发送」）或后台子代理交回结果 →
 *   模型先读新消息，要等的话再调一次（steer 要等模型当前这一步结束才送得进去，不叫醒就会被睡眠压住）；
 * - `cancel`：任务被停止 / 关闭 / 删除 → 返回给一个已经被取消的 run，文案只是为了让回调干净退出。
 *
 * # 为什么按 taskId 注册
 * 停止 / 插话 / 跳过的入口都只认识 taskId；而工具回调里拿到的是 callerToken——
 * 两者的映射要穿过 agent 包装层，不如在工具构建处（两条后端都知道 taskId）直接把 taskId 带进来。
 * 没有 taskId 的会话（理论上不存在）仍然能等，只是只能被定时器 / AbortSignal 结束。
 *
 * # 为什么还有一档 scope（agent 实例）
 * 取消 run 的入口远不止「停止」：懒重启（切模型 / MCP / 工作目录 / 提供方）、错误收尾、期限超时、
 * 重连换实例……它们都走 `run.cancel()` / `agent.close()`，不经过 taskId 级的 stop。
 * 实测（2026-10-16）：这些路径取消后 SDK 不会被睡着的回调卡住（`run.wait()` 立刻 cancelled），
 * 但回调本身没人叫，会变成僵尸等待睡到自己的定时器（最长 30 分钟）。所以工具构建处再给每个 agent 实例
 * 一个 scope，由 cursor-subagent 的取消联动（Proxy 包住 run.cancel / close）按 scope 叫醒——
 * 按实例而不是按 taskId：新旧实例同属一个任务，旧的被取消不能把新的等待一起叫醒。
 *
 * # 为什么不靠 AbortSignal
 * Cursor 的 `SDKCustomToolContext` 没有 signal（见 cursor-subagent 头注释第 4 条：取消不联动），
 * 父 run 被取消后回调还会一直睡到自然结束。pi 的 `execute` 有 signal、会一并接上，
 * 但 Cursor 这条路必须靠注册表在停止时主动唤醒。
 */

import { formatDurationCoarse } from "@/lib/duration-display";

/**
 * 单次等待上限：30 分钟。更久的等待拆成「等一会儿 → 醒来自查 → 再等」。
 *
 * 不是为了「让用户有机会插话」——跳过 / 插话 / 停止都能随时叫醒 wait，用户不会被等待卡住。
 * 真实理由是：
 * - 防模型误填 `seconds=86400` 之类的极大值；
 * - 兜住没被任何唤醒路径覆盖的僵尸等待（最坏也只睡到这个上限）；
 * - Cursor 的 customTool 回调要经后端 agent loop 往返，后端对单次长调用的超时**未验证**
 *   （现有实测只有 12s 的原生 await）。真机跑过 ≥5 分钟（最好 30 分钟）稳定后，可再评估抬到 3600。
 */
export const WAIT_MAX_SECONDS = 1800;
export const WAIT_MIN_SECONDS = 1;

export type WaitInterruptReason = "skip" | "steer" | "cancel";
export type WaitStatus = "done" | WaitInterruptReason;

export interface WaitOutcome {
  status: WaitStatus;
  /** 实际等了多久（墙钟，机器睡眠期间也在走） */
  elapsedMs: number;
  /** 当初要等多久 */
  plannedMs: number;
}

interface Waiter {
  wake: (reason: WaitInterruptReason) => void;
}

type WaitHolder = typeof globalThis & {
  __flowshipSessionWaiters?: Map<string, Set<Waiter>>;
};

/** 挂 globalThis：Next 多个路由 chunk 各 import 一份模块也共用同一张表 */
const waiters = (): Map<string, Set<Waiter>> => {
  const g = globalThis as WaitHolder;
  g.__flowshipSessionWaiters ??= new Map();
  return g.__flowshipSessionWaiters;
};

/**
 * 把工具入参里的秒数收敛成合法范围；非数字 / NaN / 非正数返回 null（由调用方报用法错误给模型）。
 * 超上限不报错、钳到上限（`clamped` 告诉调用方在返回文案里说一句）。
 */
export const normalizeWaitSeconds = (
  raw: unknown,
): { seconds: number; clamped: boolean } | null => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  const rounded = Math.max(WAIT_MIN_SECONDS, Math.round(raw));
  if (rounded > WAIT_MAX_SECONDS) {
    return { seconds: WAIT_MAX_SECONDS, clamped: true };
  }
  return { seconds: rounded, clamped: false };
};

/**
 * 等待 `plannedMs`，期间可被 {@link interruptWaits}（按 key）或 `signal` 提前结束。
 * 永不 reject：所有结局都以 {@link WaitOutcome} resolve。
 */
export const runWait = (opts: {
  /** 一般是 taskId（用户侧：停止 / 插话 / 跳过按它叫醒）；缺省 = 不登记这一档 */
  key?: string;
  /**
   * agent 实例级 scope（后端侧：这个实例的 run 被取消 / 会话被关时按它叫醒）。
   * 与 key 并存、互不替代：同一个任务先后有两个实例（懒重启 / 重连换实例）时，
   * 旧实例被取消只该叫醒旧实例自己的等待，不能误伤新实例刚开始的那个。
   */
  scope?: string;
  plannedMs: number;
  signal?: AbortSignal;
}): Promise<WaitOutcome> =>
  new Promise<WaitOutcome>((resolve) => {
    const { key, scope, plannedMs, signal } = opts;
    const keys = [key, scope].filter((k): k is string => !!k);
    const startedAt = Date.now();
    let settled = false;
    // 句柄放对象里而不是 `let timer`：signal 已取消的提前返回路径会在定时器创建前就调 finish，
    // 用 const 会撞 TDZ；对象属性则读到 undefined、安全跳过 clearTimeout
    const timer: { id?: ReturnType<typeof setTimeout> } = {};

    const waiter: Waiter = { wake: (reason) => finish(reason) };

    const onAbort = (): void => finish("cancel");

    function finish(status: WaitStatus): void {
      if (settled) return;
      settled = true;
      if (timer.id !== undefined) clearTimeout(timer.id);
      signal?.removeEventListener("abort", onAbort);
      for (const k of keys) {
        const set = waiters().get(k);
        set?.delete(waiter);
        if (set && set.size === 0) waiters().delete(k);
      }
      resolve({
        status,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        plannedMs,
      });
    }

    // 已经被取消：不登记、不起定时器，直接收尾
    if (signal?.aborted) {
      finish("cancel");
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    for (const k of keys) {
      const map = waiters();
      const set = map.get(k) ?? new Set<Waiter>();
      set.add(waiter);
      map.set(k, set);
    }
    timer.id = setTimeout(() => finish("done"), plannedMs);
  });

/**
 * 唤醒某个 key（taskId）下所有在等的 `wait`；返回唤醒了几个。
 * 无人在等 / key 为空 = 0（调用方不用先判断「有没有人在等」，停止 / 插话路径可以无脑调）。
 */
export const interruptWaits = (
  key: string | null | undefined,
  reason: WaitInterruptReason,
): number => {
  if (!key) return 0;
  const set = waiters().get(key);
  if (!set || set.size === 0) return 0;
  // 复制一份再唤醒：wake 会同步把自己从 set 里删掉
  const snapshot = [...set];
  for (const w of snapshot) w.wake(reason);
  return snapshot.length;
};

/** 当前有几个 `wait` 在等（测试 / 诊断用） */
export const activeWaitCount = (key: string): number =>
  waiters().get(key)?.size ?? 0;

// ----------------- 返回给模型的文案 -----------------

const fmt = (ms: number): string => formatDurationCoarse(ms) ?? "0s";

/**
 * 工具返回文案。统一带 `[WAIT_xxx]` 前缀，模型一眼分得清「等够了」还是「被打断了」；
 * 被打断的几种各自说清下一步该怎么办（不然模型会愣住、或者不管三七二十一再睡一遍）。
 */
export const formatWaitResult = (
  outcome: WaitOutcome,
  opts?: { reason?: string; clamped?: boolean },
): string => {
  const what = opts?.reason?.trim() ? `（${opts.reason.trim()}）` : "";
  const progress = `已等 ${fmt(outcome.elapsedMs)} / 计划 ${fmt(outcome.plannedMs)}`;
  const clampNote = opts?.clamped
    ? `\n注意：你要的时长超过单次上限 ${WAIT_MAX_SECONDS}s，已按上限等。`
    : "";
  switch (outcome.status) {
    case "done":
      return `[WAIT_DONE] 已等待 ${fmt(outcome.elapsedMs)}${what}。等待只是睡觉、不会替你检查要等的事——现在自己去确认它是否就绪。${clampNote}`;
    case "skip":
      // 跳过 ≠ 条件已满足：用户只是不想再等（可能嫌慢、可能要先看别的），要等的事多半还没好。
      // 只说「直接继续」，模型会当它已就绪、在没好的东西上往下做
      return `[WAIT_SKIPPED] 用户选择跳过等待${what}（${progress}）。跳过只表示用户不想再等，不表示你要等的事已经完成——先自己确认一次它现在的状态，再据实际情况往下做（没好就如实告诉用户、按没好处理）。不要再为同一件事重复等待。${clampNote}`;
    case "steer":
      return `[WAIT_INTERRUPTED] 有新消息到达（用户插话，或后台子代理交回了结果），等待提前结束${what}（${progress}）。先读并处理这条新消息；确实还需要等的话，再调一次 wait。${clampNote}`;
    case "cancel":
      return `[WAIT_CANCELLED] 任务已被停止或关闭，等待结束${what}。立刻结束本轮：不要再调用任何工具，也不要再继续做事。`;
  }
};
