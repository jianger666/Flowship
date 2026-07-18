/**
 * Ownership failpoint 矩阵（ownership-refactor-2026-07-18）
 *
 * 面向设计文档 API 契约：claimTaskOp / snapshotTaskOp / isTaskOpCurrent /
 * releaseTaskOpIf / revokeTaskOps + 12 个固定插桩点名 + 不变量 I1～I5。
 * 核心重构并行落地前本文件预期编译不过——主线统一跑通后按下方「API 假设」核对漂移。
 *
 * 结构：
 *   1. failpoint × 注入动作矩阵（真实调用链 + setFailpoint，不预摆 token 直测 helper）
 *   2. R22-5 / R22-6 定向补充
 *   3. 新 API 协议层小用例
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-fp-"));
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

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
  claimTaskOp,
  clearTaskStarting,
  getTaskOpGeneration,
  isTaskOpCurrent,
  pendingStopRequests,
  releaseTaskOpIf,
  revokeTaskOps,
  runningTasks,
  snapshotTaskOp,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { getPendingAsk } = await import("@/lib/server/chat-pending");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const {
  advanceTask,
  deliverAskReply,
  handleRunFailure,
  resumeCurrentActionWithMessage,
  startOneShotQuestion,
} = await import("@/lib/server/task-runner");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-failpoint-matrix DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
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
    title: `ownership-fp ${id}`,
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

/** 共用 action 种子：resume / failure / consume 矩阵共用 */
const seedSharedRunningAction = async (
  id: string,
  status: "running" | "error" | "awaiting_user" = "running",
): Promise<void> => {
  const meta = makeMeta(id);
  meta.runStatus = status === "error" ? "error" : status;
  meta.currentActionId = "act_shared";
  meta.actions = [
    {
      id: "act_shared",
      n: 1,
      type: "plan",
      status: status === "awaiting_user" ? "running" : status,
      userInstruction: "",
      artifactPath: null,
      startedAt: Date.now(),
      endedAt: status === "running" || status === "awaiting_user" ? null : Date.now(),
    },
  ] as TaskMetaV06["actions"];
  await writeMeta(meta);
};

/**
 * create 挂起 gate——对齐 task-op-generation 的 makePendingCreateAgent。
 * 放行前 mockCreate 已入队、Agent.create 尚未 resolve。
 */
const makePendingCreateAgent = (agentId: string) => {
  let resolveCreate!: (agent: unknown) => void;
  const gate = new Promise((resolve) => {
    resolveCreate = resolve;
  });
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
  mockCreate.mockImplementation(() => gate.then(() => agent));
  return {
    releaseCreate: () => resolveCreate(agent),
    close,
    send,
    wait,
    cancel,
    agentId,
  };
};

/** 立即 resolve 的 agent（走完 create、靠 failpoint 卡后续节点） */
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

/** 挂起式 failpoint：命中后等 release，供「注入动作 → 放行」时序 */
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

const collectEnvelopes = (id: string) => {
  const envelopes: Array<{ kind: string; ok?: boolean }> = [];
  const unsub = subscribeTaskStream(id, (ev) => {
    if (ev.kind === "done" || ev.kind === "error") {
      envelopes.push({
        kind: ev.kind,
        ok: ev.kind === "done" ? ev.ok : undefined,
      });
    }
  });
  return { envelopes, unsub };
};

/**
 * I2 / I4：无「action running 且无活 runner 且 op 无人持有」僵尸；收敛后无人持有。
 * R24-8：旧 helper 用 claimTaskOp 探测「可 claim」会覆盖现 owner、掩盖泄漏——改为只读断言。
 */
