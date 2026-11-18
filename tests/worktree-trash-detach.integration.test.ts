/**
 * 快速摘除（removeTaskWorktrees → detachWorktreeToTrash）——真 git 临时仓。
 *
 * 背景：归档 / 终结 / 删任务同步等「逐文件删 worktree」（依赖目录动辄几十万文件，几十秒到几分钟、还有 60s 超时），
 * 用户点了归档很久才有反馈。现在整目录先 rename 进 `worktrees/.trash/`、prune 清登记，物理删除转后台的 `rm -rf`。
 *
 * 钉住：
 *  - 返回时原位置已空、git 登记已清、分支立刻可再建 worktree、快照照旧先落；
 *  - 物理删除确实**不在**关键路径上（spawn 被截住时，返回后回收站里的内容还在）；
 *  - 后台清理真的会把回收站清干净；
 *  - 登记被锁（prune 清不掉）→ 放回原位、走旧路径（与此前行为一致、不留回收站残留）；
 *  - 开机孤儿扫描会把崩溃遗留的回收站目录清掉。
 */
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

const TMP_ROOT = path.join(os.tmpdir(), `fe-worktree-trash-it-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

// spawn 可被测试截住（默认走真的）；execFile 等其余导出原样——被测模块跑 git 靠 execFile
const spawnHook = vi.hoisted(() => ({
  impl: null as null | ((...args: unknown[]) => unknown),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) =>
      spawnHook.impl
        ? spawnHook.impl(...args)
        : (actual.spawn as (...a: unknown[]) => unknown)(...args),
  };
});

import {
  cleanupOrphanTaskWorktrees,
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  getWorktreesRoot,
  removeTaskWorktrees,
  waitForTrashPurges,
  wipSnapshotRefName,
} from "@/lib/server/task-worktrees";

const DATA_DIR = process.env.FLOWSHIP_DATA_DIR!;
const REPO = path.join(TMP_ROOT, "origin-repo");
const TRASH = () => path.join(getWorktreesRoot(), ".trash");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const exists = async (p: string): Promise<boolean> =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);

const markTaskAlive = async (taskId: string): Promise<void> => {
  await fs.mkdir(path.join(DATA_DIR, "tasks", taskId), { recursive: true });
};

let seq = 0;
const makeTask = (tag: string): Task => {
  seq += 1;
  return {
    id: `t_1700000010${String(seq).padStart(3, "0")}_${tag}`,
    mode: "task",
    title: "快速摘除",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: [REPO],
    isolateWorktree: true,
    repoBaseBranches: { [REPO]: "main" },
    feishuStoryUrl: `https://project.feishu.cn/x/story/detail/${810000 + seq}`,
    actions: [],
    mrs: [],
  } as unknown as Task;
};

/** 建好 worktree，并往里塞一个「像依赖目录」的多文件目录 + 一个未提交改动 */
const setupWorktree = async (tag: string): Promise<{ task: Task; workDir: string }> => {
  const task = makeTask(tag);
  await markTaskAlive(task.id);
  await ensureTaskWorktrees(task, () => true);
  const workDir = getTaskWorkRepoPaths(task)[0];
  const dep = path.join(workDir, "node_modules", "pkg");
  await fs.mkdir(dep, { recursive: true });
  for (let i = 0; i < 50; i++) await fs.writeFile(path.join(dep, `f${i}.js`), `// ${i}\n`);
  await fs.writeFile(path.join(workDir, "uncommitted.ts"), "export const x = 1;\n");
  return { task, workDir };
};

beforeAll(async () => {
  await fs.mkdir(REPO, { recursive: true });
  git(REPO, "init", "-b", "main");
  git(REPO, "config", "user.email", "t@t.local");
  git(REPO, "config", "user.name", "t");
  await fs.writeFile(path.join(REPO, "a.txt"), "hello\n");
  await fs.writeFile(path.join(REPO, ".gitignore"), "node_modules/\n");
  git(REPO, "add", "-A");
  git(REPO, "commit", "-m", "init");
});

beforeEach(() => {
  spawnHook.impl = null;
});

