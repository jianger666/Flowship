/**
 * R28-4：per-action in-flight side effect 登记（同 action 并发屏障）。
 *
 * 背景：action lease（R27-4）能拒历史 action，但协调不了同一 current/running
 * action 上并行的 MCP 调用——`submit_mr` 的 GitLab create/poll 可长时间 pending，
 * 同 caller 并行 `submit_work` 会立刻启 post-check，读到空的 sideEffects.mrs
 * 后把 action 切 awaiting_ack，随后 createMR 只能 skipped_local（外部 MR 孤儿）。
 *
 * 与 resource-jobs 同形：globalThis Map、独立小模块，避免 task-runner ↔ task-fs 环。
 * 屏障语义选择（R28-4）：submit_work **等待** 在飞 submit_mr 结束再启 check
 * （轮询 deadline ~120s、与 createMR/poll 上限对齐；超时 warn 后按现状启动），
 * 不打断 agent 流；反向 submit_mr 入场若 post-check 在飞则工具错误拒入、不 abort check。
 */

export type ActionSideEffectKind = "submit_mr";

const ACTION_SIDE_EFFECTS_GLOBAL_KEY = "__feAiFlowActionSideEffectsV1__";

type SideEffectEntry = {
  /** 引用计数（同 action 可叠多层，目前只有 submit_mr） */
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

/** 进入外部副作用段前 +1（须在第一个不可逆 await 前同步调用） */
export const beginActionSideEffect = (
  taskId: string,
  actionId: string,
  kind: ActionSideEffectKind,
): void => {
  const m = getMap();
  const k = keyOf(taskId, actionId);
  const cur = m.get(k);
  if (cur) {
    m.set(k, { count: cur.count + 1, kind });
  } else {
    m.set(k, { count: 1, kind });
  }
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
 * R28-4：等待同 action 在飞 side effect 结束。
 * @returns `"cleared"` 已清空；`"timeout"` 超时（调用方按现状继续、已 console.warn）
 */
export const waitForActionSideEffectClear = async (
  taskId: string,
  actionId: string,
  opts?: { deadlineMs?: number; pollMs?: number },
): Promise<"cleared" | "timeout"> => {
  // 与 createMR + getMRMergeStatus poll 上限对齐（~120s）
  const deadlineMs = opts?.deadlineMs ?? 120_000;
  const pollMs = opts?.pollMs ?? 50;
  const deadline = Date.now() + deadlineMs;
  while (hasActionSideEffect(taskId, actionId)) {
    if (Date.now() >= deadline) {
      console.warn(
        `[action-side-effects] R28-4：等待 submit_mr 结束超时 task=${taskId} action=${actionId}、按现状启动 post-check`,
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
