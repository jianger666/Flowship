/**
 * Ownership R25 线性化窗口矩阵（fable5-chat-polish 第二十五轮验收 R25-5 点名）
 *
 * 面向修复后的目标行为：commit rename / hydrate / MCP handler await / SDK·question
 * 出口 await 内换主后不得留下幽灵状态或不可逆副作用。
 * 修复代理并行插桩落地前本文件预期跑红——主线统一收口后按文末「关键假设」核对。
 *
 * setup 对齐 ownership-r23-matrix / ownership-r24-wave1：
 * raceExpectSettled 判赢家、断言不进条件分支、waitUntil 超时必抛。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r25-"));
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
/** advance / postcheck 秒过；本文件不验 check 本体 */
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));

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
  runningTasks,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  CALLER_MISMATCH_ERROR,
  cleanupChatTaskState,
  getPendingAsk,
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
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const { handleSdkMessage } = await import("@/lib/server/sdk-message-handler");
const {
  advanceTask,
  deliverTaskQuestion,
  finalizeTask,
  buildSessionBridges,
  startOneShotQuestion,
} = await import("@/lib/server/task-runner");
const {
  appendAction,
  getTask,
  listTasks,
  setTaskRunStatusIfRunOwner,
} = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r25-matrix DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
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
  SUBMIT_REPO = mkdtempSync(path.join(os.tmpdir(), "ownership-r25-submit-"));
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
    title: `ownership-r25 ${id}`,
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

