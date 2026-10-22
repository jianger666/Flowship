/**
 * 「把宿主环境交给用户命令 / 用户仓钩子」的出口都要剔宿主注入变量（第三轮 review R10b-05）。
 *
 * 背景见 `host-env.ts` 文件头：Electron 壳拉起内嵌 server 时，ELECTRON_RUN_AS_NODE / PORT / HOSTNAME /
 * FLOWSHIP_DATA_DIR / __NEXT_PRIVATE_STANDALONE_CONFIG 等留在 server 的 process.env 里。agent shell 与
 * worktree 依赖初始化早已走 `stripHostInjectedEnv`，但预览命令、git 钩子、IDE 启动器、OS 打开器、
 * workflow-gate 脚本仍整份继承：用户的 `next dev` 拿到 standalone 配置报 "generate is not a function"、
 * husky 钩子里的 `pnpm build` 同理、被拉起的 Electron 系 IDE（VS Code）被当成纯 node 秒退。
 *
 * 行为测试：真实 git 钩子把自己拿到的 env 落盘（mac / linux；Windows 上钩子语义不同，跳过）；
 * 其余出口用纯函数 / 路由（spawn 被 mock 记录 options.env）；没法在不起 IDE / python 的前提下
 * 直接跑的两处（IDE 启动器、workflow-gate 脚本）用接线契约钉死。
 */
import { execFileSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({ // eslint-disable-line @typescript-eslint/no-unused-vars
    on(ev: string, cb: (code: number) => void) {
      if (ev === "exit") setTimeout(() => cb(0), 0);
      return this;
    },
    unref() {},
  })),
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { checkoutGitBranch } from "@/lib/server/git-branches";
import { buildPreviewEnv } from "@/lib/server/preview-manager";
import { createTask } from "@/lib/server/task-fs";
import { ensureTaskWorktrees } from "@/lib/server/task-worktrees";

