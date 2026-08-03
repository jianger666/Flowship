import type { UserRole } from "@/lib/types";

/** 测试角色以验证现有分支为主，不暴露也不创建隔离 worktree。 */
export const roleSupportsWorktree = (
  role: UserRole | undefined,
): boolean => role !== "qa";

export const resolveLaunchIsolateWorktree = ({
  role,
  forceOriginalRepo,
  runInRepo,
}: {
  role: UserRole | undefined;
  forceOriginalRepo: boolean;
  runInRepo: boolean;
}): boolean =>
  roleSupportsWorktree(role) && !forceOriginalRepo && !runInRepo;
