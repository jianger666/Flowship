/**
 * GitLab host 解析：一律按任务仓库 origin remote 现推（产品口径=单 GitLab 实例）。
 * 不再接受 settings 全局覆盖——历史 gitHost 字段已退役（不要复活 UI 配置）。
 *
 * ⚠️ 这里推出来的 host 只是「仓库 origin 说它是谁」，origin 在 agent 可写的 `.git/config` 里、
 * 并不可信。PAT 真正出站前必须再过 `trusted-git-host.assertTrustedGitHost`（首次绑定固定 / 白名单）；
 * 本文件另提供在可信时机把推导结果固定下来的入口（pinTrustedGitHostFromRepoPaths / FromSettings）。
 */
import { deriveHostFromRepo } from "./submit-mr-guard";
import {
  hasTrustedGitHostRecord,
  pinTrustedGitHostIfAbsent,
  type PinResult,
  type PinSource,
} from "./trusted-git-host";

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
 * @param excludeRepoPaths 不参与推导的仓（如脚本仓——不 ship / 不提 MR、
 *   origin 常挂在别的 GitLab 实例，参与推导会误伤 fail-fast）
 */
export const resolveEffectiveGitHost = async (
  repoPaths: string[],
  excludeRepoPaths?: ReadonlyArray<string> | ReadonlySet<string>,
): Promise<string | null> => {
  const exclude = new Set(excludeRepoPaths ?? []);
  const hosts: Array<string | null> = [];
  for (const repoPath of repoPaths) {
    if (exclude.has(repoPath)) continue;
    hosts.push(await deriveHostFromRepo(repoPath));
  }
  return pickUnifiedGitHost(hosts);
};

/**
 * 在可信时机从一组仓库路径固定可信 GitLab host（task-runner / chat-runner 会话启动用）。
 * 永不抛：多仓分属不同实例、推不出 host、读 git 失败都只返回 null——固定是增强项，不能挡住会话启动。
 * 已有固定记录（含损坏）直接跳过，省掉 N 次 `git config` 子进程。
 */
export const pinTrustedGitHostFromRepoPaths = async (
  repoPaths: string[],
  source: PinSource,
  excludeRepoPaths?: ReadonlyArray<string> | ReadonlySet<string>,
): Promise<PinResult | null> => {
  try {
    if (hasTrustedGitHostRecord()) return null;
    const host = await resolveEffectiveGitHost(repoPaths, excludeRepoPaths);
    return host ? pinTrustedGitHostIfAbsent(host, source) : null;
  } catch {
    return null;
  }
};

/**
 * 在可信时机从 settings.repos 固定可信 GitLab host（启动 / 设置保存用）。
 * 脚本仓（scriptRepo）不参与：它们不 ship、origin 常挂在别的实例，参与推导会让固定结果有歧义。
 * 其余仓 origin 指向不同 host 时 resolveEffectiveGitHost 会抛 → 本次不固定，留给会话启动那个时机
 * （那时是按单个任务的仓库推，歧义更小）。
 */
export const pinTrustedGitHostFromSettings = async (
  settings: Record<string, unknown> | null | undefined,
  source: PinSource,
): Promise<PinResult | null> => {
  const repos = Array.isArray(settings?.repos) ? settings.repos : [];
  const paths: string[] = [];
  const scriptPaths: string[] = [];
  for (const repo of repos) {
    if (!repo || typeof repo !== "object") continue;
    const row = repo as { path?: unknown; scriptRepo?: unknown };
    if (typeof row.path !== "string" || !row.path.trim()) continue;
    const p = row.path.trim();
    paths.push(p);
    if (row.scriptRepo === true) scriptPaths.push(p);
  }
  if (paths.length === 0) return null;
  return pinTrustedGitHostFromRepoPaths(paths, source, scriptPaths);
};
