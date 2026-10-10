/**
 * handleSdkMessage：tool_call running 去重 + task 工具 args 短字段前置 / 截断放大
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseTaskToolArgs, parseTodoToolArgs } from "@/lib/tool-display";

type WrittenEvent = {
  kind: string;
  text?: string;
  meta?: Record<string, unknown>;
};

type WriteOwnedFn = (
  taskId: string,
  stillCurrent: () => boolean,
  event: WrittenEvent,
) => Promise<void>;

type AppendEventFn = (
  taskId: string,
  event: WrittenEvent,
  lease?: () => boolean,
  onCommitted?: (event: unknown) => void,
) => Promise<unknown>;

const writeOwnedEventAndPublish = vi.fn<WriteOwnedFn>(async () => {});
const appendEvent = vi.fn<AppendEventFn>(async () => null);

vi.mock("@/lib/server/task-fs", () => ({
  getTask: vi.fn(),
  patchActionIfOwner: vi.fn(),
  appendEvent,
}));

vi.mock("@/lib/server/failpoints", () => ({
  failpoint: vi.fn(async () => {}),
}));

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return {
    ...actual,
    writeOwnedEventAndPublish: (
      taskId: string,
      stillCurrent: () => boolean,
      event: WrittenEvent,
    ) => writeOwnedEventAndPublish(taskId, stillCurrent, event),
    publish: vi.fn(),
    publishIfCurrent: vi.fn(),
  };
});

vi.mock("@/lib/server/tool-result-persist", () => ({
  buildToolResultMeta: vi.fn(
    async (input: {
      callId: string;
      rawName: string;
      msgStatus: string;
    }) => ({
      callId: input.callId,
      name: input.rawName,
      status: input.msgStatus === "error" ? "error" : "ok",
      output: "ok",
    }),
  ),
}));

const {
  handleSdkMessage,
  maybeEmitSubmitFixedText,
  SUBMIT_COMPLETED_TEXT,
  __resetToolCallRunningSeenForTest,
} = await import("@/lib/server/sdk-message-handler");
import type { AssistantBufferCtx } from "@/lib/server/sdk-message-handler";

const assistantCtx: AssistantBufferCtx = {
  buffer: "",
  flush: async () => {},
};

const leaseOk = () => true;

const toolCallEvents = (): WrittenEvent[] =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => c[2])
    .filter((e): e is WrittenEvent => e != null && e.kind === "tool_call");

const toolResultEvents = (): WrittenEvent[] =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => c[2])
    .filter((e): e is WrittenEvent => e != null && e.kind === "tool_result");

/** 消音审计落盘（appendEvent）里的事件 */
const mutedEvents = (): WrittenEvent[] =>
  appendEvent.mock.calls
    .map((c) => c[1])
    .filter((e) => e.meta?.muted === true);

