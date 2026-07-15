/**
 * 收件箱「改bug」预置检查（2026-07-15：不再直接 POST advance）
 *
 * 职责收窄为：查预置「改bug」action 是否可用 + 用户确认后重装出厂预置。
 * 真正推进改走任务页深链 `?advance=fix-bug&…` → 打开推进弹窗预选「改bug」、用户确认后启动。
 *
 * 可用判定与 server `reinstallBuiltinFixBugPreset` 共用 `isFixBugPresetUsable`
 *（看实际挂载 skill、不硬编码要求 name=fix-bug）。
 */

import { fetchCustomActions } from "./custom-action-client";
import { isFixBugPresetUsable } from "./fix-bug-preset-usable";
import { BUILTIN_FIX_BUG_ACTION_ID } from "./mr-inbox";

/** 预置可用性：usable 可预选推进；missing 需 confirm 重建 */
export type FixBugPresetStatus = "usable" | "missing";

/**
 * 用户确认后重装出厂「改bug」预置（skill + action）。
 * 失败 throw，调用方 toast。
 */
export const reinstallFixBugPreset = async (): Promise<void> => {
  const res = await fetch("/api/custom-actions/fix-bug-preset", {
    method: "POST",
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 无 body / 非 JSON
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `重建预置失败（HTTP ${res.status}）`;
    throw new Error(msg);
  }
};

/**
 * 查「改bug」预置是否可用（action 存在 + 挂载 skill 可见）。
 * 入口在跳深链前调用——预选的 action 得在列表里才有意义。
 */
export const checkFixBugPreset = async (): Promise<FixBugPresetStatus> => {
  const [defs, skillRes] = await Promise.all([
    fetchCustomActions(),
    fetch("/api/skills"),
  ]);
  if (!skillRes.ok) {
    throw new Error(`拉取 skill 列表失败（HTTP ${skillRes.status}）`);
  }
  const skillBody = (await skillRes.json().catch(() => ({}))) as {
    skills?: Array<{ name?: string }>;
  };
  // 含 disabled：关掉 ≠ 删掉、不触发重建（与 findSkillByName 不滤 disabled 一致）
  const visibleSkillNames = Array.isArray(skillBody.skills)
    ? skillBody.skills
        .map((s) => s.name?.trim())
        .filter((n): n is string => !!n)
    : [];
  const preset = defs.find((d) => d.id === BUILTIN_FIX_BUG_ACTION_ID);
  if (
    !isFixBugPresetUsable({
      action: preset,
      visibleSkillNames,
    })
  ) {
    return "missing";
  }
  return "usable";
};
