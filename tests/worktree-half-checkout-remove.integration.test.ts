/**
 * R14 B5-2（Q10-01）——删除侧：6 处 `git worktree remove --force` + 1 处相邻路径（开机孤儿清理）遇到
 * 「`git worktree add` 被 SIGKILL 留下的 locked=initializing 半截检出」时的行为。
 *
 * 旧实现：`remove --force` 被 locked 拦下 → 退回 `fs.rm` + `prune`，而 prune 清不掉被锁定的登记 →
 * 目录没了、登记还在，同名分支永远报 `already checked out`。
 * 现在：只有「确认是 stale 的 initializing 锁」才升级成 `remove --force --force`（或在 prune 前先 unlock）。
 *
 * 每个入口两类用例：
 * - (a) 真 SIGKILL 残留（stale）→ 目录没了、登记没了、分支保留、**同名分支能在新路径再 add（原症状）**；
 * - (b) 用户手动 lock 的健康 worktree → **不升级**（git 包装脚本记下 argv：没有 `remove --force --force`、没有 `worktree unlock`）。
 *   这里只断言「没升级」，不断言 remove 失败之后各入口既有的 `fs.rm` + `prune` 兜底的结果——那是 B5-2 之前就有的行为，不在 Q10-01 范围。
 * 另有 live（刚杀、locked 才几秒）不升级的用例，和 stale 残留的删任务**不往任务分支记「删光」的 WIP**（快照 taskBranch=null）的用例。
 *
 * 真 git + 真 SIGKILL（见 tests/helpers/half-checkout.ts）；Windows 上整组跳过——**Windows 未验证**。
 * 例外（如实标注）：#2 失主补偿那一支**不是 SIGKILL 真复现**——补偿时 add 刚成功、git 已经删了 `locked`，现实中不会遇到 initializing；
 * 这里在 failpoint 里手工把 `locked` 写成 `initializing` 来约束 helper 的行为（防御性路径）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";
import {
  ageLock,
  branchTip,
  exists,
  git,
  gitOk,
  hermeticGitEnv,
  initRepoForHalfCheckout,
  installGitShim,
  isRegistered,
  killAddMidCheckout,
  readLocked,
  REPO_FILES,
  type GitShim,
} from "./helpers/half-checkout";

hermeticGitEnv();
const TMP_ROOT = path.join(os.tmpdir(), `fe-half-checkout-remove-${process.pid}-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
const DATA_DIR = process.env.FLOWSHIP_DATA_DIR;

import { clearFailpoints, setFailpoint } from "@/lib/server/failpoints";
import {
  cleanupOrphanTaskWorktrees,
  cleanupStaleTaskWorktrees,
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  removeTaskWorktrees,
  syncTaskWorktreesToRepoPaths,
  WorktreeLeaseLostError,
  wipSnapshotRefName,
} from "@/lib/server/task-worktrees";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const TITLE = "半截检出";
const BRANCH = "feature/888888-半截检出";
const STALE = 10 * 60_000;

const makeTask = (repos: string[], id: string, title = TITLE): Task =>
  ({
    id,
    mode: "task",
    title,
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: repos,
    isolateWorktree: true,
    repoBaseBranches: Object.fromEntries(repos.map((r) => [r, "main"])),
    // 与 ensure 渲染出的分支一致：removeTaskWorktrees / sync 的快照口径要看它
    gitBranches: repos.map((r) => ({ repoPath: r, name: BRANCH, baseBranch: "main" })),
    feishuStoryUrl: "https://project.feishu.cn/x/story/detail/888888",
    actions: [],
    mrs: [],
  }) as unknown as Task;

const markTaskAlive = async (taskId: string): Promise<void> => {
  await fs.mkdir(path.join(DATA_DIR, "tasks", taskId), { recursive: true });
};
const markTaskDeleted = async (taskId: string): Promise<void> => {
  await fs.rm(path.join(DATA_DIR, "tasks", taskId), { recursive: true, force: true });
};

let seq = 0;
const nextId = (): string => `t_17000000${String(++seq).padStart(5, "0")}_rm`;

const newCase = async () => {
  const repo = path.join(TMP_ROOT, `repo-${++seq}`);
  await initRepoForHalfCheckout(repo);
  const task = makeTask([repo], `t_17000000${String(seq).padStart(5, "0")}_rm`);
  await markTaskAlive(task.id);
  return { repo, task, workDir: getTaskWorkRepoPaths(task)[0] };
};

const registeredCount = (repo: string): number =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;

const expectFullCheckout = async (dir: string): Promise<void> => {
  for (const [name, content] of Object.entries(REPO_FILES)) {
    expect(await fs.readFile(path.join(dir, name), "utf8"), `${dir}/${name}`).toBe(content);
  }
};

/** 原症状：同名分支能在一个新路径上再 add（旧实现留下僵尸登记后永远报 already checked out） */
const canReAddBranch = (repo: string, branch: string): boolean => {
  const probe = path.join(TMP_ROOT, `probe-${++seq}`);
  const ok = gitOk(repo, "worktree", "add", probe, branch);
  if (ok) git(repo, "worktree", "remove", "--force", probe);
  return ok;
};

