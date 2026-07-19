/**
 * 飞书桥接命令词：定位分支 / 回执文案 / 异常
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetCommandsRegisteredForTest,
  __setCommandsDepsForTest,
  buildHistoryRounds,
  ensureBridgeCommandsRegistered,
  resolveCommandTargetTask,
} from "@/lib/server/feishu-bridge/commands";
import { __clearBridgeCommandsForTest } from "@/lib/server/feishu-bridge/router";
import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { TaskEvent, TaskSummary } from "@/lib/types";

const baseMsg = (
  overrides: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: "om_cmd_1",
  create_time: String(Date.now()),
  chat_id: "oc_test",
  chat_type: "p2p",
  message_type: "text",
  sender_id: "ou_owner",
  content: "/help",
  ...overrides,
});

const mockTask = (overrides: Partial<TaskSummary> = {}): TaskSummary =>
  ({
    id: "task-1",
    title: "测试对话",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    updatedAt: Date.now(),
    createdAt: Date.now(),
    repoPaths: [],
    currentActionId: null,
    mrs: [],
    actionCount: 0,
    ...overrides,
  }) as TaskSummary;

describe("buildHistoryRounds", () => {
  it("按 user_reply→assistant_message 成轮并取最近 n", () => {
    const events: TaskEvent[] = [
      { id: "1", ts: 1, kind: "user_reply", text: "u1" },
      { id: "2", ts: 2, kind: "assistant_message", text: "a1" },
      { id: "3", ts: 3, kind: "user_reply", text: "u2" },
      { id: "4", ts: 4, kind: "assistant_message", text: "a2" },
      { id: "5", ts: 5, kind: "user_reply", text: "u3" },
      { id: "6", ts: 6, kind: "assistant_message", text: "a3" },
    ];
    expect(buildHistoryRounds(events, 2)).toEqual([
      { user: "u2", assistant: "a2" },
      { user: "u3", assistant: "a3" },
    ]);
  });
});

describe("resolveCommandTargetTask", () => {
  const findByRoot = vi.fn();
  const listActive = vi.fn();
  const getTask = vi.fn();

  beforeEach(() => {
    findByRoot.mockReset();
    listActive.mockReset();
    getTask.mockReset();
    __setCommandsDepsForTest({
      findTaskByMessageId: findByRoot,
      listActiveChatTasks: listActive,
      getTask,
    });
  });

  afterEach(() => {
    __setCommandsDepsForTest(null);
  });

  it("root_id 命中 card-map → 该 task", async () => {
    findByRoot.mockResolvedValue({
      messageId: "om_card",
      cardId: "c1",
      taskId: "task-anchored",
      createdAt: Date.now(),
    });
    getTask.mockResolvedValue({
      id: "task-anchored",
      title: "锚定对话",
      mode: "chat",
      repoStatus: "developing",
      runStatus: "running",
      updatedAt: Date.now(),
      createdAt: Date.now(),
      repoPaths: [],
      currentActionId: null,
      mrs: [],
      actions: [],
      events: [],
    });
    const r = await resolveCommandTargetTask(
      baseMsg({ root_id: "om_card" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.id).toBe("task-anchored");
  });

  it("无 root、活跃唯一 → 直接用", async () => {
    findByRoot.mockResolvedValue(null);
    listActive.mockResolvedValue([mockTask()]);
    const r = await resolveCommandTargetTask(baseMsg());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.id).toBe("task-1");
  });

  it("多个活跃 → 提示回复卡片", async () => {
    listActive.mockResolvedValue([
      mockTask({ id: "a", title: "A" }),
      mockTask({ id: "b", title: "B" }),
    ]);
    const r = await resolveCommandTargetTask(baseMsg());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("进行中的对话");
  });

  it("零活跃 → 没有进行中的对话", async () => {
    listActive.mockResolvedValue([]);
    const r = await resolveCommandTargetTask(baseMsg());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("没有进行中的对话");
  });
});

describe("ensureBridgeCommandsRegistered", () => {
  const sendText = vi.fn(async () => ({ chat_id: "c", message_id: "m" }));
  const listActive = vi.fn(async () => [mockTask()]);
  const getStatus = vi.fn(() => ({
    overall: "running" as const,
    enabled: true,
    keepAwake: true,
    hostname: "host-a",
    consumers: [
      {
        eventKey: "im.message.receive_v1" as const,
        status: "ready" as const,
        restartCount: 0,
      },
    ],
  }));
  const createChat = vi.fn(
    async (title: string) => ({ taskId: "task-new", title }),
  );
  const handleChat = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const getTask = vi.fn(async () => ({
    id: "task-1",
    title: "测试对话",
    mode: "chat" as const,
    repoStatus: "developing" as const,
    runStatus: "idle" as const,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    repoPaths: [] as string[],
    currentActionId: null,
    mrs: [],
    actions: [],
    events: [
      { id: "1", ts: 1, kind: "user_reply" as const, text: "你好" },
      { id: "2", ts: 2, kind: "assistant_message" as const, text: "你好呀" },
    ],
  }));
  const stopAgent = vi.fn(async () => ({
    hadAgent: true,
    task: {} as never,
  }));
  const compact = vi.fn(async () => ({} as never));
  const findByRoot = vi.fn(async () => null);

  /** 经 routeInboundMessage 走命令扩展点（handler 已 ensure 注册） */
  const runCmd = async (command: string, args = "") => {
    const { routeInboundMessage, __setRouterDepsForTest } = await import(
      "@/lib/server/feishu-bridge/router"
    );
    __setRouterDepsForTest({
      getBotAppInfo: async () => ({
        appId: "cli_x",
        ownerOpenId: "ou_owner",
      }),
      sendTextMessage: sendText,
      downloadMessageResource: async () => "/tmp/x",
      findTaskByMessageId: findByRoot,
      listTasks: async () => [mockTask()],
      createTask: async (input) =>
        ({
          id: "task-new",
          title: input.title,
          mode: "chat",
        }) as never,
      getPendingAsk: () => null,
      handleChatReplyInject: handleChat as never,
      injectPendingAskText: async () => ({ ok: true as const }),
      readSettingsFile: async () => ({
        status: "ok" as const,
        settings: {
          apiKey: "sk-test",
          defaultModel: { id: "gpt-5" },
          repos: [{ path: "/tmp/repo" }],
        },
      }),
      listSkillsWithSource: async () => [],
      prewarmTaskWorkspace: () => undefined,
    });
    await routeInboundMessage(
      baseMsg({ content: `/${command}${args ? ` ${args}` : ""}` }),
    );
    __setRouterDepsForTest(null);
  };

  beforeEach(() => {
    sendText.mockClear();
    listActive.mockClear();
    getStatus.mockClear();
    createChat.mockClear();
    handleChat.mockClear();
    getTask.mockClear();
    stopAgent.mockClear();
    compact.mockClear();
    findByRoot.mockClear();
    findByRoot.mockResolvedValue(null);
    listActive.mockResolvedValue([mockTask()]);
    __clearBridgeCommandsForTest();
    __resetCommandsRegisteredForTest();
    __setCommandsDepsForTest({
      getBotAppInfo: async () => ({
        appId: "cli_x",
        ownerOpenId: "ou_owner",
      }),
      sendTextMessage: sendText,
      listActiveChatTasks: listActive,
      getBridgeRuntimeStatus: getStatus,
      findTaskByMessageId: findByRoot,
      createChatTaskForBridge: createChat,
      loadBridgeBootContext: async () => ({
        apiKey: "sk-test",
        model: { id: "gpt-5" } as never,
        repoPaths: ["/tmp/repo"],
        disabledMcpServers: [],
      }),
      handleChatReplyInject: handleChat as never,
      getTask: getTask as never,
      stopTaskAgent: stopAgent as never,
      compactChatSession: compact as never,
    });
    ensureBridgeCommandsRegistered();
  });

  afterEach(() => {
    __setCommandsDepsForTest(null);
    __clearBridgeCommandsForTest();
    __resetCommandsRegisteredForTest();
  });

  it("/help 回静态清单", async () => {
    await runCmd("help");
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("/stop"),
    );
  });

  it("/list 有活跃时列标题+runStatus（中文）", async () => {
    await runCmd("list");
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      "1. 测试对话（空闲）",
    );
  });

  it("/list 空 → 没有进行中的对话", async () => {
    listActive.mockResolvedValueOnce([]);
    await runCmd("list");
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      "没有进行中的对话",
    );
  });

  it("/status 紧凑几行（overall 中文）", async () => {
    await runCmd("status");
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringMatching(/桥接：运行中[\s\S]*host-a[\s\S]*im\.message\.receive_v1：ready/),
    );
  });

  it("/new 无 args 只建 chat", async () => {
    await runCmd("new");
    expect(createChat).toHaveBeenCalled();
    expect(handleChat).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("直接发消息开聊"),
    );
  });

  it("/new 有 args 建 chat + 注入首条", async () => {
    await runCmd("new", "你好世界");
    expect(createChat).toHaveBeenCalled();
    expect(handleChat).toHaveBeenCalledWith(
      "task-new",
      expect.objectContaining({ text: "你好世界" }),
      expect.anything(),
    );
  });

  it("/stop 定位后调用 stopTaskAgent", async () => {
    await runCmd("stop");
    expect(stopAgent).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      "已停止：测试对话",
    );
  });

  it("/compact 调用 compactChatSession", async () => {
    await runCmd("compact");
    expect(compact).toHaveBeenCalledWith("task-1");
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      "已压缩：测试对话",
    );
  });

  it("/history 发轮次摘要", async () => {
    await runCmd("history");
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringMatching(/你：你好[\s\S]*AI：你好呀/),
    );
  });

  it("多活跃时 /stop 提示而非执行", async () => {
    listActive.mockResolvedValueOnce([
      mockTask({ id: "a", title: "A" }),
      mockTask({ id: "b", title: "B" }),
    ]);
    await runCmd("stop");
    expect(stopAgent).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("请回复对应卡片"),
    );
  });

  it("异常 → 命令执行失败 + inject 记 failed（非 sent）", async () => {
    const { onInjectResult, __clearInjectResultListenersForTest } =
      await import("@/lib/server/feishu-bridge/router");
    const results: Array<{ kind: string }> = [];
    onInjectResult((p) => {
      results.push(p);
    });
    stopAgent.mockRejectedValueOnce(new Error("boom"));
    await runCmd("stop");
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      "命令执行失败：boom",
    );
    expect(results.at(-1)?.kind).toBe("failed");
    __clearInjectResultListenersForTest();
  });

  it("/new 注入失败 → handled_failed（inject 记 failed）", async () => {
    const { onInjectResult, __clearInjectResultListenersForTest } =
      await import("@/lib/server/feishu-bridge/router");
    const results: Array<{ kind: string }> = [];
    onInjectResult((p) => {
      results.push(p);
    });
    handleChat.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "忙" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await runCmd("new", "首条");
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("首条注入失败"),
    );
    expect(results.at(-1)?.kind).toBe("failed");
    __clearInjectResultListenersForTest();
  });

  it("/compact 失败 → handled_failed", async () => {
    const { onInjectResult, __clearInjectResultListenersForTest } =
      await import("@/lib/server/feishu-bridge/router");
    const { CompactChatError } = await import("@/lib/server/chat-runner");
    const results: Array<{ kind: string }> = [];
    onInjectResult((p) => {
      results.push(p);
    });
    compact.mockRejectedValueOnce(
      new CompactChatError("no_session", "无可用会话或 agent 正在回", 400),
    );
    await runCmd("compact");
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      "命令执行失败：无可用会话或 agent 正在回",
    );
    expect(results.at(-1)?.kind).toBe("failed");
    __clearInjectResultListenersForTest();
  });

  it("ensure 幂等：二次调用不抛", () => {
    expect(() => ensureBridgeCommandsRegistered()).not.toThrow();
  });
});
