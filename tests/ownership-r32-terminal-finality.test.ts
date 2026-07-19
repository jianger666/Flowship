/**
 * Ownership R32 / R31-2 + R31-3：terminal cleanup reservation + DELETE durable tombstone
 *
 * ① finalize timeout → 旧 job end → delayed remove 前 reopen + 预热 → B 工作区不被旧 cleanup 删
 * ② quarantine 在 cleanup 完成前不解除（jobs 归零但 cleanup 在飞 → ensure 仍拒）
 * ③ DELETE 延迟分支返回的当下 listTasks/getTask 不可见
 * ④ 模拟重启（清内存 lifecycle/quarantine）→ boot recovery 见 tombstone 完成删除
 * ⑤ 并发 refresh 不回灌（tombstone 期间 list 稳定不含该任务）
 *
 * 前端 use-task-list：200 时逻辑删除已 durable、refresh 读不到——无需改动（见本文件末注释）。
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
  path.join(os.tmpdir(), "fe-ownership-r32-terminal-"),
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
const { DELETED_TOMBSTONE_FILE, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  beginResourceJob,
  clearResourceJobs,
  clearTaskStarting,
  endResourceJob,
  hasResourceJobs,
  hasTerminalCleanup,
  isWorkspaceQuarantined,
  registerJobAbort,
  runningTasks,
  setResourceJoinTimeoutMsForTest,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { clearChatGate, endChatLifecycle, getChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { cleanupChatTaskState } = await import("@/lib/server/chat-pending");
const {
  getTask,
  isTaskTombstoned,
  listTasks,
  writeDeleteTombstone,
} = await import("@/lib/server/task-fs");
const {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  WorktreeLeaseLostError,
} = await import("@/lib/server/task-worktrees");
const { finalizeTask, reopenTask } = await import("@/lib/server/task-runner");
const { DELETE: deleteTaskRoute } = await import(
  "@/app/api/tasks/[id]/route"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r32-terminal DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
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

const initGitRepo = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "r32@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r32"]);
  writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
};

const makeMeta = (id: string, repo: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r32 ${id}`,
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

describe("ownership R32 / R31-2 terminal cleanup + R31-3 DELETE tombstone", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r32_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    }
  });

  // ─────────────────────────────────────────────────────────────
  // ① reopen 后旧 delayed remove 让位，B 工作区保留
  // ─────────────────────────────────────────────────────────────
  it(
    "R31-2①：finalize timeout × delayed remove 前 reopen → 旧 cleanup 让位、B marker 仍在",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r32-reopen-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r32-reopen", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;

      await ensureTaskWorktrees(task, () => true);
      const workDir = getTaskWorkRepoPaths(task)[0]!;

      // 挂住旧 job：finalize join 超时 → quarantine + deferred cleanup
      const jobA = beginResourceJob(id);
      registerJobAbort(id, jobA.jobId, () => {});
      setResourceJoinTimeoutMsForTest(200);

      const hang = installHangingFailpoint("finalize.beforeDeferredRemove");
      const pFin = finalizeTask(id, "abandoned");
      await raceExpectSettled(pFin, 10_000);
      expect(isWorkspaceQuarantined(id)).toBe(true);
      expect(hasTerminalCleanup(id)).toBe(true);

      // 旧 job 归零 → waiter 放行到 failpoint；quarantine 因 cleanup hold 仍在
      endResourceJob(jobA);
      expect(hasResourceJobs(id)).toBe(false);
      await hang.waitHit();
      expect(isWorkspaceQuarantined(id)).toBe(true);
      expect(hasTerminalCleanup(id)).toBe(true);

      // reopen 作废旧 cleanup + 解除 quarantine → 预热/ensure 重建
      await reopenTask(id);
      expect(isWorkspaceQuarantined(id)).toBe(false);
      expect(hasTerminalCleanup(id)).toBe(false);

      const taskB = (await getTask(id))!;
      await ensureTaskWorktrees(taskB, () => true);
      const markerB = path.join(workDir, "b-owned.txt");
      await fs.writeFile(markerB, "owned-by-B");

      // 放行旧 cleanup——应发现 gen 失效让位，不得删 B
      hang.release();
      await sleep(400);
      expect(await fs.readFile(markerB, "utf8")).toBe("owned-by-B");
      expect(await dirExists(workDir)).toBe(true);
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ② jobs 归零但 cleanup 在飞 → ensure 仍拒
  // ─────────────────────────────────────────────────────────────
  it(
    "R31-2②：jobs 归零但 terminal cleanup 在飞 → quarantine 不解除、ensure 仍拒",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r32-hold-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r32-hold", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;
      await ensureTaskWorktrees(task, () => true);

      const jobA = beginResourceJob(id);
      registerJobAbort(id, jobA.jobId, () => {});
      setResourceJoinTimeoutMsForTest(200);

      const hang = installHangingFailpoint("finalize.beforeDeferredRemove");
      await raceExpectSettled(finalizeTask(id, "abandoned"), 10_000);
      expect(hasTerminalCleanup(id)).toBe(true);

      endResourceJob(jobA);
      await hang.waitHit();
      // 关键断言：jobs==0 ≠ quarantine 解除
      expect(hasResourceJobs(id)).toBe(false);
      expect(isWorkspaceQuarantined(id)).toBe(true);

      // 人工翻回 developing 测 ensure gate（不走 reopen，避免 invalidate）
      await writeMeta({
        ...(await readMetaV06(id))!,
        repoStatus: "developing",
        runStatus: "idle",
        updatedAt: Date.now(),
      });
      const taskB = (await getTask(id))!;
      await expect(ensureTaskWorktrees(taskB, () => true)).rejects.toBeInstanceOf(
        WorktreeLeaseLostError,
      );

      hang.release();
      // cleanup 完成后 quarantine 应解除
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && isWorkspaceQuarantined(id)) {
        await sleep(50);
      }
      expect(isWorkspaceQuarantined(id)).toBe(false);
      expect(hasTerminalCleanup(id)).toBe(false);
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ③④⑤ DELETE durable tombstone
  // ─────────────────────────────────────────────────────────────
  it(
    "R31-3③④⑤：DELETE 延迟分支立刻 list/get 不可见；清内存后 boot 完成物理删；refresh 不回灌",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r32-del-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });

      // 挂住 resource job → DELETE join 超时走延迟分支
      const jobA = beginResourceJob(id);
      registerJobAbort(id, jobA.jobId, () => {});
      setResourceJoinTimeoutMsForTest(200);

      const res = await raceExpectSettled(
        deleteTaskRoute(new Request(`http://local/api/tasks/${id}`, {
          method: "DELETE",
        }), { params: Promise.resolve({ id }) }),
        15_000,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean };
      expect(body.ok).toBe(true);

      // ③ 返回当下：tombstone 已落盘，list/get 不可见（meta 可能仍在）
      expect(await isTaskTombstoned(id)).toBe(true);
      expect(await getTask(id)).toBeNull();
      const listed1 = await listTasks();
      expect(listed1.some((t) => t.id === id)).toBe(false);
      // meta 仍可直接读到（证明是逻辑删、非已物理 rm）
      expect(await readMetaV06(id)).not.toBeNull();

      // ⑤ 并发 refresh 不回灌
      const [listedA, listedB] = await Promise.all([listTasks(), listTasks()]);
      expect(listedA.some((t) => t.id === id)).toBe(false);
      expect(listedB.some((t) => t.id === id)).toBe(false);

      // ④ 模拟进程重启：清内存 lifecycle / quarantine / jobs（后台 Promise 丢弃）
      // 注意：不 end 旧 job——模拟进程退出后内存全丢；tombstone 留在盘上
      clearResourceJobs(id);
      if (getChatLifecycle(id) === "deleting") {
        endChatLifecycle(id, "deleting");
      }
      clearChatGate(id);
      // 防止 afterEach 的 endResourceJob 语义干扰：job 句柄已随 clear 消失
      void jobA;

      // boot recovery 见 tombstone → 物理删除
      resetBootRecovery();
      const listedAfterBoot = await listTasks();
      expect(listedAfterBoot.some((t) => t.id === id)).toBe(false);
      expect(await dirExists(taskDir(id))).toBe(false);
      skipBootRecovery();
    },
    40_000,
  );

  it("R31-3：writeDeleteTombstone 原子协议——list/get 跳过、与既有 EBUSY 降级同文件名", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id, mkdtempSync(path.join(TMP_ROOT, "r32-tb-"))));
    expect(await getTask(id)).not.toBeNull();

    await writeDeleteTombstone(id);
    expect(
      await dirExists(path.join(taskDir(id), DELETED_TOMBSTONE_FILE)),
    ).toBe(true);
    expect(await getTask(id)).toBeNull();
    expect((await listTasks()).some((t) => t.id === id)).toBe(false);
  });
});

/*
 * 前端报告（R31-3）：use-task-list.tsx deleteTaskById 在收到 ok 后 unmarkDeleting，
 * 并假设「服务端已无此任务」。写 tombstone 后 listTasks 跳过该 id，refresh 不会回灌——
 * 无需改前端。
 */