describe("handleSdkMessage 交卷/提问后收尾（交卷后答案照常广播、横幅在 run 结束）", () => {
  beforeEach(() => {
    writeOwnedEventAndPublish.mockClear();
    appendEvent.mockClear();
    __resetToolCallRunningSeenForTest();
  });

  const submitWorkCompleted = (result: string) =>
    ({
      type: "tool_call",
      call_id: "call-submit",
      name: "mcp",
      status: "completed",
      args: { providerIdentifier: "custom-user-tools", toolName: "submit_work" },
      result,
    }) as never;

  const artifactWriteToolCall = () =>
    ({
      type: "tool_call",
      call_id: "call-edit-artifact",
      name: "edit",
      status: "running",
      args: { path: "actions/1-plan.md" },
    }) as never;

  const assistantText = (text: string) =>
    ({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    }) as never;

  const bannerEvents = (): WrittenEvent[] =>
    writeOwnedEventAndPublish.mock.calls
      .map((c) => c[2])
      .filter((e) => e.kind === "info" && e.text === SUBMIT_COMPLETED_TEXT);

  it("交卷成功后：交卷后正文照常广播（答案给用户看）、固定横幅只在 run 结束兜底补发一次", async () => {
    const ctx: AssistantBufferCtx = { buffer: "", flush: async () => {}, submitSeen: false };

    // 交卷前的正常正文仍进 buffer
    await handleSdkMessage("task-1", assistantText("正文结论"), ctx, leaseOk);
    expect(ctx.buffer).toContain("正文结论");

    // 本轮写了 artifact（事实信号）——固定横幅的发放前提
    await handleSdkMessage("task-1", artifactWriteToolCall(), ctx, leaseOk);
    expect(ctx.artifactWritten).toBe(true);

    await handleSdkMessage("task-1", submitWorkCompleted("[SUBMITTED] action=act_1 已交卷、系统正在后台跑质量检查"), ctx, leaseOk);
    expect(ctx.submitSeen).toBe(true);

    // 交卷后 thinking 照常广播、不静音
    await handleSdkMessage("task-1", { type: "thinking", text: "系统提示用户继续。" } as never, ctx, leaseOk);
    expect(mutedEvents().filter((e) => e.kind === "thinking")).toHaveLength(0);

    // 交卷后正文（答案）照常广播、进 buffer，不再静音
    await handleSdkMessage("task-1", assistantText("这就是本轮答案。"), ctx, leaseOk);
    expect(ctx.buffer).toContain("这就是本轮答案");
    expect(
      mutedEvents().some((e) => (e.text ?? "").includes("这就是本轮答案")),
    ).toBe(false);

    // 交卷成功一刻：不立即补发横幅（等 run 结束兜底）
    expect(bannerEvents()).toHaveLength(0);

    // run 结束兜底：补发固定横幅一次、内容平台固定、不含「交卷」术语
    const wrote = await maybeEmitSubmitFixedText(ctx, async (ev) => {
      writeOwnedEventAndPublish("task-1", leaseOk, ev as WrittenEvent);
    });
    expect(wrote).toBe(true);
    expect(bannerEvents()).toHaveLength(1);
    expect(bannerEvents()[0]!.text).not.toMatch(/交卷|submit_work/i);

    // 重复调用不再补发
    const wroteAgain = await maybeEmitSubmitFixedText(ctx, async () => {});
    expect(wroteAgain).toBe(false);
  });

  it("纯答疑重新交卷（没写 artifact）：交卷后正文照常广播、run 结束发「已回复」", async () => {
    const ctx: AssistantBufferCtx = { buffer: "", flush: async () => {}, submitSeen: false };

    await handleSdkMessage("task-1", assistantText("这个文案是哪个需求改的？"), ctx, leaseOk);
    await handleSdkMessage("task-1", submitWorkCompleted("[SUBMITTED] action=act_1 已交卷"), ctx, leaseOk);
    expect(ctx.submitSeen).toBe(true);

    // 没写 artifact → 交卷成功一刻不发横幅、也不发「已回复」（等 run 结束）
    expect(bannerEvents()).toHaveLength(0);
    expect(
      writeOwnedEventAndPublish.mock.calls.some(
        (c) => c[2].kind === "info" && c[2].text === "已回复",
      ),
    ).toBe(false);

    // 交卷后正文照常广播、不静音
    await handleSdkMessage("task-1", assistantText("补充说明。"), ctx, leaseOk);
    expect(ctx.buffer).toContain("补充说明");
    expect(
      mutedEvents().some((e) => (e.text ?? "").includes("补充说明")),
    ).toBe(false);

    // run 结束兜底：没写 artifact → 发轻量「已回复」
    const wrote = await maybeEmitSubmitFixedText(ctx, async (ev) => {
      writeOwnedEventAndPublish("task-1", leaseOk, ev as WrittenEvent);
    });
    expect(wrote).toBe(true);
    expect(bannerEvents()).toHaveLength(0);
    expect(
      writeOwnedEventAndPublish.mock.calls.some(
        (c) => c[2].kind === "info" && c[2].text === "已回复",
      ),
    ).toBe(true);
  });

  it("交卷失败（未受理）不消音：模型后续正文仍正常缓冲", async () => {
    const ctx: AssistantBufferCtx = { buffer: "", flush: async () => {}, submitSeen: false };

    await handleSdkMessage(
      "task-1",
      submitWorkCompleted("交卷未受理：MR claim 在飞超时、请稍后重试 submit_work"),
      ctx,
      leaseOk,
    );
    expect(ctx.submitSeen).toBe(false);

    await handleSdkMessage(
      "task-1",
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "交卷没成功，我重试一下。" }],
        },
      } as never,
      ctx,
      leaseOk,
    );
    expect(ctx.buffer).toContain("交卷没成功");
  });

  it("提问成功（[ASK_SUBMITTED]）后：thinking / 正文 / 工具带 muted 标记落盘、不补固定文案", async () => {
    const ctx: AssistantBufferCtx = { buffer: "", flush: async () => {}, askSeen: false };

    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        call_id: "call-ask",
        name: "mcp",
        status: "completed",
        args: { providerIdentifier: "custom-user-tools", toolName: "ask_user" },
        result: "[ASK_SUBMITTED] 问题组 ask_x 已推送给用户（UI 答题卡）。",
      } as never,
      ctx,
      leaseOk,
    );
    expect(ctx.askSeen).toBe(true);

    // 提问后的 thinking / 正文 / 工具照常落盘（appendEvent、不广播）、全部带 muted 标记
    await handleSdkMessage("task-1", { type: "thinking", text: "系统提示用户继续。" } as never, ctx, leaseOk);
    await handleSdkMessage(
      "task-1",
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "正在查看用户对答题卡的回复。" }],
        },
      } as never,
      ctx,
      leaseOk,
    );
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        call_id: "call-read",
        name: "read",
        status: "running",
        args: { path: "/some/events.jsonl" },
      } as never,
      ctx,
      leaseOk,
    );
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        call_id: "call-read",
        name: "read",
        status: "completed",
        args: { path: "/some/events.jsonl" },
        result: "ok",
      } as never,
      ctx,
      leaseOk,
    );
    expect(ctx.buffer).not.toContain("正在查看");
    const mutedThinking = mutedEvents().filter((e) => e.kind === "thinking");
    expect(mutedThinking).toHaveLength(1);
    const mutedAssistant = mutedEvents().filter(
      (e) =>
        e.kind === "assistant_message" &&
        (e.text ?? "").includes("正在查看"),
    );
    expect(mutedAssistant).toHaveLength(1);
    // 提问后的工具调用带 muted 标记（call-read）
    const mutedToolCalls = mutedEvents().filter(
      (e) => e.kind === "tool_call" && e.meta?.callId === "call-read",
    );
    expect(mutedToolCalls).toHaveLength(1);
    // 不补任何固定文案：除消音正文外没有其他未标记 assistant_message
    expect(
      writeOwnedEventAndPublish.mock.calls.some(
        (c) =>
          c[2].kind === "assistant_message" && c[2].meta?.muted !== true,
      ),
    ).toBe(false);
    // 消音事件不经过 SSE 广播（writeOwnedEventAndPublish 里不应有任何 muted 标记事件；
    // ask_user 自身那次正常 tool_result 仍走广播、属预期）
    expect(
      writeOwnedEventAndPublish.mock.calls.some(
        (c) => c[2].meta?.muted === true,
      ),
    ).toBe(false);
  });

  it("提问成功后再调 read：只消音、不结束本轮", async () => {
    const ctx: AssistantBufferCtx = {
      buffer: "",
      flush: async () => {},
      askSeen: false,
    };

    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        call_id: "call-ask",
        name: "ask_user",
        status: "completed",
        result: "[ASK_SUBMITTED] 问题组 ask_x 已推送给用户（UI 答题卡）。",
      } as never,
      ctx,
      leaseOk,
    );
    expect(ctx.askSeen).toBe(true);

    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        call_id: "call-read",
        name: "read",
        status: "running",
        args: { path: "/tmp/x" },
      } as never,
      ctx,
      leaseOk,
    );
    expect(ctx.askSeen).toBe(true);
    const mutedRead = appendEvent.mock.calls.filter(
      (c) =>
        c[1]?.kind === "tool_call" &&
        c[1]?.meta?.callId === "call-read" &&
        c[1]?.meta?.muted === true,
    );
    expect(mutedRead).toHaveLength(1);

    const ctxWait: AssistantBufferCtx = {
      buffer: "",
      flush: async () => {},
      askSeen: true,
    };
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        call_id: "call-curl",
        name: "Shell",
        status: "running",
        args: {
          command:
            'curl -NsS --no-buffer "http://127.0.0.1:8676/api/tasks/t1/ask-wait?token=abc"',
        },
      } as never,
      ctxWait,
      leaseOk,
    );
    expect(ctxWait.askSeen).toBe(true);
    // 等答案 curl 也消音：对用户是协议内部步骤，事件流只留答题卡
    const waitCurl = appendEvent.mock.calls.filter(
      (c) =>
        c[1]?.kind === "tool_call" &&
        c[1]?.meta?.callId === "call-curl" &&
        c[1]?.meta?.muted === true,
    );
    expect(waitCurl).toHaveLength(1);
    expect(
      writeOwnedEventAndPublish.mock.calls.some(
        (c) => c[2]?.meta?.callId === "call-curl",
      ),
    ).toBe(false);
  });

  it("ask-wait curl 吐出 [ASK_USER_REPLY] 后清 askSeen，同一轮可再问", async () => {
    const ctx: AssistantBufferCtx = {
      buffer: "",
      flush: async () => {},
      askSeen: true,
    };
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        call_id: "call-curl-done",
        name: "Shell",
        status: "completed",
        args: {
          command:
            'curl -NsS --no-buffer "http://127.0.0.1:8676/api/tasks/t1/ask-wait?token=abc"',
        },
        result:
          "# ask-wait connected\n[ASK_USER_REPLY]\n\nQ1: 能看到吗？\n答：能看到",
      } as never,
      ctx,
      leaseOk,
    );
    expect(ctx.askSeen).toBe(false);
  });

  it("提问失败（未受理）不消音：模型后续正文仍正常缓冲", async () => {
    const ctx: AssistantBufferCtx = { buffer: "", flush: async () => {}, askSeen: false };

    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        call_id: "call-ask-fail",
        name: "mcp",
        status: "completed",
        args: { providerIdentifier: "custom-user-tools", toolName: "ask_user" },
        result: "交卷未受理：任务当前没有活跃会话桥、请结束本轮回复",
      } as never,
      ctx,
      leaseOk,
    );
    expect(ctx.askSeen).toBe(false);

    await handleSdkMessage(
      "task-1",
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "提问没成功，我重试一下。" }],
        },
      } as never,
      ctx,
      leaseOk,
    );
    expect(ctx.buffer).toContain("提问没成功");
  });
});

