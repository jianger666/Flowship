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

const writeOwnedEventAndPublish = vi.fn<WriteOwnedFn>(async () => {});

vi.mock("@/lib/server/task-fs", () => ({
  getTask: vi.fn(),
  patchActionIfOwner: vi.fn(),
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
  __resetToolCallRunningSeenForTest,
} = await import("@/lib/server/sdk-message-handler");

const assistantCtx = {
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