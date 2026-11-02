/**
 * 「当前分支」读取必须给精确的分支名，分支与同名 tag 并存时也一样。
 *
 * 旧行为：`git rev-parse --abbrev-ref HEAD`——分支 `foo` 与标签 `foo` 并存时输出 `heads/foo`（git 为消歧义缩短 ref）。
 * 连锁后果：
 * - `buildBranchOccupancy(entries, current)` 按名字排除「本工作树自己的分支」，`heads/foo` ≠ `foo` → 自己的分支被当成「被别的工作树占用」；
 * - `checkoutGitBranch` 的「切到当前分支自己」豁免（b === current）失效，还会被占用检查拦成「已被占用」；
 * - 变更面板的 `branch` 带着 `heads/` 前缀、`onBaseBranch` 比不上线上分支名。
 *
 * 现在：`rev-parse --symbolic-full-name HEAD`（输出完整 ref，去掉 `refs/heads/` 即精确名；`--short` 版的 symbolic-ref 同样会输出
 * `heads/foo`，所以不用它）。失败语义与旧版逐项一致：
 * - unborn（空仓、HEAD 指向还没有提交的分支）：命令失败 → readCurrentBranch 为 null、readGitBranchState 照旧判 isRepo=false；
 * - detached HEAD：输出字面量 HEAD → null；
 * - 非 git 目录：命令失败 → null。
 *
 * 真 git + 临时仓库，全程不碰工作区这个真仓库。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkoutGitBranch, readGitBranchState } from "@/lib/server/git-branches";
import { parseCurrentBranchOutput } from "@/lib/server/git-exec";
import { readTaskChanges } from "@/lib/server/task-changes";

const LEAKY_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
] as const;
const saved: Record<string, string | undefined> = {};
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "flowship-cur-branch-")));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** 当前分支（精确名）；detached 时是字面量 HEAD。不用 rev-parse --abbrev-ref（同名 tag 并存时是 heads/<name>） */
const head = (cwd: string): string => {
  try {
    return git(cwd, "symbolic-ref", "-q", "HEAD").replace(/^refs\/heads\//, "");
  } catch {
    return "HEAD";
  }
};

let seq = 0;
/** 有一个提交的仓库，HEAD 在 main */
const makeRepo = (): string => {
  const dir = path.join(TMP, `repo-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "tester");
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
};

beforeAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GIT_CONFIG_GLOBAL = path.join(TMP, "gitconfig-empty");
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("parseCurrentBranchOutput（纯函数）", () => {
  it("refs/heads/<名> → 精确名（含 / . _ 与看起来像 heads/ 的名字）；HEAD / 空 / 其它 ref → null", () => {
    expect(parseCurrentBranchOutput("refs/heads/main\n")).toBe("main");
    expect(parseCurrentBranchOutput("refs/heads/feature/x.y_z\n")).toBe("feature/x.y_z");
    expect(parseCurrentBranchOutput("refs/heads/heads/foo\n")).toBe("heads/foo"); // 真有一个叫 heads/foo 的分支
    expect(parseCurrentBranchOutput("HEAD\n")).toBeNull();
    expect(parseCurrentBranchOutput("")).toBeNull();
    expect(parseCurrentBranchOutput("refs/heads/")).toBeNull();
    expect(parseCurrentBranchOutput("refs/remotes/origin/main\n")).toBeNull();
  });
});

describe("分支与同名 tag 并存：当前分支仍是精确名", () => {
  it("readGitBranchState：current 是 foo（不是 heads/foo），自己的分支不算被占用", async () => {
    const repo = makeRepo();
    git(repo, "branch", "foo");
    git(repo, "tag", "foo");
    git(repo, "checkout", "-q", "foo");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("heads/foo"); // 前提：这个仓里 git 确实会缩成 heads/foo

    const state = await readGitBranchState(repo);

    expect(state.isRepo).toBe(true);
    expect(state.current).toBe("foo");
    expect(state.occupied?.foo).toBeUndefined(); // 旧实现：{ path: repo }——自己占着自己
  });

  it("别的工作树占着、且也有同名 tag 的分支：照常列在 occupied（精确名匹配不受影响）", async () => {
    const repo = makeRepo();
    const wt = path.join(TMP, `wt-${seq}`);
    git(repo, "tag", "other");
    git(repo, "worktree", "add", "-q", "-b", "other", wt);

    const state = await readGitBranchState(repo);
    expect(state.current).toBe("main");
    expect(state.occupied?.other?.path).toBe(wt);

    const fromWt = await readGitBranchState(wt);
    expect(fromWt.current).toBe("other"); // 旧实现：heads/other
    expect(fromWt.occupied?.other).toBeUndefined();
    expect(fromWt.occupied?.main?.path).toBe(repo);
  });

  it("checkoutGitBranch：切到当前分支自己（同名 tag 并存）放行，不被占用检查拦成「已被占用」", async () => {
    const repo = makeRepo();
    git(repo, "branch", "foo");
    git(repo, "tag", "foo");
    git(repo, "checkout", "-q", "foo");

    expect(await checkoutGitBranch(repo, "foo")).toEqual({ ok: true });
    expect(head(repo)).toBe("foo");
  });

  it("checkoutGitBranch：别的工作树占着的分支（同名 tag 并存）仍被拦，报我们自己的占用说明", async () => {
    const repo = makeRepo();
    const wt = path.join(TMP, `wt-${seq}`);
    git(repo, "tag", "taken");
    git(repo, "worktree", "add", "-q", "-b", "taken", wt);

    const res = await checkoutGitBranch(repo, "taken");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(wt);
    expect(head(repo)).toBe("main");
  });

  it("变更面板：branch 是 main（不是 heads/main），onBaseBranch 比得上线上分支名", async () => {
    const repo = makeRepo();
    git(repo, "tag", "main");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("heads/main");
    fs.writeFileSync(path.join(repo, "a.txt"), "1\nchanged\n");

    const { repos } = await readTaskChanges({ mode: "chat", repoPaths: [repo], workCwd: repo }, {});

    expect(repos).toHaveLength(1);
    expect(repos[0].branch).toBe("main");
    expect(repos[0].onBaseBranch).toBe(true);
  });
});

describe("既有语义不变：unborn / detached / 普通分支 / 非仓库", () => {
  it("unborn（HEAD 指向还没有提交的分支）：current=null、readGitBranchState 照旧 isRepo=false；任何切换请求都被拒、HEAD 不动", async () => {
    const dir = path.join(TMP, `unborn-${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "symbolic-ref", "HEAD", "refs/heads/trunk");

    expect(await readGitBranchState(dir)).toEqual({ isRepo: false, current: null, branches: [] });
    for (const target of ["trunk", "HEAD", "master"]) {
      const res = await checkoutGitBranch(dir, target);
      expect(res.ok, target).toBe(false);
      expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("trunk");
    }
  });

  it("detached HEAD：current=null、仍是仓库；可以切回已有分支", async () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "--detach");

    const state = await readGitBranchState(repo);
    expect(state.isRepo).toBe(true);
    expect(state.current).toBeNull();
    expect(state.branches).toContain("main");

    expect(await checkoutGitBranch(repo, "main")).toEqual({ ok: true });
    expect(head(repo)).toBe("main");
  });

  it("普通分支（含 / . _ 的名字）：current 是精确名", async () => {
    const repo = makeRepo();
    expect((await readGitBranchState(repo)).current).toBe("main");
    git(repo, "checkout", "-q", "-b", "feature/x.y_z");
    expect((await readGitBranchState(repo)).current).toBe("feature/x.y_z");
    // 看起来像 heads/ 前缀、但确实就是分支名
    git(repo, "checkout", "-q", "-b", "heads/real");
    expect((await readGitBranchState(repo)).current).toBe("heads/real");
  });

  it("非 git 目录：照旧 isRepo=false", async () => {
    const plain = path.join(TMP, `plain-${++seq}`);
    fs.mkdirSync(plain, { recursive: true });
    expect(await readGitBranchState(plain)).toEqual({ isRepo: false, current: null, branches: [] });
  });
});
