/**
 * R26 接线波定向测试（第二十六轮·业务路径接线）
 *
 * 八组：resume 终态拒 / prewarm × finalize / reconnect 失主关闭 /
 * submit_work 不杀 B check / set_plan_batches null 返失败 /
 * stop 后 MCP 立即拒 / createMR 后失主跳过 closeOpenMR / 普通 done 失主不发。
 *
 * 不动 ownership-r26-matrix（另一代理维护）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r26-wiring-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

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

const mockEnsureTaskWorktrees = vi.fn();
vi.mock("@/lib/server/task-worktrees", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/task-worktrees")>();
  return {
    ...actual,
    ensureTaskWorktrees: (...args: unknown[]) =>
      mockEnsureTaskWorktrees(...args),
  };
});

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  claimTaskOp,
  clearTaskStarting,
  getTaskOpGeneration,
  isTaskOpCurrent,
  pendingStopRequests,
  releaseTaskOpIf,
  runningChecks,
  runningTasks,
  snapshotTaskOp,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  CALLER_MISMATCH_ERROR,
  cleanupChatTaskState,
  getExpectedCallerToken,
  matchExpectedCallerToken,
  runTaskAction,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { clearChatGate, getChatLifecycle } = await import("@/lib/server/chat-gate");
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const {
  buildSessionBridges,
  deliverAskReply,
  finalizeTask,
  prewarmTaskWorkspace,
  resumeTaskSession,
} = await import("@/lib/server/task-runner");
const { getTask, listTasks } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r26-wiring DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

await listTasks();

const CREDS = {
  apiKey: "k",
  model: { id: "m", params: [] as never[] },
  fallbackModel: { id: "m", params: [] as never[] },
};

const REMOTE_URL = "git@git.corp.com:group/proj.git";
const PROJECT_PATH = "group/proj";
let SUBMIT_REPO = "";

beforeAll(() => {
  SUBMIT_REPO = mkdtempSync(path.join(os.tmpdir(), "ownership-r26w-submit-"));
  execFileSync("git", ["init"], { cwd: SUBMIT_REPO });
  execFileSync("git", ["remote", "add", "origin", REMOTE_URL], {
    cwd: SUBMIT_REPO,
  });
});

afterAll(() => {
  if (SUBMIT_REPO) {
    rmSync(SUBMIT_REPO, { recursive: true, force: true });
  }
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r26-wiring ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: "act_a",
    actions: [
      {
        id: "act_a",
        n: 1,
        type: "plan",
        status: "running",
        userInstruction: "",
        artifactPath: "actions/1-plan.md",
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const waitUntil = async (
  pred: () => boolean | Promise<boolean>,
  ms = 5000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`waitUntil 超时 ${ms}ms`);
};

const raceExpectSettled = async <T>(
  p: Promise<T>,
  ms: number,
): Promise<T> => {
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

/** R26-2：只装 bridge（不装 session） */
const registerBridgesForTest = (
  task: Task,
  opts: { callerToken: string; gitToken?: string },
) => {
  const bridges = buildSessionBridges(task, opts);
  setChatTaskActionHandler(task.id, bridges.taskActionHandler, opts.callerToken);
  setChatAwaitingNotifier(task.id, bridges.awaitingNotifier, opts.callerToken);
  return bridges;
};

const makeCloseAgent = (agentId: string) => {
  const close = vi.fn();
  return {
    agentId,
    close,
    send: vi.fn(),
  };
};