beforeEach(() => {
  writeOwnedEventAndPublish.mockClear();
  __resetToolCallRunningSeenForTest();
});

describe("handleSdkMessage tool_call running 去重", () => {
  it("同 callId 两条 status=running → 只落一条 tool_call 事件", async () => {
    const msg = {
      type: "tool_call" as const,
      name: "edit",
      call_id: "call_dup_running",
      status: "running" as const,
      args: { path: "src/a.ts", old_string: "a", new_string: "b" },
    };

    await handleSdkMessage("task-1", msg as never, assistantCtx, leaseOk);
    await handleSdkMessage("task-1", msg as never, assistantCtx, leaseOk);

    expect(toolCallEvents()).toHaveLength(1);
    expect(toolCallEvents()[0]?.meta?.callId).toBe("call_dup_running");
  });

  it("同 callId running → completed → 正常落 tool_result（去重不影响 completed）", async () => {
    const callId = "call_run_then_done";
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "shell",
        call_id: callId,
        status: "running",
        args: { command: "echo hi" },
      } as never,
      assistantCtx,
      leaseOk,
    );
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "shell",
        call_id: callId,
        status: "completed",
        args: { command: "echo hi" },
        result: { output: "hi" },
      } as never,
      assistantCtx,
      leaseOk,
    );

    expect(toolCallEvents()).toHaveLength(1);
    expect(toolResultEvents()).toHaveLength(1);
    expect(toolResultEvents()[0]?.meta?.callId).toBe(callId);
  });
});