const TMP_ROOT = path.join(os.tmpdir(), `fe-spawn-env-${Date.now()}`);
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/** 宿主注入的哨兵值（与 host-env.ts 黑名单一一对应） */
const SENTINELS: Record<string, string> = {
  ELECTRON_RUN_AS_NODE: "1",
  FLOWSHIP_PORT: "8876",
  PORT: "8876",
  HOSTNAME: "127.0.0.1",
  __NEXT_PRIVATE_STANDALONE_CONFIG: '{"sentinel":true}',
  __NEXT_PRIVATE_ORIGIN: "http://127.0.0.1:8876",
  NEXT_DEPLOYMENT_ID: "dpl_sentinel",
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [k, v] of Object.entries(SENTINELS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  vi.clearAllMocks();
});
afterEach(() => {
  for (const k of Object.keys(SENTINELS)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

/** 钩子落盘的 env 里，宿主变量一个都不该有；PATH 等正常变量必须还在（没把环境整个洗空） */
const expectHostEnvAbsent = (dump: string): void => {
  const keys = new Set(dump.split("\n").map((l) => l.split("=")[0]));
  for (const k of [...Object.keys(SENTINELS), "FLOWSHIP_DATA_DIR"]) {
    expect(keys.has(k), `钩子环境里不该有 ${k}`).toBe(false);
  }
  expect(keys.has("PATH")).toBe(true);
};

const initRepoWithHook = async (name: string, hook: string) => {
  const repo = path.join(TMP_ROOT, name);
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t.local");
  git(repo, "config", "user.name", "t");
  await fs.writeFile(path.join(repo, "f.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  const hookFile = path.join(repo, ".git", "hooks", "post-checkout");
  await fs.writeFile(hookFile, hook, { mode: 0o755 });
  await fs.chmod(hookFile, 0o755);
  return repo;
};

describe.skipIf(process.platform === "win32")("git 钩子拿到的环境不含宿主注入变量", () => {
  it("git-branches：checkoutGitBranch 触发的 post-checkout 钩子", async () => {
    const out = path.join(TMP_ROOT, "hook-checkout.env");
    await fs.mkdir(TMP_ROOT, { recursive: true });
    const repo = await initRepoWithHook("checkout", `#!/bin/sh\nenv > "${out}"\n`);
    git(repo, "branch", "feat");

    const res = await checkoutGitBranch(repo, "feat");

    expect(res).toEqual({ ok: true });
    expectHostEnvAbsent(await fs.readFile(out, "utf8"));
  });

  it("testing-task-branches：失败回滚时的 `git checkout` 触发的 post-checkout 钩子", async () => {
    const out = path.join(TMP_ROOT, "hook-testing-restore.env");
    await fs.mkdir(TMP_ROOT, { recursive: true });
    const repo = await initRepoWithHook("testing-restore", `#!/bin/sh\nenv > "${out}"\n`);
    git(repo, "checkout", "-b", "feat"); // 此刻在 feat 上（= 测试分支）；原分支 main
    await fs.rm(out, { force: true }); // 上面的 checkout 也会触发钩子，清掉只看回滚那一次

    const { restoreRepoAfterFailedTestingCheckout } = await import("@/lib/server/testing-task-branches");
    await restoreRepoAfterFailedTestingCheckout(
      {
        repoPath: repo,
        branch: "feat",
        currentBranch: "main",
        currentCommit: git(repo, "rev-parse", "HEAD"),
      },
      new AbortController().signal,
    );

    expect(git(repo, "branch", "--show-current")).toBe("main");
    expectHostEnvAbsent(await fs.readFile(out, "utf8"));
  });

  it("task-worktrees：ensureTaskWorktrees 的 `git worktree add` 触发的 post-checkout 钩子", async () => {
    const out = path.join(TMP_ROOT, "hook-worktree.env");
    await fs.mkdir(TMP_ROOT, { recursive: true });
    const repo = await initRepoWithHook("worktree", `#!/bin/sh\nenv > "${out}"\n`);
    const task = await createTask({
      title: "钩子环境",
      mode: "task",
      workRole: "fe",
      repoPaths: [repo],
      repoBaseBranches: { [repo]: "main" },
      feishuStoryUrl: "https://project.feishu.cn/x/story/detail/840001",
    } as never);

    await ensureTaskWorktrees(task, () => true);

    expectHostEnvAbsent(await fs.readFile(out, "utf8"));
  }, 60_000);
});

describe("buildPreviewEnv：用户配置的预览命令（next dev / pnpm dev）的环境", () => {
  it("剔掉宿主注入变量与 GitLab token，保留 PATH 等其余变量，并关掉颜色", () => {
    const env = buildPreviewEnv({
      ...SENTINELS,
      FLOWSHIP_DATA_DIR: "/data/prod",
      FLOWSHIP_GITLAB_TOKEN: "glpat-secret",
      PATH: "/usr/bin",
      HOME: "/Users/me",
      MY_VAR: "keep",
    } as unknown as NodeJS.ProcessEnv);
    for (const k of [...Object.keys(SENTINELS), "FLOWSHIP_DATA_DIR", "FLOWSHIP_GITLAB_TOKEN"]) {
      expect(env, k).not.toHaveProperty(k);
    }
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/me");
    expect(env.MY_VAR).toBe("keep");
    expect(env.FORCE_COLOR).toBe("0");
  });

  it("不改传入对象（也就不会动 server 自己的 process.env）", () => {
    const base = { PORT: "8876", PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv;
    buildPreviewEnv(base);
    expect(base).toEqual({ PORT: "8876", PATH: "/usr/bin" });
  });

  it("默认取当前 process.env", () => {
    const env = buildPreviewEnv();
    expect(env).not.toHaveProperty("PORT");
    expect(env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(env.FORCE_COLOR).toBe("0");
  });
});

describe("OS 打开器（open-path / reveal-in-folder）：被拉起的应用不继承宿主变量", () => {
  const post = (url: string, body: unknown) =>
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const spawnedEnv = (): NodeJS.ProcessEnv | undefined => {
    const opts = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    return opts?.env;
  };

  it("reveal-in-folder", async () => {
    const { POST } = await import("@/app/api/system/reveal-in-folder/route");
    const res = await POST(post("http://127.0.0.1/x", { path: path.join(os.tmpdir(), "a.txt") }));
    expect(res.status).toBe(200);
    const env = spawnedEnv();
    expect(env, "spawn 必须显式带 env（不带 = 整份继承）").toBeDefined();
    for (const k of Object.keys(SENTINELS)) expect(env, k).not.toHaveProperty(k);
    expect(env?.PATH).toBeTruthy();
  });

  it("open-path", async () => {
    const { POST } = await import("@/app/api/system/open-path/route");
    const res = await POST(post("http://127.0.0.1/x", { path: path.join(os.tmpdir(), "a.txt") }));
    expect(res.status).toBe(200);
    const env = spawnedEnv();
    expect(env, "spawn 必须显式带 env（不带 = 整份继承）").toBeDefined();
    for (const k of Object.keys(SENTINELS)) expect(env, k).not.toHaveProperty(k);
  });
});

describe("接线契约：没法在不起 IDE / python / 真 shell 的前提下直接跑的出口", () => {
  const src = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

  it("ide-tools：Windows / Linux 直接 spawn IDE 启动器时带 stripHostInjectedEnv（VS Code 系是 Electron，吃到 ELECTRON_RUN_AS_NODE 会被当纯 node 秒退）", () => {
    const s = src("src/lib/server/ide-tools.ts");
    expect(s).toMatch(/from "\.\/host-env"/);
    const at = s.indexOf("const child = spawn(cmd, cmdArgs as string[], {");
    expect(at).toBeGreaterThan(0);
    expect(s.slice(at, at + 400)).toContain("env: stripHostInjectedEnv()");
  });

  it("action-checks：runShell 的 git 子进程带 stripHostInjectedEnv", () => {
    const s = src("src/lib/server/action-checks.ts");
    expect(s).toMatch(/from "\.\/host-env"/);
    const at = s.indexOf("const proc = spawn(cmd, args, {");
    expect(at).toBeGreaterThan(0);
    expect(s.slice(at, at + 300)).toContain("env: stripHostInjectedEnv()");
  });

  it("wk-gate：workflow-gate 的 python 脚本环境从 stripHostInjectedEnv 起步，而不是整份 process.env", () => {
    const s = src("src/lib/server/wk-gate.ts");
    expect(s).toMatch(/from "\.\/host-env"/);
    const at = s.indexOf("const scriptEnv = (plan: WkGatePlanActive)");
    expect(at).toBeGreaterThan(0);
    const body = s.slice(at, at + 400);
    expect(body).toContain("...stripHostInjectedEnv()");
    expect(body).not.toContain("...process.env");
  });
});
