/**
 * R31-1 / 第 32 轮退出矩阵①：queue item 终态协议 + 前端 pending 对账
 *
 * ① 队列 B、C，B strict EIO → B/C 都有明确终态（count=0、queue_failed 含两 id、无 owner 滞留）
 * ② 前端 reducer 按 itemId 清 pending（纯函数单测）
 * ③ 持续 EIO（连续两轮 flush）→ 不自旋、有 queue_failed、payload 不静默丢
 * ④ 带 images/attachments 的消息同样按 id 对账
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
import {
  removePendingByQueueFailed,
  removePendingByUserReply,
} from "@/lib/chat-pending-reconcile";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r32-qf-"));
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
    ok: true as boolean,
    repoSnapshots: [{ repoPath: "/tmp/fake-repo", treeOid: "oid_r32_qf" }],
    elapsedMsByRepo: { "/tmp/fake-repo": 1 },
    warnings: [] as string[],
  }),
  persistCheckpointForReply: async () => true,
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { clearEventSeqCounter, taskDir, writeMeta } = taskFsCore;
const {
  closeChatSessionUnconditional,
  flushChatQueue,
  hasChatSession,
  isChatQueueDraining,
  isChatRunActive,
  resumeChatSession,
} = await import("@/lib/server/chat-runner");
const {
  clearChatQueue,
  enqueueChatMessage,
  getChatQueueCount,
} = await import("@/lib/server/chat-queue");
const { subscribeTaskStream } = await import("@/lib/server/task-stream");
import type { TaskStreamEvent } from "@/lib/server/task-stream";

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r32-qf DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001320_r32_qf";
const AGENT_ID = "agent_fake_r32_qf";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string, sessionAgentId?: string): TaskMetaV06 =>
  ({
    id,
    title: `r32-qf ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: ["/tmp/fake-repo"],
    sessionAgentId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

const makeFakeRun = () => ({
  stream: vi.fn(async function* (): AsyncGenerator<never> {
    /* 空 */
  }),
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  cancel: vi.fn().mockResolvedValue(undefined),
});

const makePendingSend = () => {
  const resolvers: Array<(run: unknown) => void> = [];
  const fakeRun = makeFakeRun();
  const send = vi.fn().mockImplementation(() => {
    return new Promise((resolve) => {
      resolvers.push(resolve);
    });
  });
  return { send, fakeRun, resolvers };
};

const eioErr = (): NodeJS.ErrnoException => {
  const err = new Error("simulated EIO") as NodeJS.ErrnoException;
  err.code = "EIO";
  return err;
};

/** 对 events.jsonl 的前 failCount 次 append 注入 EIO */
const withAppendEio = async <T,>(
  fn: () => Promise<T>,
  failCount = 1,
): Promise<T> => {
  const real = fs.appendFile.bind(fs);
  let remaining = failCount;
  const spy = vi.spyOn(fs, "appendFile").mockImplementation(async (p, data, enc) => {
    if (String(p).endsWith("events.jsonl") && remaining > 0) {
      remaining -= 1;
      throw eioErr();
    }
    return real(p, data, enc as BufferEncoding);
  });
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
};

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

const collectStream = (
  taskId: string,
): { events: TaskStreamEvent[]; unsub: () => void } => {
  const events: TaskStreamEvent[] = [];
  const unsub = subscribeTaskStream(taskId, (ev) => {
    events.push(ev);
  });
  return { events, unsub };
};

beforeEach(async () => {
  mockCreate.mockReset();
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  clearChatQueue(TASK_ID);
  await new Promise((r) => setTimeout(r, 20));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  await writeServerCreds();
});