describe("handleSdkMessage task 工具 args 短字段前置 + 截断", () => {
  it("name=task、prompt 超长、model 在尾部 → parseTaskToolArgs 能解析出 model", async () => {
    const prompt = "P".repeat(1200);
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "task",
        call_id: "call_task_model",
        status: "running",
        // 模拟 SDK 原始键序：prompt 很长、model 在尾部
        args: {
          description: "跑子代理",
          prompt,
          subagentType: "generalPurpose",
          model: "grok-4.5",
        },
      } as never,
      assistantCtx,
      leaseOk,
    );

    const args = toolCallEvents()[0]?.meta?.args;
    expect(typeof args).toBe("string");
    const parsed = parseTaskToolArgs(args as string);
    expect(parsed?.model).toBe("grok-4.5");
    // 短字段前置后截断上限 2000，prompt 应保留更多（远超旧默认 500）
    expect(parsed?.prompt?.length ?? 0).toBeGreaterThan(500);
  });

  it("非 task 工具 args 截断仍是 500 上限", async () => {
    const longVal = "x".repeat(600);
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "shell",
        call_id: "call_shell_trunc",
        status: "running",
        args: { command: longVal },
      } as never,
      assistantCtx,
      leaseOk,
    );

    const args = toolCallEvents()[0]?.meta?.args;
    expect(typeof args).toBe("string");
    const argsStr = args as string;
    expect(argsStr).toMatch(/…\(truncated \d+ chars\)$/);
    // truncate 默认 max=500：正文前 500 字符 + 后缀
    const body = argsStr.replace(/…\(truncated \d+ chars\)$/, "");
    expect(body.length).toBe(500);
  });

  it("updateTodos 长 todos 数组 → 事件 args 能解析出全部条目", async () => {
    // 构造远超旧默认 500 的 todos 数组，验证放大到 4000 后仍完整可解析
    const todos = Array.from({ length: 40 }, (_, i) => ({
      content: `Task ${i + 1}: implement feature module section detail ${i}`,
      status: i % 4 === 0 ? "completed" : i % 4 === 1 ? "in_progress" : "pending",
    }));
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "updateTodos",
        call_id: "call_todos_long",
        status: "running",
        args: { todos, merge: true },
      } as never,
      assistantCtx,
      leaseOk,
    );

    const args = toolCallEvents()[0]?.meta?.args;
    expect(typeof args).toBe("string");
    const argsStr = args as string;
    // 完整 stringify 可能仍超 4000；至少不能被默认 500 截到只剩几条
    const parsed = parseTodoToolArgs(argsStr);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(40);
    expect(parsed![0]?.content).toContain("Task 1:");
    expect(parsed![39]?.content).toContain("Task 40:");
  });
});