afterAll(async () => {
  spawnHook.impl = null;
  await waitForTrashPurges();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("removeTaskWorktrees 快速摘除", () => {
  it("返回时原位置已空、登记已清、快照先落、同分支立刻能再建 worktree；后台清理最终把回收站清干净", async () => {
    const { task, workDir } = await setupWorktree("detach_ok");
    const branch = git(workDir, "branch", "--show-current");

    const removed = await removeTaskWorktrees(task);

    expect(removed.removedAny).toBe(true);
    expect(removed.snapshotRepos).toEqual([REPO]);
    expect(removed.snapshotFailedRepos).toEqual([]);
    expect(await exists(workDir)).toBe(false);
    expect(git(REPO, "worktree", "list")).not.toContain(workDir);
    // 快照 ref 在、里面有未提交的文件
    const ref = wipSnapshotRefName(task.id, path.basename(workDir));
    expect(git(REPO, "ls-tree", "-r", "--name-only", ref)).toContain("uncommitted.ts");
    // 分支登记已释放：不用等后台删完，同一分支马上可以再建
    const again = path.join(TMP_ROOT, "again-wt");
    git(REPO, "worktree", "add", again, branch);
    git(REPO, "worktree", "remove", "--force", again);

    await waitForTrashPurges();
    const left = (await exists(TRASH())) ? await fs.readdir(TRASH()) : [];
    expect(left).toEqual([]);
  });

  it("物理删除不在关键路径上：后台 rm 被截住时，返回后回收站里的内容还在、原位置已空", async () => {
    const { task, workDir } = await setupWorktree("detach_async");
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    const fakes: EventEmitter[] = [];
    spawnHook.impl = (cmd, args) => {
      spawned.push({ cmd: String(cmd), args: args as string[] });
      const fake = new EventEmitter() as EventEmitter & { unref: () => void; pid?: number };
      fake.unref = () => {};
      fakes.push(fake);
      return fake;
    };

    const removed = await removeTaskWorktrees(task);

    expect(removed.removedAny).toBe(true);
    expect(await exists(workDir)).toBe(false);
    // 回到调用方时，依赖目录还躺在回收站里（没被同步删）
    const entries = await fs.readdir(TRASH());
    expect(entries).toHaveLength(1);
    const trashed = path.join(TRASH(), entries[0]);
    expect(entries[0].startsWith(`${task.id}-`)).toBe(true);
    expect(await exists(path.join(trashed, "node_modules", "pkg", "f0.js"))).toBe(true);
    // 回收站里的目录已不是 worktree：`.git` 指针去掉了
    expect(await exists(path.join(trashed, ".git"))).toBe(false);
    // 交给了独立的 rm -rf 进程
    expect(spawned).toEqual([{ cmd: "rm", args: ["-rf", trashed] }]);

    // 收尾：spawn 被截住了、没人替我们删——手动清掉这份，再让假 child 报告「rm 退出 0」放行在途登记
    spawnHook.impl = null;
    await fs.rm(trashed, { recursive: true, force: true });
    for (const f of fakes) f.emit("close", 0);
    await waitForTrashPurges();
  });

  it("登记被锁、prune 清不掉 → 放回原位走旧路径：没有任何后台 rm、不留回收站残留", async () => {
    const { task, workDir } = await setupWorktree("detach_locked");
    git(REPO, "worktree", "lock", "--reason", "user lock", workDir);
    const spawned: unknown[] = [];
    spawnHook.impl = (...args) => {
      spawned.push(args);
      throw new Error("不该走到后台 rm（快路径应当放弃）");
    };

    const removed = await removeTaskWorktrees(task);

    // 旧路径：git worktree remove 被锁拦住 → fs.rm + prune（prune 清不掉被锁的登记）→ 目录没了
    expect(removed.removedAny).toBe(true);
    expect(await exists(workDir)).toBe(false);
    expect(spawned).toEqual([]);
    const left = (await exists(TRASH())) ? await fs.readdir(TRASH()) : [];
    expect(left).toEqual([]);

    // 清理测试留下的锁定登记（别影响后续用例；目录已不在、git 按路径解不开锁，直接清登记目录）
    await fs.rm(path.join(REPO, ".git", "worktrees"), { recursive: true, force: true });
    git(REPO, "worktree", "prune");
  });
});

describe("后台清理的兜底", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "只读子目录：第一遍 rm 删不净 → chmod 后再删，最终回收站清干净（旧的同步删除这里只能把目录留在原位）",
    async () => {
      const { task, workDir } = await setupWorktree("detach_readonly");
      const locked = path.join(workDir, "locked");
      await fs.mkdir(locked, { recursive: true });
      await fs.writeFile(path.join(locked, "x.txt"), "x\n");
      await fs.chmod(locked, 0o555);

      const removed = await removeTaskWorktrees(task);

      expect(removed.removedAny).toBe(true);
      expect(await exists(workDir)).toBe(false);
      await waitForTrashPurges();
      const left = (await exists(TRASH())) ? await fs.readdir(TRASH()) : [];
      expect(left).toEqual([]);
    },
    60_000,
  );

  it("逃生口 FLOWSHIP_WORKTREE_FAST_REMOVE=0：不进回收站、不起后台 rm、仍删干净", async () => {
    const { task, workDir } = await setupWorktree("detach_off");
    const spawned: unknown[] = [];
    spawnHook.impl = (...args) => {
      spawned.push(args);
      throw new Error("逃生口打开时不该起后台 rm");
    };
    const prev = process.env.FLOWSHIP_WORKTREE_FAST_REMOVE;
    process.env.FLOWSHIP_WORKTREE_FAST_REMOVE = "0";
    try {
      const removed = await removeTaskWorktrees(task);
      expect(removed.removedAny).toBe(true);
      expect(await exists(workDir)).toBe(false);
      expect(spawned).toEqual([]);
      // 回收站目录可能是前面用例留下的空壳、但这次没往里放东西
      const left = (await exists(TRASH())) ? await fs.readdir(TRASH()) : [];
      expect(left).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_WORKTREE_FAST_REMOVE;
      else process.env.FLOWSHIP_WORKTREE_FAST_REMOVE = prev;
    }
  });
});

describe("开机孤儿扫描兜住崩溃遗留的回收站", () => {
  it("回收站里没有 .git 的残留目录被当成非 worktree 残留整个清掉", async () => {
    const leftover = path.join(TRASH(), "t_crashed-repo-abc-123");
    await fs.mkdir(path.join(leftover, "node_modules", "x"), { recursive: true });
    await fs.writeFile(path.join(leftover, "node_modules", "x", "i.js"), "1\n");

    await cleanupOrphanTaskWorktrees(new Set());

    expect(await exists(TRASH())).toBe(false);
  });
});
