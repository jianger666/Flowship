/**
 * 共享库上传归属判定。
 *
 * 新上传项用 GitLab token 对应的 user id 作为稳定 owner；历史项没有 owner 文件，
 * 只能用首次引入 SKILL.md 的 git author 与当前 GitLab 姓名/用户名做一次兼容迁移。
 * 历史信息无法匹配时 fail closed，不能因为“可能是本人”就放开覆盖。
 */

export type GitLabUploadIdentity = {
  host: string;
  userId: number;
  username: string;
  name: string;
  emails: string[];
};

export type SharedSkillOwner = {
  schemaVersion: 1;
  gitlabHost: string;
  gitlabUserId: number;
  gitlabUsername: string;
  displayName: string;
};

const normalized = (value: string | undefined): string =>
  (value ?? "").trim().toLocaleLowerCase();

export const ownerFromGitLabIdentity = (
  identity: GitLabUploadIdentity,
): SharedSkillOwner => ({
  schemaVersion: 1,
  gitlabHost: identity.host,
  gitlabUserId: identity.userId,
  gitlabUsername: identity.username,
  displayName: identity.name || identity.username,
});

export const parseSharedSkillOwner = (
  value: unknown,
): SharedSkillOwner | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.gitlabHost !== "string" ||
    typeof raw.gitlabUserId !== "number" ||
    !Number.isFinite(raw.gitlabUserId) ||
    typeof raw.gitlabUsername !== "string" ||
    typeof raw.displayName !== "string"
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    gitlabHost: raw.gitlabHost.trim(),
    gitlabUserId: raw.gitlabUserId,
    gitlabUsername: raw.gitlabUsername.trim(),
    displayName: raw.displayName.trim(),
  };
};

export type SharedSkillOwnershipDecision =
  | { allowed: true; source: "owner-file" | "legacy-author" | "new" }
  | { allowed: false; ownerLabel?: string; reason: string };

export const decideSharedSkillUpdate = ({
  exists,
  owner,
  legacyAuthor,
  legacyAuthorEmail,
  currentUser,
}: {
  exists: boolean;
  owner: SharedSkillOwner | null;
  legacyAuthor?: string;
  legacyAuthorEmail?: string;
  currentUser: GitLabUploadIdentity;
}): SharedSkillOwnershipDecision => {
  if (!exists) return { allowed: true, source: "new" };

  if (owner) {
    const sameHost = normalized(owner.gitlabHost) === normalized(currentUser.host);
    if (sameHost && owner.gitlabUserId === currentUser.userId) {
      return { allowed: true, source: "owner-file" };
    }
    const ownerLabel = owner.displayName || owner.gitlabUsername;
    return {
      allowed: false,
      ...(ownerLabel ? { ownerLabel } : {}),
      reason: ownerLabel
        ? `由 ${ownerLabel} 上传，当前账号无权覆盖`
        : "当前账号不是该共享项的创建人，无权覆盖",
    };
  }

  // 历史产物没有 owner 文件：只允许首次 commit 邮箱与 GitLab 当前账号邮箱明确匹配。
  // 姓名可修改、可重名，不能把“名字一样”当授权依据。
  const authorEmail = normalized(legacyAuthorEmail);
  const currentEmails = new Set(
    currentUser.emails.map(normalized).filter(Boolean),
  );
  if (authorEmail && currentEmails.has(authorEmail)) {
    return { allowed: true, source: "legacy-author" };
  }

  return {
    allowed: false,
    ...(legacyAuthor?.trim() ? { ownerLabel: legacyAuthor.trim() } : {}),
    reason: legacyAuthor?.trim()
      ? `由 ${legacyAuthor.trim()} 创建，当前账号无权覆盖`
      : "无法确认该共享项的创建人，已拒绝覆盖；请联系 maintainer 处理",
  };
};
