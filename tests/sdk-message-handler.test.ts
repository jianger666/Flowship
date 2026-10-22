/**
 * handleSdkMessage：tool_call running 去重 + task 工具 args 短字段前置 / 截断放大
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mergeToolDisplayEvents,
  parseTaskToolArgs,
  parseTodoToolArgs,
  toolBlockArgsTruncatedHint,
  toolBlockSummary,
  type ToolBlock,
} from "@/lib/tool-display";

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

  it("name=task、prompt 超长、effort 在尾部 → effort 不会被截掉（徽标 = 实际思考档）", async () => {
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "task",
        call_id: "call_task_effort",
        status: "running",
        args: {
          description: "跑子代理",
          prompt: "P".repeat(3000),
          subagentType: "general",
          model: "gpt-5",
          effort: "high",
        },
      } as never,
      assistantCtx,
      leaseOk,
    );

    const args = toolCallEvents()[0]?.meta?.args;
    const parsed = parseTaskToolArgs(args as string);
    expect(parsed?.model).toBe("gpt-5");
    expect(parsed?.effort).toBe("high");
  });

  it("其它工具（grep 等）args 截断仍是 500 上限", async () => {
    const longVal = "x".repeat(600);
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "grep",
        call_id: "call_grep_trunc",
        status: "running",
        args: { pattern: longVal },
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

  // V4-01：shell / write / edit 的 args 上限放宽到 4000（命令本体 / heredoc 脚本常超 500）
  it("shell 命令 600 字符不再被截断（旧上限 500）：args 是完整可 parse 的 JSON", async () => {
    const longVal = "x".repeat(600);
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "shell",
        call_id: "call_shell_600",
        status: "running",
        args: { command: longVal, working_directory: "/repo" },
      } as never,
      assistantCtx,
      leaseOk,
    );
    const argsStr = toolCallEvents()[0]?.meta?.args as string;
    expect(argsStr).not.toMatch(/truncated/);
    expect(JSON.parse(argsStr)).toEqual({
      command: longVal,
      working_directory: "/repo",
    });
  });

  it("shell 命令超 4000 → 截到 4000 + 后缀；真实事件形状下摘要仍是 `$ 命令`", async () => {
    const script = `cd /repo && python3 - <<'PY'\n${"print('x')\n".repeat(600)}PY`;
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "shell",
        call_id: "call_shell_5000",
        status: "running",
        args: { command: script },
      } as never,
      assistantCtx,
      leaseOk,
    );
    const ev = toolCallEvents()[0];
    const argsStr = ev?.meta?.args as string;
    expect(argsStr).toMatch(/…\(truncated \d+ chars\)$/);
    expect(argsStr.replace(/…\(truncated \d+ chars\)$/, "").length).toBe(4000);
    // 端到端：落盘事件（text 截 120 + meta.args 截 4000）→ 配对 → 摘要
    const [item] = mergeToolDisplayEvents([
      { id: "e1", ts: 1, kind: "tool_call", text: ev?.text ?? "", meta: ev?.meta } as never,
    ]);
    const summary = toolBlockSummary(item as ToolBlock);
    expect(summary.startsWith("$ cd /repo && python3 - <<'PY'")).toBe(true);
    expect(toolBlockArgsTruncatedHint(item as ToolBlock)).toBe("命令过长已截断");
  });

  it("shell：关键字段 command 前置（SDK 键序里它排在长字段后面也能留在截断窗口内）", async () => {
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "shell",
        call_id: "call_shell_order",
        status: "running",
        args: { description: "d".repeat(5000), command: "pnpm test" },
      } as never,
      assistantCtx,
      leaseOk,
    );
    const argsStr = toolCallEvents()[0]?.meta?.args as string;
    expect(argsStr.startsWith('{"command":"pnpm test"')).toBe(true);
  });

  it("write：path 前置到 content 之前（真实数据里 351 次 write 是 content 在前）→ 长 content 被截也能拿到路径", async () => {
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "write",
        call_id: "call_write_order",
        status: "running",
        // SDK 原始键序：content 在前、path 在后
        args: { content: "c".repeat(6000), path: "/repo/src/big.ts" },
      } as never,
      assistantCtx,
      leaseOk,
    );
    const ev = toolCallEvents()[0];
    const argsStr = ev?.meta?.args as string;
    expect(argsStr.startsWith('{"path":"/repo/src/big.ts"')).toBe(true);
    expect(argsStr).toMatch(/…\(truncated \d+ chars\)$/);
    expect(argsStr.replace(/…\(truncated \d+ chars\)$/, "").length).toBe(4000);
    const [item] = mergeToolDisplayEvents([
      { id: "e1", ts: 1, kind: "tool_call", text: ev?.text ?? "", meta: ev?.meta } as never,
    ]);
    expect(toolBlockSummary(item as ToolBlock)).toBe("/repo/src/big.ts");
  });

  it("edit：path 前置到 edits 数组之前；其余键相对顺序不变", async () => {
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "edit",
        call_id: "call_edit_order",
        status: "running",
        args: {
          edits: [{ oldText: "a", newText: "b" }],
          path: "/repo/src/a.ts",
          note: "n",
        },
      } as never,
      assistantCtx,
      leaseOk,
    );
    const argsStr = toolCallEvents()[0]?.meta?.args as string;
    expect(Object.keys(JSON.parse(argsStr))).toEqual(["path", "edits", "note"]);
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

describe("handleSdkMessage：Cursor 的 subagent 自定义工具（MCP 外壳）改写成 task", () => {
  // 形状来自 2026-10-13 真实 Cursor SDK 运行（composer-2.5 父 → claude-sonnet-5-5 子）
  const subagentArgs = {
    providerIdentifier: "custom-user-tools",
    toolName: "subagent",
    args: {
      prompt: "In one short sentence, say which AI model you are.",
      model: "claude-sonnet-5-5",
      effort: "low",
      description: "Report exact model name",
    },
  };

  it("running：事件名是 task、args 是扁平真入参 → 卡片能解析出 model / effort", async () => {
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "mcp",
        call_id: "call_sub_1",
        status: "running",
        args: subagentArgs,
      } as never,
      assistantCtx,
      leaseOk,
    );
    const ev = toolCallEvents()[0];
    expect(ev?.meta?.name).toBe("task");
    // 不再带 MCP 外壳字段（innerToolName 是给 MCP 工具识别用的）
    expect(ev?.meta?.innerToolName).toBeUndefined();
    const parsed = parseTaskToolArgs(ev?.meta?.args as string);
    expect(parsed?.model).toBe("claude-sonnet-5-5");
    expect(parsed?.effort).toBe("low");
    expect(parsed?.description).toBe("Report exact model name");
    expect(ev?.meta?.args).not.toContain("custom-user-tools");
  });

  it("running：ctx 带父会话模型时，inherit 的 model / effort 徽标换成实际生效值（args 只在 running 落盘一次，事后补不了）", async () => {
    const withParent: AssistantBufferCtx = {
      ...assistantCtx,
      subagentParentModel: {
        id: "claude-sonnet-5-5",
        params: [{ id: "reasoning_effort", value: "high" }],
      },
    };
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "mcp",
        call_id: "call_sub_inherit",
        status: "running",
        args: { ...subagentArgs, args: { prompt: "p", description: "d", model: "inherit" } },
      } as never,
      withParent,
      leaseOk,
    );
    const parsed = parseTaskToolArgs(toolCallEvents()[0]?.meta?.args as string);
    expect(parsed?.model).toBe("claude-sonnet-5-5");
    expect(parsed?.effort).toBe("high");
  });

  it("running：ctx 没有父会话模型（pi / 没挂 subagent）时徽标保持原始入参，不乱补", async () => {
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "mcp",
        call_id: "call_sub_inherit2",
        status: "running",
        args: { ...subagentArgs, args: { prompt: "p", description: "d", model: "inherit" } },
      } as never,
      assistantCtx,
      leaseOk,
    );
    const parsed = parseTaskToolArgs(toolCallEvents()[0]?.meta?.args as string);
    expect(parsed?.model).toBe("inherit");
    expect(parsed?.effort ?? null).toBeNull();
  });

  it("running：显式指定了别的模型但没写 effort → 徽标补该模型的默认档（查表函数来自 ctx）", async () => {
    const withLookup: AssistantBufferCtx = {
      ...assistantCtx,
      subagentParentModel: {
        id: "gemini-4-argon",
        params: [{ id: "reasoning_effort", value: "high" }],
      },
      subagentDisplayLookup: {
        defaultEffortOf: (id) => (id === "claude-sonnet-5-5" ? "high" : undefined),
      },
    };
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "mcp",
        call_id: "call_sub_default_effort",
        status: "running",
        args: {
          ...subagentArgs,
          args: {
            prompt: "p",
            description: "查看素材",
            model: "claude-sonnet-5-5",
            subagentType: "explore",
          },
        },
      } as never,
      withLookup,
      leaseOk,
    );
    const parsed = parseTaskToolArgs(toolCallEvents()[0]?.meta?.args as string);
    expect(parsed?.model).toBe("claude-sonnet-5-5");
    expect(parsed?.effort).toBe("high");
  });

  it("running：resume 接着之前的子代理 → 徽标显示它当初的模型 / effort（args 只在 running 落盘一次）", async () => {
    const withLookup: AssistantBufferCtx = {
      ...assistantCtx,
      subagentParentModel: { id: "gemini-4-argon" },
      subagentDisplayLookup: {
        resumedChildOf: (id) =>
          id === "agent-606696db" ? { model: "claude-sonnet-5-5", effort: "high" } : undefined,
      },
    };
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "mcp",
        call_id: "call_sub_resume",
        status: "running",
        args: {
          ...subagentArgs,
          args: { prompt: "继续读剩下的", description: "查看其余素材", resume: "agent-606696db" },
        },
      } as never,
      withLookup,
      leaseOk,
    );
    const parsed = parseTaskToolArgs(toolCallEvents()[0]?.meta?.args as string);
    expect(parsed?.model).toBe("claude-sonnet-5-5");
    expect(parsed?.effort).toBe("high");
    expect(parsed?.description).toBe("查看其余素材");
  });

  it("running：ctx 没有查表函数时，指定别的模型 / resume 的卡片保持原样，不乱补", async () => {
    for (const [id, inner] of [
      ["call_sub_nolookup_a", { prompt: "p", description: "d", model: "claude-sonnet-5-5" }],
      ["call_sub_nolookup_b", { prompt: "p", description: "d", resume: "agent-x" }],
    ] as const) {
      await handleSdkMessage(
        "task-1",
        {
          type: "tool_call",
          name: "mcp",
          call_id: id,
          status: "running",
          args: { ...subagentArgs, args: inner },
        } as never,
        { ...assistantCtx, subagentParentModel: { id: "gemini-4-argon" } },
        leaseOk,
      );
    }
    const evs = toolCallEvents();
    const a = parseTaskToolArgs(evs[0]?.meta?.args as string);
    const b = parseTaskToolArgs(evs[1]?.meta?.args as string);
    expect(a?.model).toBe("claude-sonnet-5-5");
    expect(a?.effort ?? null).toBeNull();
    expect(b?.model ?? null).toBeNull();
    expect(b?.effort ?? null).toBeNull();
  });

  it("running：prompt 很长也不会把尾部的 model / effort 截掉（走 task 的短字段前置）", async () => {
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "mcp",
        call_id: "call_sub_long",
        status: "running",
        args: {
          ...subagentArgs,
          args: { prompt: "P".repeat(3000), description: "d", subagentType: "general", model: "claude-sonnet-5-5", effort: "high" },
        },
      } as never,
      assistantCtx,
      leaseOk,
    );
    const parsed = parseTaskToolArgs(toolCallEvents()[0]?.meta?.args as string);
    expect(parsed?.model).toBe("claude-sonnet-5-5");
    expect(parsed?.effort).toBe("high");
  });

  it("completed：结果拆掉 MCP 信封、以 task 名落 tool_result（卡片里是纯文本）", async () => {
    const { buildToolResultMeta } = await import("@/lib/server/tool-result-persist");
    const build = vi.mocked(buildToolResultMeta);
    build.mockClear();
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "mcp",
        call_id: "call_sub_done",
        status: "completed",
        args: subagentArgs,
        result: {
          status: "success",
          value: { content: [{ text: { text: "我是 Claude Sonnet 5.5。" } }], isError: false },
        },
      } as never,
      assistantCtx,
      leaseOk,
    );
    expect(build).toHaveBeenCalledTimes(1);
    const input = build.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(input.rawName).toBe("task");
    expect(input.result).toBe("我是 Claude Sonnet 5.5。");
    expect(input.msgStatus).toBe("completed");
    expect((input.args as Record<string, unknown>).model).toBe("claude-sonnet-5-5");
    expect(toolResultEvents()).toHaveLength(1);
  });

  it("completed 且工具回了 isError：落成 error（卡片标红，用法错误 / 子任务失败不会显示成功）", async () => {
    const { buildToolResultMeta } = await import("@/lib/server/tool-result-persist");
    const build = vi.mocked(buildToolResultMeta);
    build.mockClear();
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "mcp",
        call_id: "call_sub_err",
        status: "completed",
        args: subagentArgs,
        result: {
          status: "success",
          value: { content: [{ text: { text: "子代理模型无效：当前 provider 没有「x」" } }], isError: true },
        },
      } as never,
      assistantCtx,
      leaseOk,
    );
    const input = build.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(input.msgStatus).toBe("error");
    expect(input.result).toContain("子代理模型无效");
  });

  it("别的 MCP 工具（如 ask_user）一律不动：事件名仍是 mcp、外壳字段还在", async () => {
    await handleSdkMessage(
      "task-1",
      {
        type: "tool_call",
        name: "mcp",
        call_id: "call_other_mcp",
        status: "running",
        args: { providerIdentifier: "custom-user-tools", toolName: "share_to_group", args: { content: "hi" } },
      } as never,
      assistantCtx,
      leaseOk,
    );
    const ev = toolCallEvents()[0];
    expect(ev?.meta?.name).toBe("mcp");
    expect(ev?.meta?.innerToolName).toBe("share_to_group");
    expect(ev?.meta?.args).toContain("custom-user-tools");
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
 * usage（= SDK 的 turn-ended）只计数，不改变任何消息的处理。
 *
 * 背景：v1.9.29 曾在首条 usage 就落盘回复，并把其后同一条流上的 thinking / 回复当「重放」丢掉。
 * 2026-10-12 整套撤掉——被丢的文字既不上屏也不落盘，事后无法核对有没有误杀；而多出来的回合
 * 基本是 SDK 的连接重试（重新生成，不是原文重复）。现在只保留计数（turn-wrapup.jsonl 取证用）。
 * 这里钉死「usage 之后的一切照常处理、一个字不丢」，防止谁再把丢弃加回来。
 */