afterEach(() => {
  closeChatSessionUnconditional(TASK_ID);
  clearChatQueue(TASK_ID);
  clearEventSeqCounter(TASK_ID);
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

const setupIdleSession = async () => {
  const pending = makePendingSend();
  mockResume.mockResolvedValue({
    agentId: AGENT_ID,
    close: vi.fn(),
    send: pending.send,
  });
  await writeMeta(makeMeta(TASK_ID, AGENT_ID));
  const task = asTask(makeMeta(TASK_ID, AGENT_ID));
  expect(await resumeChatSession(task, BOOT)).not.toBeNull();
  expect(hasChatSession(TASK_ID)).toBe(true);
  return pending;
};

describe("R31-1 / R32：队列终态 + queue_failed", () => {
  it("① B、C 队首 EIO → 整队清、queue_failed 含两 id、无 run/drain 滞留", async () => {
    const pending = await setupIdleSession();
    const { events, unsub } = collectStream(TASK_ID);

    const b = enqueueChatMessage(TASK_ID, {
      itemId: "item_b_r32",
      agentText: "msg-B",
      displayText: "msg-B",
      enqueuedAt: Date.now(),
    });
    const c = enqueueChatMessage(TASK_ID, {
      itemId: "item_c_r32",
      agentText: "msg-C",
      displayText: "msg-C",
      enqueuedAt: Date.now() + 1,
    });
    expect(b).toMatchObject({ ok: true, itemId: "item_b_r32" });
    expect(c).toMatchObject({ ok: true, itemId: "item_c_r32" });
    expect(getChatQueueCount(TASK_ID)).toBe(2);

    await withAppendEio(async () => {
      await flushChatQueue(TASK_ID);
    });

    expect(pending.send).not.toHaveBeenCalled();
    expect(getChatQueueCount(TASK_ID)).toBe(0);
    expect(isChatQueueDraining(TASK_ID)).toBe(false);
    expect(isChatRunActive(TASK_ID)).toBe(false);

    const failed = events.filter((e) => e.kind === "queue_failed");
    expect(failed).toHaveLength(1);
    if (failed[0]!.kind !== "queue_failed") throw new Error("unreachable");
    expect(failed[0].itemIds).toEqual(["item_b_r32", "item_c_r32"]);
    expect(failed[0].reason).toBe("persist_failed");

    unsub();
  });

  it("③ 持续 EIO：两轮 flush 有界、每轮均有 queue_failed、不静默丢", async () => {
    const pending = await setupIdleSession();
    const { events, unsub } = collectStream(TASK_ID);

    // 第一轮：B+C
    enqueueChatMessage(TASK_ID, {
      itemId: "round1_b",
      agentText: "r1b",
      displayText: "r1b",
      enqueuedAt: 1,
    });
    enqueueChatMessage(TASK_ID, {
      itemId: "round1_c",
      agentText: "r1c",
      displayText: "r1c",
      enqueuedAt: 2,
    });

    // failCount 很大：user_reply + best-effort 警告都写不上，控制帧仍须送达
    await withAppendEio(async () => {
      await flushChatQueue(TASK_ID);
    }, 50);

    expect(getChatQueueCount(TASK_ID)).toBe(0);
    expect(isChatQueueDraining(TASK_ID)).toBe(false);
    expect(pending.send).not.toHaveBeenCalled();

    // 第二轮：再入队后 flush（模拟用户重发 / 再次接受）
    enqueueChatMessage(TASK_ID, {
      itemId: "round2_d",
      agentText: "r2d",
      displayText: "r2d",
      enqueuedAt: 3,
    });
    await withAppendEio(async () => {
      await flushChatQueue(TASK_ID);
    }, 50);

    expect(getChatQueueCount(TASK_ID)).toBe(0);
    expect(isChatQueueDraining(TASK_ID)).toBe(false);
    expect(pending.send).not.toHaveBeenCalled();

    const failed = events.filter((e) => e.kind === "queue_failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({
      kind: "queue_failed",
      itemIds: ["round1_b", "round1_c"],
      reason: "persist_failed",
    });
    expect(failed[1]).toMatchObject({
      kind: "queue_failed",
      itemIds: ["round2_d"],
      reason: "persist_failed",
    });

    unsub();
  });

  it("④ 带 images/attachments 的消息按 itemId 进 queue_failed", async () => {
    const pending = await setupIdleSession();
    const { events, unsub } = collectStream(TASK_ID);

    const itemId = "item_with_media_r32";
    enqueueChatMessage(TASK_ID, {
      itemId,
      agentText: "see attach",
      displayText: "see attach",
      enqueuedAt: Date.now(),
      imageAbsPaths: ["/tmp/img.png"],
      savedImages: [
        {
          absPath: "/tmp/img.png",
          relPath: "attachments/img.png",
          mimeType: "image/png",
          bytes: 12,
        },
      ],
      attachmentAbsPaths: ["/tmp/a.pdf"],
      attachmentMetas: [
        {
          absPath: "/tmp/a.pdf",
          isDir: false,
          bytes: 34,
        },
      ],
    });

    await withAppendEio(async () => {
      await flushChatQueue(TASK_ID);
    });

    expect(pending.send).not.toHaveBeenCalled();
    expect(getChatQueueCount(TASK_ID)).toBe(0);
    const failed = events.filter((e) => e.kind === "queue_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      kind: "queue_failed",
      itemIds: [itemId],
      reason: "persist_failed",
    });

    unsub();
  });
});

describe("R31-1 / R32：前端 pending reducer 按 itemId 对账", () => {
  it("② queue_failed 按 itemIds 精确清除；无关 pending 保留", () => {
    const prev = [
      { itemId: "a", displayText: "A" },
      { itemId: "b", displayText: "B" },
      { itemId: "c", displayText: "C" },
    ];
    const next = removePendingByQueueFailed(prev, ["a", "c"]);
    expect(next).toEqual([{ itemId: "b", displayText: "B" }]);
  });

  it("② user_reply 优先按 meta.queueItemId；无 id 时 displayText 兜底", () => {
    const prev = [
      { itemId: "x1", displayText: "same-text" },
      { itemId: "x2", displayText: "same-text" },
    ];
    // 同文案两条：按 id 只清精确那条
    const byId = removePendingByUserReply(prev, {
      text: "same-text",
      meta: { queueItemId: "x2" },
    });
    expect(byId).toEqual([{ itemId: "x1", displayText: "same-text" }]);

    // 旧事件无 queueItemId：按文案清第一条匹配
    const byText = removePendingByUserReply(prev, { text: "same-text" });
    expect(byText).toEqual([{ itemId: "x2", displayText: "same-text" }]);
  });

  it("② 图/附件 pending 同样只靠 itemId（文案相同也不误伤）", () => {
    const prev = [
      {
        itemId: "img_a",
        displayText: "（附件）",
      },
      {
        itemId: "img_b",
        displayText: "（附件）",
      },
    ];
    const next = removePendingByQueueFailed(prev, ["img_b"]);
    expect(next).toEqual([{ itemId: "img_a", displayText: "（附件）" }]);
  });
});