describe("handleSdkMessage 自定义 pi 压缩", () => {
  beforeEach(() => {
    writeOwnedEventAndPublish.mockClear();
    appendEvent.mockClear();
  });

  const infoEvents = (): WrittenEvent[] =>
    writeOwnedEventAndPublish.mock.calls
      .map((c) => c[2])
      .filter((e): e is WrittenEvent => e != null && e.kind === "info");

  it("compaction_start/end 落过程行，不 flush assistant_message", async () => {
    const flush = vi.fn(async () => {});
    const ctx: AssistantBufferCtx = { buffer: "结论：可合", flush };

    await handleSdkMessage(
      "task-1",
      { type: "compaction_start", reason: "overflow" } as never,
      ctx,
      leaseOk,
    );
    await handleSdkMessage(
      "task-1",
      { type: "compaction_end", reason: "overflow", aborted: false } as never,
      ctx,
      leaseOk,
    );

    expect(flush).not.toHaveBeenCalled();
    expect(ctx.buffer).toBe("结论：可合");
    expect(infoEvents()).toEqual([
      {
        kind: "info",
        text: "正在压缩上下文…",
        meta: { kind: "compaction", status: "running", reason: "overflow" },
      },
      {
        kind: "info",
        text: "已压缩上下文",
        meta: { kind: "compaction", status: "done", reason: "overflow" },
      },
    ]);
  });

  it("compaction_end aborted → 压缩已取消", async () => {
    const flush = vi.fn(async () => {});
    await handleSdkMessage(
      "task-1",
      { type: "compaction_end", aborted: true } as never,
      { buffer: "", flush },
      leaseOk,
    );
    expect(flush).not.toHaveBeenCalled();
    expect(infoEvents()[0]).toMatchObject({
      text: "压缩已取消",
      meta: { kind: "compaction", status: "aborted" },
    });
  });

  it("compaction_end willRetry 不落完成行", async () => {
    const flush = vi.fn(async () => {});
    await handleSdkMessage(
      "task-1",
      { type: "compaction_start", reason: "overflow" } as never,
      { buffer: "", flush },
      leaseOk,
    );
    await handleSdkMessage(
      "task-1",
      {
        type: "compaction_end",
        reason: "overflow",
        aborted: false,
        willRetry: true,
      } as never,
      { buffer: "", flush },
      leaseOk,
    );
    expect(infoEvents()).toEqual([
      {
        kind: "info",
        text: "正在压缩上下文…",
        meta: { kind: "compaction", status: "running", reason: "overflow" },
      },
    ]);
  });
});

