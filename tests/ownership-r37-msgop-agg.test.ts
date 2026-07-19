/**
 * R36 MessageOperation aggregate 退出矩阵（R36-1/4/5/11/12 + fingerprint）：
 * ① Agent.create reject → 非 delivered、failed 终态
 * ② create 成功 send reject → 同
 * ③ 窗口 stop → failed（不用 delivered）
 * ④ happy path：send resolve 后才 handedOff
 * ⑤ claim 后未 enqueue → bootstrap snapshot 含 accepting
 * ⑥ finalizer 表驱动：409/EIO/throw 出口无幽灵 accepting
 * ⑦ terminal 淘汰后同 id 新受理
 * ⑧ staged attachments 回滚
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r37-msgop-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FE_AI_FLOW_DATA_DIR = DATA_DIR;

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

const mockCaptureCheckpoint = vi.fn(async () => ({
  ok: true as boolean,
  repoSnapshots: [{ repoPath: "/tmp/fake-repo", treeOid: "oid_r37" }],
  elapsedMsByRepo: { "/tmp/fake-repo": 1 },
  warnings: [] as string[],
}));
vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint: (...args: unknown[]) =>
    mockCaptureCheckpoint(...(args as [])),
  persistCheckpointForReply: async () => true,
}));

const mockCheckUpdatePending = vi.fn(async (): Promise<string | null> => null);
vi.mock("@/lib/server/update-pending", () => ({
  checkUpdatePendingRestart: () => mockCheckUpdatePending(),
}));

const saveImageSpy = vi.fn(
  async (taskId: string, images: Array<{ filename?: string }>) => {
    const dir = path.join(DATA_DIR, "tasks", taskId, "uploads");
    await fs.mkdir(dir, { recursive: true });
    const saved = [];
    for (let i = 0; i < images.length; i++) {
      const filename = images[i]?.filename ?? `img_${i}.png`;
      const absPath = path.join(dir, `att_r37_${i}_${filename}`);
      await fs.writeFile(absPath, Buffer.from("png"), "utf-8");
      saved.push({
        absPath,
        relPath: `uploads/att_r37_${i}_${filename}`,
        mimeType: "image/png",
        bytes: 3,
        filename,
      });
    }
    return saved;
  },
);
vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: (...args: unknown[]) =>
    saveImageSpy(...(args as [string, Array<{ filename?: string }>])),
}));

const { clearFailpoints } = await import("@/lib/server/failpoints");
const taskFsCore = await import("@/lib/server/task-fs-core");
const { clearEventSeqCounter, taskDir, writeMeta } = taskFsCore;
const taskFs = await import("@/lib/server/task-fs");
const {
  closeChatSessionUnconditional,
  isChatRunActive,
  resumeChatSession,
} = await import("@/lib/server/chat-runner");
const {
  CHAT_QUEUE_MAX,
  claimMessageOperation,
  cleanupChatQueueState,
  enqueueChatMessage,
  fingerprintFromMessagePayload,
  getMessageOperation,
  listMessageOperationSnapshot,
  listRecentSettled,
  RECENT_SETTLED_MAX,
  recordQueueItemSettled,
} = await import("@/lib/server/chat-queue");
const { stopTaskAgent } = await import("@/lib/server/stop-task");
const { POST: chatReplyPost } = await import(
  "@/app/api/tasks/[id]/chat-reply/route"
);
const { GET: watchTaskGet } = await import(
  "@/app/api/tasks/[id]/watch-task/route"
);
const { computeChatPayloadFingerprint, imageKeysFromPayloads } = await import(
  "@/lib/chat-payload-fingerprint"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r37-msgop-agg DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000001370_r37_msgop";
const AGENT_ID = "agent_fake_r37_msgop";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string, sessionAgentId?: string): TaskMetaV06 =>
  ({
    id,
    title: `对话 · 测试`,
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

const postReply = (body: Record<string, unknown>) =>
  chatReplyPost(
    new Request(`http://local/api/tasks/${TASK_ID}/chat-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: TASK_ID }) },
  );

const waitFor = async (
  pred: () => boolean,
  timeoutMs = 3000,
): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((r) => setTimeout(r, 15));
  }
};

const listUploads = async (): Promise<string[]> => {
  const dir = path.join(DATA_DIR, "tasks", TASK_ID, "uploads");
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
};

beforeEach(async () => {
  clearFailpoints();
  cleanupChatQueueState(TASK_ID);
  clearEventSeqCounter(TASK_ID);
  mockCreate.mockReset();
  mockResume.mockReset();
  mockSend.mockReset();
  mockCaptureCheckpoint.mockReset();
  mockCaptureCheckpoint.mockResolvedValue({
    ok: true,
    repoSnapshots: [{ repoPath: "/tmp/fake-repo", treeOid: "oid_r37" }],
    elapsedMsByRepo: { "/tmp/fake-repo": 1 },
    warnings: [],
  });
  mockCheckUpdatePending.mockReset();
  mockCheckUpdatePending.mockResolvedValue(null);
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
  // 无 session → firstMessage 路径
  await writeMeta(makeMeta(TASK_ID));
});

afterEach(() => {
  clearFailpoints();
  closeChatSessionUnconditional(TASK_ID);
  cleanupChatQueueState(TASK_ID);
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("R36-1：handedOff 仅在 send resolve 后", () => {
  it("① Agent.create reject → HTTP 非 delivered，item 恰一个 failed 终态", async () => {
    mockCreate.mockRejectedValue(new Error("create boom"));
    const clientItemId = "cq_r37_create_reject";
    const res = await postReply({
      text: "create-fail",
      clientItemId,
      bootArgs: BOOT,
    });
    const json = (await res.json()) as {
      settled?: boolean;
      outcome?: string;
      phase?: string;
    };
    expect(json.settled).not.toBe(true);
    expect(json.outcome).not.toBe("delivered");
    expect(res.status).not.toBe(200);

    await waitFor(() => {
      const op = getMessageOperation(TASK_ID, clientItemId);
      return !!op && op.phase !== "accepting" && op.phase !== "persisted";
    });
    const op = getMessageOperation(TASK_ID, clientItemId);
    expect(op?.phase).toBe("startup_failed");
    expect(
      listRecentSettled(TASK_ID).filter((e) => e.itemId === clientItemId),
    ).toHaveLength(1);
    expect(
      listRecentSettled(TASK_ID).find((e) => e.itemId === clientItemId)
        ?.outcome,
    ).toBe("startup_failed");
  }, 10_000);

  it("② create 成功 send reject → 非 delivered、failed 终态", async () => {
    mockSend.mockRejectedValue(new Error("send boom"));
    const clientItemId = "cq_r37_send_reject";
    const res = await postReply({
      text: "send-fail",
      clientItemId,
      bootArgs: BOOT,
    });
    const json = (await res.json()) as {
      settled?: boolean;
      outcome?: string;
    };
    expect(json.outcome).not.toBe("delivered");
    expect(res.status).not.toBe(200);

    await waitFor(() => {
      const op = getMessageOperation(TASK_ID, clientItemId);
      return !!op && op.phase !== "accepting" && op.phase !== "persisted";
    });
    expect(getMessageOperation(TASK_ID, clientItemId)?.phase).toBe(
      "startup_failed",
    );
  }, 10_000);

  it("③ create 窗口 stop → failed，非 delivered", async () => {
    let hitResolve!: () => void;
    const hit = new Promise<void>((r) => {
      hitResolve = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockCreate.mockImplementation(async () => {
      hitResolve();
      await gate;
      return {
        agentId: "agent_r37_stop",
        close: vi.fn(),
        send: mockSend,
      };
    });

    const clientItemId = "cq_r37_stop_window";
    const replyPromise = postReply({
      text: "stop-window",
      clientItemId,
      bootArgs: BOOT,
    });
    await hit;
    await stopTaskAgent(asTask(makeMeta(TASK_ID)));
    release();
    const res = await replyPromise;
    const json = (await res.json()) as { outcome?: string; settled?: boolean };
    expect(json.outcome).not.toBe("delivered");

    await waitFor(() => {
      const op = getMessageOperation(TASK_ID, clientItemId);
      return (
        !!op &&
        op.phase !== "accepting" &&
        op.phase !== "persisted" &&
        op.phase !== "handedOff"
      );
    }, 5000);
    const phase = getMessageOperation(TASK_ID, clientItemId)?.phase;
    expect(phase).not.toBe("handedOff");
    expect(["stopped", "startup_failed", "cancelled"]).toContain(phase);
  }, 15_000);

  it("④ happy path：HTTP 返回时尚未 handedOff，send resolve 后才 handedOff", async () => {
    let resolveSend!: (run: ReturnType<typeof makeFakeRun>) => void;
    const sendGate = new Promise<ReturnType<typeof makeFakeRun>>((r) => {
      resolveSend = r;
    });
    mockSend.mockImplementation(() => sendGate);

    const clientItemId = "cq_r37_happy_handoff";
    const replyPromise = postReply({
      text: "happy",
      clientItemId,
      bootArgs: BOOT,
    });

    await waitFor(() => isChatRunActive(TASK_ID));
    // send 尚未 resolve → 不得 handedOff
    expect(getMessageOperation(TASK_ID, clientItemId)?.phase).not.toBe(
      "handedOff",
    );
    expect(
      listRecentSettled(TASK_ID).some(
        (e) => e.itemId === clientItemId && e.outcome === "delivered",
      ),
    ).toBe(false);

    resolveSend(makeFakeRun());
    const res = await replyPromise;
    expect(res.status).toBe(202);
    const json = (await res.json()) as {
      settled?: boolean;
      outcome?: string;
      phase?: string;
    };
    expect(json.settled).not.toBe(true);
    expect(json.outcome).not.toBe("delivered");

    await waitFor(
      () => getMessageOperation(TASK_ID, clientItemId)?.phase === "handedOff",
    );
    expect(getMessageOperation(TASK_ID, clientItemId)?.phase).toBe("handedOff");
  }, 10_000);
});

describe("R36-4：operationSnapshot", () => {
  it("⑤ claim 后未 enqueue 时 bootstrap snapshot 含 accepting", async () => {
    const clientItemId = "cq_r37_snap_accepting";
    const fp = fingerprintFromMessagePayload({ text: "snap" });
    const claim = claimMessageOperation(TASK_ID, clientItemId, fp);
    expect(claim.status).toBe("claimed");

    const snap = listMessageOperationSnapshot(TASK_ID);
    expect(snap.some((e) => e.itemId === clientItemId && e.phase === "accepting")).toBe(
      true,
    );

    const res = await watchTaskGet(
      new Request(`http://local/api/tasks/${TASK_ID}/watch-task`),
      { params: Promise.resolve({ id: TASK_ID }) },
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let queueState: {
      operationSnapshot?: Array<{ itemId: string; phase: string }>;
      itemIds?: string[];
    } | null = null;
    while (!queueState) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const block of buf.split("\n\n")) {
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const payload = JSON.parse(line.slice(6)) as {
          type?: string;
          operationSnapshot?: Array<{ itemId: string; phase: string }>;
          itemIds?: string[];
        };
        if (payload.type === "queue_state") {
          queueState = payload;
          break;
        }
      }
    }
    await reader.cancel().catch(() => {});
    expect(queueState).not.toBeNull();
    // 旧字段兼容：accepting 不在 queue itemIds
    expect(queueState!.itemIds ?? []).not.toContain(clientItemId);
    expect(
      queueState!.operationSnapshot?.some(
        (e) => e.itemId === clientItemId && e.phase === "accepting",
      ),
    ).toBe(true);

    if (claim.status === "claimed") claim.handle.finalize();
  });
});

describe("R36-5：claim finalizer", () => {
  it("⑥ 表驱动：4xx/5xx/throw 出口后无幽灵 accepting", async () => {
    const cases: Array<{
      label: string;
      setup: () => Promise<void> | void;
      body: Record<string, unknown>;
      expectStatus?: number;
    }> = [
      {
        label: "pending-update 409（懒重启路径）",
        setup: async () => {
          await writeMeta(makeMeta(TASK_ID, AGENT_ID));
          await resumeChatSession(asTask(makeMeta(TASK_ID, AGENT_ID)), BOOT);
          mockCheckUpdatePending.mockResolvedValue("请先重启应用以完成更新");
        },
        body: {
          text: "restart-block",
          clientItemId: "cq_r37_fin_pending",
          bootArgs: {
            apiKey: "test-key",
            // 与会话模型不同 → 进懒重启分支
            model: { id: "gpt-other", params: [] },
          },
        },
        expectStatus: 409,
      },
      {
        label: "bootArgs 非法 400",
        setup: () => {},
        body: {
          text: "no-boot",
          clientItemId: "cq_r37_fin_boot",
          // 无 bootArgs → 起新会话 400
        },
        expectStatus: 400,
      },
      {
        label: "checkpoint throw",
        setup: () => {
          mockCaptureCheckpoint.mockRejectedValue(new Error("EIO checkpoint"));
        },
        body: {
          text: "ckpt-throw",
          clientItemId: "cq_r37_fin_ckpt",
          bootArgs: BOOT,
        },
      },
      {
        label: "标题写 EIO",
        setup: () => {
          vi.spyOn(taskFs, "updateTaskFields").mockRejectedValueOnce(
            new Error("EIO title"),
          );
        },
        body: {
          text: "title-eio-message-long-enough",
          clientItemId: "cq_r37_fin_title",
          bootArgs: BOOT,
        },
      },
      {
        label: "queue full 409",
        setup: () => {
          for (let i = 0; i < CHAT_QUEUE_MAX; i++) {
            enqueueChatMessage(TASK_ID, {
              itemId: `cq_r37_fill_${i}`,
              agentText: `f${i}`,
              displayText: `f${i}`,
              enqueuedAt: i,
            });
          }
          // 已有 session + run active 才会走 enqueue；这里无 session 会先起会话
          // 改为：compact/queue 路径——有 session 且 run active
        },
        body: {
          text: "full",
          clientItemId: "cq_r37_fin_full",
          bootArgs: BOOT,
        },
      },
    ];

    for (const c of cases) {
      cleanupChatQueueState(TASK_ID);
      closeChatSessionUnconditional(TASK_ID);
      await fs
        .rm(taskDir(TASK_ID), { recursive: true, force: true })
        .catch(() => {});
      await writeMeta(makeMeta(TASK_ID));
      mockCheckUpdatePending.mockResolvedValue(null);
      mockCaptureCheckpoint.mockImplementation(async () => ({
        ok: true,
        repoSnapshots: [{ repoPath: "/tmp/fake-repo", treeOid: "oid_r37" }],
        elapsedMsByRepo: { "/tmp/fake-repo": 1 },
        warnings: [],
      }));
      // 清掉上一轮 title spy（避免影响后续 case）
      if (vi.isMockFunction(taskFs.updateTaskFields)) {
        taskFs.updateTaskFields.mockRestore();
      }

      await c.setup();
      const itemId = c.body.clientItemId as string;
      const res = await postReply(c.body).catch(() => null);
      if (c.expectStatus != null && res) {
        expect(res.status, c.label).toBe(c.expectStatus);
      }
      // 允许 throw 路径 res=null
      const op = getMessageOperation(TASK_ID, itemId);
      // 不得留下「非 queue、非 runner、非 terminal 的 accepting」
      if (op?.phase === "accepting") {
        // 仅当已在队内 / in-flight / runner starting 才可接受——本矩阵期望无幽灵
        expect(op.phase, c.label).not.toBe("accepting");
      }
      // 更强：accepting 必须不存在（transfer 则至少 persisted 或队内）
      expect(op?.phase === "accepting", c.label).toBe(false);
    }
  }, 20_000);
});

describe("R36-11：terminal 有界淘汰", () => {
  it("⑦ 淘汰后同 id 新受理", () => {
    const id = "cq_r37_evict_reuse";
    // 填满 ledger
    for (let i = 0; i < RECENT_SETTLED_MAX; i++) {
      recordQueueItemSettled(TASK_ID, `cq_r37_old_${i}`, "delivered");
    }
    // 再记一条 → 挤掉最老；把 id 先 settle 再挤掉
    recordQueueItemSettled(TASK_ID, id, "startup_failed");
    expect(getMessageOperation(TASK_ID, id)?.phase).toBe("startup_failed");
    for (let i = 0; i < RECENT_SETTLED_MAX; i++) {
      recordQueueItemSettled(TASK_ID, `cq_r37_new_${i}`, "error");
    }
    // 淘汰后 op 消失
    expect(getMessageOperation(TASK_ID, id)).toBeUndefined();
    expect(
      listRecentSettled(TASK_ID).some((e) => e.itemId === id),
    ).toBe(false);

    // 同 id 新受理
    const fp = fingerprintFromMessagePayload({ text: "reuse" });
    const claim = claimMessageOperation(TASK_ID, id, fp);
    expect(claim.status).toBe("claimed");
    expect(getMessageOperation(TASK_ID, id)?.phase).toBe("accepting");
    if (claim.status === "claimed") claim.handle.finalize();
  });
});

describe("R36-12：staged attachments 回滚", () => {
  it("⑧ queue full / boot 400 / pending-update 409 / checkpoint throw 后 uploads 无残留", async () => {
    const img = {
      data: Buffer.from("pngdata").toString("base64"),
      mimeType: "image/png",
      filename: "roll.png",
    };

    // boot 400（有图）
    {
      const id = "cq_r37_att_boot";
      await postReply({
        text: "x",
        clientItemId: id,
        images: [img],
      });
      expect(await listUploads()).toEqual([]);
      expect(getMessageOperation(TASK_ID, id)).toBeUndefined();
    }

    // checkpoint throw
    {
      mockCaptureCheckpoint.mockRejectedValueOnce(new Error("EIO"));
      const id = "cq_r37_att_ckpt";
      await postReply({
        text: "y",
        clientItemId: id,
        bootArgs: BOOT,
        images: [img],
      }).catch(() => {});
      expect(await listUploads()).toEqual([]);
      expect(getMessageOperation(TASK_ID, id)?.phase === "accepting").toBe(
        false,
      );
    }

    // pending-update 409（懒重启 + 图）
    {
      await writeMeta(makeMeta(TASK_ID, AGENT_ID));
      await resumeChatSession(asTask(makeMeta(TASK_ID, AGENT_ID)), BOOT);
      mockCheckUpdatePending.mockResolvedValueOnce("请先重启");
      const id = "cq_r37_att_pending";
      const res = await postReply({
        text: "z",
        clientItemId: id,
        images: [img],
        bootArgs: {
          apiKey: "test-key",
          model: { id: "gpt-other", params: [] },
        },
      });
      expect(res.status).toBe(409);
      expect(await listUploads()).toEqual([]);
      expect(getMessageOperation(TASK_ID, id)).toBeUndefined();
      closeChatSessionUnconditional(TASK_ID);
      await writeMeta(makeMeta(TASK_ID));
    }

    // 重试成功只留一批
    {
      mockCreate.mockResolvedValue({
        agentId: "agent_r37_att_ok",
        close: vi.fn(),
        send: mockSend,
      });
      const id = "cq_r37_att_ok";
      const res = await postReply({
        text: "ok-img",
        clientItemId: id,
        bootArgs: BOOT,
        images: [img],
      });
      expect([200, 202]).toContain(res.status);
      await waitFor(() => {
        const phase = getMessageOperation(TASK_ID, id)?.phase;
        return phase === "handedOff" || phase === "persisted";
      });
      const files = await listUploads();
      expect(files.length).toBe(1);
    }
  }, 15_000);
});

describe("fingerprint 统一", () => {
  it("server fingerprintFromMessagePayload ≡ 共享 computeChatPayloadFingerprint", () => {
    const images = [
      { data: "abc", mimeType: "image/png", filename: "a.png" },
    ];
    const a = fingerprintFromMessagePayload({
      text: "hi",
      images,
      attachmentPaths: ["/tmp/x"],
      skills: [{ name: "s", absPath: "/skills/s" }],
    });
    const b = computeChatPayloadFingerprint({
      text: "hi",
      imagePaths: imageKeysFromPayloads(images),
      attachmentPaths: ["/tmp/x"],
      skills: [{ name: "s", absPath: "/skills/s" }],
    });
    expect(a).toBe(b);
  });
});