/** ship action + 真实仓路径——submit_mr 校验链能走到 createMR 前 */
const seedShipForSubmitMr = async (id: string): Promise<void> => {
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
  meta.repoTestBranches = { [SUBMIT_REPO]: "test" } as TaskMetaV06["repoTestBranches"];
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
 * 仅首次命中挂起——R25-2：route/调用方 getTask 卡住时，finalize 内部后续 getTask 必须放行。
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

/** advance 用：create 后 wait 挂起，避免自然 finished 干扰 stop 收尾断言 */
const makeHangingAdvanceAgent = (agentId: string) => {
  const close = vi.fn();
  let releaseWait!: () => void;
  const waitGate = new Promise<void>((r) => {
    releaseWait = r;
  });
  const cancel = vi.fn().mockImplementation(async () => {
    releaseWait();
  });
  const wait = vi.fn().mockImplementation(async () => {
    await waitGate;
    return { status: "finished" as const };
  });
  const send = vi.fn().mockResolvedValue({
    stream: async function* () {
      /* 空 */
    },
    wait,
    cancel,
  });
  return { agentId, close, send, wait, cancel, releaseWait };
};


/** R26-2 管道适配：只装 bridge（不装 session） */
const registerBridgesForTest = (
  task: NonNullable<Awaited<ReturnType<typeof getTask>>>,
  opts: { callerToken: string; gitToken?: string },
) => {
  const bridges = buildSessionBridges(task, opts);
  setChatTaskActionHandler(task.id, bridges.taskActionHandler, opts.callerToken);
  setChatAwaitingNotifier(task.id, bridges.awaitingNotifier, opts.callerToken);
  return bridges;
};

describe("ownership R25 线性化窗口矩阵", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_r25_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    mockCreateMR.mockReset();
    mockGetMRMergeStatus.mockReset();
    mockCloseOpenMR.mockReset();
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
    mockCloseOpenMR.mockResolvedValue({ ok: true, closed: false });
    clearFailpoints();
  });

  afterEach(async () => {
    clearFailpoints();
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
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
  // 1) R25-1：metaCommit.beforeRename × 并发 stop
  // ─────────────────────────────────────────────────────────────
  it(
    "R25-1 rename 窗口：advance commit rename 未落盘 × stop → 无幽灵（R25-1 / R26-5）",
    async () => {
      // 旧实现：append guard 已过 → await rename 挂起 → stop 无锁 getTask 读旧 meta →
      // rename 落盘后 stop 按旧快照漏收尾 → action=running + task=idle + 无 runner。
      // R26-5：finalGuard 进 commit——revoke 落在 failpoint 后则拒 rename（0 action + idle）；
      // 若 rename 仍落盘，则 stop 锁内收尾必见并 cancelled。两路都不允许幽灵。
      // 依赖插桩：metaCommit.beforeRename
      const id = alloc();
      await writeMeta(makeMeta(id));

      const hangAgent = makeHangingAdvanceAgent("agent_r25_1");
      mockCreate.mockResolvedValue(hangAgent);

      const hang = installHangingFailpoint("metaCommit.beforeRename");
      // 立刻挂 catch：stop 后 advance 可能抛「正在停止」——避免 unhandled rejection 污染后续用例
      const pAdvance = advanceTask({
        task: (await getTask(id))!,
        actionType: "plan",
        userInstruction: "R25-1 rename 窗口推进",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      }).catch(() => {
        /* stale / stopping abort 可接受 */
      });
      await hang.waitHit();

      // ⚠️ 死锁：failpoint 时 append 持 task lock；stop 锁内事务会排队。
      // 注入动作里不能 await stop 完成再放行 rename——先 fire stop（等 revoke）、放行、再等 stop。
      const genAtHang = getTaskOpGeneration(id);
      const pStop = stopTaskAgent((await getTask(id))!);
      await waitUntil(() => getTaskOpGeneration(id) !== genAtHang);

      hang.release();
      await raceExpectSettled(pStop, 8000);
      await raceExpectSettled(pAdvance, 8000);
      hangAgent.releaseWait();
      await sleep(50);

      const fresh = await readMetaV06(id);
      expect(fresh?.runStatus).toBe("idle");
      // 新提交的 action 不得残留 running（拒写 0 条 / 或 stop 收尾成终态）
      const runningActions =
        fresh?.actions.filter((a) => a.status === "running") ?? [];
      expect(runningActions).toHaveLength(0);
      // 若 rename 已落盘：全部终态；若 R26-5 finalGuard 拒写：0 条也合法
      if ((fresh?.actions.length ?? 0) >= 1) {
        expect(
          fresh!.actions.every(
            (a) =>
              a.status === "cancelled" ||
              a.status === "completed" ||
              a.status === "error",
          ),
        ).toBe(true);
      }
      // 禁止幽灵组合：action=running + task=idle + 无 runner
      const zombie =
        (fresh?.actions.some((a) => a.status === "running") ?? false) &&
        fresh?.runStatus === "idle" &&
        !runningTasks.has(id) &&
        !agentSessions.has(id);
      expect(zombie).toBe(false);
    },
    20_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 2) R25-2：taskread.beforeHydrate × finalize × 陈旧 one-shot
  // ─────────────────────────────────────────────────────────────
  it(
    "R25-2 hydrate 窗口：getTask 持旧 meta × finalize 终态 → 陈旧快照不得写回 running / 不起 one-shot（R25-2）",
    async () => {
      // 旧实现：getTask 读完 developing meta 后 await hydrate；期间 finalize 写 merged 并释放
      // lifecycle；route 见 lifecycle=null + 新 gen，裸 setTaskRunStatus(running) 把终态改回
      // running 再起 one-shot。依赖插桩：taskread.beforeHydrate（仅首次挂起）
      const id = alloc();
      await writeMeta(makeMeta(id));
      expect((await readMetaV06(id))?.repoStatus).toBe("developing");

      let createCalls = 0;
      mockCreate.mockImplementation(async () => {
        createCalls += 1;
        return makeSessionAgent("agent_r25_2_oneshot");
      });

      const hang = installOnceHangingFailpoint("taskread.beforeHydrate");
      const pGet = getTask(id);
      await hang.waitHit();

      // hydrate 窗口内：finalize 写完终态并释放 lifecycle（二次 getTask 不挂）
      await finalizeTask(id, "merged");
      expect(getChatLifecycle(id)).toBeNull();
      expect((await readMetaV06(id))?.repoStatus).toBe("merged");

      hang.release();
      await raceExpectSettled(pGet, 5000);
      const staleTask = await pGet;
      expect(staleTask).not.toBeNull();
      // 返回值仍是 hydrate 前拍下的旧 developing 快照
      expect(staleTask!.repoStatus).toBe("developing");

      // runner 层等价 /question one-shot 路径（对齐 route R25-2 修复）：
      // lifecycle 已空 + 陈旧 developing 快照 → terminal-aware 条件写 running
      expect(getChatLifecycle(id)).toBeNull();
      const opGen = getTaskOpGeneration(id);
      const expectedWaitingStatus = staleTask!.runStatus;
      const updated = await setTaskRunStatusIfRunOwner(
        id,
        "running",
        () =>
          getTaskOpGeneration(id) === opGen &&
          getChatLifecycle(id) === null,
        undefined,
        expectedWaitingStatus,
      );
      // 终态拒写（route 见 null → 409、不起 one-shot）
      expect(updated).toBeNull();
      // 双保险：即便绕过条件写，one-shot 启动边界也必须因盘上终态让位
      startOneShotQuestion(
        staleTask!,
        "R25-2 终态后陈旧 one-shot？",
        undefined,
        { apiKey: CREDS.apiKey, model: CREDS.model },
        undefined,
        opGen,
      );
      await sleep(200);

      expect(createCalls).toBe(0);
      expect(mockCreate).not.toHaveBeenCalled();
      const disk = await readMetaV06(id);
      expect(disk?.repoStatus).toBe("merged");
      expect(disk?.runStatus).not.toBe("running");
    },
    20_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 3) R25-3：mcp.submitMr.beforeCreateMR × B 重注册
  // ─────────────────────────────────────────────────────────────
  it(
    "R25-3 createMR 窗口：handler 入场后 await 中换主 → createMR 不调、返接管文案（R25-3）",
    async () => {
      // 旧实现：runTaskAction 入口 token 匹配后进入 handler；卡在 host/getTask/校验 await
      // 时 B 重注册；A 恢复仍调 createMR 并落 MR。依赖插桩：mcp.submitMr.beforeCreateMR
      const id = alloc();
      await seedShipForSubmitMr(id);
      const task = (await getTask(id))!;
      const tokenA = String(allocTaskRunInstanceId());
      const tokenB = String(allocTaskRunInstanceId());

      registerBridgesForTest(task, {
        callerToken: tokenA,
        gitToken: "pat-r25-3",
      });

      const hang = installHangingFailpoint("mcp.submitMr.beforeCreateMR");
      const pMr = runTaskAction(
        id,
        {
          kind: "submit_mr",
          actionId: "act_ship",
          repoPath: SUBMIT_REPO,
          projectPath: PROJECT_PATH,
          sourceBranch: "feature/me/123-x",
          targetBranch: "test",
          title: "R25-3 MR",
          description: "",
          lastCommitHash: "abc1234",
        },
        tokenA,
      );
      await hang.waitHit();

      // 挂起期间 B 重注册新 callerToken（模拟接管）
      registerBridgesForTest(task, {
        callerToken: tokenB,
        gitToken: "pat-r25-3-b",
      });

      hang.release();
      const result = await Promise.race([
        pMr,
        sleep(8000).then(() => "timeout" as const),
      ]);
      expect(result).not.toBe("timeout");
      expect(result).toMatchObject({ ok: false });
      expect(
        (result as { ok: false; error: string }).error,
      ).toContain("已被新 agent 接管");
      // 文案与分派层 CALLER_MISMATCH_ERROR 同源（修复可复用）
      expect(CALLER_MISMATCH_ERROR).toContain("已被新 agent 接管");

      expect(mockCreateMR).not.toHaveBeenCalled();
      const disk = await readMetaV06(id);
      expect(disk?.mrs ?? []).toHaveLength(0);
      const events = await readEvents(id);
      expect(
        events.filter(
          (e) =>
            (e.kind === "info" || e.kind === "error") &&
            typeof e.text === "string" &&
            /MR|提测|merge_request/i.test(e.text),
        ),
      ).toHaveLength(0);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 4) R25-3：mcp.askUser.afterSupersede × B 重注册
  // ─────────────────────────────────────────────────────────────
  it(
    "R25-3 ask 窗口：supersede 后换主 → 不落 ask 事件 / awaiting_user、pendingAsk 反登记（R25-3）",
    async () => {
      // 旧实现：caller 入口通过后 await supersedePendingAsks；B 在 await 中接管，
      // A 仍写 ask_user_request + awaiting_user，pendingAsk 成孤儿弹窗。
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
          { id: "q1", question: "R25-3 接管窗口提问？", allowText: true },
        ],
      });
      await hang.waitHit();

      // 此时 pendingAsk 已登记（工具层先 register）——B 接管
      expect(getPendingAsk(id)).not.toBeNull();
      registerBridgesForTest(task, { callerToken: tokenB });

      hang.release();
      await raceExpectSettled(pAsk, 8000);
      await sleep(50);

      const events = await readEvents(id);
      expect(
        events.filter((e) => e.kind === "ask_user_request"),
      ).toHaveLength(0);
      const disk = await readMetaV06(id);
      expect(disk?.runStatus).not.toBe("awaiting_user");
      // 反登记：无孤儿弹窗
      expect(getPendingAsk(id)).toBeNull();
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 5) R25-4：sdkmsg.beforeEventWrite × claim 换主
  // ─────────────────────────────────────────────────────────────
  it(
    "R25-4 event 窗口：handleSdkMessage tool_result await 后换主 → 事件不落盘（R25-4）",
    async () => {
      // 旧实现：入口 isTaskOpCurrent 通过后 await buildToolResultMeta / flush；
      // await 内 B claim，A 仍永久写 tool_result。依赖插桩：sdkmsg.beforeEventWrite
      const id = alloc();
      await seedRunningAction(id);
      const handleA = claimTaskOp(id, getTaskOpGeneration(id));
      expect(handleA).not.toBeNull();

      const eventsBefore = (await readEvents(id)).length;
      const hang = installHangingFailpoint("sdkmsg.beforeEventWrite");
      const pMsg = handleSdkMessage(
        id,
        {
          type: "tool_call",
          name: "shell",
          call_id: "call_r25_4",
          status: "completed",
          args: { command: "echo r25" },
          result: { output: "r25-ok" },
        } as never,
        {
          buffer: "",
          flush: async () => {},
        },
        // R27-6 管道适配：lease 改必传闭包（断言不变）
        () => isTaskOpCurrent(handleA!),
      );
      await hang.waitHit();

      // 期间 claim 换主
      const handleB = claimTaskOp(id, getTaskOpGeneration(id));
      expect(handleB).not.toBeNull();
      expect(isTaskOpCurrent(handleA!)).toBe(false);

      hang.release();
      await raceExpectSettled(pMsg, 5000);
      await sleep(40);

      const events = await readEvents(id);
      expect(
        events.filter(
          (e) =>
            e.kind === "tool_result" &&
            (e.meta as { callId?: string } | undefined)?.callId ===
              "call_r25_4",
        ),
      ).toHaveLength(0);
      expect(events.length).toBe(eventsBefore);

      releaseTaskOpIf(handleB!);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 6) R25-4：question.beforeDone × 换主
  // ─────────────────────────────────────────────────────────────
  it(
    "R25-4 done 窗口：questionRun 出口 publish done 前换主 → 不发 task 级 done（R25-4）",
    async () => {
      // 旧实现：lostStartOwner 通过后 await restore/getTask，再无复查 publish done；
      // B 接管后前端仍收旧 done 清 streamingText。依赖插桩：question.beforeDone
      const id = alloc();
      await seedRunningAction(id);

      const agent = makeSessionAgent("agent_r25_4_q");
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: agent as never,
        agentId: agent.agentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: `r25 ${id}` },
      });

      const dones: unknown[] = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "done") dones.push(ev);
      });

      const hang = installHangingFailpoint("question.beforeDone");
      const pQ = deliverTaskQuestion(
        (await getTask(id))!,
        "R25-4 答疑 done 窗口",
        undefined,
        {
          apiKey: CREDS.apiKey,
          model: CREDS.model,
        },
      );
      await hang.waitHit();

      claimTaskOp(id, getTaskOpGeneration(id));
      hang.release();
      await raceExpectSettled(pQ, 8000);
      await sleep(80);
      unsub();

      expect(dones).toHaveLength(0);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 7) R25-1 补充：stop 先拿锁 × append.afterPrepare（M6b 反向序）
  // ─────────────────────────────────────────────────────────────
  it(
    "R25-1 补充：stop 先 revoke × append 排队 → early guard 拒写、不落盘（R25-1 / M6b 反向）",
    async () => {
      // 旧实现对偶窗口：与 M6b（append.afterPrepare 先挂 → 再 stop）顺序相反——
      // 先跑 stop（afterGate 时已 sync revoke），再让 append 入锁。
      // revoke 先行时 early guard（prepare 前）即拒，到不了 append.afterPrepare；
      // 与 M6b「prepare 后复查」形成对偶闭环。依赖插桩：stop.afterGate
      // （append.afterPrepare 仍安装：断言未被命中，证明走的是 early-guard 短路）
      const id = alloc();
      await writeMeta(makeMeta(id));
      const actionsBefore = (await readMetaV06(id))!.actions.length;

      const gen = getTaskOpGeneration(id);
      const ownerA = claimTaskOp(id, gen);
      expect(ownerA).not.toBeNull();

      const hangStop = installHangingFailpoint("stop.afterGate");
      const hangAppend = installHangingFailpoint("append.afterPrepare");
      const pStop = stopTaskAgent((await getTask(id))!);
      await hangStop.waitHit();
      // stop 已 sync revoke；锁内收尾尚未拿锁（卡在 afterGate）
      expect(isTaskOpCurrent(ownerA!)).toBe(false);

      const pAppend = appendAction(
        id,
        { type: "plan", userInstruction: "R25-1 反向序幽灵 append" },
        { guard: () => isTaskOpCurrent(ownerA!) },
      );
      const appended = await Promise.race([
        pAppend,
        sleep(5000).then(() => "timeout" as const),
      ]);
      expect(appended).toBeNull();
      expect(appended).not.toBe("timeout");
      // revoke 先行 → early guard 短路，不应进 prepare 后窗口
      expect(hangAppend.wasHit()).toBe(false);

      hangStop.release();
      hangAppend.release();
      await raceExpectSettled(pStop, 5000);

      const fresh = await readMetaV06(id);
      expect(fresh?.actions).toHaveLength(actionsBefore);
      expect(fresh?.runStatus).toBe("idle");
      expect(fresh?.actions.filter((a) => a.status === "running")).toHaveLength(
        0,
      );
    },
    15_000,
  );
});

