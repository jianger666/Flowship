/**
 * R24 第二波定向测试：R24-1 / R24-2 / R24-6 / R24-7
 *
 * 与 ownership-r24-wave1 / r23-* 分开，避免并行测试代理冲突。
 */
import { mkdtempSync, promises as fs } from "node:fs";
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r24w2-"));
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

// R24-1：可控慢 check——挂起后放行
let checkGate: Promise<void> = Promise.resolve();
let releaseCheckGate: (() => void) | null = null;
const resetCheckGate = () => {
  releaseCheckGate = null;
  checkGate = new Promise<void>((r) => {
    releaseCheckGate = r;
  });
};
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => {
    await checkGate;
    return { passed: true, details: "ok" };
  }),
  captureActionStartBaseline: vi.fn(),
  captureReadonlyRepoBaselines: vi.fn(),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readMetaV06, taskDir, writeMeta } = taskFsCore;
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
  snapshotTaskOp,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { clearFailpoints } = await import("@/lib/server/failpoints");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const {
  CALLER_MISMATCH_ERROR,
  cleanupChatTaskState,
  getExpectedCallerToken,
  getPendingAsk,
  matchExpectedCallerToken,
  runTaskAction,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { dispatchAskUserForTest } = await import("@/lib/server/chat-mcp");
const { handleSdkMessage } = await import("@/lib/server/sdk-message-handler");
const { getTask, listTasks } = await import("@/lib/server/task-fs");
const {
  abortRunningCheck,
  deliverTaskQuestion,
  buildSessionBridges,
} = await import("@/lib/server/task-runner");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r24-wave2 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

// 先跑空目录 boot recovery——否则首条 seed 的 running 会被 recovery 标成 error
await listTasks();

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r24w2 ${id}`,
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

const seedRunningAction = async (id: string): Promise<void> => {
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

describe("ownership R24 wave2", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_r24w2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    clearFailpoints();
    resetCheckGate();
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
      endChatLifecycle(id);
      revokeTaskOps(id);
      cleanupChatTaskState(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ─────────────────────────────────────────────────────────────
  // R24-1：run 结束 release owner 后慢 check 仍能落 awaiting_ack，且摘掉 runningChecks
  // ─────────────────────────────────────────────────────────────
  it("R24-1 主案例：run owner 已 release 后慢 check 完成 → 落 awaiting_ack + 摘 zombie", async () => {
    const id = alloc();
    await seedRunningAction(id);
    const task = (await getTask(id))!;
    const callerToken = String(allocTaskRunInstanceId());
    // 模拟 run 已 claim 后释放（consume finally）——旧实现会把 check 结果作废
    const runHandle = claimTaskOp(id, getTaskOpGeneration(id))!;
    const { awaitingNotifier } = registerBridgesForTest(task, {
      callerToken,
    });
    releaseTaskOpIf(runHandle);

    // 交卷 → 启慢 check（挂在 gate）
    // R25-3：notifier 签名加 ctx；直调时传恒 true 闭包（管道适配、断言不弱化）
    const stillValid = { callerStillValid: () => true };
    void awaitingNotifier(
      {
        kind: "awaiting_start",
        actionId: "act_shared",
        artifactPath: "actions/1-plan.md",
      },
      stillValid,
    );
    await waitUntil(() => runningChecks.has(id));

    // 放行 check
    releaseCheckGate?.();
    await waitUntil(async () => {
      const m = await readMetaV06(id);
      return (
        m?.actions.find((a) => a.id === "act_shared")?.status ===
          "awaiting_ack" && m.runStatus === "awaiting_user"
      );
    }, 8000);

    expect(runningChecks.has(id)).toBe(false);
  }, 15_000);

  it("R24-1 接管：check 期间 stop revoke → 不落状态 + runningChecks 摘掉", async () => {
    const id = alloc();
    await seedRunningAction(id);
    const task = (await getTask(id))!;
    const callerToken = String(allocTaskRunInstanceId());
    const { awaitingNotifier } = registerBridgesForTest(task, { callerToken });

    void awaitingNotifier(
      {
        kind: "awaiting_start",
        actionId: "act_shared",
        artifactPath: "actions/1-plan.md",
      },
      { callerStillValid: () => true },
    );
    await waitUntil(() => runningChecks.has(id));

    // stop 语义：abort check + revoke gen
    abortRunningCheck(id);
    revokeTaskOps(id);
    releaseCheckGate?.();
    await sleep(80);

    const m = await readMetaV06(id);
    expect(m?.actions.find((a) => a.id === "act_shared")?.status).toBe(
      "running",
    );
    expect(m?.runStatus).toBe("running");
    expect(runningChecks.has(id)).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────
  // R24-2：复用会话第二轮——caller 不变时 bridge 仍有效（不绑一次性 op）
  // ─────────────────────────────────────────────────────────────
  it("R24-2：同 caller 第二轮 send 后 submit_work 路径正常执行", async () => {
    const id = alloc();
    await seedRunningAction(id);
    const task = (await getTask(id))!;
    const callerToken = String(allocTaskRunInstanceId());

    // 首轮：claim + 注册 + release（模拟首轮 run 结束）
    const h1 = claimTaskOp(id, getTaskOpGeneration(id))!;
    const { awaitingNotifier } = registerBridgesForTest(task, { callerToken });
    releaseTaskOpIf(h1);

    // 第二轮：新 claim（H2）但不重注册——产品语义「续用会话」只 send、不换 token
    const h2 = claimTaskOp(id, getTaskOpGeneration(id))!;
    expect(getExpectedCallerToken(id)).toBe(callerToken);
    expect(matchExpectedCallerToken(id, callerToken)).toBe(true);

    // 立刻放行 check（本用例验 bridge 不被拒，不验慢 check）
    releaseCheckGate?.();
    await awaitingNotifier(
      {
        kind: "awaiting_start",
        actionId: "act_shared",
        artifactPath: "actions/1-plan.md",
      },
      { callerStillValid: () => true },
    );
    await waitUntil(async () => {
      const m = await readMetaV06(id);
      return (
        m?.actions.find((a) => a.id === "act_shared")?.status === "awaiting_ack"
      );
    }, 8000);

    releaseTaskOpIf(h2);
  });

  // ─────────────────────────────────────────────────────────────
  // R24-6：旧 token 在 B 重注册后被拒、无 pendingAsk 副作用
  // ─────────────────────────────────────────────────────────────
  it("R24-6：旧 caller 在 B 重注册后 ask_user 被拒、pendingAsk 未登记", async () => {
    const id = alloc();
    await seedRunningAction(id);
    const task = (await getTask(id))!;
    const tokenA = String(allocTaskRunInstanceId());
    const tokenB = String(allocTaskRunInstanceId());

    registerBridgesForTest(task, { callerToken: tokenA });
    // B 接管重注册
    registerBridgesForTest(task, { callerToken: tokenB });
    expect(getExpectedCallerToken(id)).toBe(tokenB);

    const rejected = await dispatchAskUserForTest({
      taskId: id,
      callerToken: tokenA,
      actionId: "act_shared",
      questions: [
        { id: "q1", question: "旧 A 迟到提问？", allowText: true },
      ],
    });
    expect(rejected).toEqual({ ok: false, error: CALLER_MISMATCH_ERROR });
    expect(getPendingAsk(id)).toBeNull();

    // B 自己的调用正常
    const ok = await dispatchAskUserForTest({
      taskId: id,
      callerToken: tokenB,
      actionId: "act_shared",
      questions: [
        { id: "q1", question: "B 合法提问？", allowText: true },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(getPendingAsk(id)?.askId).toBeTruthy();

    // submit_mr 路径：旧 token 在 runTaskAction 入口拒、不进 handler
    const mrReject = await runTaskAction(
      id,
      {
        kind: "set_plan_batches",
        actionId: "act_shared",
        batches: [],
      },
      tokenA,
    );
    expect(mrReject).toEqual({ ok: false, error: CALLER_MISMATCH_ERROR });
  });

  // ─────────────────────────────────────────────────────────────
  // R24-7：失主后不发 done/error；handleSdkMessage 失主不落事件
  // ─────────────────────────────────────────────────────────────
  it("R24-7：handleSdkMessage 失主后不落 thinking 事件", async () => {
    const id = alloc();
    await seedRunningAction(id);
    const handle = snapshotTaskOp(id);
    // 换主 → handle 失效
    claimTaskOp(id, getTaskOpGeneration(id));

    const events: { kind: string }[] = [];
    const unsub = subscribeTaskStream(id, (ev) => {
      if ("kind" in ev) events.push({ kind: String(ev.kind) });
    });

    // R27-6 管道适配：handleSdkMessage lease 改必传闭包（断言不变）
    await handleSdkMessage(
      id,
      { type: "thinking", text: "迟到思考" } as never,
      {
        buffer: "",
        flush: async () => {},
      },
      () => isTaskOpCurrent(handle),
    );
    unsub();
    expect(events.filter((e) => e.kind === "thinking")).toHaveLength(0);
  });

  it("R24-7：questionRun 失主后不发 done envelope", async () => {
    const id = alloc();
    await seedRunningAction(id);

    let releaseWait!: () => void;
    const waitGate = new Promise<void>((r) => {
      releaseWait = r;
    });
    const cancel = vi.fn().mockImplementation(async () => {
      releaseWait();
    });
    const send = vi.fn().mockResolvedValue({
      stream: async function* () {
        /* 空 */
      },
      wait: async () => {
        await waitGate;
        return { status: "finished" as const };
      },
      cancel,
    });
    const agent = {
      agentId: "agent_r24_7_q",
      close: vi.fn(),
      send,
    };
    agentSessions.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agent: agent as never,
      agentId: agent.agentId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title: `r24w2 ${id}` },
    });

    const dones: unknown[] = [];
    const unsub = subscribeTaskStream(id, (ev) => {
      if (ev.kind === "done") dones.push(ev);
    });

    // deliverTaskQuestion 无 ackContext → questionRun；入场拍 observer 后、wait 前换主
    const p = deliverTaskQuestion((await getTask(id))!, "R24-7 答疑", undefined, {
      apiKey: "k",
      model: { id: "m", params: [] as never[] },
    });

    await waitUntil(() => send.mock.calls.length > 0, 5000);
    // B claim → questionRun 的 observer 失效
    claimTaskOp(id, getTaskOpGeneration(id));
    releaseWait();
    await p;
    await sleep(80);
    unsub();

    expect(dones).toHaveLength(0);
  });
});
