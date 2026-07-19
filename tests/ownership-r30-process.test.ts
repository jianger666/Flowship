/**
 * Ownership R30：R29-2 ResourceJob 可中止子进程 + R29-3 preview spawn 最终准入
 *
 * ① 假长子进程（registerJobAbort）× stop revoke → abort 被调、join 速收敛、B 可起、A 补偿不碰 B
 * ② preview.beforeSpawn 挂起 × finalize → spawn 不执行、无新 pid
 * ③ preview.beforeSpawn 挂起 × DELETE → 同上
 * ④ 正常 preview / resource 链回归（start 成功有 pid；ensure 无 revoke 仍可完成）
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
  path.join(os.tmpdir(), "fe-ownership-r30-process-"),
);
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

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
  hasResourceJobs,
  registerJobAbort,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  beginChatLifecycle,
  clearChatGate,
  endChatLifecycle,
} = await import("@/lib/server/chat-gate");
const { cleanupChatTaskState } = await import("@/lib/server/chat-pending");
const { finalizeTask } = await import("@/lib/server/task-runner");
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const { getTask, listTasks, deleteTask } = await import("@/lib/server/task-fs");
const {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  WorktreeLeaseLostError,
} = await import("@/lib/server/task-worktrees");
const {
  getPreviewStatus,
  hasPreviewStarting,
  startPreview,
  stopAllPreviews,
  stopPreviewsForTask,
} = await import("@/lib/server/preview-manager");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r30-process DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

await listTasks();

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

const initGitRepo = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "r30@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r30"]);
  writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
};

const makeMeta = (id: string, repo: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r30 ${id}`,
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

describe("ownership R30 process（R29-2 / R29-3）", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r30_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    clearFailpoints();
  });

  afterEach(async () => {
    clearFailpoints();
    await stopAllPreviews().catch(() => {});
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
    }
  });

  // ─────────────────────────────────────────────────────────────
  // ① ResourceJob revoke → abort → join 收敛；B 可起；A 补偿不碰 B
  // ─────────────────────────────────────────────────────────────
  it(
    "R29-2①：假长子进程 × stop revoke → abort 被调、join 速收敛、B ensure 成功、A 补偿跳过",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r30-abort-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r30-abort", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;

      // 先建好 worktree（B 后续复用）；A 用假子进程占 resource job
      await ensureTaskWorktrees(task, () => true);
      const workDir = getTaskWorkRepoPaths(task)[0]!;
      const markerB = path.join(workDir, "b-owner.txt");

      // A：模拟超过 join 上限的假子进程（挂起 + 可观测 abort）
      const jobA = beginResourceJob(id);
      let abortCalls = 0;
      let jobADone = false;
      const hangGate = new Promise<void>((resolve) => {
        registerJobAbort(id, jobA.jobId, () => {
          abortCalls += 1;
          resolve();
        });
      });
      // 假「长命令」：等 abort 后才 end job（模拟子进程退出 → finally endResourceJob）
      const pJobA = hangGate.then(() => {
        registerJobAbort(id, jobA.jobId, null);
        endResourceJob(jobA);
        jobADone = true;
      });
      expect(hasResourceJobs(id)).toBe(true);

      const t0 = Date.now();
      const pStop = stopTaskAgent(task);
      await raceExpectSettled(pJobA, 5_000);
      await raceExpectSettled(pStop, 10_000);
      const elapsed = Date.now() - t0;

      expect(abortCalls).toBeGreaterThanOrEqual(1);
      expect(jobADone).toBe(true);
      expect(hasResourceJobs(id)).toBe(false);
      // revoke 后应远快于旧 30s 空等上限
      expect(elapsed).toBeLessThan(5_000);

      // B：stop 后可重新 ensure（写标记证明工作区归 B）
      clearChatGate(id);
      await writeMeta({
        ...(await readMetaV06(id))!,
        repoStatus: "developing",
        runStatus: "idle",
        updatedAt: Date.now(),
      });
      const taskB = (await getTask(id))!;
      await ensureTaskWorktrees(taskB, () => true);
      await fs.writeFile(markerB, "owned-by-B");
      expect(await fs.readFile(markerB, "utf8")).toBe("owned-by-B");

      // A 补偿路径：伪造「失主 + 后继活跃」——不应删 B 的标记
      //（复用 ensure 热路径：lease 立刻 false → 让位；workDir 仍在）
      await expect(
        ensureTaskWorktrees(taskB, () => false),
      ).rejects.toBeInstanceOf(WorktreeLeaseLostError);
      expect(await fs.readFile(markerB, "utf8")).toBe("owned-by-B");
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ② preview × finalize
  // ─────────────────────────────────────────────────────────────
  it(
    "R29-3②：preview.beforeSpawn 挂起 × finalize → 不 spawn、无新 pid",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r30-prev-fin-"));
      initGitRepo(repo);
      await writeMeta(makeMeta(id, repo));
      await fs.mkdir(taskDir(id), { recursive: true });

      const hang = installHangingFailpoint("preview.beforeSpawn");
      const pStart = startPreview({
        taskId: id,
        taskTitle: "r30-prev",
        repoPath: repo,
        workDir: TMP_ROOT,
        command: "sleep 60",
      });
      await hang.waitHit();
      expect(hasPreviewStarting(id)).toBe(true);

      // finalize 须在 failpoint 挂起期间完成（stopPreviews 不与队列死锁）
      await raceExpectSettled(finalizeTask(id, "abandoned"), 15_000);
      expect((await readMetaV06(id))?.repoStatus).toBe("abandoned");

      hang.release();
      const result = await raceExpectSettled(pStart, 10_000);
      expect(result.yielded).toBe(true);
      expect(
        getPreviewStatus().filter((s) => s.taskId === id && !s.exited),
      ).toHaveLength(0);
      // 无活 pid（yielded 路径不 spawn）
      expect(result.status.exited).toBe(true);
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ③ preview × DELETE
  // ─────────────────────────────────────────────────────────────
  it(
    "R29-3③：preview.beforeSpawn 挂起 × DELETE → 不 spawn、无新 pid",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r30-prev-del-"));
      initGitRepo(repo);
      await writeMeta(makeMeta(id, repo));
      await fs.mkdir(taskDir(id), { recursive: true });

      const hang = installHangingFailpoint("preview.beforeSpawn");
      const pStart = startPreview({
        taskId: id,
        taskTitle: "r30-del",
        repoPath: repo,
        workDir: TMP_ROOT,
        command: "sleep 60",
      });
      await hang.waitHit();

      // 模拟 DELETE owner：占 deleting lifecycle + deleteTask（含 stopPreviews）
      const began = beginChatLifecycle(id, "deleting");
      expect(began).toBe(true);
      try {
        await raceExpectSettled(deleteTask(id), 15_000);
      } finally {
        endChatLifecycle(id, "deleting");
      }
      expect(await readMetaV06(id)).toBeNull();

      hang.release();
      const result = await raceExpectSettled(pStart, 10_000);
      expect(result.yielded).toBe(true);
      expect(
        getPreviewStatus().filter((s) => s.taskId === id && !s.exited),
      ).toHaveLength(0);
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ④ 正常回归
  // ─────────────────────────────────────────────────────────────
  it(
    "R29-3④：正常 preview start 有 pid；resource ensure 无 revoke 可完成",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r30-ok-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r30-ok", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;

      await ensureTaskWorktrees(task, () => true);
      expect(hasResourceJobs(id)).toBe(false);

      const started = await startPreview({
        taskId: id,
        taskTitle: "r30-ok",
        repoPath: repo,
        workDir: TMP_ROOT,
        command: "sleep 30",
      });
      expect(started.yielded).toBeFalsy();
      expect(started.status.exited).toBe(false);
      const slots = getPreviewStatus().filter((s) => s.taskId === id);
      expect(slots).toHaveLength(1);
      expect(slots[0]?.exited).toBe(false);

      await stopPreviewsForTask(id);
      expect(
        getPreviewStatus().filter((s) => s.taskId === id && !s.exited),
      ).toHaveLength(0);
    },
    30_000,
  );

  it("R29-2：revokeResourceJobs 不误杀无 abort 的 job（仅清登记）", async () => {
    const id = alloc();
    const job = beginResourceJob(id);
    expect(hasResourceJobs(id)).toBe(true);
    // 未 register abort——revoke 应为 no-op，job 仍在
    const { revokeResourceJobs } = await import("@/lib/server/resource-jobs");
    revokeResourceJobs(id);
    expect(hasResourceJobs(id)).toBe(true);
    endResourceJob(job);
    expect(hasResourceJobs(id)).toBe(false);
  });
});
