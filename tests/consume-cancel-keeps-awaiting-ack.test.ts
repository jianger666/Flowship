/**
 * R14 Q7b-01：consume 的 cancel 收尾只收「仍 running」的 action，不把已交卷的待审阅位打回 cancelled
 *
 * 场景：agent 已 submit_work、后置 check 通过 → action 落 awaiting_ack（runStatus 刻意保持 running，
 * 因为收尾旁白还在流）；旁白阶段卡 >20s，用户在输入条发消息 → 输入条路由（handleTaskQuestionInject）
 * 排空超时 → abortStuckRunForSend → stuck.cancel() → consumeSessionRun 的 cancelled 分支 → finalizeOwnAction。
 *
 * 旧行为：finalizeOwnAction 无条件 patchAction(status=cancelled)——
 *   · 待审阅的 action 被打成 cancelled，丢了审阅位；
 *   · 路由 abortStuck 之后重校验「当前 action 仍是 awaiting_ack」不通过 → 回 409「任务状态刚变化…请重新发送」，用户那条消息也丢了。
 * 新行为：finalizeOwnAction 用 patchActionIfOwner(…, { actionStatus: "running" })——只收仍 running 的；
 *   awaiting_ack 保持不动，consume 的 cancelled 分支随后仍把 runStatus 置 idle（状态 = awaiting_ack + idle，与归档 / 停止同口径）。
 *
 * 手法：真 task-fs + 真 task-runner（deliverAskReply 起一条挂着的 run → 登记 runningTasks → 交卷 → abortStuckRunForSend），
 * 只 mock 外部重依赖（SDK / MCP / skills / 杀孤儿进程 / chat-pending）。
 * 路由级用例（回归 4）额外部分 mock 两处：task-stream.waitForTaskToStop 的「第一次」（不真等 20s、直接判排空超时）、
 * task-runner.resumeCurrentActionWithMessage（唤醒链会起真 agent，换成桩、只看路由有没有走到唤醒）；
 * abortStuckRunForSend / finalizeOwnAction / deliverTaskQuestion 全是真的。
 *
 * 真实链路（回归 4 走的就是它）：abortStuck 之后 consume 的 cancelled 分支末尾 closeMySession()（缺省 keepPersisted:false）
 * 会连 sessionAgentId 锚点一起清 → 后继 deliverTaskQuestion 真实返回 no_session → 路由按「当前 action 停在 awaiting_ack / cancelled / error …」
 * 走「唤醒当前阶段」分支（resumeCurrentActionWithMessage：起新 agent 原地续同一 action、用户消息当最新指示）。
 * 所以用户消息的承接方是唤醒、不是对旧会话的 send——这也是没有写「cancel 之后再 deliverAskReply 一次」用例的原因：
 * 会话与锚点都已清，后继 deliverAskReply 返回 no_session（改前改后一致，钉它等于钉实现细节）。
 *
 * 不覆盖：finalizeOwnAction 的另两类调用方——
 *   · applyPendingStopIfRequested（启动窗口停止）：该窗口里 agent 还没起来、action 不会已是 awaiting_ack，没有可稳定构造的入口；
 *   · handleRunFailure 的 error 收尾：该处自带 ownAction.status==="running" 的前置检查，改前改后行为一致，无可钉的回归。
 * finalizeOwnAction 是模块私有，一律经公开入口间接测，不 import。
 *
 * 用例分类：「回归」= 改前（BF）必须红；「对照」= 改前改后都绿。
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
import type { TaskStreamEvent } from "@/lib/server/task-stream";
import type { ActionStatus } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-consume-cancel-ack-"));
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

/**
 * 路由级用例的「旁白卡 >20s」开关：armed 时下一次 waitForTaskToStop 直接返回 false（排空超时），
 * 用完自动复位；其余调用（含路由 abortStuck 之后那次 2s 短 drain）委托真实实现。
 */
const drainTimeout = { armed: false };
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return {
    ...actual,
    waitForTaskToStop: async (taskId: string, timeoutMs?: number) => {
      if (drainTimeout.armed) {
        drainTimeout.armed = false;
        return false;
      }
      return actual.waitForTaskToStop(taskId, timeoutMs);
    },
  };
});

/**
 * 路由用：「唤醒当前阶段」换成桩（真实现会起新 agent；桩只记录入参、不调 onRunningCommitted，
 * 路由对此有兜底——退回 getTaskMeta 快照照回 200）。abortStuckRunForSend / deliverAskReply / deliverTaskQuestion 等仍是真的。
 */
