/**
 * checkoutGitBranch 只能切到「已有的分支」。
 *
 * 旧行为：只拒绝 `-` 开头，其余原样交给 `git checkout <b> --`——`HEAD~3` / sha / 标签都会被检出成 detached HEAD，
 * 用户以为在「切分支」，实际脱离了分支（之后的提交没有分支指着）。40 位 sha 语法上也是合法 refname，`check-ref-format` 拦不住，
 * 所以必须看 `refs/heads/<b>` / `refs/remotes/<remote>/<b>` 是否真存在。
 * 现有合法分支名（含 `/` `.` `_`、叫 constructor 的、远端独有的 DWIM）不能被误拒。
 *
 * 真 git + 临时仓库（同 git-branches-occupancy.integration.test.ts 的夹具写法）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { checkoutGitBranch } from "@/lib/server/git-branches";

const LEAKY_GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"] as const;
const saved: Record<string, string | undefined> = {};
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "flowship-checkout-existing-")));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
/**
 * 当前分支（精确名）；detached HEAD 时是字面量 HEAD。
 * 不用 `rev-parse --abbrev-ref`：分支与同名标签并存时它会输出 `heads/<name>`。
 */
const head = (cwd: string): string => {
  try {
    return git(cwd, "symbolic-ref", "--quiet", "HEAD").replace(/^refs\/heads\//, "");
  } catch {
    return "HEAD";
  }
};

let REPO = "";
let FIRST_SHA = "";

beforeAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GIT_CONFIG_GLOBAL = path.join(TMP, "gitconfig-empty");
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  const origin = path.join(TMP, "origin.git");
  REPO = path.join(TMP, "repo");
  git(TMP, "init", "-q", "--bare", origin);
  git(TMP, "clone", "-q", origin, REPO);
  git(REPO, "symbolic-ref", "HEAD", "refs/heads/main");
  git(REPO, "config", "user.email", "t@example.com");
  git(REPO, "config", "user.name", "tester");
  fs.writeFileSync(path.join(REPO, "a.txt"), "1\n");
  git(REPO, "add", "-A");
  git(REPO, "commit", "-q", "-m", "c1");
  FIRST_SHA = git(REPO, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(REPO, "a.txt"), "2\n");
  git(REPO, "commit", "-q", "-am", "c2");
  git(REPO, "push", "-q", "-u", "origin", "main");
  // 各种合法分支名 + 一个标签 + 一个只在远端的分支
  for (const b of ["feature/x.y_z", "release-1.2", "constructor", "feat/中文分支"]) git(REPO, "branch", b);
  git(REPO, "tag", "v1", FIRST_SHA);
  git(REPO, "branch", "remote-only");
  git(REPO, "push", "-q", "origin", "remote-only");
  git(REPO, "branch", "-q", "-D", "remote-only");
  // 远端独有分支 + 同名标签：`git checkout remote-tagged --` 会被标签抢走、检出成 detached HEAD
  git(REPO, "branch", "remote-tagged");
  git(REPO, "push", "-q", "origin", "remote-tagged");
  git(REPO, "branch", "-q", "-D", "remote-tagged");
  git(REPO, "tag", "remote-tagged", FIRST_SHA);
  // 远端分支叫 feature/deep、本地敲 `deep`（只是它的后缀）+ 恰有标签 deep：旧的 endsWith 判定会放行、再被标签抢成 detached
  git(REPO, "branch", "feature/deep");
  git(REPO, "push", "-q", "origin", "feature/deep");
  git(REPO, "branch", "-q", "-D", "feature/deep");
  git(REPO, "tag", "deep", FIRST_SHA);
  git(REPO, "fetch", "-q", "origin");
});

beforeEach(() => {
  git(REPO, "checkout", "-q", "main");
});

afterAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("checkoutGitBranch：拒绝 commit-ish（不会进入 detached HEAD）", () => {
  it.each([
    ["相对引用 HEAD~1", "HEAD~1"],
    ["HEAD 本身", "HEAD"],
    ["HEAD^", "HEAD^"],
    ["@{-1}（上一个分支的简写）", "@{-1}"],
    ["标签 v1", "v1"],
    ["以 - 开头", "-b"],
  ])("%s", async (_label, target) => {
    const before = head(REPO);
    const res = await checkoutGitBranch(REPO, target);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
    expect(head(REPO)).toBe(before); // 仍在原分支、没有 detached
  });

  it("完整 sha / 短 sha（语法上是合法 refname）也拒绝", async () => {
    for (const target of [FIRST_SHA, FIRST_SHA.slice(0, 7)]) {
      const res = await checkoutGitBranch(REPO, target);
      expect(res.ok, target).toBe(false);
      expect(head(REPO)).not.toBe("HEAD");
    }
  });

  it("拒绝的错误文案点明原因（不是 git 的 fatal 原文）", async () => {
    const res = await checkoutGitBranch(REPO, "HEAD~3");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("HEAD~3");
    expect(res.error).toContain("detached HEAD");
  });
});

