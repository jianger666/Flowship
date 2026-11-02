/**
 * 单槽取消登记（纯逻辑，use-dialog 用）。
 *
 * 全局 confirm / prompt 只有一个弹窗槽：新的 `await confirm()` 会把旧的顶掉。
 * 旧的 Promise 如果没人 resolve 就永远 pending（调用方的 await 之后逻辑永不执行、按钮 loading 卡死）。
 * 这里登记「当前占位的取消回调」：被顶替 / 卸载时由槽统一用取消语义 resolve 掉旧的。
 */

export interface CancelSlot {
  /** 登记新占位；前一个还没正常结束的占位会先被取消（调用其取消回调一次） */
  take: (cancel: () => void) => void;
  /** 当前占位已由用户正常结束（点了确认 / 取消）：清空登记，不再取消 */
  release: () => void;
  /** 取消当前占位（卸载兜底）；没有占位时无副作用 */
  flush: () => void;
}

export const createCancelSlot = (): CancelSlot => {
  let current: (() => void) | null = null;
  return {
    take: (cancel) => {
      const prev = current;
      // 先登记新的再取消旧的：旧回调里若同步又开新弹窗，也不会把新占位误清
      current = cancel;
      prev?.();
    },
    release: () => {
      current = null;
    },
    flush: () => {
      const prev = current;
      current = null;
      prev?.();
    },
  };
};

// ---------- 代际守卫（过期异步结果丢弃） ----------

/**
 * 代际守卫：给「会被关闭 / 重开的作用域」里的异步回调判断「我还属于当前这一代吗」。
 *
 * 为什么不用布尔位（alive / mounted）：关闭→快速重开时布尔位又变回 true，旧一代迟到的回调会误以为自己还有效——
 * 把新一代的 loading 提前清掉、把旧结果并进新状态、把新开的对话框关掉。每次打开领一个新代号，
 * 回调只认自己启动时领到的那个代号，关闭时整体作废。
 *
 * - `next()`：打开 / 激活——开新一代，此前所有代作废，返回新代号（恒 > 0）；
 * - `invalidate()`：关闭 / 卸载——当前代作废，`current()` 归 0（= 没有存活代）；
 * - `isCurrent(gen)`：回调落地时判断；0 永远不是当前（没存活代时启动的回调直接作废）。
 */
export interface GenerationGuard {
  next: () => number;
  invalidate: () => void;
  current: () => number;
  isCurrent: (gen: number) => boolean;
}

export const createGenerationGuard = (): GenerationGuard => {
  // 只增不减：invalidate 后再 next 也不会复用旧代号
  let counter = 0;
  let live = 0;
  return {
    next: () => {
      counter += 1;
      live = counter;
      return live;
    },
    invalidate: () => {
      live = 0;
    },
    current: () => live,
    isCurrent: (gen) => gen !== 0 && gen === live,
  };
};

// ---------- 代际守卫的两个「落地」纯函数（生产代码真实调用，同时是行为测试的对象） ----------

/** {@link runGuardedTask} 的回调；除 onStart 外，只有「落地时仍是同一代」才会被调用 */
export interface GuardedTaskHandlers<T> {
  /** 有存活代、task 启动前调用（置 loading 之类） */
  onStart?: () => void;
  onResult: (value: T) => void;
  onError: (err: unknown) => void;
  /** 无论成功失败都收尾（清 loading）；同样只在同一代时调用——过期代的 loading 由代的切换方（cleanup）统一清 */
  onSettled?: () => void;
}

/**
 * 跑一个异步任务，并按代际守卫丢弃过期落地（use-mcp-health 的 probe 用）：
 * - 没有存活代（面板没开 / 已卸载）：任务都不启动；
 * - 落地时代号已变（关闭 / 重开 / 卸载）：结果、错误、收尾一律丢弃，不动新一代的状态。
 */
export const runGuardedTask = async <T>(
  guard: GenerationGuard,
  task: () => Promise<T>,
  handlers: GuardedTaskHandlers<T>,
): Promise<void> => {
  const gen = guard.current();
  if (gen === 0) return;
  handlers.onStart?.();
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await task() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (!guard.isCurrent(gen)) return;
  try {
    if (outcome.ok) handlers.onResult(outcome.value);
    else handlers.onError(outcome.error);
  } finally {
    handlers.onSettled?.();
  }
};

/** 请求成功落地后对「对话框」该做什么 */
export type LandingAction =
  /** 仍是发起请求的那一代：照常关弹窗 */
  | "close"
  /** 弹窗已换了一代（关了又开 / 同一实例换了任务）：不能关新开的框，但结果会改变展示内容，要刷新 */
  | "refresh"
  /** 弹窗已关：下次打开本来就会重新拉状态，什么都不用做 */
  | "none";

/**
 * 弹窗里的请求成功后决定怎么收尾（requirement-group-dialog 用）。
 * toast / 上抛 onTaskUpdate 不走这里——结果无论落在哪一代都要照常落地。
 *
 * @param gen 发起请求时 `guard.current()` 的值
 */
export const resolveLanding = (guard: GenerationGuard, gen: number): LandingAction => {
  if (guard.isCurrent(gen)) return "close";
  return guard.current() !== 0 ? "refresh" : "none";
};

/** 请求失败后，错误 / 引导（内联状态）该怎么落 */
export type FailureLanding =
  /** 仍是发起请求的那一代：用户正盯着这次请求的弹窗，照常写内联错误 / 引导 */
  | "inline"
  /**
   * 弹窗已换代（关了又开 / 同一实例换了任务）、已关或已卸载：内联状态属于别的上下文，**不能写**——
   * 否则任务 A 的 rebuild 引导 / 错误会带进任务 B 的弹窗。失败本身仍要让用户知道，改走 toast 兜底
   * （与成功分支同口径：toast 不论落在哪一代都照常，只有「改弹窗内容」受守卫）。
   */
  | "toast";

/**
 * 弹窗里的请求**失败**后决定内联状态写不写（requirement-group-dialog 的 landFailure 用）。
 * 成功路径看 {@link resolveLanding}；两者都认「发起时的 gen 是否仍是当前代」，口径一致。
 *
 * @param gen 发起请求时 `guard.current()` 的值（必须在任何 await 之前取，见 requirement-group-dialog）
 */
export const resolveFailureLanding = (guard: GenerationGuard, gen: number): FailureLanding =>
  guard.isCurrent(gen) ? "inline" : "toast";
