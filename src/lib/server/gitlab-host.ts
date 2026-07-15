/**
 * GitLab host 解析：一律按任务仓库 origin remote 现推（产品口径=单 GitLab 实例）。
 * 不再接受 settings 全局覆盖——历史 gitHost 字段已退役。
 */
import { deriveHostFromRepo } from "./submit-mr-guard";

/** 多仓 remote 推导出不同 host 时的统一报错文案（fail-fast） */
export const MULTI_GITLAB_HOST_ERROR = "多仓属于不同 GitLab 实例、暂不支持";

/**
 * 从已收集的 host 列表挑出唯一值。
 * - 全空 → null
 * - 多于一个不同 host → throw
 * - 恰好一个 → 返回该 host
 */
export const pickUnifiedGitHost = (
  hosts: Array<string | null | undefined>,
): string | null => {
  const unique = new Set<string>();
  for (const h of hosts) {
    const t = typeof h === "string" ? h.trim() : "";
    if (t) unique.add(t);
  }
  if (unique.size === 0) return null;
  if (unique.size > 1) {
    throw new Error(MULTI_GITLAB_HOST_ERROR);
  }
  return [...unique][0]!;
};

/**
 * 按任务 repoPaths 从各仓 origin remote 推导统一 GitLab host。
 * 推不出返 null；多仓分属不同实例则抛 MULTI_GITLAB_HOST_ERROR。
 */
export const resolveEffectiveGitHost = async (
  repoPaths: string[],
): Promise<string | null> => {
  const hosts: Array<string | null> = [];
  for (const repoPath of repoPaths) {
    hosts.push(await deriveHostFromRepo(repoPath));
  }
  return pickUnifiedGitHost(hosts);
};
