/**
 * 「改bug」预置是否可用——纯判定谓词
 *
 * 客户端检查（`launchFixBugAdvance`）与 server 重建（`reinstallBuiltinFixBugPreset`）
 * **必须用同一套口径**，避免「一边说缺、一边觉得在」的死循环。
 *
 * 口径（四条全满足才可用）：
 * 1. action `builtin-fix-bug` 存在
 * 2. 非 legacyPlaybook
 * 3. skill 挂载非空
 * 4. **实际挂载的** skill 名在可见列表里（挂用户自定义 skill 也算可用）
 *
 * 注意：不硬编码要求挂载名必须是 `fix-bug`——同事把挂载换成自己的 skill 是合法诉求。
 */

import {
  BUILTIN_FIX_BUG_ACTION_ID,
} from "@/lib/mr-inbox";

/** 判定用的 action 快照（前后端 / 单测共用、不绑完整 CustomActionDef） */
export type FixBugPresetActionSnap = {
  id: string;
  skill: string;
  legacyPlaybook?: string;
};

/**
 * 预置是否处于「可推进」状态。
 * @see launchFixBugAdvance（客户端）
 * @see reinstallBuiltinFixBugPreset（重建：不满足则写出厂壳）
 */
export const isFixBugPresetUsable = (opts: {
  action: FixBugPresetActionSnap | null | undefined;
  /** 可见 skill 名集合（含 disabled——关掉 ≠ 删掉、不触发重建） */
  visibleSkillNames: Iterable<string>;
}): boolean => {
  const { action, visibleSkillNames } = opts;
  if (!action || action.id !== BUILTIN_FIX_BUG_ACTION_ID) return false;
  if (action.legacyPlaybook) return false;
  const mounted = action.skill?.trim();
  if (!mounted) return false;
  const names =
    visibleSkillNames instanceof Set
      ? visibleSkillNames
      : new Set(visibleSkillNames);
  return names.has(mounted);
};
