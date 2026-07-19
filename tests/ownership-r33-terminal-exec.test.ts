/**
 * Ownership R33 / R32-3 + R32-4 + R32-6 退出测试
 *
 * ① cleanup 已转 executing（failpoint 在 removeTaskWorktrees pathExists 后）
 *    → reopen 409、prewarm 不入场、B marker 保留
 * ② waiting 阶段 reopen 照旧作废
 * ③ 跨 vi.resetModules 的 gen ABA——新旧 token 永不相等、A validity 恒 false
 * ④ 真实 git ref：tombstone 后模拟重启 → boot 先清 refs 再 rm
 * ⑤ refs 清到一半崩溃再重启 → 最终一致
 * ⑥ 共享 treeOid 的其它 task ref 保留
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-ownership-r33-terminal-"),
);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({
    servers,
    dropped: [],
  }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));
vi.mock("@/lib/server/update-pending", () => ({
  assertNoUpdatePendingRestart: async () => {},
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  beginResourceJob,
  clearResourceJobs,
  clearTaskStarting,
  endResourceJob,
  getTerminalCleanupPhase,
  hasTerminalCleanup,
  holdTerminalCleanup,
  invalidateTerminalCleanupForReopen,
  isTerminalCleanupGenValid,
  isWorkspaceQuarantined,
  registerJobAbort,
  runningTasks,
  setResourceJoinTimeoutMsForTest,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { cleanupChatTaskState } = await import("@/lib/server/chat-pending");
const {
  getDeletionJournalPath,
  getTask,
  listTasks,
  recoverDeletedTaskArtifacts,
  writeDeleteTombstone,
} = await import("@/lib/server/task-fs");
const {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
} = await import("@/lib/server/task-worktrees");
const {
  finalizeTask,
  reopenTask,
  TaskCleanupInProgressError,
} = await import("@/lib/server/task-runner");
const {
  checkpointRefName,
  writeRewindPoints,
} = await import("@/lib/server/chat-checkpoint");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r33-terminal DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";

const skipBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  g[RECOVERY_FLAG] = Promise.resolve();
};

const resetBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  delete g[RECOVERY_FLAG];
};

await listTasks();
skipBootRecovery();

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const raceExpectSettled = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
  const result = await Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`Promise 未在 ${ms}ms 内 settle`);
    }),
  ]);
  return result as T;
};

const installHangingFailpoint = (name: string) => {
  let hitResolve!: () => void;
  const hit = new Promise<void>((r) => {
    hitResolve = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setFailpoint(name, async () => {
    hitResolve();
    await gate;
  });
  return { waitHit: () => hit, release: () => release() };
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const initGitRepo = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "r33@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r33"]);
  writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
};

const refExists = (cwd: string, ref: string): boolean => {
  try {
    git(cwd, "show-ref", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
};

const treeOidOfHead = (cwd: string): string =>
  git(cwd, "rev-parse", "HEAD^{tree}");

const makeMeta = (id: string, repo: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r33 ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [repo],
    isolateWorktree: true,
    repoBaseBranches: { [repo]: "main" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const dirExists = async (dir: string): Promise<boolean> => {
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
};

describe("ownership R33 / R32-3+4+6 terminal exec + journal", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r33_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    clearFailpoints();
    setResourceJoinTimeoutMsForTest(null);
    skipBootRecovery();
  });

  afterEach(async () => {
    clearFailpoints();
    setResourceJoinTimeoutMsForTest(null);
    for (const id of ids.splice(0)) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      clearTaskStarting(id);
      clearResourceJobs(id);
      clearChatGate(id);
      cleanupChatTaskState(id);
      try {
        rmSync(taskDir(id), { recursive: true, force: true });
      } catch {
        /* noop */
      }
      try {
        rmSync(getDeletionJournalPath(id), { force: true });
      } catch {
        /* noop */
      }
    }
  });

  // ─────────────────────────────────────────────────────────────
  // ① executing 阶段 reopen 409
  // ─────────────────────────────────────────────────────────────
  it(
    "R32-3①：cleanup 已转 executing → reopen 409、prewarm 不入场、B marker 保留",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r33-exec-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r33-exec", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;

      await ensureTaskWorktrees(task, () => true);
      const workDir = getTaskWorkRepoPaths(task)[0]!;
      const markerB = path.join(workDir, "b-owned.txt");
      await fs.writeFile(markerB, "owned-by-B");

      const jobA = beginResourceJob(id);
      registerJobAbort(id, jobA.jobId, () => {});
      setResourceJoinTimeoutMsForTest(200);

      // 挂在 remove 内部 pathExists 之后——此时必已 markTerminalCleanupExecuting
      const hang = installHangingFailpoint(
        "removeTaskWorktrees.afterPathExists",
      );
      const pFin = finalizeTask(id, "abandoned");
      await raceExpectSettled(pFin, 10_000);
      expect(hasTerminalCleanup(id)).toBe(true);

      endResourceJob(jobA);
      await hang.waitHit();
      expect(getTerminalCleanupPhase(id)).toBe("executing");
      expect(isWorkspaceQuarantined(id)).toBe(true);

      // executing → 409，不得解除 quarantine / 放行 ensure
      await expect(reopenTask(id)).rejects.toBeInstanceOf(
        TaskCleanupInProgressError,
      );
      expect(hasTerminalCleanup(id)).toBe(true);
      expect(isWorkspaceQuarantined(id)).toBe(true);
      expect(getTerminalCleanupPhase(id)).toBe("executing");

      // 人工翻 developing 也进不了 ensure（quarantine 仍在）
      await writeMeta({
        ...(await readMetaV06(id))!,
        repoStatus: "developing",
        runStatus: "idle",
        updatedAt: Date.now(),
      });
      const taskB = (await getTask(id))!;
      await expect(ensureTaskWorktrees(taskB, () => true)).rejects.toThrow(
        /quarantine|R30-2/,
      );

      hang.release();
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && hasTerminalCleanup(id)) {
        await sleep(50);
      }
      // remove 会删掉旧 worktree——本用例断言的是「executing 期间」marker 未被
      // reopen/prewarm 抢占覆盖；挂起期间 marker 必须仍在
      // （放行后旧 cleanup 合法删除，不再要求 marker）
      expect(hasTerminalCleanup(id)).toBe(false);
    },
    40_000,
  );

  // 放行前单独断言 marker：与上用例同一 setup 的精简版
  it(
    "R32-3①b：executing 挂起期间 B marker 始终保留（reopen 失败不放行 prewarm）",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r33-execb-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r33-execb", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;
      await ensureTaskWorktrees(task, () => true);
      const workDir = getTaskWorkRepoPaths(task)[0]!;
      const markerB = path.join(workDir, "b-owned.txt");
      await fs.writeFile(markerB, "owned-by-B");

      const jobA = beginResourceJob(id);
      registerJobAbort(id, jobA.jobId, () => {});
      setResourceJoinTimeoutMsForTest(200);
      const hang = installHangingFailpoint(
        "removeTaskWorktrees.afterPathExists",
      );
      await raceExpectSettled(finalizeTask(id, "abandoned"), 10_000);
      endResourceJob(jobA);
      await hang.waitHit();

      await expect(reopenTask(id)).rejects.toBeInstanceOf(
        TaskCleanupInProgressError,
      );
      expect(await fs.readFile(markerB, "utf8")).toBe("owned-by-B");
      expect(await dirExists(workDir)).toBe(true);

      hang.release();
      await sleep(400);
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ② waiting 阶段 reopen 照旧作废
  // ─────────────────────────────────────────────────────────────
  it(
    "R32-3②：waiting 阶段 reopen 照旧作废、旧 cleanup 让位、B marker 保留",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r33-wait-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r33-wait", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;
      await ensureTaskWorktrees(task, () => true);
      const workDir = getTaskWorkRepoPaths(task)[0]!;

      const jobA = beginResourceJob(id);
      registerJobAbort(id, jobA.jobId, () => {});
      setResourceJoinTimeoutMsForTest(200);

      // waiting：挂在转 executing 之前
      const hang = installHangingFailpoint("finalize.beforeDeferredRemove");
      await raceExpectSettled(finalizeTask(id, "abandoned"), 10_000);
      endResourceJob(jobA);
      await hang.waitHit();
      expect(getTerminalCleanupPhase(id)).toBe("waiting");

      await reopenTask(id);
      expect(hasTerminalCleanup(id)).toBe(false);
      expect(isWorkspaceQuarantined(id)).toBe(false);

      const taskB = (await getTask(id))!;
      await ensureTaskWorktrees(taskB, () => true);
      const markerB = path.join(workDir, "b-owned.txt");
      await fs.writeFile(markerB, "owned-by-B");

      hang.release();
      await sleep(400);
      expect(await fs.readFile(markerB, "utf8")).toBe("owned-by-B");
      expect(await dirExists(workDir)).toBe(true);
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ④⑤⑥ checkpoint refs journal + boot（ABA 用例放最后，避免 resetModules 污染）
  // ─────────────────────────────────────────────────────────────
  it(
    "R32-6④：tombstone 后模拟重启 → boot 先清 refs 再 rm、refs 与 taskDir 都消失",
    async () => {
      const id = alloc();
      const idOther = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r33-refs-"));
      initGitRepo(repo);
      const treeOid = treeOidOfHead(repo);
      const refA = checkpointRefName(id, treeOid);
      const refOther = checkpointRefName(idOther, treeOid);
      // ⑥ 共享 treeOid：另一 task 的 ref 必须保留
      git(repo, "update-ref", refA, treeOid);
      git(repo, "update-ref", refOther, treeOid);
      expect(refExists(repo, refA)).toBe(true);
      expect(refExists(repo, refOther)).toBe(true);

      await writeMeta(makeMeta(id, repo));
      await fs.mkdir(path.join(taskDir(id), "checkpoints"), {
        recursive: true,
      });
      await writeRewindPoints(id, [
        {
          eventId: `e_${Date.now()}`,
          createdAt: Date.now(),
          repoSnapshots: [{ repoPath: repo, treeOid }],
          kind: "checkpoint",
        },
      ]);

      // 写 tombstone + journal，模拟 DELETE 200 后、后台清 refs 前进程退出
      await writeDeleteTombstone(id);
      expect(await dirExists(getDeletionJournalPath(id))).toBe(true);
      expect(refExists(repo, refA)).toBe(true);

      // 模拟重启：清内存，触发 boot
      clearResourceJobs(id);
      clearChatGate(id);
      resetBootRecovery();
      await listTasks();
      skipBootRecovery();

      expect(await dirExists(taskDir(id))).toBe(false);
      expect(await dirExists(getDeletionJournalPath(id))).toBe(false);
      expect(refExists(repo, refA)).toBe(false);
      // ⑥ 其它 task 的同 treeOid ref 保留
      expect(refExists(repo, refOther)).toBe(true);

      // 清理 other ref
      try {
        git(repo, "update-ref", "-d", refOther);
      } catch {
        /* noop */
      }
    },
    40_000,
  );

  it(
    "R32-6⑤：refs 清到一半崩溃再重启 → 最终一致",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r33-mid-"));
      initGitRepo(repo);
      // 两条不同 tree——写两个文件各 commit，拿两个 treeOid
      writeFileSync(path.join(repo, "a.txt"), "v2");
      git(repo, "add", "-A");
      git(repo, "commit", "-m", "v2");
      const tree1 = treeOidOfHead(repo);
      writeFileSync(path.join(repo, "a.txt"), "v3");
      git(repo, "add", "-A");
      git(repo, "commit", "-m", "v3");
      const tree2 = treeOidOfHead(repo);
      expect(tree1).not.toBe(tree2);

      const ref1 = checkpointRefName(id, tree1);
      const ref2 = checkpointRefName(id, tree2);
      git(repo, "update-ref", ref1, tree1);
      git(repo, "update-ref", ref2, tree2);

      await writeMeta(makeMeta(id, repo));
      await fs.mkdir(path.join(taskDir(id), "checkpoints"), {
        recursive: true,
      });
      await writeRewindPoints(id, [
        {
          eventId: "e1",
          createdAt: Date.now(),
          repoSnapshots: [{ repoPath: repo, treeOid: tree1 }],
          kind: "checkpoint",
        },
        {
          eventId: "e2",
          createdAt: Date.now() + 1,
          repoSnapshots: [{ repoPath: repo, treeOid: tree2 }],
          kind: "checkpoint",
        },
      ]);

      await writeDeleteTombstone(id);

      // 后台清 refs：首个成功 delete 后挂起 =「清到一半」；不放行 = 模拟进程退出
      const hang = installHangingFailpoint("checkpointRefs.afterFirstDelete");
      void recoverDeletedTaskArtifacts(id);
      await raceExpectSettled(hang.waitHit(), 10_000);
      // 崩溃点：至少删掉一条 ref，journal + taskDir 仍在，另一条可能残留
      const goneCount = [ref1, ref2].filter((r) => !refExists(repo, r)).length;
      expect(goneCount).toBeGreaterThanOrEqual(1);
      expect(await dirExists(getDeletionJournalPath(id))).toBe(true);
      expect(await dirExists(taskDir(id))).toBe(true);
      // 摘掉 failpoint，不 release 旧 Promise（模拟进程死、旧栈不再继续）
      clearFailpoint("checkpointRefs.afterFirstDelete");

      // 重启 boot：journal 仍在 → 清完剩余 refs + rm taskDir + 删 journal
      clearResourceJobs(id);
      clearChatGate(id);
      resetBootRecovery();
      await listTasks();
      skipBootRecovery();

      expect(await dirExists(taskDir(id))).toBe(false);
      expect(await dirExists(getDeletionJournalPath(id))).toBe(false);
      expect(refExists(repo, ref1)).toBe(false);
      expect(refExists(repo, ref2)).toBe(false);

      // 放行崩溃前挂起的 Promise（failpoint 已摘、后续幂等 no-op），避免挂死 worker
      hang.release();
      await sleep(100);
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ③ 跨 resetModules gen ABA（必须最后：resetModules 换掉后续模块单例）
  // ─────────────────────────────────────────────────────────────
  it("R32-4③：跨 vi.resetModules 新旧 gen 永不相等、A validity 恒 false", async () => {
    const id = `t_r33_aba_${Date.now()}`;
    ids.push(id);

    const genA = holdTerminalCleanup(id);
    expect(isTerminalCleanupGenValid(id, genA)).toBe(true);
    expect(invalidateTerminalCleanupForReopen(id)).toBe("invalidated");
    expect(isTerminalCleanupGenValid(id, genA)).toBe(false);

    // 模拟 route-chunk / HMR：模块局部 let 会从零，但发号器在 globalThis
    vi.resetModules();
    const rjB = await import("@/lib/server/resource-jobs");
    const genB = rjB.holdTerminalCleanup(id);
    expect(genB).not.toBe(genA);
    expect(rjB.isTerminalCleanupGenValid(id, genA)).toBe(false);
    expect(rjB.isTerminalCleanupGenValid(id, genB)).toBe(true);

    rjB.clearResourceJobs(id);
  });
});
