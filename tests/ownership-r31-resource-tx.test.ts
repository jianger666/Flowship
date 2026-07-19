/**
 * Ownership R31 / R30-2：ResourceJob 覆盖完整资源事务 + join 超时 fail-closed quarantine
 *
 * ① abort 不结束 job（模拟慢清理）+ join 超时 → quarantine、B ensure 被拒、stop HTTP 已返回
 * ② 旧事务结束（job 归零）→ quarantine 清除、B 可正常 ensure
 * ③ 补偿逐仓 remove 前 successor 现查——身份检查窗口注入 B → A 不删该仓
 * ④ 正常快速路径回归（无 quarantine 误伤）
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
  path.join(os.tmpdir(), "fe-ownership-r31-resource-tx-"),
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
  allocTaskRunInstanceId,
  beginResourceJob,
  claimTaskOp,
  clearResourceJobs,
  clearTaskStarting,
  endResourceJob,
  getTaskOpGeneration,
  hasResourceJobs,
  isWorkspaceQuarantined,
  registerJobAbort,
  runningTasks,
  setResourceJoinTimeoutMsForTest,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { cleanupChatTaskState } = await import("@/lib/server/chat-pending");
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  WorktreeLeaseLostError,
} = await import("@/lib/server/task-worktrees");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r31-resource-tx DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
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
  execFileSync("git", ["-C", dir, "config", "user.email", "r31@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r31"]);
  writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
};

const makeMeta = (id: string, repo: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r31 ${id}`,
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

describe("ownership R31 / R30-2 resource tx + quarantine", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r31_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    clearFailpoints();
    setResourceJoinTimeoutMsForTest(null);
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
  // ①② abort 不 settle + join 超时 quarantine → job 归零后解除
  // ─────────────────────────────────────────────────────────────
  it(
    "R30-2①②：abort 不结束 job × join 超时 → quarantine 挡 B；job 归零后 B 可 ensure",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r31-q-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r31-q", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;

      await ensureTaskWorktrees(task, () => true);
      const workDir = getTaskWorkRepoPaths(task)[0]!;
      const markerB = path.join(workDir, "b-owner.txt");

      // A：abort 只记次数、**不** end job——模拟 abort 后慢清理仍占事务
      const jobA = beginResourceJob(id);
      let abortCalls = 0;
      registerJobAbort(id, jobA.jobId, () => {
        abortCalls += 1;
      });
      expect(hasResourceJobs(id)).toBe(true);
      expect(isWorkspaceQuarantined(id)).toBe(false);

      // 缩短 join 上限，避免单测空等 30s
      setResourceJoinTimeoutMsForTest(250);

      let stopDone = false;
      const pStop = stopTaskAgent(task).then((r) => {
        stopDone = true;
        return r;
      });

      await raceExpectSettled(pStop, 5_000);
      expect(stopDone).toBe(true);
      expect(abortCalls).toBeGreaterThanOrEqual(1);
      // stop HTTP 已返回，但 job 仍在 + quarantine 已置
      expect(hasResourceJobs(id)).toBe(true);
      expect(isWorkspaceQuarantined(id)).toBe(true);

      // B：不得复用同路径
      clearChatGate(id);
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
      expect(isWorkspaceQuarantined(id)).toBe(true);

      // ② 旧事务结束 → quarantine 清除 → B 可 ensure
      registerJobAbort(id, jobA.jobId, null);
      endResourceJob(jobA);
      expect(hasResourceJobs(id)).toBe(false);
      expect(isWorkspaceQuarantined(id)).toBe(false);

      await ensureTaskWorktrees(taskB, () => true);
      await fs.writeFile(markerB, "owned-by-B");
      expect(await fs.readFile(markerB, "utf8")).toBe("owned-by-B");
    },
    30_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ③ 补偿逐仓现查：remove 前注入 B → 不删
  // ─────────────────────────────────────────────────────────────
  it(
    "R30-2③：compensate.beforeRemove 注入后继 B → A 跳过该仓、worktree 保留",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r31-comp-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r31-comp", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;

      let leaseOk = true;
      // afterAdd 失主 → 进补偿；补偿循环在 beforeRemove 挂起
      const hangAdd = installHangingFailpoint("worktree.afterAdd");
      const hangComp = installHangingFailpoint("compensate.beforeRemove");
      const p = ensureTaskWorktrees(task, () => leaseOk).catch(
        (err: unknown) => err,
      );
      await hangAdd.waitHit();

      // 入场时尚无后继——释放 afterAdd 让 A 进补偿（旧一次性快照会放行）
      leaseOk = false;
      hangAdd.release();
      await hangComp.waitHit();

      // 身份检查窗口后、remove 完成前注入 B——逐仓现查必须跳过
      claimTaskOp(id, getTaskOpGeneration(id));
      runningTasks.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agentId: "agent_B_r31",
        startedAt: Date.now(),
        startSnapshot: { title: `r31 ${id}` },
        cancel: vi.fn(),
      });

      hangComp.release();
      const settled = await raceExpectSettled(p, 30_000);
      expect(settled).toBeInstanceOf(WorktreeLeaseLostError);

      const list = execFileSync("git", ["-C", repo, "worktree", "list"], {
        encoding: "utf-8",
      });
      expect(list.includes(id)).toBe(true);
      const workDir = getTaskWorkRepoPaths(task)[0]!;
      expect(
        await fs.stat(workDir).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
    },
    45_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ④ 快速路径：无 quarantine 误伤
  // ─────────────────────────────────────────────────────────────
  it(
    "R30-2④：正常快速 abort→end job → stop 无 quarantine、B ensure 成功",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r31-fast-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r31-fast", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;

      await ensureTaskWorktrees(task, () => true);
      const workDir = getTaskWorkRepoPaths(task)[0]!;

      const jobA = beginResourceJob(id);
      const hangGate = new Promise<void>((resolve) => {
        registerJobAbort(id, jobA.jobId, () => {
          resolve();
        });
      });
      const pJobA = hangGate.then(() => {
        registerJobAbort(id, jobA.jobId, null);
        endResourceJob(jobA);
      });

      const pStop = stopTaskAgent(task);
      await raceExpectSettled(pJobA, 5_000);
      await raceExpectSettled(pStop, 10_000);

      expect(hasResourceJobs(id)).toBe(false);
      expect(isWorkspaceQuarantined(id)).toBe(false);

      clearChatGate(id);
      await writeMeta({
        ...(await readMetaV06(id))!,
        repoStatus: "developing",
        runStatus: "idle",
        updatedAt: Date.now(),
      });
      const taskB = (await getTask(id))!;
      await ensureTaskWorktrees(taskB, () => true);
      await fs.writeFile(path.join(workDir, "fast-ok.txt"), "ok");
      expect(await fs.readFile(path.join(workDir, "fast-ok.txt"), "utf8")).toBe(
        "ok",
      );
    },
    30_000,
  );
});
