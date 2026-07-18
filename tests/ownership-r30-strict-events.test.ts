/**
 * R30 退出测试：R29-4 strict 用户输入落盘 + R29-6 seq durable 恢复
 *
 * ① 三 route 注入 append EIO——send 前 → 5xx 不继续、不清 pending
 * ② send 后 → 200 + persistWarning、console.error
 * ③ stop/cleanup → append seq 严格递增
 * ④ counter 清空（模拟重启）→ append 从 durable 尾恢复
 * ⑤ ENOENT 仍返 null（strict 不抛）
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r30-"));
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

const mockSendChatMessage = vi.fn();
const mockRunChatSession = vi.fn();
const mockHasChatSession = vi.fn(() => false);
const mockResumeChatSession = vi.fn(async () => null);
const mockDeliverChatAskReply = vi.fn();
const mockDeliverAskReply = vi.fn();
const mockDeliverTaskQuestion = vi.fn();
const mockResumeCurrentAction = vi.fn();
const mockStartOneShotQuestion = vi.fn();
const mockCaptureCheckpoint = vi.fn(async () => ({
  ok: false,
  repoSnapshots: [],
  elapsedMsByRepo: {},
  warnings: [],
}));
const mockPersistCheckpoint = vi.fn(async () => {});
const mockSaveImageAttachments = vi.fn(async () => []);
const mockCheckUpdatePendingRestart = vi.fn(async () => null);

vi.mock("@/lib/server/task-artifacts", () => ({
  saveImageAttachments: (...args: unknown[]) =>
    mockSaveImageAttachments(...(args as [])),
  snapshotActionArtifact: vi.fn(async () => {}),
}));

vi.mock("@/lib/server/chat-checkpoint", () => ({
  captureChatCheckpoint: (...args: unknown[]) =>
    mockCaptureCheckpoint(...(args as [])),
  persistCheckpointForReply: (...args: unknown[]) =>
    mockPersistCheckpoint(...(args as [])),
}));

vi.mock("@/lib/server/update-pending", () => ({
  checkUpdatePendingRestart: () => mockCheckUpdatePendingRestart(),
}));

vi.mock("@/lib/server/chat-runner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/chat-runner")>();
  return {
    ...actual,
    sendChatMessage: (...args: unknown[]) =>
      mockSendChatMessage(...(args as [])),
    runChatSession: (...args: unknown[]) =>
      mockRunChatSession(...(args as [])),
    hasChatSession: (...args: unknown[]) =>
      mockHasChatSession(...(args as [])),
    resumeChatSession: (...args: unknown[]) =>
      mockResumeChatSession(...(args as [])),
    deliverChatAskReply: (...args: unknown[]) =>
      mockDeliverChatAskReply(...(args as [])),
    getChatRunModel: vi.fn(() => ({ id: "test-model" })),
    getChatRunDisabledMcp: vi.fn(() => []),
    getChatRunRepoPaths: vi.fn(() => []),
    cancelChatRun: vi.fn(),
    forceClearChatRun: vi.fn(),
    waitForChatToStop: vi.fn(async () => true),
    releaseChatRunClaim: vi.fn(),
    isChatCompactInProgress: vi.fn(() => false),
    isChatQueueDraining: vi.fn(() => false),
  };
});

vi.mock("@/lib/server/task-runner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/task-runner")>();
  return {
    ...actual,
    deliverAskReply: (...args: unknown[]) =>
      mockDeliverAskReply(...(args as [])),
    deliverTaskQuestion: (...args: unknown[]) =>
      mockDeliverTaskQuestion(...(args as [])),
    resumeCurrentActionWithMessage: (...args: unknown[]) =>
      mockResumeCurrentAction(...(args as [])),
    startOneShotQuestion: (...args: unknown[]) =>
      mockStartOneShotQuestion(...(args as [])),
    supersedePendingAsks: vi.fn(async () => {}),
    isTaskOpStale: vi.fn(() => false),
  };
});

const taskFsCore = await import("@/lib/server/task-fs-core");
const {
  clearEventSeqCounter,
  readEvents,
  taskDir,
  writeMeta,
} = taskFsCore;
const { appendEvent } = await import("@/lib/server/task-fs");
const {
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
  PERSIST_WARNING_DELIVERED,
  agentSessions,
  clearTaskStarting,
} = await import("@/lib/server/task-stream");
const {
  cleanupChatTaskState,
  clearPendingAsk,
  getPendingAsk,
  registerPendingAsk,
} = await import("@/lib/server/chat-pending");
const { clearChatGate, endChatLifecycle } = await import(
  "@/lib/server/chat-gate"
);
const { clearChatQueue } = await import("@/lib/server/chat-queue");

const { POST: chatReplyPost } = await import(
  "@/app/api/tasks/[id]/chat-reply/route"
);
const { POST: questionPost } = await import(
  "@/app/api/tasks/[id]/question/route"
);
const { POST: askReplyPost } = await import(
  "@/app/api/tasks/[id]/ask-reply/route"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r30 DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const MODEL = { id: "test-model" };
const BOOT = { apiKey: "sk-test", model: MODEL };

const eioErr = (): NodeJS.ErrnoException => {
  const err = new Error("simulated EIO") as NodeJS.ErrnoException;
  err.code = "EIO";
  return err;
};

const enoentErr = (): NodeJS.ErrnoException => {
  const err = new Error("simulated ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
};

/** 仅对 events.jsonl 的 appendFile 注入错误；其它路径走真实 IO */
const withAppendFail = async <T,>(
  code: "EIO" | "ENOENT",
  fn: () => Promise<T>,
): Promise<T> => {
  const real = fs.appendFile.bind(fs);
  const spy = vi.spyOn(fs, "appendFile").mockImplementation(async (p, data, enc) => {
    if (String(p).endsWith("events.jsonl")) {
      throw code === "EIO" ? eioErr() : enoentErr();
    }
    return real(p, data, enc as BufferEncoding);
  });
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
};

const makeChatMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `对话 · r30`,
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

const makeTaskMeta = (
  id: string,
  overrides: Partial<TaskMetaV06> = {},
): TaskMetaV06 =>
  ({
    id,
    title: `r30 ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: ["/tmp/fake-repo"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }) as unknown as TaskMetaV06;

const callChatReply = async (
  id: string,
  body: Record<string, unknown>,
): Promise<Response> => {
  const req = new Request(`http://local/api/tasks/${id}/chat-reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return chatReplyPost(req, { params: Promise.resolve({ id }) });
};

const callQuestion = async (
  id: string,
  body: Record<string, unknown>,
): Promise<Response> => {
  const req = new Request(`http://local/api/tasks/${id}/question`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return questionPost(req, { params: Promise.resolve({ id }) });
};

const callAskReply = async (
  id: string,
  body: Record<string, unknown>,
): Promise<Response> => {
  const req = new Request(`http://local/api/tasks/${id}/ask-reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return askReplyPost(req, { params: Promise.resolve({ id }) });
};

describe("R30：R29-4 strict 用户输入 + R29-6 seq durable", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r30_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockSendChatMessage.mockReset();
    mockRunChatSession.mockReset();
    mockHasChatSession.mockReset();
    mockHasChatSession.mockReturnValue(false);
    mockResumeChatSession.mockReset();
    mockResumeChatSession.mockResolvedValue(null);
    mockDeliverChatAskReply.mockReset();
    mockDeliverAskReply.mockReset();
    mockDeliverTaskQuestion.mockReset();
    mockResumeCurrentAction.mockReset();
    mockStartOneShotQuestion.mockReset();
    mockCaptureCheckpoint.mockReset();
    mockCaptureCheckpoint.mockResolvedValue({
      ok: false,
      repoSnapshots: [],
      elapsedMsByRepo: {},
      warnings: [],
    });
    mockPersistCheckpoint.mockReset();
    mockSaveImageAttachments.mockReset();
    mockSaveImageAttachments.mockResolvedValue([]);
    mockCheckUpdatePendingRestart.mockReset();
    mockCheckUpdatePendingRestart.mockResolvedValue(null);
  });

  afterEach(async () => {
    for (const id of ids) {
      agentSessions.delete(id);
      clearTaskStarting(id);
      clearChatGate(id);
      endChatLifecycle(id);
      clearChatQueue(id);
      clearPendingAsk(id);
      cleanupChatTaskState(id);
      clearEventSeqCounter(id);
    }
    await new Promise((r) => setTimeout(r, 20));
    for (const id of ids) {
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
    ids.length = 0;
  });

  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ─────────────────────────────────────────────────────────────
  // R29-4：三 route send 前 EIO → 5xx
  // ─────────────────────────────────────────────────────────────
  it("R29-4 chat-reply：start 前 append EIO → 500、不起 session", async () => {
    const id = alloc();
    await writeMeta(makeChatMeta(id));
    mockHasChatSession.mockReturnValue(false);

    const res = await withAppendFail("EIO", () =>
      callChatReply(id, {
        text: "hello before start",
        bootArgs: BOOT,
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/消息保存失败/);
    expect(mockRunChatSession).not.toHaveBeenCalled();
    const events = await readEvents(id);
    expect(events.some((e) => e.kind === "user_reply")).toBe(false);
  });

  it("R29-4 question：oneshot 前 append EIO → 500、不 start、不清 pending", async () => {
    const id = alloc();
    await writeMeta(makeTaskMeta(id, { runStatus: "idle" }));
    registerPendingAsk(id, {
      askId: "ask_pre",
      questions: [{ id: "q1", question: "?", allowText: true }],
    });
    mockDeliverTaskQuestion.mockResolvedValue("no_session");

    const res = await withAppendFail("EIO", () =>
      callQuestion(id, {
        text: "oneshot before persist",
        bootArgs: BOOT,
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/消息保存失败/);
    expect(mockStartOneShotQuestion).not.toHaveBeenCalled();
    expect(mockResumeCurrentAction).not.toHaveBeenCalled();
    expect(getPendingAsk(id)?.askId).toBe("ask_pre");
  });

  it("R29-4 ask-reply：wake 前 append EIO → 500、不清 pending", async () => {
    const id = alloc();
    const actionId = "act_plan_1";
    await writeMeta(
      makeTaskMeta(id, {
        runStatus: "awaiting_user",
        currentActionId: actionId,
        actions: [
          {
            id: actionId,
            n: 1,
            type: "plan",
            status: "running",
            userInstruction: "",
            artifactPath: null,
            startedAt: Date.now(),
            endedAt: null,
          },
        ],
      } as Partial<TaskMetaV06>),
    );
    const askId = "ask_wake_eio";
    const qId = "q1";
    const questions = [{ id: qId, question: "怎么走？", allowText: true }];
    // 先登记 pending 拿 token，再写请求事件——token 必须一致
    const pending = registerPendingAsk(id, { askId, questions, actionId });
    await appendEvent(id, {
      kind: "ask_user_request",
      actionId,
      text: "需要确认",
      meta: {
        askId,
        token: pending.token,
        questions,
      },
    });
    // 会话死 → 走 wakeWithAnswer（send 前落盘）
    mockDeliverAskReply.mockResolvedValue("no_session");

    const res = await withAppendFail("EIO", () =>
      callAskReply(id, {
        askId,
        answers: [{ questionId: qId, answer: "走 A" }],
        bootArgs: BOOT,
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/消息保存失败/);
    expect(getPendingAsk(id)?.askId).toBe(askId);
    expect(mockResumeCurrentAction).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────
  // R29-4：三 route send 后 EIO → 200 + persistWarning
  // ─────────────────────────────────────────────────────────────
  it("R29-4 chat-reply：send 后 append EIO → 200 + persistWarning", async () => {
    const id = alloc();
    await writeMeta(makeChatMeta(id));
    mockHasChatSession.mockReturnValue(true);
    mockSendChatMessage.mockResolvedValue("sent");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await withAppendFail("EIO", () =>
      callChatReply(id, {
        text: "hello after send",
        bootArgs: BOOT,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      persistWarning?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.persistWarning).toBe(PERSIST_WARNING_DELIVERED);
    expect(mockSendChatMessage).toHaveBeenCalled();
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes("已送达但持久化失败"),
      ),
    ).toBe(true);
    errSpy.mockRestore();
  });

  it("R29-4 question：send 后 append EIO → 200 + persistWarning", async () => {
    const id = alloc();
    // runStatus 不能是 running（route 会 409）；deliver mock 仍返 sent
    await writeMeta(
      makeTaskMeta(id, {
        runStatus: "awaiting_user",
        currentActionId: "act_1",
        actions: [
          {
            id: "act_1",
            n: 1,
            type: "plan",
            status: "running",
            userInstruction: "",
            artifactPath: null,
            startedAt: Date.now(),
            endedAt: null,
          },
        ],
      } as Partial<TaskMetaV06>),
    );
    mockDeliverTaskQuestion.mockResolvedValue("sent");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await withAppendFail("EIO", () =>
      callQuestion(id, {
        text: "after send question",
        bootArgs: BOOT,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      persistWarning?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.persistWarning).toBe(PERSIST_WARNING_DELIVERED);
    expect(mockStartOneShotQuestion).not.toHaveBeenCalled();
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes("已送达但持久化失败"),
      ),
    ).toBe(true);
    errSpy.mockRestore();
  });

  it("R29-4 ask-reply：send 后 append EIO → 200 + persistWarning、清 pending", async () => {
    const id = alloc();
    const actionId = "act_plan_2";
    await writeMeta(
      makeTaskMeta(id, {
        runStatus: "awaiting_user",
        currentActionId: actionId,
        actions: [
          {
            id: actionId,
            n: 1,
            type: "plan",
            status: "running",
            userInstruction: "",
            artifactPath: null,
            startedAt: Date.now(),
            endedAt: null,
          },
        ],
      } as Partial<TaskMetaV06>),
    );
    const askId = "ask_sent_eio";
    const qId = "q1";
    const questions = [{ id: qId, question: "怎么走？", allowText: true }];
    const pending = registerPendingAsk(id, { askId, questions, actionId });
    await appendEvent(id, {
      kind: "ask_user_request",
      actionId,
      text: "需要确认",
      meta: {
        askId,
        token: pending.token,
        questions,
      },
    });
    mockDeliverAskReply.mockResolvedValue("sent");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // 只让「已答」那次 append 失败：先 seed 成功、再对后续 events append 注入 EIO
    // seed 已完成；本次 call 的 ask_user_reply 会撞 EIO
    const res = await withAppendFail("EIO", () =>
      callAskReply(id, {
        askId,
        answers: [{ questionId: qId, answer: "走 B" }],
        bootArgs: BOOT,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      persistWarning?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.persistWarning).toBe(PERSIST_WARNING_DELIVERED);
    expect(getPendingAsk(id)).toBeNull();
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes("已送达但持久化失败"),
      ),
    ).toBe(true);
    errSpy.mockRestore();
  });

  // ─────────────────────────────────────────────────────────────
  // R29-6：seq 连续性
  // ─────────────────────────────────────────────────────────────
  it("R29-6：cleanup 后 append seq 严格大于 durable 尾", async () => {
    const id = alloc();
    await writeMeta(makeTaskMeta(id));
    const e1 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r30-seq-1",
    });
    const e2 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r30-seq-2",
    });
    expect(e1?.seq).toBe(1);
    expect(e2?.seq).toBe(2);
    cleanupChatTaskState(id);
    const e3 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r30-seq-after-cleanup",
    });
    expect(e3?.seq).toBeGreaterThan(e2!.seq!);
  });

  it("R29-6：counter 清空（模拟重启）→ append 从 durable 尾恢复递增", async () => {
    const id = alloc();
    await writeMeta(makeTaskMeta(id));
    await writeEventAndPublish(id, {
      kind: "info",
      text: "r30-restart-1",
    });
    const e2 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r30-restart-2",
    });
    expect(e2?.seq).toBe(2);
    // 模拟进程重启：模块级 counter 清空，文件仍在
    clearEventSeqCounter(id);
    const e3 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r30-restart-3",
    });
    expect(e3?.seq).toBe(3);
    const disk = await readEvents(id);
    const seqs = disk.map((e) => e.seq).filter((s): s is number => typeof s === "number");
    expect(seqs).toEqual([1, 2, 3]);
  });

  // ─────────────────────────────────────────────────────────────
  // R29-4：ENOENT 仍返 null、不抛
  // ─────────────────────────────────────────────────────────────
  it("R29-4：strict helper 遇 ENOENT 返 null、不抛", async () => {
    const id = alloc();
    await writeMeta(makeTaskMeta(id));
    const result = await withAppendFail("ENOENT", () =>
      writeUserEventAndPublishStrict(id, {
        kind: "user_reply",
        text: "should-be-null",
      }),
    );
    expect(result).toBeNull();
  });
});
