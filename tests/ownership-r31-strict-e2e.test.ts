/**
 * R31 退出矩阵第 3、4 条：R30-3 strict 端到端 + R30-4 seq 恢复健壮化
 *
 * ① flushChatQueue 注入 EIO → 不 send、有警告事件、无「agent 收到但无记录」
 * ② 先落盘后 send 正常路径 + checkpoint 关联
 * ③ task-store 三客户端透传 persistWarning
 * ④ 末条 >64KB 单行 → 清 counter 模拟重启 → 新 seq > 旧 max
 * ⑤ 历史重号 [98,99,100,1] → 追加得 101
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r31-"));
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

const mockCaptureCheckpoint = vi.fn(async () => ({
  ok: true as boolean,
  repoSnapshots: [{ repoPath: "/tmp/fake-repo", treeOid: "oid_r31_abc" }],
  elapsedMsByRepo: { "/tmp/fake-repo": 1 },
  warnings: [] as string[],
}));
const mockPersistCheckpoint = vi.fn(async () => true);

vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint: (...args: unknown[]) =>
    mockCaptureCheckpoint(...(args as [])),
  persistCheckpointForReply: (...args: unknown[]) =>
    mockPersistCheckpoint(...(args as [])),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const {
  clearEventSeqCounter,
  EVENTS_FILE,
  readEvents,
  taskDir,
  writeMeta,
} = taskFsCore;
const { appendEvent } = await import("@/lib/server/task-fs");
const { writeEventAndPublish } = await import("@/lib/server/task-stream");
const {
  closeChatSessionUnconditional,
  flushChatQueue,
  hasChatSession,
  resumeChatSession,
} = await import("@/lib/server/chat-runner");
const {
  clearChatQueue,
  enqueueChatMessage,
  getChatQueueCount,
} = await import("@/lib/server/chat-queue");

const {
  sendChatReply,
  submitAskReply,
  submitTaskQuestion,
} = await import("@/lib/task-store");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r31 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001300_r31_e2e";
const AGENT_ID = "agent_fake_r31";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string, sessionAgentId?: string): TaskMetaV06 =>
  ({
    id,
    title: `r31 ${id}`,
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
  const resolveNext = () => {
    const resolve = resolvers.shift();
    if (!resolve) throw new Error("makePendingSend: 无挂起的 send");
    resolve(fakeRun);
  };
  return { send, resolveNext, fakeRun };
};

const eioErr = (): NodeJS.ErrnoException => {
  const err = new Error("simulated EIO") as NodeJS.ErrnoException;
  err.code = "EIO";
  return err;
};

/**
 * 对 events.jsonl 的前 `failCount` 次 append 注入 EIO（默认 1）。
 * 只打第一次 → user_reply strict 失败后，best-effort 警告事件仍能落盘。
 */
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

const readRawEvents = async (id: string): Promise<string> => {
  try {
    return await fs.readFile(path.join(taskDir(id), EVENTS_FILE), "utf-8");
  } catch {
    return "";
  }
};

beforeEach(async () => {
  mockCreate.mockReset();
  mockResume.mockReset();
  mockCaptureCheckpoint.mockClear();
  mockPersistCheckpoint.mockClear();
  mockCaptureCheckpoint.mockResolvedValue({
    ok: true,
    repoSnapshots: [{ repoPath: "/tmp/fake-repo", treeOid: "oid_r31_abc" }],
    elapsedMsByRepo: { "/tmp/fake-repo": 1 },
    warnings: [],
  });
  mockPersistCheckpoint.mockResolvedValue(true);
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

describe("R31 / R30-3：flushChatQueue 先落盘再 send", () => {
  it("注入 EIO → 不 send、有警告事件、无 user_reply、消息丢弃（不塞回忙等）", async () => {
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

    const displayText = "r31-eio-should-not-reach-agent";
    expect(
      enqueueChatMessage(TASK_ID, {
        agentText: displayText,
        displayText,
        enqueuedAt: Date.now(),
      }),
    ).toMatchObject({ ok: true });

    await withAppendEio(async () => {
      await flushChatQueue(TASK_ID);
    });

    // 关键断言：agent 绝不能收到
    expect(pending.send).not.toHaveBeenCalled();
    // 消息已丢弃（不塞回——避免持久 EIO 链式 flush 忙等）
    expect(getChatQueueCount(TASK_ID)).toBe(0);

    const raw = await readRawEvents(TASK_ID);
    // 原文不得以 user_reply 落盘；警告 info 可含前 50 字预览
    expect(raw).not.toMatch(
      new RegExp(`"kind":"user_reply"[^\\n]*${displayText}`),
    );
    expect(raw).toMatch(/消息保存失败、未发送/);
    const disk = await readEvents(TASK_ID);
    expect(disk.some((e) => e.kind === "user_reply")).toBe(false);
    expect(
      disk.some(
        (e) =>
          e.kind === "info" &&
          typeof e.text === "string" &&
          e.text.includes("消息保存失败、未发送"),
      ),
    ).toBe(true);
  });

  it("正常路径：先落盘 user_reply + checkpoint，再 send；checkpoint 绑 reply id", async () => {
    const pending = makePendingSend();
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: pending.send,
    });
    await writeMeta(makeMeta(TASK_ID, AGENT_ID));
    const task = asTask(makeMeta(TASK_ID, AGENT_ID));
    expect(await resumeChatSession(task, BOOT)).not.toBeNull();

    const displayText = "r31-happy-persist-then-send";
    expect(
      enqueueChatMessage(TASK_ID, {
        agentText: displayText,
        displayText,
        enqueuedAt: Date.now(),
      }),
    ).toMatchObject({ ok: true });

    const flushP = flushChatQueue(TASK_ID);
    await vi.waitFor(() => expect(pending.send).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
      interval: 20,
    });
    // send 被调用时 user_reply 必须已在盘上
    const eventsBeforeSendResolve = await readEvents(TASK_ID);
    const reply = eventsBeforeSendResolve.find(
      (e) => e.kind === "user_reply" && e.text === displayText,
    );
    expect(reply).toBeTruthy();
    expect(reply?.meta?.checkpointed).toBe(true);
    expect(mockPersistCheckpoint).toHaveBeenCalled();
    const persistArgs = mockPersistCheckpoint.mock.calls[0] as unknown[];
    expect(persistArgs[0]).toBe(TASK_ID);
    expect(persistArgs[1]).toBe(reply!.id);

    pending.resolveNext();
    await flushP;
    await vi.waitFor(() => expect(getChatQueueCount(TASK_ID)).toBe(0), {
      timeout: 5_000,
      interval: 20,
    });
    const prompts = pending.send.mock.calls.map((c) => String(c[0]));
    expect(prompts[0]).toContain(displayText);
  });
});

