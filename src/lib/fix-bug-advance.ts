/**
 * 收件箱「改bug」直接推进（2026-07-14 用户拍板：点按钮即确认、不弹推进弹窗）
 *
 * 链路：查预置「改bug」action 可用（挂载 skill 可见）→ 拉全量 task → prepareRunArgs 校验 →
 * POST advance（actionType=custom + builtin-fix-bug + bug 上下文指令）。
 *
 * 三种非 started 出口：
 * - missing-preset：预置不可用 → 调用方 confirm 重建后再重试
 * - aborted：apiKey / model 校验失败（prepareRunArgs 内部已 toast）
 * - 其余错误直接 throw（调用方 toast）
 *
 * 可用判定与 server `reinstallBuiltinFixBugPreset` 共用 `isFixBugPresetUsable`
 *（看实际挂载 skill、不硬编码要求 name=fix-bug）。
 */

import { fetchCustomActions } from "./custom-action-client";
import { isFixBugPresetUsable } from "./fix-bug-preset-usable";
import { getSettings } from "./local-store";
import {
  BUILTIN_FIX_BUG_ACTION_ID,
  buildFixBugInstruction,
} from "./mr-inbox";
import { prepareRunArgs } from "./run-args";
import { fetchTask } from "./task-store";

export type FixBugLaunchResult =
  | { kind: "started" }
  | { kind: "missing-preset" }
  | { kind: "aborted" };

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

export const launchFixBugAdvance = async (
  taskId: string,
  bug: { bugTitle: string; bugUrl: string; storyName?: string },
): Promise<FixBugLaunchResult> => {
  // 1. 预置不可用 → missing-preset（与 server 重建同一套 isFixBugPresetUsable）
  // 看 action 实际挂载的 skill 是否可见——挂用户自定义 skill 也算可用，不硬编码 fix-bug
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
    return { kind: "missing-preset" };
  }

  // 2. 全量 task（要 actions 找上次用的模型；tail=1 不拉整卷 events）
  const task = await fetchTask(taskId, { tail: 1 });
  if (!task) throw new Error("任务不存在或已删除");

  // 3. apiKey / model 基线校验（失败内部已 toast、这里直接收手）
  const args = prepareRunArgs(task);
  if (!args) return { kind: "aborted" };

  // 模型优先级与推进弹窗一致：本 task 最近 action 实际用的 → task.model → settings 默认
  const lastUsedModel = [...task.actions]
    .reverse()
    .find((a) => a.agentModel?.id?.trim())?.agentModel;
  const model = lastUsedModel?.id?.trim() ? lastUsedModel : args.model;

  const settings = getSettings();
  // 设置页最新分支配置快照（与任务页 handleAdvance 同构、server 据此刷新 task 分支快照）
  const repoBaseBranches: Record<string, string> = {};
  const repoTestBranches: Record<string, string> = {};
  const repoDevBranches: Record<string, string> = {};
  for (const p of task.repoPaths) {
    const repo = settings.repos.find((r) => r.path === p);
    if (!repo) continue;
    const ob = repo.onlineBranch?.trim();
    if (ob) repoBaseBranches[p] = ob;
    const tb = repo.testBranch?.trim();
    if (tb) repoTestBranches[p] = tb;
    const db = repo.devBranch?.trim();
    if (db) repoDevBranches[p] = db;
  }

  const res = await fetch(`/api/tasks/${task.id}/advance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionType: "custom",
      customActionId: BUILTIN_FIX_BUG_ACTION_ID,
      userInstruction: buildFixBugInstruction(bug),
      apiKey: args.apiKey,
      model,
      // 按设置页偏好走默认（缺省 false = 起新 agent）、点按钮即确认不再进弹窗改
      reuseAgent: settings.reuseAgentDefault ?? false,
      gitToken: settings.gitToken?.trim() || undefined,
      repoBaseBranches:
        Object.keys(repoBaseBranches).length > 0 ? repoBaseBranches : undefined,
      repoTestBranches:
        Object.keys(repoTestBranches).length > 0 ? repoTestBranches : undefined,
      repoDevBranches:
        Object.keys(repoDevBranches).length > 0 ? repoDevBranches : undefined,
    }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(
      typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
    );
  }
  return { kind: "started" };
};
