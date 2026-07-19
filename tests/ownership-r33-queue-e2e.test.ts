/**
 * R32-1 / R32-2 / 第三十三轮退出矩阵①②：
 * ① enqueue → SSE 终态先发 → 202 后到（settledItemIds）；success / EIO 各一组
 * ② no-session / replyEvent=null / checkpoint throw / send throw → 每个已 202 item 恰有一个 id 化终态
 * ③ 两 tab 同文案 → queue-priority head 带 queueItemId、互不清错
 * ④ SSE 重连 bootstrap queue_state 对账清幽灵 pending
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
  applyQueueFailedTerminal,
  applyUserReplyTerminal,
  reconcilePendingWithQueueState,
  shouldInsertPendingAfter202,
} from "@/lib/chat-pending-reconcile";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r33-qe-"));
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

const mockPersistCheckpoint = vi.fn(async () => true);
vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint: async () => ({
    ok: true as boolean,
    repoSnapshots: [{ repoPath: "/tmp/fake-repo", treeOid: "oid_r33_qe" }],
    elapsedMsByRepo: { "/tmp/fake-repo": 1 },
    warnings: [] as string[],
  }),
  persistCheckpointForReply: (...args: unknown[]) =>
    mockPersistCheckpoint(...(args as [])),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { clearEventSeqCounter, readEvents, taskDir, writeMeta } = taskFsCore;
const {
  closeChatSessionUnconditional,
  flushChatQueue,
  hasChatSession,
  resumeChatSession,
} = await import("@/lib/server/chat-runner");
const {
  clearChatQueue,
  enqueueChatMessage,
  failQueuedItems,
  getChatQueueCount,
  listChatQueueItemIds,
  beginChatQueueInFlight,
  endChatQueueInFlight,
  dequeueChatMessage,
} = await import("@/lib/server/chat-queue");
const { subscribeTaskStream } = await import("@/lib/server/task-stream");
import type { TaskStreamEvent } from "@/lib/server/task-stream";

const { GET: watchTaskGet } = await import(
  "@/app/api/tasks/[id]/watch-task/route"
);
const { POST: chatReplyPost } = await import(
  "@/app/api/tasks/[id]/chat-reply/route"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r33-qe DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001330_r33_qe";
const AGENT_ID = "agent_fake_r33_qe";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string, sessionAgentId?: string): TaskMetaV06 =>
  ({
    id,
    title: `r33-qe ${id}`,
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

/** 模拟前端：SSE 终态先到 → 再处理 202 插 pending */
const simulateSseThen202 = (
  itemId: string,
  terminal:
    | { kind: "user_reply"; text: string }
    | { kind: "queue_failed"; itemIds: string[] },
): { pending: Array<{ itemId: string; displayText: string }>; settled: string[] } => {
  let pending: Array<{ itemId: string; displayText: string }> = [];
  let settled: string[] = [];
  if (terminal.kind === "user_reply") {
    const r = applyUserReplyTerminal(pending, settled, {
      text: terminal.text,
      meta: { queueItemId: itemId },
    });
    pending = r.pending;
    settled = r.settled;
  } else {
    const r = applyQueueFailedTerminal(pending, settled, terminal.itemIds);
    pending = r.pending;
    settled = r.settled;
  }
  // 202 后到：已 settled 则不插
  if (shouldInsertPendingAfter202(settled, itemId)) {
    pending = [...pending, { itemId, displayText: "late" }];
  }
  return { pending, settled };
};

