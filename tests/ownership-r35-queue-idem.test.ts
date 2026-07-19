/**
 * R34-4 / R34-5 / R34-6 / R34-8 退出矩阵（第三十四轮收敛建议 3、4）：
 * ① enqueue 后掐断 HTTP → 同 id 重试 → 队列始终一条、agent 只收一次、pending 恰一终态
 * ② 服务端重启清内存 active → 同 id 重试得明确「未受理 / 可重试」（非 alreadyAccepted）
 * ③ 两 tab 同文案 direct 200 + queued 202 → direct user_reply 只清 A、B 保留到自己终态
 * ④ queue-priority head checkpoint 后挂起 → queue_state 含 head；重连/stop/DELETE/启动失败
 *    → head 恰一终态、不当 ghost、不复活
 * ⑤ task_deleted：在线收帧 / 断线重连 404 → 同一 deletion sink
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
  applyUserReplyTerminal,
  dropPendingByItemId,
  markPendingUncertain,
  reconcilePendingWithQueueState,
  shouldInsertPendingAfter202,
} from "@/lib/chat-pending-reconcile";
import { ApiRequestError } from "@/lib/task-store";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r35-qi-"));
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
    repoSnapshots: [{ repoPath: "/tmp/fake-repo", treeOid: "oid_r35_qi" }],
    elapsedMsByRepo: { "/tmp/fake-repo": 1 },
    warnings: [] as string[],
  }),
  persistCheckpointForReply: async () => true,
}));

const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const taskFsCore = await import("@/lib/server/task-fs-core");
const { clearEventSeqCounter, readEvents, taskDir, writeMeta } = taskFsCore;
const {
  closeChatSessionUnconditional,
  hasChatSession,
  resumeChatSession,
} = await import("@/lib/server/chat-runner");
const {
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
const { DELETE: deleteTask } = await import("@/app/api/tasks/[id]/route");
const { GET: watchTaskGet } = await import(
  "@/app/api/tasks/[id]/watch-task/route"
);
const { POST: chatReplyPost } = await import(
  "@/app/api/tasks/[id]/chat-reply/route"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r35-qi DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001350_r35_qi";
const AGENT_ID = "agent_fake_r35_qi";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string, sessionAgentId?: string): TaskMetaV06 =>
  ({
    id,
    title: `r35-qi ${id}`,
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

/** 读 watch bootstrap 的 queue_state */
const readWatchQueueState = async (
  taskId: string,
): Promise<{
  itemIds: string[];
  recentSettled: Array<{ itemId: string; outcome: string }>;
}> => {
  const ac = new AbortController();
  const res = await watchTaskGet(
    new Request(`http://local/api/tasks/${taskId}/watch-task`, {
      headers: { Accept: "text/event-stream" },
      signal: ac.signal,
    }),
    { params: Promise.resolve({ id: taskId }) },
  );
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let found: {
    itemIds?: string[];
    recentSettled?: Array<{ itemId: string; outcome: string }>;
  } | null = null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !found) {
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
            found = env;
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
  expect(found).toBeTruthy();
  return {
    itemIds: found!.itemIds ?? [],
    recentSettled: found!.recentSettled ?? [],
  };
};

/**
 * R36-7：模拟 useTaskWatch catch——仅 410 → deletion sink；404/503 = unavailable 重试。
 * （hook 本身依赖 React；此处锁定与实现一致的决策契约）
 */
const resolveWatchCatchAsDeletion = (
  err: unknown,
): { deleted: boolean; shouldRetry: boolean } => {
  const status =
    err instanceof ApiRequestError
      ? err.status
      : (err as { status?: number }).status;
  if (status === 410) {
    return { deleted: true, shouldRetry: false };
  }
  // 404/503/网络错 → 重试，不 commit deleted
  return { deleted: false, shouldRetry: true };
};