const assertNoZombieAndClaimable = async (id: string): Promise<void> => {
  const fresh = await readMetaV06(id);
  const runningActions =
    fresh?.actions.filter((a) => a.status === "running") ?? [];
  if (runningActions.length > 0) {
    // 有 running action 则必须有活 runner 或仍持有 op（否则即 R22-1 僵尸）
    const op = snapshotTaskOp(id);
    const hasLiveRunner = runningTasks.has(id) || agentSessions.has(id);
    const hasOwner = op.kind === "owner" || op.opId !== null;
    expect(
      hasLiveRunner || (hasOwner && isTaskOpCurrent(op)),
      `I2 僵尸：action running 但无 runner/owner task=${id}`,
    ).toBe(true);
  }
  // I4：无活 runner/session 时必须无人持有（opId === null）；有 opId 即 owner 泄漏
  if (!runningTasks.has(id) && !agentSessions.has(id)) {
    const snap = snapshotTaskOp(id);
    expect(
      snap.opId,
      `I4 owner 泄漏：无活 runner 但 opId=${snap.opId} task=${id}`,
    ).toBeNull();
  }
};

describe("ownership failpoint 矩阵（I1～I5 / R22）", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_ofp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    // fire-and-forget 落盘避 ENOENT（同 task-op-generation）
    await sleep(30);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
    vi.mocked(getPendingAsk).mockReset();
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ─────────────────────────────────────────────────────────────
  // 第一部分：failpoint × 注入动作矩阵
  // ─────────────────────────────────────────────────────────────
  describe("矩阵：failpoint × 注入动作", () => {
    it("M1 advance.afterAppend × 抛错 → 新 action 不留 running、可再 claim（R22-1 advance / I2/I4）", async () => {
      // 旧实现：append 后抛错只回 400，action/token 永久 running 泄漏
      const id = alloc();
      await writeMeta(makeMeta(id));
      setFailpoint("advance.afterAppend", () => {
        throw new Error("failpoint 注入异常");
      });

      await expect(
        advanceTask({
          task: (await getTask(id))!,
          actionType: "plan",
          userInstruction: "M1 推进",
          apiKey: CREDS.apiKey,
          model: CREDS.model,
        }),
      ).rejects.toThrow(/failpoint 注入异常/);

      const fresh = await readMetaV06(id);
      // I2：新 append 的 action 不得留 running
      expect(
        fresh?.actions.filter((a) => a.status === "running"),
      ).toHaveLength(0);
      // I1/I2：task 不得卡在 running
      expect(fresh?.runStatus).not.toBe("running");
      expect(runningTasks.has(id)).toBe(false);
      // I4：op 无泄漏，后续 claim 可拿号
      await assertNoZombieAndClaimable(id);
    });

    it("M2 advance.beforeHandoff × 抛错 → 同 M1 收尾（R22-1 advance / I2/I4）", async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      // handoff 前仍需能过 create 前置——给一个立刻 resolve 的 create，抛点在 handoff
      makeInstantAgent("agent_m2");
      setFailpoint("advance.beforeHandoff", () => {
        throw new Error("failpoint 注入异常");
      });

      await expect(
        advanceTask({
          task: (await getTask(id))!,
          actionType: "plan",
          userInstruction: "M2 推进",
          apiKey: CREDS.apiKey,
          model: CREDS.model,
        }),
      ).rejects.toThrow(/failpoint 注入异常/);

      const fresh = await readMetaV06(id);
      expect(
        fresh?.actions.filter((a) => a.status === "running"),
      ).toHaveLength(0);
      expect(fresh?.runStatus).not.toBe("running");
      expect(runningTasks.has(id)).toBe(false);
      await assertNoZombieAndClaimable(id);
    });

    it("M3 resume.afterClaim × 抛错（首次状态写前）→ 共用 action 不坏、无僵尸（R22-1 resume / I1/I2/I4）", async () => {
      // 旧实现：claim 后、patch running 前抛 → token 泄漏 + 可能半截副作用
      const id = alloc();
      await seedSharedRunningAction(id, "error");
      setFailpoint("resume.afterClaim", () => {
        throw new Error("failpoint 注入异常");
      });

      await expect(
        resumeCurrentActionWithMessage({
          task: (await getTask(id))!,
          userMessage: "M3 唤醒",
          apiKey: CREDS.apiKey,
          fallbackModel: CREDS.fallbackModel,
        }),
      ).rejects.toThrow(/failpoint 注入异常/);

      const fresh = await readMetaV06(id);
      // I1：首次状态写之前抛——共用 action 不得被写坏成 running 后无人收
      expect(fresh?.actions.find((a) => a.id === "act_shared")?.status).not.toBe(
        "running",
      );
      expect(fresh?.runStatus).not.toBe("running");
      expect(runningTasks.has(id)).toBe(false);
      expect(agentSessions.has(id)).toBe(false);
      await assertNoZombieAndClaimable(id);
    });

    it("M4 resume.beforeStatusWrite × 抛错 → 同 M3（R22-1 resume / I1/I2/I4）", async () => {
      const id = alloc();
      await seedSharedRunningAction(id, "error");
      setFailpoint("resume.beforeStatusWrite", () => {
        throw new Error("failpoint 注入异常");
      });

      await expect(
        resumeCurrentActionWithMessage({
          task: (await getTask(id))!,
          userMessage: "M4 唤醒",
          apiKey: CREDS.apiKey,
          fallbackModel: CREDS.fallbackModel,
        }),
      ).rejects.toThrow(/failpoint 注入异常/);

      const fresh = await readMetaV06(id);
      expect(fresh?.actions.find((a) => a.id === "act_shared")?.status).not.toBe(
        "running",
      );
      expect(fresh?.runStatus).not.toBe("running");
      expect(runningTasks.has(id)).toBe(false);
      await assertNoZombieAndClaimable(id);
    });

    it("M5 failure.beforePrepare × stop → 放行后仍 cancelled+idle、无 task 级失败 envelope（R22-2 / I1/I5）", async () => {
      // 旧实现：stop 写 cancelled+idle 后，failure prepare 仍认 owner、盖成 error
      const id = alloc();
      await seedSharedRunningAction(id, "running");
      const handleA = claimTaskOp(id, getTaskOpGeneration(id));
      expect(handleA).not.toBeNull();

      const hang = installHangingFailpoint("failure.beforePrepare");
      const { envelopes, unsub } = collectEnvelopes(id);

      try {
        const pFail = handleRunFailure(
          id,
          "act_shared",
          new Error("mid-flight boom"),
          { opHandle: handleA! },
        );
        await hang.waitHit();

        // 挂起期间用户 stop 完成
        await stopTaskAgent((await getTask(id))!);
        expect((await readMetaV06(id))?.runStatus).toBe("idle");
        expect(
          (await readMetaV06(id))?.actions.find((a) => a.id === "act_shared")
            ?.status,
        ).toBe("cancelled");

        hang.release();
        await pFail;

        // I5 / I1：stop 终态不被迟到 error 覆盖
        const fresh = await readMetaV06(id);
        expect(fresh?.runStatus).toBe("idle");
        expect(
          fresh?.actions.find((a) => a.id === "act_shared")?.status,
        ).toBe("cancelled");
        // I3：无 task 级 done(false)/error envelope
        expect(envelopes.filter((e) => e.kind === "error")).toHaveLength(0);
        expect(
          envelopes.filter((e) => e.kind === "done" && e.ok === false),
        ).toHaveLength(0);
      } finally {
        unsub();
      }
    });

    it("M6 failure.beforePrepare × 同 action 接管 → 不提交 error、不 finalize 共享 action、无全局 envelope（R21-2/R22-3 / I3）", async () => {
      const id = alloc();
      await seedSharedRunningAction(id, "running");
      const handleA = claimTaskOp(id, getTaskOpGeneration(id));
      expect(handleA).not.toBeNull();

      let claimedB = false;
      setFailpoint("failure.beforePrepare", async () => {
        // B 在 prepare await 窗口 claim 换主（真实第二 claim，非预摆）
        const b = claimTaskOp(id, getTaskOpGeneration(id));
        expect(b).not.toBeNull();
        claimedB = true;
      });

      const { envelopes, unsub } = collectEnvelopes(id);
      try {
        await handleRunFailure(
          id,
          "act_shared",
          new Error("mid-flight boom"),
          { opHandle: handleA! },
        );

        expect(claimedB).toBe(true);
        expect(isTaskOpCurrent(handleA!)).toBe(false);

        const fresh = await readMetaV06(id);
        // I3：共享 action / task 未被 A 提交为 error
        expect(fresh?.runStatus).toBe("running");
        expect(
          fresh?.actions.find((a) => a.id === "act_shared")?.status,
        ).toBe("running");
        expect(envelopes).toHaveLength(0);
      } finally {
        unsub();
      }
    });

    it("M7 failure.beforePublish × 接管 → 无 task 级 done(false)/error envelope（R22-3 / I3）", async () => {
      // 旧实现：写盘成功后 getTask await 内换主，仍发全局失败 envelope
      const id = alloc();
      await seedSharedRunningAction(id, "running");
      const handleA = claimTaskOp(id, getTaskOpGeneration(id));
      expect(handleA).not.toBeNull();

      let claimedDuringPublish = false;
      setFailpoint("failure.beforePublish", async () => {
        const b = claimTaskOp(id, getTaskOpGeneration(id));
        expect(b).not.toBeNull();
        claimedDuringPublish = true;
      });

      const { envelopes, unsub } = collectEnvelopes(id);
      try {
        await handleRunFailure(
          id,
          "act_shared",
          new Error("publish-window boom"),
          { opHandle: handleA! },
        );

        expect(claimedDuringPublish).toBe(true);
        // I3：无论盘上 action 是否已被 A 写成 error，都不得发 task 级失败 envelope
        expect(envelopes.filter((e) => e.kind === "error")).toHaveLength(0);
        expect(
          envelopes.filter((e) => e.kind === "done" && e.ok === false),
        ).toHaveLength(0);
      } finally {
        unsub();
      }
    });

    it("M8 consume.beforeFinalize × 同 action resume 接管 → A 不追问、不标共享 error、B 保持 running（R22-4 / I3）", async () => {
      // 旧实现：同 actionId 时自然完成仍走追问/标错，伤 B
      const id = alloc();
      await seedSharedRunningAction(id, "running");

      const hang = installHangingFailpoint("consume.beforeFinalize");
      const close = vi.fn();
      const send = vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空 */
        },
        wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
        cancel: vi.fn().mockResolvedValue(undefined),
      });
      agentSessions.set(id, {
        instanceId: 1,
        agent: { agentId: "agent_m8_a", close, send } as never,
        agentId: "agent_m8_a",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: "m8" },
      });

      // B 的 create 挂起，便于断言 B 已 claim 且 running 保持
      const bAgent = makePendingCreateAgent("agent_m8_b");
      vi.mocked(getPendingAsk).mockReturnValue({
        askId: "ask_m8",
      } as never);

      const task = (await getTask(id))!;
      const pA = deliverAskReply(task, "答案 A", undefined, "act_shared");
      await hang.waitHit();
      const sendAfterA = send.mock.calls.length;

      // A 收尾前 B 同 action resume 接管（不 await 完成）
      const pB = resumeCurrentActionWithMessage({
        task: (await getTask(id))!,
        userMessage: "B 换模型唤醒",
        apiKey: CREDS.apiKey,
        fallbackModel: CREDS.fallbackModel,
      });
      // 等 B claim 副作用：盘上仍/再变 running
      await waitUntil(async () => {
        const m = await readMetaV06(id);
        return m?.runStatus === "running";
      });

      hang.release();
      await pA;
      // 放行 B 的 create，让链可 settle
      bAgent.releaseCreate();
      // R24-8：必须断言业务 Promise 先 settle
      await raceExpectSettled(pB, 2000);

      // I3：A 不得在失主后追问（send 次数不增加）
      expect(send.mock.calls.length).toBe(sendAfterA);
      const fresh = await readMetaV06(id);
      expect(fresh?.actions.find((a) => a.id === "act_shared")?.status).not.toBe(
        "error",
      );
      // B 的 running 状态保持（或至少不是被 A 打成 error/idle 的倒挂）
      expect(fresh?.runStatus).toBe("running");
      expect(fresh?.currentActionId).toBe("act_shared");
    });

    it("M9 start.afterCreate × stop → agent 被关、无状态污染（W 系 / I5/I4）", async () => {
      const id = alloc();
      await seedSharedRunningAction(id, "error");
      const { close, send } = makeInstantAgent("agent_m9");

      setFailpoint("start.afterCreate", async () => {
        await stopTaskAgent((await getTask(id))!);
      });

      // resume 走 create→afterCreate；stop 在 send/预登记前完成
      await resumeCurrentActionWithMessage({
        task: (await getTask(id))!,
        userMessage: "M9 唤醒后被停",
        apiKey: CREDS.apiKey,
        fallbackModel: CREDS.fallbackModel,
      }).catch(() => {
        // stop 可能导致链抛 stale / abort——允许
      });

      // R24-8：等待失败本身就要 fail，不得 .catch 吞掉后继续假绿
      await waitUntil(async () => {
        const m = await readMetaV06(id);
        // runStatus 无 cancelled——停止归位是 idle
        return m?.runStatus === "idle";
      });
      // Codex 第二十三轮点名的抖动：resume 返回 = handoff 完成，close 在 fire-and-forget
      // IIFE 的让位路径里异步发生——idle 只证明 stop 落盘、不证明 IIFE 已跑到 close。
      // 必须显式等 close 被调再断言，否则偶发「未等到 close」假失败。
      await waitUntil(() => close.mock.calls.length > 0);

      // I5：停止语义——agent 关、不 send、不留 running 污染
      expect(close).toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      const fresh = await readMetaV06(id);
      expect(fresh?.runStatus).not.toBe("running");
      expect(
        fresh?.actions.find((a) => a.id === "act_shared")?.status,
      ).not.toBe("running");
      expect(runningTasks.has(id)).toBe(false);
    });

    it("M10 start.afterSend × 同 action resume 接管 → 旧链 cancel 自己的 run、不预登记覆盖后继（I3/I4）", async () => {
      const id = alloc();
      await seedSharedRunningAction(id, "error");

      const cancelA = vi.fn().mockResolvedValue(undefined);
      const closeA = vi.fn();
      const sendA = vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空 */
        },
        wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
        cancel: cancelA,
      });
      mockCreate.mockResolvedValueOnce({
        agentId: "agent_m10_a",
        close: closeA,
        send: sendA,
      });

      let pB: Promise<void> | undefined;
      let bClaimed = false;
      // pA 在 handoff 后就 resolve（早于 afterSend）——必须等 failpoint 命中，不能只等 pA
      let afterSendHit = false;
      setFailpoint("start.afterSend", async () => {
        afterSendHit = true;
        // send resolve 后、预登记 runningTasks 前——B 同 action 接管
        const opIdBeforeB = snapshotTaskOp(id).opId;
        mockCreate.mockResolvedValueOnce({
          agentId: "agent_m10_b",
          close: vi.fn(),
          send: vi.fn().mockResolvedValue({
            stream: async function* () {
              /* 空 */
            },
            wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
            cancel: vi.fn().mockResolvedValue(undefined),
          }),
        });
        pB = resumeCurrentActionWithMessage({
          task: (await getTask(id))!,
          userMessage: "B 接管",
          apiKey: CREDS.apiKey,
          fallbackModel: CREDS.fallbackModel,
        });
        // B claim 换主 → currentOpId 变化（旧实现会在此处仍用 A 预登记盖表）
        await waitUntil(() => snapshotTaskOp(id).opId !== opIdBeforeB);
        bClaimed = true;
      });

      vi.mocked(getPendingAsk).mockReturnValue({ askId: "ask_m10" } as never);

      const pA = resumeCurrentActionWithMessage({
        task: (await getTask(id))!,
        userMessage: "A 先唤醒",
        apiKey: CREDS.apiKey,
        fallbackModel: CREDS.fallbackModel,
      });

      await waitUntil(() => afterSendHit);
      await waitUntil(() => bClaimed);
      // R24-8：必须断言业务 Promise 先 settle
      await raceExpectSettled(pA, 5000);
      expect(pB).toBeDefined();
      await raceExpectSettled(pB!, 3000);

      expect(bClaimed).toBe(true);
      // I3：A 应 cancel 自己的 run；不得留下 A 的 runningTasks 盖住 B
      // （若 A 在失主后仍预登记，runningTasks.agentId 会是 A——旧 bug）
      const runner = runningTasks.get(id);
      if (runner) {
        expect(runner.agentId).not.toBe("agent_m10_a");
      }
    });

    it("M11 consume.afterWait × stop → 停止语义收尾 cancelled、不标 error（I5）", async () => {
      const id = alloc();
      await seedSharedRunningAction(id, "running");

      setFailpoint("consume.afterWait", async () => {
        await stopTaskAgent((await getTask(id))!);
      });

      const close = vi.fn();
      const send = vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空 */
        },
        wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
        cancel: vi.fn().mockResolvedValue(undefined),
      });
      agentSessions.set(id, {
        instanceId: 1,
        agent: { agentId: "agent_m11", close, send } as never,
        agentId: "agent_m11",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: "m11" },
      });

      const result = await deliverAskReply(
        (await getTask(id))!,
        "答案",
        undefined,
        "act_shared",
      );
      expect(result === "sent" || result === "stale").toBe(true);

      await waitUntil(async () => {
        const m = await readMetaV06(id);
        return (
          m?.runStatus === "idle" &&
          m.actions.find((a) => a.id === "act_shared")?.status === "cancelled"
        );
      });

      const fresh = await readMetaV06(id);
      // I5：stop 终态
      expect(fresh?.runStatus).toBe("idle");
      expect(fresh?.actions.find((a) => a.id === "act_shared")?.status).toBe(
        "cancelled",
      );
      // 不得被自然完成路径改写成 error
      expect(fresh?.actions.find((a) => a.id === "act_shared")?.status).not.toBe(
        "error",
      );
      const events = await readEvents(id);
      // 停止路径允许 info；不应出现把停止伪装成失败的 task 级 error 收尾
      expect(
        events.filter(
          (e) =>
            e.kind === "error" &&
            typeof e.text === "string" &&
            e.text.includes("Task agent 失败"),
        ),
      ).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 第二部分：R22 定向补充
  // ─────────────────────────────────────────────────────────────
  describe("R22 定向补充", () => {
    it(
      "R22-5 advance 在 activeRun 空快照后暂停 → one-shot 预登记 → 放行后正式 action 仍能启动（I2）",
      async () => {
      // 旧实现：beforeHandoff 前 one-shot 写入 runningTasks → guard 早退吞掉正式启动
      // → action=running / task=idle / 无 formal agent 僵尸
      const id = alloc();
      await writeMeta(makeMeta(id));

      const hang = installHangingFailpoint("advance.beforeHandoff");

      // one-shot / formal 的 run.wait 都挂起——否则空 stream 瞬间收尾：
      // ① 测不到 runningTasks 窗口；② formal 未交卷追问会把刚启动的 action 标 error
      let releaseOneShotWait!: () => void;
      const oneShotWaitGate = new Promise<void>((r) => {
        releaseOneShotWait = r;
      });
      let releaseFormalWait!: () => void;
      const formalWaitGate = new Promise<void>((r) => {
        releaseFormalWait = r;
      });

      // 两阶段 create：one-shot 与 formal 各一次
      const agents: Array<{
        agentId: string;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
        cancel: ReturnType<typeof vi.fn>;
      }> = [];
      mockCreate.mockImplementation(() => {
        const isOneShot = agents.length === 0;
        // 前驱 cancel 时放行 one-shot wait，避免 internalStart 干等 5s 才 forceClear
        const cancel = vi.fn().mockImplementation(async () => {
          if (isOneShot) releaseOneShotWait();
        });
        const close = vi.fn();
        const wait = vi.fn().mockImplementation(async () => {
          await (isOneShot ? oneShotWaitGate : formalWaitGate);
          return { status: "finished" as const };
        });
        const send = vi.fn().mockResolvedValue({
          stream: async function* () {
            /* 空 */
          },
          wait,
          cancel,
        });
        const agent = {
          agentId: `agent_r225_${agents.length + 1}`,
          close,
          send,
          cancel,
        };
        agents.push(agent);
        return Promise.resolve(agent);
      });

      const pAdvance = advanceTask({
        task: (await getTask(id))!,
        actionType: "plan",
        userInstruction: "R22-5 正式推进",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      });
      await hang.waitHit();

      // 此时 advance 已 snapshot activeRun=空；期间 one-shot 完成预登记
      const createBeforeOneShot = mockCreate.mock.calls.length;
      startOneShotQuestion((await getTask(id))!, "临时问一句？", undefined, {
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      });
      await waitUntil(() => runningTasks.has(id));
      expect(mockCreate.mock.calls.length).toBeGreaterThan(createBeforeOneShot);
      const oneShotAgentId = runningTasks.get(id)?.agentId;

      hang.release();
      await pAdvance;

      // 正式链应再 create（或至少 cancel 前驱后登记 formal）
      await waitUntil(
        () =>
          mockCreate.mock.calls.length >= 2 ||
          (runningTasks.has(id) &&
            runningTasks.get(id)?.agentId !== oneShotAgentId),
      );

      const fresh = await readMetaV06(id);
      const latest = fresh?.actions[fresh.actions.length - 1];
      expect(latest?.status).toBe("running");
      expect(fresh?.runStatus).toBe("running");
      // I2：禁止「action running / task idle / 无 agent」僵尸组合
      const zombie =
        latest?.status === "running" &&
        fresh?.runStatus === "idle" &&
        !agentSessions.has(id) &&
        !runningTasks.has(id);
      expect(zombie).toBe(false);
      // predecessor 应被 cancel（one-shot 的 cancel 或 close）
      if (oneShotAgentId) {
        const oneShot = agents.find((a) => a.agentId === oneShotAgentId);
        expect(
          (oneShot?.cancel.mock.calls.length ?? 0) +
            (oneShot?.close.mock.calls.length ?? 0),
        ).toBeGreaterThan(0);
      }
      releaseOneShotWait();
      releaseFormalWait();
    },
    15_000,
    );

    it("R22-6 observer 快照门控：后继 claim / revoke 后 isTaskOpCurrent=false（route 语义见 ask-reply-zombie-r22-6）", async () => {
      // route 层「无断开 error」已由 tests/ask-reply-zombie-r22-6.test.ts 覆盖；
      // 此处钉 ownership 重构后僵尸兜底共用的 observer handle 契约（设计文档 claim 表）。
      const id = alloc();
      await seedSharedRunningAction(id, "awaiting_user");

      // 无 session + awaiting_user = 僵尸兜底入场条件；observer 不夺主
      const observer = snapshotTaskOp(id);
      expect(observer.kind).toBe("observer");
      expect(isTaskOpCurrent(observer)).toBe(true);

      // 并发 B 把盘上拉成 running（模拟后继接管）并 claim 换主
      const meta = (await readMetaV06(id))!;
      meta.runStatus = "running";
      meta.updatedAt = Date.now();
      await writeMeta(meta);
      const ownerB = claimTaskOp(id, getTaskOpGeneration(id));
      expect(ownerB).not.toBeNull();
      expect(ownerB!.kind).toBe("owner");

      // 僵尸分支迟到写的门控：observer 已失效
      expect(isTaskOpCurrent(observer)).toBe(false);
      expect(isTaskOpCurrent(ownerB!)).toBe(true);

      // revoke（stop/DELETE）同样作废 observer
      const id2 = alloc();
      await writeMeta(makeMeta(id2));
      const obs2 = snapshotTaskOp(id2);
      expect(isTaskOpCurrent(obs2)).toBe(true);
      const genBefore = getTaskOpGeneration(id2);
      revokeTaskOps(id2);
      expect(isTaskOpCurrent(obs2)).toBe(false);
      expect(getTaskOpGeneration(id2)).toBeGreaterThan(genBefore);

      // 补充：盘上已被写成 running 时，不得出现「Agent 已断开」类 error 事件
      // （本用例不走 route；仅保证种子场景本身无该文案，防测试污染误报）
      const events = await readEvents(id);
      expect(
        events.find(
          (e) =>
            e.kind === "error" &&
            typeof e.text === "string" &&
            e.text.includes("Agent 已断开"),
        ),
      ).toBeUndefined();
      expect((await readMetaV06(id))?.runStatus).toBe("running");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 第三部分：新 API 协议层
  // ─────────────────────────────────────────────────────────────
  describe("协议层：TaskOpHandle", () => {
    it("P1 claim 换主：A claim → B claim → isTaskOpCurrent(A)=false、B=true", async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      const gen = getTaskOpGeneration(id);
      const a = claimTaskOp(id, gen);
      expect(a).not.toBeNull();
      expect(a!.kind).toBe("owner");
      expect(isTaskOpCurrent(a!)).toBe(true);

      const b = claimTaskOp(id, getTaskOpGeneration(id));
      expect(b).not.toBeNull();
      expect(isTaskOpCurrent(a!)).toBe(false);
      expect(isTaskOpCurrent(b!)).toBe(true);
      expect(b!.opId).not.toBe(a!.opId);
    });

    it("P2 observer 不夺主：snapshot 后 A 仍 current；B claim 后 observer 失效", async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      const a = claimTaskOp(id, getTaskOpGeneration(id));
      expect(a).not.toBeNull();

      const observer = snapshotTaskOp(id);
      expect(observer.kind).toBe("observer");
      // 快照到在飞 owner 的 opId，但不夺主——A 仍是 current
      expect(isTaskOpCurrent(a!)).toBe(true);
      expect(observer.opId).toBe(a!.opId);

      const b = claimTaskOp(id, getTaskOpGeneration(id));
      expect(b).not.toBeNull();
      expect(isTaskOpCurrent(a!)).toBe(false);
      expect(isTaskOpCurrent(observer)).toBe(false);
      expect(isTaskOpCurrent(b!)).toBe(true);
    });

    it("P3 releaseTaskOpIf：observer release 是 no-op、不清 owner 的号", async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      const owner = claimTaskOp(id, getTaskOpGeneration(id));
      expect(owner).not.toBeNull();
      const observer = snapshotTaskOp(id);

      releaseTaskOpIf(observer);
      // observer 不得误删 owner
      expect(isTaskOpCurrent(owner!)).toBe(true);

      releaseTaskOpIf(owner!);
      expect(isTaskOpCurrent(owner!)).toBe(false);
      // 释放后无人持有——新 claim 应成功
      const next = claimTaskOp(id, getTaskOpGeneration(id));
      expect(next).not.toBeNull();
      releaseTaskOpIf(next!);
    });

    it("P5 observer null-opId ABA：快照时无人持有 → claim → release 清回 null → 快照仍失效", async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      // 无人持有时快照（ask-consume / one-shot 的常态入场）
      const observer = snapshotTaskOp(id);
      expect(observer.opId).toBeNull();
      expect(isTaskOpCurrent(observer)).toBe(true);

      // 期间一条启动链 claim 又正常 release（currentOpId 回到 null）
      const owner = claimTaskOp(id, getTaskOpGeneration(id));
      expect(owner).not.toBeNull();
      releaseTaskOpIf(owner!);

      // 只比 currentOpId 的旧实现这里会重新变 true（ABA、迟到写复活）——
      // claimSeq 判定必须让快照保持失效
      expect(isTaskOpCurrent(observer)).toBe(false);
    });

    it("P4 revokeTaskOps：bump 后旧 handle 全失效、gen 递增；旧 gen claim 返 null", async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      const owner = claimTaskOp(id, getTaskOpGeneration(id));
      const observer = snapshotTaskOp(id);
      expect(owner).not.toBeNull();
      const genAtClaim = owner!.gen;
      const genBeforeRevoke = getTaskOpGeneration(id);

      revokeTaskOps(id);

      expect(isTaskOpCurrent(owner!)).toBe(false);
      expect(isTaskOpCurrent(observer)).toBe(false);
      expect(getTaskOpGeneration(id)).toBeGreaterThan(genBeforeRevoke);

      // 用旧 admission gen claim → null（关闭「快照→claim」窗口）
      const stale = claimTaskOp(id, genAtClaim);
      expect(stale).toBeNull();

      // 用当前 gen 可再 claim
      const fresh = claimTaskOp(id, getTaskOpGeneration(id));
      expect(fresh).not.toBeNull();
      releaseTaskOpIf(fresh!);
    });
  });
});
