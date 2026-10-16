/**
 * 共享库删除归属校验（S07-01）
 *
 * 删除路径此前不校验身份：任何持有推送权限 token 的人都能删别人上传的共享 skill。
 * 现在删除与上传覆盖共用 decideSharedSkillUpdate：owner 文件 → 历史首次提交邮箱 → fail closed。
 * 上半：authorizeSharedSkillDeletion 单元；下半：用本地 bare 仓真实走 deleteFromTeamLibrary 全链路。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  authorizeSharedSkillDeletion,
  deleteFromTeamLibrary,
} from "@/lib/server/team-library";
import {
  ownerFromGitLabIdentity,
  type GitLabUploadIdentity,
} from "@/lib/server/team-library-ownership";

const execFileAsync = promisify(execFile);

const alice: GitLabUploadIdentity = {
  host: "gitlab.example.com",
  userId: 101,
  username: "alice",
  name: "Alice",
  emails: ["alice@example.com"],
};
const bob: GitLabUploadIdentity = {
  host: "gitlab.example.com",
  userId: 202,
  username: "bob",
  name: "Bob",
  emails: ["bob@example.com"],
};

describe("authorizeSharedSkillDeletion", () => {
  const TMP = path.join(os.tmpdir(), `fe-tl-delete-authz-${Date.now()}`);
  const ownedDir = path.join(TMP, "skills", "qa", "owned");
  const legacyDir = path.join(TMP, "skills", "qa", "legacy");

  beforeAll(async () => {
    await fs.mkdir(ownedDir, { recursive: true });
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(ownedDir, ".flowship-owner.json"),
      JSON.stringify(ownerFromGitLabIdentity(alice)),
      "utf-8",
    );
  });

  afterAll(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("owner 本人可以删", async () => {
    const r = await authorizeSharedSkillDeletion({
      absDir: ownedDir,
      relDir: "skills/qa/owned",
      currentUser: alice,
      authorIdentities: {},
    });
    expect(r).toEqual({ ok: true });
  });

  it("非 owner 被拒（即使同样有推送权限的 token）", async () => {
    const r = await authorizeSharedSkillDeletion({
      absDir: ownedDir,
      relDir: "skills/qa/owned",
      currentUser: bob,
      authorIdentities: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("无权删除");
      expect(r.error).toContain("owned");
      expect(r.error).toContain("Alice");
    }
  });

  it("历史项（无 owner 文件）：首次提交邮箱匹配可删、不匹配被拒", async () => {
    const authorIdentities = {
      "skills/qa/legacy": { name: "Alice", email: "alice@example.com" },
    };
    await expect(
      authorizeSharedSkillDeletion({
        absDir: legacyDir,
        relDir: "skills/qa/legacy",
        currentUser: alice,
        authorIdentities,
      }),
    ).resolves.toEqual({ ok: true });
    const denied = await authorizeSharedSkillDeletion({
      absDir: legacyDir,
      relDir: "skills/qa/legacy",
      currentUser: bob,
      authorIdentities,
    });
    expect(denied.ok).toBe(false);
  });

  it("历史项查不到创建人 → fail closed", async () => {
    const r = await authorizeSharedSkillDeletion({
      absDir: legacyDir,
      relDir: "skills/qa/legacy",
      currentUser: alice,
      authorIdentities: {},
    });
    expect(r.ok).toBe(false);
  });
});

/**
 * 真实走对外入口 deleteFromTeamLibrary（→ deleteFromTeamLibraryInternal）：
 * 本地 bare 仓当远端（git url.insteadOf 把 https 地址重写过去）、fetch 只 mock GitLab /api/v4/user。
 * 不再 grep 源码顺序：授权判定被删 / 挪到 stageDelete 之后，远端树就会被非 owner 改掉 → 断言变红。
 */
