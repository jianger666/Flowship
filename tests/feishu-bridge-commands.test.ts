/**
 * 飞书桥接命令词：/help 面板卡 / /stop 双语义（锚定停运行、直发清理卡）/ 回执文案 / 异常
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetCommandsRegisteredForTest,
  __setCommandsDepsForTest,
  ensureBridgeCommandsRegistered,
} from "@/lib/server/feishu-bridge/commands";
import {
  buildCleanupCardJson,
  buildHelpPanelCardJson,
} from "@/lib/server/feishu-bridge/control-cards";
import { __clearBridgeCommandsForTest } from "@/lib/server/feishu-bridge/router";
import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { TaskSummary } from "@/lib/types";

// runCmd 走 routeInboundMessage、指针层会读写真实 bridge-state 文件——隔离到独立 tmp。
// bridge-state 的数据目录在每次调用时才解析 env、import 后再设也生效。
process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `feishu-bridge-commands-${Date.now()}`,
  "data",
);

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

// ----------------- 静态卡构建（纯函数、无 mock） -----------------

describe("control-cards 构建", () => {
  it("清理卡：每行标题+状态、当前指针标注、结束/全部结束按钮协议", () => {
    const card = buildCleanupCardJson(
      [
        { id: "task-a", title: "对话 A", runStatus: "idle" },
        { id: "task-b", title: "对话 B", runStatus: "running" },
      ],
      "task-b",
    );
    const json = JSON.stringify(card);
    expect(json).toContain("**对话 A**（空闲）");
    // 当前指针对话标「← 当前」
    expect(json).toContain("**对话 B**（跑步中） ← 当前");
    expect(json).toContain('{"kind":"end_chat","taskId":"task-a"}');
    expect(json).toContain('{"kind":"end_chat","taskId":"task-b"}');
    expect(json).toContain('{"kind":"end_all"}');
    expect(json).toContain("全部结束");
    // 静态卡不开流式
    expect(json).not.toContain("streaming_mode");
  });

  it("控制面板卡：命令说明 + 三颗 cmd 快捷按钮", () => {
    const card = buildHelpPanelCardJson("/new — 开新对话");
    const json = JSON.stringify(card);
    expect(json).toContain("/new — 开新对话");
    expect(json).toContain('{"kind":"cmd","command":"new"}');
    expect(json).toContain('{"kind":"cmd","command":"clean"}');
    expect(json).toContain('{"kind":"cmd","command":"status"}');
    expect(json).toContain("开新对话");
    expect(json).toContain("清理对话");
    expect(json).toContain("桥接状态");
  });
});

// ----------------- 命令注册 + 行为 -----------------

describe("ensureBridgeCommandsRegistered", () => {
  const sendText = vi.fn(async () => ({ chat_id: "c", message_id: "m" }));
  const sendCard = vi.fn<
    (
      openId: string,
      cardJson: unknown,
    ) => Promise<{ chat_id: string; message_id: string; card_id: string }>
  >(async () => ({
    chat_id: "c",
    message_id: "om_card_sent",
    card_id: "card_sent",
  }));
  const rememberCard = vi.fn(async () => undefined);
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
    events: [],
  }));
  const stopAgent = vi.fn(async () => ({
    hadAgent: true,
    task: {} as never,
  }));
  const findByRoot = vi.fn(async () => null);
  const getPointer = vi.fn(async () => "");
  const revive = vi.fn(async () => undefined);
  // 锚定解析：直接取消息自带 root_id（避免真实实现的 REST 反查）
  const resolveAnchors = vi.fn(async (msg: FeishuInboundMessage) =>
    msg.root_id ? [msg.root_id] : [],
  );

  /** 经 routeInboundMessage 走命令扩展点（handler 已 ensure 注册） */
  const runCmd = async (
    command: string,
    args = "",
    msgOverrides: Partial<FeishuInboundMessage> = {},
  ) => {
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
      baseMsg({
        content: `/${command}${args ? ` ${args}` : ""}`,
        ...msgOverrides,
      }),
    );
    __setRouterDepsForTest(null);
  };

  beforeEach(() => {
    sendText.mockClear();
    sendCard.mockClear();
    rememberCard.mockClear();
    listActive.mockClear();
    getStatus.mockClear();
    createChat.mockClear();
    handleChat.mockClear();
    getTask.mockClear();
    stopAgent.mockClear();
    findByRoot.mockClear();
    findByRoot.mockResolvedValue(null);
    getPointer.mockClear();
    getPointer.mockResolvedValue("");
    revive.mockClear();
    resolveAnchors.mockClear();
    listActive.mockResolvedValue([mockTask()]);
    __clearBridgeCommandsForTest();
    __resetCommandsRegisteredForTest();
    __setCommandsDepsForTest({
      getBotAppInfo: async () => ({
        appId: "cli_x",
        ownerOpenId: "ou_owner",
      }),
      sendTextMessage: sendText,
      sendInteractiveCard: sendCard as never,
      rememberCardMessage: rememberCard,
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
      resolveReplyAnchorIds: resolveAnchors,
      reviveChatByAnchor: revive,
      getCurrentChatTaskId: getPointer,
    });
    ensureBridgeCommandsRegistered();
  });

  afterEach(() => {
    __setCommandsDepsForTest(null);
    __clearBridgeCommandsForTest();
    __resetCommandsRegisteredForTest();
  });

  it("/help 发控制面板卡（命令说明 + 三颗快捷按钮）", async () => {
    await runCmd("help");
    expect(sendCard).toHaveBeenCalledTimes(1);
    const [openId, cardJson] = sendCard.mock.calls[0]!;
    expect(openId).toBe("ou_owner");
    const json = JSON.stringify(cardJson);
    expect(json).toMatch(/\/new \[消息\] — /);
    expect(json).toMatch(/\/stop — /);
    expect(json).toMatch(/\/status — /);
    // /history /compact /list 已砍——面板不再出现
    expect(json).not.toContain("/history");
    expect(json).not.toContain("/compact");
    expect(json).not.toContain("/list");
    expect(json).toContain('{"kind":"cmd","command":"new"}');
    expect(json).toContain('{"kind":"cmd","command":"clean"}');
    expect(json).toContain('{"kind":"cmd","command":"status"}');
    // 面板卡不记 card-map
    expect(rememberCard).not.toHaveBeenCalled();
  });

  // T8 用户拍板：Get = 消息真进了 AI——命令 handled 只回文本/卡片、不点表情
  it("命令 handled → inject 记 skipped（不点 Get）", async () => {
    const { onInjectResult, __clearInjectResultListenersForTest } =
      await import("@/lib/server/feishu-bridge/router");
    const results: Array<{ kind: string }> = [];
    onInjectResult((p) => {
      results.push(p);
    });
    await runCmd("help");
    expect(results.at(-1)?.kind).toBe("skipped");
    __clearInjectResultListenersForTest();
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

  it("回复锚定 + /stop 运行中：停止那个对话 + 触发复活语义", async () => {
    findByRoot.mockResolvedValue({
      messageId: "om_old_card",
      cardId: "c1",
      taskId: "task-1",
      createdAt: Date.now(),
    } as never);
    getTask.mockResolvedValueOnce({
      ...(await getTask()),
      runStatus: "running",
    } as never);
    await runCmd("stop", "", { root_id: "om_old_card" });
    expect(stopAgent).toHaveBeenCalled();
    // 锚定命中 → 复活 + 指针切换（reviveChatByAnchor 同源语义）
    expect(revive).toHaveBeenCalledWith("task-1");
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("已停止当前运行：测试对话"),
    );
    // 有锚定不发清理卡
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("回复锚定 + /stop 空闲：不调 stopTaskAgent、回「没有在运行」", async () => {
    findByRoot.mockResolvedValue({
      messageId: "om_old_card",
      cardId: "c1",
      taskId: "task-1",
      createdAt: Date.now(),
    } as never);
    await runCmd("stop", "", { root_id: "om_old_card" });
    expect(stopAgent).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("没有在运行的回复"),
    );
  });

  it("直发 /stop（无锚定）→ 发对话清理卡 + 记 card-map（taskId 空串）", async () => {
    getPointer.mockResolvedValue("task-1");
    listActive.mockResolvedValueOnce([
      mockTask(),
      mockTask({ id: "task-2", title: "另一个" }),
    ]);
    await runCmd("stop");
    expect(stopAgent).not.toHaveBeenCalled();
    expect(sendCard).toHaveBeenCalledTimes(1);
    const json = JSON.stringify(sendCard.mock.calls[0]![1]);
    expect(json).toContain("测试对话");
    expect(json).toContain("另一个");
    // 当前指针对话标注
    expect(json).toContain("← 当前");
    expect(json).toContain('{"kind":"end_all"}');
    // 记 card-map：taskId 空串（只供 card-action 反查 cardId、不参与锚定路由）
    expect(rememberCard).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "om_card_sent",
        cardId: "card_sent",
        taskId: "",
      }),
    );
  });

  it("直发 /stop 零活跃 → 文本「没有进行中的对话」", async () => {
    listActive.mockResolvedValueOnce([]);
    await runCmd("stop");
    expect(sendCard).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "ou_owner",
      "没有进行中的对话",
    );
  });

  // /history /compact /list 已砍——未注册命令 + 非本机 skill → 当普通文本放行（走注入主路径）
  it("/compact /history /list 不再注册为命令、按普通文本处理", async () => {
    await runCmd("compact");
    await runCmd("history");
    await runCmd("list");
    for (const text of ["/compact", "/history", "/list"]) {
      expect(handleChat).toHaveBeenCalledWith(
        "task-1",
        expect.objectContaining({ text }),
        expect.anything(),
      );
    }
  });

  it("异常 → 命令执行失败 + inject 记 failed（非 sent）", async () => {
    const { onInjectResult, __clearInjectResultListenersForTest } =
      await import("@/lib/server/feishu-bridge/router");
    const results: Array<{ kind: string }> = [];
    onInjectResult((p) => {
      results.push(p);
    });
    // 锚定 + running 才走到 stopAgent 异常分支
    findByRoot.mockResolvedValue({
      messageId: "om_old_card",
      cardId: "c1",
      taskId: "task-1",
      createdAt: Date.now(),
    } as never);
    getTask.mockResolvedValueOnce({
      ...(await getTask()),
      runStatus: "running",
    } as never);
    stopAgent.mockRejectedValueOnce(new Error("boom"));
    await runCmd("stop", "", { root_id: "om_old_card" });
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

  it("ensure 幂等：二次调用不抛", () => {
    expect(() => ensureBridgeCommandsRegistered()).not.toThrow();
  });
});