/** 健康 worktree + 用户手动 lock（reason 是「我的锁」） */
const makeUserLockedWorktree = async (repo: string, workDir: string): Promise<void> => {
  await fs.mkdir(path.dirname(workDir), { recursive: true });
  git(repo, "worktree", "add", "--no-track", "-b", BRANCH, workDir, "main");
  git(repo, "worktree", "lock", "--reason", "我的锁", workDir);
};

/** 断言：期间没有升级成 `remove --force --force`、也没有 `worktree unlock` */
const expectNoEscalation = async (s: GitShim): Promise<void> => {
  const calls = await s.calls();
  expect(calls.filter((c) => /worktree remove --force --force/.test(c))).toEqual([]);
  expect(calls.filter((c) => /worktree unlock/.test(c))).toEqual([]);
};

let shim: GitShim | null = null;
afterEach(async () => {
  clearFailpoints();
  shim?.restore();
  shim = null;
  await import("@/lib/server/worktree-residue").then(
    (m) => m.__resetWorktreeAddInFlightForTest(),
    () => {
      /* 基线（改动前）没有这个模块 */
    },
  );
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")(
  "R14 B5-2 删除侧：6 处 remove --force + 开机孤儿清理（真 git + 真 SIGKILL）",
  () => {
    // ───────────────────────── #1 tryReleaseDeletedTaskOrphan ─────────────────────────
    describe("#1 tryReleaseDeletedTaskOrphan（新任务撞「已删任务」孤儿占用分支）", () => {
      it("(a) 孤儿是 stale 半截检出 → 释放后新任务 ensure 成功；孤儿目录与登记都没了；分支 tip 不变；半截里的文件保全在 WIP ref", async () => {
        const { repo, task: t1, workDir: wd1 } = await newCase();
        const killed = await killAddMidCheckout({ repo, workDir: wd1, branch: BRANCH });
        await ageLock(killed.lockFile, STALE);
        await markTaskDeleted(t1.id);
        const t2 = makeTask([repo], nextId());
        await markTaskAlive(t2.id);
        const tipBefore = branchTip(repo, BRANCH);

        const res = await ensureTaskWorktrees(t2, () => true);

        expect(res.createdRepos).toEqual([repo]);
        const wd2 = getTaskWorkRepoPaths(t2)[0];
        await expectFullCheckout(wd2);
        expect(git(wd2, "branch", "--show-current")).toBe(BRANCH);
        expect(await exists(wd1)).toBe(false);
        expect(isRegistered(repo, wd1)).toBe(false);
        expect(registeredCount(repo)).toBe(2);
        expect(branchTip(repo, BRANCH)).toBe(tipBefore); // 快照 taskBranch=null：不往分支上记 WIP
        expect(git(repo, "show", `${wipSnapshotRefName(t1.id, path.basename(wd1))}:a.txt`)).toBe("a");
      });

      it("(b) 孤儿是用户手动 lock 的健康 worktree → 不升级（remove --force 失败后走既有的 fs.rm + prune 兜底）", async () => {
        const { repo, task: t1, workDir: wd1 } = await newCase();
        await makeUserLockedWorktree(repo, wd1);
        await markTaskDeleted(t1.id);
        const t2 = makeTask([repo], nextId());
        await markTaskAlive(t2.id);
        shim = await installGitShim(path.join(TMP_ROOT, `shim-${seq}`));

        // 结果（ensure 成功与否）取决于既有兜底，不在本用例断言范围；只要求：没有升级、没有解锁
        await ensureTaskWorktrees(t2, () => true).catch(() => {});

        const calls = await shim.calls();
        expect(calls.some((c) => /worktree remove --force /.test(c) && !/--force --force/.test(c))).toBe(true); // 确实走到了 remove 路径
        await expectNoEscalation(shim);
      });
    });

    // ───────────────────────── #2 compensateRemoveCreatedWorktrees ─────────────────────────
    describe("#2 compensateRemoveCreatedWorktrees（失主补偿）——注意：不是 SIGKILL 真复现，locked 是在 failpoint 里手工写的", () => {
      it("(a) 补偿时登记带 stale 的 initializing 锁 → 升级后目录与登记都清掉、分支保留、同名分支能再 add", async () => {
        const { repo, task, workDir } = await newCase();
        let leaseOk = true;
        setFailpoint("worktree.afterAdd", async () => {
          const adminDir = git(workDir, "rev-parse", "--absolute-git-dir");
          const lockFile = path.join(adminDir, "locked");
          await fs.writeFile(lockFile, "initializing\n");
          await ageLock(lockFile, STALE);
          leaseOk = false;
        });

        await expect(ensureTaskWorktrees(task, () => leaseOk)).rejects.toBeInstanceOf(
          WorktreeLeaseLostError,
        );

        expect(await exists(workDir)).toBe(false);
        expect(isRegistered(repo, workDir)).toBe(false);
        expect(gitOk(repo, "rev-parse", "--verify", `refs/heads/${BRANCH}`)).toBe(true);
        expect(canReAddBranch(repo, BRANCH)).toBe(true);
      });

      it("(b) 补偿时登记带用户的 lock（reason 不是 initializing）→ 不升级", async () => {
        const { task, workDir } = await newCase();
        let leaseOk = true;
        setFailpoint("worktree.afterAdd", async () => {
          const adminDir = git(workDir, "rev-parse", "--absolute-git-dir");
          const lockFile = path.join(adminDir, "locked");
          await fs.writeFile(lockFile, "我的锁\n");
          await ageLock(lockFile, STALE);
          leaseOk = false;
        });
        shim = await installGitShim(path.join(TMP_ROOT, `shim-${seq}`));

        await expect(ensureTaskWorktrees(task, () => leaseOk)).rejects.toBeInstanceOf(
          WorktreeLeaseLostError,
        );

        const calls = await shim.calls();
        expect(calls.some((c) => /worktree remove --force /.test(c) && !/--force --force/.test(c))).toBe(true);
        await expectNoEscalation(shim);
      });
    });

    // ───────────────────────── #3 removeTaskWorktrees ─────────────────────────
    describe("#3 removeTaskWorktrees（删任务）", () => {
      it("(a) stale 半截检出 → 目录与登记都清掉、分支保留且 tip 不变（不往任务分支记「删光」的 WIP）、同名分支能再 add（原症状）", async () => {
        const { repo, task, workDir } = await newCase();
        const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
        await ageLock(killed.lockFile, STALE);
        const tipBefore = branchTip(repo, BRANCH);
        expect(tipBefore).toBe(branchTip(repo, "main"));

        const removed = await removeTaskWorktrees(task);

        expect(removed.removedAny).toBe(true);
        expect(removed.snapshotFailedRepos).toEqual([]);
        expect(await exists(workDir)).toBe(false);
        expect(isRegistered(repo, workDir)).toBe(false);
        expect(registeredCount(repo)).toBe(1);
        // 快照：内容保在 ref 里，但不动任务分支（半截检出里索引是空的，快照树 = 缺了大半文件）
        expect(removed.snapshots).toHaveLength(1);
        expect(removed.snapshots![0].branch).toBeUndefined();
        expect(gitOk(repo, "show-ref", "--verify", "--quiet", removed.snapshots![0].ref)).toBe(true);
        expect(branchTip(repo, BRANCH)).toBe(tipBefore);
        expect(canReAddBranch(repo, BRANCH)).toBe(true);
      });

      it("(b) 用户手动 lock 的健康 worktree → 不升级", async () => {
        const { repo, task, workDir } = await newCase();
        await makeUserLockedWorktree(repo, workDir);
        shim = await installGitShim(path.join(TMP_ROOT, `shim-${seq}`));

        await removeTaskWorktrees(task);

        const calls = await shim.calls();
        expect(calls.some((c) => /worktree remove --force /.test(c) && !/--force --force/.test(c))).toBe(true);
        await expectNoEscalation(shim);
      });

      it("(c) live（locked 才几秒）→ 不升级", async () => {
        const { repo, task, workDir } = await newCase();
        const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
        // 不 ageLock
        shim = await installGitShim(path.join(TMP_ROOT, `shim-${seq}`));

        await removeTaskWorktrees(task);

        await expectNoEscalation(shim);
        expect(await readLocked(killed.adminDir)).toBe("initializing\n"); // 登记没被动（live 不解锁）
        expect(isRegistered(repo, workDir)).toBe(true);
      });
    });

    // ───────────────────────── #4 removeWorktreeDirAndRegistration（经 cleanupStaleTaskWorktrees） ─────────────────────────
    describe("#4 removeWorktreeDirAndRegistration（存储页「删除残留工作区」，经 cleanupStaleTaskWorktrees）", () => {
      it("(a) 已删任务留下的 stale 半截检出 → 目录与登记都清掉、同名分支能再 add（原症状）", async () => {
        const { repo, task, workDir } = await newCase();
        const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
        await ageLock(killed.lockFile, STALE);
        await markTaskDeleted(task.id);
        const tipBefore = branchTip(repo, BRANCH);

        const res = await cleanupStaleTaskWorktrees(task.id);

        expect(res.removedDirs).toEqual([path.basename(workDir)]);
        expect(res.kept).toEqual([]);
        expect(await exists(workDir)).toBe(false);
        expect(isRegistered(repo, workDir)).toBe(false);
        expect(registeredCount(repo)).toBe(1);
        expect(branchTip(repo, BRANCH)).toBe(tipBefore);
        expect(canReAddBranch(repo, BRANCH)).toBe(true);
      });

      it("(b) 用户手动 lock 的健康 worktree → 不升级", async () => {
        const { repo, task, workDir } = await newCase();
        await makeUserLockedWorktree(repo, workDir);
        await markTaskDeleted(task.id);
        shim = await installGitShim(path.join(TMP_ROOT, `shim-${seq}`));

        await cleanupStaleTaskWorktrees(task.id);

        const calls = await shim.calls();
        expect(calls.some((c) => /worktree remove --force /.test(c) && !/--force --force/.test(c))).toBe(true);
        await expectNoEscalation(shim);
      });
    });

    // ───────────────────────── #5 syncTaskWorktreesToRepoPaths ─────────────────────────
    describe("#5 syncTaskWorktreesToRepoPaths（用户改仓、解绑某个仓）", () => {
      const twoRepoTask = async () => {
        const n = ++seq;
        const repoA = path.join(TMP_ROOT, `repo-${n}-a`);
        const repoB = path.join(TMP_ROOT, `repo-${n}-b`);
        await initRepoForHalfCheckout(repoA);
        await initRepoForHalfCheckout(repoB);
        const task = makeTask([repoA, repoB], nextId());
        await markTaskAlive(task.id);
        return { repoA, repoB, task, workDirA: getTaskWorkRepoPaths(task)[0] };
      };

      it("(a) 解绑的仓是 stale 半截检出 → 目录与登记都清掉、分支 tip 不变、同名分支能再 add（原症状）", async () => {
        const { repoA, repoB, task, workDirA } = await twoRepoTask();
        const killed = await killAddMidCheckout({ repo: repoA, workDir: workDirA, branch: BRANCH });
        await ageLock(killed.lockFile, STALE);
        const tipBefore = branchTip(repoA, BRANCH);

        const res = await syncTaskWorktreesToRepoPaths(task, [repoA, repoB], [repoB]);

        expect(res.unboundRepos).toEqual([repoA]);
        expect(await exists(workDirA)).toBe(false);
        expect(isRegistered(repoA, workDirA)).toBe(false);
        expect(registeredCount(repoA)).toBe(1);
        expect(branchTip(repoA, BRANCH)).toBe(tipBefore); // 不往任务分支记「删光」的 WIP
        expect(canReAddBranch(repoA, BRANCH)).toBe(true);
      });

      it("(b) 解绑的仓是用户手动 lock 的健康 worktree → 不升级", async () => {
        const { repoA, repoB, task, workDirA } = await twoRepoTask();
        await makeUserLockedWorktree(repoA, workDirA);
        shim = await installGitShim(path.join(TMP_ROOT, `shim-${seq}`));

        await syncTaskWorktreesToRepoPaths(task, [repoA, repoB], [repoB]);

        const calls = await shim.calls();
        expect(calls.some((c) => /worktree remove --force /.test(c) && !/--force --force/.test(c))).toBe(true);
        await expectNoEscalation(shim);
      });
    });

    // ───────────────────────── #6 pruneUnmappedTaskWorktreeDirs（ensure 开头调用） ─────────────────────────
    describe("#6 pruneUnmappedTaskWorktreeDirs（活任务容器里不在映射里的残留目录，ensure 开头清）", () => {
      it("(a) 多出来的目录是 stale 半截检出、且占着任务分支（解绑后残留）→ 目录与登记都清掉、分支 tip 不变；任务自己随后检出该分支、内容完整", async () => {
        const { repo, task, workDir } = await newCase();
        const extra = path.join(path.dirname(workDir), "stale-extra");
        const killed = await killAddMidCheckout({ repo, workDir: extra, branch: BRANCH });
        await ageLock(killed.lockFile, STALE);
        const tipBefore = branchTip(repo, BRANCH);

        const res = await ensureTaskWorktrees(task, () => true);

        expect(res.createdRepos).toEqual([repo]);
        expect(await exists(extra)).toBe(false);
        expect(isRegistered(repo, extra)).toBe(false);
        expect(registeredCount(repo)).toBe(2); // 主仓 + 任务自己的
        // 清 extra 时的快照不往任务分支记「删光」的 WIP——否则下面任务自己检出的就是缺文件的树
        expect(branchTip(repo, BRANCH)).toBe(tipBefore);
        expect(git(workDir, "branch", "--show-current")).toBe(BRANCH);
        await expectFullCheckout(workDir);
      });

      it("(a2) 多出来的目录属于**另一个仓**（任务已解绑的仓）的 stale 半截检出 → 照样清掉：ensure 后面的「存量僵尸」兜底只管当前这个仓、管不到它，只能靠 #6 自己升级", async () => {
        const { repo, task, workDir } = await newCase(); // 任务只绑 repo
        const repoB = path.join(TMP_ROOT, `repo-${seq}-unbound`);
        await initRepoForHalfCheckout(repoB);
        const extra = path.join(path.dirname(workDir), "stale-unbound");
        const killed = await killAddMidCheckout({ repo: repoB, workDir: extra, branch: "feature/unbound" });
        await ageLock(killed.lockFile, STALE);
        const tipBefore = branchTip(repoB, "feature/unbound");

        const res = await ensureTaskWorktrees(task, () => true);

        expect(res.createdRepos).toEqual([repo]);
        expect(await exists(extra)).toBe(false);
        expect(isRegistered(repoB, extra)).toBe(false); // 没有任何别的环节会替 repoB 解锁
        expect(registeredCount(repoB)).toBe(1);
        // 任务的分支记录里没有 repoB：旧口径会把「删光」的 WIP 记到它 HEAD 附着的 feature/unbound 上
        expect(branchTip(repoB, "feature/unbound")).toBe(tipBefore);
        expect(canReAddBranch(repoB, "feature/unbound")).toBe(true);
      });

      it("(b) 多出来的目录是用户手动 lock 的健康 worktree → 不升级", async () => {
        const { repo, task, workDir } = await newCase();
        const extra = path.join(path.dirname(workDir), "stale-extra");
        await fs.mkdir(path.dirname(extra), { recursive: true });
        git(repo, "worktree", "add", "--no-track", "-b", "feature/extra", extra, "main");
        git(repo, "worktree", "lock", "--reason", "我的锁", extra);
        shim = await installGitShim(path.join(TMP_ROOT, `shim-${seq}`));

        await ensureTaskWorktrees(task, () => true).catch(() => {});

        const calls = await shim.calls();
        expect(calls.some((c) => /worktree remove --force /.test(c) && !/--force --force/.test(c))).toBe(true);
        await expectNoEscalation(shim);
      });

      it("(c) 多出来的目录是独立 gitdir（`.git` 文件不是 worktree 指针、反查不出原仓）→ 快照口径保持旧行为：未提交改动照旧记到它 HEAD 附着的分支，目录随后删掉（B5-2 没改这条）", async () => {
        const { task, workDir } = await newCase();
        const extra = path.join(path.dirname(workDir), "standalone-extra");
        const sepGitDir = path.join(TMP_ROOT, `sep-${seq}.git`);
        await fs.mkdir(path.dirname(extra), { recursive: true });
        git(TMP_ROOT, "init", "-q", "-b", "main", `--separate-git-dir=${sepGitDir}`, extra);
        git(extra, "config", "user.email", "t@t.local");
        git(extra, "config", "user.name", "t");
        await fs.writeFile(path.join(extra, "tracked.txt"), "t\n");
        git(extra, "add", "-A");
        git(extra, "commit", "-q", "-m", "init");
        const tipBefore = git(extra, "rev-parse", "HEAD");
        await fs.writeFile(path.join(extra, "dirty.txt"), "未提交\n");

        await ensureTaskWorktrees(task, () => true);

        expect(await exists(extra)).toBe(false);
        const inSep = (...args: string[]): string => git(TMP_ROOT, "--git-dir", sepGitDir, ...args);
        // 沿用旧口径（taskBranch=undefined）：HEAD 附着的 main 被推进到快照 commit，快照里有那个未提交文件
        expect(inSep("rev-parse", "refs/heads/main")).not.toBe(tipBefore);
        expect(inSep("ls-tree", "-r", "--name-only", "main")).toContain("dirty.txt");
      });
    });

    // ───────────────────────── 相邻路径：开机孤儿清理 ─────────────────────────
    describe("相邻路径 cleanupOrphanTaskWorktrees（开机孤儿清理：先 fs.rm 再 prune，没有 remove --force）", () => {
      it("(a) 已删任务留下的 stale 半截检出 → 目录清掉后先解锁再 prune，登记没了、同名分支能再 add（原症状）", async () => {
        const { repo, task, workDir } = await newCase();
        const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
        await ageLock(killed.lockFile, STALE);
        await markTaskDeleted(task.id);

        await cleanupOrphanTaskWorktrees(new Set());

        expect(await exists(workDir)).toBe(false);
        expect(isRegistered(repo, workDir)).toBe(false);
        expect(registeredCount(repo)).toBe(1);
        expect(canReAddBranch(repo, BRANCH)).toBe(true);
      });

      it("(b) locked 还很新（live）→ 保守不解锁，登记原样（下次再试）", async () => {
        const { repo, task, workDir } = await newCase();
        const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
        // 不 ageLock
        await markTaskDeleted(task.id);
        shim = await installGitShim(path.join(TMP_ROOT, `shim-${seq}`));

        await cleanupOrphanTaskWorktrees(new Set());

        await expectNoEscalation(shim);
        expect(await readLocked(killed.adminDir)).toBe("initializing\n");
        expect(isRegistered(repo, workDir)).toBe(true);
      });
    });

  },
);