/*
 * ─────────────────────────────────────────────────────────────
 * 用例清单（主线核对）
 * ─────────────────────────────────────────────────────────────
 * R25-1   metaCommit.beforeRename × 并发 stop → idle、无 running action、无幽灵
 *         （R26-5：finalGuard 拒 rename → 0 action；或 rename 落盘后 stop 收尾 cancelled）
 * R25-2   taskread.beforeHydrate × finalize → 陈旧快照不写 running / 不起 one-shot
 * R25-3a  mcp.submitMr.beforeCreateMR × B 重注册 → createMR 不调、接管文案
 * R25-3b  mcp.askUser.afterSupersede × B 重注册 → 无 ask 事件 / awaiting / pendingAsk
 * R25-4a  sdkmsg.beforeEventWrite × claim → tool_result 不落盘
 * R25-4b  question.beforeDone × claim → 不 publish done
 * R25-1b  stop.afterGate 先 × append → early guard 拒写（M6b 反向；afterPrepare 不命中）
 *
 * ─────────────────────────────────────────────────────────────
 * 关键假设（修复落地后主线核对用）
 * ─────────────────────────────────────────────────────────────
 * 1. prepareMetaWrite().commit(finalGuard?)：failpoint("metaCommit.beforeRename")
 *    → 同步 finalGuard → rename；false 则 unlink tmp 不 rename（R26-5）
 * 2. getTask 在 readMeta 后、hydrate await 前调用 failpoint("taskread.beforeHydrate")
 * 3. submit_mr：外部 await（host/getTask/validate）之后、createMR 之前复查 caller，
 *    并调用 failpoint("mcp.submitMr.beforeCreateMR")；失主返含「已被新 agent 接管」
 * 4. ask notifier：supersedePendingAsks 之后、写 ask 事件前复查 caller，
 *    并调用 failpoint("mcp.askUser.afterSupersede")；失主 cancelPendingIf(askId)、不写 awaiting_user
 * 5. emitToolResult：buildToolResultMeta await 之后、写事件前复查，
 *    并调用 failpoint("sdkmsg.beforeEventWrite")
 * 6. questionRun 出口：publish done 前复查失主，并调用 failpoint("question.beforeDone")
 * 7. stop 用 finalizeStaleAndIdleLocked 与 append commit 共享 withTaskLock
 * 8. 终态下裸 setTaskRunStatus("running") 拒写；one-shot 启动前 readTaskRepoStatusFresh 让位
 */