beforeEach(async () => {
  mockCreate.mockReset();
  mockResume.mockReset();
  mockPersistCheckpoint.mockReset();
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

describe("R32-1：SSE 终态早于 202 → settledItemIds 不插永久 pending", () => {
  it("① success：user_reply 先到 → 非终态（persisted）；queue_failed 仍可终态清零", () => {
    // R36-2：user_reply 不再记 settled/delivered；仅 queue_failed 等真终态挡 202
    const { pending, settled } = simulateSseThen202("cq_success", {
      kind: "user_reply",
      text: "hello",
    });
    // 空 pending 上 user_reply 无法标 persisted；settled 也不占坑 → 202 仍可插
    expect(settled).not.toContain("cq_success");
    expect(pending).toHaveLength(1);
  });

  it("① EIO：queue_failed 先到 → 202 后到 → pending=0", () => {
    const { pending, settled } = simulateSseThen202("cq_eio", {
      kind: "queue_failed",
      itemIds: ["cq_eio"],
    });
    expect(settled).toContain("cq_eio");
    expect(pending).toHaveLength(0);
  });

  it("① server 事件序：enqueue 后 flush EIO → 先有 queue_failed（模拟 202 前终态）", async () => {
    await setupIdleSession();
    const { events, unsub } = collectStream(TASK_ID);
    const enq = enqueueChatMessage(TASK_ID, {
      itemId: "item_before_202",
      agentText: "x",
      displayText: "x",
      enqueuedAt: Date.now(),
    });
    expect(enq).toMatchObject({ ok: true, itemId: "item_before_202" });

    await withAppendEio(async () => {
      await flushChatQueue(TASK_ID);
    });

    const failed = events.filter((e) => e.kind === "queue_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      kind: "queue_failed",
      itemIds: ["item_before_202"],
      reason: "persist_failed",
    });
    // 前端对账：终态先记账 → 假想 202 不得插 pending
    const ui = simulateSseThen202("item_before_202", {
      kind: "queue_failed",
      itemIds: ["item_before_202"],
    });
    expect(ui.pending).toHaveLength(0);
    unsub();
  });
});

describe("R32-2：全部清队路径走 failQueuedItems", () => {
  it("② no_session → queue_failed(reason=no_session)，含当前条", async () => {
    await setupIdleSession();
    closeChatSessionUnconditional(TASK_ID);
    expect(hasChatSession(TASK_ID)).toBe(false);

    const { events, unsub } = collectStream(TASK_ID);
    enqueueChatMessage(TASK_ID, {
      itemId: "ns_a",
      agentText: "a",
      displayText: "a",
      enqueuedAt: 1,
    });
    enqueueChatMessage(TASK_ID, {
      itemId: "ns_b",
      agentText: "b",
      displayText: "b",
      enqueuedAt: 2,
    });

    await flushChatQueue(TASK_ID);

    expect(getChatQueueCount(TASK_ID)).toBe(0);
    const failed = events.filter((e) => e.kind === "queue_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      kind: "queue_failed",
      reason: "no_session",
    });
    if (failed[0]!.kind !== "queue_failed") throw new Error("unreachable");
    expect(failed[0].itemIds).toEqual(["ns_a", "ns_b"]);
    unsub();
  });

  it("② replyEvent=null（任务目录消失）→ queue_failed(task_gone)", async () => {
    await setupIdleSession();
    const { events, unsub } = collectStream(TASK_ID);
    enqueueChatMessage(TASK_ID, {
      itemId: "gone_a",
      agentText: "a",
      displayText: "a",
      enqueuedAt: 1,
    });
    enqueueChatMessage(TASK_ID, {
      itemId: "gone_b",
      agentText: "b",
      displayText: "b",
      enqueuedAt: 2,
    });

    // flush 内 getTask 后、落盘前删目录 → append ENOENT → replyEvent=null
    const realGetTask = (await import("@/lib/server/task-fs")).getTask;
    const spy = vi
      .spyOn(await import("@/lib/server/task-fs"), "getTask")
      .mockImplementation(async (id: string) => {
        const t = await realGetTask(id);
        if (id === TASK_ID && t) {
          await fs.rm(taskDir(TASK_ID), { recursive: true, force: true });
        }
        return t;
      });

    try {
      await flushChatQueue(TASK_ID);
    } finally {
      spy.mockRestore();
    }

    expect(getChatQueueCount(TASK_ID)).toBe(0);
    const failed = events.filter((e) => e.kind === "queue_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      kind: "queue_failed",
      reason: "task_gone",
      itemIds: ["gone_a", "gone_b"],
    });
    unsub();
  });

  it("② checkpoint throw：仅 persisted 未 handoff → head+tail 均 queue_failed（R35-6）", async () => {
    await setupIdleSession();
    const { events, unsub } = collectStream(TASK_ID);
    enqueueChatMessage(TASK_ID, {
      itemId: "cp_head",
      agentText: "head",
      displayText: "head",
      enqueuedAt: 1,
    });
    enqueueChatMessage(TASK_ID, {
      itemId: "cp_tail",
      agentText: "tail",
      displayText: "tail",
      enqueuedAt: 2,
    });

    mockPersistCheckpoint.mockRejectedValueOnce(new Error("checkpoint boom"));

    await flushChatQueue(TASK_ID);

    expect(getChatQueueCount(TASK_ID)).toBe(0);
    const failed = events.filter((e) => e.kind === "queue_failed");
    expect(failed).toHaveLength(1);
    // R35-6：有气泡但 agent 未接管 → head 也进 failed（禁止当 delivered）
    expect(failed[0]).toMatchObject({
      kind: "queue_failed",
      reason: "flush_error",
      itemIds: ["cp_head", "cp_tail"],
    });
    const persisted = events.filter(
      (e) => e.kind === "event" && e.event.kind === "user_reply",
    );
    expect(persisted.length).toBeGreaterThanOrEqual(1);
    unsub();
  });

  it("② send 后置异常：setTaskRunStatus throw → agent 已受理仍 handedOff，只 fail 尾队列", async () => {
    // R35-6：agent.send 成功后 status 写失败仍返 sent；flush 记 handedOff，尾队列才 failed
    const pending = await setupIdleSession();
    pending.send.mockResolvedValue(pending.fakeRun);
    const { events, unsub } = collectStream(TASK_ID);
    enqueueChatMessage(TASK_ID, {
      itemId: "send_head",
      agentText: "head",
      displayText: "head",
      enqueuedAt: 1,
    });
    enqueueChatMessage(TASK_ID, {
      itemId: "send_tail",
      agentText: "tail",
      displayText: "tail",
      enqueuedAt: 2,
    });

    const taskFs = await import("@/lib/server/task-fs");
    const spy = vi
      .spyOn(taskFs, "setTaskRunStatus")
      .mockRejectedValueOnce(new Error("status boom"));

    try {
      await flushChatQueue(TASK_ID);
    } finally {
      spy.mockRestore();
    }

    // head 已 handedOff；尾队列可能被链式 flush 发出或仍在——关键是 head 不进 queue_failed
    const failed = events.filter((e) => e.kind === "queue_failed");
    for (const ev of failed) {
      if (ev.kind === "queue_failed") {
        expect(ev.itemIds).not.toContain("send_head");
      }
    }
    unsub();
  });

  it("failQueuedItems 契约：currentHandedOff 时当前条不进 failed（R35-6）", () => {
    const { events, unsub } = collectStream(TASK_ID);
    enqueueChatMessage(TASK_ID, {
      itemId: "rest_1",
      agentText: "r",
      displayText: "r",
      enqueuedAt: 1,
    });
    // R35-6：仅真 handoff 豁免；旧 currentReplyPersisted（仅气泡）不再豁免
    const failed = failQueuedItems(TASK_ID, {
      reason: "flush_error",
      currentItemId: "already_ok",
      currentHandedOff: true,
    });
    expect(failed).toEqual(["rest_1"]);
    expect(events.filter((e) => e.kind === "queue_failed")).toHaveLength(1);
    unsub();
  });
});

