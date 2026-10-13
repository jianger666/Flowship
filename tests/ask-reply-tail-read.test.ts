/**
 * ask-reply 的读盘策略：入口判定先只读尾部事件（不整文件 parse 大对话），
 * 请求事件不在窗口里才退回全量读；响应里的 task 只带尾部；僵尸分支只读 meta。
 *
 * 判定语义必须与「一直全量读」一致——所以重点测「窗口里没有请求事件」的回退：
 * 用户答很早以前的旧弹窗时，已答 / 已跳过 / 已过期这些判定不能因为窗口太小而丢。
 *
 * 全部 mock 外部调用——不起 agent、不碰盘、不发飞书。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task, TaskEvent } from "@/lib/types";

const {
  agentSessions,
  clearPendingAsk,
  deliverAskReply,
  deliverChatAskReply,
  getPendingAsk,
  restorePendingAskIf,
  takePendingAskIf,
  getTask,
  getTaskMeta,
  getTaskWithTailEvents,
  hasChatSession,
  publishTaskStreamEvent,
  resumeCurrentActionWithMessage,
  saveImageAttachments,
  setTaskRunStatusIfRunOwner,
  supersedePendingAsks,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    agentSessions: new Map<string, unknown>(),
    clearPendingAsk: vi.fn<AnyFn>(),
    deliverAskReply: vi.fn<AnyFn>(async () => "sent"),
    deliverChatAskReply: vi.fn<AnyFn>(async () => true),
    getPendingAsk: vi.fn<AnyFn>(),
    restorePendingAskIf: vi.fn<AnyFn>(),
    takePendingAskIf: vi.fn<AnyFn>(),
    getTask: vi.fn<AnyFn>(),
    getTaskMeta: vi.fn<AnyFn>(),
    getTaskWithTailEvents: vi.fn<AnyFn>(),
    hasChatSession: vi.fn<AnyFn>(() => true),
    publishTaskStreamEvent: vi.fn<AnyFn>(),
    resumeCurrentActionWithMessage: vi.fn<AnyFn>(async () => undefined),
    saveImageAttachments: vi.fn<AnyFn>(async () => []),
    setTaskRunStatusIfRunOwner: vi.fn<AnyFn>(async () => null),
    supersedePendingAsks: vi.fn<AnyFn>(async () => []),
    writeEventAndPublish: vi.fn<AnyFn>(async () => undefined),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(async () => ({ id: "e1" })),
  };
});

vi.mock("@/lib/server/task-fs", () => ({
  getTask,
  getTaskMeta,
  getTaskWithTailEvents,
  setTaskRunStatusIfRunOwner,
}));
vi.mock("@/lib/server/task-artifacts", () => ({ saveImageAttachments }));
vi.mock("@/lib/server/chat-pending", () => ({
  clearPendingAsk,
  getPendingAsk,
  restorePendingAskIf,
  takePendingAskIf,
  wasAskTakenRecently: vi.fn(() => false),
}));
vi.mock("@/lib/server/task-runner", () => ({
  deliverAskReply,
  isTaskOpStale: () => false,
  resumeCurrentActionWithMessage,
  supersedePendingAsks,
  TASK_OP_STALE_HTTP_MESSAGE: "任务状态刚变化、请重新发送",
}));
vi.mock("@/lib/server/chat-runner", () => ({
  deliverChatAskReply,
  hasChatSession,
}));
vi.mock("@/lib/server/task-stream", () => ({
  agentSessions,
  getTaskOpGeneration: () => 1,
  isTaskOpCurrent: () => true,
  PERSIST_FAIL_RETRY_MESSAGE: "落盘失败、请重试",
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
  publishTaskStreamEvent,
  snapshotTaskOp: () => ({}),
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
}));
vi.mock("@/lib/server/chat-gate", () => ({ getChatLifecycle: () => null }));

const { POST } = await import("@/app/api/tasks/[id]/ask-reply/route");

const TASK_ID = "task-1";
const ASK_ID = "ask-1";

const requestEvent = (askId = ASK_ID): TaskEvent =>
  ({
    id: `req-${askId}`,
    kind: "ask_user_request",
    text: "有问题要问",
    ts: Date.now(),
    actionId: "act-1",
    meta: {
      askId,
      token: "tok-1",
      questions: [{ id: "q1", question: "用哪个方案", allowText: true }],
    },
  }) as unknown as TaskEvent;

const replyEvent = (askId = ASK_ID): TaskEvent =>
  ({
    id: `rep-${askId}`,
    kind: "ask_user_reply",
    text: "方案 A",
    ts: Date.now(),
    actionId: "act-1",
    meta: { askId },
  }) as unknown as TaskEvent;

const filler = (n: number): TaskEvent[] =>
  Array.from(
    { length: n },
    (_, i) =>
      ({
        id: `fill-${i}`,
        kind: "info",
        text: `filler ${i}`,
        ts: Date.now(),
      }) as unknown as TaskEvent,
  );

const taskWith = (
  events: TaskEvent[],
  opts?: { truncated?: boolean; runStatus?: Task["runStatus"] },
): Task =>
  ({
    id: TASK_ID,
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: opts?.runStatus ?? "awaiting_user",
    currentActionId: "act-1",
    repoPaths: ["/tmp/repo"],
    mrs: [],
    actions: [
      {
        id: "act-1",
        n: 1,
        type: "plan",
        status: "running",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    events,
    ...(opts?.truncated ? { eventsTruncated: true } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as Task;

const post = async (body: unknown): Promise<Response> =>
  POST(
    new Request(`http://localhost/api/tasks/${TASK_ID}/ask-reply`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: TASK_ID }) },
  );

const ANSWER = {
  askId: ASK_ID,
  answers: [{ questionId: "q1", answer: "用方案 B" }],
};

const tailCalls = (): unknown[][] =>
  (getTaskWithTailEvents as unknown as { mock: { calls: unknown[][] } }).mock
    .calls;

beforeEach(() => {
  vi.clearAllMocks();
  agentSessions.clear();
  agentSessions.set(TASK_ID, {});
  const pendingAsk = {
    askId: ASK_ID,
    token: "tok-1",
    createdAt: Date.now(),
    questions: [{ id: "q1", question: "用哪个方案", allowText: true }],
  };
  getPendingAsk.mockReturnValue(pendingAsk);
  takePendingAskIf.mockReturnValue(pendingAsk);
  deliverAskReply.mockResolvedValue("sent");
  writeUserEventAndPublishStrict.mockResolvedValue({ id: "e1" });
  // 默认：尾部读返回含请求事件的窗口；全量 / meta 读也都能读到
  getTaskWithTailEvents.mockImplementation(async () =>
    taskWith([requestEvent()], { truncated: true }),
  );
  getTask.mockImplementation(async () => taskWith([requestEvent()]));
  getTaskMeta.mockImplementation(async () => taskWith([]));
});

describe("入口判定：先读尾部、窗口里有请求事件就不退回全量", () => {
  it("请求事件在尾部窗口 → 一次全量 getTask 都不调、判定与全量一致地放行", async () => {
    const resp = await post(ANSWER);

    expect(resp.status).toBe(200);
    expect(getTask).not.toHaveBeenCalled();
    // 入口读 200 条（判定窗口）
    expect(tailCalls()[0]).toEqual([TASK_ID, 200]);
    expect(deliverAskReply).toHaveBeenCalledTimes(1);
  });

  it("窗口里已有这组 ask 的回答 → 409 已回答（后续标记一定在请求事件之后、也在窗口里）", async () => {
    getTaskWithTailEvents.mockImplementation(async () =>
      taskWith([requestEvent(), replyEvent()], { truncated: true }),
    );

    const resp = await post(ANSWER);

    expect(resp.status).toBe(409);
    expect(String((await resp.json()).error)).toContain("已经回答过");
    expect(getTask).not.toHaveBeenCalled();
    expect(deliverAskReply).not.toHaveBeenCalled();
  });
});

describe("入口判定：窗口里没有请求事件 → 退回全量读、保持原判定语义", () => {
  it("很早以前的旧弹窗（窗口被截断、请求事件不在窗口里）：退回全量，全量里已回答 → 409", async () => {
    // 尾部窗口只有一堆无关事件、被截断
    getTaskWithTailEvents.mockImplementation(async () =>
      taskWith(filler(200), { truncated: true }),
    );
    // 全量里该 ask 早已回答过
    getTask.mockImplementation(async () =>
      taskWith([requestEvent(), replyEvent(), ...filler(500)]),
    );

    const resp = await post(ANSWER);

    expect(getTask).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(409);
    expect(String((await resp.json()).error)).toContain("已经回答过");
    expect(deliverAskReply).not.toHaveBeenCalled();
  });

  it("窗口里只有「别的 ask」的请求事件（本 askId 的不在）→ 同样要退回全量，不能把它当成命中", async () => {
    getTaskWithTailEvents.mockImplementation(async () =>
      taskWith([...filler(100), requestEvent("ask-newer")], { truncated: true }),
    );
    getTask.mockImplementation(async () =>
      taskWith([requestEvent(), replyEvent(), requestEvent("ask-newer")]),
    );

    const resp = await post(ANSWER);

    expect(getTask).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(409);
    expect(String((await resp.json()).error)).toContain("已经回答过");
  });

  it("窗口被截断、全量里也没有这个 askId → 404（而不是误放行）", async () => {
    getTaskWithTailEvents.mockImplementation(async () =>
      taskWith(filler(200), { truncated: true }),
    );
    getTask.mockImplementation(async () => taskWith(filler(500)));

    const resp = await post(ANSWER);

    expect(getTask).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(404);
    expect(String((await resp.json()).error)).toContain("找不到");
    expect(deliverAskReply).not.toHaveBeenCalled();
  });

  it("窗口没被截断（整个对话都在窗口里）且没有请求事件 → 直接 404、没必要再全量读", async () => {
    getTaskWithTailEvents.mockImplementation(async () =>
      taskWith(filler(3), { truncated: false }),
    );

    const resp = await post(ANSWER);

    expect(getTask).not.toHaveBeenCalled();
    expect(resp.status).toBe(404);
  });

  it("任务不存在 → 404、不退回全量", async () => {
    getTaskWithTailEvents.mockImplementation(async () => null);

    const resp = await post(ANSWER);

    expect(resp.status).toBe(404);
    expect(getTask).not.toHaveBeenCalled();
  });
});

describe("响应里的 task 只带尾部事件", () => {
  it("成功响应的 task 来自 getTaskWithTailEvents(id, 300)、不是全量 getTask", async () => {
    const resp = await post(ANSWER);

    expect(resp.status).toBe(200);
    expect(getTask).not.toHaveBeenCalled();
    const lens = tailCalls().map((c) => c[1]);
    expect(lens).toContain(200);
    expect(lens).toContain(300);
    const body = (await resp.json()) as { ok: boolean; task: Task };
    expect(body.ok).toBe(true);
    expect(body.task.id).toBe(TASK_ID);
  });
});

describe("僵尸唤醒分支的响应同样只带尾部", () => {
  it("登记没了、会话也没了、任务停在 awaiting_user → 唤醒兜底；响应的 task 来自 tail(300)、全程不全量读", async () => {
    takePendingAskIf.mockReturnValue(null);
    getPendingAsk.mockReturnValue(null);
    agentSessions.clear(); // 会话已死
    getTaskMeta.mockImplementation(async () =>
      taskWith([], { runStatus: "awaiting_user" }),
    );

    const resp = await post({
      ...ANSWER,
      bootArgs: { apiKey: "k_test", model: { id: "composer-2.5" } },
    });

    expect(resp.status).toBe(200);
    expect(resumeCurrentActionWithMessage).toHaveBeenCalledTimes(1);
    expect(getTask).not.toHaveBeenCalled();
    expect(tailCalls().map((c) => c[1])).toContain(300);
    const body = (await resp.json()) as { ok: boolean; task: Task };
    expect(body.ok).toBe(true);
    expect(body.task.id).toBe(TASK_ID);
  });
});

describe("登记为空的僵尸判定只读 meta", () => {
  it("登记没了但会话还活着 → 「提问已失效」409；这里只看 runStatus，用 getTaskMeta、不全量读", async () => {
    // 登记被别人摘走：本次认领拿不到
    takePendingAskIf.mockReturnValue(null);
    getPendingAsk.mockReturnValue(null);
    // 会话还活着（beforeEach 已 set）
    getTaskMeta.mockImplementation(async () =>
      taskWith([], { runStatus: "awaiting_user" }),
    );

    const resp = await post(ANSWER);

    expect(resp.status).toBe(409);
    expect(String((await resp.json()).error)).toContain("已失效");
    expect(getTaskMeta).toHaveBeenCalled();
    expect(getTask).not.toHaveBeenCalled();
    expect(deliverAskReply).not.toHaveBeenCalled();
  });
});
