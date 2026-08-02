import { describe, expect, it } from "vitest";

import {
  decideSharedSkillUpdate,
  ownerFromGitLabIdentity,
  parseSharedSkillOwner,
  type GitLabUploadIdentity,
} from "@/lib/server/team-library-ownership";

const currentUser: GitLabUploadIdentity = {
  host: "gitlab.example.com",
  userId: 101,
  username: "chenlujiang",
  name: "陈禄江",
  emails: ["chenlujiang@example.com"],
};

describe("共享库上传归属", () => {
  it("新名字允许上传并把 GitLab 身份固化为 owner", () => {
    expect(
      decideSharedSkillUpdate({
        exists: false,
        owner: null,
        currentUser,
      }),
    ).toEqual({ allowed: true, source: "new" });
    expect(ownerFromGitLabIdentity(currentUser)).toEqual({
      schemaVersion: 1,
      gitlabHost: "gitlab.example.com",
      gitlabUserId: 101,
      gitlabUsername: "chenlujiang",
      displayName: "陈禄江",
    });
  });

  it("owner id 相同才允许更新；同名但不同账号也不能覆盖", () => {
    const owner = ownerFromGitLabIdentity(currentUser);
    expect(
      decideSharedSkillUpdate({
        exists: true,
        owner,
        currentUser,
      }),
    ).toEqual({ allowed: true, source: "owner-file" });

    const denied = decideSharedSkillUpdate({
      exists: true,
      owner,
      currentUser: { ...currentUser, userId: 202 },
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toContain("无权覆盖");
  });

  it("历史项仅首次 git author 明确匹配时允许迁移", () => {
    expect(
      decideSharedSkillUpdate({
        exists: true,
        owner: null,
        legacyAuthor: "陈禄江",
        legacyAuthorEmail: "chenlujiang@example.com",
        currentUser,
      }),
    ).toEqual({ allowed: true, source: "legacy-author" });

    const denied = decideSharedSkillUpdate({
      exists: true,
      owner: null,
      legacyAuthor: "Alice",
      legacyAuthorEmail: "alice@example.com",
      currentUser,
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toContain("Alice");
  });

  it("历史项不能只凭同名认领，必须匹配 commit 邮箱", () => {
    const denied = decideSharedSkillUpdate({
      exists: true,
      owner: null,
      legacyAuthor: "陈禄江",
      legacyAuthorEmail: "other@example.com",
      currentUser,
    });
    expect(denied.allowed).toBe(false);
  });

  it("owner 文件结构不完整时拒绝解析", () => {
    expect(
      parseSharedSkillOwner({
        schemaVersion: 1,
        gitlabHost: "gitlab.example.com",
        gitlabUserId: 101,
        gitlabUsername: "chenlujiang",
        displayName: "陈禄江",
      }),
    ).not.toBeNull();
    expect(parseSharedSkillOwner({ gitlabUserId: 101 })).toBeNull();
  });
});
