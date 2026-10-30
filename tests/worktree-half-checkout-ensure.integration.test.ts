/**
 * R14 B5-2（Q10-01）——ensure 侧：`git worktree add` 被 SIGKILL 留下「半截检出 + locked=initializing」时的自愈 / 不误伤。
 *
 * 全部是真 git、真 SIGKILL（仓里一个 `*.slowtxt` 文件挂 smudge 过滤器卡住 checkout，等 index.lock 出现再杀整个进程组，
 * 见 tests/helpers/half-checkout.ts）。`locked` 的「年龄」用 `fs.utimes` 拨 mtime 模拟，不注入时钟。
 * 依赖 POSIX 进程组与 sh，Windows 上整组跳过——**Windows 未验证**。
 *
 * 用例分三类：
 * - 自愈（该动的动）：stale 残留 → 目录改名隔离（文件全保留）、解锁、重建健康 worktree、分支 tip 不变；
 * - 不误伤（不该动的不动）：live（刚杀 / 本进程在途）、用户手动 lock、reason 含 initializing、孤立 index.lock、用户删光文件；
 * - 收敛（并发 / 重入 / 失败后的二段式自愈）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";
import {
  ageLock,
  branchTip,
  clearSlowSmudge,
  exists,
  git,
  gitOk,
  hermeticGitEnv,
  initRepoForHalfCheckout,
  installGitShim,
  isRegistered,
  killAddMidCheckout,
  openAllGates,
  readLocked,
  realpathLoose,
  REPO_FILES,
  setGatedSmudge,
  waitForAnyLock,
  waitForFreshLock,
  waitForGateReached,
  within,
  type GitShim,
} from "./helpers/half-checkout";

hermeticGitEnv();
// dataRoot 走环境变量、指到临时目录（调用被测模块前钉死；dataRoot() 是惰性读取）
const TMP_ROOT = path.join(os.tmpdir(), `fe-half-checkout-ensure-${process.pid}-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
const DATA_DIR = process.env.FLOWSHIP_DATA_DIR;

import { clearFailpoints, setFailpoint } from "@/lib/server/failpoints";
import {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  WorktreeLeaseLostError,
} from "@/lib/server/task-worktrees";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const TITLE = "半截检出";
const BRANCH = "feature/888888-半截检出";
const STALE = 10 * 60_000; // 远超 5 分钟阈值

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
    feishuStoryUrl: "https://project.feishu.cn/x/story/detail/888888",
    actions: [],
    mrs: [],
  }) as unknown as Task;

const markTaskAlive = async (taskId: string): Promise<void> => {
  await fs.mkdir(path.join(DATA_DIR, "tasks", taskId), { recursive: true });
};

let seq = 0;
const nextId = (): string => `t_17000000${String(++seq).padStart(5, "0")}_half`;

/** 一个独立的仓 + 任务（用例之间互不串扰） */
const newCase = async (title = TITLE) => {
  const n = ++seq;
  const repo = path.join(TMP_ROOT, `repo-${n}`);
  await initRepoForHalfCheckout(repo);
  const task = makeTask([repo], `t_17000000${String(n).padStart(5, "0")}_half`, title);
  await markTaskAlive(task.id);
  return { repo, task, workDir: getTaskWorkRepoPaths(task)[0] };
};

/** workDir 同级的 `<name>.orphaned-*` 隔离目录 */
const orphanedDirs = async (workDir: string): Promise<string[]> =>
  (await fs.readdir(path.dirname(workDir)))
    .filter((n) => n.startsWith(`${path.basename(workDir)}.orphaned-`))
    .map((n) => path.join(path.dirname(workDir), n));

const registeredCount = (repo: string): number =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;

/** 隔离目录 / worktree 里一份完整检出该有的文件都在、内容对 */
const expectFullCheckout = async (dir: string): Promise<void> => {
  for (const [name, content] of Object.entries(REPO_FILES)) {
    expect(await fs.readFile(path.join(dir, name), "utf8"), `${dir}/${name}`).toBe(content);
  }
};

