/**
 * 主流程选择与 UI 互斥（集中、可整体删除）
 *
 * 内置 plan/build/review 与 wk:* 九指令壳互斥：任务历史中最早出现的主流程 action 决定锁定哪套。
 * ship/dev/其它非主流程 custom 不参与锁定。禁用只接在前端推进面板，不做服务端 action 准入硬校验；
 * server 只复用同一判定选择普通/WK 工作区与 MR 源分支规则。
 */

import { isBuiltinAdvanceAction } from "./action-layout";
import { wkCommandForAction, wkCommandForSkill } from "./wk-command";
import type { ActionRecord, ActionType, CustomActionDef } from "./types";

/** 参与互斥锁定的内置主流程 action */
export const BUILTIN_PRIMARY_FLOW_TYPES = [
  "plan",
  "build",
  "review",
] as const satisfies readonly ActionType[];

export type BuiltinPrimaryFlowType = (typeof BUILTIN_PRIMARY_FLOW_TYPES)[number];

export type PrimaryFlowKind = "wk" | "legacy";

/** null = 尚无主流程、两套都可用 */
export type FlowLock = PrimaryFlowKind | null;

export const FLOW_MUTEX_WK_LOCK_REASON =
  "任务已走 wk 流程，内置 plan/build/review 不可用";

export const FLOW_MUTEX_LEGACY_LOCK_REASON =
  "任务已走内置流程，wk 流程不可用";

const BUILTIN_PRIMARY_SET = new Set<string>(BUILTIN_PRIMARY_FLOW_TYPES);

const isBuiltinPrimaryFlowType = (
  type: ActionType,
): type is BuiltinPrimaryFlowType => BUILTIN_PRIMARY_SET.has(type);

/** 派生 action id（app:/team:）→ skill 名；其它 id 返回 null */
export const skillNameFromDerivedActionId = (
  id: string | undefined,
): string | null => {
  if (!id) return null;
  if (id.startsWith("app:") || id.startsWith("team:")) {
    const name = id.slice(id.indexOf(":") + 1).trim();
    return name || null;
  }
  return null;
};

type ActionFlowPick = Pick<ActionRecord, "type" | "customActionId" | "n">;
type CustomDefPick = Pick<CustomActionDef, "skill" | "order">;

/**
 * 单条 action 是否属于主流程（wk 或 legacy）；非主流程返回 null。
 */
export const classifyPrimaryFlowAction = (
  action: Pick<ActionRecord, "type" | "customActionId">,
  customDefById?: ReadonlyMap<string, CustomDefPick>,
): PrimaryFlowKind | null => {
  if (isBuiltinPrimaryFlowType(action.type)) return "legacy";
  if (action.type !== "custom") return null;

  const def =
    action.customActionId != null
      ? customDefById?.get(action.customActionId)
      : undefined;
  if (def && wkCommandForAction(def)) return "wk";

  const skill =
    def?.skill?.trim() || skillNameFromDerivedActionId(action.customActionId);
  if (skill && wkCommandForSkill(skill)) return "wk";

  return null;
};

/** 按 action 序号 n 找历史中最早的主流程 action，决定锁定方向 */
export const resolveFlowLock = (
  actions: readonly ActionFlowPick[],
  customDefById?: ReadonlyMap<string, CustomDefPick>,
): FlowLock => {
  const sorted = [...actions].sort((a, b) => a.n - b.n);
  for (const action of sorted) {
    const kind = classifyPrimaryFlowAction(action, customDefById);
    if (kind) return kind;
  }
  return null;
};

export const flowMutexBuiltinDisabledReason = (
  type: BuiltinPrimaryFlowType,
  lock: FlowLock,
): string | null => {
  if (lock === "wk") return FLOW_MUTEX_WK_LOCK_REASON;
  return null;
};

export const flowMutexWkDisabledReason = (
  def: CustomDefPick | null | undefined,
  lock: FlowLock,
): string | null => {
  if (lock !== "legacy" || !def || !wkCommandForAction(def)) return null;
  return FLOW_MUTEX_LEGACY_LOCK_REASON;
};

/** 推进面板 action key 是否被主流程互斥禁用 */
export const isAdvanceKeyFlowMutexDisabled = (
  key: string,
  lock: FlowLock,
  customDefById: ReadonlyMap<string, CustomDefPick>,
): boolean => {
  if (isBuiltinAdvanceAction(key) && isBuiltinPrimaryFlowType(key)) {
    return flowMutexBuiltinDisabledReason(key, lock) !== null;
  }
  const def = customDefById.get(key);
  return flowMutexWkDisabledReason(def, lock) !== null;
};
