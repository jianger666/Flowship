/**
 * 孤儿 worktree 清理的两道闸必须 fail-closed（数据安全）。
 *
 * 旧行为（两道闸都是 fail-open）：
 * - 闸 1：`cleanupOrphanTaskWorktrees` 里 `readFile(<workDir>/.git)` 任何失败都被 catch 吞成「非 worktree 残留」，
 *   **跳过 WIP 快照**直接 `fs.rm` 整棵目录——瞬时 EACCES / EBUSY / EIO 下，整个工作区的未提交改动就此丢失、没有快照；
 * - 闸 2：`readMetaRaw` 先用 `exists()` 预探 meta.json，它把一切错误吞成 false → 「没有 meta」→ boot recovery 判
 *   「非存活任务」→ 该任务的 worktree 被当孤儿清理。两个窗口很窄，但同时撞上就是整个工作区没了。
 *
 * 现在：只有「明确 ENOENT（/ ENOTDIR）」才算不存在；其它错误一律保留目录、记日志、留到下次启动再处理。
 * 且「读 .git 失败」≠「不是 worktree」。
 *
 * DATA_DIR 在 task-fs-core 模块加载时冻结：必须先钉 FLOWSHIP_DATA_DIR 再动态 import（同 boot-recovery-retry.test.ts）。
 * 全程只写临时目录。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import { git, hermeticGitEnv } from "./helpers/half-checkout";

hermeticGitEnv();

vi.mock("@/lib/server/sdk-store-gc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/sdk-store-gc")>()),
  maybeGcSdkStore: vi.fn(),
}));

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-orphan-wt-closed-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const { DATA_DIR, readMetaRaw, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const { listTasksWithCorrupt } = await import("@/lib/server/task-fs");
const { cleanupOrphanTaskWorktrees, getWorktreesRoot, wipSnapshotRefName } = await import(
  "@/lib/server/task-worktrees"
);

if (!DATA_DIR.startsWith(TMP_ROOT) || !getWorktreesRoot().startsWith(TMP_ROOT)) {
  throw new Error(`orphan-worktree DATA_DIR / worktrees 未隔离到 TMP：${DATA_DIR}`);
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const RETRY_STATE = "__flowshipBootRecoveryRetryV1__";
const g = globalThis as unknown as Record<string, unknown>;
const resetBoot = (): void => {
  delete g[RECOVERY_FLAG];
  delete g[RETRY_STATE];
};

const baseMeta = (id: string, patch: Partial<TaskMetaV06> = {}): TaskMetaV06 => ({
  id,
  title: `任务 ${id}`,
  mode: "chat",
  repoStatus: "developing",
  runStatus: "idle",
  currentActionId: null,
  actions: [],
  mrs: [],
  repoPaths: [],
  createdAt: 1_000,
  updatedAt: 1_000,
  ...patch,
});

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: injected`), { code });

/** 造 `<worktrees>/<taskId>/<repoDir>/`；withGitFile=true 时放一个指向不存在主仓的 `.git` 指针文件 */
const seedWorkDir = async (
  taskId: string,
  repoDir: string,
  opts: { withGitFile?: boolean } = {},
): Promise<string> => {
  const workDir = path.join(getWorktreesRoot(), taskId, repoDir);
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(workDir, "uncommitted.txt"), "未提交的改动\n");
  if (opts.withGitFile) {
    await fs.writeFile(path.join(workDir, ".git"), `gitdir: ${TMP_ROOT}/nope/.git/worktrees/${repoDir}\n`);
  }
  return workDir;
};

const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

/** 让路径以 `suffix` 结尾的 readFile 抛指定 errno */
const failReadFile = (suffix: string, code: string) => {
  const real = fs.readFile.bind(fs) as (...a: unknown[]) => Promise<unknown>;
  const ctl = { hits: 0 };
  vi.spyOn(fs, "readFile").mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (String(p).endsWith(suffix)) {
      ctl.hits += 1;
      return Promise.reject(errno(code));
    }
    return real(p, ...rest);
  }) as unknown as typeof fs.readFile);
  return ctl;
};

