/**
 * Ownership R29 交叉审查修复·task 侧
 *
 * ① 失主补偿 × 后继活跃 worktree → 不删（留孤儿）
 * ② stop join resourceJobs（在飞 job 结束才收尾）
 * ③ cancel done × B takeover → 无 done envelope
 * ④ 屏障超时 × createMR 仍 pending → check 不启动、notifier 返 busy
 * ⑤ claim 互斥：双 submit_mr 第二路拒（R29-1 tryClaimSideEffect）
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task } from "@/lib/types";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-ownership-r29-taskside-"),
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

const mockCreateMR = vi.fn();
const mockGetMRMergeStatus = vi.fn();
const mockCloseOpenMR = vi.fn();
vi.mock("@/lib/server/gitlab-client", () => ({
  createMR: (...args: unknown[]) => mockCreateMR(...args),
  getMRMergeStatus: (...args: unknown[]) => mockGetMRMergeStatus(...args),
  closeOpenMR: (...args: unknown[]) => mockCloseOpenMR(...args),
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
vi.mock("@/lib/server/update-pending", () => ({
  assertNoUpdatePendingRestart: async () => {},
}));

const mockRunActionCheck = vi.fn(async () => ({
  passed: true,
  details: "ok",
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: () => mockRunActionCheck(),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { taskDir, writeMeta } = taskFsCore;
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
  runningChecks,
  runningTasks,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { clearChatGate } = await import("@/lib/server/chat-gate");
const {
  cleanupChatTaskState,
  runTaskAction,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { buildSessionBridges, deliverAskReply } = await import(
  "@/lib/server/task-runner"
);
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const {
  clearActionSideEffects,
  hasActionSideEffect,
  releaseSideEffect,
  tryClaimSideEffect,
} = await import("@/lib/server/action-side-effects");
const {
  ensureTaskWorktrees,
  getTaskWorkRepoPaths,
  WorktreeLeaseLostError,
} = await import("@/lib/server/task-worktrees");
const { stopTaskAgent } = await import("@/lib/server/stop-task");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r29-taskside DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

await listTasks();

const REMOTE_URL = "git@git.corp.com:group/proj.git";
const PROJECT_PATH = "group/proj";
let SUBMIT_REPO = "";

const CREDS = {
  apiKey: "k",
  model: { id: "m", params: [] as never[] },
};

beforeAll(() => {
  SUBMIT_REPO = mkdtempSync(path.join(os.tmpdir(), "ownership-r29-submit-"));
  execFileSync("git", ["init"], { cwd: SUBMIT_REPO });
  execFileSync("git", ["remote", "add", "origin", REMOTE_URL], {
    cwd: SUBMIT_REPO,
  });
});

afterAll(() => {
  if (SUBMIT_REPO) {
    rmSync(SUBMIT_REPO, { recursive: true, force: true });
  }
  rmSync(TMP_ROOT, { recursive: true, force: true });
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
  execFileSync("git", ["-C", dir, "config", "user.email", "r29@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r29"]);
  writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
};

const makeMeta = (id: string, repo?: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r29-taskside ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: repo ? [repo] : [],
    isolateWorktree: !!repo,
    repoBaseBranches: repo ? { [repo]: "main" } : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const seedShipRunning = async (id: string): Promise<void> => {
  const meta = makeMeta(id);
  meta.runStatus = "running";
  meta.currentActionId = "act_ship";
  meta.repoPaths = [SUBMIT_REPO];
  meta.gitBranches = [
    {
      repoPath: SUBMIT_REPO,
      name: "feature/me/123-x",
      baseBranch: "master",
    },
  ] as TaskMetaV06["gitBranches"];
  meta.repoTestBranches = {
    [SUBMIT_REPO]: "test",
  } as TaskMetaV06["repoTestBranches"];
  meta.actions = [
    {
      id: "act_ship",
      n: 1,
      type: "ship",
      status: "running",
      userInstruction: "",
      artifactPath: "actions/1-ship.md",
      startedAt: Date.now(),
      endedAt: null,
    },
  ] as TaskMetaV06["actions"];
  await writeMeta(meta);
};

const registerBridgesForTest = (
  task: Task,
  opts: { callerToken: string; gitToken?: string },
) => {
  const bridges = buildSessionBridges(task, opts);
  setChatTaskActionHandler(
    task.id,
    bridges.taskActionHandler,
    opts.callerToken,
  );
  setChatAwaitingNotifier(
    task.id,
    bridges.awaitingNotifier,
    opts.callerToken,
  );
  return bridges;
};

const submitMrArgs = () =>
  ({
    kind: "submit_mr" as const,
    actionId: "act_ship",
    repoPath: SUBMIT_REPO,
    projectPath: PROJECT_PATH,
    sourceBranch: "feature/me/123-x",
    targetBranch: "test",
    title: "R29 MR",
    description: "",
    lastCommitHash: "hash_r29",
  });

const makeSessionAgent = (agentId: string) => {
  const close = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const wait = vi.fn().mockResolvedValue({ status: "finished" as const });
  const send = vi.fn().mockResolvedValue({
    stream: async function* () {
      /* 空 */
    },
    wait,
    cancel,
  });
  return { agentId, close, send, wait, cancel };
};

