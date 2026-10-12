/**
 * 分支被其他工作树占用：真 git 端到端（临时目录里真建 worktree）
 *
 * 复现的就是用户截图里的场景：主仓在 main，另一个 worktree 占着 `fix/windows-install-update-startup`，
 * 在分支选择器里点它 → 以前 toast「致命错误：'…' 已经检出到 '…'」（git 原文、随系统语言变）。
 *
 * 这里不去断言任何 git 报错文案——断言的是「我们自己算出来的占用关系」和「我们自己的报错」，
 * 这才是跨语言 / 跨 git 版本稳定的东西。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkoutGitBranch, readGitBranchState } from "@/lib/server/git-branches";
import { occupantOf } from "@/lib/git-branch-occupancy";

// 在 git hook 里跑测试时这些变量会指向「外层仓」，让测试里的 git 命令全跑偏
const LEAKY_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

// macOS 的 tmpdir 在 /var → /private/var 的软链下，git 吐的是真实路径，比对前统一取 realpath
const TMP = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "flowship-occ-it-")),
);
const REPO = path.join(TMP, "main-repo");
/** 路径带空格：任务隔离工作区就在 `Application Support` 下，必须覆盖 */
const WT_A = path.join(TMP, "wt a", "feature-a");
const WT_DETACHED = path.join(TMP, "wt-detached");
const WT_PROTO = path.join(TMP, "wt-proto");

// stderr 吞掉：git init 会打一大段「默认分支名」的 hint，纯噪音；失败时 execFileSync 的异常里仍带 stderr
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const currentBranch = (cwd: string): string =>
  git(cwd, "rev-parse", "--abbrev-ref", "HEAD");

beforeAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, "init", "-q");
  // 不用 init -b：旧 git 不认；直接把 unborn HEAD 指到 main
  git(REPO, "symbolic-ref", "HEAD", "refs/heads/main");
  git(REPO, "config", "user.email", "t@example.com");
  git(REPO, "config", "user.name", "tester");
  git(REPO, "commit", "-q", "--allow-empty", "-m", "init");
  for (const b of ["feature/a", "feature/b", "constructor"]) git(REPO, "branch", b);
  // 被占用：feature/a 在 WT_A（路径带空格）
  fs.mkdirSync(path.dirname(WT_A), { recursive: true });
  git(REPO, "worktree", "add", "-q", WT_A, "feature/a");
  // detached：不占任何分支
  git(REPO, "worktree", "add", "-q", "--detach", WT_DETACHED);
  // 分支名叫 __proto__ 的占用——考验 Record 的 key 安全
  git(REPO, "worktree", "add", "-q", "-b", "__proto__", WT_PROTO);
}, 60_000);

