/**
 * pi 路径（自定义 provider）的子代理过程记录：`task` 工具 → `runPiSubagent` → 记录器。
 *
 * 契约：
 *  - 子会话的事件翻成和 Cursor 路径同形的 SDKMessage 再喂记录器（`piSubagentEventMessages`）
 *  - 父会话 `task` 调用的 callId（pi 的 toolCallId）精确绑到记录上——事件流卡片按它找
 *  - 收尾按 done / failed / cancelled 记；没 taskId（一次性调用）不记
 *  - 记录出问题不影响子代理
 *
 * 子会话是 mock 的（createAgentSession），事件由测试脚本化喂入。DATA_DIR 须在动态 import 前钉死。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-pi-subagent-transcript-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const hoisted = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: hoisted.createAgentSession };
});

const { runPiSubagent, piSubagentEventMessages } = await import(
  "../src/lib/server/custom-agent-backend"
);
const transcript = await import("../src/lib/server/subagent-transcript");
const { taskDir } = await import("../src/lib/server/task-fs-core");
type SubagentParent = import("../src/lib/server/custom-agent-backend").SubagentParent;

const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-transcript-cwd-"));
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const parent = {
  input: {
    kind: "custom",
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1",
    format: "openai",
    model: { id: "m-parent" },
    local: { cwd },
  },
  runtime: {},
  model: {},
  thinkingLevel: undefined,
} as unknown as SubagentParent;

type Ev = Record<string, unknown>;

const think = (delta: string): Ev => ({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", delta },
});
const text = (delta: string): Ev => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});
const toolStart = (id: string, name: string, args: unknown): Ev => ({
  type: "message_update",
  assistantMessageEvent: { type: "toolcall_end", toolCall: { id, name, arguments: args } },
});
const toolEnd = (id: string, name: string, result: unknown, isError = false): Ev => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: name,
  result,
  isError,
});
const agentEnd: Ev = { type: "agent_end", willRetry: false };

/** prompt() 被调用时按脚本把事件喂给订阅者；script 可以是函数（异步控制时序） */
const sessionWith = (events: Ev[], opts: { promptError?: string } = {}) => {
  let onEvent: ((ev: unknown) => void) | undefined;
  return {
    // 真 pi 的 abort 会让这一轮收尾（发 agent_end）；mock 同样
    abort: vi.fn(async () => {
      onEvent?.(agentEnd);
    }),
    prompt: vi.fn(async () => {
      if (opts.promptError) throw new Error(opts.promptError);
      for (const ev of events) onEvent?.(ev);
    }),
    subscribe: vi.fn((cb: (ev: unknown) => void) => {
      onEvent = cb;
      return () => {};
    }),
    dispose: vi.fn(),
    state: { messages: [], errorMessage: null },
  };
};

