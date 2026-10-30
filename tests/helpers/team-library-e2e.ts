/**
 * 共享库（team-library）端到端测试脚手架：本地 bare 仓当远端，只 mock GitLab 的 `/api/v4/user`。
 * 从 tests/team-library-delete-authz.test.ts 的内联写法抽出来，B7-1 的三个新测试共用。
 *
 * - `https://gitlab.test/grp/lib.git` 经 git 的 `url.<bare>.insteadOf` 重写到本地 bare 仓——走的是真 clone / fetch / push；
 * - FLOWSHIP_DATA_DIR 指向临时目录，config.json 放假 token，team-library.json 指向上面的地址；
 * - `noGitIdentity: true` = 模拟「没有任何提交身份」的机器：全局 git 配置只剩 insteadOf + `user.useConfigOnly=true`
 *   （禁止 git 按「用户名@主机名」自动推断），并清掉环境变量里的 GIT_AUTHOR_* / GIT_COMMITTER_* / EMAIL
 *   （tests/setup/hermetic-env.ts 给整个测试进程设了兜底身份，不清掉就复现不了）；
 * - `installRejectHook()` 给 bare 仓装 pre-receive 钩子、拒绝一切推送。文案不含 "protected branch"：
 *   classifyPushRejection 把裸 `[remote rejected]` 归「其它」，既不触发 MR 降级也不触发 non-fast-forward 重试；
 * - 种子提交用显式 env 里的身份，和被测的「本机身份」完全隔开；
 * - cleanup() 还原所有 env / spy / 临时目录。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";

const execFileAsync = promisify(execFile);

export const TL_E2E_HOST = "gitlab.test";
export const TL_E2E_REPO_URL = `https://${TL_E2E_HOST}/grp/lib.git`;
export const TL_E2E_KB_URL = `https://${TL_E2E_HOST}/grp/kb.git`;

/** /api/v4/user 的响应字段（email 缺省 = GitLab 没给邮箱） */
export type TlE2eUser = {
  id: number;
  username: string;
  name: string;
  email?: string;
};

const ENV_KEYS = [
  "FLOWSHIP_DATA_DIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
] as const;

const SEED_IDENTITY = {
  GIT_AUTHOR_NAME: "seed",
  GIT_AUTHOR_EMAIL: "seed@example.invalid",
  GIT_COMMITTER_NAME: "seed",
  GIT_COMMITTER_EMAIL: "seed@example.invalid",
} as const;

const writeFiles = async (
  root: string,
  files: Record<string, string>,
): Promise<void> => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
  }
};

