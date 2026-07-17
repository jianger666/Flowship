/**
 * Git remote URL 解析（纯函数、client / server 共用）
 *
 * 与 action-ship.md / submit-mr-guard 的 sed 规则对齐。
 * 支持三种常见形态：ssh://、scp（git@host:path）、http(s)。
 */

const stripGitSuffix = (path: string): string => path.replace(/\.git$/, "").trim();

/** git@host:group/repo.git / ssh://git@host[:port]/group/repo.git / https://host/group/repo.git → group/repo */
export const parseProjectPathFromRemoteUrl = (url: string): string | null => {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // ssh://user@host[:port]/path —— 旧逻辑会把 :port 当路径前缀、或残留整段 ssh://…（审查实测）
  if (/^ssh:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      // URL.pathname 带前导 /，GitLab project path 不要
      const projectPath = stripGitSuffix(parsed.pathname.replace(/^\//, ""));
      return projectPath.length > 0 ? projectPath : null;
    } catch {
      return null;
    }
  }

  // scp 形态：git@host:group/repo.git（注意不能误伤 https:// 里的 :）
  const scpMatch = trimmed.match(/^[^@/\s]+@[^:/\s]+:(.+)$/);
  if (scpMatch?.[1]) {
    const projectPath = stripGitSuffix(scpMatch[1]);
    return projectPath.length > 0 ? projectPath : null;
  }

  // http(s)://host/group/repo.git
  if (/^https?:\/\//i.test(trimmed)) {
    const projectPath = stripGitSuffix(
      trimmed.replace(/^https?:\/\/[^/]+\//, ""),
    );
    return projectPath.length > 0 ? projectPath : null;
  }

  return null;
};

/** remote URL → GitLab host（不带协议 / 端口），解析失败返 null */
export const parseHostFromRemoteUrl = (url: string): string | null => {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // ssh:// 走 URL 解析，避免带端口时把 host:port 拼错
  if (/^ssh:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname || null;
    } catch {
      return null;
    }
  }

  // scp：git@host:path → host（[^:/]+ 天然不含端口）
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
