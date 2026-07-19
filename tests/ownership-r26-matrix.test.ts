/**
 * Ownership R26 真实 sink 窗口矩阵（fable5-chat-polish 第二十六轮验收 R26-7 点名）
 *
 * 面向修复后的目标行为：9 条缺失矩阵——终态 resume/prewarm、session 半状态、
 * ask 身份、event 队内 lease、meta caller takeover、createMR→closeOpenMR、
 * submit_work action scope、普通 consume done。
 *
 * setup 对齐 ownership-r25-matrix / ownership-r24-wave1：
 * raceExpectSettled 判赢家、断言不进条件分支、waitUntil 超时必抛、轮询 deadline 不裸 sleep。
 *
 * 接线波并行插桩落地前，依赖未接线 failpoint 的用例预期暂红——文末「行为假设」逐条对照。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r26-"));
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
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));
/** advance / postcheck 秒过；本文件不验 check 本体 */
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));

/** prewarm × finalize：spy ensure；其余 worktree helper 走真实现 */
const mockEnsureTaskWorktrees = vi.fn();
vi.mock("@/lib/server/task-worktrees", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-worktrees")>();
  return {
    ...actual,
    ensureTaskWorktrees: (...args: unknown[]) =>
      mockEnsureTaskWorktrees(...args),
  };
});

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  claimTaskOp,
  clearTaskStarting,
  getTaskOpGeneration,
  isTaskOpCurrent,
  pendingStopRequests,
  releaseTaskOpIf,
  revokeTaskOps,
  runningChecks,
  runningTasks,
  subscribeTaskStream,
  writeEventAndPublish,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  cleanupChatTaskState,
  getExpectedCallerToken,
  getPendingAsk,
  registerPendingAsk,
  runTaskAction,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { dispatchAskUserForTest } = await import("@/lib/server/chat-mcp");
const {
  clearChatGate,
  endChatLifecycle,
  getChatLifecycle,
} = await import("@/lib/server/chat-gate");
const {
  buildSessionBridges,
  deliverAskReply,
  deliverTaskQuestion,
  finalizeTask,
  installSessionIfCurrent,
  prewarmTaskWorkspace,
} = await import("@/lib/server/task-runner");
const { getTask, listTasks } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r26-matrix DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

// 先跑空目录 boot recovery——否则首条 seed 的 running 会被 recovery 标成 error
await listTasks();

const CREDS = {
  apiKey: "k",
  model: { id: "m", params: [] as never[] },
  fallbackModel: { id: "m", params: [] as never[] },
};

/** submit_mr 真实校验用临时仓（origin → project_path 对账） */
const REMOTE_URL = "git@git.corp.com:group/proj.git";
const PROJECT_PATH = "group/proj";
let SUBMIT_REPO = "";

beforeAll(() => {
  SUBMIT_REPO = mkdtempSync(path.join(os.tmpdir(), "ownership-r26-submit-"));
  execFileSync("git", ["init"], { cwd: SUBMIT_REPO });
  execFileSync("git", ["remote", "add", "origin", REMOTE_URL], {
    cwd: SUBMIT_REPO,
  });
});

