/**
 * R35-1 / R35-6 MessageOperationCoordinator 退出矩阵：
 * ① direct 200 丢失 × run active / idle 同 id 重试 → 原 operation、单条 user_reply、agent 收一次
 * ② 两同 id POST 并发 claim 后第一个 await 前 → 只一个执行附件落盘
 * ③ 同 id 改 text/图片/附件/skill → 409 payloadMismatch
 * ④ queue-priority / flush 在 persisted 后、handoff 前注入 stop → 恰一次真投递或 queue_failed
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r36-msgop-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const mockCreate = vi.fn();
const mockResume = vi.fn();
const mockSend = vi.fn();
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
    repoSnapshots: [{ repoPath: "/tmp/fake-repo", treeOid: "oid_r36" }],
    elapsedMsByRepo: { "/tmp/fake-repo": 1 },
    warnings: [] as string[],
  }),
  persistCheckpointForReply: async () => true,
}));

const saveImageSpy = vi.fn(
  async (taskId: string, images: Array<{ filename?: string }>) =>
    images.map((img, i) => ({
      absPath: `/tmp/${taskId}/uploads/${img.filename ?? `img_${i}.png`}`,
      relPath: `uploads/${img.filename ?? `img_${i}.png`}`,
      mimeType: "image/png",
      bytes: 4,
      filename: img.filename ?? `img_${i}.png`,
    })),
);
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: (...args: unknown[]) =>
    saveImageSpy(...(args as [string, Array<{ filename?: string }>])),
}));

const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const taskFsCore = await import("@/lib/server/task-fs-core");
const { clearEventSeqCounter, readEvents, taskDir, writeMeta } = taskFsCore;
const {
  closeChatSessionUnconditional,
  flushChatQueue,
  hasChatSession,
  isChatRunActive,
  resumeChatSession,
} = await import("@/lib/server/chat-runner");
const {
  cleanupChatQueueState,
  enqueueChatMessage,
  getMessageOperation,
  listChatQueueItemIds,
  listRecentSettled,
} = await import("@/lib/server/chat-queue");
const { subscribeTaskStream } = await import("@/lib/server/task-stream");
import type { TaskStreamEvent } from "@/lib/server/task-stream";
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const { POST: chatReplyPost } = await import(
  "@/app/api/tasks/[id]/chat-reply/route"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r36-msgop DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001360_r36_msgop";
const AGENT_ID = "agent_fake_r36_msgop";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string, sessionAgentId?: string): TaskMetaV06 =>
  ({
    id,
    title: `r36-msgop ${id}`,
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

const countUserReplyWithId = async (itemId: string): Promise<number> => {
  const events = await readEvents(TASK_ID);
  return events.filter(
    (e) =>
      e.kind === "user_reply" &&
      (e.meta as { queueItemId?: string } | undefined)?.queueItemId === itemId,
  ).length;
};

beforeEach(async () => {
  clearFailpoints();
  cleanupChatQueueState(TASK_ID);
  clearEventSeqCounter(TASK_ID);
  mockCreate.mockReset();
  mockResume.mockReset();
  mockSend.mockReset();
  saveImageSpy.mockClear();
  mockSend.mockResolvedValue(makeFakeRun());
  mockResume.mockResolvedValue({
    agentId: AGENT_ID,
    close: vi.fn(),
    send: mockSend,
  });
  mockCreate.mockResolvedValue({
    agentId: AGENT_ID,
    close: vi.fn(),
    send: mockSend,
  });
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

describe("R35-1：claim 原子受理 + direct 幂等", () => {
  it("① direct 200 丢失后同 id 重试（run idle）→ settled delivered，单条气泡、agent 一次", async () => {
    const task = asTask(makeMeta(TASK_ID, AGENT_ID));
    await resumeChatSession(task, BOOT);
    expect(hasChatSession(TASK_ID)).toBe(true);

    const clientItemId = "cq_r36_direct_idle";
    const body = {
      text: "direct-idle-msg",
      clientItemId,
      bootArgs: BOOT,
    };
    const first = await chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      settled?: boolean;
      outcome?: string;
      itemId?: string;
    };
    expect(firstJson.itemId).toBe(clientItemId);
    expect(firstJson.outcome).toBe("delivered");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(await countUserReplyWithId(clientItemId)).toBe(1);

    // 模拟 200 丢失后同 id 重试
    const retry = await chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(retry.status).toBe(200);
    const retryJson = (await retry.json()) as {
      settled?: boolean;
      outcome?: string;
      alreadyAccepted?: boolean;
    };
    expect(retryJson.settled).toBe(true);
    expect(retryJson.outcome).toBe("delivered");
    expect(retryJson.alreadyAccepted).toBeUndefined();
    // 不得再次 send / 再落气泡
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(await countUserReplyWithId(clientItemId)).toBe(1);
    expect(getMessageOperation(TASK_ID, clientItemId)?.phase).toBe("handedOff");
  });

  it("① direct 200 后 run active 时同 id 重试 → 仍 settled，不再入队", async () => {
    const task = asTask(makeMeta(TASK_ID, AGENT_ID));
    await resumeChatSession(task, BOOT);

    const clientItemId = "cq_r36_direct_active";
    const body = {
      text: "direct-active-msg",
      clientItemId,
      bootArgs: BOOT,
    };
    const first = await chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(first.status).toBe(200);
    // send 后 run 仍可能 active（fake run 未消费完）——同 id 重试不得 202 再入队
    const retry = await chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(retry.status).toBe(200);
    const retryJson = (await retry.json()) as {
      settled?: boolean;
      queued?: boolean;
      outcome?: string;
    };
    expect(retryJson.settled).toBe(true);
    expect(retryJson.queued).toBeUndefined();
    expect(retryJson.outcome).toBe("delivered");
    expect(listChatQueueItemIds(TASK_ID)).not.toContain(clientItemId);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(await countUserReplyWithId(clientItemId)).toBe(1);
  });

  it("② 两同 id POST 并发 claim 后 → 只一个执行附件落盘", async () => {
    const hang = installHangingFailpoint("chatReply.afterClaim");
    const task = asTask(makeMeta(TASK_ID, AGENT_ID));
    await resumeChatSession(task, BOOT);

    const clientItemId = "cq_r36_concurrent_claim";
    const body = {
      text: "with-img",
      clientItemId,
      bootArgs: BOOT,
      images: [
        {
          data: "aGVsbG8=",
          mimeType: "image/png",
          filename: "a.png",
        },
      ],
    };

    const p1 = chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    await hang.waitHit();
    // 第一个停在 claim 后；第二个应立刻 alreadyAccepted，绝不 saveImage
    const p2 = chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    const r2 = await p2;
    expect(r2.status).toBe(202);
    const j2 = (await r2.json()) as { alreadyAccepted?: boolean };
    expect(j2.alreadyAccepted).toBe(true);
    expect(saveImageSpy).toHaveBeenCalledTimes(0);

    hang.release();
    const r1 = await p1;
    expect(r1.status).toBe(200);
    expect(saveImageSpy).toHaveBeenCalledTimes(1);
  });

  it("③ 同 id 改 text / 图片 / 附件 / skill → 409 payloadMismatch", async () => {
    const task = asTask(makeMeta(TASK_ID, AGENT_ID));
    await resumeChatSession(task, BOOT);
    const clientItemId = "cq_r36_mismatch";

    const first = await chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "original",
          clientItemId,
          bootArgs: BOOT,
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(first.status).toBe(200);

    const cases: Array<{ label: string; body: Record<string, unknown> }> = [
      {
        label: "text",
        body: { text: "changed-text", clientItemId, bootArgs: BOOT },
      },
      {
        label: "image",
        body: {
          text: "original",
          clientItemId,
          bootArgs: BOOT,
          images: [
            { data: "eHh4", mimeType: "image/png", filename: "b.png" },
          ],
        },
      },
      {
        label: "attachment",
        body: {
          text: "original",
          clientItemId,
          bootArgs: BOOT,
          attachments: ["/tmp/r36-fake-attach.txt"],
        },
      },
      {
        label: "skill",
        body: {
          text: "original",
          clientItemId,
          bootArgs: BOOT,
          skills: [{ name: "demo", absPath: "/tmp/skills/demo" }],
        },
      },
    ];

    // 附件路径需存在，否则路由在 claim 前就 400——先造文件
    await fs.writeFile("/tmp/r36-fake-attach.txt", "x", "utf-8");
    await fs.mkdir("/tmp/skills/demo", { recursive: true });
    await fs.writeFile("/tmp/skills/demo/SKILL.md", "# demo\n", "utf-8");

    for (const c of cases) {
      const res = await chatReplyPost(
        new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(c.body),
        }),
        { params: Promise.resolve({ id: TASK_ID }) },
      );
      expect(res.status, c.label).toBe(409);
      const json = (await res.json()) as {
        payloadMismatch?: boolean;
        itemId?: string;
      };
      expect(json.payloadMismatch, c.label).toBe(true);
      expect(json.itemId, c.label).toBe(clientItemId);
    }
    // 原文同 id 重试仍 settled
    const same = await chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "original",
          clientItemId,
          bootArgs: BOOT,
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(same.status).toBe(200);
    expect(((await same.json()) as { outcome?: string }).outcome).toBe(
      "delivered",
    );
  });
});

describe("R35-6：persisted ≠ delivered；handoff 后才 settle", () => {
  it("④ queue-priority：persisted 后 stop → queue_failed，无 delivered 假账", async () => {
    // 无 sessionAgentId → 走 mode2 队列优先启动（勿 resume）
    await writeMeta(makeMeta(TASK_ID));
    closeChatSessionUnconditional(TASK_ID);
    mockCreate.mockResolvedValue({
      agentId: "agent_qp_r36",
      close: vi.fn(),
      send: vi.fn().mockResolvedValue(makeFakeRun()),
    });
    const headId = "cq_r36_qp_head";
    enqueueChatMessage(TASK_ID, {
      itemId: headId,
      agentText: "head-msg",
      displayText: "head-msg",
      enqueuedAt: 1,
    });
    const hang = installHangingFailpoint("chatReply.afterQueuePriorityPersist");
    const { events, unsub } = collectStream(TASK_ID);

    const replyPromise = chatReplyPost(
      new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "follower",
          clientItemId: "cq_r36_qp_follower",
          bootArgs: BOOT,
        }),
      }),
      { params: Promise.resolve({ id: TASK_ID }) },
    );

    await hang.waitHit();
    // 此时 head 应 persisted，尚未 handedOff
    expect(getMessageOperation(TASK_ID, headId)?.phase).toBe("persisted");
    expect(
      listRecentSettled(TASK_ID).some(
        (e) => e.itemId === headId && e.outcome === "delivered",
      ),
    ).toBe(false);

    await stopTaskAgent(asTask(makeMeta(TASK_ID)));
    const stopFailed = events.filter(
      (e) => e.kind === "queue_failed" && e.reason === "stopped",
    );
    expect(stopFailed.length).toBeGreaterThanOrEqual(1);
    const last = stopFailed[stopFailed.length - 1];
    expect(last && last.kind === "queue_failed" && last.itemIds).toContain(
      headId,
    );

    hang.release();
    await replyPromise.catch(() => {});
    const ledger = listRecentSettled(TASK_ID).filter((e) => e.itemId === headId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.outcome).not.toBe("delivered");
    expect(listChatQueueItemIds(TASK_ID)).not.toContain(headId);
    unsub();
  }, 15_000);

  it("④ flush：persisted 后 stop → queue_failed 或重排，绝无 delivered+未 send", async () => {
    const task = asTask(makeMeta(TASK_ID, AGENT_ID));
    await resumeChatSession(task, BOOT);
    expect(hasChatSession(TASK_ID)).toBe(true);

    const itemId = "cq_r36_flush_head";
    enqueueChatMessage(TASK_ID, {
      itemId,
      agentText: "flush-me",
      displayText: "flush-me",
      enqueuedAt: 1,
    });

    const hang = installHangingFailpoint("flushChatQueue.afterPersist");
    const { events, unsub } = collectStream(TASK_ID);
    const flushPromise = flushChatQueue(TASK_ID);
    await hang.waitHit();

    expect(getMessageOperation(TASK_ID, itemId)?.phase).toBe("persisted");
    expect(
      listRecentSettled(TASK_ID).some(
        (e) => e.itemId === itemId && e.outcome === "delivered",
      ),
    ).toBe(false);
    const sendCountBefore = mockSend.mock.calls.length;

    await stopTaskAgent(asTask(makeMeta(TASK_ID, AGENT_ID)));
    hang.release();
    await flushPromise.catch(() => {});

    const sendCountAfter = mockSend.mock.calls.length;
    const ledger = listRecentSettled(TASK_ID).filter((e) => e.itemId === itemId);
    const failed = events.filter(
      (e) =>
        e.kind === "queue_failed" &&
        e.itemIds.includes(itemId),
    );

    // 恰一次真投递 XOR 明确失败；禁止 delivered ledger 却未 send
    if (ledger.some((e) => e.outcome === "delivered")) {
      expect(sendCountAfter - sendCountBefore).toBeGreaterThanOrEqual(1);
    } else {
      expect(failed.length + (ledger.length > 0 ? 1 : 0)).toBeGreaterThanOrEqual(
        1,
      );
      expect(ledger.every((e) => e.outcome !== "delivered")).toBe(true);
    }
    // 不得出现「delivered + 零次 send 增量」
    if (sendCountAfter === sendCountBefore) {
      expect(ledger.some((e) => e.outcome === "delivered")).toBe(false);
    }
    unsub();
  });

  it("④ flush happy path：send 成功后才 handedOff/delivered", async () => {
    const task = asTask(makeMeta(TASK_ID, AGENT_ID));
    await resumeChatSession(task, BOOT);
    // 等可能的 active run 结束，避免 flush 见 busy 塞回
    for (let i = 0; i < 20 && isChatRunActive(TASK_ID); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const itemId = "cq_r36_flush_ok";
    enqueueChatMessage(TASK_ID, {
      itemId,
      agentText: "ok-flush",
      displayText: "ok-flush",
      enqueuedAt: 1,
    });
    await flushChatQueue(TASK_ID);
    expect(getMessageOperation(TASK_ID, itemId)?.phase).toBe("handedOff");
    expect(
      listRecentSettled(TASK_ID).find((e) => e.itemId === itemId)?.outcome,
    ).toBe("delivered");
    expect(mockSend).toHaveBeenCalled();
  });
});
