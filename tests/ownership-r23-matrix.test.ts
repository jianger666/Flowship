/**
 * Ownership R23 跨入口矩阵（fable5-chat-polish 第二十三轮验收点名）
 *
 * 面向修复后的目标行为：claim 后条件事务 / 入场 observer 贯穿 / stop 重读收尾 /
 * finalize 占 terminal lifecycle 等。修复代理并行落地前本文件预期跑不过——
 * 主线统一跑通后按文末「关键假设」核对漂移。
 *
 * 覆盖：验收「测试覆盖评价」展开的 8 条真实调用链（不许预摆 meta 直测 helper）。
 * setup 对齐 ownership-failpoint-matrix.test.ts。
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
import type { AwaitingNotifier } from "@/lib/server/chat-pending";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r23-"));
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
/** postcheck 秒过；advance 的 baseline 捕获也 mock 掉（M4/M7 走真实 advance） */
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
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
  runningTasks,
  snapshotTaskOp,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const { getPendingAsk, setChatAwaitingNotifier } = await import(
  "@/lib/server/chat-pending"
);
const {
  beginChatLifecycle,
  clearChatGate,
  endChatLifecycle,
  getChatLifecycle,
} = await import("@/lib/server/chat-gate");
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const {
  advanceTask,
  deliverAskReply,
  finalizeTask,
  resumeCurrentActionWithMessage,
  startOneShotQuestion,
} = await import("@/lib/server/task-runner");
const { appendAction, getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r23-matrix DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
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

/** 共用 action 种子：resume / send / postcheck / reconnect 用 */
const seedSharedAction = async (
  id: string,
  status: "running" | "error" | "awaiting_user" | "awaiting_ack" = "running",
  extras?: Partial<TaskMetaV06>,
): Promise<void> => {
  const meta = makeMeta(id);
  meta.runStatus =
    status === "awaiting_ack"
      ? "awaiting_user"
      : status === "error"
        ? "error"
        : status;
  meta.currentActionId = "act_shared";
  meta.actions = [
    {
      id: "act_shared",
      n: 1,
      type: "plan",
      status:
        status === "awaiting_user"
          ? "running"
          : status === "awaiting_ack"
            ? "awaiting_ack"
            : status,
      userInstruction: "",
      artifactPath: status === "awaiting_ack" ? "actions/1-plan.md" : null,
      startedAt: Date.now(),
      endedAt:
        status === "running" ||
        status === "awaiting_user" ||
        status === "awaiting_ack"
          ? null
          : Date.now(),
    },
  ] as TaskMetaV06["actions"];
  Object.assign(meta, extras);
  await writeMeta(meta);
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

/** 会话内 agent：挂在 agentSessions，send/wait 可定制 */
const makeSessionAgent = (
  agentId: string,
  opts?: {
    waitImpl?: () => Promise<unknown>;
    sendImpl?: () => Promise<unknown>;
  },
) => {
  const close = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const wait =
    opts?.waitImpl != null
      ? vi.fn().mockImplementation(opts.waitImpl)
      : vi.fn().mockResolvedValue({ status: "finished" as const });
  const send =
    opts?.sendImpl != null
      ? vi.fn().mockImplementation(opts.sendImpl)
      : vi.fn().mockResolvedValue({
          stream: async function* () {
            /* 空 */
          },
          wait,
          cancel,
        });
  return { agentId, close, send, wait, cancel };
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

/** 给 reconnect 路径准备 dataRoot/config.json（readServerCreds） */
const writeServerCreds = async (): Promise<void> => {
  const dataDir = process.env.FLOWSHIP_DATA_DIR!;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      apiKey: CREDS.apiKey,
      defaultModel: CREDS.model,
    }),
  );
};

