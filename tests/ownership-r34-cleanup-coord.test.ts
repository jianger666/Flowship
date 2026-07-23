/**
 * Ownership R34 / R33-2 + R33-3：TerminalCleanupCoordinator 退出测试
 *
 * ① waiting 期第二次 finalize → join、remove 只调一次、phase 不倒退
 * ② executing 期第二次 finalize → join、不能提前 release
 * ③ 第一 holder 未完成前 reopen/prewarm 恒 409
 * ④ 同步 remove（无 ResourceJob）挂 afterPathExists × reopen → 409；
 *    release 后 reopen 才成功（复刻 Codex 探针、期望反转）
 * ⑤ DELETE 占 deleting × 并发 reopen → 409、不写 developing、不 prewarm
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
  path.join(os.tmpdir(), "fe-ownership-r34-cleanup-"),
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
  loadSkillsForTask: async () => [],
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
  beginResourceJob,
  clearResourceJobs,
  endResourceJob,
  getTerminalCleanupPhase,
  hasTerminalCleanup,
  registerJobAbort,
  setResourceJoinTimeoutMsForTest,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { beginChatLifecycle, clearChatGate, endChatLifecycle, getChatLifecycle } =
  await import("@/lib/server/chat-gate");
const { cleanupChatTaskState } = await import("@/lib/server/chat-pending");
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const taskWorktrees = await import("@/lib/server/task-worktrees");
const { ensureTaskWorktrees, getTaskWorkRepoPaths } = taskWorktrees;
const taskRunner = await import("@/lib/server/task-runner");
const {
  finalizeTask,
  prewarmTaskWorkspace,
  reopenTask,
  TaskCleanupInProgressError,
} = taskRunner;
const reopenRoute = await import("@/app/api/tasks/[id]/reopen/route");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r34-cleanup DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";

const skipBootRecovery = (): void => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  g[RECOVERY_FLAG] = Promise.resolve();
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
  execFileSync("git", ["-C", dir, "config", "user.email", "r34@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r34"]);
  writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
};

const makeMeta = (id: string, repo: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r34 ${id}`,
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

describe("ownership R34 TerminalCleanupCoordinator (R33-2/R33-3)", () => {
  const ids: string[] = [];
  let seq = 0;
  const alloc = (): string => {
    const id = `t_r34_${Date.now()}_${seq++}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    clearFailpoints();
    setResourceJoinTimeoutMsForTest(null);
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    clearFailpoints();
    setResourceJoinTimeoutMsForTest(null);
    for (const id of ids.splice(0)) {
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
  // ① waiting 期第二次 finalize → join、remove 一次、phase 不倒退
  // ─────────────────────────────────────────────────────────────
  it(
    "R33-2①：waiting 期第二次 finalize → join、remove 只调一次、phase 不倒退",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r34-wait-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r34-wait", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;
      await ensureTaskWorktrees(task, () => true);

      const jobA = beginResourceJob(id);
      registerJobAbort(id, jobA.jobId, () => {});
      setResourceJoinTimeoutMsForTest(200);

      const removeSpy = vi.spyOn(taskWorktrees, "removeTaskWorktrees");

      const hang = installHangingFailpoint("finalize.beforeDeferredRemove");
      const pFin1 = finalizeTask(id, "abandoned");
      await raceExpectSettled(pFin1, 10_000);
      endResourceJob(jobA);
      await hang.waitHit();
      expect(getTerminalCleanupPhase(id)).toBe("waiting");
      expect(hasTerminalCleanup(id)).toBe(true);

      // 第二次 finalize：应 join 在飞 cleanup，不得重写 phase→waiting、不得再起 remove
      const pFin2 = finalizeTask(id, "abandoned");
      // 仍挂在 waiting——phase 绝不能被第二 holder 改写（本就 waiting，关键是不倒退自 executing）
      expect(getTerminalCleanupPhase(id)).toBe("waiting");
      expect(removeSpy).toHaveBeenCalledTimes(0);

      hang.release();
      await raceExpectSettled(pFin2, 10_000);
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && hasTerminalCleanup(id)) {
        await sleep(50);
      }
      expect(hasTerminalCleanup(id)).toBe(false);
      expect(removeSpy).toHaveBeenCalledTimes(1);
      removeSpy.mockRestore();
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ② executing 期第二次 finalize → join、不能提前 release
  // ─────────────────────────────────────────────────────────────
  it(
    "R33-2②：executing 期第二次 finalize → join、不能提前 release",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r34-exec-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r34-exec", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;
      await ensureTaskWorktrees(task, () => true);

      const jobA = beginResourceJob(id);
      registerJobAbort(id, jobA.jobId, () => {});
      setResourceJoinTimeoutMsForTest(200);

      const hang = installHangingFailpoint(
        "removeTaskWorktrees.afterPathExists",
      );
      await raceExpectSettled(finalizeTask(id, "abandoned"), 10_000);
      endResourceJob(jobA);
      await hang.waitHit();
      expect(getTerminalCleanupPhase(id)).toBe("executing");

      // 第二次 finalize 启动——应挂在 join 上（holder 未 release 前不 settle）
      let fin2Settled = false;
      const pFin2 = finalizeTask(id, "abandoned").then(() => {
        fin2Settled = true;
      });
      await sleep(200);
      expect(fin2Settled).toBe(false);
      // 关键：phase 仍是 executing——第二 holder 不得降级回 waiting、不得 release
      expect(getTerminalCleanupPhase(id)).toBe("executing");
      expect(hasTerminalCleanup(id)).toBe(true);

      hang.release();
      await raceExpectSettled(pFin2, 10_000);
      expect(fin2Settled).toBe(true);
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && hasTerminalCleanup(id)) {
        await sleep(50);
      }
      expect(hasTerminalCleanup(id)).toBe(false);
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ③ 第一 holder 未完成前 reopen/prewarm 恒 409
  // ─────────────────────────────────────────────────────────────
  it(
    "R33-2③：第一 holder executing 未完成前 reopen/prewarm 恒 409",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r34-busy-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r34-busy", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;
      await ensureTaskWorktrees(task, () => true);

      const jobA = beginResourceJob(id);
      registerJobAbort(id, jobA.jobId, () => {});
      setResourceJoinTimeoutMsForTest(200);
      const hang = installHangingFailpoint(
        "removeTaskWorktrees.afterPathExists",
      );
      await raceExpectSettled(finalizeTask(id, "abandoned"), 10_000);
      endResourceJob(jobA);
      await hang.waitHit();
      expect(getTerminalCleanupPhase(id)).toBe("executing");

      await expect(reopenTask(id)).rejects.toBeInstanceOf(
        TaskCleanupInProgressError,
      );
      const metaStill = await readMetaV06(id);
      expect(metaStill?.repoStatus).toBe("abandoned");

      // prewarm：lifecycle 空但 quarantine 在——ensure 拒；不得把状态翻回 developing
      prewarmTaskWorkspace(id);
      await sleep(300);
      expect((await readMetaV06(id))?.repoStatus).toBe("abandoned");
      expect(hasTerminalCleanup(id)).toBe(true);

      hang.release();
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && hasTerminalCleanup(id)) {
        await sleep(50);
      }
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ④ 同步 remove × reopen（Codex 探针期望反转）
  // ─────────────────────────────────────────────────────────────
  it(
    "R33-3④：同步 remove 挂 afterPathExists × reopen → 409；release 后 reopen 成功",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r34-sync-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r34-sync", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;
      await ensureTaskWorktrees(task, () => true);
      const workDir = getTaskWorkRepoPaths(task)[0]!;
      const marker = path.join(workDir, "sync-owned.txt");
      await fs.writeFile(marker, "owned");

      // 无 ResourceJob → 同步 remove 路径；挂在 afterPathExists
      const hang = installHangingFailpoint(
        "removeTaskWorktrees.afterPathExists",
      );
      const pFin = finalizeTask(id, "abandoned");
      await hang.waitHit();
      // R33-3：同步路径也进 coordinator → executing
      expect(hasTerminalCleanup(id)).toBe(true);
      expect(getTerminalCleanupPhase(id)).toBe("executing");

      // Codex 探针原期望：reopen 成功穿越——现期望反转 409
      await expect(reopenTask(id)).rejects.toBeInstanceOf(
        TaskCleanupInProgressError,
      );
      expect((await readMetaV06(id))?.repoStatus).toBe("abandoned");
      expect(await fs.readFile(marker, "utf8")).toBe("owned");

      hang.release();
      await raceExpectSettled(pFin, 15_000);
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && hasTerminalCleanup(id)) {
        await sleep(50);
      }
      expect(hasTerminalCleanup(id)).toBe(false);

      // remove 完成 release 后 reopen 才成功
      await reopenTask(id);
      expect((await readMetaV06(id))?.repoStatus).toBe("developing");
    },
    40_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ⑤ DELETE deleting × 并发 reopen → 409
  // ─────────────────────────────────────────────────────────────
  it(
    "R33-3⑤：DELETE 占 deleting × 并发 reopen → 409、不写 developing、不 prewarm",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r34-del-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.repoStatus = "abandoned";
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r34-del", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });

      // 模拟 DELETE 已占 deleting（不改 DELETE route 本体）
      expect(beginChatLifecycle(id, "deleting")).toBe(true);
      expect(getChatLifecycle(id)).toBe("deleting");

      const prewarmSpy = vi.spyOn(taskRunner, "prewarmTaskWorkspace");

      const res = await reopenRoute.POST(
        new Request(`http://local/api/tasks/${id}/reopen`, { method: "POST" }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(409);
      expect((await readMetaV06(id))?.repoStatus).toBe("abandoned");
      expect(prewarmSpy).not.toHaveBeenCalled();
      expect(getChatLifecycle(id)).toBe("deleting");

      prewarmSpy.mockRestore();
      endChatLifecycle(id, "deleting");
    },
    20_000,
  );
});
