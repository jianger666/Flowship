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
const { startChatFromQueuedMessage } = await import("@/lib/server/chat-queue-send-now");

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

// 第六轮评审 P3：「立即发送」走 resume 续接路径（有落盘锚点 → Agent.resume → sendChatMessage）送出后，要把这条操作结算成 handedOff。
// steer 路径（delivered）、新会话路径（runChatSession 的 settleFirstOp）都会结算；sendChatMessage 自己不认 clientItemId、不结算，
// 这条路径以前就停在 persisted（非终态），ledger 里查不到 delivered。用真实的 startChatFromQueuedMessage → resumeChatSession → sendChatMessage，只 mock SDK。
describe("第六轮评审 P3：send-now 的 resume 续接路径送出后结算成 handedOff", () => {
  it("Agent.resume + send 都成功：回 202（resumed）、ledger 里是 delivered，不是停在 persisted", async () => {
    const pending = makePendingSend();
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: pending.send,
    });
    await writeMeta(makeMeta(TASK_ID, AGENT_ID));

    const head: QueuedChatMsg = {
      itemId: "item_send_now_resume_1",
      agentText: "agent-hi",
      displayText: "user-hi",
      enqueuedAt: Date.now(),
      skipPersistEvent: true, // 入队方已落过 user_reply：不落事件、不打检查点，直接以它的内容续接
    };
    const res = await startChatFromQueuedMessage(TASK_ID, head, BOOT);

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, sentNow: true, resumed: true, itemId: head.itemId });
    expect(mockResume, "走的是 resume 续接，不是新建会话").toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(pending.send, "消息确实送给了 agent").toHaveBeenCalledTimes(1);
    expect(findRecentSettledEntry(TASK_ID, head.itemId)?.outcome).toBe("delivered");
  });
});
