/**
 * 共享库 commit / commit-tree 的提交身份（R14 B7-1 · Q13-07）
 *
 * 症状：`commitAndPush` 的 `git commit` 与 `writeTeamLibraryBranchFile` 的 `git commit-tree` 都不带身份，
 * 靠本机 git 配置。没有全局身份的机器（常见于 Windows / 新装机 / 容器）报 `Author identity unknown` /
 * `unable to auto-detect email address`，上传 / 镜像 / 写数据分支必败。macOS 往往能从「用户名@主机名」自动推断
 * 而成功，所以开发机上不易复现——这里用 `user.useConfigOnly=true` + 清掉环境变量里的身份来模拟「没有身份的机器」。
 *
 * 取舍：**只在本机没有可用身份时才补**，补的是 GitLab token 对应的身份（环境变量注入、不落盘）；
 * 本机已有身份的人提交作者不变、也不会为此多去问一次 GitLab。邮箱：GitLab 给的第一个邮箱，没有就用它的 noreply 形态，
 * 不写死 `flowship@local`。
 *
 * 分三块：纯函数口径；没有身份的机器（解析三分支 + 上传 / 数据分支 / 镜像三条真接线）；已有身份的机器（不覆盖、不多问）。
 * 脚手架见 tests/helpers/team-library-e2e.ts（本地 bare 仓当远端、只 mock GitLab 的 /api/v4/user）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildGitCommitIdentityEnv,
  mirrorKnowledgeBase,
  resolveCommitIdentityEnv,
  syncTeamLibrary,
  uploadSkillsToTeamLibrary,
  writeTeamLibraryBranchFile,
} from "@/lib/server/team-library";
import { HERMETIC_GIT_IDENTITY } from "./helpers/hermetic-env";
import {
  setupTeamLibraryE2E,
  TL_E2E_REPO_URL,
} from "./helpers/team-library-e2e";

const execFileAsync = promisify(execFile);
const T = 60_000;

const skillMd = (name: string): string =>
  `---\nname: ${name}\ndescription: ${name} desc\n---\n\n# ${name}\n`;

describe("buildGitCommitIdentityEnv：口径", () => {
  const base = {
    host: "gitlab.example.com",
    userId: 101,
    username: "alice",
    name: "Alice",
    emails: ["alice@example.com", "alice@other.example.com"],
  };

  it("名字 / 第一个邮箱；作者与提交者一致", () => {
    expect(buildGitCommitIdentityEnv(base)).toEqual({
      GIT_AUTHOR_NAME: "Alice",
      GIT_AUTHOR_EMAIL: "alice@example.com",
      GIT_COMMITTER_NAME: "Alice",
      GIT_COMMITTER_EMAIL: "alice@example.com",
    });
  });

  it("GitLab 没给任何邮箱 → noreply 形态 <userId>-<username>@users.noreply.<host>，不写死假地址", () => {
    const env = buildGitCommitIdentityEnv({ ...base, emails: [] });
    expect(env.GIT_AUTHOR_EMAIL).toBe(
      "101-alice@users.noreply.gitlab.example.com",
    );
    expect(env.GIT_COMMITTER_EMAIL).toBe(env.GIT_AUTHOR_EMAIL);
    expect(env.GIT_AUTHOR_EMAIL).not.toContain("flowship@local");
  });

  it("名字为空 → 退回 username", () => {
    expect(buildGitCommitIdentityEnv({ ...base, name: "" }).GIT_AUTHOR_NAME).toBe(
      "alice",
    );
  });

  it("名字 / 邮箱里的换行与尖括号被剔掉（git 会把它们当 ident 分隔符）", () => {
    const env = buildGitCommitIdentityEnv({
      ...base,
      name: "Al<i>ce\nSmith",
      emails: ["<alice@example.com>\n"],
    });
    expect(env.GIT_AUTHOR_NAME).toBe("AliceSmith");
    expect(env.GIT_AUTHOR_EMAIL).toBe("alice@example.com");
  });
});

describe("提交身份：本机没有 git 身份的机器（模拟）", () => {
  let env: Awaited<ReturnType<typeof setupTeamLibraryE2E>>;
  const resolve = (token: string) =>
    resolveCommitIdentityEnv({
      repoDir: env.repoDir,
      repoUrl: TL_E2E_REPO_URL,
      token,
    });
  const authorOf = (ref: string): Promise<string> =>
    env.git(["log", "-1", "--format=%an|%ae|%cn|%ce", ref], env.bareDir);

  beforeAll(async () => {
    env = await setupTeamLibraryE2E({
      prefix: "fe-tl-identity-none",
      token: "tok-alice",
      users: {
        "tok-alice": {
          id: 101,
          username: "alice",
          name: "Alice",
          email: "alice@example.com",
        },
        // GitLab 没给邮箱的用户
        "tok-bob": { id: 202, username: "bob", name: "Bob" },
      },
      noGitIdentity: true,
      knowledgeSeed: { "new.md": "new\n" },
    });
    expect((await syncTeamLibrary()).ok).toBe(true);
  }, T);

  afterAll(async () => {
    await env.cleanup();
  });

  it("前置：这台模拟机器上 git 确实没有提交身份（否则下面的用例什么都证明不了）", async () => {
    await expect(
      execFileAsync("git", ["var", "GIT_AUTHOR_IDENT"], { cwd: env.repoDir }),
    ).rejects.toThrow();
    await expect(
      execFileAsync("git", ["var", "GIT_COMMITTER_IDENT"], {
        cwd: env.repoDir,
      }),
    ).rejects.toThrow();
  });

  it(
    "resolveCommitIdentityEnv：缺身份 → 用 GitLab 身份（名字 / 邮箱）；邮箱缺省 → noreply",
    async () => {
      const alice = await resolve("tok-alice");
      expect(alice.ok).toBe(true);
      if (alice.ok) {
        expect(alice.env).toMatchObject({
          GIT_AUTHOR_NAME: "Alice",
          GIT_AUTHOR_EMAIL: "alice@example.com",
          GIT_COMMITTER_NAME: "Alice",
          GIT_COMMITTER_EMAIL: "alice@example.com",
        });
      }

      const bob = await resolve("tok-bob");
      expect(bob.ok).toBe(true);
      if (bob.ok) {
        expect(bob.env).toMatchObject({
          GIT_AUTHOR_NAME: "Bob",
          GIT_AUTHOR_EMAIL: "202-bob@users.noreply.gitlab.test",
        });
      }
    },
    T,
  );

  // 只配了作者、或只配了提交者的机器：git 提交时两头都要有，所以仍算「缺身份」（git ≥ 2.22 支持 author.* / committer.* 配置）
  it.each([
    ["author", "GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"],
    ["committer", "GIT_COMMITTER_IDENT", "GIT_AUTHOR_IDENT"],
  ] as const)(
    "resolveCommitIdentityEnv：只配了 %s 一头（另一头 git 定不出来）仍算缺身份 → 用 GitLab 身份",
    async (which, haveVar, missVar) => {
      await env.git(
        ["config", "--local", `${which}.name`, "Half Ident"],
        env.repoDir,
      );
      await env.git(
        ["config", "--local", `${which}.email`, "half@example.com"],
        env.repoDir,
      );
      try {
        // 前置：确实只有一头（否则下面的用例什么都证明不了）
        await execFileAsync("git", ["var", haveVar], { cwd: env.repoDir });
        await expect(
          execFileAsync("git", ["var", missVar], { cwd: env.repoDir }),
        ).rejects.toThrow();

        const r = await resolve("tok-alice");

        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.env).toMatchObject({
            GIT_AUTHOR_NAME: "Alice",
            GIT_AUTHOR_EMAIL: "alice@example.com",
            GIT_COMMITTER_NAME: "Alice",
            GIT_COMMITTER_EMAIL: "alice@example.com",
          });
        }
      } finally {
        await env.git(
          ["config", "--local", "--unset", `${which}.name`],
          env.repoDir,
        );
        await env.git(
          ["config", "--local", "--unset", `${which}.email`],
          env.repoDir,
        );
      }
    },
    T,
  );

  it(
    "resolveCommitIdentityEnv：本机没身份、GitLab 身份也取不到 → 明确的中文错误，不是 git 的英文",
    async () => {
      const r = await resolve("tok-unknown");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("没有可用的提交身份");
        expect(r.error).toContain("git config --global user.name");
        expect(r.error).toContain("401");
      }
    },
    T,
  );

  it(
    "接线·上传（commit）：没有本机身份也能上传成功，提交作者 = GitLab 身份",
    async () => {
      await env.writeAppSkill("who", { "SKILL.md": skillMd("who") });
      const before = await env.remoteHead();

      const r = await uploadSkillsToTeamLibrary(["who"], "qa");

      expect(r.ok).toBe(true);
      expect(await env.remoteHead()).not.toBe(before);
      expect(await authorOf("main")).toBe(
        "Alice|alice@example.com|Alice|alice@example.com",
      );
    },
    T,
  );

  it(
    "接线·数据分支（commit-tree）：没有本机身份也能写成员注册表，提交作者 = GitLab 身份",
    async () => {
      const r = await writeTeamLibraryBranchFile({
        relPath: "group-members.json",
        mutate: () => '{"version":1,"members":{}}\n',
        message: "chore: 首次创建注册表",
      });

      expect(r).toEqual({ ok: true, changed: true });
      expect(await authorOf("members")).toBe(
        "Alice|alice@example.com|Alice|alice@example.com",
      );
    },
    T,
  );

  it(
    "接线·数据分支：本机没身份、GitLab 身份也取不到 → 明确报错、远端分支不动",
    async () => {
      const before = await env.git(["rev-parse", "members"], env.bareDir);
      await env.setToken("tok-unknown");
      try {
        const r = await writeTeamLibraryBranchFile({
          relPath: "group-members.json",
          mutate: () => '{"version":1,"members":{"x":1}}\n',
          message: "chore: 不该写进去",
        });

        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("没有可用的提交身份");
      } finally {
        await env.setToken("tok-alice");
      }
      expect(await env.git(["rev-parse", "members"], env.bareDir)).toBe(before);
    },
    T,
  );

  it(
    "接线·镜像（mirror 不取身份、由 commitAndPush 内部兜底）：本机没身份、GitLab 身份也取不到 → 明确报错、工作树回滚",
    async () => {
      const before = await env.remoteHead();
      await env.setToken("tok-unknown");
      let r: Awaited<ReturnType<typeof mirrorKnowledgeBase>>;
      try {
        r = await mirrorKnowledgeBase();
      } finally {
        await env.setToken("tok-alice");
      }

      expect(r.ok).toBe(false);
      expect(r.error ?? "").toContain("没有可用的提交身份");
      expect(await env.remoteHead()).toBe(before);
      expect(await env.localHead()).toBe(before);
      expect(await env.localStatus()).toBe("");
    },
    T,
  );
});

describe("提交身份：本机已有 git 身份 → 不覆盖、不多问 GitLab", () => {
  let env: Awaited<ReturnType<typeof setupTeamLibraryE2E>>;

  beforeAll(async () => {
    env = await setupTeamLibraryE2E({
      prefix: "fe-tl-identity-has",
      token: "tok-solo",
      users: {
        "tok-solo": {
          id: 303,
          username: "solo",
          name: "Solo",
          email: "solo@example.com",
        },
      },
    });
    expect((await syncTeamLibrary()).ok).toBe(true);
  }, T);

  afterAll(async () => {
    await env.cleanup();
  });

  it(
    "resolveCommitIdentityEnv：本机有身份 → 不注入（env 缺省）、一次 GitLab 身份查询都不发",
    async () => {
      const r = await resolveCommitIdentityEnv({
        repoDir: env.repoDir,
        repoUrl: TL_E2E_REPO_URL,
        token: "tok-solo",
      });

      expect(r).toEqual({ ok: true });
      expect(env.identityQueries).not.toContain("tok-solo");
    },
    T,
  );

  it(
    "接线·上传：提交作者仍是本机身份，不是 GitLab 身份；身份查询只有上传自己那一次",
    async () => {
      await env.writeAppSkill("mine", { "SKILL.md": skillMd("mine") });

      const r = await uploadSkillsToTeamLibrary(["mine"], "qa");

      expect(r.ok).toBe(true);
      const author = await env.git(
        ["log", "-1", "--format=%an|%ae|%cn|%ce", "main"],
        env.bareDir,
      );
      const { name, email } = HERMETIC_GIT_IDENTITY;
      expect(author).toBe(`${name}|${email}|${name}|${email}`);
      expect(env.identityQueries.filter((t) => t === "tok-solo")).toHaveLength(
        1,
      );
    },
    T,
  );
});