let seq = 0;
const freshTask = async (): Promise<string> => {
  seq += 1;
  const id = `t_pi_sub_${seq}`;
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

const req = {
  prompt: "读一下登录实现并总结",
  description: "读登录",
  subagentType: "explore" as const,
};

beforeEach(() => {
  hoisted.createAgentSession.mockReset();
  transcript.__resetSubagentRunsForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("piSubagentEventMessages：pi 事件 → Cursor 同形 SDKMessage", () => {
  it("text_delta / thinking_delta / toolcall_end / tool_execution_end 四类，其它事件空", () => {
    const cache = new Map<string, { name: string; args: unknown }>();
    expect(piSubagentEventMessages(text("你好") as never, cache)).toEqual([
      { type: "assistant", message: { content: [{ type: "text", text: "你好" }] } },
    ]);
    expect(piSubagentEventMessages(think("嗯") as never, cache)).toEqual([
      { type: "thinking", text: "嗯" },
    ]);
    const start = piSubagentEventMessages(
      toolStart("t1", "read", { path: "a.ts" }) as never,
      cache,
    );
    expect(start).toEqual([
      { type: "tool_call", call_id: "t1", name: "read", args: { path: "a.ts" }, status: "running" },
    ]);
    // 执行结束事件里没有入参：靠缓存补回
    const end = piSubagentEventMessages(toolEnd("t1", "read", "内容") as never, cache);
    expect(end).toEqual([
      {
        type: "tool_call",
        call_id: "t1",
        name: "read",
        args: { path: "a.ts" },
        status: "completed",
        result: "内容",
      },
    ]);
    const err = piSubagentEventMessages(toolEnd("t1", "read", "炸了", true) as never, cache);
    expect((err[0] as { status: string }).status).toBe("error");
    expect(piSubagentEventMessages(agentEnd as never, cache)).toEqual([]);
    expect(piSubagentEventMessages({ type: "message_end" } as never, cache)).toEqual([]);
    // 空增量不产生消息
    expect(piSubagentEventMessages(text("") as never, cache)).toEqual([]);
  });

  it("没缓存过入参的执行结束（缺 toolcall_end）也不抛：args 回退空对象", () => {
    const out = piSubagentEventMessages(toolEnd("zz", "bash", "x") as never, new Map());
    expect((out[0] as { args: unknown }).args).toEqual({});
  });
});

describe("runPiSubagent → 记录器", () => {
  it("过程事件 / 完整任务书 / 模型 / 收尾都进记录，且父会话 task 调用的 callId 精确绑上", async () => {
    const taskId = await freshTask();
    const session = sessionWith([
      think("先想想"),
      toolStart("tc1", "read", { path: "login.ts" }),
      toolEnd("tc1", "read", { content: [{ type: "text", text: "文件内容" }] }),
      text("总结：入口是 login()"),
      agentEnd,
    ]);
    hoisted.createAgentSession.mockResolvedValue({ session });

    const out = await runPiSubagent(req, new AbortController().signal, {
      parent,
      cwd,
      taskId,
      toolCallId: "pi-card-1",
    });
    expect(out).toBe("总结：入口是 login()");

    const snap = await transcript.getSubagentRunSnapshot(taskId, { callId: "pi-card-1" });
    expect(snap).not.toBeNull();
    expect(snap!.meta).toMatchObject({
      provider: "pi",
      description: "读登录",
      prompt: req.prompt,
      model: "m-parent",
      explore: true,
      status: "done",
      result: "总结：入口是 login()",
    });
    expect(snap!.events.map((e) => e.kind)).toEqual([
      "thinking",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
    expect(snap!.events[2]!.meta).toMatchObject({ callId: "tc1", status: "success" });
  });

  it("子会话 prompt 失败 → failed + 原因", async () => {
    const taskId = await freshTask();
    hoisted.createAgentSession.mockResolvedValue({
      session: sessionWith([], { promptError: "端点 401" }),
    });
    await expect(
      runPiSubagent(req, new AbortController().signal, { parent, cwd, taskId, toolCallId: "c-f" }),
    ).rejects.toThrow("端点 401");
    const snap = await transcript.getSubagentRunSnapshot(taskId, { callId: "c-f" });
    expect(snap?.meta.status).toBe("failed");
    expect(snap?.meta.error).toContain("端点 401");
  });

  it("运行中被取消 → cancelled", async () => {
    const taskId = await freshTask();
    const ac = new AbortController();
    const session = sessionWith([text("做到一半")]);
    // prompt 返回前先取消：模拟父会话被停
    session.prompt.mockImplementation(async () => {
      ac.abort();
    });
    hoisted.createAgentSession.mockResolvedValue({ session });
    await expect(
      runPiSubagent(req, ac.signal, { parent, cwd, taskId, toolCallId: "c-x" }),
    ).rejects.toThrow("子任务已取消");
    const snap = await transcript.getSubagentRunSnapshot(taskId, { callId: "c-x" });
    expect(snap?.meta.status).toBe("cancelled");
  });

  it("没有 taskId（一次性调用）→ 不记", async () => {
    hoisted.createAgentSession.mockResolvedValue({
      session: sessionWith([text("ok"), agentEnd]),
    });
    await runPiSubagent(req, new AbortController().signal, { parent, cwd });
    expect(transcript.__runKeysForTests("")).toEqual([]);
  });

  it("创建子会话期间就被取消（根本没进 prompt）→ 不留记录", async () => {
    const taskId = await freshTask();
    const ac = new AbortController();
    hoisted.createAgentSession.mockImplementation(async () => {
      ac.abort();
      return { session: sessionWith([]) };
    });
    await expect(
      runPiSubagent(req, ac.signal, { parent, cwd, taskId, toolCallId: "c-early" }),
    ).rejects.toThrow("子任务已取消");
    expect(transcript.__runKeysForTests(taskId)).toEqual([]);
  });
});