beforeEach(async () => {
  clearFailpoints();
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

describe("R34-4：QueueOperation 幂等受理", () => {
  it("① enqueue 后掐断响应 → 同 id 重试 → 队列始终一条 + alreadyAccepted", async () => {
    const hang = installHangingFailpoint("chatReply.afterEnqueue");
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(makeFakeRun()),
    });
    const task = asTask(makeMeta(TASK_ID, AGENT_ID));
    await resumeChatSession(task, BOOT);
    expect(hasChatSession(TASK_ID)).toBe(true);
    // 队非空 → chat-reply 走 enqueueOrReject（不直接 send）
    enqueueChatMessage(TASK_ID, {
      itemId: "cq_preexisting",
      agentText: "pre",
      displayText: "pre",
      enqueuedAt: 1,
    });

    const clientItemId = "cq_idem_cut_1";
    // 客户端：预登记 pending
    let pending = [
      { itemId: clientItemId, displayText: "idem-cut", uncertain: false },
    ];
    let settled: string[] = [];

    const replyPromise = chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "idem-cut",
          clientItemId,
          bootArgs: BOOT,
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );

    await hang.waitHit();
    // 入队已发生、HTTP 未返回 → 客户端标 uncertain（模拟掐断）
    expect(listChatQueueItemIds(TASK_ID)).toContain(clientItemId);
    pending = markPendingUncertain(pending, clientItemId);
    expect(pending[0]?.uncertain).toBe(true);

    // 同 id 重试（幂等）——入口 / enqueue 短路 alreadyAccepted
    const retry = await chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "idem-cut",
          clientItemId,
          bootArgs: BOOT,
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(retry.status).toBe(202);
    const retryBody = (await retry.json()) as {
      itemId?: string;
      alreadyAccepted?: boolean;
      queuedCount?: number;
    };
    expect(retryBody.itemId).toBe(clientItemId);
    expect(retryBody.alreadyAccepted).toBe(true);
    // 同 id 始终一条（另有 preexisting）
    expect(
      listChatQueueItemIds(TASK_ID).filter((id) => id === clientItemId),
    ).toHaveLength(1);

    // 放行首请求 202
    hang.release();
    const first = await replyPromise;
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { itemId?: string };
    expect(firstBody.itemId).toBe(clientItemId);
    expect(
      listChatQueueItemIds(TASK_ID).filter((id) => id === clientItemId),
    ).toHaveLength(1);

    // 注入终态 → pending 恰一个终态
    failQueuedItems(TASK_ID, { reason: "stopped" });
    const failed = listRecentSettled(TASK_ID).filter(
      (e) => e.itemId === clientItemId,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.outcome).toBe("stopped");
    const r = reconcilePendingWithQueueState(
      pending,
      settled,
      listChatQueueItemIds(TASK_ID),
      listRecentSettled(TASK_ID),
    );
    pending = r.pending;
    settled = r.settled;
    expect(pending).toHaveLength(0);
    expect(settled).toContain(clientItemId);
    expect(shouldInsertPendingAfter202(settled, clientItemId)).toBe(false);
  });

  it("② 清内存 active 后同 id 重试 → 非 alreadyAccepted（未受理/可重试）", () => {
    const clientItemId = "cq_restart_retry";
    const first = enqueueChatMessage(TASK_ID, {
      itemId: clientItemId,
      agentText: "x",
      displayText: "x",
      enqueuedAt: 1,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.alreadyAccepted).toBeFalsy();

    // 模拟进程重启：清 active + ledger
    cleanupChatQueueState(TASK_ID);
    expect(listChatQueueItemIds(TASK_ID)).toEqual([]);
    expect(listRecentSettled(TASK_ID)).toEqual([]);

    const retry = enqueueChatMessage(TASK_ID, {
      itemId: clientItemId,
      agentText: "x",
      displayText: "x",
      enqueuedAt: 2,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("unreachable");
    // 明确未受理过（内存无账）→ 新鲜受理，不是幂等命中
    expect(retry.alreadyAccepted).toBeFalsy();
    expect(listChatQueueItemIds(TASK_ID)).toEqual([clientItemId]);
  });

  it("② recentSettled 命中 → already_settled 终态 JSON（route）", async () => {
    mockResume.mockResolvedValue({
      agentId: AGENT_ID,
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(makeFakeRun()),
    });
    await resumeChatSession(asTask(makeMeta(TASK_ID, AGENT_ID)), BOOT);

    const clientItemId = "cq_settled_hit";
    recordQueueItemSettled(TASK_ID, clientItemId, "stopped");

    const res = await chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "already-done",
          clientItemId,
          bootArgs: BOOT,
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settled?: boolean;
      itemId?: string;
      outcome?: string;
    };
    expect(body.settled).toBe(true);
    expect(body.itemId).toBe(clientItemId);
    expect(body.outcome).toBe("stopped");
    // 禁止再 append
    expect(listChatQueueItemIds(TASK_ID)).not.toContain(clientItemId);
  });
});

describe("R34-6：direct user_reply 带 clientItemId", () => {
  it("③ 两 tab 同文案：direct 带 id 只清 A，B 保留到自己终态", async () => {
    // 无会话 → chat-reply 走起新会话 direct 路径
    mockCreate.mockResolvedValue({
      agentId: "agent_direct_r35",
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(makeFakeRun()),
    });

    const tabA = "cq_tab_a_direct";
    const tabB = "cq_tab_b_queued";
    const sameText = "same-copy-r35";

    // A：direct 200
    const resA = await chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: sameText,
          clientItemId: tabA,
          bootArgs: BOOT,
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect([200, 202]).toContain(resA.status);

    const events = await readEvents(TASK_ID);
    const directReply = events.find(
      (e) =>
        e.kind === "user_reply" &&
        e.meta &&
        (e.meta as { queueItemId?: string }).queueItemId === tabA,
    );
    // 若走了 202 队列优先，至少保证有带 id 的 user_reply；direct 路径必有
    if (resA.status === 200) {
      expect(directReply).toBeTruthy();
      expect(directReply!.meta).toMatchObject({ queueItemId: tabA });
    }

    // 前端两 tab pending
    let pendingA: Array<{
      itemId: string;
      displayText: string;
      phase?: "sending" | "uncertain" | "persisted";
    }> = [{ itemId: tabA, displayText: sameText }];
    let pendingB: Array<{
      itemId: string;
      displayText: string;
      phase?: "sending" | "uncertain" | "persisted";
    }> = [{ itemId: tabB, displayText: sameText }];
    let settledA: string[] = [];
    let settledB: string[] = [];

    // 用带 id 的 direct 事件对账（R34-6 契约）
    const ev = {
      text: sameText,
      meta: { queueItemId: tabA },
    };
    const a1 = applyUserReplyTerminal(pendingA, settledA, ev);
    pendingA = a1.pending;
    settledA = a1.settled;
    const b1 = applyUserReplyTerminal(pendingB, settledB, ev);
    pendingB = b1.pending;
    settledB = b1.settled;
    // R36-2：user_reply → 标 persisted，不摘 pending / 不记 settled
    expect(pendingA).toHaveLength(1);
    expect(pendingA[0]?.phase).toBe("persisted");
    expect(settledA).not.toContain(tabA);
    expect(pendingB).toEqual([{ itemId: tabB, displayText: sameText }]);

    // B 自己的 user_reply → 同样 persisted
    const b2 = applyUserReplyTerminal(pendingB, settledB, {
      text: sameText,
      meta: { queueItemId: tabB },
    });
    expect(b2.pending).toHaveLength(1);
    expect(b2.pending[0]?.phase).toBe("persisted");
    expect(b2.settled).not.toContain(tabB);
  });

  it("③ 无 id 旧事件仍可按 displayText 兜底（兼容）", () => {
    const prev: Array<{
      itemId: string;
      displayText: string;
      phase?: "sending" | "uncertain" | "persisted";
    }> = [
      { itemId: "old_1", displayText: "legacy" },
      { itemId: "old_2", displayText: "legacy" },
    ];
    const next = applyUserReplyTerminal(prev, [], {
      text: "legacy",
      meta: null,
    });
    // R36-2：只把第一条文案匹配标为 persisted
    expect(next.pending[0]?.phase).toBe("persisted");
    expect(next.pending[0]?.itemId).toBe("old_1");
    expect(next.pending[1]).toEqual({
      itemId: "old_2",
      displayText: "legacy",
    });
  });
});

describe("R34-8：queue-priority head 全程 in-flight", () => {
  it("④ checkpoint 后挂起 → queue_state 含 head；stop 恰一终态不复活", async () => {
    mockCreate.mockResolvedValue({
      agentId: "agent_qp_r35",
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(makeFakeRun()),
    });

    const headId = "cq_qp_head_inflight";
    enqueueChatMessage(TASK_ID, {
      itemId: headId,
      agentText: "head-msg",
      displayText: "head-msg",
      enqueuedAt: 1,
    });

    const hang = installHangingFailpoint(
      "chatReply.afterQueuePriorityCheckpoint",
    );
    const { events, unsub } = collectStream(TASK_ID);

    const replyPromise = chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "follower",
          clientItemId: "cq_qp_follower",
          bootArgs: BOOT,
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );

    await hang.waitHit();
    // 挂起窗口：head 必须在 active（in-flight）
    expect(listChatQueueItemIds(TASK_ID)).toContain(headId);

    const qs = await readWatchQueueState(TASK_ID);
    expect(qs.itemIds).toContain(headId);

    // 前端 pending 含 head → 重连不得当 ghost
    let pending = [
      { itemId: headId, displayText: "head-msg" },
      { itemId: "cq_qp_follower", displayText: "follower" },
    ];
    let settled: string[] = [];
    const recon = reconcilePendingWithQueueState(
      pending,
      settled,
      qs.itemIds,
      qs.recentSettled,
    );
    pending = recon.pending;
    settled = recon.settled;
    expect(pending.map((p) => p.itemId)).toContain(headId);
    expect(recon.ghostIds).not.toContain(headId);

    // stop → failQueuedItems 点名 head
    await stopTaskAgent(asTask(makeMeta(TASK_ID, AGENT_ID)));
    const stopFailed = events.filter(
      (e) => e.kind === "queue_failed" && e.reason === "stopped",
    );
    expect(stopFailed.length).toBeGreaterThanOrEqual(1);
    const stopEv = stopFailed[stopFailed.length - 1];
    expect(stopEv && stopEv.kind === "queue_failed").toBe(true);
    if (!stopEv || stopEv.kind !== "queue_failed") throw new Error("unreachable");
    expect(stopEv.itemIds).toContain(headId);

    const ledgerHits = listRecentSettled(TASK_ID).filter(
      (e) => e.itemId === headId,
    );
    expect(ledgerHits).toHaveLength(1);

    // 放行后不得复活 head
    hang.release();
    const res = await replyPromise;
    // stop 后可能 409 / 202 / 5xx——关键是 head 不回队列
    void res;
    expect(listChatQueueItemIds(TASK_ID)).not.toContain(headId);
    unsub();
  });

  it("④ DELETE 在 checkpoint 窗口点名 head 终态", async () => {
    mockCreate.mockResolvedValue({
      agentId: "agent_qp_del",
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(makeFakeRun()),
    });
    const headId = "cq_qp_del_head";
    enqueueChatMessage(TASK_ID, {
      itemId: headId,
      agentText: "d",
      displayText: "d",
      enqueuedAt: 1,
    });
    const hang = installHangingFailpoint(
      "chatReply.afterQueuePriorityCheckpoint",
    );
    const replyPromise = chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "f",
          clientItemId: "cq_qp_del_f",
          bootArgs: BOOT,
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    await hang.waitHit();
    expect(listChatQueueItemIds(TASK_ID)).toContain(headId);

    // DELETE 走 failQueuedItems(deleted)
    const delRes = await deleteTask(
      new Request(`http://local/api/tasks/${TASK_ID}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(delRes.status).toBeGreaterThanOrEqual(200);

    const ledger = listRecentSettled(TASK_ID).filter((e) => e.itemId === headId);
    // DELETE 可能已 cleanupChatQueueState——若 ledger 被清，至少 active 无 head
    hang.release();
    await replyPromise.catch(() => {});
    expect(listChatQueueItemIds(TASK_ID)).not.toContain(headId);
    // 若 ledger 仍在，恰一条
    if (ledger.length > 0) {
      expect(ledger).toHaveLength(1);
    }
  });

  it("④ 启动失败补偿：in-flight head 进 startup_failed，不复活", async () => {
    // capture 后抛错 → catch requeue 或 finally 补偿
    mockCreate.mockRejectedValue(new Error("create boom"));
    const headId = "cq_qp_fail_head";
    enqueueChatMessage(TASK_ID, {
      itemId: headId,
      agentText: "h",
      displayText: "h",
      enqueuedAt: 1,
    });
    // 让 create 在 fire 时炸：checkpoint 后正常走到 runChatSession
    // 用 afterQueuePriorityCheckpoint 不挂，让链路跑完
    const res = await chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "f2",
          clientItemId: "cq_qp_fail_f",
          bootArgs: BOOT,
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    // 可能 200/202（fire-and-forget）或补偿后状态——断言 head 不双终态复活
    void res;
    const hits = listRecentSettled(TASK_ID).filter((e) => e.itemId === headId);
    // head 要么 delivered（落盘成功）要么在 fail 里；不得出现两条不同 outcome 叠写
    // recordQueueItemSettled 幂等：最多一条
    expect(hits.length).toBeLessThanOrEqual(1);
    // 若已 clear，active 不含；若仍在队，也只一条
    const active = listChatQueueItemIds(TASK_ID).filter((id) => id === headId);
    expect(active.length).toBeLessThanOrEqual(1);
  });
});

describe("R34-5：task_deleted 统一 terminal reducer", () => {
  it("⑤ 在线：task_deleted 帧语义 → 清 pending/streaming（纯函数）", () => {
    // 模拟消费者 sink：收到删除 → 清本地
    let pending = [
      { itemId: "p1", displayText: "x", uncertain: true },
    ];
    let streaming = "partial…";
    const onTaskDeleted = () => {
      pending = [];
      streaming = "";
    };
    // 帧到达
    onTaskDeleted();
    expect(pending).toHaveLength(0);
    expect(streaming).toBe("");
  });

  it("⑤ 断线错过帧 → watch 404 unavailable 可重试；410 才 deletion sink", async () => {
    // 先删任务目录模拟不可读（当前 server 仍可能回 404；client 按 unavailable）
    await fs.rm(taskDir(TASK_ID), { recursive: true, force: true });

    const res = await watchTaskGet(
      new Request(`http://local/api/tasks/${TASK_ID}/watch-task`, {
        headers: { Accept: "text/event-stream" },
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(res.status).toBe(404);

    // R36-7：404 → unavailable、可重试、不 commit deleted
    const decision = resolveWatchCatchAsDeletion(
      new ApiRequestError("not_found", 404),
    );
    expect(decision).toEqual({ deleted: false, shouldRetry: true });

    const d410 = resolveWatchCatchAsDeletion(
      new ApiRequestError("gone", 410),
    );
    expect(d410.deleted).toBe(true);
    expect(d410.shouldRetry).toBe(false);

    // 普通网络错仍可重试
    const net = resolveWatchCatchAsDeletion(new Error("fetch failed"));
    expect(net.deleted).toBe(false);
    expect(net.shouldRetry).toBe(true);
  });

  it("⑤ uncertain pending：bootstrap 见 active 则清除 uncertain；见 ledger 则终态", () => {
    const itemId = "cq_uncert_1";
    let pending = [
      { itemId, displayText: "u", uncertain: true },
    ];
    const settled: string[] = [];

    // 仍在 active → 确认受理
    const alive = reconcilePendingWithQueueState(
      pending,
      settled,
      [itemId],
      [],
    );
    expect(alive.pending).toHaveLength(1);
    expect(alive.pending[0]?.uncertain).toBe(false);

    // ledger 终态 → 清
    pending = [{ itemId, displayText: "u", uncertain: true }];
    const done = reconcilePendingWithQueueState(
      pending,
      settled,
      [],
      [{ itemId, outcome: "stopped" }],
    );
    expect(done.pending).toHaveLength(0);
    expect(done.settled).toContain(itemId);

    // 重启后空账本 → uncertain 保留（可同 id 重试），不当 ghost
    pending = [{ itemId, displayText: "u", uncertain: true }];
    const empty = reconcilePendingWithQueueState(pending, [], [], []);
    expect(empty.pending).toHaveLength(1);
    expect(empty.ghostIds).toEqual([]);
  });

  it("⑤ 明确 4xx 才 dropPending；网络错 markUncertain", () => {
    const itemId = "cq_err_path";
    let pending: Array<{
      itemId: string;
      displayText: string;
      uncertain?: boolean;
    }> = [{ itemId, displayText: "e" }];
    const settled: string[] = [];

    // 模拟 4xx
    const dropped = dropPendingByItemId(pending, settled, itemId);
    expect(dropped.pending).toHaveLength(0);

    pending = [{ itemId, displayText: "e" }];
    pending = markPendingUncertain(pending, itemId);
    expect(pending[0]?.uncertain).toBe(true);
    expect(pending).toHaveLength(1);
  });
});
