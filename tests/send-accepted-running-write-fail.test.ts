/**
 * R14 Q7b-03：send 已受理之后「写 running」失败，不能让这条 run 变孤儿
 *
 * 旧行为（修复前）：
 *   sendToTaskSessionBody 在 `agent.send` 受理之后、`void consumeSessionRun(...)` 之前，要把盘上 runStatus 刷成 running
 *   （setTaskRunStatusIfRunOwner）。这一步没有 try/catch——写盘失败（EBUSY / EPERM / ENOSPC / 杀软占用）一抛，
 *   整个函数异常退出，下面的 consume 被跳过：
 *     · agent 已经收到消息、正在后台干活，却没有任何人消费它的流（输出不进事件流、也没人收尾）；
 *     · runningTasks 没占位（别的入口以为没在跑，可以并发再起一个）；
 *     · 调用方（ask-reply / question 路由）看到的是「发送失败」，用户一重发就是二次 send（agent 收到两遍）。
 *
 * 修复后：
 *   这一步包进 try/catch，失败只 console.warn（「send 已受理但写 running 失败」），照常 `void consumeSessionRun(...)`、返回 "sent"。
 *   盘上 runStatus 只是辅助显示（侧栏「运行中」），consume 的各出口会按真实结果归位，所以吞错是安全的。
 *
 * 手法：
 *   task-runner 是从 `./task-fs` 具名导入 setTaskRunStatusIfRunOwner 的——用 vi.mock 在 task-fs 外面包一层：
 *   默认转发真实现；用例可以让「某个 task 的某个 runStatus 值」的**下一次**调用抛错（抛完自动解除、之后走真实现）。
 *   只让 `"running"` 那一次抛：consume 出口的 awaiting_user / idle 写入照常走真实现。
 *   （不用 chmod 目录模拟写失败：跨平台不稳，Windows CI 上 chmod 无效。）
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，先钉 FLOWSHIP_DATA_DIR 再动态 import。
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
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-send-accepted-running-write-fail-"),
);
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
 * setTaskRunStatusIfRunOwner 的可控替身（vi.hoisted：vi.mock 工厂提升到文件顶部，引用的变量必须同样提升）。
 * failOnce：命中「taskId + runStatus 都相同」的**下一次**调用就抛 error，抛完置回 null（之后走真实现）。
 * calls：每次调用的 (taskId, runStatus)——既是「写 running 确实被调用过」的正向信号，
 *        也用来断言「send 失败路径根本没走到写 running」。
 */
