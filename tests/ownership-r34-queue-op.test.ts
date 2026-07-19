/**
 * R33-1 / R33-7 QueueOperation 退出矩阵：
 * ① 挂起 chat-reply（failpoint）× stop / cancelled / error / 启动补偿
 *    → 终态先到、202 后到 → pending=0、每个已接受 item 恰一个可重放终态
 * ② SSE 断线错过 queue_failed → 重连 bootstrap recentSettled 对账清幽灵
 * ③ 两 tab 同文案互不误清（id 化）
 * ④ resetModules 同毫秒 enqueue → itemId 仍唯一（复刻 Codex 探针）
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
  allocClientChatQueueItemId,
  applyDoneClearPending,
  applyQueueFailedTerminal,
  applyUserReplyTerminal,
  dropPendingByItemId,
  reconcilePendingWithQueueState,
  shouldInsertPendingAfter202,
} from "@/lib/chat-pending-reconcile";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r34-qo-"));
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

vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint: async () => ({
    ok: true as boolean,
    repoSnapshots: [{ repoPath: "/tmp/fake-repo", treeOid: "oid_r34_qo" }],
    elapsedMsByRepo: { "/tmp/fake-repo": 1 },
    warnings: [] as string[],
  }),
  persistCheckpointForReply: async () => true,
}));

const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const taskFsCore = await import("@/lib/server/task-fs-core");
const { clearEventSeqCounter, taskDir, writeMeta } = taskFsCore;
const {
  closeChatSessionUnconditional,
  hasChatSession,
  resumeChatSession,
} = await import("@/lib/server/chat-runner");
const {
  allocChatQueueItemId,
  clearChatQueue,
  cleanupChatQueueState,
  enqueueChatMessage,
  failQueuedItems,
  listChatQueueItemIds,
  listRecentSettled,
  recordQueueItemSettled,
} = await import("@/lib/server/chat-queue");
const { subscribeTaskStream } = await import("@/lib/server/task-stream");
import type { TaskStreamEvent } from "@/lib/server/task-stream";
const { stopTaskAgent } = await import("@/lib/server/stop-task");

const { GET: watchTaskGet } = await import(
  "@/app/api/tasks/[id]/watch-task/route"
);
const { POST: chatReplyPost } = await import(
  "@/app/api/tasks/[id]/chat-reply/route"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r34-qo DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001340_r34_qo";
const AGENT_ID = "agent_fake_r34_qo";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string, sessionAgentId?: string): TaskMetaV06 =>
  ({
    id,
    title: `r34-qo ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "running",
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

/** 挂起 failpoint：命中后等 release */
const installHangingFailpoint = (name: string) => {
  let hitResolve!: () => void;
  const hit = new Promise<void>((r) => {
    hitResolve = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setFailpoint(name, async () => {
    hitResolve();
    await gate;
  });
  return { waitHit: () => hit, release: () => release() };
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

/**
 * R33-1 前端模拟：请求前登记 pending →（可选）终态/done/bootstrap → 202 后到。
 * 断言 pending=0 且 item 在 settled。
 */
const simulatePreRegisterThenTerminalThen202 = (
  itemId: string,
  applyTerminal: (pending: { itemId: string; displayText: string }[], settled: string[]) => {
    pending: { itemId: string; displayText: string }[];
    settled: string[];
  },
): { pending: { itemId: string; displayText: string }[]; settled: string[] } => {
  // 请求前登记
  let pending = [{ itemId, displayText: "hello" }];
  let settled: string[] = [];
  // 终态先到
  const mid = applyTerminal(pending, settled);
  pending = mid.pending;
  settled = mid.settled;
  // 202 后到：已 settled 不得再插
  if (shouldInsertPendingAfter202(settled, itemId)) {
    if (!pending.some((p) => p.itemId === itemId)) {
      pending = [...pending, { itemId, displayText: "hello" }];
    }
  } else {
    // 摘掉预登记（与 chat-view 202 路径一致）
    const dropped = dropPendingByItemId(pending, settled, itemId);
    pending = dropped.pending;
    settled = dropped.settled;
  }
  return { pending, settled };
};

beforeEach(async () => {
  clearFailpoints();
  // 含 recentSettled——clearChatQueue 只清 active，ledger 需 cleanup
  cleanupChatQueueState(TASK_ID);
  clearEventSeqCounter(TASK_ID);
  mockCreate.mockReset();
  mockResume.mockReset();
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeServerCreds();
  await writeMeta(makeMeta(TASK_ID, AGENT_ID));
});

afterEach(() => {
  clearFailpoints();
  closeChatSessionUnconditional(TASK_ID);
  cleanupChatQueueState(TASK_ID);
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("R33-1：挂起 202 × 旁路终态", () => {
  it("① stop：终态先到、202 后到 → pending=0 + recentSettled", async () => {
    const hang = installHangingFailpoint("chatReply.afterEnqueue");
    // 有会话 + 队非空 → chat-reply 直接 enqueueOrReject（不走 send）
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(makeFakeRun()),
    });
    const task = asTask(makeMeta(TASK_ID, AGENT_ID));
    await resumeChatSession(task, BOOT);
    expect(hasChatSession(TASK_ID)).toBe(true);
    enqueueChatMessage(TASK_ID, {
      itemId: "cq_preexisting",
      agentText: "pre",
      displayText: "pre",
      enqueuedAt: 1,
    });

    const clientItemId = "cq_stop_hang_1";
    const { events, unsub } = collectStream(TASK_ID);

    const replyPromise = chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "hang-then-stop",
          clientItemId,
          bootArgs: BOOT,
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );

    await hang.waitHit();
    // 入队已发生、202 未返回 —— 注入 stop
    expect(listChatQueueItemIds(TASK_ID)).toContain(clientItemId);
    await stopTaskAgent(asTask(makeMeta(TASK_ID, AGENT_ID)));

    const failed = events.filter((e) => e.kind === "queue_failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    const stopFailed = failed.find(
      (e) => e.kind === "queue_failed" && e.reason === "stopped",
    );
    expect(stopFailed).toBeTruthy();
    expect(stopFailed && stopFailed.kind === "queue_failed").toBe(true);
    if (!stopFailed || stopFailed.kind !== "queue_failed") {
      throw new Error("unreachable");
    }
    expect(stopFailed.itemIds).toContain(clientItemId);

    // ledger 可重放
    expect(
      listRecentSettled(TASK_ID).some((e) => e.itemId === clientItemId),
    ).toBe(true);

    // 放行 202
    hang.release();
    const res = await replyPromise;
    expect(res.status).toBe(202);
    const body = (await res.json()) as { itemId?: string };
    expect(body.itemId).toBe(clientItemId);

    // 前端：预登记 → queue_failed → 202
    const ui = simulatePreRegisterThenTerminalThen202(clientItemId, (p, s) =>
      applyQueueFailedTerminal(p, s, [clientItemId]),
    );
    expect(ui.pending).toHaveLength(0);
    expect(ui.settled).toContain(clientItemId);
    unsub();
  });

  it("① cancelled / error / startup_failed：failQueuedItems 各写 ledger", () => {
    for (const reason of ["cancelled", "error", "startup_failed"] as const) {
      clearChatQueue(TASK_ID);
      const id = `cq_${reason}_item`;
      enqueueChatMessage(TASK_ID, {
        itemId: id,
        agentText: reason,
        displayText: reason,
        enqueuedAt: 1,
      });
      const { events, unsub } = collectStream(TASK_ID);
      const failed = failQueuedItems(TASK_ID, { reason });
      expect(failed).toEqual([id]);
      expect(events.filter((e) => e.kind === "queue_failed")).toHaveLength(1);
      expect(listRecentSettled(TASK_ID)).toEqual(
        expect.arrayContaining([{ itemId: id, outcome: reason }]),
      );
      // 前端对账
      const ui = simulatePreRegisterThenTerminalThen202(id, (p, s) =>
        applyQueueFailedTerminal(p, s, failed),
      );
      expect(ui.pending).toHaveLength(0);
      unsub();
    }
  });

  it("① onDone 无终态 → 标 uncertain（不猜 delivered）", () => {
    // R36-2：done_clear 只清已有明确终态；无 outcome 保持可对账
    const itemId = "cq_done_settle";
    let pending: Array<{
      itemId: string;
      displayText: string;
      phase?: "sending" | "uncertain" | "persisted";
    }> = [{ itemId, displayText: "x" }];
    let settled: string[] = [];
    const done = applyDoneClearPending(pending, settled, {});
    pending = done.pending;
    settled = done.settled;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.phase).toBe("uncertain");
    expect(done.clearedIds).toHaveLength(0);
    expect(settled).not.toContain(itemId);
  });
});

describe("R33-1：SSE 断线 + recentSettled bootstrap", () => {
  it("② 错过 queue_failed → 重连 recentSettled 对账 → 晚到 202 不插", async () => {
    const itemId = "cq_reconnect_ghost";
    // 模拟：已接受并 fail，前端断线未收到 queue_failed，但请求前已登记 pending
    failQueuedItems(TASK_ID, { reason: "stopped" }); // 空
    enqueueChatMessage(TASK_ID, {
      itemId,
      agentText: "g",
      displayText: "g",
      enqueuedAt: 1,
    });
    failQueuedItems(TASK_ID, { reason: "stopped" });
    expect(listChatQueueItemIds(TASK_ID)).toEqual([]);
    expect(listRecentSettled(TASK_ID).some((e) => e.itemId === itemId)).toBe(
      true,
    );

    // 前端：有 pending、无 settled（错过帧）
    let pending = [{ itemId, displayText: "g" }];
    let settled: string[] = [];

    // 重连 bootstrap
    const ac = new AbortController();
    const res = await watchTaskGet(
      new Request(`http://local/api/tasks/${TASK_ID}/watch-task`, {
        headers: { Accept: "text/event-stream" },
        signal: ac.signal,
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let queueState: {
      type: string;
      itemIds?: string[];
      recentSettled?: Array<{ itemId: string; outcome: string }>;
    } | null = null;
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
        if (data) {
          try {
            const env = JSON.parse(data) as {
              type: string;
              itemIds?: string[];
              recentSettled?: Array<{ itemId: string; outcome: string }>;
            };
            if (env.type === "queue_state") {
              queueState = env;
              break;
            }
          } catch {
            /* ignore */
          }
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
    expect(queueState!.recentSettled?.some((e) => e.itemId === itemId)).toBe(
      true,
    );

    const r = reconcilePendingWithQueueState(
      pending,
      settled,
      queueState!.itemIds ?? [],
      queueState!.recentSettled ?? [],
    );
    pending = r.pending;
    settled = r.settled;
    expect(pending).toHaveLength(0);
    expect(settled).toContain(itemId);
    // 晚到 202
    expect(shouldInsertPendingAfter202(settled, itemId)).toBe(false);
  });

  it("② 纯函数：无 pending 时 recentSettled 仍记入 settled（挡未知晚到 202）", () => {
    const r = reconcilePendingWithQueueState(
      [],
      [],
      [],
      [{ itemId: "cq_early", outcome: "stopped" }],
    );
    expect(r.pending).toHaveLength(0);
    expect(r.settled).toContain("cq_early");
    expect(shouldInsertPendingAfter202(r.settled, "cq_early")).toBe(false);
  });
});

describe("R33-1：两 tab 同文案 id 化", () => {
  it("③ 同 displayText → user_reply / queue_failed 只动目标 item", () => {
    // R36-2：user_reply → persisted；queue_failed 才摘 pending
    const tabA: Array<{
      itemId: string;
      displayText: string;
      phase?: "sending" | "uncertain" | "persisted";
    }> = [{ itemId: "tab_a", displayText: "same" }];
    const tabB: Array<{
      itemId: string;
      displayText: string;
      phase?: "sending" | "uncertain" | "persisted";
    }> = [{ itemId: "tab_b", displayText: "same" }];
    const aUr = applyUserReplyTerminal(tabA, [], {
      text: "same",
      meta: { queueItemId: "tab_a" },
    }).pending;
    expect(aUr[0]?.phase).toBe("persisted");
    expect(
      applyUserReplyTerminal(tabB, [], {
        text: "same",
        meta: { queueItemId: "tab_a" },
      }).pending,
    ).toEqual(tabB);
    expect(applyQueueFailedTerminal(tabA, [], ["tab_a"]).pending).toEqual([]);
    expect(applyQueueFailedTerminal(tabB, [], ["tab_a"]).pending).toEqual(tabB);
  });

  it("③ clientItemId 预生成短 id 唯一前缀", () => {
    const a = allocClientChatQueueItemId();
    const b = allocClientChatQueueItemId();
    expect(a).toMatch(/^cq_[0-9a-f]{12}$/);
    expect(b).toMatch(/^cq_[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe("R33-7：发号器 globalThis + resetModules", () => {
  it("④ 同毫秒 + resetModules 后 enqueue itemId 仍唯一", async () => {
    const fixedNow = 1_700_000_001_340;
    const spy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);

    // 模块 A 入队
    const idA = allocChatQueueItemId();
    enqueueChatMessage(TASK_ID, {
      itemId: idA,
      agentText: "a",
      displayText: "a",
      enqueuedAt: fixedNow,
    });

    // 保留 global queue，重置模块本地绑定
    vi.resetModules();
    const queueB = await import("@/lib/server/chat-queue");
    // 同毫秒再发号 / 入队
    const idB = queueB.allocChatQueueItemId();
    const enq = queueB.enqueueChatMessage(TASK_ID, {
      agentText: "b",
      displayText: "b",
      enqueuedAt: fixedNow,
    });
    expect(enq.ok).toBe(true);
    if (!enq.ok) throw new Error("unreachable");

    expect(idA).not.toBe(idB);
    expect(idA).not.toBe(enq.itemId);
    expect(idB).not.toBe(enq.itemId);

    const ids = queueB.listChatQueueItemIds(TASK_ID);
    expect(new Set(ids).size).toBe(ids.length);
    // 同文案终态只影响目标
    queueB.failQueuedItems(TASK_ID, { reason: "stopped" });
    const settled = queueB.listRecentSettled(TASK_ID).map((e) => e.itemId);
    expect(settled).toEqual(expect.arrayContaining(ids));
    expect(new Set(settled).size).toBe(settled.length);

    spy.mockRestore();
    // resetModules 后重新绑定本文件用的 chat-queue（afterEach 清理）
    const queueAgain = await import("@/lib/server/chat-queue");
    queueAgain.clearChatQueue(TASK_ID);
  });

  it("④ delivered 记入 ledger", () => {
    cleanupChatQueueState(TASK_ID);
    recordQueueItemSettled(TASK_ID, "cq_deliv", "delivered");
    expect(listRecentSettled(TASK_ID)).toEqual([
      { itemId: "cq_deliv", outcome: "delivered" },
    ]);
    // 去重
    recordQueueItemSettled(TASK_ID, "cq_deliv", "stopped");
    expect(listRecentSettled(TASK_ID)).toHaveLength(1);
  });
});