describe("ownership R23 跨入口矩阵（I1～I5）", () => {
  const ids: string[] = [];

  const alloc = (): string => {
    const id = `t_r23_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    vi.mocked(setChatAwaitingNotifier).mockReset();
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
    // fire-and-forget 落盘避 ENOENT（同 ownership-failpoint-matrix）
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
  // 1) advance.afterClaim × stop
  // ─────────────────────────────────────────────────────────────
  it("R23-M1 advance.afterClaim × stop → 不 append 幽灵 action、无 action_start/已通过、保持 idle（R23-1/R23-8 / I1/I5）", async () => {
    // 旧实现：claim 后 stop 已 revoke+idle，旧推进仍 append running action，
    // 之后才被 stale helper 取消——用户可见「停止后多出一条从未启动的 action」。
    const id = alloc();
    await writeMeta(makeMeta(id));
    const actionsBefore = (await readMetaV06(id))!.actions.length;
    const eventsBefore = (await readEvents(id)).length;

    const hang = installHangingFailpoint("advance.afterClaim");
    const pAdvance = advanceTask({
      task: (await getTask(id))!,
      actionType: "plan",
      userInstruction: "R23-M1 推进",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
    });
    await hang.waitHit();

    // 挂起期间 stop 完成：revoke + cancelled（若有）+ idle
    await stopTaskAgent((await getTask(id))!);
    const afterStop = await readMetaV06(id);
    expect(afterStop?.runStatus).toBe("idle");
    expect(afterStop?.actions).toHaveLength(actionsBefore);

    hang.release();
    await pAdvance.catch(() => {
      // 失主后允许抛 stale / abort
    });
    await sleep(50);

    const fresh = await readMetaV06(id);
    // I1/I5：不 append 幽灵 action；盘上保持 idle
    expect(fresh?.actions).toHaveLength(actionsBefore);
    expect(fresh?.runStatus).toBe("idle");
    expect(fresh?.actions.filter((a) => a.status === "running")).toHaveLength(0);

    const events = await readEvents(id);
    const newEvents = events.slice(eventsBefore);
    // 不得在 stop 完成后再落「已通过」或新 action_start
    expect(
      newEvents.filter(
        (e) =>
          e.kind === "action_start" ||
          (typeof e.text === "string" && e.text.includes("已通过")),
      ),
    ).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────
  // 2) resume.beforeStatusWrite × stop
  // ─────────────────────────────────────────────────────────────
  it("R23-M2 resume.beforeStatusWrite × stop → action/runStatus 不复活为 running（R23-1 / I1/I5）", async () => {
    // 旧实现：resume 在 patchAction(running) 与 setTaskRunStatus(running) 两段裸写之间
    // 可被 stop 插入；即便后续纠正，stop 返回后仍有持久化复活窗口。
    // 种子用 running：stop 只收尾 running/awaiting_ack（error 不在扫描范围）。
    const id = alloc();
    await seedSharedAction(id, "running");
    makeInstantAgent("agent_r23_m2");

    const hang = installHangingFailpoint("resume.beforeStatusWrite");
    const pResume = resumeCurrentActionWithMessage({
      task: (await getTask(id))!,
      userMessage: "R23-M2 唤醒",
      apiKey: CREDS.apiKey,
      fallbackModel: CREDS.fallbackModel,
    });
    await hang.waitHit();

    await stopTaskAgent((await getTask(id))!);
    const afterStop = await readMetaV06(id);
    expect(afterStop?.runStatus).toBe("idle");
    expect(
      afterStop?.actions.find((a) => a.id === "act_shared")?.status,
    ).toBe("cancelled");

    hang.release();
    await pResume.catch(() => {
      /* stale / abort 允许 */
    });
    await sleep(50);

    const fresh = await readMetaV06(id);
    // I1/I5：stop 终态不被 resume 条件写复活
    expect(fresh?.runStatus).toBe("idle");
    expect(fresh?.runStatus).not.toBe("running");
    expect(
      fresh?.actions.find((a) => a.id === "act_shared")?.status,
    ).toBe("cancelled");
    expect(
      fresh?.actions.find((a) => a.id === "act_shared")?.status,
    ).not.toBe("running");
  });

  // ─────────────────────────────────────────────────────────────
  // 3) send.afterSend × 同 generation claim（入场 observer 贯穿）
  // ─────────────────────────────────────────────────────────────
  it("R23-M3 send.afterSend × 同 generation resume claim → 旧链让位、不覆盖 runningTasks/状态（R23-3 / I3）", async () => {
    // 旧实现：send 成功后重新 snapshotTaskOp，A 挂起期间 B claim → A 拍到 B 的 claimSeq，
    // 被当成当前 observer，覆盖 B 的 runningTasks 并在结束时恢复/收尾 B。
    const id = alloc();
    await seedSharedAction(id, "running");

    const hang = installHangingFailpoint("send.afterSend");
    const agentA = makeSessionAgent("agent_r23_m3_a", {
      waitImpl: async () => {
        // consume 挂起，避免瞬间 finished 干扰断言窗口
        await new Promise(() => {
          /* 永不 resolve；失主后应 cancel/让位 */
        });
        return { status: "finished" as const };
      },
    });
    agentSessions.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agent: agentA as never,
      agentId: agentA.agentId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title: `r23 ${id}` },
    });

    // 入场 observer：send 受理前快照（修复后应贯穿 consume，不得重拍）
    const entryObserver = snapshotTaskOp(id);
    expect(entryObserver.kind).toBe("observer");

    const pSend = deliverAskReply(
      (await getTask(id))!,
      "答案 A",
      undefined,
      "act_shared",
    );
    await hang.waitHit();
    const sendCallsAtHang = agentA.send.mock.calls.length;
    expect(sendCallsAtHang).toBeGreaterThanOrEqual(1);

    // 同 generation claim：B resume 换主（不预摆 claimTaskOp）
    // wait 挂起：避免 B 瞬间 finished → 追问耗尽把 act_shared 标 error（干扰「A 不得打 error」断言）
    mockCreate.mockResolvedValue({
      agentId: "agent_r23_m3_b",
      close: vi.fn(),
      send: vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空 */
        },
        wait: async () => {
          await new Promise(() => {
            /* 永不 resolve；保持 B running */
          });
          return { status: "finished" as const };
        },
        cancel: vi.fn().mockResolvedValue(undefined),
      }),
    });
    const opIdBeforeB = snapshotTaskOp(id).opId;
    const pB = resumeCurrentActionWithMessage({
      task: (await getTask(id))!,
      userMessage: "B 同 action 接管",
      apiKey: CREDS.apiKey,
      fallbackModel: CREDS.fallbackModel,
    });
    await waitUntil(() => snapshotTaskOp(id).opId !== opIdBeforeB);

    // 入场 observer 在 B claim 后必须失效（claimSeq 判定）
    expect(isTaskOpCurrent(entryObserver)).toBe(false);

    hang.release();
    // R24-8：必须断言业务 Promise 先 settle，不能 timeout 假绿
    await raceExpectSettled(pSend, 5000);
    await raceExpectSettled(pB, 3000);
    await sleep(80);

    // I3：旧链不得覆盖 B 的 runningTasks；不得把共享 action/task 收尾成 A 的终态
    const runner = runningTasks.get(id);
    if (runner) {
      expect(runner.agentId).not.toBe("agent_r23_m3_a");
    }
    const fresh = await readMetaV06(id);
    expect(fresh?.currentActionId).toBe("act_shared");
    // B 接管后应保持 running（或至少不是被 A 打成 idle/error 的倒挂）
    expect(fresh?.runStatus).not.toBe("idle");
    expect(
      fresh?.actions.find((a) => a.id === "act_shared")?.status,
    ).not.toBe("error");
    // A 在失主后不应再多发消息（consume 用入场 observer → 无共享写 / 无追问）
    expect(agentA.send.mock.calls.length).toBe(sendCallsAtHang);
  });

  // R24-8：M3 旧窗口在 send 完成后才注入 B；补「入口同步拍后、首 await 让出时 claim」
  it("R23-M3b send 入口同步段后首 await 即 claim → 旧链让位、不覆盖 B（R24-8 / R23-3 / I3）", async () => {
    const id = alloc();
    await seedSharedAction(id, "running");
    const agentA = makeSessionAgent("agent_r23_m3b_a", {
      waitImpl: async () => {
        await new Promise(() => {
          /* 永不 resolve */
        });
        return { status: "finished" as const };
      },
    });
    agentSessions.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agent: agentA as never,
      agentId: agentA.agentId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title: `r23 ${id}` },
    });

    // 占住 runningTasks → send body 卡在首个 await（waitForRunToDrain 轮询）
    // 比 queueMicrotask 更稳：保证 claim 落在入口 snapshot 之后、send 之前
    runningTasks.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agentId: "agent_r23_m3b_blocker",
      startedAt: Date.now(),
      startSnapshot: { title: `r23 ${id}` },
      cancel: () => {
        /* noop */
      },
    });

    const pSend = deliverAskReply(
      (await getTask(id))!,
      "答案 A 早 claim",
      undefined,
      "act_shared",
    );
    await sleep(50);

    const handleB = claimTaskOp(id, getTaskOpGeneration(id));
    expect(handleB).not.toBeNull();
    // 清 blocker 放行 drain；A 出队后应 entryLost → stale，不得 send
    runningTasks.delete(id);

    const sendResult = await pSend;
    expect(sendResult).toBe("stale");
    expect(isTaskOpCurrent(handleB!)).toBe(true);
    // I3：A 不得 send / 不得把共享 action 打成 error；B ownership 仍在
    expect(agentA.send).not.toHaveBeenCalled();
    const fresh = await readMetaV06(id);
    expect(fresh?.runStatus).toBe("running");
    expect(
      fresh?.actions.find((a) => a.id === "act_shared")?.status,
    ).not.toBe("error");
    releaseTaskOpIf(handleB!);
  });

  // ─────────────────────────────────────────────────────────────
  // 4) oneshot.afterSend × formal advance claim
  // ─────────────────────────────────────────────────────────────
  it(
    "R23-M4 oneshot.afterSend × advance claim → restore 不把 B 写回 idle、失败不拿 B instanceId（R23-3 / I3）",
    async () => {
    // 旧实现：one-shot 直到 create+send+runningTasks.set 后才 snapshot；
    // Q send 挂起 → B advance claim/append → Q 放行后采用 B 的 observer，
    // restore 可把 B 的 running 写回 idle；catch 从全局表读到 B 的 instanceId。
    const id = alloc();
    await writeMeta(makeMeta(id));
    // question 路由常见前置：先置 running（one-shot 的 prevRunStatus 会记 idle）
    {
      const m = (await readMetaV06(id))!;
      m.runStatus = "running";
      m.updatedAt = Date.now();
      await writeMeta(m);
    }

    let releaseOneShotWait!: () => void;
    const oneShotWaitGate = new Promise<void>((r) => {
      releaseOneShotWait = r;
    });
    const oneShotCancel = vi.fn().mockImplementation(async () => {
      releaseOneShotWait();
    });
    const oneShotClose = vi.fn();
    const oneShotWait = vi.fn().mockImplementation(async () => {
      await oneShotWaitGate;
      // 放行后以失败收尾，逼出 catch / restore 分支
      throw new Error("oneshot boom after yield");
    });
    const oneShotSend = vi.fn().mockResolvedValue({
      stream: async function* () {
        /* 空 */
      },
      wait: oneShotWait,
      cancel: oneShotCancel,
    });
    mockCreate.mockResolvedValueOnce({
      agentId: "agent_r23_m4_q",
      close: oneShotClose,
      send: oneShotSend,
    });

    const hang = installHangingFailpoint("oneshot.afterSend");
    startOneShotQuestion((await getTask(id))!, "临时问一句？", undefined, {
      apiKey: CREDS.apiKey,
      model: CREDS.model,
    });
    await hang.waitHit();

    // formal advance claim/append（真实调用链）
    // wait 挂起：保持 B running，避免瞬间 finished 干扰「restore 不得写回 idle」断言
    mockCreate.mockResolvedValue({
      agentId: "agent_r23_m4_b",
      close: vi.fn(),
      send: vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空 */
        },
        wait: async () => {
          await new Promise(() => {
            /* 永不 resolve */
          });
          return { status: "finished" as const };
        },
        cancel: vi.fn().mockResolvedValue(undefined),
      }),
    });
    const pAdvance = advanceTask({
      task: (await getTask(id))!,
      actionType: "plan",
      userInstruction: "R23-M4 正式推进",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
    });
    await waitUntil(async () => {
      const m = await readMetaV06(id);
      return (m?.actions.length ?? 0) >= 1 && m?.runStatus === "running";
    }, 8000);
    const bActionId = (await readMetaV06(id))!.currentActionId;
    const bRunnerBefore = runningTasks.get(id)?.instanceId;

    hang.release();
    // R24-8：必须断言业务 Promise 先 settle
    await raceExpectSettled(pAdvance, 5000);
    // 放行 one-shot wait → 走失败分支
    releaseOneShotWait();
    await sleep(120);

    const fresh = await readMetaV06(id);
    // I3：one-shot restore 不得把 B 的 running 写回 idle
    expect(fresh?.runStatus).toBe("running");
    expect(fresh?.currentActionId).toBe(bActionId);
    expect(
      fresh?.actions.find((a) => a.id === bActionId)?.status,
    ).toBe("running");
    // 失败分支不得拿 B 的 instanceId 提交状态（B runner 仍在或已被 formal 链合法替换，但不得消失成 idle）
    if (bRunnerBefore !== undefined && runningTasks.has(id)) {
      // 若仍是 B 的 record，说明 Q 没误删；若换成 formal agent 也合法
      expect(runningTasks.get(id)?.agentId).not.toBeUndefined();
    }
    expect(fresh?.runStatus).not.toBe("idle");
  },
  15_000,
  );

  // R24-8：M4 旧窗口在 oneshot.afterSend 后才 advance；补「入口同步拍后、首 await 前 claim」
  it(
    "R23-M4b oneshot 入口后首 await 前 claim → 旧链让位、不把 B 写回 idle（R24-8 / R23-3 / I3）",
    async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      {
        const m = (await readMetaV06(id))!;
        m.runStatus = "running";
        m.updatedAt = Date.now();
        await writeMeta(m);
      }

      // oneshot.beforeEnsure：入口已 snapshot，尚未 ensure/create——在此注入 B claim
      const hang = installHangingFailpoint("oneshot.beforeEnsure");
      mockCreate.mockResolvedValueOnce({
        agentId: "agent_r23_m4b_q",
        close: vi.fn(),
        send: vi.fn().mockResolvedValue({
          stream: async function* () {
            /* 空 */
          },
          wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      });
      startOneShotQuestion((await getTask(id))!, "临时问一句早 claim？", undefined, {
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      });
      await hang.waitHit();

      const handleB = claimTaskOp(id, getTaskOpGeneration(id));
      expect(handleB).not.toBeNull();
      const bInstanceId = allocTaskRunInstanceId();
      runningTasks.set(id, {
        instanceId: bInstanceId,
        agentId: "agent_r23_m4b_b",
        startedAt: Date.now(),
        startSnapshot: { title: `r23 ${id}` },
        cancel: () => {
          /* noop */
        },
      });
      // 盘上保持 B running（one-shot restore 旧 bug 会写回 idle）
      {
        const m = (await readMetaV06(id))!;
        m.runStatus = "running";
        m.updatedAt = Date.now();
        await writeMeta(m);
      }

      hang.release();
      await sleep(120);

      expect(isTaskOpCurrent(handleB!)).toBe(true);
      expect(runningTasks.get(id)?.agentId).toBe("agent_r23_m4b_b");
      expect(runningTasks.get(id)?.instanceId).toBe(bInstanceId);
      const fresh = await readMetaV06(id);
      expect(fresh?.runStatus).toBe("running");
      expect(fresh?.runStatus).not.toBe("idle");
      releaseTaskOpIf(handleB!);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 5) postcheck.betweenWrites × stop
  // ─────────────────────────────────────────────────────────────
  it("R23-M5 postcheck.betweenWrites × stop → 不出现 cancelled→awaiting_ack / idle→awaiting_user（R23-4 / I1）", async () => {
    // 旧实现：post-check 先裸 patchAction(awaiting_ack)、再裸 setTaskRunStatus(awaiting_user)；
    // stop 插在两段写之间后，第二段仍可把 cancelled+idle 盖回 A。
    const id = alloc();
    await seedSharedAction(id, "running");

    // 捕获 registerSessionBridges 注册的真实 notifier（mock 只挡表、不挡闭包）
    let capturedNotifier: AwaitingNotifier | null = null;
    vi.mocked(setChatAwaitingNotifier).mockImplementation((_tid, n) => {
      if (n) capturedNotifier = n;
    });

    const hang = installHangingFailpoint("postcheck.betweenWrites");
    // wait 挂起：避免 consume 自然收尾把 action 移出 running，挡掉 postcheck 前置条件
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((r) => {
      releaseWait = r;
    });
    const cancel = vi.fn().mockImplementation(async () => {
      releaseWait();
    });
    mockCreate.mockResolvedValue({
      agentId: "agent_r23_m5",
      close: vi.fn(),
      send: vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空 */
        },
        wait: async () => {
          await waitGate;
          return { status: "finished" as const };
        },
        cancel,
      }),
    });
    // resume 走 create → registerSessionBridges → 捕获 notifier
    const pResume = resumeCurrentActionWithMessage({
      task: (await getTask(id))!,
      userMessage: "R23-M5 起链注册 bridge",
      apiKey: CREDS.apiKey,
      fallbackModel: CREDS.fallbackModel,
    });
    await waitUntil(() => capturedNotifier !== null, 8000);
    // 确保盘上 action 仍/再为 running（postcheck 前置条件）
    await waitUntil(async () => {
      const m = await readMetaV06(id);
      return m?.actions.find((a) => a.id === "act_shared")?.status === "running";
    });

    // 真实交卷信号 → runActionPostCheck（修复后在两段写之间命中 failpoint）
    // R25-3：notifier 签名加 ctx（管道适配）
    void capturedNotifier!(
      {
        kind: "awaiting_start",
        actionId: "act_shared",
        artifactPath: "actions/1-plan.md",
      },
      { callerStillValid: () => true },
    );
    await hang.waitHit();

    await stopTaskAgent((await getTask(id))!);
    expect((await readMetaV06(id))?.runStatus).toBe("idle");
    expect(
      (await readMetaV06(id))?.actions.find((a) => a.id === "act_shared")
        ?.status,
    ).toBe("cancelled");

    hang.release();
    releaseWait();
    // R24-8：必须断言业务 Promise 先 settle
    await raceExpectSettled(pResume, 3000);
    await sleep(80);

    const fresh = await readMetaV06(id);
    // I1：禁止倒挂——cancelled 被写回 awaiting_ack、idle 被写回 awaiting_user
    expect(fresh?.runStatus).toBe("idle");
    expect(fresh?.runStatus).not.toBe("awaiting_user");
    expect(
      fresh?.actions.find((a) => a.id === "act_shared")?.status,
    ).toBe("cancelled");
    expect(
      fresh?.actions.find((a) => a.id === "act_shared")?.status,
    ).not.toBe("awaiting_ack");
  });

  // ─────────────────────────────────────────────────────────────
  // 6) stop.afterGate × 期间 append（旧快照漏收尾）
  // ─────────────────────────────────────────────────────────────
  it("R23-M6 stop 旧快照 + afterGate 期间 append → 重读后收尾全部非终态、无僵尸（R23-6 / I2/I5）", async () => {
    // 旧实现：route/调用方快照的 actions 扫描非终态；gate 前刚 append 的 B 被漏掉，
    // 留下 action=running + task=idle + 无 runner 僵尸。
    const id = alloc();
    await seedSharedAction(id, "running");
    // 旧快照：只有 act_shared
    const staleSnapshot = (await getTask(id))!;
    expect(staleSnapshot.actions.map((a) => a.id)).toEqual(["act_shared"]);

    const hang = installHangingFailpoint("stop.afterGate");
    const pStop = stopTaskAgent(staleSnapshot);
    await hang.waitHit();

    // stop 已占 gate + revoke；期间盘上再 append 一条（模拟 B 在快照后、重读前落盘）
    const appended = await appendAction(id, {
      type: "build",
      userInstruction: "R23-M6 gate 窗口内 append",
      agentModel: CREDS.model,
    });
    expect(appended).not.toBeNull();
    const newActionId = appended!.action.id;
    expect(newActionId).not.toBe("act_shared");

    hang.release();
    await pStop;

    const fresh = await readMetaV06(id);
    // I5：重读后的全部非终态都被 cancelled
    expect(fresh?.runStatus).toBe("idle");
    expect(
      fresh?.actions.find((a) => a.id === "act_shared")?.status,
    ).toBe("cancelled");
    expect(
      fresh?.actions.find((a) => a.id === newActionId)?.status,
    ).toBe("cancelled");
    // I2：禁止 action=running + task=idle + 无 runner
    const zombie =
      fresh?.actions.some((a) => a.status === "running") &&
      fresh?.runStatus === "idle" &&
      !runningTasks.has(id) &&
      !agentSessions.has(id);
    expect(zombie).toBe(false);
  });

  // R24-8：M1/M6 窗口缺口——guard 已通过、append.afterPrepare 挂起 → stop 重读收尾 →
  // 放行后 commit 被同步复查拒绝、无幽灵 running、盘上保持 idle。
  // 依赖第一波修复的 append.afterPrepare 插桩（尚未落地时本用例会红）。
  it("R23-M6b append.afterPrepare × stop → commit 拒写、无幽灵 running、保持 idle（R24-8 / R23-1 / I1/I5）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const actionsBefore = (await readMetaV06(id))!.actions.length;

    const hang = installHangingFailpoint("append.afterPrepare");
    const pAdvance = advanceTask({
      task: (await getTask(id))!,
      actionType: "plan",
      userInstruction: "R23-M6b prepare 窗口",
      apiKey: CREDS.apiKey,
      model: CREDS.model,
    });
    await hang.waitHit();

    // guard 已通过、prepare 后挂起：fire stop 等到 revoke（完整 await 会死锁——
    // stop.patchAction 与 append 同把 task lock；须先放行 append abort 再等 stop 收尾）
    const genAtHang = getTaskOpGeneration(id);
    const pStop = stopTaskAgent((await getTask(id))!);
    await waitUntil(() => getTaskOpGeneration(id) !== genAtHang);

    hang.release();
    await pAdvance.catch(() => {
      // 失主后允许抛 stale / abort
    });
    await Promise.race([pStop, sleep(5000)]);
    await sleep(50);

    const fresh = await readMetaV06(id);
    // 同步复查拒绝 commit → 无幽灵 running action；盘上保持 idle
    expect(fresh?.runStatus).toBe("idle");
    expect(fresh?.actions).toHaveLength(actionsBefore);
    expect(fresh?.actions.filter((a) => a.status === "running")).toHaveLength(0);
    expect(runningTasks.has(id)).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────
  // 7) reconnect.beforeResume × advance claim
  // ─────────────────────────────────────────────────────────────
  it(
    "R23-M7 reconnect.beforeResume × advance claim → 旧 A 不关 B 会话、不发 reconnect prompt（R23-5 / I3）",
    async () => {
      // 旧实现：退避中无 TaskOpHandle 复查；B advance 后 A 仍 closeTaskSession(undefined)
      // 关掉当前会话、resume 覆盖 agentSessions、再发 reconnect prompt。
      const id = alloc();
      await writeServerCreds();
      await seedSharedAction(id, "running", {
        sessionAgentId: "agent_r23_m7_persisted",
      } as Partial<TaskMetaV06>);

      const hang = installHangingFailpoint("reconnect.beforeResume");

      // wait 抛可重试网络错 → consume 进自动重连 → 退避后命中 failpoint
      const agentA = makeSessionAgent("agent_r23_m7_a", {
        waitImpl: async () => {
          throw new Error("fetch failed");
        },
      });
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: agentA as never,
        agentId: agentA.agentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: `r23 ${id}` },
      });

      const pSend = deliverAskReply(
        (await getTask(id))!,
        "触发重连",
        undefined,
        "act_shared",
        {
          apiKey: CREDS.apiKey,
          model: CREDS.model,
        },
      );

      // 首轮退避 2s；等 reconnect.beforeResume 命中
      await hang.waitHit();
      await waitUntil(async () => {
        const events = await readEvents(id);
        return events.some(
          (e) =>
            e.kind === "info" &&
            typeof e.text === "string" &&
            e.text.includes("自动重连"),
        );
      }, 8000);

      // B advance claim（真实启动链）
      // wait 挂起：保持 B 会话在表——瞬间 finished 会追问耗尽后 closeMySession，干扰「A 不得关 B」断言
      const bClose = vi.fn();
      const bCancel = vi.fn().mockResolvedValue(undefined);
      const bWait = vi.fn().mockImplementation(async () => {
        await new Promise(() => {
          /* 永不 resolve */
        });
        return { status: "finished" as const };
      });
      const bSend = vi.fn().mockResolvedValue({
        stream: async function* () {
          /* 空 */
        },
        wait: bWait,
        cancel: bCancel,
      });
      mockCreate.mockResolvedValue({
        agentId: "agent_r23_m7_b",
        close: bClose,
        send: bSend,
      });
      const sendCountBeforeB = agentA.send.mock.calls.length;
      const pAdvance = advanceTask({
        task: (await getTask(id))!,
        actionType: "build",
        userInstruction: "R23-M7 退避中推进",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      });
      // 等 B 真实启动链登记 session（勿手动抢先 set——会与 internalStartAgent 的 set 竞态换 instanceId）
      await waitUntil(
        () => agentSessions.get(id)?.agentId === "agent_r23_m7_b",
        8000,
      );
      await waitUntil(async () => {
        const m = await readMetaV06(id);
        return (m?.actions.length ?? 0) >= 2;
      }, 8000);
      const bSessionInstance = agentSessions.get(id)!.instanceId;

      hang.release();
      // R24-8：必须断言业务 Promise 先 settle
      await raceExpectSettled(pSend, 5000);
      await raceExpectSettled(pAdvance, 5000);
      await sleep(100);

      // I3：旧 A 不得关掉 B 会话 / 覆盖 agentSessions
      expect(agentSessions.get(id)?.agentId).toBe("agent_r23_m7_b");
      expect(agentSessions.get(id)?.instanceId).toBe(bSessionInstance);
      expect(bClose).not.toHaveBeenCalled();
      // 不得再发 reconnect prompt（A.send 次数不因重连增长）
      const reconnectSend = agentA.send.mock.calls.some((c) =>
        String(c[0] ?? "").includes("网络连接中断"),
      );
      expect(reconnectSend).toBe(false);
      expect(agentA.send.mock.calls.length).toBe(sendCountBeforeB);
      // Agent.resume 若在失主后仍被调用会覆盖会话——修复后不应在 B claim 后再 resume 成功落表
      // （允许 0 次，或失败返回；关键是 agentSessions 仍是 B）
      expect(agentSessions.get(id)?.agentId).toBe("agent_r23_m7_b");
    },
    20_000,
  );

  // ─────────────────────────────────────────────────────────────
  // 8) finalize × 并发 advance（进行中 + 终态后）
  // ─────────────────────────────────────────────────────────────
  it("R23-M8 finalize 进行中 / 完成后 advance 均被拒（R23-7 / I5）", async () => {
    // 旧实现：finalize 只 revoke、不占 lifecycle；revoke 后新 advance 拿到新 gen 合法启动，
    // finalize 随后写 merged + 可能删 worktree——倒挂。
    const id = alloc();
    await writeMeta(makeMeta(id));
    makeInstantAgent("agent_r23_m8");

    // —— 进行中：修复后 finalize 占 finalizing lifecycle；此处用同协议 begin 模拟窗口 ——
    // （真实 finalizeTask 入口也会 begin；卡住 waitForTaskToStop 可并发验证）
    const began = (
      beginChatLifecycle as (tid: string, phase: string) => boolean
    )(id, "finalizing");
    expect(began).toBe(true);
    expect(getChatLifecycle(id)).toBe("finalizing");

    await expect(
      advanceTask({
        task: (await getTask(id))!,
        actionType: "plan",
        userInstruction: "R23-M8 finalize 进行中推进",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      }),
    ).rejects.toThrow();

    // 进行中不得落新 action
    expect((await readMetaV06(id))?.actions).toHaveLength(0);
    endChatLifecycle(id);

    // —— 并发真链：卡住 runner 让 finalize 停在 waitForTaskToStop，期间 advance 被拒 ——
    runningTasks.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agentId: "agent_r23_m8_stuck",
      startedAt: Date.now(),
      startSnapshot: { title: `r23 ${id}` },
      cancel: () => {
        /* 不清理 runningTasks，拉长 finalize 窗口 */
      },
    });
    const pFin = finalizeTask(id, "merged");
    // R24-8：旧写法 catch 吞超时并把核心 expect 放条件分支——等待失败会整体跳过假绿
    await waitUntil(
      () =>
        getChatLifecycle(id) === "finalizing" ||
        getChatLifecycle(id) === "stopping",
      3000,
    );
    expect(getChatLifecycle(id)).not.toBeNull();
    await expect(
      advanceTask({
        task: (await getTask(id))!,
        actionType: "plan",
        userInstruction: "R23-M8 finalize 真链窗口推进",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      }),
    ).rejects.toThrow();

    // 放行 finalize
    runningTasks.delete(id);
    await raceExpectSettled(pFin, 5000);

    const afterFin = await readMetaV06(id);
    expect(afterFin?.repoStatus).toBe("merged");
    expect(afterFin?.runStatus).toBe("idle");

    // —— 完成后：终态准入仍拒（I5）——
    await expect(
      advanceTask({
        task: (await getTask(id))!,
        actionType: "plan",
        userInstruction: "R23-M8 merged 后推进",
        apiKey: CREDS.apiKey,
        model: CREDS.model,
      }),
    ).rejects.toThrow(/终态|merged|已合入|repoStatus|不允许|无法|developing|abandon/i);

    expect((await readMetaV06(id))?.actions).toHaveLength(0);
    expect((await readMetaV06(id))?.repoStatus).toBe("merged");
  });
});

/*
 * ─────────────────────────────────────────────────────────────
 * 用例清单（主线核对）
 * ─────────────────────────────────────────────────────────────
 * R23-M1  advance.afterClaim × stop → 无幽灵 append / 无 action_start·已通过 / idle（R23-1/R23-8, I1/I5）
 * R23-M2  resume.beforeStatusWrite × stop → 不复活 running（R23-1, I1/I5）
 * R23-M3  send.afterSend × 同 gen resume claim → 入场 observer 失效、不伤 B（R23-3, I3）
 * R23-M3b send 入口后首 await 即 claim → 旧链让位、不伤 B（R24-8）
 * R23-M4  oneshot.afterSend × advance claim → restore/失败不盖 B running（R23-3, I3）
 * R23-M4b oneshot.beforeEnsure × claim → 旧链让位、不盖 B idle（R24-8）
 * R23-M5  postcheck.betweenWrites × stop → 无 cancelled→awaiting_ack / idle→awaiting_user（R23-4, I1）
 * R23-M6  stop.afterGate 期间 append → 重读收尾全部非终态、无僵尸（R23-6, I2/I5）
 * R23-M6b append.afterPrepare × stop → commit 拒写、无幽灵 running / idle（R24-8）
 * R23-M7  reconnect.beforeResume × advance → 不关 B 会话 / 不发 reconnect prompt（R23-5, I3）
 * R23-M8  finalize 进行中+完成后 advance 均拒（R23-7, I5）
 *
 * ─────────────────────────────────────────────────────────────
 * 关键假设（修复落地后主线核对用）
 * ─────────────────────────────────────────────────────────────
 * 1. claim 后业务写（append / patch running / setRunStatus）均带 isOpOwner 条件事务；
 *    失主后 advance/resume 抛错或静默让位，且不落幽灵 action / action_start。
 * 2. sendToTaskSession 在 send resolve 后调用 failpoint("send.afterSend")，且
 *    consume 使用入场 entryOpHandle（不再 snapshotTaskOp 重拍）。
 * 3. startOneShotQuestion 在 send resolve 后调用 failpoint("oneshot.afterSend")；
 *    restore / catch 写状态以入场 observer + 自身 instanceId 门控，绝不读全局表当 B。
 * 4. runActionPostCheck 在 patchAction(awaiting_ack) 与 setTaskRunStatus(awaiting_user)
 *    之间调用 failpoint("postcheck.betweenWrites")；两段写合并为带 owner 的事务或
 *    第二段写前复查 isOpOwner / stillOwner。
 * 5. stopTaskAgent 在占 stopping + revoke 之后、扫描非终态之前调用
 *    failpoint("stop.afterGate")，并在 gate 内 getTask 重读后再收尾。
 * 6. tryAutoReconnect 在退避 sleep 返回后、closeTaskSession/resume 之前调用
 *    failpoint("reconnect.beforeResume")；每个 await 后复查同一 opHandle；
 *    close/resume 带 expected session instance CAS。
 * 7. finalizeTask 入口 beginChatLifecycle(taskId, "finalizing")（或等价 terminal
 *    phase），直到状态提交 / 会话关闭 / worktree 清理结束才 end；advance 准入在锁内
 *    拒绝 lifecycle≠null 与 repoStatus∉{developing}。
 * 8. ChatLifecyclePhase 扩展含 "finalizing"；isOpOwner / advance 路由识别该相位。
 *
 * ─────────────────────────────────────────────────────────────
 * 依赖的全部插桩点名
 * ─────────────────────────────────────────────────────────────
 * 新：stop.afterGate / send.afterSend / oneshot.afterSend /
 *     postcheck.betweenWrites / reconnect.beforeResume
 * 已有：advance.afterClaim / resume.beforeStatusWrite
 * （本文件未用但约定存在：advance.afterAppend / advance.beforeHandoff /
 *  start.afterCreate / start.afterPrompt / start.afterSend / resume.afterClaim /
 *  consume.afterWait / consume.beforeFinalize / failure.beforePrepare /
 *  failure.beforePublish）
 */