describe("handleSdkMessage usage（= turn-ended）只计数，其后的消息照常处理", () => {
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
  const mkCtx = (): AssistantBufferCtx => {
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
    };
    return ctx;
  };

  const eventsOf = (kind: string): WrittenEvent[] =>
    writeOwnedEventAndPublish.mock.calls
      .map((c) => c[2])
      .filter((e): e is WrittenEvent => e != null && e.kind === kind);

  it("usage 本身不产生事件、不提前落盘：只记条数与首条到达时刻", async () => {
    const ctx = mkCtx();
    await handleSdkMessage("task-1", assistantMsg("你好，"), ctx, leaseOk);
    await handleSdkMessage("task-1", assistantMsg("世界"), ctx, leaseOk);
    const before = Date.now();
    await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);

    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
    expect(ctx.flush).not.toHaveBeenCalled();
    // 回复还在缓冲里，等下一个事件 / run 结束才落盘（与 usage 出现之前一样）
    expect(ctx.buffer).toBe("你好，世界");
    expect(ctx.turnEndedCount).toBe(1);
    expect(ctx.turnEndedAt).toBeGreaterThanOrEqual(before);
  });

  it("usage 之后又来的 thinking / 正文 / 工具调用照常处理：全部落盘，一个字不丢", async () => {
    const ctx = mkCtx();
    await handleSdkMessage("task-1", assistantMsg("第一遍回复"), ctx, leaseOk);
    await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);

    // SDK 在同一条流上又跑了一轮：thinking + 正文 + 工具调用 + 正文 + 第二条 usage，最后流结束再冲一次
    await handleSdkMessage("task-1", thinkingMsg("重新想"), ctx, leaseOk);
    await handleSdkMessage("task-1", assistantMsg("第二遍回复"), ctx, leaseOk);
    await handleSdkMessage("task-1", shellRunning("call-replay"), ctx, leaseOk);
    await handleSdkMessage("task-1", assistantMsg("重放里的收尾"), ctx, leaseOk);
    await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);
    await ctx.flush();

    expect(eventsOf("assistant_message").map((e) => e.text)).toEqual([
      "第一遍回复",
      "第二遍回复",
      "重放里的收尾",
    ]);
    expect(eventsOf("thinking").map((e) => e.text)).toEqual(["重新想"]);
    expect(toolCallEvents()).toHaveLength(1);
    // 计数照常：turn-wrapup.jsonl 靠它记「SDK 又跑了一轮」
    expect(ctx.turnEndedCount).toBe(2);
  });

  it("多条 usage：turnEndedCount 累加，turnEndedAt 只记首条", async () => {
    const ctx = mkCtx();
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000);
      await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);
      now.mockReturnValue(2_000);
      await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);
      now.mockReturnValue(3_000);
      await handleSdkMessage("task-1", usageMsg(), ctx, leaseOk);
    } finally {
      now.mockRestore();
    }
    expect(ctx.turnEndedCount).toBe(3);
    expect(ctx.turnEndedAt).toBe(1_000);
  });

  it("lease 已失效（run 已被替换）：usage 不计数、不写事件", async () => {
    const ctx = mkCtx();
    ctx.buffer = "旧 run 的残留";
    await handleSdkMessage("task-1", usageMsg(), ctx, () => false);
    expect(ctx.turnEndedCount).toBeUndefined();
    expect(ctx.turnEndedAt).toBeUndefined();
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
  });
});