/** 模拟某个任务的 meta.json 整条读路径瞬时故障：存在性预探（access / stat）与 readFile 都失败 */
const failMetaProbe = (id: string, code: string): void => {
  const target = path.join(taskDir(id), "meta.json");
  const wrap = <K extends "access" | "stat" | "readFile">(name: K): void => {
    const real = (fs[name] as unknown as (...a: unknown[]) => Promise<unknown>).bind(fs);
    vi.spyOn(fs, name).mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (String(p) === target) return Promise.reject(errno(code));
      return real(p, ...rest);
    }) as never);
  };
  wrap("access");
  wrap("stat");
  wrap("readFile");
};

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetBoot();
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.rm(getWorktreesRoot(), { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  resetBoot();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

/** 真 git：主仓 + 一个挂在 `<worktrees>/<taskId>/repoA` 的真 worktree，里面有一个未提交的新文件 */
const seedRealDirtyWorktree = async (taskId: string): Promise<{ repo: string; workDir: string }> => {
  const repo = path.join(TMP_ROOT, `real-repo-${taskId}`);
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.local");
  git(repo, "config", "user.name", "t");
  await fs.writeFile(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const workDir = path.join(getWorktreesRoot(), taskId, "repoA");
  await fs.mkdir(path.dirname(workDir), { recursive: true });
  git(repo, "worktree", "add", "-q", "--detach", workDir, "main");
  await fs.writeFile(path.join(workDir, "wip.txt"), "只存在于工作区的未提交改动\n");
  return { repo, workDir };
};

describe("闸 1：cleanupOrphanTaskWorktrees 读 .git 指针失败不能当「非 worktree」去删", () => {
  it("真 git：脏 worktree 的 .git 指针瞬时读失败（EACCES）→ 目录与未提交改动都保留（旧实现跳过快照直接 rm）", async () => {
    const { workDir } = await seedRealDirtyWorktree("t_real_err");
    const ctl = failReadFile(`${path.sep}repoA${path.sep}.git`, "EACCES");

    await cleanupOrphanTaskWorktrees(new Set());

    expect(ctl.hits).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(workDir, "wip.txt"), "utf8")).toContain("未提交改动");
  });

  it("真 git 对照：读 .git 正常时，脏 worktree 先落 WIP 快照 ref 再清掉（行为不变）", async () => {
    const { repo, workDir } = await seedRealDirtyWorktree("t_real_ok");

    await cleanupOrphanTaskWorktrees(new Set());

    expect(await exists(path.join(getWorktreesRoot(), "t_real_ok"))).toBe(false);
    const ref = wipSnapshotRefName("t_real_ok", "repoA");
    expect(git(repo, "show", `${ref}:wip.txt`)).toContain("未提交改动");
    expect(await exists(workDir)).toBe(false);
  });


  it.each(["EACCES", "EBUSY", "EIO", "EPERM"])(
    ".git 读取抛 %s（非 ENOENT）：整棵孤儿目录保留、未提交改动还在",
    async (code) => {
      const workDir = await seedWorkDir("t_orphan_err", "repoA", { withGitFile: true });
      const ctl = failReadFile(`${path.sep}.git`, code);

      await cleanupOrphanTaskWorktrees(new Set());

      expect(ctl.hits).toBeGreaterThan(0);
      expect(await exists(path.join(workDir, "uncommitted.txt"))).toBe(true);
      expect(await exists(path.join(getWorktreesRoot(), "t_orphan_err"))).toBe(true);
    },
  );

  it("同一任务多个仓：只要有一个仓的 .git 读不了，其它仓（哪怕明确没有 .git）也一起保留", async () => {
    const bad = await seedWorkDir("t_orphan_mixed", "repoBad", { withGitFile: true });
    const plain = await seedWorkDir("t_orphan_mixed", "repoPlain"); // 没有 .git
    failReadFile(`${path.sep}repoBad${path.sep}.git`, "EACCES");

    await cleanupOrphanTaskWorktrees(new Set());

    expect(await exists(bad)).toBe(true);
    expect(await exists(plain)).toBe(true);
  });

  it("读失败后故障消失：下一轮（下次启动）才处理这个目录", async () => {
    const workDir = await seedWorkDir("t_orphan_retry", "repoA"); // 没有 .git：恢复后属于「可清」
    failReadFile(`${path.sep}.git`, "EBUSY");
    await cleanupOrphanTaskWorktrees(new Set());
    expect(await exists(workDir)).toBe(true);

    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await cleanupOrphanTaskWorktrees(new Set());
    expect(await exists(path.join(getWorktreesRoot(), "t_orphan_retry"))).toBe(false);
  });

  it("明确没有 .git（ENOENT）的非 worktree 残留：行为不变、照常清理", async () => {
    await seedWorkDir("t_orphan_plain", "repoA");
    await cleanupOrphanTaskWorktrees(new Set());
    expect(await exists(path.join(getWorktreesRoot(), "t_orphan_plain"))).toBe(false);
  });

  it("存活任务的目录不在清理范围（liveTaskIds 命中）", async () => {
    const workDir = await seedWorkDir("t_live_keep", "repoA");
    await cleanupOrphanTaskWorktrees(new Set(["t_live_keep"]));
    expect(await exists(workDir)).toBe(true);
  });
});

describe("闸 2：meta.json 的存在性只有明确 ENOENT 才算「不存在」", () => {
  it("readMetaRaw：ENOENT → null；EACCES / EIO / EBUSY → 抛错（不是 null）", async () => {
    // 目录都没有 → 明确不存在
    expect(await readMetaRaw("t_meta_none")).toBeNull();

    await writeMeta(baseMeta("t_meta_probe"));
    expect(await readMetaRaw("t_meta_probe")).toMatchObject({ id: "t_meta_probe" });

    for (const code of ["EACCES", "EIO", "EBUSY"]) {
      vi.restoreAllMocks();
      failMetaProbe("t_meta_probe", code);
      await expect(readMetaRaw("t_meta_probe"), code).rejects.toMatchObject({ code });
    }
  });

  it("boot recovery：存活任务的 meta 读路径瞬时故障 → 不当成「非存活」，它的 worktree 不被当孤儿清掉", async () => {
    await writeMeta(baseMeta("t_live_flaky"));
    const liveWork = await seedWorkDir("t_live_flaky", "repoA");
    // 对照：tasks/ 下根本没有这个 id 的孤儿目录，照常清
    await seedWorkDir("t_truly_gone", "repoA");
    failMetaProbe("t_live_flaky", "EIO");

    await listTasksWithCorrupt(); // 触发首轮 boot recovery（含孤儿 worktree 清理）

    expect(await exists(liveWork)).toBe(true);
    expect(await exists(path.join(getWorktreesRoot(), "t_truly_gone"))).toBe(false);
  });

  it("boot recovery：meta.json 明确不存在（ENOENT）的任务目录仍按旧口径当非存活（行为不变）", async () => {
    await fs.mkdir(path.join(DATA_DIR, "t_no_meta"), { recursive: true });
    await seedWorkDir("t_no_meta", "repoA");

    await listTasksWithCorrupt();

    expect(await exists(path.join(getWorktreesRoot(), "t_no_meta"))).toBe(false);
  });
});

describe("`.orphaned-*`（改名隔离的损坏工作区）不拖住整个孤儿容器", () => {
  const ISOLATED = "repoB.orphaned-1700000000000";

  it("真 git：容器里同时有健康仓与 .orphaned-*：健康仓照常快照 + 回收，隔离目录原样保留（旧实现：整个容器永不回收）", async () => {
    const { repo, workDir } = await seedRealDirtyWorktree("t_iso_mixed");
    const isolated = await seedWorkDir("t_iso_mixed", ISOLATED, { withGitFile: true }); // .git 指针指向不存在的主仓
    const container = path.join(getWorktreesRoot(), "t_iso_mixed");

    await cleanupOrphanTaskWorktrees(new Set());

    // 健康仓：WIP 快照落到 ref、目录被回收、worktree 注册被 prune
    const ref = wipSnapshotRefName("t_iso_mixed", "repoA");
    expect(git(repo, "show", `${ref}:wip.txt`)).toContain("未提交改动");
    expect(await exists(workDir)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("repoA");
    // 隔离目录：原样保留（含用户未提交改动），容器也还在
    expect(await fs.readFile(path.join(isolated, "uncommitted.txt"), "utf8")).toContain("未提交的改动");
    expect(await exists(container)).toBe(true);
    expect((await fs.readdir(container)).sort()).toEqual([ISOLATED]);
  });

  it("容器里只剩 .orphaned-*（上轮已回收完健康仓）：幂等、不动它、不抛", async () => {
    const isolated = await seedWorkDir("t_iso_only", ISOLATED, { withGitFile: true });
    await cleanupOrphanTaskWorktrees(new Set());
    await cleanupOrphanTaskWorktrees(new Set());
    expect(await fs.readFile(path.join(isolated, "uncommitted.txt"), "utf8")).toContain("未提交的改动");
    expect(await exists(path.join(getWorktreesRoot(), "t_iso_only", ".git"))).toBe(false);
  });

  /** console.log 里「已清理孤儿 worktree」的条数（beforeEach 里 console.log 已被桩掉、每个用例重新计数） */
  const cleanedLogs = (): string[] =>
    vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .filter((m) => m.includes("已清理孤儿 worktree"));

  it("容器里只剩 .orphaned-*：无事可做就静默（不打「已清理」）——它永久保留、每次启动都会重进这个分支", async () => {
    const isolated = await seedWorkDir("t_iso_silent", ISOLATED, { withGitFile: true });

    for (let boot = 1; boot <= 3; boot++) {
      await cleanupOrphanTaskWorktrees(new Set());
      expect(cleanedLogs(), `第 ${boot} 次启动`).toEqual([]); // 旧实现：每次都打一条「已清理孤儿 worktree（保留…）」
    }
    expect(await fs.readFile(path.join(isolated, "uncommitted.txt"), "utf8")).toContain("未提交的改动");
  });

  it("真的清理了东西才打日志：首轮回收健康仓打一条，之后同一容器只剩 .orphaned-* 的几轮不再打", async () => {
    await seedWorkDir("t_iso_once", ISOLATED, { withGitFile: true });
    await seedWorkDir("t_iso_once", "repoPlain"); // 无 .git 的残留：可回收

    await cleanupOrphanTaskWorktrees(new Set());
    expect(cleanedLogs()).toHaveLength(1);
    expect(cleanedLogs()[0]).toContain("t_iso_once");

    await cleanupOrphanTaskWorktrees(new Set());
    await cleanupOrphanTaskWorktrees(new Set());
    expect(cleanedLogs()).toHaveLength(1); // 仍然只有首轮那一条
  });

  it("没有 .orphaned- 的普通孤儿容器：照常打「已清理」（行为不变）", async () => {
    await seedWorkDir("t_iso_logged", "repoA");
    await cleanupOrphanTaskWorktrees(new Set());
    expect(cleanedLogs()).toHaveLength(1);
  });

  it("容器里的零散文件 / 无 .git 的残留目录一并回收；隔离目录保留", async () => {
    const isolated = await seedWorkDir("t_iso_plain", ISOLATED);
    const plain = await seedWorkDir("t_iso_plain", "repoPlain"); // 没有 .git：非 worktree 残留
    const stray = path.join(getWorktreesRoot(), "t_iso_plain", "stray.txt");
    await fs.writeFile(stray, "x");

    await cleanupOrphanTaskWorktrees(new Set());

    expect(await exists(plain)).toBe(false);
    expect(await exists(stray)).toBe(false);
    expect(await exists(isolated)).toBe(true);
  });

  it("健康仓自己的 .git 读不了（fail-closed 闸）：整个容器（含 .orphaned-*）本轮原样保留，行为不变", async () => {
    const bad = await seedWorkDir("t_iso_closed", "repoBad", { withGitFile: true });
    const isolated = await seedWorkDir("t_iso_closed", ISOLATED, { withGitFile: true });
    failReadFile(`${path.sep}repoBad${path.sep}.git`, "EACCES");

    await cleanupOrphanTaskWorktrees(new Set());

    expect(await exists(bad)).toBe(true);
    expect(await exists(isolated)).toBe(true);
  });

  it("不含 .orphaned- 的普通孤儿容器：仍整个删除（行为不变）", async () => {
    await seedWorkDir("t_iso_none", "repoA");
    await cleanupOrphanTaskWorktrees(new Set());
    expect(await exists(path.join(getWorktreesRoot(), "t_iso_none"))).toBe(false);
  });
});