const mockResumeCurrentAction = vi.fn();
vi.mock("@/lib/server/task-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-runner")>();
  return {
    ...actual,
    resumeCurrentActionWithMessage: (...args: unknown[]) =>
      mockResumeCurrentAction(...args),
  };
});

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readMetaV06, taskDir, withTaskLock, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  pendingStopRequests,
  runningTasks,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { abortStuckRunForSend, deliverAskReply } = await import(
  "@/lib/server/task-runner"
);
const { handleTaskQuestionInject } = await import(
  "@/lib/server/task-question-inject"
);
const { getTask, listTasks, patchAction } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `consume-cancel-keeps-awaiting-ack DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

// 跳过 boot-recovery：它会把盘上 runStatus=running 的任务当「上次进程遗留的僵尸」标成 error，
// 而本文件的用例恰恰要以 running 起手（与 stop-flush-partial-output / ownership-r34 同款处理）。
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
(globalThis as unknown as Record<string, Promise<void>>)[RECOVERY_FLAG] =
  Promise.resolve();
await listTasks();

const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
const PERSISTED_AGENT_ID = "agent_q7b01_persisted";
/** 回归 4：用户在旁白卡住时发的那句话 */
const USER_TEXT = "旁白卡住时用户发的这句话";
/** seed 出来的 completed action 的固定 endedAt：区分「保留原值」与「被改写」 */
const COMPLETED_ENDED_AT = 1_700_000_000_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 轮询直到条件成立（机器高负载时不靠固定 sleep 等异步结果）；上限 20s */
const waitUntil = async (
  pred: () => boolean | Promise<boolean>,
  ms = 20_000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`waitUntil 超时 ${ms}ms`);
};

/** 续接 / 读服务端凭据（readServerCreds）用 */
const writeServerCreds = async (): Promise<void> => {
  const dataDir = process.env.FLOWSHIP_DATA_DIR!;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({ apiKey: CREDS.apiKey, defaultModel: CREDS.model }),
  );
};

/** 一条单 action 的 running 任务：run 在跑所以 runStatus=running；status 参数化 action 起手状态 */
const seedTask = async (id: string, actionStatus: ActionStatus): Promise<void> => {
  await writeMeta({
    id,
    title: `consume-cancel-ack ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: "act1",
    sessionAgentId: PERSISTED_AGENT_ID,
    actions: [
      {
        id: "act1",
        n: 1,
        type: "plan",
        status: actionStatus,
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: actionStatus === "running" ? null : COMPLETED_ENDED_AT,
      },
    ],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskMetaV06);
};

const metaOf = async (id: string): Promise<TaskMetaV06> => {
  const meta = await readMetaV06(id);
  if (!meta) throw new Error(`meta 丢失：${id}`);
  return meta;
};

/** 按 kind 窄化任务流帧的类型谓词 */
const isFrameOf =
  <K extends TaskStreamEvent["kind"]>(kind: K) =>
  (f: TaskStreamEvent): f is Extract<TaskStreamEvent, { kind: K }> =>
    f.kind === kind;