const runStatusCtl = vi.hoisted(() => ({
  failOnce: null as null | { taskId: string; status: string; error: Error },
  calls: [] as Array<{ taskId: string; status: string }>,
}));
vi.mock("@/lib/server/task-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-fs")>();
  return {
    ...actual,
    setTaskRunStatusIfRunOwner: async (
      ...args: Parameters<typeof actual.setTaskRunStatusIfRunOwner>
    ) => {
      const [taskId, status] = args;
      runStatusCtl.calls.push({ taskId, status });
      const fail = runStatusCtl.failOnce;
      if (fail && fail.taskId === taskId && fail.status === status) {
        runStatusCtl.failOnce = null;
        throw fail.error;
      }
      return actual.setTaskRunStatusIfRunOwner(...args);
    },
  };
});

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readEvents, readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  forkPendingTasks,
  pendingStopRequests,
  runningTasks,
} = await import("@/lib/server/task-stream");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { deliverAskReply } = await import("@/lib/server/task-runner");
const { getTask } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `send-accepted-running-write-fail DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

// 跳过 task-fs 的惰性 boot-recovery：它会把 runStatus=running 的任务标成 error 并往事件流补「[boot-recovery]」，
// 让 fixture 的初始态不确定（与 ownership-r34 同手法）。
const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
(globalThis as unknown as Record<string, Promise<void>>)[RECOVERY_FLAG] =
  Promise.resolve();

const PERSISTED_AGENT_ID = "agent_sendrun_persisted";
const ACTION_ID = "act_sendrun";
const CREDS = { apiKey: "k", model: { id: "m", params: [] as never[] } };
/** 轮询上限：机器高负载时也要有余量；条件成立即返回，通过路径不会真等这么久。 */
const POLL_MS = 15_000;

/**
 * fixture：runStatus=awaiting_user（用户答完 ask / 回复审阅后 send 的典型起点），action 停在 awaiting_ack：
 * run 自然结束后不触发「没交卷 → send 追问」（否则 agent.send 会被调多次、污染「只 send 一次」的断言），
 * 也不触发「action 终态 → 即用即还关会话」。
 */
const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `send-accepted ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    currentActionId: ACTION_ID,
    actions: [
      {
        id: ACTION_ID,
        n: 1,
        type: "plan",
        status: "awaiting_ack",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    sessionAgentId: PERSISTED_AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 轮询直到条件成立，返回是否在上限内成立（不抛：由调用方用带说明的 expect 断言，
 * 这样「改前」的失败信息是一句人话，而不是一个裸的超时）。
 */
const pollUntil = async (
  pred: () => boolean | Promise<boolean>,
  ms = POLL_MS,
): Promise<boolean> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
};

const makeDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const assistantMsg = (text: string) => ({
  type: "assistant" as const,
  message: { content: [{ type: "text", text }] },
});

/** 假 run：流里吐一条旁白后挂在 gate 上（run 进行中可观测）、wait 回 finished。state.streamed = 流已被 consume 开始消费。 */
const makeRun = (gate: Promise<void>) => {
  const state = { streamed: false };
  const run = {
    id: `run_${Math.random().toString(36).slice(2, 8)}`,
    stream: async function* (): AsyncGenerator<unknown> {
      state.streamed = true;
      yield assistantMsg("继续干活的旁白");
      await gate;
    },
    wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  return { run, state };
};

type FakeAgent = { agentId: string; close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };

const installSession = (id: string, agent: FakeAgent): void => {
  agentSessions.set(id, {
    instanceId: allocTaskRunInstanceId(),
    agent: agent as never,
    agentId: agent.agentId,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    startSnapshot: { title: `sendrun ${id}` },
    repoPaths: [],
  });
};

/** 模拟 task 目录 rename 被占用时抛的错（Windows 杀软 / 同步盘最常见） */
const injectedEbusy = (): Error =>
  Object.assign(
    new Error("EBUSY: resource busy or locked, rename 'meta.json.tmp'（测试注入）"),
    { code: "EBUSY" },
  );

const runningWrites = (id: string): number =>
  runStatusCtl.calls.filter((c) => c.taskId === id && c.status === "running")
    .length;

/** 被测日志：用例里要断言 warn / error 内容，同时把它们挡在终端输出之外 */
const logs = { warn: [] as unknown[][], error: [] as unknown[][] };

describe("R14 Q7b-03 send 已受理后写 running 失败：run 不得变孤儿", () => {
  const ids: string[] = [];
  /** 用例里造的 gate：afterEach 统一放行，别留悬空的 consume */
  const gates: Array<() => void> = [];

  const alloc = (): string => {
    const id = `t_sendrun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  const deliver = async (id: string) =>
    deliverAskReply((await getTask(id))!, "用户的回复", undefined, ACTION_ID, {
      apiKey: CREDS.apiKey,
      model: CREDS.model,
    });

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    runStatusCtl.failOnce = null;
    runStatusCtl.calls.length = 0;
    logs.warn.length = 0;
    logs.error.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logs.warn.push(args);
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.error.push(args);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    runStatusCtl.failOnce = null;
    for (const release of gates.splice(0)) release();
    for (const id of ids) {
      pendingStopRequests.delete(id);
      clearTaskStarting(id);
      runningTasks.delete(id);
      agentSessions.delete(id);
      forkPendingTasks.delete(id);
      clearChatGate(id);
      endChatLifecycle(id);
    }
    // 沿用现有测试的收尾手法：先让 fire-and-forget 的落盘（会话锚点等）走完再删目录，免得 ENOENT 噪音
    await sleep(60);
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // 回归：受理后写 running 失败 → 照样消费 run
  // ---------------------------------------------------------------------------
  it(
    "回归：send 受理后「写 running」抛错 → deliverAskReply 不抛、返回 sent；run 的流被消费、期间占位、结束后释放；agent.send 只调 1 次",
    async () => {
      // 保护：已受理的 run 必须有人消费。改前：写 running 抛错 → 函数异常退出、consume 被跳过 →
      // 调用方拿到异常（路由当「发送失败」，用户重发 = 二次 send）、stream 无人读、runningTasks 没占位。
      const id = alloc();
      await writeMeta(makeMeta(id));
      const injected = injectedEbusy();
      // 只让「这个 task 的 running 写入」的下一次调用抛错（consume 出口的 awaiting_user 写入走真实现）
      runStatusCtl.failOnce = { taskId: id, status: "running", error: injected };
      const gate = makeDeferred();
      gates.push(gate.resolve);
      const r1 = makeRun(gate.promise);
      const agent: FakeAgent = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockResolvedValueOnce(r1.run),
      };
      installSession(id, agent);

      let thrown: unknown = null;
      let result: unknown;
      try {
        result = await deliver(id);
      } catch (err) {
        thrown = err;
      }
      expect(
        thrown,
        "send 已受理后写 running 失败不该让 deliverAskReply 抛错（改前：抛出 EBUSY，调用方当成「发送失败」）",
      ).toBeNull();
      expect(result, "已受理 = 送达，应返回 sent").toBe("sent");
      // 注入的失败确实命中了「受理后写 running」那一次（不是别处）
      expect(runStatusCtl.failOnce, "注入的写失败应已命中并消费").toBeNull();
      expect(runningWrites(id)).toBe(1);

      // run 的流被消费，期间占位
      expect(
        await pollUntil(() => r1.state.streamed),
        "run 的流应被消费（改前：consume 被跳过、run 成孤儿）",
      ).toBe(true);
      expect(runningTasks.has(id), "run 期间应占 runningTasks（改前没占位）").toBe(
        true,
      );
      expect(agent.send).toHaveBeenCalledTimes(1);

      // run 结束后释放；盘上 runStatus 由 consume 出口归位（不是卡在 running / error）
      gate.resolve();
      expect(
        await pollUntil(() => !runningTasks.has(id)),
        "run 结束后应释放占位",
      ).toBe(true);
      expect(agent.send, "不该二次 send").toHaveBeenCalledTimes(1);
      expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
      expect(
        (await readEvents(id)).some((e: TaskEvent) => e.kind === "error"),
        "写 running 失败不该在事件流里冒出 error",
      ).toBe(false);
      // 会话留着（agent 没出问题，下一条消息还要用它）
      expect(agent.close).not.toHaveBeenCalled();
      expect(agentSessions.has(id)).toBe(true);
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 回归：写失败要留 warn 日志
  // ---------------------------------------------------------------------------
  it(
    "回归：写 running 失败时记 warn（含「send 已受理但写 running 失败」、task id 与原始错误）",
    async () => {
      // 保护：吞错必须留下可检索的告警（运维靠它定位磁盘 / 杀软问题）。改前：没有这条告警，错直接抛给调用方。
      const id = alloc();
      await writeMeta(makeMeta(id));
      const injected = injectedEbusy();
      runStatusCtl.failOnce = { taskId: id, status: "running", error: injected };
      const gate = makeDeferred();
      gates.push(gate.resolve);
      installSession(id, {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockResolvedValueOnce(makeRun(gate.promise).run),
      });

      // 改前这里会抛：本用例只关心日志，抛不抛交给上一条用例断言
      await deliver(id).catch(() => undefined);

      const warned = logs.warn.find((args) =>
        String(args[0]).includes("send 已受理但写 running 失败"),
      );
      expect(warned, "应记「send 已受理但写 running 失败」告警").toBeDefined();
      expect(String(warned![0])).toContain(id);
      expect(warned![1], "告警应带上原始错误").toBe(injected);

      // 收尾：让（改后才存在的）run 走完再清理
      gate.resolve();
      expect(
        await pollUntil(() => !runningTasks.has(id)),
        "run 结束后应释放占位",
      ).toBe(true);
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 对照：正常路径行为不变
  // ---------------------------------------------------------------------------
  it(
    "对照：写 running 正常 → 盘上先变 running、流被消费、期间占位、结束后释放并归位，agent.send 只调 1 次",
    async () => {
      // 保护：修复没有改坏正常路径——写 running 成功时仍然 running → consume 出口归位 awaiting_user。BF 里也绿。
      const id = alloc();
      await writeMeta(makeMeta(id));
      const gate = makeDeferred();
      gates.push(gate.resolve);
      const r1 = makeRun(gate.promise);
      const agent: FakeAgent = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockResolvedValueOnce(r1.run),
      };
      installSession(id, agent);

      expect(await deliver(id)).toBe("sent");
      // 正向信号：受理后确实走了「写 running」那一步，且成功落盘
      expect(runningWrites(id)).toBe(1);
      expect((await readMetaV06(id))?.runStatus).toBe("running");
      expect(
        await pollUntil(() => r1.state.streamed),
        "run 的流应被消费",
      ).toBe(true);
      expect(runningTasks.has(id), "run 期间应占位").toBe(true);
      expect(agent.send).toHaveBeenCalledTimes(1);

      gate.resolve();
      expect(
        await pollUntil(() => !runningTasks.has(id)),
        "run 结束后应释放占位",
      ).toBe(true);
      // consume 出口把 running 归位成 awaiting_user（action 停在 awaiting_ack）
      expect(
        await pollUntil(
          async () => (await readMetaV06(id))?.runStatus === "awaiting_user",
        ),
        "run 结束后 runStatus 应归位 awaiting_user",
      ).toBe(true);
      expect(agent.send).toHaveBeenCalledTimes(1);
      expect(
        logs.warn.some((args) =>
          String(args[0]).includes("send 已受理但写 running 失败"),
        ),
        "写成功时不该有失败告警",
      ).toBe(false);
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // 对照：agent.send 本身抛错 → 仍是 send_failed 路径
  // ---------------------------------------------------------------------------
  it(
    "对照：agent.send 本身抛错 → 返回 send_failed、关掉这个坏会话、不占位、根本没走到写 running",
    async () => {
      // 保护：本次修复只包了「受理之后」的写 running；send 本身失败（会话失效 / SDK 异常）仍走原路径：
      // 关坏会话、返回 send_failed 让调用方降级。BF 里同样如此。
      const id = alloc();
      await writeMeta(makeMeta(id));
      const sendErr = new Error("boom: 会话已失效（测试注入）");
      const agent: FakeAgent = {
        agentId: PERSISTED_AGENT_ID,
        close: vi.fn(),
        send: vi.fn().mockRejectedValue(sendErr),
      };
      installSession(id, agent);

      expect(await deliver(id)).toBe("send_failed");

      expect(agent.send).toHaveBeenCalledTimes(1);
      expect(agent.close, "坏会话应被关掉").toHaveBeenCalledTimes(1);
      expect(agentSessions.has(id), "坏会话应从表里摘掉").toBe(false);
      expect(runningTasks.has(id), "send 失败不该占位").toBe(false);
      expect(
        runningWrites(id),
        "send 失败路径根本不该走到「写 running」",
      ).toBe(0);
      expect(
        logs.error.some((args) => String(args[0]).includes("send 失败")),
        "应记 send 失败日志",
      ).toBe(true);
    },
    60_000,
  );
});
