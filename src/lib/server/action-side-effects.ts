/**
 * R28-4 / R29-C / R29-P2c：per-action in-flight side effect 登记（同 action 并发屏障）。
 *
 * 背景：action lease（R27-4）能拒历史 action，但协调不了同一 current/running
 * action 上并行的 MCP 调用——`submit_mr` 的 GitLab create/poll 可长时间 pending，
 * 同 caller 并行 `submit_work` 会立刻启 post-check，读到空的 sideEffects.mrs
 * 后把 action 切 awaiting_ack，随后 createMR 只能 skipped_local（外部 MR 孤儿）。
 *
 * 与 resource-jobs 同形：globalThis Map、独立小模块，避免 task-runner ↔ task-fs 环。
 *
 * 屏障语义（R29-C）：submit_work **等待** 在飞 submit_mr 结束再启 check；
 * 超时 fail-closed（拒启 check、工具错误让 agent 稍后重试 submit_work），
 * 不 abort、不 warn 后继续。deadline ~200s = GitLab FETCH_TIMEOUT×poll 总和 + 余量。
 * 反向：同 (taskId, actionId, kind) 已在飞 → begin 返 false（互斥）；
 * post-check 在飞则工具错误拒入、不 abort check。
 */

export type ActionSideEffectKind = "submit_mr";

const ACTION_SIDE_EFFECTS_GLOBAL_KEY = "__feAiFlowActionSideEffectsV1__";

/**
 * R29-C：与 gitlab-client FETCH_TIMEOUT_MS(30s) × getMRMergeStatus maxPolls(5)
 * + createMR 一次 fetch + closeOpenMR 余量对齐 → ~200s。
 */
export const ACTION_SIDE_EFFECT_WAIT_MS = 200_000;

type SideEffectEntry = {
  /** 同 kind 互斥后通常为 1；保留计数便于对称 end */
  count: number;
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

/**
 * R29-P2c：进入外部副作用段前登记。
 * 同 (taskId, actionId, kind) 已在飞 → 返 false（互斥拒入）；成功登记返 true。
 * 须在第一个不可逆 await 前同步调用。
 */
export const beginActionSideEffect = (
  taskId: string,
  actionId: string,
  kind: ActionSideEffectKind,
): boolean => {
  const m = getMap();
  const k = keyOf(taskId, actionId);
  const cur = m.get(k);
  if (cur && cur.kind === kind) {
    // 同 kind 在飞——互斥，不叠计数
    return false;
  }
  if (cur) {
    m.set(k, { count: cur.count + 1, kind });
  } else {
    m.set(k, { count: 1, kind });
  }
  return true;
};

/** 副作用段结束 -1；归零删键（kind 仅对称 begin 签名、计数按 action 聚合） */
export const endActionSideEffect = (
  taskId: string,
  actionId: string,
  kind?: ActionSideEffectKind,
): void => {
  void kind;
  const m = getMap();
  const k = keyOf(taskId, actionId);
  const cur = m.get(k);
  if (!cur) return;
  const n = cur.count - 1;
  if (n <= 0) m.delete(k);
  else m.set(k, { count: n, kind: cur.kind });
};

/** 该 action 是否仍有在飞的 side effect（submit_work 屏障查询） */
export const hasActionSideEffect = (
  taskId: string,
  actionId: string,
): boolean => (getMap().get(keyOf(taskId, actionId))?.count ?? 0) > 0;

/**
 * R28-4 / R29-C：等待同 action 在飞 side effect 结束。
 * @returns `"cleared"` 已清空；`"timeout"` 超时（调用方须 fail-closed 拒启 check）
 */
export const waitForActionSideEffectClear = async (
  taskId: string,
  actionId: string,
  opts?: { deadlineMs?: number; pollMs?: number },
): Promise<"cleared" | "timeout"> => {
  // R29-C：测试可经 globalThis 压短 deadline（避免单测真等 200s）
  const testOverride = (
    globalThis as unknown as { __feAiFlowActionSideEffectWaitMs?: number }
  ).__feAiFlowActionSideEffectWaitMs;
  const deadlineMs =
    opts?.deadlineMs ?? testOverride ?? ACTION_SIDE_EFFECT_WAIT_MS;
  const pollMs = opts?.pollMs ?? 50;
  const deadline = Date.now() + deadlineMs;
  while (hasActionSideEffect(taskId, actionId)) {
    if (Date.now() >= deadline) {
      console.warn(
        `[action-side-effects] R29-C：等待 submit_mr 结束超时 task=${taskId} action=${actionId}、fail-closed 拒启 post-check`,
      );
      return "timeout";
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
  return "cleared";
};

/** 测试 / 异常清理：强制清零某 action 的 side effect 登记 */
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
