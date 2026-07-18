/**
 * S1 / S2：新会话启动 lease + 首包 create/send 后 cancelled/instanceId 复查
 *
 * S1：cancelChatStart 后 lease 失效；runChatSession 带失效 token 不注册、不 create。
 * S2：首包 send pending → forceClear + 实例 B → A 迟到 resolve 不得覆盖 B；
 *     create/send pending → stop → 不落 error、本地 agent 被 close。
 *
 * Mock 手法对齐 chat-runner-resume-owner.test.ts（挂起的 send promise、forceClear）。
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-start-lease-"));
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: vi.fn(),
  },
}));

// MCP / skills 热路径：避免真探测拖慢 / 不稳定
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
  forceClearChatRun,
  hasChatSession,
  runChatSession,
} = await import("@/lib/server/chat-runner");
const {
  cancelChatStart,
  clearChatGate,
  isChatStartLeaseValid,
  tryReserveChatStart,
} = await import("@/lib/server/chat-gate");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-runner-start-lease DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001100_start_lease";
const AGENT_A = "agent_fake_start_A";
const AGENT_B = "agent_fake_start_B";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `start lease ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

/** 可手动放行的挂起 send + 可断言的 fake run / close */
const makePendingSendAgent = (agentId: string) => {
  let resolveSend!: (run: unknown) => void;
  let rejectSend!: (err: unknown) => void;
  const gate = new Promise((resolve, reject) => {
    resolveSend = resolve;
    rejectSend = reject;
  });
  const fakeRun = {
    stream: vi.fn(async function* (): AsyncGenerator<never> {
      /* 空 */
    }),
    wait: vi.fn().mockResolvedValue({ status: "cancelled" as const }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const close = vi.fn().mockResolvedValue(undefined);
  const mockSend = vi.fn().mockImplementation(() => gate);
  return {
    agentId,
    close,
    send: mockSend,
    resolveSend,
    rejectSend,
    fakeRun,
  };
};

const readEvents = async (): Promise<Array<{ kind: string; text?: string }>> => {
  const p = path.join(taskDir(TASK_ID), "events.jsonl");
  try {
    const raw = await fs.readFile(p, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; text?: string });
  } catch {
    return [];
  }
};

beforeEach(async () => {
  mockCreate.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  clearChatGate(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
});

afterEach(async () => {
  closeChatSessionUnconditional(TASK_ID);
  clearChatGate(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("S1：启动 lease 失效拒绝 runChatSession", () => {
  it("cancelChatStart 后 isChatStartLeaseValid 为 false；带失效 token 不注册、不 create", async () => {
    const token = tryReserveChatStart(TASK_ID);
    expect(token).not.toBeNull();
    cancelChatStart(TASK_ID);
    expect(isChatStartLeaseValid(TASK_ID, token!)).toBe(false);

    const task = asTask(makeMeta(TASK_ID));
    const result = await runChatSession({
      task,
      ...BOOT,
      firstMessage: { text: "不应启动" },
      startToken: token!,
    });
    expect(result).toBe("lease_cancelled");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(false);
  });
});

describe("S2：首包 send pending × forceClear / stop", () => {
  it("send pending → forceClear + 实例 B → A resolve 不得覆盖 B、A 的 run.cancel/agent.close 被调", async () => {
    const pendingA = makePendingSendAgent(AGENT_A);
    const agentBClose = vi.fn().mockResolvedValue(undefined);
    const runB = {
      stream: vi.fn(async function* (): AsyncGenerator<never> {
        /* 立刻结束 */
      }),
      wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const sendB = vi.fn().mockResolvedValue(runB);

    mockCreate
      .mockResolvedValueOnce({
        agentId: AGENT_A,
        close: pendingA.close,
        send: pendingA.send,
      })
      .mockResolvedValueOnce({
        agentId: AGENT_B,
        close: agentBClose,
        send: sendB,
      });

    const task = asTask(makeMeta(TASK_ID));
    const startA = runChatSession({
      task,
      ...BOOT,
      firstMessage: { text: "A 首包" },
    });

    // 等到 A 卡住 send
    for (let i = 0; i < 50 && pendingA.send.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pendingA.send).toHaveBeenCalledTimes(1);
    expect(hasChatSession(TASK_ID)).toBe(true);

    // 懒重启兜底：forceClear 摘 A、实例 B 完整走完 create/send
    forceClearChatRun(TASK_ID);
    const startB = runChatSession({
      task,
      ...BOOT,
      firstMessage: { text: "B 首包" },
    });
    await startB;
    expect(hasChatSession(TASK_ID)).toBe(true);
    expect(sendB).toHaveBeenCalledTimes(1);

    // A 的 send 迟到 resolve
    pendingA.resolveSend(pendingA.fakeRun);
    await startA;

    // B 未被覆盖：落盘仍是 B；A 的迟到 run/agent 被丢弃
    expect(pendingA.fakeRun.cancel).toHaveBeenCalled();
    expect(pendingA.close).toHaveBeenCalled();
    expect(agentBClose).not.toHaveBeenCalled();
    expect(pendingA.fakeRun.stream).not.toHaveBeenCalled();
    const meta = await readMetaV06(TASK_ID);
    expect(meta?.sessionAgentId).toBe(AGENT_B);
    expect(hasChatSession(TASK_ID)).toBe(true);
  });

  it("send pending → stop（cancelled）→ resolve 后不落 error、runStatus 非 error、agent.close", async () => {
    const pending = makePendingSendAgent(AGENT_A);
    mockCreate.mockResolvedValue({
      agentId: AGENT_A,
      close: pending.close,
      send: pending.send,
    });

    const task = asTask(makeMeta(TASK_ID));
    const startPromise = runChatSession({
      task,
      ...BOOT,
      firstMessage: { text: "会被停止的首包" },
    });

    for (let i = 0; i < 50 && pending.send.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pending.send).toHaveBeenCalledTimes(1);

    expect(cancelChatRun(TASK_ID)).toBe(true);

    pending.resolveSend(pending.fakeRun);
    await startPromise;

    expect(pending.close).toHaveBeenCalled();
    expect(pending.fakeRun.cancel).toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(false);
    const meta = await readMetaV06(TASK_ID);
    expect(meta?.runStatus).not.toBe("error");
    const events = await readEvents();
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  it("send pending → stop 后 send reject → 仍不落 error（对齐 consumeChatRun cancelled 分流）", async () => {
    const pending = makePendingSendAgent(AGENT_A);
    mockCreate.mockResolvedValue({
      agentId: AGENT_A,
      close: pending.close,
      send: pending.send,
    });

    const task = asTask(makeMeta(TASK_ID));
    const startPromise = runChatSession({
      task,
      ...BOOT,
      firstMessage: { text: "抛错前被停止" },
    });

    for (let i = 0; i < 50 && pending.send.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(cancelChatRun(TASK_ID)).toBe(true);

    pending.rejectSend(new Error("network blip after stop"));
    await startPromise;

    expect(pending.close).toHaveBeenCalled();
    expect(hasChatSession(TASK_ID)).toBe(false);
    const meta = await readMetaV06(TASK_ID);
    expect(meta?.runStatus).not.toBe("error");
    const events = await readEvents();
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });
});