/**
 * 回合结束后的重放保护（chat 开 dropAfterTurnEnded）。
 *
 * 对应线上现象：回复完整出现后，对话迟迟不结束，过一会儿 AI 又把同一句话回复一遍。
 * 机理（main.log + 探针实测）：SDK 的 turn-ended（= 一条 usage）先于 checkpoint 持久化到达；
 * 迟迟收不到 FINISHED 时 SDK 无进展检测取消 attempt、从 checkpoint 重放，同一条流上再来一轮
 * thinking / assistant / usage。这里钉死：首条 usage 就落盘回复，其后的重放不再上屏。
 */
describe("handleSdkMessage 回合结束后的重放保护（usage = turn-ended）", () => {
  beforeEach(() => {
    writeOwnedEventAndPublish.mockClear();
    appendEvent.mockClear();
    __resetToolCallRunningSeenForTest();
  });

  const usageMsg = () =>
    ({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } }) as never;
  const assistantMsg = (text: string) =>
    ({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }) as never;
  const thinkingMsg = (text: string) =>
    ({ type: "thinking", text, thinking_duration_ms: 120 }) as never;
  const shellRunning = (callId: string) =>
    ({
      type: "tool_call",
      name: "shell",
      call_id: callId,
      status: "running",
      args: { command: "echo hi" },
    }) as never;

  /** 模拟 consumeChatRun 的 ctx：flush 把 buffer 写成一条 assistant_message 并清空 */
  const mkCtx = (over: Partial<AssistantBufferCtx> = {}): AssistantBufferCtx => {
    const ctx: AssistantBufferCtx = {
      buffer: "",
      flush: vi.fn(async () => {
        const text = ctx.buffer.trim();
        ctx.buffer = "";
        if (text) {
          await writeOwnedEventAndPublish("task-1", leaseOk, {
            kind: "assistant_message",
            text,
          });
        }
      }),
      dropAfterTurnEnded: true,
      ...over,
    };
    return ctx;
  };

  const eventsOf = (kind: string): WrittenEvent[] =>
    writeOwnedEventAndPublish.mock.calls
      .map((c) => c[2])
      .filter((e): e is WrittenEvent => e != null && e.kind === kind);

  it("首条 usage 到达即落盘回复（不等 run 结束）并通知 onTurnEnded；usage 本身不产生事件", async () => {
    const onTurnEnded = vi.fn();
    const ctx = mkCtx({ onTurnEnded });
    await handleSdkMessage("task-1", thinkingMsg("想一想"), ctx, leaseOk);
    await handleSdkMessage("task-1", assistantMsg("你好，"), ctx, leaseOk);
    await handleSdkMessage("task-1", assistantMsg("世界"), ctx, leaseOk);
    // 还没 turn-ended：正文只在 buffer 里，没落盘
    expect(eventsOf("assistant_message")).toHaveLength(0);

    const before = Date.now();
    await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);

    expect(eventsOf("assistant_message").map((e) => e.text)).toEqual(["你好，世界"]);
    expect(eventsOf("thinking").map((e) => e.text)).toEqual(["想一想"]);
    expect(ctx.buffer).toBe("");
    expect(onTurnEnded).toHaveBeenCalledTimes(1);
    expect(ctx.turnEndedCount).toBe(1);
    expect(ctx.turnEndedAt).toBeGreaterThanOrEqual(before);
    // usage 只是计量信号：除了冲出已有内容，不额外写任何事件
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(2);
  });

  it("本回合只有 thinking、没有正文：usage 也会把 thinking 冲出去", async () => {
    const ctx = mkCtx();
    await handleSdkMessage("task-1", thinkingMsg("只想不说"), ctx, leaseOk);
    expect(eventsOf("thinking")).toHaveLength(0);
    await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);
    expect(eventsOf("thinking").map((e) => e.text)).toEqual(["只想不说"]);
    expect(eventsOf("assistant_message")).toHaveLength(0);
  });

  it("turn-ended 之后重放的 thinking / assistant 被丢弃：不累 buffer、不落盘，只计数；onTurnEnded 只触发一次", async () => {
    const onTurnEnded = vi.fn();
    const ctx = mkCtx({ onTurnEnded });
    await handleSdkMessage("task-1", assistantMsg("第一遍回复"), ctx, leaseOk);
    await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);
    expect(eventsOf("assistant_message")).toHaveLength(1);
    writeOwnedEventAndPublish.mockClear();

    // SDK stall 重放：thinking + 一整段重复正文 + 第二条 usage
    await handleSdkMessage("task-1", thinkingMsg("重新想"), ctx, leaseOk);
    await handleSdkMessage("task-1", assistantMsg("第一遍回复"), ctx, leaseOk);
    await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);
    // consumeChatRun 在流结束时还会再冲一次 thinking / flush——这里也不应该吐出重复内容
    await ctx.flush();

    expect(ctx.buffer).toBe("");
    expect(ctx.thinkingBuffer ?? "").toBe("");
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
    expect(ctx.replayDropped).toEqual({
      thinking: 1,
      assistant: 1,
      assistantChars: "第一遍回复".length,
      toolCalls: 0,
    });
    expect(ctx.turnEndedCount).toBe(2);
    expect(onTurnEnded).toHaveBeenCalledTimes(1);
  });

  it("重放里的工具调用不丢（用户得看到真有动作在发生），只计数", async () => {
    const ctx = mkCtx();
    await handleSdkMessage("task-1", assistantMsg("回复"), ctx, leaseOk);
    await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);
    writeOwnedEventAndPublish.mockClear();

    await handleSdkMessage("task-1", shellRunning("call-replay"), ctx, leaseOk);
    expect(toolCallEvents()).toHaveLength(1);
    expect(ctx.replayDropped?.toolCalls).toBe(1);
    // 工具之后的正文是重放里的新增内容吗？无法判断 → 仍按规则丢（回合已经结束）
    await handleSdkMessage("task-1", assistantMsg("重放正文"), ctx, leaseOk);
    expect(ctx.buffer).toBe("");
    expect(ctx.replayDropped?.assistant).toBe(1);
  });

  it("回合结束前的 tool_call / thinking / assistant 完全不受影响（usage 之前没有任何丢弃）", async () => {
    const ctx = mkCtx();
    await handleSdkMessage("task-1", thinkingMsg("先想"), ctx, leaseOk);
    await handleSdkMessage("task-1", shellRunning("call-1"), ctx, leaseOk);
    await handleSdkMessage("task-1", assistantMsg("中间说明"), ctx, leaseOk);
    await handleSdkMessage("task-1", shellRunning("call-2"), ctx, leaseOk);
    await handleSdkMessage("task-1", assistantMsg("最终回复"), ctx, leaseOk);
    await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);

    expect(eventsOf("thinking")).toHaveLength(1);
    expect(toolCallEvents()).toHaveLength(2);
    expect(eventsOf("assistant_message").map((e) => e.text)).toEqual([
      "中间说明",
      "最终回复",
    ]);
    expect(ctx.replayDropped).toBeUndefined();
  });

  it("没开 dropAfterTurnEnded（task 模式）：usage 只计数，不提前落盘，其后正文照常累积", async () => {
    const flush = vi.fn(async () => {});
    const onTurnEnded = vi.fn();
    const ctx: AssistantBufferCtx = { buffer: "", flush, onTurnEnded };
    await handleSdkMessage("task-1", assistantMsg("交卷前"), ctx, leaseOk);
    await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);
    expect(flush).not.toHaveBeenCalled();
    expect(onTurnEnded).not.toHaveBeenCalled();

    await handleSdkMessage("task-1", assistantMsg("交卷后续跑"), ctx, leaseOk);
    await handleSdkMessage("task-1", thinkingMsg("续跑思考"), ctx, leaseOk);
    expect(ctx.buffer).toBe("交卷前交卷后续跑");
    expect(ctx.thinkingBuffer).toBe("续跑思考");
    expect(ctx.turnEndedCount).toBe(1);
    expect(ctx.replayDropped).toBeUndefined();
  });

  it("lease 已失效（run 已被替换）：usage 不落盘、不计数、不通知", async () => {
    const onTurnEnded = vi.fn();
    const ctx = mkCtx({ onTurnEnded });
    ctx.buffer = "旧 run 的残留";
    await handleSdkMessage("task-1", usageMsg(), ctx, () => false);
    expect(ctx.turnEndedCount).toBeUndefined();
    expect(onTurnEnded).not.toHaveBeenCalled();
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
  });
});
