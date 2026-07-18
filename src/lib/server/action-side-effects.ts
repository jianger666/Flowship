/**
 * R28-4 / R29-1：per-action 副作用单一 claim 状态机。
 *
 * 背景：旧实现把 MR side-effect（本 Map）与 post-check（task-stream.runningChecks）
 * 拆成两张表互相「先查再登记」——`waitForActionSideEffectClear` 返回后到
 * `runActionPostCheck` 挂 runningChecks 之间有空窗，并发 submit_mr 可抢入，
 * 两类副作用同时飞（验收 R29-1）。
 *
 * R29-1 收口：同一 action 上 MR / post-check 共用一张 claim 表，
 * `tryClaimSideEffect(..., "mr")` 与 `waitAndClaimPostCheck` 在同步提交点互斥。
 * runningChecks 仍只表示 check 执行态，不再充当 submit_mr 准入判据。
 *
 * 屏障语义：submit_work **等待** mr claim 清空后、同一同步 tick 内 claim postcheck；
 * 超时 fail-closed（拒启 check、工具 busy 让 agent 稍后重试）。
 */

/** R29-1：单一 claim 的两种互斥 kind */
export type ActionSideEffectKind = "mr" | "postcheck";

const ACTION_SIDE_EFFECTS_GLOBAL_KEY = "__feAiFlowActionSideEffectsV2__";

/**
 * R29-C：与 gitlab-client FETCH_TIMEOUT_MS(30s) × getMRMergeStatus maxPolls(5)
 * + createMR 一次 fetch + closeOpenMR 余量对齐 → ~200s。
 */
export const ACTION_SIDE_EFFECT_WAIT_MS = 200_000;

type SideEffectEntry = {
  kind: ActionSideEffectKind;
};

const getMap = (): Map<string, SideEffectEntry> => {
  const g = globalThis as unknown as Record<
    string,
    Map<string, SideEffectEntry> | undefined
  >;
  if (!g[ACTION_SIDE_EFFECTS_GLOBAL_KEY]) {
    g[ACTION_SIDE_EFFECTS_GLOBAL_KEY] = new Map();
  }
  return g[ACTION_SIDE_EFFECTS_GLOBAL_KEY]!;
};

const keyOf = (taskId: string, actionId: string): string =>
  `${taskId}\0${actionId}`;

/** 该 action 是否仍有任意 kind 的 claim（测试 / 观测） */
export const hasActionSideEffect = (
  taskId: string,
  actionId: string,
): boolean => getMap().has(keyOf(taskId, actionId));

/** 读当前 claim kind（测试用；无 claim 返 undefined） */
export const getActionSideEffectKind = (
  taskId: string,
  actionId: string,
): ActionSideEffectKind | undefined =>
  getMap().get(keyOf(taskId, actionId))?.kind;

/**
 * R29-1：同步原子 claim MR 副作用。
 * 已有任何 claim（mr 或 postcheck）→ false；成功登记返 true。
 * 须在第一个不可逆 await 前同步调用。
 */
export const tryClaimSideEffect = (
  taskId: string,
  actionId: string,
  kind: "mr",
): boolean => {
  void kind; // 签名固定 "mr"；postcheck 只走 waitAndClaimPostCheck
  const m = getMap();
  const k = keyOf(taskId, actionId);
  if (m.has(k)) return false;
  m.set(k, { kind: "mr" });
  return true;
};

/**
 * R29-1：匹配才删——防错放其它 kind / 已被顶替者的 claim。
 */
export const releaseSideEffect = (
  taskId: string,
  actionId: string,
  kind: ActionSideEffectKind,
): void => {
  const m = getMap();
  const k = keyOf(taskId, actionId);
  const cur = m.get(k);
  if (!cur || cur.kind !== kind) return;
  m.delete(k);
};

export type WaitAndClaimPostCheckResult = "claimed" | "timeout" | "invalid";

export type WaitAndClaimPostCheckOpts = {
  deadlineMs?: number;
  pollMs?: number;
  /**
   * R29-1：等待中每轮验 caller / action lease；失效返 invalid（不 claim）。
   * 支持 sync / async。
   */
  stillValid?: () => boolean | Promise<boolean>;
};

/**
 * R29-1：等待 mr claim 清空后、同一同步 tick 内 claim postcheck（零 await 空窗）。
 *
 * - 无 claim → 立即 claim postcheck
 * - 已是 postcheck（同 action 重交卷）→ 视为 claimed（交给 runActionPostCheck 顶替）
 * - 持有 mr → 轮询等待；清空后同 tick claim
 * - stillValid 失效 → invalid；超时 → timeout（fail-closed）
 */
export const waitAndClaimPostCheck = async (
  taskId: string,
  actionId: string,
  opts?: WaitAndClaimPostCheckOpts,
): Promise<WaitAndClaimPostCheckResult> => {
  // R29-C：测试可经 globalThis 压短 deadline（避免单测真等 200s）
  const testOverride = (
    globalThis as unknown as { __feAiFlowActionSideEffectWaitMs?: number }
  ).__feAiFlowActionSideEffectWaitMs;
  const deadlineMs =
    opts?.deadlineMs ?? testOverride ?? ACTION_SIDE_EFFECT_WAIT_MS;
  const pollMs = opts?.pollMs ?? 50;
  const deadline = Date.now() + deadlineMs;
  const stillValid = opts?.stillValid ?? (() => true);

  while (true) {
    // 等待中每轮验 lease（可 await）；失效不 claim
    if (!(await stillValid())) return "invalid";

    // R29-1：观察与 claim 同一同步段——中间零 await（关 check→register 空窗）
    const m = getMap();
    const k = keyOf(taskId, actionId);
    const cur = m.get(k);
    if (!cur) {
      m.set(k, { kind: "postcheck" });
      return "claimed";
    }
    if (cur.kind === "postcheck") {
      // 同 action 重交卷：claim 已在、交给 runActionPostCheck 顶替旧 check
      return "claimed";
    }
    // cur.kind === "mr" → 继续等

    if (Date.now() >= deadline) {
      console.warn(
        `[action-side-effects] R29-1：等待 mr claim 结束超时 task=${taskId} action=${actionId}、fail-closed 拒启 post-check`,
      );
      return "timeout";
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
};

/** stop / DELETE：强制清零某 task（或单 action）的全部 claim */
export const clearActionSideEffects = (
  taskId: string,
  actionId?: string,
): void => {
  const m = getMap();
  if (actionId !== undefined) {
    m.delete(keyOf(taskId, actionId));
    return;
  }
  for (const k of [...m.keys()]) {
    if (k.startsWith(`${taskId}\0`)) m.delete(k);
  }
};
