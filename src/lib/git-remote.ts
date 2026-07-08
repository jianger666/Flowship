/**
 * Git remote URL 解析（纯函数、client / server 共用）
 *
 * 与 action-ship.md / submit-mr-guard 的 sed 规则对齐。
 */

/** git@host:group/repo.git 或 https://host/group/repo.git → group/repo */
export const parseProjectPathFromRemoteUrl = (url: string): string | null => {
  const projectPath = url
    .replace(/^[^@]+@[^:]+:/, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\.git$/, "")
    .trim();
  return projectPath.length > 0 ? projectPath : null;
};

/** remote URL → GitLab host（不带协议），解析失败返 null */
export const parseHostFromRemoteUrl = (url: string): string | null => {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const sshMatch = trimmed.match(/^[^@]+@([^:/]+)(?::|\/)/);
  if (sshMatch?.[1]) return sshMatch[1];

  try {
    const normalized = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const parsed = new URL(normalized);
    return parsed.hostname || null;
  } catch {
    return null;
  }
};
