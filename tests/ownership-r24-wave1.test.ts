/**
 * R24 第一波定向测试：R24-3a/b/c、R24-4、R24-5b/c
 *
 * 与 ownership-r23-* / failpoint-matrix 分开，避免并行测试代理冲突。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r24-"));
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
vi.mock("@/lib/server/chat-pending", () => ({
  cleanupChatTaskState: vi.fn(),
  invalidateCallerToken: vi.fn(),
  buildAgentMessage: (opts: { text: string }) => opts.text,
  cancelPending: vi.fn(),
  getPendingAsk: vi.fn(),
  setChatAwaitingNotifier: vi.fn(),
  setChatTaskActionHandler: vi.fn(),
  unsetChatAwaitingNotifierIf: vi.fn(),
  unsetChatTaskActionHandlerIf: vi.fn(),
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
  runningTasks,
  snapshotTaskOp,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  beginChatLifecycle,
  clearChatGate,
  endChatLifecycle,
  getChatLifecycle,
} = await import("@/lib/server/chat-gate");
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const {
  deliverAskReply,
  runWithTaskSendSerial,
  startOneShotQuestion,
} = await import("@/lib/server/task-runner");
const {
  appendAction,
  getTask,
  patchActionAndRunStatusIfOpFresh,
  patchActionIfOwner,
  setTaskRepoStatus,
  setTaskRunStatusIfRunOwner,
} = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r24-wave1 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const CREDS = {
  apiKey: "k",
  model: { id: "m", params: [] as never[] },
  fallbackModel: { id: "m", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r24 ${id}`,
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

const seedSharedAction = async (
  id: string,
  status: "running" | "idle" = "running",
): Promise<void> => {
  const meta = makeMeta(id);
  meta.runStatus = status === "running" ? "running" : "idle";
  meta.currentActionId = "act_shared";
  meta.sessionAgentId = "agent_persisted";
  meta.actions = [
    {
      id: "act_shared",
      n: 1,
      type: "plan",
      status: status === "running" ? "running" : "awaiting_ack",
      userInstruction: "",
      artifactPath: null,
      startedAt: Date.now(),
      endedAt: status === "running" ? null : Date.now(),
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

describe("ownership R24 wave1", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_r24_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    for (const id of ids) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      clearChatGate(id);
      endChatLifecycle(id);
      revokeTaskOps(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ─────────────────────────────────────────────────────────────
  // R24-3a：send 排队期间 claim → 出队让位、不覆盖 B
  // ─────────────────────────────────────────────────────────────
  it("R24-3a send 串行排队期间同 gen claim → 出队返 stale、不 send/不占 B", async () => {
    const id = alloc();
    await seedSharedAction(id, "running");

    const agentA = makeSessionAgent("agent_r24_3a_a");
    agentSessions.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agent: agentA as never,
      agentId: agentA.agentId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title: `r24 ${id}` },
    });

    // 占住 send 串行链——A 入队后会卡在 prev 之后
    let releaseBlocker!: () => void;
    const blockerGate = new Promise<void>((r) => {
      releaseBlocker = r;
    });
    let blockerEntered = false;
    const pBlocker = runWithTaskSendSerial(id, async () => {
      blockerEntered = true;
      await blockerGate;
    });
    await waitUntil(() => blockerEntered);

    // A 在入口同步 snapshot 后入队（此时还在排队、body 未跑）
    const observerBeforeQueue = snapshotTaskOp(id);
    const pSend = deliverAskReply(
      (await getTask(id))!,
      "答案 A",
      undefined,
      "act_shared",
    );
    // 给 A 一点时间完成入口 snapshot + 挂上串行链
    await sleep(30);

    // 同 generation claim：B 换主（claimSeq 变、gen 不变）
    const gen = getTaskOpGeneration(id);
    const ownerB = claimTaskOp(id, gen);
    expect(ownerB).not.toBeNull();
    expect(isTaskOpCurrent(observerBeforeQueue)).toBe(false);

    // B 换掉 session（不占 runningTasks——否则 A body 的 waitForRunToDrain 会挂死）
    const bSessionId = allocTaskRunInstanceId();
    const agentB = makeSessionAgent("agent_r24_3a_b");
    agentSessions.set(id, {
      instanceId: bSessionId,
      agent: agentB as never,
      agentId: agentB.agentId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title: `r24 ${id}` },
    });

    releaseBlocker();
    await pBlocker;
    const sendResult = await Promise.race([
      pSend,
      sleep(5000).then(() => "timeout" as const),
    ]);
    expect(sendResult).toBe("stale");
    expect(sendResult).not.toBe("timeout");

    // A 不得 send；B 的 session 不被 A 覆盖/清掉
    expect(agentA.send).not.toHaveBeenCalled();
    expect(agentSessions.get(id)?.instanceId).toBe(bSessionId);
    expect(agentSessions.get(id)?.agentId).toBe(agentB.agentId);

    releaseTaskOpIf(ownerB!);
  });

  // ─────────────────────────────────────────────────────────────
  // R24-3b：one-shot ensureWorkspaceReady 期间 claim → 让位
  // ─────────────────────────────────────────────────────────────
  it("R24-3b oneshot.beforeEnsure 期间 claim → 让位、不 create", async () => {
    const id = alloc();
    await seedSharedAction(id, "idle");

    const hang = installHangingFailpoint("oneshot.beforeEnsure");
    let createCalls = 0;
    mockCreate.mockImplementation(async () => {
      createCalls += 1;
      return makeSessionAgent("agent_oneshot_a");
    });

    const observerAtStart = snapshotTaskOp(id);
    startOneShotQuestion(
      (await getTask(id))!,
      "问一问",
      undefined,
      { apiKey: CREDS.apiKey, model: CREDS.model },
    );
    await hang.waitHit();

    const gen = getTaskOpGeneration(id);
    const ownerB = claimTaskOp(id, gen);
    expect(ownerB).not.toBeNull();
    expect(isTaskOpCurrent(observerAtStart)).toBe(false);

    hang.release();
    // ensure 放行后应发现失主并 return——绝不 Agent.create
    await sleep(120);
    expect(createCalls).toBe(0);
    expect(runningTasks.has(id)).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();

    releaseTaskOpIf(ownerB!);
  });

  // ─────────────────────────────────────────────────────────────
  // R24-3c：resume 登记后 caller 失主 → 刚登记的 session 被清
  // ─────────────────────────────────────────────────────────────
  it("R24-3c resume 登记后 entry 失主 → 按 instance 清刚登记 session", async () => {
    const id = alloc();
    await seedSharedAction(id, "idle");
    // 无内存会话、有落盘锚点 → send 走 resume
    expect(agentSessions.has(id)).toBe(false);

    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((r) => {
      releaseResume = r;
    });
    let resumeHit = false;
    const resumedAgent = makeSessionAgent("agent_r24_3c_resumed");
    mockResume.mockImplementation(async () => {
      resumeHit = true;
      await resumeGate;
      return resumedAgent;
    });

    const pSend = deliverAskReply(
      (await getTask(id))!,
      "答案",
      undefined,
      "act_shared",
      {
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      },
    );
    await waitUntil(() => resumeHit);

    // resume await 期间 B claim——A 的 entry observer 失效
    const gen = getTaskOpGeneration(id);
    const ownerB = claimTaskOp(id, gen);
    expect(ownerB).not.toBeNull();

    releaseResume();
    const sendResult = await Promise.race([
      pSend,
      sleep(5000).then(() => "timeout" as const),
    ]);
    expect(sendResult).toBe("stale");
    expect(sendResult).not.toBe("timeout");

    // R24-3c：刚登记的 A session 必须被清掉（B 需要干净位子）
    expect(agentSessions.has(id)).toBe(false);
    expect(resumedAgent.close).toHaveBeenCalled();

    releaseTaskOpIf(ownerB!);
  });

  // ─────────────────────────────────────────────────────────────
  // R24-4：append.afterPrepare 挂起期间 stop 完成 → commit 被拒
  // ─────────────────────────────────────────────────────────────
  it("R24-4 append.afterPrepare × stop revoke → commit 拒、无幽灵 action", async () => {
    const id = alloc();
    await seedSharedAction(id, "idle");
    // 清掉 seed 的 action，模拟「推进前空 actions」更直观；保留 task 目录
    {
      const meta = (await readMetaV06(id))!;
      meta.actions = [];
      meta.currentActionId = null;
      meta.runStatus = "idle";
      await writeMeta(meta);
    }

    const gen = getTaskOpGeneration(id);
    const ownerA = claimTaskOp(id, gen);
    expect(ownerA).not.toBeNull();

    const hang = installHangingFailpoint("append.afterPrepare");
    const pAppend = appendAction(
      id,
      { type: "plan", userInstruction: "幽灵推进" },
      { guard: () => isTaskOpCurrent(ownerA!) },
    );
    await hang.waitHit();

    // 验收点名第三种顺序：guard 已过、prepare 已写 tmp、stop 重读在中间。
    // ⚠️ stop 的 patchAction 要同把 task lock——不能 await 完整 stop（会死锁），
    // 先 fire stop 等到 revoke，再放行 append abort，最后等 stop 收尾。
    const pStop = stopTaskAgent((await getTask(id))!);
    await waitUntil(() => !isTaskOpCurrent(ownerA!));

    hang.release();
    const appended = await Promise.race([
      pAppend,
      sleep(5000).then(() => "timeout" as const),
    ]);
    expect(appended).toBeNull();
    expect(appended).not.toBe("timeout");

    await Promise.race([pStop, sleep(5000)]);
    const fresh = await readMetaV06(id);
    expect(fresh?.actions.length).toBe(0);
    expect(fresh?.runStatus).toBe("idle");
    expect(fresh?.currentActionId).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────
  // R24-5b：终态后旧链 append/patch 全被拒
  // ─────────────────────────────────────────────────────────────
  it("R24-5b finalize 写完终态后旧链 append/patch 全拒", async () => {
    const id = alloc();
    await seedSharedAction(id, "running");

    // 模拟 finalize 已写终态（裸 setTaskRepoStatus——不经条件 helper）
    await setTaskRepoStatus(id, "merged");
    const meta = await readMetaV06(id);
    expect(meta?.repoStatus).toBe("merged");

    const gen = getTaskOpGeneration(id);
    const owner = claimTaskOp(id, gen);
    expect(owner).not.toBeNull();
    const stillOwner = () => isTaskOpCurrent(owner!);

    const appended = await appendAction(
      id,
      { type: "build", userInstruction: "终态幽灵" },
      { guard: stillOwner },
    );
    expect(appended).toBeNull();

    const patched = await patchActionAndRunStatusIfOpFresh(
      id,
      "act_shared",
      "running",
      "running",
      stillOwner,
      { currentActionId: "act_shared" },
    );
    expect(patched).toBeNull();

    const patchedOnly = await patchActionIfOwner(
      id,
      "act_shared",
      { status: "completed" },
      stillOwner,
    );
    expect(patchedOnly).toBeNull();

    const runPatched = await setTaskRunStatusIfRunOwner(
      id,
      "running",
      stillOwner,
    );
    expect(runPatched).toBeNull();

    const fresh = await readMetaV06(id);
    expect(fresh?.repoStatus).toBe("merged");
    expect(fresh?.actions.find((a) => a.id === "act_shared")?.status).toBe(
      "running",
    );
    expect(fresh?.actions.some((a) => a.type === "build")).toBe(false);

    releaseTaskOpIf(owner!);
  });

  // ─────────────────────────────────────────────────────────────
  // R24-5c：finalizing 期间 stop 进来 join、不破坏
  // ─────────────────────────────────────────────────────────────
  it("R24-5c finalizing 期间 stop → join 不 revoke/不写状态", async () => {
    const id = alloc();
    await seedSharedAction(id, "running");

    const genBefore = getTaskOpGeneration(id);
    const began = beginChatLifecycle(id, "finalizing");
    expect(began).toBe(true);
    expect(getChatLifecycle(id)).toBe("finalizing");

    // 模拟 finalize 已 revoke 一次后的 gen；再记一个 owner 证明 stop 不再二次 revoke
    revokeTaskOps(id);
    const genAfterFinalizeRevoke = getTaskOpGeneration(id);
    expect(genAfterFinalizeRevoke).toBeGreaterThan(genBefore);
    const owner = claimTaskOp(id, genAfterFinalizeRevoke);
    expect(owner).not.toBeNull();

    const before = await readMetaV06(id);
    const result = await stopTaskAgent((await getTask(id))!);
    expect(result.hadAgent).toBe(false);
    expect(getChatLifecycle(id)).toBe("finalizing");
    // 不得再 bump gen（join 不 revoke）
    expect(getTaskOpGeneration(id)).toBe(genAfterFinalizeRevoke);
    expect(isTaskOpCurrent(owner!)).toBe(true);

    const after = await readMetaV06(id);
    // 不得把 awaiting_ack/running 改成 cancelled、不得写 idle
    expect(after?.runStatus).toBe(before?.runStatus);
    expect(after?.actions.find((a) => a.id === "act_shared")?.status).toBe(
      "running",
    );

    releaseTaskOpIf(owner!);
    endChatLifecycle(id, "finalizing");
  });
});
