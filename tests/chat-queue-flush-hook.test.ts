/**
 * R1-13a：真链路 flushChatQueue → settleMessageHandedOff → emitQueuedMessageFlushed
 * （不 mock emit 本身；mock 的是 send 层）
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-flush-hook-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

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

vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint: async () => ({
    ok: false as boolean,
    repoSnapshots: [],
    elapsedMsByRepo: {},
    warnings: [] as string[],
  }),
  persistCheckpointForReply: async () => true,
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { taskDir, writeMeta } = taskFsCore;
const {
  closeChatSessionUnconditional,
  flushChatQueue,
  hasChatSession,
  resumeChatSession,
} = await import("@/lib/server/chat-runner");
const {
  clearChatQueue,
  enqueueChatMessage,
  findRecentSettledEntry,
  onQueuedMessageFlushed,
  __clearQueuedMessageFlushedListenersForTest,
} = await import("@/lib/server/chat-queue");
type QueuedChatMsg = import("@/lib/server/chat-queue").QueuedChatMsg;

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-queue-flush-hook DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001400_flush_hook";
const AGENT_ID = "agent_fake_flush_hook";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string, sessionAgentId?: string): TaskMetaV06 =>
  ({
    id,
    title: `flush-hook ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    events: [],
    repoPaths: [],
    mrs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(sessionAgentId ? { sessionAgentId } : {}),
  }) as TaskMetaV06;

const asTask = (meta: TaskMetaV06): Task =>
  ({
    ...meta,
    events: [],
    actions: meta.actions ?? [],
  }) as Task;

const makeFakeRun = () => ({
  stream: vi.fn(async function* (): AsyncGenerator<never> {
    /* 空 */
  }),
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

/** mock send 层：立刻返回可 wait 的假 run（flush 认 sent） */
const makePendingSend = () => {
  const fakeRun = makeFakeRun();
  const send = vi.fn().mockResolvedValue(fakeRun);
  return { send, fakeRun };
};

beforeEach(async () => {
  __clearQueuedMessageFlushedListenersForTest();
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  mockCreate.mockReset();
  mockResume.mockReset();
  // 等可能在途的 events 落盘后再清（防 ENOTEMPTY）
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(taskDir(TASK_ID), { recursive: true });
});

afterEach(async () => {
  __clearQueuedMessageFlushedListenersForTest();
  clearChatQueue(TASK_ID);
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("R1-13a：flushChatQueue 真链路触发 onQueuedMessageFlushed", () => {
  it("send===sent → settle handedOff 后钩子带 extraMeta 被调用", async () => {
    const pending = makePendingSend();
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: pending.send,
    });
    await writeMeta(makeMeta(TASK_ID, AGENT_ID));
    expect(await resumeChatSession(asTask(makeMeta(TASK_ID, AGENT_ID)), BOOT)).not.toBeNull();
    expect(hasChatSession(TASK_ID)).toBe(true);

    const seen: Array<{ taskId: string; msg: QueuedChatMsg }> = [];
    onQueuedMessageFlushed((taskId, msg) => {
      seen.push({ taskId, msg });
    });

    const enq = enqueueChatMessage(TASK_ID, {
      itemId: "item_flush_hook_1",
      agentText: "agent-hi",
      displayText: "user-hi",
      enqueuedAt: Date.now(),
      extraMeta: { feishuMessageId: "om_flush_x", source: "feishu" },
    });
    expect(enq).toMatchObject({ ok: true, itemId: "item_flush_hook_1" });

    await flushChatQueue(TASK_ID);

    expect(pending.send).toHaveBeenCalledTimes(1);
    expect(findRecentSettledEntry(TASK_ID, "item_flush_hook_1")?.outcome).toBe(
      "delivered",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.taskId).toBe(TASK_ID);
    expect(seen[0]!.msg.extraMeta).toMatchObject({
      feishuMessageId: "om_flush_x",
      source: "feishu",
    });
    expect(seen[0]!.msg.displayText).toBe("user-hi");
  });
});
