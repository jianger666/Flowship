/**
 * 飞书桥接 router：过滤 / content 形态 / 活跃 chat 分支 / pendingAsk / 命令扩展点
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __clearBridgeCommandsForTest,
  __setRouterDepsForTest,
  isActiveChatTask,
  onInjectResult,
  parseTextContent,
  registerBridgeCommand,
  routeInboundMessage,
} from "@/lib/server/feishu-bridge/router";
import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { TaskSummary } from "@/lib/types";

const baseMsg = (
  overrides: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: "om_test_1",
  create_time: String(Date.now()),
  chat_id: "oc_test",
  chat_type: "p2p",
  message_type: "text",
  sender_id: "ou_owner",
  content: "hello",
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

describe("parseTextContent", () => {
  it("兼容裸字符串与 {text} JSON", () => {
    expect(parseTextContent("hello")).toBe("hello");
    expect(parseTextContent('{"text":"world"}')).toBe("world");
  });
});

describe("isActiveChatTask", () => {
  it("mode=chat + developing + 24h 内 = 活跃", () => {
    const t = mockTask();
    expect(isActiveChatTask(t)).toBe(true);
  });
  it("终态 / 过期 / 非 chat 不活跃", () => {
    expect(isActiveChatTask(mockTask({ repoStatus: "abandoned" }))).toBe(false);
    expect(isActiveChatTask(mockTask({ mode: "task" }))).toBe(false);
    expect(
      isActiveChatTask(
        mockTask({ updatedAt: Date.now() - 25 * 60 * 60 * 1000 }),
      ),
    ).toBe(false);
  });
});

describe("routeInboundMessage", () => {
  const sendText = vi.fn(async () => ({ chat_id: "c", message_id: "m" }));
  const handleChat = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const injectAsk = vi.fn(async () => ({ ok: true as const }));
  const findByRoot = vi.fn(
    async (): Promise<{
      messageId: string;
      cardId: string;
      taskId: string;
      createdAt: number;
    } | null> => null,
  );
  const listTasks = vi.fn(async () => [mockTask()]);
  const getPending = vi.fn(
    (): {
      askId: string;
      token: string;
      questions: Array<{ id: string; question: string; allowText: boolean }>;
      createdAt: number;
    } | null => null,
  );
  const results: Array<{ kind: string }> = [];

  beforeEach(() => {
    sendText.mockClear();
    handleChat.mockClear();
    injectAsk.mockClear();
    findByRoot.mockClear();
    listTasks.mockClear();
    listTasks.mockResolvedValue([mockTask()]);
    getPending.mockClear();
    getPending.mockReturnValue(null);
    results.length = 0;
    __clearBridgeCommandsForTest();
    onInjectResult((p) => {
      results.push(p);
    });
    __setRouterDepsForTest({
      getBotAppInfo: async () => ({
        appId: "cli_x",
        ownerOpenId: "ou_owner",
      }),
      sendTextMessage: sendText,
      downloadMessageResource: async () => "/tmp/x",
      findTaskByMessageId: findByRoot,
      listTasks,
      createTask: async (input) =>
        ({
          id: "task-new",
          title: input.title,
          mode: "chat",
        }) as never,
      getPendingAsk: getPending as never,
      handleChatReplyInject: handleChat as never,
      injectPendingAskText: injectAsk as never,
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
  });

  afterEach(() => {
    __setRouterDepsForTest(null);
    onInjectResult(null);
    __clearBridgeCommandsForTest();
  });

  it("非 p2p / 非本人 → skipped", async () => {
    const r1 = await routeInboundMessage(
      baseMsg({ chat_type: "group" }),
    );
    expect(r1.kind).toBe("skipped");
    const r2 = await routeInboundMessage(
      baseMsg({ sender_id: "ou_other" }),
    );
    expect(r2.kind).toBe("skipped");
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("root_id 精确路由", async () => {
    findByRoot.mockResolvedValueOnce({
      messageId: "om_card",
      cardId: "c1",
      taskId: "task-anchored",
      createdAt: Date.now(),
    });
    await routeInboundMessage(baseMsg({ root_id: "om_card", content: "续" }));
    expect(handleChat).toHaveBeenCalledWith(
      "task-anchored",
      expect.objectContaining({ text: "续" }),
      expect.objectContaining({
        userReplyMetaExtra: { source: "feishu" },
      }),
    );
  });

  it("0 个活跃 → 自动新建", async () => {
    listTasks.mockResolvedValueOnce([]);
    await routeInboundMessage(baseMsg({ content: "开个新话题吧朋友们" }));
    expect(handleChat).toHaveBeenCalledWith(
      "task-new",
      expect.anything(),
      expect.anything(),
    );
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("已开新对话"),
    );
  });

  it("≥2 个活跃 → 提示并丢弃", async () => {
    listTasks.mockResolvedValueOnce([
      mockTask({ id: "a", title: "A" }),
      mockTask({ id: "b", title: "B" }),
    ]);
    const r = await routeInboundMessage(baseMsg({ content: "哪一个" }));
    expect(r.kind).toBe("skipped");
    expect(handleChat).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("进行中的对话"),
    );
  });

  it("pendingAsk → ask 分流", async () => {
    getPending.mockReturnValue({
      askId: "ask-1",
      token: "t",
      questions: [{ id: "q1", question: "Q?", allowText: true }],
      createdAt: Date.now(),
    });
    await routeInboundMessage(baseMsg({ content: "答案是 42" }));
    expect(injectAsk).toHaveBeenCalled();
    expect(handleChat).not.toHaveBeenCalled();
    expect(results.at(-1)?.kind).toBe("sent");
  });

  it("命令 handler 注册后可 handled 短路", async () => {
    const fn = vi.fn(async () => "handled" as const);
    registerBridgeCommand("ping", fn);
    await routeInboundMessage(baseMsg({ content: "/ping" }));
    expect(fn).toHaveBeenCalled();
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("未注册的 /xxx 命中本机 skill → 当 skill 消息（带 skills 字段）", async () => {
    __setRouterDepsForTest({
      listSkillsWithSource: async () =>
        [
          {
            name: "写代码",
            description: "d",
            absPath: "/skills/写代码/SKILL.md",
            source: "app",
            editable: true,
          },
        ] as never,
    });
    await routeInboundMessage(baseMsg({ content: "/写代码帮我改下" }));
    expect(handleChat).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        text: "帮我改下",
        skills: [{ name: "写代码", absPath: "/skills/写代码/SKILL.md" }],
      }),
      expect.anything(),
    );
  });

  it("未命中命令也未命中 skill 的 /xxx → 当普通文本放行", async () => {
    await routeInboundMessage(baseMsg({ content: "/notacmd 你好" }));
    expect(handleChat).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ text: "/notacmd 你好", skills: undefined }),
      expect.anything(),
    );
  });

  it("202 入队响应 → kind=queued", async () => {
    handleChat.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, queued: true, queuedCount: 1 }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await routeInboundMessage(baseMsg({ content: "排队吧" }));
    expect(r.kind).toBe("queued");
  });

  it("注入失败 → 文本回执", async () => {
    handleChat.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "排队已满" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await routeInboundMessage(baseMsg({ content: "忙吗" }));
    expect(r.kind).toBe("failed");
    expect(sendText).toHaveBeenCalledWith("ou_owner", "排队已满");
  });
});