describe("ownership R29 task-side", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r29t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    mockCreateMR.mockReset();
    mockGetMRMergeStatus.mockReset();
    mockCloseOpenMR.mockReset();
    mockRunActionCheck.mockReset();
    mockCreateMR.mockResolvedValue({
      ok: true,
      url: "https://git.corp.com/group/proj/-/merge_requests/42",
      iid: 42,
    });
    mockGetMRMergeStatus.mockResolvedValue({
      ok: true,
      hasConflicts: false,
      detailedStatus: "mergeable",
      undetermined: false,
    });
    mockCloseOpenMR.mockResolvedValue({ ok: true, closed: false });
    mockRunActionCheck.mockResolvedValue({ passed: true, details: "ok" });
    clearFailpoints();
  });

  afterEach(async () => {
    clearFailpoints();
    for (const id of ids.splice(0)) {
      clearActionSideEffects(id);
      runningChecks.delete(id);
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
  // ① 失主补偿 × 后继活跃 → 不删
  // ─────────────────────────────────────────────────────────────
  it(
    "R29-A①：失主补偿 × 后继 claim/活跃 → 不删 worktree（留孤儿）",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r29-comp-"));
      initGitRepo(repo);
      const meta = makeMeta(id, repo);
      meta.gitBranches = [
        { repoPath: repo, name: "feat/r29-comp", baseBranch: "main" },
      ];
      await writeMeta(meta);
      await fs.mkdir(taskDir(id), { recursive: true });
      const task = (await getTask(id))!;

      let leaseOk = true;
      const hang = installHangingFailpoint("worktree.afterAdd");
      const p = ensureTaskWorktrees(task, () => leaseOk).catch(
        (err: unknown) => err,
      );
      await hang.waitHit();

      // 后继 B claim + 活跃 runningTasks——补偿必须跳过
      claimTaskOp(id, getTaskOpGeneration(id));
      runningTasks.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agentId: "agent_B",
        startedAt: Date.now(),
        startSnapshot: { title: `r29 ${id}` },
        cancel: vi.fn(),
      });

      leaseOk = false;
      hang.release();
      const settled = await raceExpectSettled(p, 30_000);
      expect(settled).toBeInstanceOf(WorktreeLeaseLostError);

      // worktree 仍在（孤儿留给 B / finalize）
      const list = execFileSync("git", ["-C", repo, "worktree", "list"], {
        encoding: "utf-8",
      });
      expect(list.includes(id)).toBe(true);
      const workDir = getTaskWorkRepoPaths(task)[0];
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
  // ② stop join resourceJobs（R30-2：归零才放行；超时则 quarantine 而非开闸继续）
  // ─────────────────────────────────────────────────────────────
  it(
    "R29-A②：stop join resourceJobs——在飞 job 结束才收尾（无 quarantine 误伤）",
    async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "idle";
      await writeMeta(meta);
      const task = (await getTask(id))!;

      beginResourceJob(id);
      expect(hasResourceJobs(id)).toBe(true);

      let stopDone = false;
      const pStop = stopTaskAgent(task).then((r) => {
        stopDone = true;
        return r;
      });

      // join 窗口内 stop 不得立刻结束（R30-2 加强：未归零不开闸）
      await sleep(120);
      expect(stopDone).toBe(false);
      expect(hasResourceJobs(id)).toBe(true);
      expect(isWorkspaceQuarantined(id)).toBe(false);

      endResourceJob(id);
      await raceExpectSettled(pStop, 10_000);
      expect(stopDone).toBe(true);
      expect(hasResourceJobs(id)).toBe(false);
      // R30-2：超时前归零 → 不得残留 quarantine（加强，非弱化）
      expect(isWorkspaceQuarantined(id)).toBe(false);
    },
    20_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ③ cancel done × B takeover
  // ─────────────────────────────────────────────────────────────
  it(
    "R29-B③：cancel/自然收尾 done × B claim → 无 done envelope",
    async () => {
      // 复用 consume.beforeDone 窗口：A 自然 finished 前 B claim → publishIfCurrent 拒
      // （cancel 路径同形走 publishIfCurrent、失主不发）
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
      meta.currentActionId = "act_shared";
      meta.actions = [
        {
          id: "act_shared",
          n: 1,
          type: "plan",
          status: "awaiting_ack",
          userInstruction: "",
          artifactPath: "actions/1-plan.md",
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);

      const agent = makeSessionAgent("agent_r29_b");
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: agent as never,
        agentId: agent.agentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: `r29 ${id}` },
      });

      const dones: unknown[] = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "done") dones.push(ev);
      });

      const hang = installHangingFailpoint("consume.beforeDone");
      const pReply = deliverAskReply(
        (await getTask(id))!,
        "R29-B cancel/done 窗口",
        undefined,
        "act_shared",
        {
          apiKey: CREDS.apiKey,
          model: CREDS.model,
        },
      );
      await hang.waitHit();
      claimTaskOp(id, getTaskOpGeneration(id));
      hang.release();
      await raceExpectSettled(pReply, 8000);
      await sleep(80);
      unsub();

      expect(dones).toHaveLength(0);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ④ 屏障超时 fail-closed
  // ─────────────────────────────────────────────────────────────
  it(
    "R29-C④：屏障超时 × createMR 仍 pending → check 不启动、notifier 返 busy",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      const { awaitingNotifier } = registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r29-4",
      });

      // 模拟 createMR 仍 pending：占 mr claim + 压短全局 wait deadline
      const mrHandle = tryClaimSideEffect(id, "act_ship", "mr");
      expect(mrHandle).not.toBeNull();
      expect(hasActionSideEffect(id, "act_ship")).toBe(true);
      const g = globalThis as unknown as {
        __feAiFlowActionSideEffectWaitMs?: number;
      };
      g.__feAiFlowActionSideEffectWaitMs = 80;

      try {
        const outcome = await awaitingNotifier(
          {
            kind: "awaiting_start",
            actionId: "act_ship",
            artifactPath: "actions/1-ship.md",
          },
          { callerStillValid: () => true },
        );
        // R29-5：timeout → busy（不再 throw）
        expect(outcome).toBe("busy");
        expect(runningChecks.get(id)).toBeUndefined();
        expect(mockRunActionCheck).not.toHaveBeenCalled();
      } finally {
        delete g.__feAiFlowActionSideEffectWaitMs;
        releaseSideEffect(mrHandle!);
      }
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // ⑤ claim 互斥（R29-1 tryClaimSideEffect）
  // ─────────────────────────────────────────────────────────────
  it(
    "R29-P2c⑤：双 submit_mr 第二路拒（同 action claim 互斥）",
    async () => {
      const id = alloc();
      await seedShipRunning(id);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat-r29-5",
      });

      const hang = installHangingFailpoint("mcp.submitMr.beforeCreateMR");
      const p1 = runTaskAction(id, submitMrArgs(), token);
      await hang.waitHit();
      expect(hasActionSideEffect(id, "act_ship")).toBe(true);

      const r2 = await runTaskAction(id, submitMrArgs(), token);
      expect(r2).toMatchObject({ ok: false });
      expect(String((r2 as { error?: string }).error ?? "")).toMatch(
        /正有其它副作用进行|稍后重试/,
      );
      expect(mockCreateMR).not.toHaveBeenCalled();

      hang.release();
      await raceExpectSettled(p1, 12_000);
      expect(hasActionSideEffect(id, "act_ship")).toBe(false);
    },
    20_000,
  );
});