describe("ownership R26 wiring", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r26w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    mockCreateMR.mockReset();
    mockGetMRMergeStatus.mockReset();
    mockCloseOpenMR.mockReset();
    mockEnsureTaskWorktrees.mockReset();
    mockCreateMR.mockResolvedValue({
      ok: true,
      url: "https://git.corp.com/group/proj/-/merge_requests/1",
      iid: 1,
    });
    mockGetMRMergeStatus.mockResolvedValue({
      ok: true,
      hasConflicts: false,
      detailedStatus: "mergeable",
      undetermined: false,
    });
    mockCloseOpenMR.mockResolvedValue({ ok: true, closed: true });
    mockEnsureTaskWorktrees.mockResolvedValue({
      infos: [],
      createdRepos: [],
      clonedDeps: [],
    });
    clearFailpoints();
  });

  afterEach(async () => {
    clearFailpoints();
    for (const id of ids) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      pendingStopRequests.delete(id);
      runningChecks.delete(id);
      clearTaskStarting(id);
      clearChatGate(id);
      cleanupChatTaskState(id);
      try {
        rmSync(taskDir(id), { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
    ids.length = 0;
  });

  // 1) resume 终态拒
  it(
    "R26-1 resume：盘上终态 → 不调 Agent.resume / 不装 session（R26-1）",
    async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.repoStatus = "merged";
      meta.sessionAgentId = "agent_dead";
      meta.runStatus = "idle";
      await writeMeta(meta);
      const task = (await getTask(id))!;
      const opHandle = snapshotTaskOp(id);

      const record = await resumeTaskSession(task, CREDS, { opHandle });
      expect(record).toBeNull();
      expect(mockResume).not.toHaveBeenCalled();
      expect(agentSessions.has(id)).toBe(false);
    },
    10_000,
  );

  // 2) prewarm × finalize
  it(
    "R26-1 prewarm：beforeWorktreeAdd × finalize → ensure 不调、无预热 info（R26-1）",
    async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.isolateWorktree = true;
      meta.repoPaths = [SUBMIT_REPO];
      await writeMeta(meta);

      const hang = installHangingFailpoint("prewarm.beforeWorktreeAdd");
      prewarmTaskWorkspace(id);
      await hang.waitHit();
      expect(mockEnsureTaskWorktrees).not.toHaveBeenCalled();

      // R28-1：等 finalizing 再 release——stillPrewarm 必假；starting 随后归零、join 不空等
      const pFin = finalizeTask(id, "abandoned", "r26w prewarm");
      await waitUntil(() => getChatLifecycle(id) === "finalizing", 5000);
      hang.release();
      await pFin;
      await sleep(200);
      expect(mockEnsureTaskWorktrees).not.toHaveBeenCalled();
      const events = await readEvents(id);
      expect(
        events.filter(
          (e) =>
            e.kind === "info" &&
            typeof e.text === "string" &&
            e.text.includes("后台预热"),
        ),
      ).toHaveLength(0);
    },
    15_000,
  );

  // 3) reconnect 失主关闭（直测 resume 返回后失主关 agent）
  it(
    "R26-2 resume 失主：resume.beforeInstall × claim → 关 A agent、不装 session（R26-2）",
    async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.sessionAgentId = "agent_persisted";
      await writeMeta(meta);
      const task = (await getTask(id))!;
      const opA = claimTaskOp(id, getTaskOpGeneration(id));
      expect(opA).not.toBeNull();

      const closeA = vi.fn();
      mockResume.mockImplementation(async () => ({
        agentId: "agent_persisted",
        close: closeA,
        send: vi.fn(),
      }));

      const hang = installHangingFailpoint("resume.beforeInstall");
      const pResume = resumeTaskSession(task, CREDS, { opHandle: opA! });
      await hang.waitHit();

      // B claim → A op 失效
      const opB = claimTaskOp(id, getTaskOpGeneration(id));
      expect(opB).not.toBeNull();
      expect(isTaskOpCurrent(opA!)).toBe(false);

      hang.release();
      const record = await raceExpectSettled(pResume, 8000);
      expect(record).toBeNull();
      expect(closeA).toHaveBeenCalled();
      expect(agentSessions.has(id)).toBe(false);

      releaseTaskOpIf(opB!);
    },
    15_000,
  );

  // 4) submit_work 不杀 B check
  it(
    "R26-4 submit_work：旧 action 交卷 × B check 在飞 → 不 abort B（R26-4）",
    async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.currentActionId = "act_b";
      meta.actions = [
        {
          id: "act_a",
          n: 1,
          type: "plan",
          status: "completed",
          userInstruction: "",
          artifactPath: "actions/1-plan.md",
          startedAt: Date.now() - 1000,
          endedAt: Date.now() - 500,
        },
        {
          id: "act_b",
          n: 2,
          type: "build",
          status: "running",
          userInstruction: "",
          artifactPath: "actions/2-build.md",
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      const { awaitingNotifier } = registerBridgesForTest(task, {
        callerToken: token,
      });

      const abortSpy = vi.fn();
      const checkB = {
        actionId: "act_b",
        controller: {
          abort: abortSpy,
          signal: { aborted: false },
        } as unknown as AbortController,
      };
      runningChecks.set(id, checkB);

      // R29-1：旧 action 在 waitAndClaimPostCheck 的 lease 检查处即 stale，不启 check、不 abort B
      const outcome = await awaitingNotifier(
        {
          kind: "awaiting_start",
          actionId: "act_a",
          artifactPath: "actions/1-plan.md",
        },
        { callerStillValid: () => true },
      );
      expect(outcome).toBe("stale");
      expect(abortSpy).not.toHaveBeenCalled();
      expect(runningChecks.get(id)?.actionId).toBe("act_b");
    },
    15_000,
  );

  // 5) set_plan_batches null 返失败
  it(
    "R26-4 set_plan_batches：非 current/running/plan → ok:false、无成功事件（R26-4）",
    async () => {
      const id = alloc();
      const meta = makeMeta(id);
      // current 是 build running——plan batches 应拒
      meta.currentActionId = "act_b";
      meta.actions = [
        {
          id: "act_a",
          n: 1,
          type: "plan",
          status: "completed",
          userInstruction: "",
          artifactPath: "actions/1-plan.md",
          startedAt: Date.now() - 1000,
          endedAt: Date.now() - 500,
        },
        {
          id: "act_b",
          n: 2,
          type: "build",
          status: "running",
          userInstruction: "",
          artifactPath: "actions/2-build.md",
          startedAt: Date.now(),
          endedAt: null,
        },
      ] as TaskMetaV06["actions"];
      await writeMeta(meta);
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, { callerToken: token });

      const result = await runTaskAction(
        id,
        {
          kind: "set_plan_batches",
          actionId: "act_a",
          batches: [
            { id: "b1", title: "批1", testStrategy: "none", taskRefs: [] },
          ],
        },
        token,
      );
      expect(result).toMatchObject({ ok: false });
      const events = await readEvents(id);
      expect(
        events.filter(
          (e) =>
            e.kind === "info" &&
            typeof e.text === "string" &&
            e.text.includes("批次"),
        ),
      ).toHaveLength(0);
    },
    10_000,
  );

  // 6) stop 后 MCP 立即拒
  it(
    "R26-4 stop：begin stopping 后首个 await 前 invalidateCallerToken → MCP 立即拒（R26-4）",
    async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      const task = (await getTask(id))!;
      const token = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, {
        callerToken: token,
        gitToken: "pat",
      });
      expect(getExpectedCallerToken(id)).toBe(token);
      expect(matchExpectedCallerToken(id, token)).toBe(true);

      const hang = installHangingFailpoint("stop.afterGate");
      const pStop = stopTaskAgent(task);
      await hang.waitHit();
      // 首个 await（stop.afterGate）时 token 已失效
      expect(matchExpectedCallerToken(id, token)).toBe(false);
      expect(getExpectedCallerToken(id)).toBeNull();

      const mr = await runTaskAction(
        id,
        {
          kind: "set_plan_batches",
          actionId: "act_a",
          batches: [
            { id: "b1", title: "x", testStrategy: "none", taskRefs: [] },
          ],
        },
        token,
      );
      expect(mr).toMatchObject({ ok: false });
      expect((mr as { error: string }).error).toContain("接管");
      expect(CALLER_MISMATCH_ERROR).toContain("接管");

      hang.release();
      await raceExpectSettled(pStop, 8000);
    },
    15_000,
  );

  // 7) createMR 后失主跳过 closeOpenMR
  it(
    "R26-4 createMR 后：beforeCloseOpenMR × 换主 → 不调 closeOpenMR（R26-4）",
    async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.currentActionId = "act_ship";
      meta.repoPaths = [SUBMIT_REPO];
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
      meta.mrs = [
        {
          repoPath: SUBMIT_REPO,
          targetBranch: "test",
          url: "https://git.corp.com/group/proj/-/merge_requests/9",
          title: "旧 MR",
          branch: "feature/me/123-x",
          status: "open",
          version: 1,
          createdAt: Date.now(),
          lastCommitHash: "oldhash1",
        },
      ];
      meta.gitBranches = [
        {
          repoPath: SUBMIT_REPO,
          name: "feature/me/123-x",
          baseBranch: "master",
        },
      ];
      meta.repoTestBranches = { [SUBMIT_REPO]: "test" };
      await writeMeta(meta);
      const task = (await getTask(id))!;
      const tokenA = String(allocTaskRunInstanceId());
      const tokenB = String(allocTaskRunInstanceId());
      registerBridgesForTest(task, {
        callerToken: tokenA,
        gitToken: "pat-a",
      });

      const hang = installHangingFailpoint("mcp.submitMr.beforeCloseOpenMR");
      const pMr = runTaskAction(
        id,
        {
          kind: "submit_mr",
          actionId: "act_ship",
          repoPath: SUBMIT_REPO,
          projectPath: PROJECT_PATH,
          sourceBranch: "feature/me/123-x__conflict",
          targetBranch: "test",
          title: "R26w MR",
          description: "",
          lastCommitHash: "abc",
        },
        tokenA,
      );
      await hang.waitHit();
      expect(mockCreateMR).toHaveBeenCalled();
      registerBridgesForTest(task, {
        callerToken: tokenB,
        gitToken: "pat-b",
      });
      hang.release();
      const result = await raceExpectSettled(pMr, 8000);
      expect(result).toMatchObject({
        ok: true,
        data: { skipped_local: true },
      });
      expect(mockCloseOpenMR).not.toHaveBeenCalled();
    },
    15_000,
  );

  // 8) 普通 done 失主不发
  it(
    "R26-5 普通 done：consume.beforeDone × claim → 无 done envelope（R26-5）",
    async () => {
      const id = alloc();
      const meta = makeMeta(id);
      meta.sessionAgentId = "agent_done";
      meta.currentActionId = "act_a";
      meta.actions = [
        {
          id: "act_a",
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

      const agent = makeCloseAgent("agent_done");
      const wait = vi.fn().mockResolvedValue({ status: "finished" as const });
      const cancel = vi.fn().mockResolvedValue(undefined);
      agent.send = vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空 */
        },
        wait,
        cancel,
      });
      mockResume.mockResolvedValue(agent);

      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: agent as never,
        agentId: agent.agentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: `r26w ${id}` },
      });

      const dones: unknown[] = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "done") dones.push(ev);
      });

      const hang = installHangingFailpoint("consume.beforeDone");
      // ask-reply 走普通 consume（非 questionRun）——命中 consume.beforeDone
      const p = deliverAskReply(
        (await getTask(id))!,
        "R26w 普通 done 窗口",
        undefined,
        "act_a",
        CREDS,
      );
      await hang.waitHit();
      claimTaskOp(id, getTaskOpGeneration(id));
      hang.release();
      await raceExpectSettled(p, 8000);
      await sleep(80);
      unsub();
      expect(dones).toHaveLength(0);
    },
    20_000,
  );
});
