/**
 * 答题卡 `/skill` 的「气泡 vs agent 文本」分流（v1.1.x 富输入贯通的核心契约）
 *
 * 约定：事件气泡里存**用户原答案**（replyText）、真正 send 给 agent 的是
 * `skillDirective + replyText`。写反了要么 agent 收不到 skill 指引（功能失效），
 * 要么用户气泡里凭空多出一段「[使用 skill] …」（用户没打过这些字）。
 *
 * 全部 mock 外部调用——不起 agent、不碰盘、不发飞书。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

const {
  agentSessions,
  clearPendingAsk,
  deliverAskReply,
  deliverChatAskReply,
  getPendingAsk,
  restorePendingAskIf,
  takePendingAskIf,
  getTask,
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

vi.mock("@/lib/server/task-fs", () => ({ getTask, setTaskRunStatusIfRunOwner }));
vi.mock("@/lib/server/task-artifacts", () => ({ saveImageAttachments }));
vi.mock("@/lib/server/chat-pending", () => ({
  clearPendingAsk,
  getPendingAsk,
  restorePendingAskIf,
  takePendingAskIf,
  // 本文件的用例都摘到了登记、走不到僵尸兜底；只是别让 import 缺导出
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
const SKILL = { name: "lark-doc", absPath: "/skills/lark-doc/SKILL.md" };

const askTask = (): Task =>
  ({
    id: TASK_ID,
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: "awaiting_user",
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
    events: [
      {
        id: "ev-1",
        kind: "ask_user_request",
        text: "有问题要问",
        ts: Date.now(),
        actionId: "act-1",
        meta: {
          askId: ASK_ID,
          token: "tok-1",
          questions: [{ id: "q1", question: "用哪个方案", allowText: true }],
        },
      },
    ],
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

/** deliverAskReply(task, agentText, ...) 的第 2 个实参 */
const deliveredAgentText = (): string =>
  String(
    (deliverAskReply as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] ?? "",
  );

/** 落进事件流的气泡原文 */
const bubbleText = (): string =>
  String(
    (
      (
        writeUserEventAndPublishStrict as unknown as {
          mock: { calls: unknown[][] };
        }
      ).mock.calls[0]?.[1] as { text?: string } | undefined
    )?.text ?? "",
  );

beforeEach(() => {
  vi.clearAllMocks();
  agentSessions.clear();
  agentSessions.set(TASK_ID, {});
  getTask.mockImplementation(async () => askTask());
  const pendingAsk = {
    askId: ASK_ID,
    token: "tok-1",
    createdAt: Date.now(),
    questions: [{ id: "q1", question: "用哪个方案", allowText: true }],
  };
  getPendingAsk.mockReturnValue(pendingAsk);
  // 路由入口把这组登记**原子摘走**（答 / 跳过互斥、见 chat-pending.takePendingAskIf）
  takePendingAskIf.mockReturnValue(pendingAsk);
  deliverAskReply.mockResolvedValue("sent");
  writeUserEventAndPublishStrict.mockResolvedValue({ id: "e1" });
});

describe("答题卡 /skill：气泡存原文、指引只进 agent", () => {
  it("送 agent 的文本带 [使用 skill] 段、事件气泡不带", async () => {
    const resp = await post({
      askId: ASK_ID,
      answers: [{ questionId: "q1", answer: "用方案 B" }],
      skills: [SKILL],
    });

    expect(resp.status).toBe(200);
    const agentText = deliveredAgentText();
    expect(agentText).toContain("[使用 skill]");
    expect(agentText).toContain(SKILL.absPath);
    expect(agentText).toContain("用方案 B");
    // 指引在前：agent 先 read skill 再按答案干活
    expect(agentText.indexOf("[使用 skill]")).toBeLessThan(
      agentText.indexOf("[ASK_USER_REPLY]"),
    );

    const bubble = bubbleText();
    expect(bubble).toContain("用方案 B");
    expect(bubble).not.toContain("[使用 skill]");
    expect(bubble).not.toContain(SKILL.absPath);
  });

  it("没引用 skill → 两者完全一致（老行为零变化）", async () => {
    await post({
      askId: ASK_ID,
      answers: [{ questionId: "q1", answer: "用方案 B" }],
    });

    expect(deliveredAgentText()).toBe(bubbleText());
    expect(deliveredAgentText()).not.toContain("[使用 skill]");
  });

  it("deferred（稍后再答）不带 skill 指引——没正文就无所谓指引", async () => {
    await post({ askId: ASK_ID, deferred: true, skills: [SKILL] });

    expect(deliveredAgentText()).not.toContain("[使用 skill]");
  });

  it("skill 超上限 → 整条 400、不投递（客户端已按同一上限截断、走到这里是直调）", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `s${i}`,
      absPath: `/skills/s${i}/SKILL.md`,
    }));
    const resp = await post({
      askId: ASK_ID,
      answers: [{ questionId: "q1", answer: "用方案 B" }],
      skills: many,
    });

    expect(resp.status).toBe(400);
    expect(String((await resp.json()).error)).toContain("最多引用");
    expect(deliverAskReply).not.toHaveBeenCalled();
  });
});
