/**
 * R28-4 / R29-1 / R30-1：per-action 副作用单一 claim 状态机（唯一 token）。
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
 * R30-1：entry 带进程单调 claimId；claim API 返回不可复用的 ClaimHandle；
 * release / 旧 check dropSelf 只按精确 claimId 删——关闭「同 kind ABA 误放新 owner」。
 * 已有 postcheck 时不再无条件返 claimed：同步段内 abort 旧 check + 换 token。
 *
 * 屏障语义：submit_work **等待** mr claim 清空后、同一同步 tick 内 claim postcheck；
 * 超时 fail-closed（拒启 check、工具 busy 让 agent 稍后重试）。
 */

/** R29-1：单一 claim 的两种互斥 kind */
export type ActionSideEffectKind = "mr" | "postcheck";

/**
 * R30-1：不可复用的 claim 身份——release 必须带本 handle，旧 owner 放不掉新 owner。
 */
export type ClaimHandle = {
  claimId: number;
  kind: ActionSideEffectKind;
  taskId: string;
  actionId: string;
};

const ACTION_SIDE_EFFECTS_GLOBAL_KEY = "__feAiFlowActionSideEffectsV3__";
const CLAIM_SEQ_GLOBAL_KEY = "__feAiFlowActionSideEffectClaimSeq__";

/**
 * R29-C：与 gitlab-client FETCH_TIMEOUT_MS(30s) × getMRMergeStatus maxPolls(5)
 * + createMR 一次 fetch + closeOpenMR 余量对齐 → ~200s。
 */
export const ACTION_SIDE_EFFECT_WAIT_MS = 200_000;

type SideEffectEntry = {
  kind: ActionSideEffectKind;
  /** R30-1：进程内单调发号，release 精确匹配 */
  claimId: number;
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

/** R30-1：进程单调 claimId（挂 globalThis，dev HMR 不重置到与旧 handle 冲突） */
const allocClaimId = (): number => {
  const g = globalThis as unknown as Record<string, number | undefined>;
  const next = (g[CLAIM_SEQ_GLOBAL_KEY] ?? 0) + 1;
  g[CLAIM_SEQ_GLOBAL_KEY] = next;
  return next;
};

const keyOf = (taskId: string, actionId: string): string =>
  `${taskId}\0${actionId}`;

const makeHandle = (
  taskId: string,
  actionId: string,
  kind: ActionSideEffectKind,
  claimId: number,
): ClaimHandle => ({ claimId, kind, taskId, actionId });

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

/** R30-1：读当前 claimId（测试断言换 token / ABA） */
export const getActionSideEffectClaimId = (
  taskId: string,
  actionId: string,
): number | undefined => getMap().get(keyOf(taskId, actionId))?.claimId;

/**
 * R29-1 / R30-1：同步原子 claim MR 副作用。
 * 已有任何 claim（mr 或 postcheck）→ null（调用方可读 getActionSideEffectKind）；
 * 成功登记返 ClaimHandle。须在第一个不可逆 await 前同步调用。
 */
export const tryClaimSideEffect = (
  taskId: string,
  actionId: string,
  kind: "mr",
): ClaimHandle | null => {
  void kind; // 签名固定 "mr"；postcheck 只走 waitAndClaimPostCheck
  const m = getMap();
  const k = keyOf(taskId, actionId);
  if (m.has(k)) return null;
  const claimId = allocClaimId();
  m.set(k, { kind: "mr", claimId });
  return makeHandle(taskId, actionId, "mr", claimId);
};

/**
 * R30-1：仅当 map 上仍是本 handle（精确 claimId）才删。
 * 旧 owner 的迟到 finally / dropSelf 匹配不到新 token → ABA 关闭。
 */
export const releaseSideEffect = (handle: ClaimHandle): void => {
  const m = getMap();
  const k = keyOf(handle.taskId, handle.actionId);
  const cur = m.get(k);
  if (!cur || cur.claimId !== handle.claimId) return;
  m.delete(k);
};

export type WaitAndClaimPostCheckOpts = {
  deadlineMs?: number;
  pollMs?: number;
  /**
   * R29-1：等待中每轮验 caller / action lease；失效返 invalid（不 claim）。
   * 支持 sync / async。
   */
  stillValid?: () => boolean | Promise<boolean>;
  /**
   * R30-1：已有 postcheck 时、换 token 前的同步回调（零 await）。
   * 调用方应 abort 旧 check、从 runningChecks 摘除（旧 dropSelf 变 no-op），
   * **不要** release claim——本函数随即换成新 claimId。
   */
  onReplacePostCheck?: () => void;
};

export type WaitAndClaimPostCheckResult =
  | { result: "claimed"; handle: ClaimHandle }
  | { result: "timeout" }
  | { result: "invalid" };

/**
 * R29-1 / R30-1：等待 mr claim 清空后、同一同步 tick 内 claim postcheck（零 await 空窗）。
 *
 * - 无 claim → 立即 claim postcheck，返新 handle
 * - 已是 postcheck（同 action 重交卷）→ 同步段 abort 旧 check + **换 token**，返新 handle
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
    if (!(await stillValid())) return { result: "invalid" };

    // R29-1 / R30-1：观察与 claim / 换 token 同一同步段——中间零 await
    const m = getMap();
    const k = keyOf(taskId, actionId);
    const cur = m.get(k);
    if (!cur) {
      const claimId = allocClaimId();
      m.set(k, { kind: "postcheck", claimId });
      return {
        result: "claimed",
        handle: makeHandle(taskId, actionId, "postcheck", claimId),
      };
    }
    if (cur.kind === "postcheck") {
      // R30-1：重交卷——同步 coordinator：abort 旧 check + 立即换 token
      // （不再把「已有 postcheck」无条件当 claimed 共享身份）
      opts?.onReplacePostCheck?.();
      const claimId = allocClaimId();
      m.set(k, { kind: "postcheck", claimId });
      return {
        result: "claimed",
        handle: makeHandle(taskId, actionId, "postcheck", claimId),
      };
    }
    // cur.kind === "mr" → 继续等

    if (Date.now() >= deadline) {
      console.warn(
        `[action-side-effects] R29-1：等待 mr claim 结束超时 task=${taskId} action=${actionId}、fail-closed 拒启 post-check`,
      );
      return { result: "timeout" };
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
};

/**
 * stop / DELETE：强制清零某 task（或单 action）的全部 claim。
 * R30-1：clear 是终态 owner——之后旧 handle 的 release 匹配不到，天然 no-op。
 */
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