describe("R32-2：两 tab 同文案 + queue-priority head 带 id", () => {
  it("③ 前端：同 displayText 两条 → user_reply 带 id 只标精确那条 persisted", () => {
    // R36-2：user_reply 非终态——标 persisted，不摘 pending
    const tabA: Array<{
      itemId: string;
      displayText: string;
      phase?: "sending" | "uncertain" | "persisted";
    }> = [{ itemId: "tab_a", displayText: "same-text" }];
    const tabB: Array<{
      itemId: string;
      displayText: string;
      phase?: "sending" | "uncertain" | "persisted";
    }> = [{ itemId: "tab_b", displayText: "same-text" }];
    const ev = {
      text: "same-text",
      meta: { queueItemId: "tab_a" },
    };
    const a = applyUserReplyTerminal(tabA, [], ev).pending;
    expect(a).toHaveLength(1);
    expect(a[0]?.itemId).toBe("tab_a");
    expect(a[0]?.phase).toBe("persisted");
    expect(applyUserReplyTerminal(tabB, [], ev).pending).toEqual(tabB);
  });

  it("③ queue-priority 启动 head 的 user_reply 带 meta.queueItemId", async () => {
    // 无会话 + 队非空 → chat-reply 走队列优先启动
    mockCreate.mockResolvedValue({
      agentId: "agent_qp_r33",
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(makeFakeRun()),
    });

    const headId = "qp_head_item";
    enqueueChatMessage(TASK_ID, {
      itemId: headId,
      agentText: "same-text",
      displayText: "same-text",
      enqueuedAt: 1,
    });
    // 当前请求再入一条同文案（另一 tab）
    const req = new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "same-text",
        bootArgs: BOOT,
      }),
    });
    const res = await chatReplyPost(req, {
      params: Promise.resolve({ id: TASK_ID }),
    });
    // 202 queued（当前条入队）或 200（若走了同步路径）——关键是 head 落盘带 id
    expect([200, 202]).toContain(res.status);

    const events = await readEvents(TASK_ID);
    const replies = events.filter((e) => e.kind === "user_reply");
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const headReply = replies.find(
      (e) => e.meta && (e.meta as { queueItemId?: string }).queueItemId === headId,
    );
    expect(headReply).toBeTruthy();
    expect(headReply!.meta).toMatchObject({ queueItemId: headId });
  });
});