describe("R14 Q7b-01：consume 的 cancel 收尾只收仍 running 的 action", () => {
  const ids: string[] = [];
  const unsubs: Array<() => void> = [];
  /** 每条挂着的 run 的放行闸：afterEach 统一放开，免得失败的用例把 consume 永远挂住 */
  const releasers: Array<() => void> = [];
  let seq = 0;

  const alloc = (): string => {
    const id = `t_q7b01_${Date.now()}_${seq++}`;
    ids.push(id);
    return id;
  };

  const collectFrames = (id: string): TaskStreamEvent[] => {
    const frames: TaskStreamEvent[] = [];
    unsubs.push(
      subscribeTaskStream(id, (ev) => {
        frames.push(ev);
      }),
    );
    return frames;
  };

  /**
   * 装一个会话 + 经 deliverAskReply 起一条「挂着的 run」（= 收尾旁白一直不结束），等它登记进 runningTasks。
   * stream / wait 都卡在 gate 上，run.cancel() 放闸、wait 以 cancelled 收场——
   * 与真 SDK 的 cancel 语义一致；consume 因此走 cancelled 分支。
   */
  const startHangingRun = async (id: string) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    releasers.push(release);
    const run = {
      id: `run_${id}`,
      stream: async function* (): AsyncGenerator<unknown> {
        await gate;
      },
      wait: vi.fn(async () => {
        await gate;
        return { status: "cancelled" as const };
      }),
      cancel: vi.fn(async () => {
        release();
      }),
    };
    const agent = {
      agentId: PERSISTED_AGENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(run),
    };
    agentSessions.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agent: agent as never,
      agentId: agent.agentId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title: `q7b01 ${id}` },
      repoPaths: [],
    });
    // errorActionId="act1"：把这条 run 绑定到 act1——consume 的收尾只碰它绑定的那个 action
    const sent = await deliverAskReply(
      (await getTask(id))!,
      "触发这一轮",
      undefined,
      "act1",
      { apiKey: CREDS.apiKey, model: CREDS.model },
    );
    expect(sent).toBe("sent");
    await waitUntil(() => runningTasks.has(id));
    return { run, agent };
  };

  /** 模拟交卷：post-check 通过 → action 落 awaiting_ack，runStatus 保持 running（旁白还在流） */
  const submitWork = async (id: string): Promise<number | null> => {
    await patchAction(id, "act1", { status: "awaiting_ack" });
    const meta = await metaOf(id);
    expect(meta.actions[0]!.status).toBe("awaiting_ack");
    expect(meta.runStatus).toBe("running");
    expect(runningTasks.has(id)).toBe(true);
    return meta.actions[0]!.endedAt;
  };

  /** 等 cancel 收尾彻底走完：run 摘出 runningTasks、runStatus 回 idle */
  const waitSettledIdle = async (id: string): Promise<void> => {
    await waitUntil(
      async () => !runningTasks.has(id) && (await metaOf(id)).runStatus === "idle",
    );
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    mockResumeCurrentAction.mockReset();
    mockResumeCurrentAction.mockResolvedValue(undefined);
    drainTimeout.armed = false;
  });

  afterEach(async () => {
    drainTimeout.armed = false;
    for (const unsub of unsubs.splice(0)) unsub();
    // 放开所有挂着的 run，让残留的 consume 自己收尾退出（失败用例也不留悬挂）
    for (const release of releasers.splice(0)) release();
    for (const id of ids) {
      await waitUntil(() => !runningTasks.has(id), 5_000).catch(() => {});
    }
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      agentSessions.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
    }
    // 排空 per-task 锁队列：后台的 meta.updatedAt 触碰 / 收尾写盘落完再删目录，免得删完才写、打 ENOENT 告警
    for (const id of ids) await withTaskLock(id, async () => undefined);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ───────────────────────── 核心回归：已交卷的 awaiting_ack 不被打回 ─────────────────────────
  it(
    "【回归 1】已交卷（awaiting_ack）的 action 经 abortStuckRunForSend 的 cancel 收尾后仍是 awaiting_ack、" +
      "endedAt 不被改写；runStatus 最终回 idle、runningTasks 摘除、done 照发。" +
      "改前：action 被无条件打成 cancelled，待审阅位丢了",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await seedTask(id, "running");
      const { run } = await startHangingRun(id);
      const ackedEndedAt = await submitWork(id);
      expect(ackedEndedAt).not.toBeNull();
      const frames = collectFrames(id);

      await abortStuckRunForSend(id);

      // cancel 确实发生了（不是空转）
      expect(run.cancel).toHaveBeenCalledTimes(1);
      // consume 的 cancelled 分支随后仍把 runStatus 置 idle——不是卡在 running
      await waitSettledIdle(id);
      expect(runningTasks.has(id)).toBe(false);
      // 其余收尾照常走完：会话随 cancelled 分支末尾关掉（不留悬挂会话）
      expect(agentSessions.has(id)).toBe(false);

      const after = await metaOf(id);
      expect(after.actions[0]!.status).toBe("awaiting_ack");
      expect(after.actions[0]!.endedAt).toBe(ackedEndedAt);
      expect(after.runStatus).toBe("idle");
      expect(after.currentActionId).toBe("act1");

      // 收尾其余部分照常走完：done 帧发出、快照里 runStatus 已 idle 且审阅位还在
      const doneFrames = frames.filter(isFrameOf("done"));
      expect(doneFrames.length).toBeGreaterThanOrEqual(1);
      const done = doneFrames[doneFrames.length - 1]!;
      expect(done.ok).toBe(true);
      expect(done.task.runStatus).toBe("idle");
      expect(done.task.actions[0]!.status).toBe("awaiting_ack");
    },
    60_000,
  );

  // ───────────────────────── 对照：仍 running 的照旧收成 cancelled ─────────────────────────
  it(
    "【对照 2】仍 running 的 action 经同样的 cancel 收尾照旧被收成 cancelled（写 endedAt），runStatus 回 idle（改前改后一致）",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await seedTask(id, "running");
      const { run } = await startHangingRun(id);
      expect((await metaOf(id)).actions[0]!.status).toBe("running");

      await abortStuckRunForSend(id);

      expect(run.cancel).toHaveBeenCalledTimes(1);
      await waitSettledIdle(id);
      const after = await metaOf(id);
      expect(after.actions[0]!.status).toBe("cancelled");
      // running→终态自动落 endedAt（真实 now，远大于固定的 COMPLETED_ENDED_AT）
      expect(after.actions[0]!.endedAt).toBeGreaterThan(COMPLETED_ENDED_AT);
      expect(after.runStatus).toBe("idle");
    },
    60_000,
  );

  // ───────────────────────── 已 completed 的不被改写 ─────────────────────────
  it(
    "【回归 3】已 completed 的 action（旧 run 的旁白还在流）经 cancel 收尾后不被改写：仍 completed、endedAt 不变。" +
      "改前：finalizeOwnAction 无条件 patch，completed 也会被打成 cancelled",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await seedTask(id, "completed");
      const { run } = await startHangingRun(id);

      await abortStuckRunForSend(id);

      expect(run.cancel).toHaveBeenCalledTimes(1);
      await waitSettledIdle(id);
      const after = await metaOf(id);
      expect(after.actions[0]!.status).toBe("completed");
      expect(after.actions[0]!.endedAt).toBe(COMPLETED_ENDED_AT);
      expect(after.runStatus).toBe("idle");
    },
    60_000,
  );

  // ───────────────────────── 路由层症状：用户消息不丢 ─────────────────────────
  it(
    "【回归 4】旁白卡住时用户在输入条发消息（路由排空超时 → abortStuckRunForSend）：路由不再回 409、" +
      "用户消息被接着承接（走「唤醒当前阶段」）、待审阅的 action 仍是 awaiting_ack。" +
      "改前：action 被打成 cancelled，路由 abortStuck 之后重校验「当前 action 仍 awaiting_ack」不通过，回 409「任务状态刚变化」、用户消息丢失",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await seedTask(id, "running");
      await startHangingRun(id);
      await submitWork(id);

      // 旁白卡 >20s：让路由里第一次 waitForTaskToStop 直接判超时（不真等 20s），随后真实走 abortStuckRunForSend
      drainTimeout.armed = true;
      const res = await handleTaskQuestionInject(id, {
        text: USER_TEXT,
        bootArgs: { apiKey: CREDS.apiKey, model: CREDS.model },
      });
      // 路由确实走到了「排空超时 → 假死恢复」分支（开关被消费）
      expect(drainTimeout.armed).toBe(false);

      // 失败时把响应体带进断言信息：改前这里是 409 + 「任务状态刚变化（可能已推进）、请重新发送」
      const bodyText = await res.clone().text();
      expect(res.status, bodyText).toBe(200);

      // 用户消息被承接：旧会话与锚点已随 cancel 收尾清掉 → 真实 deliverTaskQuestion 返 no_session
      // → 路由走唤醒分支（起新 agent 原地续 act1、用户消息当最新指示）。唤醒函数在这里是桩、只看入参。
      expect(mockResumeCurrentAction).toHaveBeenCalledTimes(1);
      const input = mockResumeCurrentAction.mock.calls[0]![0] as {
        task: { id: string; currentActionId: string | null };
        userMessage: string;
      };
      expect(input.task.id).toBe(id);
      expect(input.task.currentActionId).toBe("act1");
      expect(input.userMessage).toContain(USER_TEXT);

      // 唤醒被桩掉，盘上停在 abortStuck 收尾后的状态：审阅位没丢、旧 run 已摘
      const meta = await metaOf(id);
      expect(meta.actions[0]!.status).toBe("awaiting_ack");
      expect(runningTasks.has(id)).toBe(false);
    },
    60_000,
  );
});
