/**
 * GitLab host 解析：settings 显式覆盖优先，否则从 task / 仓库 remote 自动推导
 */
import { deriveHostFromRepo } from "./submit-mr-guard";

export const resolveEffectiveGitHost = async (
  explicitHost: string | undefined,
  repoPaths: string[],
): Promise<string | null> => {
  const trimmed = explicitHost?.trim();
  if (trimmed) return trimmed;
  for (const repoPath of repoPaths) {
    const host = await deriveHostFromRepo(repoPath);
    if (host) return host;
  }
  return null;
};
