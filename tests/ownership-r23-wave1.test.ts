/**
 * R23 第一波定向测试：R23-1a/b/c、R23-2、R23-6、R23-7、R23-8
 *
 * 与 ownership-failpoint-matrix 分开，避免与并行测试代理冲突。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r23-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: vi.fn(),
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
  snapshotTaskOp,
} = await import("@/lib/server/task-stream");
const { withTaskLock } = taskFsCore;
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  beginChatLifecycle,
  clearChatGate,
  endChatLifecycle,
} = await import("@/lib/server/chat-gate");
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const {
  advanceTask,
  finalizeTask,
  resumeCurrentActionWithMessage,
  TASK_OP_STALE_HTTP_MESSAGE,
} = await import("@/lib/server/task-runner");
const { appendAction, getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r23-wave1 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
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
    title: `ownership-r23 ${id}`,
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

const seedAwaitingAck = async (id: string): Promise<void> => {
  const meta = makeMeta(id);
  meta.runStatus = "awaiting_user";
  meta.currentActionId = "act_ack";
  meta.actions = [
    {
      id: "act_ack",
      n: 1,
      type: "plan",
      status: "awaiting_ack",
      userInstruction: "",
      artifactPath: null,
      startedAt: Date.now() - 1000,
      endedAt: Date.now() - 500,
    },
  ] as TaskMetaV06["actions"];
  await writeMeta(meta);
};

const seedSharedAction = async (
  id: string,
  status: "running" | "error" | "cancelled",
): Promise<void> => {
  const meta = makeMeta(id);
  meta.runStatus =
    status === "running" ? "running" : status === "error" ? "error" : "idle";
  meta.currentActionId = "act_shared";
  meta.actions = [
    {
      id: "act_shared",
      n: 1,
      type: "plan",
      status,
      userInstruction: "",
      artifactPath: null,
      startedAt: Date.now(),
      endedAt: status === "running" ? null : Date.now(),
    },
  ] as TaskMetaV06["actions"];
  await writeMeta(meta);
};

const makeInstantAgent = (agentId: string) => {
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
  const agent = { agentId, close, send };
  mockCreate.mockResolvedValue(agent);
  return { close, send, wait, cancel, agentId, agent };
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

describe("ownership R23 wave1", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_r23_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
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
    }
    await sleep(30);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("R23-1a：stop 把 pendingAck cancelled 后 advance auto-approve 不改写 completed", async () => {
    // R24-8：旧用例先完整 stop 再用 fresh task 调 advance——pendingAck 分支根本不进；
    // 改为：带着 awaiting_ack 快照入场 → 锁住 task 让 auto-approve 卡在 patchActionIfOwner →
    // stop revoke → 放行后条件写被拒、不落「已通过」。
    const id = alloc();
    await seedAwaitingAck(id);
    makeInstantAgent("agent_r23_1a");
    const taskSnap = (await getTask(id))!;
    expect(
      taskSnap.actions.find((a) => a.id === "act_ack")?.status,
    ).toBe("awaiting_ack");

    let releaseLock!: () => void;
    const lockGate = new Promise<void>((r) => {
      releaseLock = r;
    });
    let lockHeld = false;
    const holdP = withTaskLock(id, async () => {
      lockHeld = true;
      await lockGate;
    });
    await waitUntil(() => lockHeld);

    const eventsBefore = (await readEvents(id)).length;
    const pAdvance = advanceTask({
      task: taskSnap,
      actionType: "plan",
      userInstruction: "R23-1a 推进",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
    }).catch((err: unknown) => err);

    // advance 已进 pendingAck、卡在 patchActionIfOwner 等锁
    await sleep(80);

    const hangStop = installHangingFailpoint("stop.afterGate");
    const pStop = stopTaskAgent(taskSnap);
    await hangStop.waitHit();
    // 此时已 revoke + lifecycle=stopping；放行后 auto-approve 的 isOwner/结构条件必失败
    releaseLock();
    await holdP;

    hangStop.release();
    await pStop;
    await pAdvance;

    const fresh = await readMetaV06(id);
    expect(fresh?.actions.find((a) => a.id === "act_ack")?.status).toBe(
      "cancelled",
    );
    const events = await readEvents(id);
    expect(
      events.slice(eventsBefore).filter(
        (e) =>
          e.kind === "action_ack" &&
          e.actionId === "act_ack" &&
          String(e.text ?? "").includes("已通过"),
      ),
    ).toHaveLength(0);
  });

  it("R23-1b：claim 后 revoke → append 不落盘、无幽灵 action", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const hang = installHangingFailpoint("advance.afterClaim");

    const p = advanceTask({
      task: (await getTask(id))!,
      actionType: "plan",
      userInstruction: "R23-1b 幽灵",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
    }).catch((err: unknown) => err);

    await hang.waitHit();
    // claim 后、append 前 revoke（模拟 stop）
    revokeTaskOps(id);
    hang.release();

    const err = await p;
    expect(String((err as Error)?.message ?? err)).toContain(
      TASK_OP_STALE_HTTP_MESSAGE,
    );
    const fresh = await readMetaV06(id);
    expect(fresh?.actions ?? []).toHaveLength(0);
    expect(fresh?.runStatus).toBe("idle");
  });

  it("R23-1c：resume 两段写期间 stop → 不留 running 复活", async () => {
    const id = alloc();
    await seedSharedAction(id, "error");
    const hang = installHangingFailpoint("resume.beforeStatusWrite");

    const p = resumeCurrentActionWithMessage({
      task: (await getTask(id))!,
      userMessage: "R23-1c 唤醒",
      apiKey: CREDS.apiKey,
      fallbackModel: CREDS.fallbackModel,
    }).catch((err: unknown) => err);

    await hang.waitHit();
    await stopTaskAgent((await getTask(id))!);
    hang.release();

    const err = await p;
    expect(String((err as Error)?.message ?? err)).toMatch(
      new RegExp(`${TASK_OP_STALE_HTTP_MESSAGE}|正在停止|已被停止`),
    );
    const fresh = await readMetaV06(id);
    expect(fresh?.runStatus).toBe("idle");
    expect(fresh?.actions.find((a) => a.id === "act_shared")?.status).not.toBe(
      "running",
    );
  });

  it("R23-2：stale 方不补偿——B 复用同 action 不被打回 cancelled", async () => {
    // R24-8：旧用例用 isFresh=()=>true 手工模拟 B，绕过真实 ownership；
    // 改为 B 真 claim + 以 isTaskOpCurrent(handleB) 条件写 running；A 占 exclusive
    // 挂起时不能嵌套 resume（会死锁），但 claim/条件写不走 exclusive——放行后 A 走
    // abortIfTaskOpStale 抛错让位，不得把 B 打回 cancelled。
    const { patchActionAndRunStatusIfOpFresh } = await import(
      "@/lib/server/task-fs"
    );
    const id = alloc();
    await writeMeta(makeMeta(id));
    const hang = installHangingFailpoint("advance.afterAppend");

    const pA = advanceTask({
      task: (await getTask(id))!,
      actionType: "plan",
      userInstruction: "R23-2 A",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
    }).catch((err: unknown) => err);

    await hang.waitHit();
    const actionId = (await readMetaV06(id))!.actions[0]!.id;

    // stop 取消 A 刚 append 的 action + revoke
    await stopTaskAgent((await getTask(id))!);
    expect(
      (await readMetaV06(id))?.actions.find((a) => a.id === actionId)?.status,
    ).toBe("cancelled");

    // B 真 claim 换主，再用真实 owner 闭包写回 running
    const handleB = claimTaskOp(id, getTaskOpGeneration(id));
    expect(handleB).not.toBeNull();
    const bWrote = await patchActionAndRunStatusIfOpFresh(
      id,
      actionId,
      "running",
      "running",
      () => isTaskOpCurrent(handleB!),
      { currentActionId: actionId },
    );
    expect(bWrote).not.toBeNull();
    expect(isTaskOpCurrent(handleB!)).toBe(true);

    // 放行 A：stale → abortIfTaskOpStale 抛错让位，不得再补偿 patch cancelled
    hang.release();
    await pA;

    const fresh = await readMetaV06(id);
    expect(fresh?.actions.find((a) => a.id === actionId)?.status).toBe(
      "running",
    );
    expect(fresh?.runStatus).toBe("running");
    expect(isTaskOpCurrent(handleB!)).toBe(true);
    releaseTaskOpIf(handleB!);
  });

  it("R23-6：stop 用旧快照仍收尾 gate 后已 append 的 action（stop.afterGate）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    // 模拟 route 入场快照（尚无 action）
    const routeSnapshot = (await getTask(id))!;

    // route 快照后、stop 占 gate 前：B append 新 action
    const handleB = claimTaskOp(id, getTaskOpGeneration(id));
    expect(handleB).not.toBeNull();
    const created = await appendAction(
      id,
      { type: "plan", userInstruction: "R23-6 B append" },
      { guard: () => true },
    );
    expect(created).not.toBeNull();
    const actionId = created!.action.id;
    releaseTaskOpIf(handleB!);

    let sawAfterGate = false;
    setFailpoint("stop.afterGate", () => {
      sawAfterGate = true;
    });

    // stop 仍拿旧快照（actions=[]）——重读后应看到并 cancelled
    await stopTaskAgent(routeSnapshot);
    expect(sawAfterGate).toBe(true);

    const fresh = await readMetaV06(id);
    expect(fresh?.actions.find((a) => a.id === actionId)?.status).toBe(
      "cancelled",
    );
    expect(fresh?.runStatus).toBe("idle");
  });

  it("R23-7：finalize 期间 advance 拒绝 + repoStatus 终态拒推进", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    makeInstantAgent("agent_r23_7");

    // finalizing lifecycle 挡推进
    expect(beginChatLifecycle(id, "finalizing")).toBe(true);
    await expect(
      advanceTask({
        task: (await getTask(id))!,
        actionType: "plan",
        userInstruction: "R23-7 during finalize",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      }),
    ).rejects.toThrow(/终结|停止|变更|TASK_OP_STALE|正在/);
    endChatLifecycle(id, "finalizing");

    // repoStatus 终态拒推进（core 入口）
    const meta = (await readMetaV06(id))!;
    meta.repoStatus = "merged";
    await writeMeta(meta);
    await expect(
      advanceTask({
        task: (await getTask(id))!,
        actionType: "plan",
        userInstruction: "R23-7 merged",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      }),
    ).rejects.toThrow(/已合入/);

    meta.repoStatus = "abandoned";
    await writeMeta(meta);
    await expect(
      advanceTask({
        task: (await getTask(id))!,
        actionType: "plan",
        userInstruction: "R23-7 abandoned",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      }),
    ).rejects.toThrow(/已放弃/);

    // finalizeTask 本身占 finalizing（占得到才跑完）
    meta.repoStatus = "developing";
    await writeMeta(meta);
    await finalizeTask(id, "abandoned");
    expect((await readMetaV06(id))?.repoStatus).toBe("abandoned");
  });

  it("R23-8：reuse send 成功后 currentOpId 已释放", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const task = (await getTask(id))!;
    const send = vi.fn().mockResolvedValue({
      stream: async function* () {
        /* 空 */
      },
      wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    });
    const close = vi.fn();
    agentSessions.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agent: { agentId: "agent_r23_8", send, close } as never,
      agentId: "agent_r23_8",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title: task.title },
    });

    await advanceTask({
      task,
      actionType: "plan",
      userInstruction: "R23-8 reuse",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
      reuseAgent: true,
    });

    expect(send).toHaveBeenCalled();
    // I4：owner 号已释放（snapshot 的 opId 为 null）
    const snap = snapshotTaskOp(id);
    expect(snap.opId).toBeNull();
  });
});