describe("R31 / R30-3：task-store 客户端透传 persistWarning", () => {
  const WARNING = "已送达但持久化失败";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sendChatReply 解析并透传 persistWarning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            task: { id: "t1", mode: "chat" },
            autoStarted: false,
            persistWarning: WARNING,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const result = await sendChatReply("t1", "hi");
    expect(result).toMatchObject({
      persistWarning: WARNING,
      autoStarted: false,
    });
    if ("queued" in result && result.queued) {
      throw new Error("不应走 queued 分支");
    }
    if ("settled" in result && result.settled) {
      throw new Error("不应走 settled 分支");
    }
    if (!("task" in result) || !result.task) {
      throw new Error("应返回 task");
    }
    expect(result.task.id).toBe("t1");
  });

  it("submitTaskQuestion 解析并透传 persistWarning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            task: { id: "t2", mode: "task" },
            persistWarning: WARNING,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const result = await submitTaskQuestion("t2", "问一句");
    expect(result.persistWarning).toBe(WARNING);
    expect(result.task.id).toBe("t2");
  });

  it("submitAskReply 解析并透传 persistWarning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            persistWarning: WARNING,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const result = await submitAskReply("t3", "ask_1", [
      { questionId: "q1", answer: "a" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.persistWarning).toBe(WARNING);
  });
});

describe("R31 / R30-4：seq 恢复求 durable max", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r31_seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  afterEach(async () => {
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
  });

  it("末条 >64KB 单行 → 清 counter 模拟重启 → 新 seq > 旧 max", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    // 先写一条短事件占 seq=1，再手写超大行 seq=2（模拟 tool_result）
    const e1 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r31-short-before-huge",
    });
    expect(e1?.seq).toBe(1);

    const hugePayload = "X".repeat(70 * 1024);
    const hugeLine = JSON.stringify({
      id: "ev_huge_r31",
      ts: Date.now(),
      kind: "tool_result",
      text: hugePayload,
      seq: 2,
    });
    expect(Buffer.byteLength(hugeLine, "utf-8")).toBeGreaterThan(64 * 1024);
    await fs.appendFile(
      path.join(taskDir(id), EVENTS_FILE),
      hugeLine + "\n",
      "utf-8",
    );

    // 模拟进程重启：counter 清空，须从 durable 扩块读到 seq=2
    clearEventSeqCounter(id);
    const e3 = await appendEvent(id, {
      kind: "info",
      text: "r31-after-huge-restart",
    });
    expect(e3?.seq).toBeGreaterThan(2);
    expect(e3!.seq).toBe(3);
  });

  it("历史重号 [98,99,100,1] → 恢复 max=100、追加得 101", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const lines = [98, 99, 100, 1].map((seq, i) =>
      JSON.stringify({
        id: `ev_renum_${seq}_${i}`,
        ts: Date.now() + i,
        kind: "info",
        text: `renum-${seq}`,
        seq,
      }),
    );
    await fs.writeFile(
      path.join(taskDir(id), EVENTS_FILE),
      lines.join("\n") + "\n",
      "utf-8",
    );

    clearEventSeqCounter(id);
    const next = await appendEvent(id, {
      kind: "info",
      text: "r31-after-renumber",
    });
    expect(next?.seq).toBe(101);
  });
});
