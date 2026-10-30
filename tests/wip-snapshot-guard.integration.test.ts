/**
 * WIP 快照守卫的旁路（第三轮 review D2b-15 / F1-05 / D2b-01 / F1-04）——真 git 临时仓。
 *
 * 守卫的口径是「脏且存不下就别删」。下面这些场景此前都被判成 clean / 被裸 `fs.rm` 绕过：
 *  - 子模块里有未提交改动：父仓 tree 只记子模块指针，`add -A` + `write-tree` 与 HEAD 相同 → clean → 整目录删掉；
 *  - 未跟踪的嵌套 git 仓：快照只写一个 gitlink，嵌套仓里的内容（含它自己的未提交改动）随目录丢；
 *  - 存储页「删除残留工作区」：裸 `fs.rm`，而守卫「保留」下来的恰好就是出现在这个列表里的那批。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

import type { Task } from "@/lib/types";

const TMP_ROOT = path.join(os.tmpdir(), `fe-wip-guard-it-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import {
  cleanupStaleTaskWorktrees,
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  getTaskWorktreesDir,
  removeTaskWorktrees,
  wipSnapshotRefName,
} from "@/lib/server/task-worktrees";

const DATA_DIR = process.env.FLOWSHIP_DATA_DIR!;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
/** 本机 file:// 子模块在 git ≥ 2.38.1 需要显式放行（无网络、只读本地路径） */
const gitFile = (cwd: string, ...args: string[]): string =>
  git(cwd, "-c", "protocol.file.allow=always", ...args);

const markTaskAlive = async (taskId: string): Promise<void> => {
  await fs.mkdir(path.join(DATA_DIR, "tasks", taskId), { recursive: true });
};
const markTaskDeleted = async (taskId: string): Promise<void> => {
  await fs.rm(path.join(DATA_DIR, "tasks", taskId), { recursive: true, force: true });
};

