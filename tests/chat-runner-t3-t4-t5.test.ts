/**
 * T3 / T4 / T5（第十三轮验收）：
 * - T3：create pending → forceClear + B → A create resolve 不得 send
 * - T4：flushChatQueue single-flight，并发第二次直接 return、FIFO 不乱
 * - T5：重建 pending 时 stop → summarize_cancelled 且无 compact_done；
 *       重建失败 → restart_failed 且无 compact_done
 *
 * Mock 手法对齐 chat-runner-start-lease / compact-stop（挂起 promise、DATA_DIR 隔离）。
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
import type { Task } from "@/lib/types";
import { MIN_COMPACT_SUMMARY_CHARS } from "@/lib/server/chat-compact-prompt";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-t3-t4-t5-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FE_AI_FLOW_DATA_DIR = DATA_DIR;

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

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  cancelChatRun,
  closeChatSessionUnconditional,
  compactChatSession,
  CompactChatError,
  flushChatQueue,
  forceClearChatRun,
  hasChatSession,
  isChatCompactInProgress,
  isChatQueueDraining,
  resumeChatSession,
  runChatSession,
} = await import("@/lib/server/chat-runner");
const {
  clearChatQueue,
  enqueueChatMessage,
  getChatQueueCount,
} = await import("@/lib/server/chat-queue");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-runner-t3-t4-t5 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001200_t3_t4_t5";
const AGENT_A = "agent_fake_t3_A";
const AGENT_B = "agent_fake_t3_B";
const AGENT_COMPACT = "agent_fake_t5_compact";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string, sessionAgentId?: string): TaskMetaV06 =>
  ({
    id,
    title: `t3-t4-t5 ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

const makeFakeRun = (status: "finished" | "cancelled" = "finished") => ({
  stream: vi.fn(async function* (): AsyncGenerator<never> {
    /* 空 */
  }),
  wait: vi.fn().mockResolvedValue({ status }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/** 可多次挂起的 send：每次调用新开 gate，resolveNext 放行最早未决的一次 */
const makePendingSend = () => {
  const resolvers: Array<(run: unknown) => void> = [];
  const fakeRun = makeFakeRun();
  const send = vi.fn().mockImplementation(() => {
    return new Promise((resolve) => {
      resolvers.push(resolve);
    });
  });
  const resolveNext = () => {
    const resolve = resolvers.shift();
    if (!resolve) throw new Error("makePendingSend: 无挂起的 send");
    resolve(fakeRun);
  };
  return { send, resolveNext, fakeRun };
};

const LONG_SUMMARY = "摘要内容".repeat(
  Math.ceil(MIN_COMPACT_SUMMARY_CHARS / 4) + 10,
);
const SUMMARY_PAYLOAD = `<summary>${LONG_SUMMARY}</summary>`;

const makeSummaryRun = (text: string) => ({
  stream: async function* () {
    yield {
      type: "assistant" as const,
      message: { content: [{ type: "text" as const, text }] },
    };
  },
  wait: async () => ({ status: "finished" as const }),
  cancel: vi.fn(),
});

const writeServerCreds = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({
      apiKey: "server-key",
      defaultModel: { id: "gpt-test", params: [] },
    }),
    "utf-8",
  );
};

const readEventsLog = async (): Promise<string> => {
  try {
    return await fs.readFile(path.join(taskDir(TASK_ID), "events.jsonl"), "utf-8");
  } catch {
    return "";
  }
};