export const setupTeamLibraryE2E = async (opts: {
  /** 临时目录前缀（区分测试文件） */
  prefix: string;
  /** config.json 里的 gitToken（可用 setToken 中途换） */
  token: string;
  /** token → /api/v4/user 的响应；不在表里的 token 回 401（可中途改这张表） */
  users: Record<string, TlE2eUser>;
  noGitIdentity?: boolean;
  /** 共享库 main 上预置的文件（相对路径 → 内容） */
  seedFiles?: Record<string, string>;
  /** 提供则另建一个知识库源 bare 仓（main 分支）并把 knowledgeSource* 指过去（mirror 用） */
  knowledgeSeed?: Record<string, string>;
}) => {
  const tmp = path.join(
    os.tmpdir(),
    `${opts.prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const bareDir = path.join(tmp, "bare.git");
  const kbBareDir = path.join(tmp, "kb.git");
  const dataDir = path.join(tmp, "data");
  const repoDir = path.join(dataDir, "team-library", "repo");
  const gitConfigPath = path.join(tmp, "gitconfig");
  const hookPath = path.join(bareDir, "hooks", "pre-receive");

  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  const git = async (args: string[], cwd: string): Promise<string> =>
    (await execFileAsync("git", args, { cwd })).stdout.trim();
  const seedGit = async (args: string[], cwd: string): Promise<void> => {
    await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...SEED_IDENTITY, GIT_CONFIG_GLOBAL: os.devNull },
    });
  };
  const seedBare = async (
    bare: string,
    name: string,
    files: Record<string, string>,
  ): Promise<void> => {
    await execFileAsync("git", ["init", "--bare", "-b", "main", bare]);
    const seed = path.join(tmp, name);
    await writeFiles(seed, files);
    await seedGit(["init", "-b", "main"], seed);
    await seedGit(["add", "."], seed);
    await seedGit(["commit", "-m", "seed"], seed);
    await seedGit(["push", bare, "main"], seed);
  };

  await fs.mkdir(dataDir, { recursive: true });
  await seedBare(bareDir, "seed", {
    "README.md": "seed\n",
    ...(opts.seedFiles ?? {}),
  });
  if (opts.knowledgeSeed) {
    await seedBare(kbBareDir, "kb-seed", opts.knowledgeSeed);
  }

  // https 地址 → 本地 bare；身份段按场景写（有身份 = 固定 t / t@t.com，没身份 = 禁止自动推断）
  await fs.writeFile(
    gitConfigPath,
    [
      `[url "${bareDir}"]`,
      `\tinsteadOf = ${TL_E2E_REPO_URL}`,
      ...(opts.knowledgeSeed
        ? [`[url "${kbBareDir}"]`, `\tinsteadOf = ${TL_E2E_KB_URL}`]
        : []),
      ...(opts.noGitIdentity
        ? ["[user]", "\tuseConfigOnly = true"]
        : ["[user]", "\tname = t", "\temail = t@t.com"]),
      "",
    ].join("\n"),
    "utf-8",
  );
  process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.FLOWSHIP_DATA_DIR = dataDir;
  if (opts.noGitIdentity) {
    for (const k of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "EMAIL",
    ] as const) {
      delete process.env[k];
    }
  }

  await fs.writeFile(
    path.join(dataDir, "team-library.json"),
    JSON.stringify({
      repoUrl: TL_E2E_REPO_URL,
      branch: "main",
      ...(opts.knowledgeSeed
        ? { knowledgeSourceUrl: TL_E2E_KB_URL, knowledgeSourceBranch: "main" }
        : {}),
    }),
    "utf-8",
  );
  const setToken = async (token: string): Promise<void> => {
    await fs.writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({ gitToken: token }),
      "utf-8",
    );
  };
  await setToken(opts.token);

  /** 记录每次 /api/v4/user 查询用的 token（断言「本机有身份时根本没去问 GitLab」用） */
  const identityQueries: string[] = [];
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      const token = new Headers(init?.headers).get("PRIVATE-TOKEN") ?? "";
      identityQueries.push(token);
      const who = opts.users[token];
      if (!url.endsWith("/api/v4/user") || !who) {
        return new Response("{}", { status: 401, statusText: "Unauthorized" });
      }
      return new Response(
        JSON.stringify({
          id: who.id,
          username: who.username,
          name: who.name,
          ...(who.email ? { email: who.email } : {}),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

  return {
    tmp,
    bareDir,
    dataDir,
    repoDir,
    identityQueries,
    git,
    setToken,
    remoteHead: (): Promise<string> => git(["rev-parse", "main"], bareDir),
    remoteFiles: async (): Promise<string[]> =>
      (await git(["ls-tree", "-r", "--name-only", "main"], bareDir))
        .split("\n")
        .filter(Boolean),
    localHead: (): Promise<string> => git(["rev-parse", "HEAD"], repoDir),
    localStatus: (): Promise<string> =>
      git(["status", "--porcelain"], repoDir),
    /** 在本机自管 skill 目录（<dataDir>/skills/<name>/）里写文件 */
    writeAppSkill: (
      name: string,
      files: Record<string, string>,
    ): Promise<void> => writeFiles(path.join(dataDir, "skills", name), files),
    installRejectHook: async (
      message = "push rejected by test hook",
    ): Promise<void> => {
      await fs.mkdir(path.dirname(hookPath), { recursive: true });
      await fs.writeFile(
        hookPath,
        `#!/bin/sh\necho "${message}" >&2\nexit 1\n`,
        { mode: 0o755 },
      );
    },
    removeRejectHook: (): Promise<void> => fs.rm(hookPath, { force: true }),
    cleanup: async (): Promise<void> => {
      fetchSpy.mockRestore();
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await fs.rm(tmp, { recursive: true, force: true });
    },
  };
};