afterAll(() => {
  if (SUBMIT_REPO) {
    rmSync(SUBMIT_REPO, { recursive: true, force: true });
  }
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r26 ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const seedRunningAction = async (
  id: string,
  extras?: Partial<TaskMetaV06>,
): Promise<void> => {
  const meta = makeMeta(id);
  meta.runStatus = "running";
  meta.currentActionId = "act_shared";
  meta.sessionAgentId = "agent_persisted";
  meta.actions = [
    {
      id: "act_shared",
      n: 1,
      type: "plan",
      status: "running",
      userInstruction: "",
      artifactPath: "actions/1-plan.md",
      startedAt: Date.now(),
      endedAt: null,
    },
  ] as TaskMetaV06["actions"];
  Object.assign(meta, extras);
  await writeMeta(meta);
};

/** ship + 旧 MR（不同 source）——submit_mr 走 createMR 后 closeOpenMR 分支 */
const seedShipWithPrevMr = async (id: string): Promise<void> => {
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
  meta.mrs = [
    {
      repoPath: SUBMIT_REPO,
      targetBranch: "test",
      version: 1,
      url: "https://git.corp.com/group/proj/-/merge_requests/9",
      title: "旧 MR",
      branch: "feature/me/123-x",
      status: "open",
      createdAt: Date.now(),
      lastCommitHash: "oldhash1",
    },
  ] as TaskMetaV06["mrs"];
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * R24-8：旧 Promise.race([op, sleep]) 不判断赢家——op 永久挂起时 sleep 胜出仍继续假绿。
 * settle（resolve/reject）算 op 赢；timeout 胜出必须 fail。
 */
const raceExpectSettled = async (
  operation: Promise<unknown>,
  ms: number,
): Promise<void> => {
  const winner = await Promise.race([
    operation.then(
      () => "op" as const,
      () => "op" as const,
    ),
    sleep(ms).then(() => "timeout" as const),
  ]);
  expect(winner).toBe("op");
};

/** 挂起式 failpoint：命中后等 release */
const installHangingFailpoint = (name: string) => {
  let hit = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setFailpoint(name, async () => {
    hit = true;
    await gate;
  });
  return {
    wasHit: () => hit,
    release: () => release(),
    waitHit: () => waitUntil(() => hit),
  };
};

/**
 * 仅首次命中挂起——route getTask 卡住时，finalize 内部后续 getTask 必须放行。
 */
const installOnceHangingFailpoint = (name: string) => {
  let hit = false;
  let used = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setFailpoint(name, async () => {
    if (used) return;
    used = true;
    hit = true;
    await gate;
  });
  return {
    wasHit: () => hit,
    release: () => release(),
    waitHit: () => waitUntil(() => hit),
  };
};

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

/**
 * R26-2 后 registerSessionBridges 已退役——测试用「只装 bridge、不装 session」等价物
 *（MCP handler / ask notifier 路径需要 expectedCallerToken + notifier）。
 */
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

describe("ownership R26 真实 sink 窗口矩阵", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_r26_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      runningChecks.delete(id);
      agentSessions.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
      revokeTaskOps(id);
      cleanupChatTaskState(id);
    }
    // fire-and-forget 落盘避 ENOENT
    await sleep(30);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ─────────────────────────────────────────────────────────────
  // 1) R26-1：陈旧 task → deliver/resume × finalize
  // ─────────────────────────────────────────────────────────────
  it(
    "R26-1 route 陈旧 task：hydrate 持旧 developing × finalize → deliver/resume 不起活会话（R26-1）",
    async () => {
      // 旧实现：getTask 读完 developing+sessionAgentId 后 await hydrate；finalize 写终态 /
      // 关会话 / revoke；route 拿陈旧快照走 deliver→send→resumeTaskSession——不验终态、
      // 用旧 sessionAgentId Agent.resume + 注册 session + 可能重建 worktree。
      // R26-1：终态准入下沉到 resume sink——resume 不调 / 调了也不安装、盘上保持终态。
      // 依赖插桩：taskread.beforeHydrate（仅首次）
      const id = alloc();
      await seedRunningAction(id, {
        runStatus: "idle",
        currentActionId: null,
        actions: [
          {
            id: "act_done",
            n: 1,
            type: "plan",
            status: "completed",
            userInstruction: "",
            artifactPath: "actions/1-plan.md",
            startedAt: Date.now(),
            endedAt: Date.now(),
          },
        ] as TaskMetaV06["actions"],
      });

      const resumeClose = vi.fn();
      mockResume.mockResolvedValue({
        agentId: "agent_r26_1_resume",
        close: resumeClose,
        send: vi.fn().mockResolvedValue({
          stream: async function* () {
            /* 空 */
          },
          wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const hang = installOnceHangingFailpoint("taskread.beforeHydrate");
      const pGet = getTask(id);
      await hang.waitHit();

      await finalizeTask(id, "merged");
      expect(getChatLifecycle(id)).toBeNull();
      expect((await readMetaV06(id))?.repoStatus).toBe("merged");
      expect(agentSessions.has(id)).toBe(false);

      hang.release();
      await raceExpectSettled(pGet, 5000);
      const staleTask = await pGet;
      expect(staleTask).not.toBeNull();
      // 返回值仍是 hydrate 前拍下的旧 developing 快照（含 sessionAgentId）
      expect(staleTask!.repoStatus).toBe("developing");
      expect(staleTask!.sessionAgentId).toBe("agent_persisted");

      // 等价 /question 陈旧路径：无内存会话 → resume（终态准入应拒、不调 Agent.resume）
      const pDeliver = deliverTaskQuestion(staleTask!, "R26-1 终态后陈旧 deliver", undefined, {
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      });
      await raceExpectSettled(pDeliver, 8000);
      const deliverResult = await pDeliver;

      // 目标：终态准入拦在 Agent.resume 之前（或 resume 后也不安装）
      if (mockResume.mock.calls.length > 0) {
        expect(agentSessions.has(id)).toBe(false);
        expect(resumeClose).toHaveBeenCalled();
      } else {
        expect(mockResume).not.toHaveBeenCalled();
      }
      expect(agentSessions.has(id)).toBe(false);
      expect(deliverResult === "no_session" || deliverResult === "stale").toBe(
        true,
      );
      const disk = await readMetaV06(id);
      expect(disk?.repoStatus).toBe("merged");
      expect(disk?.runStatus).not.toBe("running");
      // 无 worktree 重建副作用（本用例未开 isolate；ensure spy 也不应被 resume 拉起）
      expect(mockEnsureTaskWorktrees).not.toHaveBeenCalled();
    },
    20_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 2) R26-1：prewarm × finalize remove
  // ─────────────────────────────────────────────────────────────
  it(
    "R26-1 prewarm：worktree add 前 × finalize → 不执行 ensure / upsert / info（R26-1）",
    async () => {
      // 旧实现：prewarm 只与 advance 共 runAdvanceExclusive、不参与 lifecycle/finalize；
      // ensureTaskWorktrees 挂起期间 finalize 删完 worktree，prewarm 恢复后重新 add +
      // upsertGitBranch + info event 写回终态任务。
      // R26-1：prewarm.beforeWorktreeAdd 后验终态——失主不调 ensure。
      // 依赖插桩：prewarm.beforeWorktreeAdd
      const id = alloc();
      const meta = makeMeta(id);
      meta.isolateWorktree = true;
      meta.repoPaths = [SUBMIT_REPO];
      await writeMeta(meta);

      const hang = installHangingFailpoint("prewarm.beforeWorktreeAdd");
      prewarmTaskWorkspace(id);
      await hang.waitHit();
      // 挂起点在 worktree add 前 → ensure 尚未被调
      expect(mockEnsureTaskWorktrees).not.toHaveBeenCalled();

      // R28-1：finalize 先占 finalizing + revoke，再 join starting。
      // 等 lifecycle 已 finalizing 再 release——prewarm 的 stillPrewarm 必假、不调 ensure；
      // 同时 starting 随后归零，join 不会空等到 30s。
      const pFin = finalizeTask(id, "abandoned");
      await waitUntil(() => getChatLifecycle(id) === "finalizing", 5000);
      hang.release();
      await pFin;
      expect((await readMetaV06(id))?.repoStatus).toBe("abandoned");

      // prewarm 是 fire-and-forget：deadline 内轮询确认 ensure 始终不被调（不裸 sleep 当收敛）
      await waitUntil(async () => {
        const m = await readMetaV06(id);
        return (
          m?.repoStatus === "abandoned" &&
          mockEnsureTaskWorktrees.mock.calls.length === 0
        );
      }, 3000);
      // 再给串行回调一个结算窗口，确认 ensure 仍为 0
      await sleep(80);
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
    20_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 3) R26-2：resume 半状态（resume 已返回、未安装）× B install
  // ─────────────────────────────────────────────────────────────
  it(
    "R26-2 resume 半状态：Agent.resume 返回未安装 × B install → A 不覆盖、关 A agent（R26-2）",
    async () => {
      // 旧实现：resume 分步 register bridge + set session；A 在 Agent.resume await 后、
      // 安装前 B 可先装 bridge/session；A 恢复后覆盖或留下 bridge=A/session=B 错配 + A 泄漏。
      // R26-2：resume.beforeInstall 后走 installSessionIfCurrent——失主关精确 agent、不覆盖。
      // 依赖插桩：resume.beforeInstall
      const id = alloc();
      await seedRunningAction(id, {
        runStatus: "idle",
        currentActionId: null,
        actions: [
          {
            id: "act_done",
            n: 1,
            type: "plan",
            status: "completed",
            userInstruction: "",
            artifactPath: null,
            startedAt: Date.now(),
            endedAt: Date.now(),
          },
        ] as TaskMetaV06["actions"],
      });

      const closeA = vi.fn();
      mockResume.mockResolvedValue({
        agentId: "agent_r26_2_a",
        close: closeA,
        send: vi.fn().mockResolvedValue({
          stream: async function* () {
            /* 空 */
          },
          wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const hang = installHangingFailpoint("resume.beforeInstall");
      const task = (await getTask(id))!;
      const pDeliver = deliverTaskQuestion(task, "R26-2 resume 半状态", undefined, {
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      });
      await hang.waitHit();
      // 此时 Agent.resume 已返回、尚未 install
      expect(mockResume).toHaveBeenCalled();
      expect(agentSessions.has(id)).toBe(false);

      // B claim 并完成自己的 install（新 callerToken + session）
      claimTaskOp(id, getTaskOpGeneration(id));
      const tokenB = String(allocTaskRunInstanceId());
      const agentB = makeSessionAgent("agent_r26_2_b");
      const bridgesB = buildSessionBridges(task, {
        callerToken: tokenB,
        gitToken: "pat-b",
      });
      const installed = installSessionIfCurrent(
        () => true,
        id,
        {
          instanceId: allocTaskRunInstanceId(),
          agent: agentB as never,
          agentId: agentB.agentId,
          callerToken: tokenB,
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          startSnapshot: { title: `r26 ${id}` },
        },
        bridgesB,
        tokenB,
      );
      expect(installed).toBe(true);
      expect(getExpectedCallerToken(id)).toBe(tokenB);

      hang.release();
      await raceExpectSettled(pDeliver, 8000);

      // A 不覆盖 session；A 的 agent 被 close；bridge/token 仍是 B 的
      expect(agentSessions.get(id)?.agentId).toBe("agent_r26_2_b");
      expect(getExpectedCallerToken(id)).toBe(tokenB);
      expect(closeA).toHaveBeenCalled();
    },
    20_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 4) R26-3：ask 身份——B 真登记 ask B × A cancelPendingIf
  // ─────────────────────────────────────────────────────────────
  it(
    "R26-3 ask 身份：A supersede 挂起 × B 真登记 ask B → A 反登记不误删 B（R26-3）",
    async () => {
      // 旧实现：A 失主后裸 cancelPending(taskId) 删掉 B 刚 registerPendingAsk 的条目；
      // R25 测试只换 token、把 getPendingAsk===null 当正确——固定了错误语义。
      // R26-3：cancelPendingIf(askId)——旧 A 不误删 B。
      // 依赖插桩：mcp.askUser.afterSupersede
      const id = alloc();
      await seedRunningAction(id);
      const task = (await getTask(id))!;
      const tokenA = String(allocTaskRunInstanceId());
      const tokenB = String(allocTaskRunInstanceId());

      registerBridgesForTest(task, { callerToken: tokenA });

      const hang = installHangingFailpoint("mcp.askUser.afterSupersede");
      const pAsk = dispatchAskUserForTest({
        taskId: id,
        callerToken: tokenA,
        actionId: "act_shared",
        questions: [
          { id: "q1", question: "R26-3 A 的提问？", allowText: true },
        ],
      });
      await hang.waitHit();

      const askA = getPendingAsk(id);
      expect(askA).not.toBeNull();
      const askIdA = askA!.askId;

      // B 接管：重注册 token + 真登记 ask B（不是只换 token）
      registerBridgesForTest(task, { callerToken: tokenB });
      const askB = registerPendingAsk(id, {
        askId: "ask_r26_3_b",
        questions: [
          { id: "q1", question: "R26-3 B 的提问？", allowText: true },
        ],
        actionId: "act_shared",
      });
      expect(getPendingAsk(id)?.askId).toBe(askB.askId);
      expect(askB.askId).not.toBe(askIdA);

      hang.release();
      await raceExpectSettled(pAsk, 8000);
      await sleep(40);

      // 旧 A 的 cancelPendingIf 不误删 B
      expect(getPendingAsk(id)?.askId).toBe("ask_r26_3_b");
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 5) R26-5：event 已入队未 appendFile × claim
  // ─────────────────────────────────────────────────────────────
  it(
    "R26-5 event 队内：writeEventAndPublish 入队 × claim → 不落盘、不 publish（R26-5）",
    async () => {
      // 旧实现：stillCurrent 在入队前检查；A 入队后 B claim，队列才执行 A 的 appendFile。
      // R26-5：event.inQueue 后队内验 lease——失主拒写、不 publish。
      // 依赖插桩：event.inQueue
      const id = alloc();
      await seedRunningAction(id);
      const handleA = claimTaskOp(id, getTaskOpGeneration(id));
      expect(handleA).not.toBeNull();

      const published: string[] = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "event" && typeof ev.event.text === "string") {
          published.push(ev.event.text);
        }
      });

      // 占住链：blocker 命中 event.inQueue 后挂起
      const hang = installHangingFailpoint("event.inQueue");
      const pBlocker = writeEventAndPublish(id, {
        kind: "info",
        text: "r26-5-blocker",
      });
      await hang.waitHit();

      // 带 lease 的目标事件已入队；放行前 claim 换主
      // sleep(30) 仅等 chain 入队（对齐 ownership-r26-sinks），收敛仍靠 raceExpectSettled
      const pTarget = writeEventAndPublish(
        id,
        { kind: "info", text: "r26-5-should-not-land" },
        () => isTaskOpCurrent(handleA!),
      );
      await sleep(30);

      const handleB = claimTaskOp(id, getTaskOpGeneration(id));
      expect(handleB).not.toBeNull();
      expect(isTaskOpCurrent(handleA!)).toBe(false);

      hang.release();
      await raceExpectSettled(pBlocker, 5000);
      await raceExpectSettled(pTarget, 5000);
      const wrote = await pTarget;
      expect(wrote).toBeNull();
      await sleep(30);
      unsub();

      const events = await readEvents(id);
      expect(events.some((e) => e.text === "r26-5-should-not-land")).toBe(
        false,
      );
      expect(published.includes("r26-5-should-not-land")).toBe(false);
      // blocker 无 lease、应落盘
      expect(events.some((e) => e.text === "r26-5-blocker")).toBe(true);

      releaseTaskOpIf(handleB!);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 6) R26-5：meta 已过 final guard 未 rename × caller takeover
  // ─────────────────────────────────────────────────────────────
  it(
    "R26-5 meta caller：setFeishuTesterUserKeys rename 前 × token 换主 → 盘上不变（R26-5）",
    async () => {
      // 旧实现：prepare 后验 owner → await commit；commit 内 metaCommit.beforeRename
      // 之后才 rename——B 在窗口重注册 token，A 仍提交旧值。现有测试只做 × stop。
      // R26-5：commit(finalGuard) 在 failpoint 后、rename 前同步验——caller 换主拒写。
      // 依赖插桩：metaCommit.beforeRename
      const id = alloc();
      await seedShipWithPrevMr(id);
      const task = (await getTask(id))!;
      const tokenA = String(allocTaskRunInstanceId());
      const tokenB = String(allocTaskRunInstanceId());

      registerBridgesForTest(task, {
        callerToken: tokenA,
        gitToken: "pat-r26-6",
      });

      const hang = installHangingFailpoint("metaCommit.beforeRename");
      const pFeishu = runTaskAction(
        id,
        {
          kind: "set_feishu_testers",
          actionId: "act_ship",
          userKeys: ["uk_r26_6_a"],
        },
        tokenA,
      );
      await hang.waitHit();

      // token/caller 换主（不是 stop）——lease 失效
      registerBridgesForTest(task, {
        callerToken: tokenB,
        gitToken: "pat-r26-6-b",
      });
      expect(getExpectedCallerToken(id)).toBe(tokenB);

      hang.release();
      const result = await Promise.race([
        pFeishu,
        sleep(8000).then(() => "timeout" as const),
      ]);
      expect(result).not.toBe("timeout");
      // helper / handler 返 null/false（接管）
      expect(result).toMatchObject({ ok: false });

      const disk = await readMetaV06(id);
      expect(disk?.feishuTesterUserKeys).toBeUndefined();
      const events = await readEvents(id);
      expect(
        events.filter(
          (e) =>
            e.kind === "info" &&
            typeof e.text === "string" &&
            e.text.includes("飞书测试人员"),
        ),
      ).toHaveLength(0);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 7) R26-4：createMR 成功、closeOpenMR 前 × takeover
  // ─────────────────────────────────────────────────────────────
  it(
    "R26-4 closeOpenMR 窗口：createMR 已成功 × B 重注册 → closeOpenMR 不调、不落 MR（R26-4）",
    async () => {
      // 旧实现：createMR 成功后无复查就 closeOpenMR；B 在 create await 中接管后
      // A 仍关旧 MR 并落本地 MR 状态/事件。
      // R26-4：mcp.submitMr.beforeCloseOpenMR 后复查完整 lease——失主停副作用。
      // 依赖插桩：mcp.submitMr.beforeCloseOpenMR（createMR 已成功、close 前）
      const id = alloc();
      await seedShipWithPrevMr(id);
      const task = (await getTask(id))!;
      const tokenA = String(allocTaskRunInstanceId());
      const tokenB = String(allocTaskRunInstanceId());

      registerBridgesForTest(task, {
        callerToken: tokenA,
        gitToken: "pat-r26-7",
      });

      const hang = installHangingFailpoint("mcp.submitMr.beforeCloseOpenMR");
      const pMr = runTaskAction(
        id,
        {
          kind: "submit_mr",
          actionId: "act_ship",
          repoPath: SUBMIT_REPO,
          projectPath: PROJECT_PATH,
          // 与盘上旧 MR.branch 不同 → 命中 closeOpenMR 分支
          sourceBranch: "feature/me/123-x__conflict",
          targetBranch: "test",
          title: "R26-7 新 MR",
          description: "",
          lastCommitHash: "newhash2",
        },
        tokenA,
      );
      await hang.waitHit();
      // createMR 已「成功」
      expect(mockCreateMR).toHaveBeenCalled();
      expect(mockCloseOpenMR).not.toHaveBeenCalled();

      registerBridgesForTest(task, {
        callerToken: tokenB,
        gitToken: "pat-r26-7-b",
      });

      hang.release();
      const result = await Promise.race([
        pMr,
        sleep(8000).then(() => "timeout" as const),
      ]);
      expect(result).not.toBe("timeout");
      // 接线语义：MR 已建不可撤销 → ok:true + skipped_local；关键是停 close/本地落盘
      expect(result).toMatchObject({
        ok: true,
        data: { skipped_local: true },
      });

      expect(mockCloseOpenMR).not.toHaveBeenCalled();
      const disk = await readMetaV06(id);
      // 仍只有 seed 的旧 MR（version=1、旧 url）——不得 upsert 新 MR
      expect(disk?.mrs ?? []).toHaveLength(1);
      expect(disk?.mrs?.[0]?.url).toContain("merge_requests/9");
      const events = await readEvents(id);
      expect(
        events.filter(
          (e) =>
            (e.kind === "info" || e.kind === "error") &&
            typeof e.text === "string" &&
            /关闭被取代|提 MR|merge_request/i.test(e.text),
        ),
      ).toHaveLength(0);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 8) R26-4：旧 action submit_work × 新 action post-check
  // ─────────────────────────────────────────────────────────────
  it(
    "R26-4 submit_work scope：旧 action A 交卷 × B check 在飞 → 不 abort B、A 被拒（R26-4）",
    async () => {
      // 旧实现：session caller 合法即 runActionPostCheck，入口无条件 abort 当前
      // runningChecks——旧 action A 的迟到 submit_work 会杀 B 的 check。
      // R26-4：MCP 须验 currentActionId+status；mcp.submitWork.beforeAbortCheck 后失主不 abort。
      // 依赖插桩：mcp.submitWork.beforeAbortCheck（可用于时序）
      const id = alloc();
      const meta = makeMeta(id);
      meta.runStatus = "running";
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

      // B 的 post-check 挂在 runningChecks
      const abortSpy = vi.fn();
      const controller = {
        abort: abortSpy,
        signal: { aborted: false },
      } as unknown as AbortController;
      const checkB = { actionId: "act_b", controller };
      runningChecks.set(id, checkB);

      // R29-1：waitAndClaimPostCheck 每轮验 action lease——旧 A 直接 invalid/stale，
      // 不再走到 beforeAbortCheck；语义不变：不得 abort B、不得登记 A 的 check
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
      const still = runningChecks.get(id);
      expect(still).toBe(checkB);
      expect(still?.actionId).toBe("act_b");
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 9) R26-5：普通 done 最后检查后 × claim
  // ─────────────────────────────────────────────────────────────
  it(
    "R26-5 普通 done：consume 自然 finished × claim → 无 task 级 done envelope（R26-5）",
    async () => {
      // 旧实现：普通 consume（非 questionRun）在 lostStartOwner 通过后仍 await getTask/
      // 条件写，最终 publish done 无复查——A 可清掉 B 的 streaming UI。
      // 现有测试只覆盖 question.beforeDone。
      // R26-5：consume.beforeDone 后复查 / publishIfCurrent——失主不发 done。
      // 依赖插桩：consume.beforeDone
      const id = alloc();
      await seedRunningAction(id, {
        actions: [
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
        ] as TaskMetaV06["actions"],
      });

      const agent = makeSessionAgent("agent_r26_9");
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: agent as never,
        agentId: agent.agentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: `r26 ${id}` },
      });

      const dones: unknown[] = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "done") dones.push(ev);
      });

      const hang = installHangingFailpoint("consume.beforeDone");
      const pReply = deliverAskReply(
        (await getTask(id))!,
        "R26-9 普通 done 窗口",
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
});

/*
 * ─────────────────────────────────────────────────────────────
 * 用例清单（主线核对）
 * ─────────────────────────────────────────────────────────────
 * R26-7.1  taskread.beforeHydrate × finalize → deliver/resume 不起活会话 / 无 worktree
 * R26-7.2  prewarm.beforeWorktreeAdd × finalize → ensure 不增、无 upsert/预热 info
 * R26-7.3  resume.beforeInstall × B installSessionIfCurrent → A close、token 仍是 B
 * R26-7.4  mcp.askUser.afterSupersede × B registerPendingAsk → getPendingAsk 仍是 ask B
 * R26-7.5  event.inQueue × claim → 带 lease 事件不落盘、不 publish
 * R26-7.6  metaCommit.beforeRename × caller 换主 → feishu keys 不变、handler ok:false
 * R26-7.7  mcp.submitMr.beforeCloseOpenMR × B 重注册 → closeOpenMR 不调、不 upsert 新 MR
 * R26-7.8  mcp.submitWork.beforeAbortCheck × 旧 action A → 不 abort B check
 * R26-7.9  consume.beforeDone × claim → 无 task 级 done envelope
 *
 * ─────────────────────────────────────────────────────────────
 * 行为假设（接线落地后主线核对用）
 * ─────────────────────────────────────────────────────────────
 * 1. resumeTaskSession / sendToTaskSession：终态（merged/abandoned）拒 resume；
 *    或 Agent.resume 后 installSessionIfCurrent(lease) 失败并 close 本次 agent
 * 2. prewarmTaskWorkspace：failpoint("prewarm.beforeWorktreeAdd") 后验终态/lifecycle，
 *    失主不调 ensureTaskWorktrees / upsertGitBranch / 预热 info
 * 3. resume：Agent.resume 返回后 failpoint("resume.beforeInstall")，再
 *    installSessionIfCurrent；失主 close 精确 agent、不覆盖 B 的 session/bridge
 * 4. ask notifier 失主：cancelPendingIf(taskId, signal.askId)，不得裸 cancelPending
 * 5. writeEventAndPublish/appendEvent：lease 透传到 appendEventLine；event.inQueue
 *    后队内验——false 不 appendFile、不 publish
 * 6. setFeishuTesterUserKeys / 条件 meta：commit(finalGuard=callerStillValid)；
 *    failpoint 后 caller 换主 → rename 拒、返 null
 * 7. submit_mr：createMR 成功后 failpoint("mcp.submitMr.beforeCloseOpenMR")，
 *    复查 caller；失主返 ok:true + skipped_local（MR 已建不可撤销）、不 closeOpenMR / 不 upsert
 * 8. awaitingNotifier submit_work：failpoint("mcp.submitWork.beforeAbortCheck") 后
 *    验 currentActionId===signal.actionId && running；否则不 abort、不启新 check
 * 9. 普通 consume 成功出口：failpoint("consume.beforeDone") 后复查失主 /
 *    publishIfCurrent——不得发 task 级 done
 * 10. registerSessionBridges 已退役——测试用 buildSessionBridges + setChat* 装 bridge
 */
