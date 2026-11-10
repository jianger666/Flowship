/**
 * 「交还给 AI」的真实注入通道（handback.ts 的 defaultHandbackDeps）：
 * 重模块（task-fs / chat-inject / task-question-inject / schedule-service …）全部 mock，只验证「选哪条通道、带什么选项、结果怎么分类」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  task: null as Record<string, unknown> | null,
  pendingAsk: null as unknown,
  boot: { apiKey: "k", model: { id: "m" } } as unknown,
  chatRes: { status: 200, body: { ok: true } } as { status: number; body: unknown },
  taskRes: { status: 200, body: { ok: true } } as { status: number; body: unknown },
}));

const mkRes = (r: { status: number; body: unknown }) =>
  new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });

vi.mock("@/lib/server/task-fs", () => ({ getTaskMeta: vi.fn(async () => state.task) }));
vi.mock("@/lib/server/chat-pending", () => ({ getPendingAsk: vi.fn(() => state.pendingAsk) }));
vi.mock("@/lib/server/schedule-service", () => ({ loadBootArgs: vi.fn(async () => state.boot) }));
vi.mock("@/lib/server/chat-inject", () => ({
  handleChatReplyInject: vi.fn(async () => mkRes(state.chatRes)),
}));
vi.mock("@/lib/server/task-question-inject", () => ({
  handleTaskQuestionInject: vi.fn(async () => mkRes(state.taskRes)),
}));
vi.mock("@/lib/server/task-stream", () => ({ writeEventAndPublish: vi.fn(async () => null) }));

import { defaultHandbackDeps } from "@/lib/server/browser/handback";
import { handleChatReplyInject } from "@/lib/server/chat-inject";
import { handleTaskQuestionInject } from "@/lib/server/task-question-inject";
import { writeEventAndPublish } from "@/lib/server/task-stream";

const input = {
  taskId: "t1",
  text: "回来了",
  agentContext: "[浏览器·用户交还了操作权] …",
  clientItemId: "browser-handback-1",
  meta: { source: "browser", subkind: "handback", browserEntryCount: 1 },
};

beforeEach(() => {
  state.task = { id: "t1", mode: "task", archived: false };
  state.pendingAsk = null;
  state.boot = { apiKey: "k", model: { id: "m" } };
  state.chatRes = { status: 200, body: { ok: true } };
  state.taskRes = { status: 200, body: { ok: true } };
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("defaultHandbackDeps.deliver", () => {
  it("task 模式：走 handleTaskQuestionInject，带 scheduledTrigger + agentContext + browser 来源 meta", async () => {
    const out = await defaultHandbackDeps.deliver(input);
    expect(out).toEqual({ kind: "delivered" });
    expect(handleChatReplyInject).not.toHaveBeenCalled();
    const [id, body, options] = vi.mocked(handleTaskQuestionInject).mock.calls[0]!;
    expect(id).toBe("t1");
    expect(body).toMatchObject({ text: "回来了", clientItemId: "browser-handback-1", bootArgs: state.boot });
    // 操作摘要不进气泡正文
    expect((body as { text: string }).text).not.toContain("浏览器·用户交还了操作权");
    expect(options).toMatchObject({
      scheduledTrigger: true,
      agentContext: input.agentContext,
      userReplyMetaExtra: { source: "browser" },
    });
  });

  it("chat 模式：走 handleChatReplyInject，同样的选项", async () => {
    state.task = { id: "t1", mode: "chat", archived: false };
    const out = await defaultHandbackDeps.deliver(input);
    expect(out).toEqual({ kind: "delivered" });
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    const [, , options] = vi.mocked(handleChatReplyInject).mock.calls[0]!;
    expect(options).toMatchObject({ scheduledTrigger: true, agentContext: input.agentContext, userReplyMetaExtra: { source: "browser" } });
  });

  it("会话不存在 / 已归档 / 已合入 → 永久失败，不去注入", async () => {
    state.task = null;
    expect(await defaultHandbackDeps.deliver(input)).toMatchObject({ kind: "failed", permanent: true });
    state.task = { id: "t1", mode: "task", archived: true };
    expect(await defaultHandbackDeps.deliver(input)).toMatchObject({ kind: "failed", permanent: true });
    state.task = { id: "t1", mode: "task", repoStatus: "merged" };
    expect(await defaultHandbackDeps.deliver(input)).toMatchObject({ kind: "failed", permanent: true });
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
  });

  it("有用户还没答的提问 → retry（不去顶掉提问）", async () => {
    state.pendingAsk = { askId: "a1" };
    expect(await defaultHandbackDeps.deliver(input)).toMatchObject({ kind: "retry" });
    state.pendingAsk = null;
    state.task = { id: "t1", mode: "task", pendingAskId: "a2" };
    expect(await defaultHandbackDeps.deliver(input)).toMatchObject({ kind: "retry" });
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
  });

  it("缺凭据 / 提供方悬空 → 失败并带原因", async () => {
    state.boot = null;
    expect(await defaultHandbackDeps.deliver(input)).toMatchObject({ kind: "failed" });
    state.boot = { danglingProvider: "该会话绑定的提供方已被删除" };
    expect(await defaultHandbackDeps.deliver(input)).toMatchObject({ kind: "failed", reason: "该会话绑定的提供方已被删除" });
  });

  it("注入返回 409（agent 正在跑）→ retry；404 → 永久失败；其它 4xx → 失败", async () => {
    state.taskRes = { status: 409, body: { error: "agent 正在跑" } };
    expect(await defaultHandbackDeps.deliver(input)).toMatchObject({ kind: "retry" });
    state.taskRes = { status: 404, body: { error: "not_found" } };
    expect(await defaultHandbackDeps.deliver(input)).toMatchObject({ kind: "failed", permanent: true });
    state.taskRes = { status: 400, body: { error: "缺 bootArgs" } };
    expect(await defaultHandbackDeps.deliver(input)).toMatchObject({ kind: "failed" });
  });
});

describe("defaultHandbackDeps.notifyFailure", () => {
  it("写一条 info 事件，带 browser 来源标记", async () => {
    await defaultHandbackDeps.notifyFailure("t1", "没送进去");
    expect(writeEventAndPublish).toHaveBeenCalledWith("t1", {
      kind: "info",
      text: "没送进去",
      meta: { source: "browser", subkind: "handback_failed" },
    });
  });
});