describe("deleteFromTeamLibrary 行为（非 owner 真被拒、不 stage 不推送）", () => {
  const TMP = path.join(os.tmpdir(), `fe-tl-delete-e2e-${Date.now()}`);
  const bareDir = path.join(TMP, "bare.git");
  const dataDir = path.join(TMP, "data");
  const repoDir = path.join(dataDir, "team-library", "repo");
  const gitConfigPath = path.join(TMP, "gitconfig");
  const REPO_URL = "https://gitlab.test/grp/lib.git";
  const HOST = "gitlab.test";

  const aliceId: GitLabUploadIdentity = { ...alice, host: HOST };
  const bobId: GitLabUploadIdentity = { ...bob, host: HOST };
  const TOKENS: Record<string, GitLabUploadIdentity> = {
    "tok-alice": aliceId,
    "tok-bob": bobId,
  };

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "FLOWSHIP_DATA_DIR",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
  ] as const;
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
  /** 记录 identity 请求用了哪些 token（顺带证明走了身份查询） */
  const fetchedTokens: string[] = [];

  const git = async (args: string[], cwd: string): Promise<string> =>
    (await execFileAsync("git", args, { cwd })).stdout.trim();
  const remoteHead = (): Promise<string> =>
    git(["rev-parse", "main"], bareDir);
  const remoteFiles = (): Promise<string[]> =>
    git(["ls-tree", "-r", "--name-only", "main"], bareDir).then((o) =>
      o.split("\n").filter(Boolean),
    );
  const useToken = async (token: string): Promise<void> => {
    await fs.writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({ gitToken: token }),
      "utf-8",
    );
  };

  const skillMd = (name: string): string =>
    `---\nname: ${name}\ndescription: ${name} desc\n---\n\n# ${name}\n`;

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    await fs.mkdir(dataDir, { recursive: true });
    await execFileAsync("git", ["init", "--bare", "-b", "main", bareDir]);
    // https 地址 → 本地 bare；提交身份写死、不依赖跑测机器的全局 git config
    await fs.writeFile(
      gitConfigPath,
      `[url "${bareDir}"]\n\tinsteadOf = ${REPO_URL}\n[user]\n\tname = t\n\temail = t@t.com\n`,
      "utf-8",
    );
    process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.FLOWSHIP_DATA_DIR = dataDir;

    await fs.writeFile(
      path.join(dataDir, "team-library.json"),
      JSON.stringify({ repoUrl: REPO_URL, branch: "main" }),
      "utf-8",
    );

    const seed = path.join(TMP, "seed");
    for (const [name, owner] of [
      ["alice-skill", aliceId],
      ["bob-skill", bobId],
    ] as const) {
      const dir = path.join(seed, "skills", "qa", name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), skillMd(name), "utf-8");
      await fs.writeFile(
        path.join(dir, ".flowship-owner.json"),
        JSON.stringify(ownerFromGitLabIdentity(owner)),
        "utf-8",
      );
    }
    await execFileAsync("git", ["init", "-b", "main"], { cwd: seed });
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "seed"], { cwd: seed });
    await execFileAsync("git", ["push", bareDir, "main"], { cwd: seed });

    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        const token = headers.get("PRIVATE-TOKEN") ?? "";
        fetchedTokens.push(token);
        const who = TOKENS[token];
        if (!url.endsWith("/api/v4/user") || !who) {
          return new Response("{}", { status: 401, statusText: "Unauthorized" });
        }
        return new Response(
          JSON.stringify({
            id: who.userId,
            username: who.username,
            name: who.name,
            email: who.emails[0],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
  });

  afterAll(async () => {
    fetchSpy?.mockRestore();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("身份查不到（token 无效）→ fail closed：不删、远端不动", async () => {
    await useToken("tok-unknown");
    const before = await remoteHead();
    const r = await deleteFromTeamLibrary("alice-skill");
    expect(r.ok).toBe(false);
    expect(await remoteHead()).toBe(before);
    expect(await remoteFiles()).toContain(
      "skills/qa/alice-skill/SKILL.md",
    );
  });

  it("非 owner（bob 删 alice 的 skill）→ 被拒；本地目录没被 stage 删除、远端没有任何新提交", async () => {
    await useToken("tok-bob");
    const before = await remoteHead();
    fetchedTokens.length = 0;

    const r = await deleteFromTeamLibrary("alice-skill");

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("无权删除");
      expect(r.error).toContain("alice-skill");
    }
    expect(fetchedTokens).toContain("tok-bob");
    // 没有推送：远端 main 指针不变、文件仍在
    expect(await remoteHead()).toBe(before);
    expect(await remoteFiles()).toContain("skills/qa/alice-skill/SKILL.md");
    // 没有 stageDelete：本地 clone 里目录还在、没有未提交 / 未推送改动
    await expect(
      fs.stat(path.join(repoDir, "skills", "qa", "alice-skill", "SKILL.md")),
    ).resolves.toBeTruthy();
    expect(await git(["status", "--porcelain"], repoDir)).toBe("");
    expect(await git(["rev-parse", "HEAD"], repoDir)).toBe(before);
  });

  it("owner 本人（alice）→ 删除成功并推送到远端；别人的 skill 不受影响", async () => {
    await useToken("tok-alice");
    const before = await remoteHead();

    const r = await deleteFromTeamLibrary("alice-skill");

    expect(r).toEqual({ ok: true });
    expect(await remoteHead()).not.toBe(before);
    const files = await remoteFiles();
    expect(files.some((f) => f.startsWith("skills/qa/alice-skill/"))).toBe(
      false,
    );
    expect(files).toContain("skills/qa/bob-skill/SKILL.md");
  });
});
