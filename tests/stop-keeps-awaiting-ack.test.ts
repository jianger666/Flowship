/**
 * R14 Q7a-05：用户点「停止」不丢已交卷（awaiting_ack）的 action
 *
 * 背景：agent 交卷（submit_work）→ 后置 check 通过 → action 落 awaiting_ack；runStatus 刻意保持 running
 * （收尾旁白还在流）。旧 stop-task 对 finalizeStaleAndIdleLocked 不传 leaveAwaitingAck，
 * 无条件把 running 与 awaiting_ack 一并打成 cancelled——已通过 check 的交卷产物状态丢了：
 * 「推进」的隐式认可（advance 的 pendingAck 分支）、输入条「再聊聊」的 ack 上下文随之消失，产物只能重跑。
 *
 * 修法（stop-task.ts）：leaveAwaitingAck = (trigger !== "exclude")
 *   · 普通 stop（/stop 路由、飞书卡片；缺省 / "stop"）：只把 running 收成 cancelled，awaiting_ack 保留，
 *     runStatus 仍回 idle（与归档同口径）；
 *   · exclude（划除 action 时的自动收尾）：用户明说这个 action 不要了，awaiting_ack 仍一并收成 cancelled。
 *
 * 手法：真 task-fs + 真 stop-task + 真 task-runner（cancelTaskRun / supersedePendingAsks / advanceTask），
 * 只 mock 外部重依赖（SDK / MCP / skills / 杀孤儿进程 / chat-pending）；任务用 writeMeta 直接造，
 * 「收尾旁白还在流」用一条假的 runningTasks 记录表示（cancel 是 vi.fn，只记录被调用）。
 *
 * 用例分类（与任务描述的编号对应）：
 *   「回归」= 改前（BF）必须红，证明测试真的钉住了 bug；「对照」= 改前改后都绿，防修复矫枉过正。
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
import type { ActionRecord, ActionStatus, RunStatus } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-stop-keeps-ack-"));
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

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, withTaskLock, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  isTaskStarting,
  pendingStopRequests,
  runningTasks,
  subscribeTaskStream,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const { advanceTask } = await import("@/lib/server/task-runner");
const { getTask, listTasks, patchActionIfOwner } = await import(
  "@/lib/server/task-fs"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `stop-keeps-awaiting-ack DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

// 跳过 boot-recovery：它会把盘上 runStatus=running 的任务当「上次进程遗留的僵尸」标成 error，
// 而本文件的用例恰恰要以 running 起手（与 stop-flush-partial-output / ownership-r34 同款处理）。
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
(globalThis as unknown as Record<string, Promise<void>>)[RECOVERY_FLAG] =
  Promise.resolve();
await listTasks();

const CREDS = {
  apiKey: "k",
  model: { id: "m", params: [] as never[] },
};

/** action 的固定起止时间：区分「保留原值」与「被写成 now」（真实 now 远大于它们） */
const STARTED_AT = 1_699_999_000_000;
const ACK_ENDED_AT = 1_700_000_000_000;

interface ActionSeed {
  id: string;
  status: ActionStatus;
}

const toAction = (seed: ActionSeed, n: number): ActionRecord => ({
  id: seed.id,
  n,
  type: "plan",
  status: seed.status,
  userInstruction: "",
  artifactPath: null,
  startedAt: STARTED_AT,
  // 与真实落盘口径一致：running 没有 endedAt；其余状态有值
  // （awaiting_ack 的 endedAt 是交卷时 patchAction 在 running→awaiting_ack 那一刻自动落的）
  endedAt: seed.status === "running" ? null : ACK_ENDED_AT,
});