describe("R32-2：SSE bootstrap queue_state 对账", () => {
  it("④ listChatQueueItemIds 含队内 + in-flight", () => {
    enqueueChatMessage(TASK_ID, {
      itemId: "q1",
      agentText: "1",
      displayText: "1",
      enqueuedAt: 1,
    });
    const deq = dequeueChatMessage(TASK_ID);
    expect(deq?.itemId).toBe("q1");
    beginChatQueueInFlight(TASK_ID, "q1");
    enqueueChatMessage(TASK_ID, {
      itemId: "q2",
      agentText: "2",
      displayText: "2",
      enqueuedAt: 2,
    });
    expect(listChatQueueItemIds(TASK_ID)).toEqual(["q1", "q2"]);
    endChatQueueInFlight(TASK_ID);
    clearChatQueue(TASK_ID);
  });

  it("④ reconcile：不在 server 集合且无终态 → ghost 标 uncertain（不写 delivered）", () => {
    // R36-4：无 snapshot 证据不得推导 delivered / settled
    const pending: Array<{
      itemId: string;
      displayText: string;
      phase?: "sending" | "uncertain" | "persisted";
    }> = [
      { itemId: "alive", displayText: "ok" },
      { itemId: "ghost", displayText: "gone" },
    ];
    const r = reconcilePendingWithQueueState(pending, [], ["alive"]);
    expect(r.pending.map((p) => p.itemId)).toEqual(["alive", "ghost"]);
    expect(r.pending.find((p) => p.itemId === "ghost")?.phase).toBe(
      "uncertain",
    );
    expect(r.ghostIds).toEqual(["ghost"]);
    expect(r.settled).not.toContain("ghost");
  });

  it("④ watch-task bootstrap 发出 queue_state", async () => {
    await writeMeta(makeMeta(TASK_ID));
    enqueueChatMessage(TASK_ID, {
      itemId: "boot_q",
      agentText: "b",
      displayText: "b",
      enqueuedAt: 1,
    });

    const ac = new AbortController();
    const res = await watchTaskGet(
      new Request(`http://local/api/tasks/${TASK_ID}/watch-task`, {
        headers: { Accept: "text/event-stream" },
        signal: ac.signal,
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let queueState: { type: string; itemIds?: string[] } | null = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !queueState) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) {
          sep = buf.indexOf("\n\n");
          continue;
        }
        try {
          const env = JSON.parse(data) as {
            type: string;
            itemIds?: string[];
          };
          if (env.type === "queue_state") {
            queueState = env;
            break;
          }
        } catch {
          /* 非 JSON 帧忽略 */
        }
        sep = buf.indexOf("\n\n");
      }
    }
    ac.abort();
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }

    expect(queueState).toBeTruthy();
    expect(queueState!.itemIds).toContain("boot_q");
  });
});