const initRepo = async (name: string): Promise<string> => {
  const repo = path.join(TMP_ROOT, name);
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t.local");
  git(repo, "config", "user.name", "t");
  await fs.writeFile(path.join(repo, "f.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  return repo;
};

let seq = 0;
const makeTask = (repo: string, tag: string): Task => {
  seq += 1;
  const story = 700000 + seq;
  return {
    id: `t_1700000009${String(seq).padStart(3, "0")}_${tag}`,
    mode: "task",
    title: "守卫旁路",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: [repo],
    isolateWorktree: true,
    repoBaseBranches: { [repo]: "main" },
    feishuStoryUrl: `https://project.feishu.cn/x/story/detail/${story}`,
    actions: [],
    mrs: [],
  } as unknown as Task;
};

/**
 * 建子模块仓（主仓 + 子仓 + worktree + submodule update）的用例：隔离跑也要 0.7–1.3 秒，
 * 全量并行时被放大到 5 秒以上（本机全量实测超时过一次）。CI 的 2 核机器更慢，别靠默认 5s 碰运气。
 * 凡是调 setupSubmoduleTask 的用例都带上它（只放宽超时、不改任何断言）。
 */
const SUBMODULE_TEST_MS = 60_000;

/** 带一个子模块（vendor/sub）的主仓 + 在 worktree 里把子模块拉起来 */
const setupSubmoduleTask = async (tag: string) => {
  const sub = await initRepo(`${tag}-sub`);
  const repo = await initRepo(`${tag}-main`);
  gitFile(repo, "submodule", "add", sub, "vendor/sub");
  git(repo, "commit", "-m", "add submodule");
  const t = makeTask(repo, tag);
  await markTaskAlive(t.id);
  await ensureTaskWorktrees(t, () => true);
  const wd = getTaskWorkRepoPaths(t)[0];
  gitFile(wd, "submodule", "update", "--init");
  return { repo, t, wd };
};

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("D2b-15：子模块里的未提交改动不得被判 clean", () => {
  it("子模块里改了 tracked 文件 → 快照失败、目录与改动原样保留、原因点名子模块", async () => {
    const { repo, t, wd } = await setupSubmoduleTask("sm-tracked");
    await fs.writeFile(path.join(wd, "vendor", "sub", "f.txt"), "DIRTY IN SUBMODULE\n");
    // 前提：父仓看这个子模块——v1 porcelain 只有 ` M vendor/sub`，快照树与 HEAD 树相同（这就是旧实现判 clean 的原因）
    expect(git(wd, "status", "--porcelain")).toContain("vendor/sub");

    const removed = await removeTaskWorktrees(t);
    expect(removed.removedAny).toBe(false);
    expect(removed.snapshotFailedRepos).toEqual([repo]);
    expect(removed.snapshotFailures![0].reason).toContain("子模块");
    expect(removed.snapshotFailures![0].reason).toContain("vendor/sub");
    await expect(
      fs.readFile(path.join(wd, "vendor", "sub", "f.txt"), "utf8"),
    ).resolves.toBe("DIRTY IN SUBMODULE\n");
    expect(git(repo, "worktree", "list")).toContain(wd);
  }, SUBMODULE_TEST_MS);

  it("子模块里只有未跟踪的新文件（S..U）同样保留", async () => {
    const { repo, t, wd } = await setupSubmoduleTask("sm-untracked");
    await fs.writeFile(path.join(wd, "vendor", "sub", "scratch.md"), "只在子模块里\n");

    const removed = await removeTaskWorktrees(t);
    expect(removed.snapshotFailedRepos).toEqual([repo]);
    await expect(
      fs.readFile(path.join(wd, "vendor", "sub", "scratch.md"), "utf8"),
    ).resolves.toBe("只在子模块里\n");
  }, SUBMODULE_TEST_MS);

  it("用户配了 diff.ignoreSubmodules=all（git status 默认就不报子模块）也拦得住——守卫强制 --ignore-submodules=none", async () => {
    const { repo, t, wd } = await setupSubmoduleTask("sm-ignoreall");
    git(repo, "config", "diff.ignoreSubmodules", "all");
    await fs.writeFile(path.join(wd, "vendor", "sub", "f.txt"), "dirty\n");
    expect(git(wd, "status", "--porcelain")).toBe(""); // 配置确实把它藏起来了

    const removed = await removeTaskWorktrees(t);
    expect(removed.snapshotFailedRepos).toEqual([repo]);
    expect(removed.removedAny).toBe(false);
  }, SUBMODULE_TEST_MS);

  it("对照：子模块干净时照常清理（不误伤）", async () => {
    const { repo, t, wd } = await setupSubmoduleTask("sm-clean");
    const removed = await removeTaskWorktrees(t);
    expect(removed.snapshotFailedRepos).toEqual([]);
    expect(removed.removedAny).toBe(true);
    await expect(fs.access(wd)).rejects.toThrow();
    expect(git(repo, "worktree", "list")).not.toContain(wd);
  }, SUBMODULE_TEST_MS);
});

describe("F1-05：未跟踪的嵌套 git 仓不得被「快照成 gitlink」后静默丢内容", () => {
  it("嵌套仓有提交（AI 脚手架 create-xxx 常见）：快照失败、目录保留、原因点名嵌套仓", async () => {
    const repo = await initRepo("nested-committed");
    const t = makeTask(repo, "nested");
    await markTaskAlive(t.id);
    await ensureTaskWorktrees(t, () => true);
    const wd = getTaskWorkRepoPaths(t)[0];
    const nested = path.join(wd, "scaffold");
    await fs.mkdir(nested, { recursive: true });
    git(nested, "init", "-b", "main");
    git(nested, "config", "user.email", "n@n.local");
    git(nested, "config", "user.name", "n");
    await fs.writeFile(path.join(nested, "inner.txt"), "inner\n");
    git(nested, "add", "-A");
    git(nested, "commit", "-m", "inner");
    await fs.writeFile(path.join(nested, "inner.txt"), "inner, then edited\n");

    const removed = await removeTaskWorktrees(t);
    expect(removed.snapshotFailedRepos).toEqual([repo]);
    expect(removed.snapshotFailures![0].reason).toContain("嵌套");
    expect(removed.snapshotFailures![0].reason).toContain("scaffold");
    await expect(fs.readFile(path.join(nested, "inner.txt"), "utf8")).resolves.toBe(
      "inner, then edited\n",
    );
  });

  it("对照：普通未跟踪目录（里面没有 .git）照常快照后清理", async () => {
    const repo = await initRepo("nested-plain");
    const t = makeTask(repo, "plain");
    await markTaskAlive(t.id);
    await ensureTaskWorktrees(t, () => true);
    const wd = getTaskWorkRepoPaths(t)[0];
    await fs.mkdir(path.join(wd, "docs", "deep"), { recursive: true });
    await fs.writeFile(path.join(wd, "docs", "deep", "note.md"), "normal dir\n");

    const removed = await removeTaskWorktrees(t);
    expect(removed.snapshotFailedRepos).toEqual([]);
    expect(removed.snapshotRepos).toEqual([repo]);
    expect(git(repo, "show", `${removed.snapshots![0].ref}:docs/deep/note.md`)).toBe(
      "normal dir",
    );
  });
});

describe("D2b-01 / F1-04：残留工作区清理（存储页）复用 WIP 快照守卫", () => {
  /** 造一个「任务已删、worktree 目录残留」的现场 */
  const setupStale = async (tag: string) => {
    const repo = await initRepo(`${tag}-repo`);
    const t = makeTask(repo, tag);
    await markTaskAlive(t.id);
    await ensureTaskWorktrees(t, () => true);
    const wd = getTaskWorkRepoPaths(t)[0];
    const dirName = path.basename(wd);
    await markTaskDeleted(t.id);
    return { repo, t, wd, dirName };
  };

  it("脏但存得下：先落 ref（taskBranch:null → 不动任何分支）再删目录、worktree 登记一并清掉", async () => {
    const { repo, t, wd, dirName } = await setupStale("stale-ok");
    const branch = git(wd, "branch", "--show-current");
    const branchTip = git(repo, "rev-parse", branch);
    await fs.writeFile(path.join(wd, "precious.txt"), "do-not-lose\n");

    const res = await cleanupStaleTaskWorktrees(t.id);
    expect(res.kept).toEqual([]);
    expect(res.removedDirs).toEqual([dirName]);
    expect(res.snapshots).toHaveLength(1);
    const ref = wipSnapshotRefName(t.id, dirName);
    expect(res.snapshots[0].ref).toBe(ref);
    expect(git(repo, "show", `${ref}:precious.txt`)).toBe("do-not-lose");
    // 任务已删：只写 ref、不动任务分支
    expect(git(repo, "rev-parse", branch)).toBe(branchTip);
    // 目录没了、原仓的 worktree 登记也清了（否则分支继续报 already checked out）
    await expect(fs.access(getTaskWorktreesDir(t.id))).rejects.toThrow();
    expect(git(repo, "worktree", "list")).not.toContain(wd);
  });

  it("脏且存不下（ref 名被占）：不删、返回 kept+原因；改动原样在；修好后再清成功", async () => {
    const { repo, t, wd, dirName } = await setupStale("stale-keep");
    await fs.writeFile(path.join(wd, "precious.txt"), "do-not-lose\n");
    const ref = wipSnapshotRefName(t.id, dirName);
    git(repo, "update-ref", `${ref}/blocker`, "HEAD");

    const res = await cleanupStaleTaskWorktrees(t.id);
    expect(res.removedDirs).toEqual([]);
    expect(res.kept).toHaveLength(1);
    expect(res.kept[0].dirName).toBe(dirName);
    expect(res.kept[0].reason).toContain("update-ref");
    await expect(fs.readFile(path.join(wd, "precious.txt"), "utf8")).resolves.toBe(
      "do-not-lose\n",
    );
    expect(git(repo, "worktree", "list")).toContain(wd);

    git(repo, "update-ref", "-d", `${ref}/blocker`);
    const retry = await cleanupStaleTaskWorktrees(t.id);
    expect(retry.kept).toEqual([]);
    expect(retry.removedDirs).toEqual([dirName]);
    expect(git(repo, "show", `${ref}:precious.txt`)).toBe("do-not-lose");
  });

  it("R14 Q10-04：快照用的是临时 index（GIT_INDEX_FILE 经 runGit 的 extraEnv 传下去）——存不下而保留的目录里，用户真实的暂存区没被 `add -A` 改写", async () => {
    const { repo, t, wd, dirName } = await setupStale("stale-index");
    await fs.writeFile(path.join(wd, "precious.txt"), "do-not-lose\n"); // 未跟踪
    await fs.writeFile(path.join(wd, "f.txt"), "edited\n"); // 已跟踪、未暂存
    expect(git(wd, "diff", "--cached", "--name-only"), "前提：现场里没有任何已暂存的东西").toBe("");
    git(repo, "update-ref", `${wipSnapshotRefName(t.id, dirName)}/blocker`, "HEAD"); // ref 名被占 → 快照存不下 → 目录保留

    const res = await cleanupStaleTaskWorktrees(t.id);

    expect(res.kept, "前提：快照确实跑到了 add -A / write-tree、并在落 ref 时失败").toHaveLength(1);
    expect(res.kept[0].reason).toContain("update-ref");
    expect(
      git(wd, "diff", "--cached", "--name-only"),
      "快照把改动暂存进了用户的真实 index（临时 index 没生效）",
    ).toBe("");
    expect(git(wd, "diff", "--name-only"), "已跟踪的改动仍是未暂存").toBe("f.txt");
    expect(git(wd, "ls-files", "--others", "--exclude-standard"), "未跟踪文件仍是未跟踪").toBe(
      "precious.txt",
    );
  });

  it("脏子模块的残留目录同样被拦（D2b-15 在这个入口也不能漏）", async () => {
    const { repo, t, wd } = await (async () => {
      const s = await setupSubmoduleTask("stale-sm");
      await markTaskDeleted(s.t.id);
      return s;
    })();
    await fs.writeFile(path.join(wd, "vendor", "sub", "f.txt"), "DIRTY\n");

    const res = await cleanupStaleTaskWorktrees(t.id);
    expect(res.removedDirs).toEqual([]);
    expect(res.kept[0].reason).toContain("子模块");
    await expect(fs.readFile(path.join(wd, "vendor", "sub", "f.txt"), "utf8")).resolves.toBe(
      "DIRTY\n",
    );
    expect(git(repo, "worktree", "list")).toContain(wd);
  }, SUBMODULE_TEST_MS);

  it("force：用户在确认框里明确选「仍然删除」才越过守卫（没有这个出口，原仓被移走的残留目录永远删不掉）", async () => {
    const { repo, t, wd, dirName } = await setupStale("stale-force");
    await fs.writeFile(path.join(wd, "precious.txt"), "x\n");
    const ref = wipSnapshotRefName(t.id, dirName);
    git(repo, "update-ref", `${ref}/blocker`, "HEAD");

    const res = await cleanupStaleTaskWorktrees(t.id, { force: true });
    expect(res.kept).toEqual([]);
    expect(res.removedDirs).toEqual([dirName]);
    await expect(fs.access(wd)).rejects.toThrow();
    // 登记也清掉
    expect(git(repo, "worktree", "list")).not.toContain(wd);
  });

  it("干净 / 半截目录（没有 .git）直接清，不产生快照", async () => {
    const { t, wd, dirName } = await setupStale("stale-clean");
    const res = await cleanupStaleTaskWorktrees(t.id);
    expect(res.snapshots).toEqual([]);
    expect(res.kept).toEqual([]);
    expect(res.removedDirs).toEqual([dirName]);
    await expect(fs.access(wd)).rejects.toThrow();

    // 只剩依赖克隆残留的半截目录
    const half = path.join(getTaskWorktreesDir("t_1700000009999_half"), "half-dir");
    await fs.mkdir(half, { recursive: true });
    await fs.writeFile(path.join(half, "leftover.txt"), "x\n");
    const res2 = await cleanupStaleTaskWorktrees("t_1700000009999_half");
    expect(res2.kept).toEqual([]);
    expect(res2.removedDirs).toEqual(["half-dir"]);
    await expect(fs.access(half)).rejects.toThrow();
  });
});