describe("checkoutGitBranch：合法分支名照常切（不被误拒）", () => {
  it.each(["feature/x.y_z", "release-1.2", "constructor", "feat/中文分支", "main"])("本地分支 %s", async (b) => {
    expect(await checkoutGitBranch(REPO, b)).toEqual({ ok: true });
    expect(head(REPO)).toBe(b);
  });

  it("切到当前分支自己：no-op、放行", async () => {
    expect(await checkoutGitBranch(REPO, "main")).toEqual({ ok: true });
    expect(await checkoutGitBranch(REPO, "main")).toEqual({ ok: true });
  });

  it("远端独有分支：DWIM 仍生效（自动建跟踪分支并切过去）", async () => {
    expect(await checkoutGitBranch(REPO, "remote-only")).toEqual({ ok: true });
    expect(head(REPO)).toBe("remote-only");
    expect(await checkoutGitBranch(REPO, "main")).toEqual({ ok: true });
  });

  it("detached HEAD 状态下切回已有分支：放行", async () => {
    git(REPO, "checkout", "-q", "--detach", FIRST_SHA);
    expect(head(REPO)).toBe("HEAD");
    expect(await checkoutGitBranch(REPO, "main")).toEqual({ ok: true });
    expect(head(REPO)).toBe("main");
  });

  it("不存在的分支名：被拒、HEAD 不动", async () => {
    const res = await checkoutGitBranch(REPO, "no/such-branch");
    expect(res.ok).toBe(false);
    expect(head(REPO)).toBe("main");
  });
});

describe("checkoutGitBranch：远端精确匹配 + 显式建跟踪分支（不被同名标签抢成 detached）", () => {
  it("远端独有分支与同名标签并存：切到的是分支（有跟踪关系），不是 detached HEAD", async () => {
    expect(await checkoutGitBranch(REPO, "remote-tagged")).toEqual({ ok: true });
    expect(head(REPO)).toBe("remote-tagged");
    expect(git(REPO, "config", "branch.remote-tagged.remote")).toBe("origin");
    expect(git(REPO, "config", "branch.remote-tagged.merge")).toBe("refs/heads/remote-tagged");
  });

  it("远端独有分支（无标签）：同样显式建跟踪分支", async () => {
    git(REPO, "branch", "-q", "-D", "remote-only"); // 前面的用例可能已经建过本地同名分支
    expect(await checkoutGitBranch(REPO, "remote-only")).toEqual({ ok: true });
    expect(head(REPO)).toBe("remote-only");
    expect(git(REPO, "config", "branch.remote-only.remote")).toBe("origin");
  });

  it("远端分支 origin/feature/deep 的「后缀」deep 不是分支：拒绝（旧 endsWith 会放行、再被同名标签 deep 抢成 detached）", async () => {
    const res = await checkoutGitBranch(REPO, "deep");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("不存在");
    expect(head(REPO)).toBe("main");
    // 完整名照常能切
    expect(await checkoutGitBranch(REPO, "feature/deep")).toEqual({ ok: true });
    expect(head(REPO)).toBe("feature/deep");
  });

  it("本地分支与同名标签并存：切到分支（git 优先分支）", async () => {
    git(REPO, "branch", "local-and-tag");
    git(REPO, "tag", "local-and-tag", FIRST_SHA);
    expect(await checkoutGitBranch(REPO, "local-and-tag")).toEqual({ ok: true });
    expect(head(REPO)).not.toBe("HEAD");
  });

  it("含 / 的远端名（team/up）：按 `git remote` 精确匹配，照常切", async () => {
    const up = path.join(TMP, "team-up.git");
    git(TMP, "init", "-q", "--bare", up);
    git(REPO, "push", "-q", up, "main:refs/heads/up-only");
    git(REPO, "remote", "add", "team/up", up);
    git(REPO, "fetch", "-q", "team/up");
    expect(await checkoutGitBranch(REPO, "up-only")).toEqual({ ok: true });
    expect(head(REPO)).toBe("up-only");
    expect(git(REPO, "config", "branch.up-only.remote")).toBe("team/up");
    git(REPO, "checkout", "-q", "main");
    git(REPO, "remote", "remove", "team/up");
  });

  it("多个远端有同名分支：回给 git 自己裁决（报错、HEAD 不动、不 detached）", async () => {
    const o2 = path.join(TMP, "second.git");
    git(TMP, "init", "-q", "--bare", o2);
    git(REPO, "push", "-q", o2, "main:refs/heads/both");
    git(REPO, "push", "-q", "origin", "main:refs/heads/both");
    git(REPO, "remote", "add", "second", o2);
    git(REPO, "fetch", "-q", "--all");
    const res = await checkoutGitBranch(REPO, "both");
    expect(res.ok).toBe(false);
    expect(head(REPO)).toBe("main");
    git(REPO, "remote", "remove", "second");
  });

  it("unborn 空仓（还没有任何提交）：没有已有分支可切，按「不存在」拒绝、HEAD 符号引用不变", async () => {
    const empty = path.join(TMP, "unborn");
    git(TMP, "init", "-q", "-b", "trunk", empty);
    for (const target of ["trunk", "HEAD", "master"]) {
      const res = await checkoutGitBranch(empty, target);
      expect(res.ok, target).toBe(false);
      expect(git(empty, "symbolic-ref", "--short", "HEAD")).toBe("trunk");
    }
  });
});
