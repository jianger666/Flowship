/**
 * `injectPendingAskText` 入口同步摘走 pending（P2-2 跨链答题双投）
 *
 * 背景：群答题卡按钮走 card.action 串行链、群里打字答题走入向消息串行链——
 * 两条链互不排队。旧实现 `get → (await deliver) → clear` 中间的窗口让同一组问题被
 * 投两遍 [ASK_USER_REPLY]。修法：入口 takePendingAsk 同步摘走、失败按条件放回。
 *
 * 全部 mock 外部调用——不起 agent、不碰飞书。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  agentSessions,
  deliverAskReply,
  deliverChatAskReply,
  getChatLifecycle,
  getTask,
  hasChatSession,
  saveImageAttachments,
  syncTaskPendingAskId,
  writeUserEventAndPublishStrict,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    agentSessions: new Map<string, unknown>(),
    deliverAskReply: vi.fn<AnyFn>(async () => "sent"),
    deliverChatAskReply: vi.fn<AnyFn>(async () => true),
    getChatLifecycle: vi.fn<AnyFn>(() => null),
    getTask: vi.fn<AnyFn>(),
    hasChatSession: vi.fn<AnyFn>(() => false),
    saveImageAttachments: vi.fn<AnyFn>(async () => []),
    syncTaskPendingAskId: vi.fn<AnyFn>(async () => undefined),
    writeUserEventAndPublishStrict: vi.fn<AnyFn>(async () => ({ id: "e1" })),
  };
});

vi.mock("@/lib/server/task-runner", () => ({ deliverAskReply }));
vi.mock("@/lib/server/chat-runner", () => ({
  deliverChatAskReply,
  hasChatSession,
}));
vi.mock("@/lib/server/task-artifacts", () => ({ saveImageAttachments }));
// chat-pending 的 meta 同步走动态 import("./task-fs")——这里必须一并 mock，
// 否则同步链抛「missing export」变成未捕获拒绝
vi.mock("@/lib/server/task-fs", () => ({ getTask, syncTaskPendingAskId }));
vi.mock("@/lib/server/task-stream", () => ({
  agentSessions,
  PERSIST_WARNING_DELIVERED: "已送达但持久化失败",
  writeUserEventAndPublishStrict,
}));
vi.mock("@/lib/server/chat-gate", () => ({ getChatLifecycle }));

// chat-pending 用真的——测的就是它的 take / 条件 restore 语义
const { getPendingAsk, registerPendingAsk } = await import(
  "@/lib/server/chat-pending"
);
const { injectPendingAskText } = await import(
  "@/lib/server/feishu-bridge/ask-inject"
);

const TASK_ID = "task-1";

const registerAsk = (askId: string): void => {
  registerPendingAsk(TASK_ID, {
    askId,
    questions: [{ id: "q1", question: "用哪个方案", allowText: true }],
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  agentSessions.clear();
  getChatLifecycle.mockReturnValue(null);
  deliverAskReply.mockResolvedValue("sent");
  getTask.mockImplementation(async () => ({
    id: TASK_ID,
    mode: "task",
    events: [],
  }));
});

afterEach(() => {
  agentSessions.clear();
});

describe("并发两条链答同一题", () => {
  it("只投一份答案，后到的那条拿到 no_pending", async () => {
    registerAsk("ask-1");
    // deliver 卡住 = 拉开旧实现 check→deliver→clear 的那段窗口
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    deliverAskReply.mockImplementation(async () => {
      await gate;
      return "sent";
    });

    const first = injectPendingAskText(TASK_ID, "方案 B", undefined, undefined, {
      answeredBy: "李四",
    });
    const second = injectPendingAskText(TASK_ID, "方案 A");
    release?.();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual({ ok: true });
    expect(b).toMatchObject({ ok: false, reason: "no_pending" });
    expect(deliverAskReply).toHaveBeenCalledTimes(1);
    expect(getPendingAsk(TASK_ID)).toBeNull();
  });
});

describe("投递失败后的条件放回", () => {
  it("会话还活着（只是忙）→ 放回原题、可以再答一次", async () => {
    registerAsk("ask-1");
    agentSessions.set(TASK_ID, {});
    deliverAskReply.mockResolvedValue("no_session");

    const r = await injectPendingAskText(TASK_ID, "方案 B");

    expect(r).toMatchObject({ ok: false, reason: "deliver_failed" });
    expect(getPendingAsk(TASK_ID)?.askId).toBe("ask-1");
  });

  it("会话已死 → 不放回（这组问题就此作废、改走消息注入通道）", async () => {
    registerAsk("ask-1");
    deliverAskReply.mockResolvedValue("no_session");

    const r = await injectPendingAskText(TASK_ID, "方案 B");

    expect(r).toMatchObject({ ok: false, reason: "deliver_failed" });
    expect(getPendingAsk(TASK_ID)).toBeNull();
  });

  it("摘走后 agent 已登记新提问 → 失败也不许拿旧的盖掉新的", async () => {
    registerAsk("ask-1");
    agentSessions.set(TASK_ID, {});
    deliverAskReply.mockImplementation(async () => {
      registerAsk("ask-2");
      return "no_session";
    });

    await injectPendingAskText(TASK_ID, "方案 B");

    expect(getPendingAsk(TASK_ID)?.askId).toBe("ask-2");
  });

  it("任务正在停 / 删（lifecycle 非空）→ 原题放回、等停完再答", async () => {
    registerAsk("ask-1");
    getChatLifecycle.mockReturnValue("stopping");

    const r = await injectPendingAskText(TASK_ID, "方案 B");

    expect(r).toMatchObject({ ok: false, reason: "lifecycle" });
    expect(getPendingAsk(TASK_ID)?.askId).toBe("ask-1");
    expect(deliverAskReply).not.toHaveBeenCalled();
  });
});
