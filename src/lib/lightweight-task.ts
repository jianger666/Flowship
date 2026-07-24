/**
 * 日常轻量态（无飞书需求链接）——client / server 共用判定与文案。
 * 不加 schema 字段：只看 feishuStoryUrl 是否为空。
 */

/** 无飞书链接 = 日常轻量态 */
export const isLightweightDailyTask = (t: {
  feishuStoryUrl?: string;
}): boolean => !(t.feishuStoryUrl ?? "").trim();

/**
 * 注入任务上下文的完整声明（所有 action 共用一份、勿在 playbook 末尾再叠一句）。
 * 要点：原仓当前分支 / 改文件可直接做 / git 副作用先问用户 / 飞书步骤跳过并写产物。
 */
export const LIGHTWEIGHT_DAILY_PROMPT_DIRECTIVE =
  "本任务是日常任务（无关联飞书需求）：未建独立分支、直接工作在原仓当前分支。修改文件可以直接做；但 commit / push / 建分支等 git 副作用操作必须先询问用户确认。流程中需要飞书需求链接 / 状态机的步骤一律跳过并在产物中说明。";

/** super prompt 段：轻量态才非空；正式任务返空串（占位保留字面） */
export const renderLightweightDailySection = (t: {
  feishuStoryUrl?: string;
}): string => {
  if (!isLightweightDailyTask(t)) return "";
  return `> ${LIGHTWEIGHT_DAILY_PROMPT_DIRECTIVE}`;
};

/**
 * 推进弹窗：日常任务只保留「自定义」组（隐藏通用 / 团队 wk）。
 * 正式任务原样返回。
 */
export const filterAdvanceGroupsForDailyTask = <T extends { key: string }>(
  groups: readonly T[],
  task: { feishuStoryUrl?: string },
): T[] =>
  isLightweightDailyTask(task)
    ? groups.filter((g) => g.key === "custom")
    : [...groups];