afterAll(() => {
  for (const k of LEAKY_GIT_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("readGitBranchState：occupied", () => {
  it("主仓视角：别的工作树占着的分支列在 occupied，路径是那个工作树", async () => {
    const state = await readGitBranchState(REPO);
    expect(state.isRepo).toBe(true);
    expect(state.current).toBe("main");
    expect(state.occupied?.["feature/a"]).toEqual({ path: WT_A, missing: false });
    // 占用的分支仍然在 branches 里（只是选择器要置灰它、不是把它从列表里藏起来）
    expect(state.branches).toContain("feature/a");
  });

  it("当前分支、没人占的分支、detached 工作树都不算占用", async () => {
    const state = await readGitBranchState(REPO);
    const keys = Object.keys(state.occupied ?? {}).sort();
    expect(keys).toEqual(["__proto__", "feature/a"]);
    expect(occupantOf(state.occupied, "main")).toBeUndefined(); // 当前分支自己
    expect(occupantOf(state.occupied, "feature/b")).toBeUndefined(); // 没人占
  });

  it("分支叫 __proto__ 是自有属性；叫 constructor 但没被占用的分支不会被误判", async () => {
    const state = await readGitBranchState(REPO);
    expect(Object.getPrototypeOf(state.occupied)).toBe(Object.prototype);
    expect(occupantOf(state.occupied, "__proto__")?.path).toBe(WT_PROTO);
    expect(state.branches).toContain("constructor");
    expect(occupantOf(state.occupied, "constructor")).toBeUndefined();
  });

  it("工作树视角：它自己的分支不算占用，反过来主仓占着的 main 会被列出", async () => {
    const state = await readGitBranchState(WT_A);
    expect(state.current).toBe("feature/a");
    expect(occupantOf(state.occupied, "feature/a")).toBeUndefined();
    expect(state.occupied?.main).toEqual({ path: REPO, missing: false });
  });

  it("没有任何额外工作树的仓：响应里不带 occupied 字段", async () => {
    const solo = path.join(TMP, "solo");
    fs.mkdirSync(solo);
    git(solo, "init", "-q");
    git(solo, "symbolic-ref", "HEAD", "refs/heads/main");
    git(solo, "config", "user.email", "t@example.com");
    git(solo, "config", "user.name", "tester");
    git(solo, "commit", "-q", "--allow-empty", "-m", "init");
    const state = await readGitBranchState(solo);
    expect(state.isRepo).toBe(true);
    expect("occupied" in state).toBe(false);
  });

  it("非 git 目录：照旧 isRepo=false、不带 occupied", async () => {
    const plain = path.join(TMP, "plain");
    fs.mkdirSync(plain);
    const state = await readGitBranchState(plain);
    expect(state).toEqual({ isRepo: false, current: null, branches: [] });
  });
});

describe("checkoutGitBranch：切换被占用的分支", () => {
  it("被占用的分支：不进 git、返回带路径的中文说明，且 HEAD 纹丝不动", async () => {
    const before = git(REPO, "rev-parse", "HEAD");
    const res = await checkoutGitBranch(REPO, "feature/a");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("feature/a");
    expect(res.error).toContain(WT_A);
    expect(res.error).toContain("不能同时检出到两个目录");
    // 回归点：不再是 git 的 fatal 原文
    expect(res.error).not.toMatch(/fatal|致命/i);
    expect(currentBranch(REPO)).toBe("main");
    expect(git(REPO, "rev-parse", "HEAD")).toBe(before);
  });

  it("没被占用的分支照常切；切到自己是 no-op、不会被误拦", async () => {
    expect(await checkoutGitBranch(REPO, "feature/b")).toEqual({ ok: true });
    expect(currentBranch(REPO)).toBe("feature/b");
    // 刚才的当前分支 main 现在没人占；feature/b 是当前分支、再切一次不能报「被占用」
    expect(await checkoutGitBranch(REPO, "feature/b")).toEqual({ ok: true });
    expect(await checkoutGitBranch(REPO, "main")).toEqual({ ok: true });
    expect(currentBranch(REPO)).toBe("main");
  });

  it("叫 constructor 的普通分支能切（key 安全）", async () => {
    expect(await checkoutGitBranch(REPO, "constructor")).toEqual({ ok: true });
    expect(currentBranch(REPO)).toBe("constructor");
    expect(await checkoutGitBranch(REPO, "main")).toEqual({ ok: true });
  });

  it("不存在的分支：仍然走 git、把 git 的报错带回（我们只拦占用、不吞别的错）", async () => {
    const res = await checkoutGitBranch(REPO, "no/such-branch");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toContain("不能同时检出");
    expect(res.error.length).toBeGreaterThan(0);
  });
});

// 垫片是 sh 脚本：Windows 上没有，跳过（降级逻辑本身与平台无关）
describe.skipIf(process.platform === "win32")(
  "git worktree 子命令不可用（老 git / 超时）：降级、不连累分支列表",
  () => {
    it("列表照常返回（只是没有 occupied）；切换照旧交给 git、不抛", async () => {
      // 在 PATH 最前面放一个 git 垫片：worktree 子命令一律失败，其余原样转给真 git
      const binDir = fs.mkdtempSync(path.join(TMP, "fakebin-"));
      const realGit = execFileSync("sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).trim();
      fs.writeFileSync(
        path.join(binDir, "git"),
        `#!/bin/sh\nif [ "$1" = "worktree" ]; then echo "unknown subcommand" >&2; exit 129; fi\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 },
      );
      const prevPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ""}`;
      try {
        const state = await readGitBranchState(REPO);
        expect(state.isRepo).toBe(true);
        expect(state.current).toBe("main");
        expect(state.branches).toContain("feature/a");
        expect("occupied" in state).toBe(false);

        // 拿不到占用信息就没资格替 git 拦：交给 git 自己拒（它仍会拒绝、HEAD 不动）
        const res = await checkoutGitBranch(REPO, "feature/a");
        expect(res.ok).toBe(false);
      } finally {
        process.env.PATH = prevPath;
      }
      expect(currentBranch(REPO)).toBe("main");
    });
  },
);

describe("工作树目录被手动删掉、git 里还留着登记", () => {
  // 放在最后：会改动 WT_A 的磁盘状态
  it("标 missing；切换给出 git worktree prune 的办法；prune 之后就能切了", async () => {
    fs.rmSync(path.join(TMP, "wt a"), { recursive: true, force: true });

    const state = await readGitBranchState(REPO);
    expect(state.occupied?.["feature/a"]).toEqual({ path: WT_A, missing: true });

    const blocked = await checkoutGitBranch(REPO, "feature/a");
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error).toContain("git worktree prune");
    expect(blocked.error).not.toContain("请先在那个目录里切走");
    expect(currentBranch(REPO)).toBe("main");

    git(REPO, "worktree", "prune");
    const after = await readGitBranchState(REPO);
    expect(occupantOf(after.occupied, "feature/a")).toBeUndefined();
    expect(await checkoutGitBranch(REPO, "feature/a")).toEqual({ ok: true });
    expect(currentBranch(REPO)).toBe("feature/a");
  });
});
