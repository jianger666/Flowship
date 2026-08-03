import type { Task } from "./types";

/** 测试角色的任务语义跟任务快照走，不读取当前全局设置。 */
export const isTestingTask = (
  task: Pick<Task, "workRole">,
): boolean => task.workRole === "qa";

/** 只有需求型测试任务需要「被测业务分支」；测试角色的日常任务不进入这套流程。 */
export const isTestingRequirementTask = (
  task: Pick<Task, "workRole" | "feishuStoryUrl">,
): boolean =>
  isTestingTask(task) && !!task.feishuStoryUrl?.trim();

/**
 * 测试任务里还没指定被测业务分支的 git 仓库。非 git 目录没有分支概念，不计入。
 */
export const testingTaskMissingBranchRepoPaths = (
  task: Pick<
    Task,
    | "workRole"
    | "feishuStoryUrl"
    | "repoPaths"
    | "nonGitRepoPaths"
    | "repoFeatureBranches"
  >,
): string[] => {
  if (!isTestingRequirementTask(task)) return [];
  const nonGit = new Set(task.nonGitRepoPaths ?? []);
  return task.repoPaths.filter(
    (repoPath) =>
      !nonGit.has(repoPath) &&
      !(task.repoFeatureBranches?.[repoPath]?.trim() ?? ""),
  );
};

/** 测试任务中已明确配置被测业务分支的 git 仓库。 */
export const testingTaskConfiguredBranchRepoPaths = (
  task: Pick<
    Task,
    | "workRole"
    | "feishuStoryUrl"
    | "repoPaths"
    | "nonGitRepoPaths"
    | "repoFeatureBranches"
  >,
): string[] => {
  if (!isTestingRequirementTask(task)) return [];
  const nonGit = new Set(task.nonGitRepoPaths ?? []);
  return task.repoPaths.filter(
    (repoPath) =>
      !nonGit.has(repoPath) &&
      !!task.repoFeatureBranches?.[repoPath]?.trim(),
  );
};
