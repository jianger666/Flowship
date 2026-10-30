/**
 * Git remote URL 解析（纯函数、client / server 共用）
 *
 * 与 action-ship.md / submit-mr-guard 的 sed 规则对齐。
 * 支持三种常见形态：ssh://、scp（git@host:path）、http(s)。
 *
 * 解析顺序（R14 Q21-03）：**先看有没有 `scheme://`**——带 scheme 的一律按 URL 解析，
 * 只有不带 scheme 的才可能是 scp 写法 `[user@]host:path`。旧实现把 scp 正则放在 URL 解析之前，
 * 而 `[^@]+` 能吞掉 `/`：`https://gitlab.corp.com/group/a@b/repo.git` 的 host 被读成 `b`、
 * `https://gitlab.corp.com#@evil.com/…` 读成 `evil.com`（都与 `new URL` 的真实 host 相反）；
 * `HTTPS://`（大写 scheme）的项目路径把整串 URL 原样返回；尾点 / 大小写不同的同一个 host 被当成两个 GitLab 实例。
 * 这里的 host 只是「origin 声称的 host」，出站前一律还要过 `assertTrustedGitHost`（见 gitlab-host.ts），
 * 所以这些解析错误不会把 PAT 送到别处，只会误拒 / 误报——但它仍然要和 `new URL` 的真实 host 一致。
 * 返回的 host 一律小写、去尾点；端口不带（既有取舍，HANDOFF 已声明）。
 */

const stripGitSuffix = (path: string): string => path.replace(/\.git$/, "").trim();

/** 带 `scheme://` 的 URL（ssh:// / https:// / git:// / file:// …）；scheme 大小写不敏感 */
const SCHEME_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * scp 写法 `[user@]host:path`（host 可以是方括号包起来的 IPv6，如 `git@[::1]:g/p.git`）。
 * - user 部分不许含 `/`：否则 `https://h/g/a@b/r` 里的 `@` 会被当成 `user@host` 的分隔；
 * - `host:` 后紧跟 `//` 的是带 scheme 的 URL、不算 scp（SCHEME_URL_RE 已先挡掉，这里是第二道）。
 */
const SCP_RE = /^(?:[^@/\s]+@)?(\[[^\]\s]+\]|[^:/\s@]+):(?!\/\/)(.*)$/;

const matchScp = (s: string): { host: string; path: string } | null => {
  const m = s.match(SCP_RE);
  if (!m) return null;
  const host = m[1]!;
  // 单个字母 + 冒号是 Windows 盘符（`C:\repo`、`C:/repo`），git 自己也按本地路径处理，不是 scp
  if (/^[a-z]$/i.test(host)) return null;
  return { host, path: m[2]! };
};

/** host 统一小写、去尾点（FQDN 写法 `gitlab.corp.com.`）：URL 解析对 ssh:// 这类非特殊 scheme 不会小写，也都不会去尾点 */
const normalizeHostName = (host: string): string =>
  host.toLowerCase().replace(/\.+$/, "");

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

  // http(s)://host/group/repo.git（scheme 大小写不敏感：旧实现 test 带 i、replace 不带 i，`HTTPS://…` 会把整串 URL 当项目路径）
  if (/^https?:\/\//i.test(trimmed)) {
    const projectPath = stripGitSuffix(
      trimmed.replace(/^https?:\/\/[^/]+\//i, ""),
    );
    return projectPath.length > 0 ? projectPath : null;
  }

  // 其余带 scheme 的（file:// / git:// …）不是我们认的形态——必须在 scp 之前挡掉，别让它们落进下面的 scp 分支
  if (SCHEME_URL_RE.test(trimmed)) return null;

  // scp 形态：[user@]host:group/repo.git（支持 [IPv6]；盘符 `C:\x` 不算）
  const scp = matchScp(trimmed);
  if (scp?.path) {
    const projectPath = stripGitSuffix(scp.path);
    return projectPath.length > 0 ? projectPath : null;
  }

  return null;
};

/** remote URL → GitLab host（小写、去尾点、不带协议 / 端口），解析失败返 null */
export const parseHostFromRemoteUrl = (url: string): string | null => {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // 带 scheme 的一律按 URL 解析：ssh:// 带端口时不会把 host:port 拼错，file:// 没有 host → null
  if (SCHEME_URL_RE.test(trimmed)) {
    try {
      const hostname = new URL(trimmed).hostname;
      return hostname ? normalizeHostName(hostname) : null;
    } catch {
      return null;
    }
  }

  // 不带 scheme：scp 写法 [user@]host:path（host 不含端口）
  const scp = matchScp(trimmed);
  if (scp) return normalizeHostName(scp.host);

  // 其余（`host/path`、`user@host/path`、裸域名）补 https:// 当 URL 解析
  try {
    const hostname = new URL(`https://${trimmed}`).hostname;
    return hostname ? normalizeHostName(hostname) : null;
  } catch {
    return null;
  }
};