let shim: GitShim | null = null;
afterEach(async () => {
  await openAllGates(); // 用例超时 / 中途失败也要放行卡住的 checkout，别留孤儿 git 进程
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
  "R14 B5-2 ensure：git worktree add 被硬杀的半截检出（真 git + 真 SIGKILL）",
  () => {
    // ───────────────────────── 复现自检 ─────────────────────────
    it("复现是真的：残留态下 ensure 旧的复用判据全部满足（rev-parse 为 true、当前分支就是任务分支），但检出是半截的", async () => {
      const { repo, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });

      expect(await fs.readFile(killed.lockFile, "utf8")).toBe("initializing\n");
      expect(await exists(path.join(killed.adminDir, "index.lock"))).toBe(true);
      expect(await exists(path.join(killed.adminDir, "index"))).toBe(false);
      expect(gitOk(workDir, "rev-parse", "--is-inside-work-tree")).toBe(true);
      expect(git(workDir, "branch", "--show-current")).toBe(BRANCH);
      // 已检出的前几个文件在、后面的没来得及
      expect(await exists(path.join(workDir, "a.txt"))).toBe(true);
      expect(await exists(path.join(workDir, "z.txt"))).toBe(false);
      // status 首列全是删除（索引为空）
      const status = git(workDir, "status", "--porcelain").split("\n");
      expect(status.some((l) => l.startsWith("D  z.txt"))).toBe(true);
      // git 自己也认为它被锁着
      expect(git(repo, "worktree", "list", "--porcelain")).toMatch(/locked initializing/);
    });

    // ───────────────────────── 自愈 ─────────────────────────
    it("stale 残留：改名隔离（文件全保留，含 agent 已写进去的）+ 解锁 + 重建健康 worktree；分支 tip 不变；再 ensure 幂等", async () => {
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      // 老版本把它当健康 worktree 复用后，agent 往里写了东西——自愈不能把它丢掉
      await fs.writeFile(path.join(workDir, "agent-notes.md"), "别丢\n");
      const tipBefore = branchTip(repo, BRANCH);
      await ageLock(killed.lockFile, STALE);

      const res = await ensureTaskWorktrees(task, () => true);

      expect(res.createdRepos).toEqual([repo]);
      expect(res.infos[0].name).toBe(BRANCH);
      // 新 worktree 完整、干净、在任务分支上、没有任何锁
      await expectFullCheckout(workDir);
      expect(await exists(path.join(workDir, "agent-notes.md"))).toBe(false);
      expect(git(workDir, "status", "--porcelain")).toBe("");
      expect(git(workDir, "branch", "--show-current")).toBe(BRANCH);
      expect(git(repo, "worktree", "list", "--porcelain")).not.toMatch(/locked/);
      expect(await readLocked(killed.adminDir)).toBeNull();
      expect(registeredCount(repo)).toBe(2); // 主仓 + 新 worktree，没有旧登记残留
      // 分支没动
      expect(branchTip(repo, BRANCH)).toBe(tipBefore);
      // 半截目录原样保留在隔离目录里（一个文件都没删）
      const orphans = await orphanedDirs(workDir);
      expect(orphans).toHaveLength(1);
      expect(await fs.readFile(path.join(orphans[0], "agent-notes.md"), "utf8")).toBe("别丢\n");
      expect(await fs.readFile(path.join(orphans[0], "a.txt"), "utf8")).toBe("a\n");
      expect(await exists(path.join(orphans[0], "z.txt"))).toBe(false);
      // 隔离目录不再是登记的 worktree
      expect(isRegistered(repo, orphans[0])).toBe(false);

      // 幂等：再 ensure 一次，复用、不再新建、不再多出隔离目录
      const again = await ensureTaskWorktrees(task, () => true);
      expect(again.createdRepos).toEqual([]);
      expect(await orphanedDirs(workDir)).toHaveLength(1);
      await expectFullCheckout(workDir);
    });

    it("detached 预热的残留（add --detach 被杀）同样自愈", async () => {
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: "", detach: true });
      await ageLock(killed.lockFile, STALE);

      const res = await ensureTaskWorktrees(task, () => true, {
        branchSelection: { kind: "detached" },
      });

      expect(res.createdRepos).toEqual([repo]);
      await expectFullCheckout(workDir);
      expect(git(workDir, "branch", "--show-current")).toBe(""); // 仍是 detached 预热
      expect(git(repo, "worktree", "list", "--porcelain")).not.toMatch(/locked/);
      expect(await orphanedDirs(workDir)).toHaveLength(1);
    });

    it("两个仓：只有残留的那个被自愈，健康的那个照常复用（逐仓处理、互不牵连）", async () => {
      const n = ++seq;
      const repoA = path.join(TMP_ROOT, `repo-${n}-a`);
      const repoB = path.join(TMP_ROOT, `repo-${n}-b`);
      await initRepoForHalfCheckout(repoA);
      await initRepoForHalfCheckout(repoB);
      const task = makeTask([repoA, repoB], nextId());
      await markTaskAlive(task.id);
      const [wdA, wdB] = getTaskWorkRepoPaths(task);
      // B：正常建好（与 ensure 同形的 add）；A：被杀
      await fs.mkdir(path.dirname(wdB), { recursive: true });
      git(repoB, "worktree", "add", "--no-track", "-b", BRANCH, wdB, "main");
      await fs.writeFile(path.join(wdB, "b-work.txt"), "B 的工作\n");
      const killed = await killAddMidCheckout({ repo: repoA, workDir: wdA, branch: BRANCH });
      await ageLock(killed.lockFile, STALE);

      const res = await ensureTaskWorktrees(task, () => true);

      expect(res.createdRepos).toEqual([repoA]);
      await expectFullCheckout(wdA);
      expect(await orphanedDirs(wdA)).toHaveLength(1);
      // B 原样复用：没被隔离、里面的工作还在
      expect(await orphanedDirs(wdB)).toHaveLength(0);
      expect(await fs.readFile(path.join(wdB, "b-work.txt"), "utf8")).toBe("B 的工作\n");
    });

    // ───────────────────────── 存量僵尸（老版本留下的：目录没了、登记还锁着） ─────────────────────────
    it("存量僵尸：目录已被 rm、prune 也清不掉 → ensure 先解锁再 prune，同名分支能再建（原症状）", async () => {
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      // 老版本的退回路径：fs.rm + prune——实测清不掉被锁定的登记
      await fs.rm(workDir, { recursive: true, force: true });
      git(repo, "worktree", "prune");
      expect(isRegistered(repo, workDir), "老版本 rm+prune 之后登记仍在（这就是僵尸）").toBe(true);
      expect(gitOk(repo, "worktree", "add", path.join(TMP_ROOT, "probe-wt"), BRANCH)).toBe(false); // already checked out
      await ageLock(killed.lockFile, STALE);

      const res = await ensureTaskWorktrees(task, () => true);

      expect(res.createdRepos).toEqual([repo]);
      await expectFullCheckout(workDir);
      expect(git(workDir, "branch", "--show-current")).toBe(BRANCH);
      expect(registeredCount(repo)).toBe(2);
      expect(git(repo, "worktree", "list", "--porcelain")).not.toMatch(/locked/);
    });

    it("存量僵尸但 locked 还很新（可能是另一个实例刚被杀 / 还在 add）：不解锁，ensure 带着「已被检出」的报错失败", async () => {
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      await fs.rm(workDir, { recursive: true, force: true });
      // 不 ageLock：age ≈ 0

      await expect(ensureTaskWorktrees(task, () => true)).rejects.toThrow(/创建隔离工作区失败/);

      expect(await readLocked(killed.adminDir)).toBe("initializing\n"); // 没被动
      expect(isRegistered(repo, workDir)).toBe(true);
    });

    it("存量僵尸不在 Flowship 的 worktrees 根下（用户自己手建的 worktree）：不碰，即使 stale", async () => {
      const { repo, task } = await newCase();
      const userWt = path.join(TMP_ROOT, `user-wt-${seq}`);
      const killed = await killAddMidCheckout({ repo, workDir: userWt, branch: "user/x" });
      await fs.rm(userWt, { recursive: true, force: true });
      await ageLock(killed.lockFile, STALE);

      // 触发 zombie 清理的 ensure（任务自己的 worktree 是正常新建）
      const res = await ensureTaskWorktrees(task, () => true);
      expect(res.createdRepos).toEqual([repo]);

      expect(await readLocked(killed.adminDir)).toBe("initializing\n"); // 用户的登记原样
      expect(isRegistered(repo, userWt)).toBe(true);
    });

    it("存量僵尸在名字以 worktrees 开头的「兄弟」目录下（<data>/worktrees-user/…，不在 worktrees 根里）：不碰", async () => {
      const { repo, task } = await newCase();
      const userWt = path.join(DATA_DIR, "worktrees-user", `wt-${seq}`);
      const killed = await killAddMidCheckout({ repo, workDir: userWt, branch: "user/y" });
      await fs.rm(userWt, { recursive: true, force: true });
      await ageLock(killed.lockFile, STALE);

      await ensureTaskWorktrees(task, () => true);

      expect(await readLocked(killed.adminDir)).toBe("initializing\n"); // 前缀相同 ≠ 在根里
      expect(isRegistered(repo, userWt)).toBe(true);
    });

    it("目录还在的 stale 半截检出（同仓别的任务的）：本任务 ensure 里的僵尸清理不碰它（归它自己任务的 ensure / remove 路径）", async () => {
      const { repo, task } = await newCase();
      const other = makeTask([repo], nextId(), "别的任务");
      await markTaskAlive(other.id);
      const otherWd = getTaskWorkRepoPaths(other)[0];
      const killed = await killAddMidCheckout({ repo, workDir: otherWd, branch: "feature/other" });
      await ageLock(killed.lockFile, STALE);

      const res = await ensureTaskWorktrees(task, () => true);

      expect(res.createdRepos).toEqual([repo]);
      expect(await readLocked(killed.adminDir)).toBe("initializing\n"); // 没被解锁
      expect(await exists(path.join(otherWd, "a.txt"))).toBe(true); // 目录没被动
      expect(await orphanedDirs(otherWd)).toHaveLength(0);
      expect(isRegistered(repo, otherWd)).toBe(true);
    });

    // ───────────────────────── 不误伤 ─────────────────────────
    it("live：locked 才几秒（可能是本机另一个实例 / 终端在 add）→ 抛可重试错误，目录与登记原样不动", async () => {
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      // 不 ageLock

      const err = await ensureTaskWorktrees(task, () => true).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/还在进行/);
      expect((err as Error).message).toMatch(/约 \d+s 后重试/);
      expect((err as Error).constructor.name).toBe("Error"); // 不是让位错误（不会被调用方当成失主吞掉）
      expect(await readLocked(killed.adminDir)).toBe("initializing\n");
      expect(await exists(path.join(workDir, "a.txt"))).toBe(true);
      expect(await exists(path.join(workDir, "z.txt"))).toBe(false);
      expect(await orphanedDirs(workDir)).toHaveLength(0);
      expect(registeredCount(repo)).toBe(2);
    });

    it("5 分钟的阈值在集成层生效：locked 4 分钟 → live（目录与登记原样）；同一份残留拨到 6 分钟 → stale，自愈", async () => {
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      await fs.writeFile(path.join(workDir, "agent-notes.md"), "别丢\n");

      // 4 分钟：还在阈值之内 → 当作可能有人在 add，不动
      await ageLock(killed.lockFile, 4 * 60_000);
      const err = await ensureTaskWorktrees(task, () => true).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/还在进行/);
      expect((err as Error).message).toMatch(/约 \d+s 后重试/);
      expect(await readLocked(killed.adminDir)).toBe("initializing\n");
      expect(await orphanedDirs(workDir)).toHaveLength(0);
      expect(await exists(path.join(workDir, "agent-notes.md"))).toBe(true);

      // 6 分钟：越过阈值 → 没有活的持有者，自愈
      await ageLock(killed.lockFile, 6 * 60_000);
      const res = await ensureTaskWorktrees(task, () => true);
      expect(res.createdRepos).toEqual([repo]);
      await expectFullCheckout(workDir);
      const orphans = await orphanedDirs(workDir);
      expect(orphans).toHaveLength(1);
      expect(await fs.readFile(path.join(orphans[0], "agent-notes.md"), "utf8")).toBe("别丢\n");
      expect(await readLocked(killed.adminDir)).toBeNull();
    });

    it("本进程有这个目录的 add 在跑（in-flight）：locked 再老也是 live；add 结束后才算残留", async () => {
      const { beginWorktreeAdd } = await import("@/lib/server/worktree-residue");
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      await ageLock(killed.lockFile, STALE);

      // 产品代码登记的键是 realpath 规范形；测试里用独立实现算同一个键
      const end = beginWorktreeAdd(realpathLoose(workDir));
      await expect(ensureTaskWorktrees(task, () => true)).rejects.toThrow(/本进程里另一次 git worktree add 还在进行/);
      expect(await readLocked(killed.adminDir)).toBe("initializing\n");
      expect(await orphanedDirs(workDir)).toHaveLength(0);

      end();
      const res = await ensureTaskWorktrees(task, () => true);
      expect(res.createdRepos).toEqual([repo]);
      await expectFullCheckout(workDir);
    });

    it("in-flight（真）：本进程里 ensure 自己的 git worktree add 还在跑（卡在 checkout），locked 被拨老也是 live——第二次 ensure 不得把正在建的目录隔离走", async () => {
      const { repo, task, workDir } = await newCase();
      const gate = path.join(TMP_ROOT, `gate-${seq}`);
      setGatedSmudge(repo, gate); // A 的 add 卡在 checkout，直到测试写 gate
      const pA = ensureTaskWorktrees(task, () => true);
      pA.catch(() => {}); // 断言失败提前退出时别留 unhandled rejection
      try {
        const lockFile = await waitForAnyLock(repo);
        // 拨老：现在只剩「本进程在途登记」能证明这次 add 还活着（年龄那条防线被绕开）
        await ageLock(lockFile, STALE);
        await expect(
          within(ensureTaskWorktrees(task, () => true), 15_000, "第二次 ensure"),
        ).rejects.toThrow(/本进程里另一次 git worktree add 还在进行/);
        expect(await orphanedDirs(workDir)).toHaveLength(0);
      } finally {
        await fs.writeFile(gate, ""); // 无论断言成败都放行，别留卡住的 git 进程
        clearSlowSmudge(repo);
      }
      const res = await within(pA, 15_000, "A 的 ensure"); // A 没被打断：add 自己跑完
      expect(res.createdRepos).toEqual([repo]);
      await expectFullCheckout(workDir);
      expect(await orphanedDirs(workDir)).toHaveLength(0);
    });

    it("存量僵尸判定也认本进程在途的 add：目录缺失、locked 再老，只要本进程这次 add 还在跑 → 不解锁（live）", async () => {
      const { repo, task, workDir } = await newCase();
      const gate = path.join(TMP_ROOT, `gate-${seq}`);
      setGatedSmudge(repo, gate);
      const pA = ensureTaskWorktrees(task, () => true);
      pA.catch(() => {});
      try {
        const lockFile = await waitForAnyLock(repo);
        await waitForGateReached(gate); // A 的 checkout 真的卡进 smudge 了（locked 出现时它可能还没读到那条配置）
        await ageLock(lockFile, STALE);
        // 人为造「目录缺失 + 本进程 add 在途」：让第二次 ensure 只能从「存量僵尸」这条路判（而不是读目录里的 .git 指针）
        await fs.rm(workDir, { recursive: true, force: true });
        // 撤掉卡住配置：第二次 ensure 自己的 add（不论成败）不能也卡在 gate 上。A 已启动的 git 不受影响（配置在它启动时已读入）
        clearSlowSmudge(repo);
        // 第二次 ensure 的结果不关心（git 对「缺失 + 已登记」的路径是否报错取决于路径比较，macOS 的 /var → /private/var 会影响），
        // 只看一件事：它有没有把 A 正在进行的那条登记的锁解开
        await within(
          ensureTaskWorktrees(task, () => true).catch(() => {}),
          15_000,
          "第二次 ensure",
        );
        expect(await readLocked(path.dirname(lockFile))).toBe("initializing\n"); // 在途 → live → 没被解锁
      } finally {
        await fs.writeFile(gate, ""); // 无论断言成败都放行 A 的 checkout
        await pA.catch(() => {});
      }
    });

    it("add 失败（任务分支已被别处检出）后在途登记被释放——不会让这个目录永远被当成「add 在跑」", async () => {
      const { repo, task, workDir } = await newCase();
      git(repo, "branch", BRANCH, "main");
      git(repo, "worktree", "add", path.join(TMP_ROOT, `squatter-${seq}`), BRANCH);

      await expect(ensureTaskWorktrees(task, () => true)).rejects.toThrow(/创建隔离工作区失败/);

      const { isWorktreeAddInFlight } = await import("@/lib/server/worktree-residue");
      expect(isWorktreeAddInFlight(realpathLoose(workDir))).toBe(false);
    });

    it("自愈本身把锁解开（不靠后面「存量僵尸」路径兜底）：隔离完成的那一刻登记已经没有 initializing 锁", async () => {
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      await ageLock(killed.lockFile, STALE);
      let lockAtHealed: string | null | undefined;
      setFailpoint("ensure.afterHealHalfCheckout", async () => {
        lockAtHealed = await readLocked(killed.adminDir);
      });

      const res = await ensureTaskWorktrees(task, () => true);

      expect(lockAtHealed).toBeNull(); // undefined = 没走自愈；字符串 = 没解锁
      expect(res.createdRepos).toEqual([repo]);
    });

    it("失主：自愈动手前 lease 失效 → 抛让位错、目录与登记原样不动（lease 在 mkdir 前查一次、自愈前再查一次）", async () => {
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      await ageLock(killed.lockFile, STALE);
      // lease 调用序列：ensure 开头 mkdir 前第 1 次；逐仓循环里自愈前第 2 次——让第 2 次起失效
      let calls = 0;
      const lease = () => ++calls < 2;

      await expect(ensureTaskWorktrees(task, lease)).rejects.toBeInstanceOf(WorktreeLeaseLostError);

      expect(await readLocked(killed.adminDir)).toBe("initializing\n");
      expect(await exists(path.join(workDir, "a.txt"))).toBe(true);
      expect(await orphanedDirs(workDir)).toHaveLength(0);
    });

    it("用户手动 lock 的健康 worktree（reason 不是 initializing）：即使 locked 很老也照常复用，锁不动", async () => {
      const { repo, task, workDir } = await newCase();
      await ensureTaskWorktrees(task, () => true);
      git(repo, "worktree", "lock", "--reason", "我的锁", workDir);
      const adminDir = git(workDir, "rev-parse", "--absolute-git-dir");
      await ageLock(path.join(adminDir, "locked"), STALE);
      await fs.writeFile(path.join(workDir, "mine.txt"), "我的改动\n");

      const res = await ensureTaskWorktrees(task, () => true);

      expect(res.createdRepos).toEqual([]);
      expect(await orphanedDirs(workDir)).toHaveLength(0);
      expect((await readLocked(adminDir))?.trim()).toBe("我的锁"); // git 写 reason 时会补换行
      expect(await fs.readFile(path.join(workDir, "mine.txt"), "utf8")).toBe("我的改动\n");
    });

    it("用户 lock 的 reason 只是「含」initializing 字样（不是恰好等于）：不是残留，照常复用", async () => {
      const { repo, task, workDir } = await newCase();
      await ensureTaskWorktrees(task, () => true);
      git(repo, "worktree", "lock", "--reason", "initializing storage", workDir);
      const adminDir = git(workDir, "rev-parse", "--absolute-git-dir");
      await ageLock(path.join(adminDir, "locked"), STALE);

      const res = await ensureTaskWorktrees(task, () => true);

      expect(res.createdRepos).toEqual([]);
      expect(await orphanedDirs(workDir)).toHaveLength(0);
      expect((await readLocked(adminDir))?.trim()).toBe("initializing storage");
      await expectFullCheckout(workDir);
    });

    it("`add --lock`（git 写 `added with --lock`）的健康 worktree：不是残留", async () => {
      const { repo, task, workDir } = await newCase();
      await fs.mkdir(path.dirname(workDir), { recursive: true });
      git(repo, "worktree", "add", "--lock", "--no-track", "-b", BRANCH, workDir, "main");
      const adminDir = git(workDir, "rev-parse", "--absolute-git-dir");
      expect(await readLocked(adminDir)).toMatch(/added with --lock/);
      await ageLock(path.join(adminDir, "locked"), STALE);

      const res = await ensureTaskWorktrees(task, () => true);

      expect(res.createdRepos).toEqual([]);
      expect(await orphanedDirs(workDir)).toHaveLength(0);
    });

    it("孤立的 index.lock（没有 locked）：不是残留判据，健康 worktree 照常复用", async () => {
      const { repo, task, workDir } = await newCase();
      await ensureTaskWorktrees(task, () => true);
      const adminDir = git(workDir, "rev-parse", "--absolute-git-dir");
      await fs.writeFile(path.join(adminDir, "index.lock"), "");
      const old = new Date(Date.now() - STALE);
      await fs.utimes(path.join(adminDir, "index.lock"), old, old);
      expect(registeredCount(repo)).toBe(2);

      const res = await ensureTaskWorktrees(task, () => true);

      expect(res.createdRepos).toEqual([]);
      expect(await orphanedDirs(workDir)).toHaveLength(0);
      expect(await exists(path.join(adminDir, "index.lock"))).toBe(true); // 别人的锁，不动
    });

    it("用户把检出文件删光（status 全是删除）但没有 initializing 锁：不是残留，照常复用、不隔离", async () => {
      const { task, workDir } = await newCase();
      await ensureTaskWorktrees(task, () => true);
      for (const name of [...Object.keys(REPO_FILES), ".gitattributes"]) {
        await fs.rm(path.join(workDir, name), { force: true });
      }
      expect(git(workDir, "status", "--porcelain")).toMatch(/^ D /m);

      const res = await ensureTaskWorktrees(task, () => true);

      expect(res.createdRepos).toEqual([]);
      expect(await orphanedDirs(workDir)).toHaveLength(0);
      expect(await exists(path.join(workDir, ".git"))).toBe(true);
    });

    // ───────────────────────── 并发 / 失败后的二段式自愈 ─────────────────────────
    it("并发：两次 ensure 同时撞上同一个 stale 残留（一个在动手前被挂起）→ 最终收敛，隔离目录只有一份，后到者不会把刚建好的 worktree 再隔离", async () => {
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      await fs.writeFile(path.join(workDir, "agent-notes.md"), "别丢\n");
      await ageLock(killed.lockFile, STALE);

      // 先到 failpoint 的那次挂起（判定为 stale 之后、动手之前），后到的那次完整跑完自愈 + 重建；再放行挂起的那次
      let held = false;
      let hitResolve!: () => void;
      const hit = new Promise<void>((r) => {
        hitResolve = r;
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      setFailpoint("ensure.beforeHealHalfCheckout", async () => {
        if (held) return;
        held = true;
        hitResolve();
        await gate;
      });

      const pA = ensureTaskWorktrees(task, () => true);
      const pB = ensureTaskWorktrees(task, () => true);
      // 没有自愈路径时 failpoint 永远不会命中——别等到用例超时才红
      await Promise.race([
        hit,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("ensure.beforeHealHalfCheckout 没命中：stale 残留没有走自愈路径")), 15_000),
        ),
      ]);
      // 没被挂起的那次先完成
      const first = await Promise.race([pA, pB]);
      release();
      const [a, b] = await Promise.all([pA, pB]);

      // 谁建的谁复用不重要：合起来恰好建了一次
      expect([a.createdRepos.length, b.createdRepos.length].sort()).toEqual([0, 1]);
      expect(first).toBeDefined();
      await expectFullCheckout(workDir);
      expect(git(workDir, "status", "--porcelain")).toBe("");
      expect(registeredCount(repo)).toBe(2);
      expect(git(repo, "worktree", "list", "--porcelain")).not.toMatch(/locked/);
      // 关键：只隔离了一份，agent 写的文件还在；后到者没有把新建的健康 worktree 再隔离一次
      const orphans = await orphanedDirs(workDir);
      expect(orphans).toHaveLength(1);
      expect(await fs.readFile(path.join(orphans[0], "agent-notes.md"), "utf8")).toBe("别丢\n");
    });

    it("并发：挂起的那次放行时，另一次已隔离完、正在重建（add 还卡在 checkout）→ 放行的这次判成 live 抛可重试错，不把正在建的目录再隔离", async () => {
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      await fs.writeFile(path.join(workDir, "agent-notes.md"), "别丢\n");
      await ageLock(killed.lockFile, STALE);

      // A 先到、在「判定为 stale 之后、动手之前」挂起；B 后到、不挂起：自己隔离 + 解锁 + 开始重建（add 卡在 gate 上的 checkout）
      let held = false;
      let hitResolve!: () => void;
      const hit = new Promise<void>((r) => {
        hitResolve = r;
      });
      let release!: () => void;
      const hold = new Promise<void>((r) => {
        release = r;
      });
      setFailpoint("ensure.beforeHealHalfCheckout", async () => {
        if (held) return;
        held = true;
        hitResolve();
        await hold;
      });
      const gate = path.join(TMP_ROOT, `gate-${seq}`);
      setGatedSmudge(repo, gate);

      const pA = ensureTaskWorktrees(task, () => true);
      pA.catch(() => {});
      let pB: ReturnType<typeof ensureTaskWorktrees> | undefined;
      try {
        await Promise.race([
          hit,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("ensure.beforeHealHalfCheckout 没命中：stale 残留没有走自愈路径")), 15_000),
          ),
        ]);
        pB = ensureTaskWorktrees(task, () => true);
        pB.catch(() => {});
        // 旧残留锁已被拨老；这里等的是 B 重建时 git 写下的**新** initializing 锁（B 的 add 此刻卡在 gate 上）
        await waitForFreshLock(repo);
        release(); // 放行 A：它的二次判定会看到 B 正在建的目录
        await expect(within(pA, 15_000, "放行后的 A")).rejects.toThrow(/还在进行/);
      } finally {
        release();
        await fs.writeFile(gate, ""); // 无论断言成败都放行 B 的 checkout
        clearSlowSmudge(repo);
      }

      const b = await within(pB!, 15_000, "B 的 ensure");
      expect(b.createdRepos).toEqual([repo]);
      await expectFullCheckout(workDir);
      expect(git(workDir, "status", "--porcelain")).toBe("");
      expect(registeredCount(repo)).toBe(2);
      // 关键：A 没把 B 正在建的目录再隔离走——只有 B 隔离的那一份，agent 写的文件还在
      const orphans = await orphanedDirs(workDir);
      expect(orphans).toHaveLength(1);
      expect(await fs.readFile(path.join(orphans[0], "agent-notes.md"), "utf8")).toBe("别丢\n");
    });

    it("改名隔离失败（容器目录只读）→ 抛错、原目录与文件原样保留、不解锁、不降级成 rm；恢复权限后下次 ensure 自愈", async () => {
      if (process.getuid?.() === 0) return; // root 不受目录权限约束，构造不出 rename 失败
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      await fs.writeFile(path.join(workDir, "agent-notes.md"), "别丢\n");
      await ageLock(killed.lockFile, STALE);
      const container = path.dirname(workDir);
      await fs.chmod(container, 0o555);
      try {
        await expect(ensureTaskWorktrees(task, () => true)).rejects.toThrow(/自动改名隔离失败/);
        expect(await fs.readFile(path.join(workDir, "agent-notes.md"), "utf8")).toBe("别丢\n");
        expect(await exists(path.join(workDir, "a.txt"))).toBe(true);
        expect(await readLocked(killed.adminDir)).toBe("initializing\n"); // 没解锁
        expect(isRegistered(repo, workDir)).toBe(true);
      } finally {
        await fs.chmod(container, 0o755);
      }

      const res = await ensureTaskWorktrees(task, () => true);
      expect(res.createdRepos).toEqual([repo]);
      await expectFullCheckout(workDir);
      const orphans = await orphanedDirs(workDir);
      expect(orphans).toHaveLength(1);
      expect(await fs.readFile(path.join(orphans[0], "agent-notes.md"), "utf8")).toBe("别丢\n");
    });

    it("隔离成功、解锁失败 → 抛带手动处置命令的错、目录已隔离且文件保留；下次 ensure 由「存量僵尸」路径兜底解锁并重建", async () => {
      const { repo, task, workDir } = await newCase();
      const killed = await killAddMidCheckout({ repo, workDir, branch: BRANCH });
      await fs.writeFile(path.join(workDir, "agent-notes.md"), "别丢\n");
      await ageLock(killed.lockFile, STALE);
      shim = await installGitShim(path.join(TMP_ROOT, `shim-${seq}`), { failUnlock: true });

      const err = await ensureTaskWorktrees(task, () => true).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/解除 git 的 initializing 锁失败/);
      expect(err!.message).toMatch(/simulated unlock failure/);
      expect(err!.message).toMatch(/worktree unlock/);
      // 目录已隔离、文件都在；登记还锁着
      expect(await exists(workDir)).toBe(false);
      const orphans = await orphanedDirs(workDir);
      expect(orphans).toHaveLength(1);
      expect(await fs.readFile(path.join(orphans[0], "agent-notes.md"), "utf8")).toBe("别丢\n");
      expect(await readLocked(killed.adminDir)).toBe("initializing\n");

      // 恢复真 git：下次 ensure 里目录缺失 + stale → 存量僵尸路径解锁 → prune → 重建
      shim.restore();
      shim = null;
      const res = await ensureTaskWorktrees(task, () => true);
      expect(res.createdRepos).toEqual([repo]);
      await expectFullCheckout(workDir);
      expect(registeredCount(repo)).toBe(2);
      expect(await orphanedDirs(workDir)).toHaveLength(1); // 没有再多隔离
    });
  },
);