beforeEach(async () => {
  mockCreate.mockReset();
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  clearChatQueue(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  await writeServerCreds();
});

afterEach(async () => {
  closeChatSessionUnconditional(TASK_ID);
  clearChatQueue(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  expect(isChatCompactInProgress(TASK_ID)).toBe(false);
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("T3：create pending × forceClear 不得 send", () => {
  it("create pending → forceClear + B 完整启动 → A create resolve 不 send、close A、B 不受影响", async () => {
    let resolveCreateA!: (agent: unknown) => void;
    const createGateA = new Promise((resolve) => {
      resolveCreateA = resolve;
    });
    const closeA = vi.fn().mockResolvedValue(undefined);
    const sendA = vi.fn();
    const closeB = vi.fn().mockResolvedValue(undefined);
    const runB = makeFakeRun();
    const sendB = vi.fn().mockResolvedValue(runB);

    mockCreate
      .mockImplementationOnce(() => createGateA)
      .mockResolvedValueOnce({
        agentId: AGENT_B,
        close: closeB,
        send: sendB,
      });

    const task = asTask(makeMeta(TASK_ID));
    const startA = runChatSession({
      task,
      ...BOOT,
      firstMessage: { text: "A 首包" },
    });

    // 等到 A 卡在 Agent.create
    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
      interval: 20,
    });
    expect(hasChatSession(TASK_ID)).toBe(true);

    // 懒重启：摘 A 占位、B 完整 create/send
    forceClearChatRun(TASK_ID);
    expect(hasChatSession(TASK_ID)).toBe(false);

    const startB = runChatSession({
      task,
      ...BOOT,
      firstMessage: { text: "B 首包" },
    });
    await startB;
    expect(hasChatSession(TASK_ID)).toBe(true);
    expect(sendB).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // A 的 create 迟到 resolve——绝不能 send
    resolveCreateA({
      agentId: AGENT_A,
      close: closeA,
      send: sendA,
    });
    await startA;

    expect(sendA).not.toHaveBeenCalled();
    expect(closeA).toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(true);
    const meta = await readMetaV06(TASK_ID);
    expect(meta?.sessionAgentId).toBe(AGENT_B);
  });
});

describe("T4：flushChatQueue single-flight", () => {
  it(
    "第一条 send 挂起时并发第二次 flush 直接返回，消息 2 未 dequeue、发送顺序 1→2",
    async () => {
    const pending = makePendingSend();
    mockResume.mockResolvedValue({
      agentId: AGENT_B,
      close: vi.fn(),
      send: pending.send,
    });

    await writeMeta(makeMeta(TASK_ID, AGENT_B));
    const task = asTask(makeMeta(TASK_ID, AGENT_B));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();
    expect(hasChatSession(TASK_ID)).toBe(true);

    expect(
      enqueueChatMessage(TASK_ID, {
        agentText: "msg-1",
        displayText: "msg-1",
        enqueuedAt: 1,
      }),
    ).toMatchObject({ ok: true });
    expect(
      enqueueChatMessage(TASK_ID, {
        agentText: "msg-2",
        displayText: "msg-2",
        enqueuedAt: 2,
      }),
    ).toMatchObject({ ok: true });
    expect(getChatQueueCount(TASK_ID)).toBe(2);

    const flush1 = flushChatQueue(TASK_ID);
    await vi.waitFor(() => expect(pending.send).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
      interval: 20,
    });
    expect(isChatQueueDraining(TASK_ID)).toBe(true);
    // 消息 1 已 dequeue，消息 2 仍在队
    expect(getChatQueueCount(TASK_ID)).toBe(1);

    // 并发第二次：single-flight 应立刻 return，不得再 dequeue
    const flush2Done = await Promise.race([
      flushChatQueue(TASK_ID).then(() => "returned"),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200)),
    ]);
    expect(flush2Done).toBe("returned");
    expect(getChatQueueCount(TASK_ID)).toBe(1);
    expect(pending.send).toHaveBeenCalledTimes(1);
    expect(isChatQueueDraining(TASK_ID)).toBe(true);

    // 放行消息 1；flush1 finally 续 drain（或 consume 链式 flush）会取消息 2
    pending.resolveNext();
    await flush1;

    await vi.waitFor(() => expect(pending.send).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
      interval: 20,
    });
    const prompts = pending.send.mock.calls.map((c) => String(c[0]));
    expect(prompts[0]).toContain("msg-1");
    expect(prompts[1]).toContain("msg-2");
    pending.resolveNext();
    await vi.waitFor(() => {
      expect(getChatQueueCount(TASK_ID)).toBe(0);
      expect(isChatQueueDraining(TASK_ID)).toBe(false);
    }, {
      timeout: 5_000,
      interval: 20,
    });
    },
    15_000,
  );
});

describe("T5：compact 重建成功前不写 done；stop/失败口径", () => {
  it("重建 runChatSession（create）pending 时 cancel → summarize_cancelled 且无 compact_done", async () => {
    const mockSend = vi
      .fn()
      .mockResolvedValue(makeSummaryRun(SUMMARY_PAYLOAD));
    mockResume.mockResolvedValue({
      agentId: AGENT_COMPACT,
      close: vi.fn(),
      send: mockSend,
    });

    let resolveCreate!: (agent: unknown) => void;
    const createGate = new Promise((resolve) => {
      resolveCreate = resolve;
    });
    const closeNew = vi.fn().mockResolvedValue(undefined);
    const sendNew = vi.fn();
    mockCreate.mockImplementationOnce(() => createGate);

    await writeMeta(makeMeta(TASK_ID, AGENT_COMPACT));
    const task = asTask(makeMeta(TASK_ID, AGENT_COMPACT));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();

    const compactP = compactChatSession(TASK_ID);
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
      interval: 20,
    });
    // 摘要成功后重建 create 挂起
    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
      interval: 20,
    });

    // 此时不得已写成功事件
    expect(await readEventsLog()).not.toContain("compact_done");
    expect(await readEventsLog()).not.toContain('"kind":"compact_summary"');

    expect(cancelChatRun(TASK_ID)).toBe(true);

    // 放行迟到 create（cancelled/instance 复查应丢弃）
    resolveCreate({
      agentId: "agent_fake_restart",
      close: closeNew,
      send: sendNew,
    });

    let err: unknown;
    try {
      await compactP;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CompactChatError);
    expect((err as InstanceType<typeof CompactChatError>).code).toBe(
      "summarize_cancelled",
    );

    const log = await readEventsLog();
    expect(log).not.toContain("compact_done");
    expect(log).not.toContain('"kind":"compact_summary"');
    expect(sendNew).not.toHaveBeenCalled();
  });

  it("重建失败（create 抛错）→ restart_failed 且无 compact_done", async () => {
    const mockSend = vi
      .fn()
      .mockResolvedValue(makeSummaryRun(SUMMARY_PAYLOAD));
    mockResume.mockResolvedValue({
      agentId: AGENT_COMPACT,
      close: vi.fn(),
      send: mockSend,
    });
    mockCreate.mockRejectedValueOnce(new Error("create boom"));

    await writeMeta(makeMeta(TASK_ID, AGENT_COMPACT));
    const task = asTask(makeMeta(TASK_ID, AGENT_COMPACT));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();

    let err: unknown;
    try {
      await compactChatSession(TASK_ID);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CompactChatError);
    expect((err as InstanceType<typeof CompactChatError>).code).toBe(
      "restart_failed",
    );

    const log = await readEventsLog();
    expect(log).not.toContain("compact_done");
    expect(log).not.toContain('"kind":"compact_summary"');
    expect(hasChatSession(TASK_ID)).toBe(false);
  });
});