const seedTask = async (
  id: string,
  opts: {
    runStatus: RunStatus;
    currentActionId: string | null;
    actions: ActionSeed[];
  },
): Promise<void> => {
  await writeMeta({
    id,
    title: `stop-keeps-ack ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: opts.runStatus,
    currentActionId: opts.currentActionId,
    actions: opts.actions.map((a, i) => toAction(a, i + 1)),
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskMetaV06);
};

/**
 * 装一条假的活 run（= 收尾旁白还在流）：runningTasks 记录里 cancel 只记录调用，
 * 不会真的结束任何 consume——所以 afterEach 要自己清。
 */
const installFakeRun = (id: string): { cancel: ReturnType<typeof vi.fn> } => {
  const cancel = vi.fn();
  runningTasks.set(id, {
    instanceId: allocTaskRunInstanceId(),
    agentId: "agent_q7a05",
    startedAt: Date.now(),
    startSnapshot: { title: id },
    cancel,
  });
  return { cancel };
};

/** 一个立刻跑完的假 agent：advance 推进后起的新 run 秒结束，不拖尾 */
const installInstantAgent = (agentId: string): void => {
  const agent = {
    agentId,
    close: vi.fn(),
    send: vi.fn().mockResolvedValue({
      stream: async function* () {
        /* 空流 */
      },
      wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    }),
  };
  mockCreate.mockResolvedValue(agent);
};

/** 重连 / 推进读服务端凭据（readServerCreds）用 */
const writeServerCreds = async (): Promise<void> => {
  const dataDir = process.env.FLOWSHIP_DATA_DIR!;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({ apiKey: CREDS.apiKey, defaultModel: CREDS.model }),
  );
};

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

const metaOf = async (id: string): Promise<TaskMetaV06> => {
  const meta = await readMetaV06(id);
  if (!meta) throw new Error(`meta 丢失：${id}`);
  return meta;
};

/** 按 kind 窄化任务流帧的类型谓词（filter 用，免得断言里到处 if + throw） */
const isFrameOf =
  <K extends TaskStreamEvent["kind"]>(kind: K) =>
  (f: TaskStreamEvent): f is Extract<TaskStreamEvent, { kind: K }> =>
    f.kind === kind;

const statusesOf = (meta: TaskMetaV06): ActionStatus[] =>
  meta.actions.map((a) => a.status);

describe("R14 Q7a-05：停止只收 running，已交卷（awaiting_ack）的 action 保留", () => {
  const ids: string[] = [];
  const unsubs: Array<() => void> = [];
  let seq = 0;

  const alloc = (): string => {
    const id = `t_q7a05_${Date.now()}_${seq++}`;
    ids.push(id);
    return id;
  };

  /** 订阅任务流，收集 stop 期间 publish 的所有帧 */
  const collectFrames = (id: string): TaskStreamEvent[] => {
    const frames: TaskStreamEvent[] = [];
    unsubs.push(
      subscribeTaskStream(id, (ev) => {
        frames.push(ev);
      }),
    );
    return frames;
  };

  const stop = async (id: string, trigger?: "stop" | "exclude") => {
    const task = (await getTask(id))!;
    return stopTaskAgent(task, trigger ? { trigger } : undefined);
  };

  beforeEach(() => {
    mockCreate.mockReset();
  });

  afterEach(async () => {
    for (const unsub of unsubs.splice(0)) unsub();
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      agentSessions.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
    }
    // 排空 per-task 锁队列：appendEvent 首条事件后会在后台排一次 meta.updatedAt 触碰，
    // 等它落完再删目录，免得删完才写、打一堆 ENOENT 告警
    for (const id of ids) await withTaskLock(id, async () => undefined);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ───────────────────────── 任务要求 1：核心回归 ─────────────────────────
  it.each([
    {
      label: "缺省 trigger（/stop 路由、飞书卡片）+ runStatus=running（收尾旁白还在流、有活 run）",
      trigger: undefined,
      runStatus: "running" as const,
      hasRun: true,
    },
    {
      label: "显式 trigger=stop + runStatus=running（有活 run）",
      trigger: "stop" as const,
      runStatus: "running" as const,
      hasRun: true,
    },
    {
      label: "缺省 trigger + runStatus=awaiting_user（旁白已结束、无活 run）",
      trigger: undefined,
      runStatus: "awaiting_user" as const,
      hasRun: false,
    },
  ])(
    "【回归 1】普通 stop 保留 awaiting_ack：$label → action 仍 awaiting_ack、runStatus=idle。" +
      "改前：action 被无条件打成 cancelled，已通过 check 的交卷状态丢了",
    async ({ trigger, runStatus, hasRun }) => {
      const id = alloc();
      await seedTask(id, {
        runStatus,
        currentActionId: "act1",
        actions: [{ id: "act1", status: "awaiting_ack" }],
      });
      const run = hasRun ? installFakeRun(id) : null;

      const result = await stop(id, trigger);

      // 盘上状态：action 保留审阅位，task 级回 idle（与归档同口径）
      const meta = await metaOf(id);
      expect(meta.actions[0]!.status).toBe("awaiting_ack");
      expect(meta.runStatus).toBe("idle");
      // 保留的是「交卷时」的原始记录，不被 stop 改写
      expect(meta.actions[0]!.endedAt).toBe(ACK_ENDED_AT);
      // 返回给路由的快照与盘上同口径（路由把它原样回给前端）
      expect(result.task.actions[0]!.status).toBe("awaiting_ack");
      expect(result.task.runStatus).toBe("idle");

      if (run) {
        // 「只停旁白」：活 run 确实被 cancel 了一次、hadAgent 为真——不是空停止
        expect(run.cancel).toHaveBeenCalledTimes(1);
        expect(result.hadAgent).toBe(true);
      } else {
        expect(result.hadAgent).toBe(false);
      }
    },
    60_000,
  );

  // ───────────────────────── 任务要求 2：对照 ─────────────────────────
  it(
    "【对照 2】running 的 action 照旧被收成 cancelled、写 endedAt，runStatus=idle（改前改后一致）",
    async () => {
      const id = alloc();
      await seedTask(id, {
        runStatus: "running",
        currentActionId: "act1",
        actions: [{ id: "act1", status: "running" }],
      });
      const run = installFakeRun(id);

      const result = await stop(id);

      const meta = await metaOf(id);
      expect(meta.actions[0]!.status).toBe("cancelled");
      expect(meta.runStatus).toBe("idle");
      // running→终态自动落 endedAt（真实 now，远大于固定的 ACK_ENDED_AT）
      expect(meta.actions[0]!.endedAt).toBeGreaterThan(ACK_ENDED_AT);
      expect(result.task.actions[0]!.status).toBe("cancelled");
      expect(run.cancel).toHaveBeenCalledTimes(1);
      expect(result.hadAgent).toBe(true);
    },
    60_000,
  );

  // ───────────────────────── 任务要求 3：对照 ─────────────────────────
  it(
    "【对照 3】trigger=exclude + awaiting_ack → 仍收成 cancelled（划除 = 用户明说不要了；保持原语义），事件文案按划除措辞",
    async () => {
      const id = alloc();
      // action-exclude 路由只在 runStatus=awaiting_user 时才自动调 stop(exclude)——按真实入口造
      await seedTask(id, {
        runStatus: "awaiting_user",
        currentActionId: "act1",
        actions: [{ id: "act1", status: "awaiting_ack" }],
      });

      const result = await stop(id, "exclude");

      const meta = await metaOf(id);
      expect(meta.actions[0]!.status).toBe("cancelled");
      expect(meta.runStatus).toBe("idle");
      // awaiting_ack 本就有 endedAt，收尾沿用原值（`endedAt ?? now`），不重写
      expect(meta.actions[0]!.endedAt).toBe(ACK_ENDED_AT);
      expect(result.task.actions[0]!.status).toBe("cancelled");

      // trigger 确实一路透传到了停止事件文案：划除措辞，而不是「用户停止了」
      const events = await readEvents(id);
      const stopEvent = events.find(
        (e) => e.kind === "info" && e.meta?.stopped === true,
      );
      expect(stopEvent?.text).toContain("划除时自动停止了");
      expect(stopEvent?.text).not.toContain("用户停止了");
    },
    60_000,
  );

  // ───────────────────────── 任务要求 4：对照 + 扩展回归 ─────────────────────────
  it(
    "【对照 4】已 completed 的历史 action 不被碰：completed + 当前 running → 只有 running 的变 cancelled",
    async () => {
      const id = alloc();
      await seedTask(id, {
        runStatus: "running",
        currentActionId: "act2",
        actions: [
          { id: "act1", status: "completed" },
          { id: "act2", status: "running" },
        ],
      });
      installFakeRun(id);

      await stop(id);

      const meta = await metaOf(id);
      expect(statusesOf(meta)).toEqual(["completed", "cancelled"]);
      // completed 记录整条原样不动（status / endedAt 都没被改）
      expect(meta.actions[0]!.endedAt).toBe(ACK_ENDED_AT);
      expect(meta.runStatus).toBe("idle");
    },
    60_000,
  );

  it(
    "【回归 4b】多个非终态残留（force-new 遗留）：completed + awaiting_ack + running → 只有 running 的变 cancelled，" +
      "awaiting_ack 与 completed 都保留。改前：awaiting_ack 也被一并打成 cancelled",
    async () => {
      const id = alloc();
      await seedTask(id, {
        runStatus: "running",
        currentActionId: "act3",
        actions: [
          { id: "act1", status: "completed" },
          { id: "act2", status: "awaiting_ack" },
          { id: "act3", status: "running" },
        ],
      });
      installFakeRun(id);

      await stop(id);

      const meta = await metaOf(id);
      expect(statusesOf(meta)).toEqual(["completed", "awaiting_ack", "cancelled"]);
      expect(meta.runStatus).toBe("idle");
    },
    60_000,
  );

  // ───────────────────────── 任务要求 5：对照（+ 5b 回归） ─────────────────────────
  it.each([
    {
      label: "awaiting_ack 保留场景（新分支：本次 stop 没有任何 action 被收成 cancelled）",
      seed: "awaiting_ack" as const,
    },
    {
      label: "running → cancelled 场景（原路径）",
      seed: "running" as const,
    },
  ])(
    "【对照 5】停止事件与 done 照旧：$label → 写 info 事件（meta.stopped=true、挂在当前 action 上）、publish task 快照 + done(ok)，runStatus=idle",
    async ({ seed }) => {
      const id = alloc();
      await seedTask(id, {
        runStatus: "running",
        currentActionId: "act1",
        actions: [{ id: "act1", status: seed }],
      });
      installFakeRun(id);
      const frames = collectFrames(id);

      await stop(id);

      // 落盘的停止事件：info + meta.stopped（前端据此把「这一轮被停掉」当边界）
      // 事件的 actionId 取「当前 action」——awaiting_ack 保留时没有任何 cancelled action，
      // 也必须从 currentActionId 找到它，而不是丢成 undefined
      const events = await readEvents(id);
      const stopEvents = events.filter(
        (e) => e.kind === "info" && e.meta?.stopped === true,
      );
      expect(stopEvents).toHaveLength(1);
      expect(stopEvents[0]!.actionId).toBe("act1");
      expect(stopEvents[0]!.text).toContain("用户停止了");
      expect(stopEvents[0]!.text).toContain("action");

      // publish：事件帧 + task 快照帧 + done 帧（done 在 stop 里由终态 owner 无条件补发，前端靠它解挂流式气泡）
      const eventFrames = frames.filter(
        (f) => f.kind === "event" && f.event.meta?.stopped === true,
      );
      expect(eventFrames).toHaveLength(1);
      const taskFrames = frames.filter(isFrameOf("task"));
      expect(taskFrames.length).toBeGreaterThanOrEqual(1);
      expect(taskFrames[taskFrames.length - 1]!.task.runStatus).toBe("idle");
      const doneFrames = frames.filter(isFrameOf("done"));
      expect(doneFrames).toHaveLength(1);
      expect(doneFrames[0]!.ok).toBe(true);
      expect(doneFrames[0]!.task.runStatus).toBe("idle");
    },
    60_000,
  );

  it(
    "【回归 5b】awaiting_ack 保留时，推给前端的 task 快照帧与 done 帧里该 action 也仍是 awaiting_ack。" +
      "改前：快照里已是 cancelled，前端「推进 / 再聊聊」的待审阅上下文随之消失",
    async () => {
      const id = alloc();
      await seedTask(id, {
        runStatus: "running",
        currentActionId: "act1",
        actions: [{ id: "act1", status: "awaiting_ack" }],
      });
      installFakeRun(id);
      const frames = collectFrames(id);

      await stop(id);

      // 前端渲染只认流里的快照：最后一张 task 帧与 done 帧都必须带着保留下来的审阅位
      const taskFrames = frames.filter(isFrameOf("task"));
      expect(taskFrames.length).toBeGreaterThanOrEqual(1);
      expect(taskFrames[taskFrames.length - 1]!.task.actions[0]!.status).toBe(
        "awaiting_ack",
      );
      const doneFrames = frames.filter(isFrameOf("done"));
      expect(doneFrames).toHaveLength(1);
      expect(doneFrames[0]!.task.actions[0]!.status).toBe("awaiting_ack");
      expect(doneFrames[0]!.task.currentActionId).toBe("act1");
    },
    60_000,
  );

  // ───────────────────────── 任务要求 6：回归 ─────────────────────────
  it(
    "【回归 6a】停止后任务仍停在待审阅位：currentActionId 仍指向该 action、endedAt 未被改写，" +
      "且 advance 隐式认可用的条件写（currentActionId + actionStatus=awaiting_ack）仍能成功落 completed。" +
      "改前：action 已是 cancelled，条件写被拒、永远认可不了",
    async () => {
      const id = alloc();
      await seedTask(id, {
        runStatus: "running",
        currentActionId: "act1",
        actions: [{ id: "act1", status: "awaiting_ack" }],
      });
      installFakeRun(id);

      await stop(id);

      const meta = await metaOf(id);
      expect(meta.currentActionId).toBe("act1");
      expect(meta.actions[0]!.status).toBe("awaiting_ack");
      expect(meta.actions[0]!.endedAt).toBe(ACK_ENDED_AT);

      // 复刻 advanceTask pendingAck 分支的条件写参数（task-runner「去掉手动通过按钮后、推进吸收认可」）：
      // 结构条件 currentActionId + actionStatus=awaiting_ack 全满足才写得进去
      const acked = await patchActionIfOwner(
        id,
        "act1",
        { status: "completed" },
        () => true,
        { currentActionId: "act1", actionStatus: "awaiting_ack" },
      );
      expect(acked).not.toBeNull();
      expect((await metaOf(id)).actions[0]!.status).toBe("completed");
    },
    60_000,
  );

  it(
    "【回归 6b】停止后点「推进」：advance 走 pendingAck 分支隐式认可上一步（落 action_ack 事件、action → completed）。" +
      "改前：action 已被 stop 打成 cancelled，没有认可事件、产物状态永久丢失",
    async () => {
      const id = alloc();
      await writeServerCreds();
      await seedTask(id, {
        runStatus: "running",
        currentActionId: "act1",
        actions: [{ id: "act1", status: "awaiting_ack" }],
      });
      installFakeRun(id);
      installInstantAgent("agent_q7a05_advance");

      await stop(id);
      // 停止完成后 stop 的假 run 记录还留在表里（cancel 只是 vi.fn）：清掉，模拟「旁白已被 cancel 退出」
      runningTasks.delete(id);

      // 停止后的状态本身由 6a 钉；这里只钉 advance 的行为——所以不在前面另加状态断言，
      // 让「改前」的红落在下面的认可断言上（action 已是 cancelled → 没有认可、不会 completed）
      const stoppedTask = (await getTask(id))!;

      try {
        await advanceTask({
          task: stoppedTask,
          actionType: "plan",
          userInstruction: "Q7a-05 停止后推进",
          apiKey: CREDS.apiKey,
          model: CREDS.model,
        });

        const meta = await metaOf(id);
        expect(meta.actions.find((a) => a.id === "act1")?.status).toBe(
          "completed",
        );
        const acks = (await readEvents(id)).filter(
          (e) =>
            e.kind === "action_ack" &&
            e.actionId === "act1" &&
            e.meta?.decision === "approve",
        );
        expect(acks).toHaveLength(1);
      } finally {
        // advance 的启动链是 detached 的：它返回时 Agent.create 通常还没发生、runningTasks 也还空着，
        // 所以「runningTasks 为空」不能当作链路已结束。先等链路确实跑过（Agent.create 被调用），
        // 再等它退出（starting 归零 + run 摘除）——假 agent 秒结束、会走「没交卷 → 追问 → error」收尾，
        // 不等的话它会拖到 afterAll 删数据目录之后才落盘，打一条 ENOENT 告警。
        // 这是清理不是断言：用例失败时也要跑，超时不另抛错（免得盖住真正的断言失败）。
        await waitUntil(
          () =>
            mockCreate.mock.calls.length > 0 &&
            !isTaskStarting(id) &&
            !runningTasks.has(id),
        ).catch(() => {});
      }
    },
    60_000,
  );
});
