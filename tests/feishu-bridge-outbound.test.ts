/**
 * feishu-bridge outbound：turn 状态机单测
 * mock card-stream 工厂 + publish 事件源，不碰真实 lark-cli
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TaskStub = {
  id: string;
  title: string;
  mode: "chat" | "task";
  model?: { id: string };
};

const getTask = vi.hoisted(() =>
  vi.fn(async (id: string): Promise<TaskStub> => ({
    id,
    title: "测对话",
    mode: "chat",
    model: { id: "grok-4" },
  })),
);

const writeEventAndPublish = vi.hoisted(() =>
  vi.fn(async (taskId: string, ev: { kind: string; text?: string }) => ({
    id: `ev_${ev.kind}_${Date.now()}`,
    kind: ev.kind,
    text: ev.text ?? "",
    createdAt: Date.now(),
    taskId,
  })),
);

vi.mock("@/lib/server/task-fs", () => ({
  getTask,
}));

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return {
    ...actual,
    writeEventAndPublish,
  };
});

vi.mock("@/lib/server/feishu-bridge/bridge-config", () => ({
  isFeishuChatBridgeEnabled: vi.fn(async () => true),
  getBridgeDataDir: async () => "/tmp/feishu-bridge-test",
  isBridgeTestInstance: () => true,
  isFeishuBridgeKeepAwakeEnabled: async () => true,
  isFeishuBridgeStreamingEnabled: vi.fn(async () => true),
}));

const getPendingAsk = vi.hoisted(() => vi.fn(() => null));

vi.mock("@/lib/server/chat-pending", () => ({
  getPendingAsk,
}));

const { isFeishuBridgeStreamingEnabled } = await import(
  "@/lib/server/feishu-bridge/bridge-config"
);

/** 假句柄 getHealth 的默认值：终稿落成、没有致命故障（用例按需覆盖） */
const okHealth = vi.hoisted(
  () =>
    (over: Record<string, unknown> = {}) => ({
      failCount: 0,
      consecutiveFails: 0,
      fatalActive: false,
      fatalEver: false,
      finalizeOk: true as boolean | undefined,
      lastError: undefined as unknown,
      ...over,
    }),
);

type CardMock = {
  start: ReturnType<typeof vi.fn>;
  pushProcess: ReturnType<typeof vi.fn>;
  pushAnswer: ReturnType<typeof vi.fn>;
  setHeaderStatus: ReturnType<typeof vi.fn>;
  appendAskUser: ReturnType<typeof vi.fn>;
  appendRetryButton: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  getFailCount: () => number;
  getHealth: () => ReturnType<typeof okHealth>;
  getIds: () => { messageId?: string; cardId?: string };
};

const cardFactory = vi.hoisted(() => {
  const cards: CardMock[] = [];
  const create = vi.fn(() => {
    const card: CardMock = {
      start: vi.fn(async () => undefined),
      pushProcess: vi.fn(),
      pushAnswer: vi.fn(),
      setHeaderStatus: vi.fn(),
      appendAskUser: vi.fn(async () => undefined),
      appendRetryButton: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined),
      getFailCount: () => 0,
      getHealth: () => okHealth(),
      getIds: () => ({ messageId: "om_x", cardId: "card_x" }),
    };
    cards.push(card);
    return card;
  });
  return { create, cards };
});

const uploadImage = vi.hoisted(() =>
  vi.fn(async (p: string) => `img_key_for_${p.split("/").pop()}`),
);

const sendTextMessage = vi.hoisted(() =>
  vi.fn(async () => ({ chat_id: "oc_x", message_id: "om_text" })) as unknown as ReturnType<
    typeof vi.fn<(openId: string, text: string) => Promise<{ chat_id: string; message_id: string }>>
  >,
);

const getBotAppInfo = vi.hoisted(() =>
  vi.fn(async () => ({
    appId: "cli_x",
    ownerOpenId: "ou_owner",
  })),
);

const {
  ensureFeishuOutboundRegistered,
  __resetFeishuOutboundForTest,
  __setCreateCardStreamForTest,
  __setUploadImageForTest,
  __setSendTextMessageForTest,
  __setGetBotAppInfoForTest,
  __setBridgeEnabledForTest,
  __setFallbackRetryDelayForTest,
  __setFinalizeBudgetForTest,
  handleFeishuOutboundEvent,
  formatElapsed,
  splitTextForFallback,
  replaceLocalImagesInMarkdown,
  redactToolDetail,
} = await import("@/lib/server/feishu-bridge/outbound");

const { publishTaskStreamEvent } = await import("@/lib/server/task-stream");
const { LarkApiError, classifyLarkFailure } = await import("@/lib/server/feishu-bridge/types");

const flush = async (): Promise<void> => {
  // 排空 microtask + 一轮 macrotask（start / finalize 链路）
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
};

const makeEvent = (
  kind: string,
  text: string,
  meta?: Record<string, unknown>,
  id = `ev_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
) => ({
  kind: "event" as const,
  event: {
    id,
    ts: Date.now(),
    kind: kind as never,
    text,
    meta,
  },
});

/**
 * 用「getHealth 可控」的假卡跑一轮 user_reply → delta → done，返回那张假卡。
 * runStatus 默认 awaiting_user（= 自然完成）；传 "idle" = 用户 stop。
 */
const runTurnWithHealth = async (opts: {
  taskId: string;
  health: Record<string, unknown>;
  ok?: boolean;
  runStatus?: string;
  /** 本轮 assistant 正文（默认「答」）：文字补发用例要长文 / 带图的正文 */
  answer?: string;
}): Promise<CardMock> => {
  const { taskId, health, ok = true, runStatus = "awaiting_user", answer = "答" } = opts;
  cardFactory.create.mockImplementationOnce(() => {
    const card: CardMock = {
      start: vi.fn(async () => undefined),
      pushProcess: vi.fn(),
      pushAnswer: vi.fn(),
      setHeaderStatus: vi.fn(),
      appendAskUser: vi.fn(async () => undefined),
      appendRetryButton: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined),
      getFailCount: () => 0,
      getHealth: () => okHealth(health),
      getIds: () => ({ messageId: "om_h", cardId: "card_h" }),
    };
    cardFactory.cards.push(card);
    return card;
  });
  publishTaskStreamEvent(taskId, makeEvent("user_reply", "问"));
  publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: answer });
  await flush();
  publishTaskStreamEvent(taskId, {
    kind: "done",
    ok,
    task: { id: taskId, title: "测对话", mode: "chat", runStatus } as never,
  });
  await flush();
  return cardFactory.cards.at(-1)!;
};

/** 本用例里写进事件流的 info 文本 */
const infoTexts = (): string[] =>
  writeEventAndPublish.mock.calls
    .filter(([, ev]) => ev.kind === "info")
    .map(([, ev]) => ev.text ?? "");

/** 最近一条飞书追发的文本 */
const lastPing = (): string =>
  String(sendTextMessage.mock.calls.at(-1)?.[1] ?? "");

beforeEach(() => {
  __resetFeishuOutboundForTest();
  cardFactory.cards.length = 0;
  cardFactory.create.mockClear();
  getTask.mockClear();
  getTask.mockImplementation(async (id: string) => ({
    id,
    title: "测对话",
    mode: "chat" as const,
    model: { id: "grok-4" },
  }));
  writeEventAndPublish.mockClear();
  uploadImage.mockClear();
  sendTextMessage.mockClear();
  getBotAppInfo.mockClear();
  getPendingAsk.mockClear();
  getPendingAsk.mockReturnValue(null);
  vi.mocked(isFeishuBridgeStreamingEnabled).mockReset();
  vi.mocked(isFeishuBridgeStreamingEnabled).mockResolvedValue(true);
  __setCreateCardStreamForTest(
    cardFactory.create as unknown as Parameters<
      typeof __setCreateCardStreamForTest
    >[0],
  );
  __setUploadImageForTest(uploadImage);
  __setSendTextMessageForTest(sendTextMessage);
  __setGetBotAppInfoForTest(getBotAppInfo);
  __setBridgeEnabledForTest(true);
  ensureFeishuOutboundRegistered();
});

afterEach(() => {
  __resetFeishuOutboundForTest();
  __setFallbackRetryDelayForTest(null);
  __setFinalizeBudgetForTest(null);
  vi.useRealTimers();
});

describe("formatElapsed / replaceLocalImages", () => {
  it("耗时格式", () => {
    expect(formatElapsed(5_000)).toBe("5s");
    expect(formatElapsed(200_000)).toBe("3m20s");
  });

  it("finalize 前替换本地图、失败降级", async () => {
    const ok = await replaceLocalImagesInMarkdown(
      "看图 ![](/tmp/a.png) 完",
      async () => "img_abc",
    );
    expect(ok).toContain("![](img_abc)");

    const fail = await replaceLocalImagesInMarkdown(
      "![](/tmp/b.png)",
      async () => {
        throw new Error("upload fail");
      },
    );
    expect(fail).toBe("[图片：仅 app 内可见]");

    const remote = await replaceLocalImagesInMarkdown(
      "![](https://example.com/x.png)",
      async () => "should_not",
    );
    expect(remote).toContain("https://example.com/x.png");
  });
});

describe("turn 状态机", () => {
  it("echo 累积（feishu 来源排除）+ 首个 assistant 事件才 start", async () => {
    const taskId = "t_echo";
    publishTaskStreamEvent(
      taskId,
      makeEvent("user_reply", "你好", {
        images: [{ absPath: "/tmp/hi.png", relPath: "uploads/hi.png" }],
      }),
    );
    await flush();
    expect(cardFactory.create).not.toHaveBeenCalled();

    publishTaskStreamEvent(
      taskId,
      makeEvent("thinking", "先想想"),
    );
    await flush();
    expect(cardFactory.create).toHaveBeenCalledTimes(1);
    expect(cardFactory.create).toHaveBeenCalledWith(taskId, {
      title: "测对话",
      streaming: true,
      onFatal: expect.any(Function),
    });
    const card = cardFactory.cards[0]!;
    expect(card.start).toHaveBeenCalled();
    const startArg = card.start.mock.calls[0]?.[0] as {
      echoText?: string;
      echoImageKeys?: string[];
    };
    expect(startArg.echoText).toBe("你好");
    expect(startArg.echoImageKeys).toEqual(["img_key_for_hi.png"]);

    // 第一轮收尾（真实链路 done 必达、清 turn）
    publishTaskStreamEvent(taskId, {
      kind: "done",
      ok: true,
      task: { id: taskId, title: "测对话", mode: "chat" } as never,
    });
    await flush();

    // 飞书来源：新一轮但不累积 echo
    publishTaskStreamEvent(
      taskId,
      makeEvent("user_reply", "飞书说的", { source: "feishu" }),
    );
    await flush();
    publishTaskStreamEvent(taskId, makeEvent("thinking", "又想"));
    await flush();
    expect(cardFactory.create).toHaveBeenCalledTimes(2);
    const card2 = cardFactory.cards[1]!;
    const start2 = card2.start.mock.calls[0]?.[0] as {
      echoText?: string;
      echoImageKeys?: string[];
    };
    expect(start2?.echoText).toBeUndefined();
    expect(start2?.echoImageKeys).toBeUndefined();
  });

  it("thinking/tool 进过程区、delta 进正文、done finalize", async () => {
    const taskId = "t_flow";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "跑一下"));
    await flush();

    publishTaskStreamEvent(taskId, makeEvent("thinking", "分析需求"));
    await flush();
    const card = cardFactory.cards[0]!;
    expect(card.pushProcess).toHaveBeenCalled();
    const processText = String(card.pushProcess.mock.calls.at(-1)?.[0] ?? "");
    // Hermes timeline：思考条目标题 + 正文
    expect(processText).toContain("**思考 1**");
    expect(processText).toContain("分析需求");

    publishTaskStreamEvent(
      taskId,
      makeEvent("tool_call", "调用 Shell:pnpm lint", {
        callId: "c1",
        name: "Shell",
        args: JSON.stringify({ command: "pnpm lint" }),
      }),
    );
    await flush();
    const process2 = String(card.pushProcess.mock.calls.at(-1)?.[0] ?? "");
    // 工具行：引用块 + `Shell` · running
    expect(process2).toContain("`Shell` · running");
    expect(process2).toContain("> ");
    expect(process2).toContain("pnpm lint");
    expect(card.setHeaderStatus).toHaveBeenCalled();
    const header = String(card.setHeaderStatus.mock.calls.at(-1)?.[0] ?? "");
    // Hermes 式实时动作：正在执行终端：pnpm lint
    expect(header).toContain("正在执行终端");
    expect(header).toContain("pnpm lint");

    publishTaskStreamEvent(
      taskId,
      makeEvent("tool_result", "工具完成 Shell", {
        callId: "c1",
        name: "Shell",
        status: "success",
      }),
    );
    await flush();
    const process3 = String(card.pushProcess.mock.calls.at(-1)?.[0] ?? "");
    expect(process3).toContain("`Shell` · completed");

    publishTaskStreamEvent(taskId, {
      kind: "assistant_delta",
      text: "结论是",
    });
    publishTaskStreamEvent(taskId, {
      kind: "assistant_delta",
      text: "通过",
    });
    await flush();
    expect(card.pushAnswer).toHaveBeenCalled();
    expect(card.pushAnswer.mock.calls.at(-1)?.[0]).toBe("结论是通过");

    publishTaskStreamEvent(taskId, {
      kind: "done",
      ok: true,
      task: {
        id: taskId,
        title: "测对话",
        mode: "chat",
      } as never,
    });
    await flush();
    expect(card.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        model: "grok-4",
      }),
    );
    expect(card.appendRetryButton).not.toHaveBeenCalled();
  });

  // 2026-07-19 用户实测：SDK 拆多条 thinking 事件 → 不被工具隔开就合并同一段
  it("连续 thinking 合并进同一「思考 1」段（空行分隔）", async () => {
    const taskId = "t_think_merge";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "想想"));
    await flush();
    publishTaskStreamEvent(taskId, makeEvent("thinking", "第一段思路"));
    publishTaskStreamEvent(taskId, makeEvent("thinking", "第二段思路"));
    await flush();
    const card = cardFactory.cards[0]!;
    const text = String(card.pushProcess.mock.calls.at(-1)?.[0] ?? "");
    expect(text).toContain("**思考 1**");
    expect(text).not.toContain("**思考 2**");
    expect(text).toContain("第一段思路\n\n第二段思路");
  });

  it("thinking→tool→thinking 被工具隔开拆成思考 1 / 思考 2", async () => {
    const taskId = "t_think_split";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "拆段"));
    await flush();
    publishTaskStreamEvent(taskId, makeEvent("thinking", "先想一步"));
    publishTaskStreamEvent(
      taskId,
      makeEvent("tool_call", "调用 Shell:ls", {
        callId: "c_split",
        name: "Shell",
        args: JSON.stringify({ command: "ls" }),
      }),
    );
    publishTaskStreamEvent(taskId, makeEvent("thinking", "再想一步"));
    await flush();
    const card = cardFactory.cards[0]!;
    const text = String(card.pushProcess.mock.calls.at(-1)?.[0] ?? "");
    // Hermes timeline：工具隔开 → 新开思考段；最后一段 running、更早的 completed
    expect(text).toContain("**思考 1** · completed\n先想一步");
    expect(text).toContain("**思考 2** · running\n再想一步");

    // Hermes record_answer_started：正文开始后开放思考收敛 completed
    publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: "答" });
    await flush();
    const after = String(card.pushProcess.mock.calls.at(-1)?.[0] ?? "");
    expect(after).toContain("**思考 2** · completed");
  });

  // P0：start 未完成时 done 抢跑——pending 思考不得因 turn.finalized 被丢弃
  it("start 未完成时 done 到达：pending 思考仍在 finalize 前推上", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((r) => {
      releaseStart = r;
    });
    __setCreateCardStreamForTest((() => {
      const card: CardMock = {
        start: vi.fn(async () => {
          await startGate;
        }),
        pushProcess: vi.fn(),
        pushAnswer: vi.fn(),
        setHeaderStatus: vi.fn(),
        appendAskUser: vi.fn(async () => undefined),
        appendRetryButton: vi.fn(async () => undefined),
        finalize: vi.fn(async () => undefined),
        getFailCount: () => 0,
        getHealth: () => okHealth(),
        getIds: () => ({ messageId: "om_race", cardId: "card_race" }),
      };
      cardFactory.cards.push(card);
      return card;
    }) as unknown as Parameters<typeof __setCreateCardStreamForTest>[0]);

    const taskId = "t_pending_race";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "hello啊"));
    await flush();
    publishTaskStreamEvent(
      taskId,
      makeEvent(
        "thinking",
        "用户在 Flowship Chat 任务中问候。我将用中文自然回复。",
      ),
    );
    publishTaskStreamEvent(taskId, {
      kind: "assistant_delta",
      text: "你好！",
    });
    // 不等 start 完成就 done（finalizeTurn 先标 finalized）
    publishTaskStreamEvent(taskId, {
      kind: "done",
      ok: true,
      task: {
        id: taskId,
        title: "测对话",
        mode: "chat",
        runStatus: "awaiting_user",
      } as never,
    });
    await flush();
    expect(cardFactory.cards.length).toBe(1);
    const card = cardFactory.cards[0]!;
    // start 还卡着 → pending 尚未排空
    expect(card.pushProcess).not.toHaveBeenCalled();

    releaseStart();
    await flush();
    await flush();

    expect(card.pushProcess).toHaveBeenCalled();
    const processTexts = card.pushProcess.mock.calls.map((c) =>
      String(c[0] ?? ""),
    );
    expect(
      processTexts.some((t) =>
        t.includes("用户在 Flowship Chat 任务中问候"),
      ),
    ).toBe(true);
    expect(card.finalize).toHaveBeenCalled();
  });

  it("redactToolDetail 脱敏 token/secret", () => {
    expect(
      redactToolDetail(
        JSON.stringify({ command: "echo", token: "secret-value" }),
      ),
    ).toContain("[REDACTED]");
    expect(redactToolDetail("password=abc123 foo")).toContain("[REDACTED]");
  });

  it("error / done ok=false 加重试按钮", async () => {
    const taskId = "t_err";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "重试我"));
    await flush();
    publishTaskStreamEvent(taskId, {
      kind: "assistant_delta",
      text: "半截",
    });
    await flush();
    const card = cardFactory.cards[0]!;

    publishTaskStreamEvent(taskId, {
      kind: "done",
      ok: false,
      task: { id: taskId, title: "测对话", mode: "chat" } as never,
    });
    await flush();
    expect(card.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false }),
    );
    expect(card.appendRetryButton).toHaveBeenCalledWith("重试我");
  });

  it("开关关闭全程 no-op", async () => {
    __setBridgeEnabledForTest(false);
    const taskId = "t_off";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "关了"));
    publishTaskStreamEvent(taskId, makeEvent("thinking", "不该推"));
    publishTaskStreamEvent(taskId, {
      kind: "assistant_delta",
      text: "也不该",
    });
    publishTaskStreamEvent(taskId, {
      kind: "done",
      ok: true,
      task: { id: taskId } as never,
    });
    await flush();
    expect(cardFactory.create).not.toHaveBeenCalled();
  });

  it("非 chat 模式忽略", async () => {
    getTask.mockImplementation(async (id: string): Promise<TaskStub> => ({
      id,
      title: "任务",
      mode: "task",
    }));
    publishTaskStreamEvent("t_task", makeEvent("user_reply", "x"));
    publishTaskStreamEvent("t_task", makeEvent("thinking", "y"));
    await flush();
    expect(cardFactory.create).not.toHaveBeenCalled();
  });

  it("新一轮开新卡", async () => {
    const taskId = "t_round";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "第一轮"));
    publishTaskStreamEvent(taskId, {
      kind: "assistant_delta",
      text: "答1",
    });
    await flush();
    publishTaskStreamEvent(taskId, {
      kind: "done",
      ok: true,
      // done 自带 task 会刷新 mode 缓存——真实链路必带 mode:"chat"
      task: { id: taskId, title: "测对话", mode: "chat" } as never,
    });
    await flush();

    publishTaskStreamEvent(taskId, makeEvent("user_reply", "第二轮"));
    publishTaskStreamEvent(taskId, {
      kind: "assistant_delta",
      text: "答2",
    });
    await flush();
    expect(cardFactory.create).toHaveBeenCalledTimes(2);
    expect(cardFactory.cards[1]!.pushAnswer.mock.calls.at(-1)?.[0]).toBe("答2");
  });

  it("ask_user_request → appendAskUser", async () => {
    const taskId = "t_ask";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "问我"));
    await flush();
    publishTaskStreamEvent(
      taskId,
      makeEvent("ask_user_request", "Q1: 选哪个？", {
        askId: "ask_1",
        token: "tok",
        questions: [
          {
            id: "q1",
            question: "选哪个？",
            allowText: true,
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        ],
      }),
    );
    await flush();
    const card = cardFactory.cards[0]!;
    expect(card.appendAskUser).toHaveBeenCalledWith({
      askId: "ask_1",
      questions: [
        {
          id: "q1",
          question: "选哪个？",
          allowText: true,
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    });
  });

  it("start 完成前的 push 不丢（outbound 层缓冲）", async () => {
    const taskId = "t_buf";
    let resolveStart!: () => void;
    const startGate = new Promise<void>((r) => {
      resolveStart = r;
    });
    cardFactory.create.mockImplementationOnce(() => {
      const card: CardMock = {
        start: vi.fn(async () => {
          await startGate;
        }),
        pushProcess: vi.fn(),
        pushAnswer: vi.fn(),
        setHeaderStatus: vi.fn(),
        appendAskUser: vi.fn(async () => undefined),
        appendRetryButton: vi.fn(async () => undefined),
        finalize: vi.fn(async () => undefined),
        getFailCount: () => 0,
        getHealth: () => okHealth(),
        getIds: () => ({}),
      };
      cardFactory.cards.push(card);
      return card;
    });

    publishTaskStreamEvent(taskId, makeEvent("user_reply", "缓冲测"));
    await flush();
    // 触发 start（挂起）+ 立刻推 delta
    const p1 = handleFeishuOutboundEvent(taskId, {
      kind: "assistant_delta",
      text: "前",
    });
    const p2 = handleFeishuOutboundEvent(taskId, {
      kind: "assistant_delta",
      text: "后",
    });
    await flush();
    const card = cardFactory.cards[0]!;
    expect(card.start).toHaveBeenCalled();
    expect(card.pushAnswer).not.toHaveBeenCalled(); // 还在等 start

    resolveStart();
    await p1;
    await p2;
    await flush();
    expect(card.pushAnswer).toHaveBeenCalled();
    expect(card.pushAnswer.mock.calls.at(-1)?.[0]).toBe("前后");
  });

  it("排队 flush 的多条 user_reply 合并进同一轮 echo", async () => {
    const taskId = "t_merge";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "第一条"));
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "第二条"));
    await flush();
    publishTaskStreamEvent(taskId, makeEvent("thinking", "想"));
    await flush();
    expect(cardFactory.create).toHaveBeenCalledTimes(1);
    const startArg = cardFactory.cards[0]!.start.mock.calls[0]?.[0] as {
      echoText?: string;
    };
    expect(startArg.echoText).toBe("第一条\n第二条");
  });

  it("落盘 error 事件文本作为 done ok=false 的 finalize 错误文案", async () => {
    const taskId = "t_errtext";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "会挂"));
    publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: "跑着" });
    await flush();
    publishTaskStreamEvent(
      taskId,
      makeEvent("error", "Chat agent 异常：连接断了"),
    );
    publishTaskStreamEvent(taskId, {
      kind: "done",
      ok: false,
      task: { id: taskId, title: "测对话", mode: "chat" } as never,
    });
    await flush();
    const card = cardFactory.cards[0]!;
    expect(card.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: "Chat agent 异常：连接断了",
      }),
    );
    expect(card.appendRetryButton).toHaveBeenCalledWith("会挂");
  });

  it("卡片已开后的迟到 user_reply 不拆轮", async () => {
    const taskId = "t_late";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "先来"));
    publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: "答" });
    await flush();
    // 竞态：persist 晚于首个 delta → 不新开卡、只更新重试文案
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "迟到的"));
    await flush();
    expect(cardFactory.create).toHaveBeenCalledTimes(1);
    publishTaskStreamEvent(taskId, {
      kind: "done",
      ok: false,
      task: { id: taskId, title: "测对话", mode: "chat" } as never,
    });
    await flush();
    expect(cardFactory.cards[0]!.appendRetryButton).toHaveBeenCalledWith(
      "迟到的",
    );
  });

  it("幂等注册不重复订阅", async () => {
    ensureFeishuOutboundRegistered();
    ensureFeishuOutboundRegistered();
    const taskId = "t_once";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "x"));
    publishTaskStreamEvent(taskId, makeEvent("thinking", "y"));
    await flush();
    expect(cardFactory.create).toHaveBeenCalledTimes(1);
  });

  // review P1#4 / 坑 #10 + R14 P1-1：飞书卡片没同步完整内容 → app 内必须可见、飞书侧追发不能报喜。
  // 判据是「终稿没落成 / 致命故障未恢复」，不再是整轮累计失败次数
  // （旧 failCount>=3：偶发抖动 3 次就误报，而 finalize 自己失败时累计数可能只有 0~2、又一声不吭）
  it("终稿没落到卡片（finalizeOk=false）→ app 内 info 带原因 + 飞书追发明说没同步、不报「已完成」", async () => {
    await runTurnWithHealth({
      taskId: "t_failvis",
      health: {
        finalizeOk: false,
        failCount: 1, // 累计数很小也要报：看的是「终稿没落成」，不是次数
        lastError: new LarkApiError("Access denied", { code: 99991672 }),
      },
    });

    const infos = infoTexts();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("飞书卡片没能同步完整回复");
    expect(infos[0]).toContain("Access denied");
    expect(infos[0]).toContain("99991672");

    // 终稿没落成：先把正文（这里是「答」）以文字补发、再追发「没同步」收尾提示（共 2 条，提示在最后）
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(String(sendTextMessage.mock.calls[0]?.[1])).toContain("答");
    expect(lastPing()).toContain("没能同步");
    expect(lastPing()).not.toContain("已完成");
  });

  it("累计失败数很大、但终稿已落成且致命故障已恢复 → 不报警，追发仍是「已完成」（旧判据 failCount>=3 的误报）", async () => {
    await runTurnWithHealth({
      taskId: "t_failvis_recovered",
      health: { failCount: 99, fatalEver: true, finalizeOk: true },
    });
    expect(infoTexts()).toHaveLength(0);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(lastPing()).toContain("已完成");
  });

  it("致命故障此刻仍未恢复（终稿结果未知）→ 同样算没同步", async () => {
    await runTurnWithHealth({
      taskId: "t_failvis_breaker",
      health: {
        fatalActive: true,
        fatalEver: true,
        finalizeOk: undefined,
        lastError: new Error("lark-cli 超时（8000ms）"),
      },
    });
    const infos = infoTexts();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("没能同步完整回复");
    expect(infos[0]).toContain("超时");
    expect(lastPing()).toContain("没能同步");
  });

  it("没有失败原因可描述时 info 也不空（原因未知）", async () => {
    await runTurnWithHealth({
      taskId: "t_failvis_noreason",
      health: { finalizeOk: false, lastError: undefined },
    });
    expect(infoTexts()[0]).toContain("原因未知");
  });

  it("句柄没给出任何成功信号（finalizeOk=undefined、也没有致命故障，例如建卡就失败）→ 按没同步报，不报喜", async () => {
    await runTurnWithHealth({
      taskId: "t_failvis_nosignal",
      health: {
        finalizeOk: undefined,
        fatalActive: false,
        lastError: new Error("建卡失败：no permission"),
      },
    });
    const infos = infoTexts();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("没能同步完整回复");
    expect(infos[0]).toContain("no permission");
    expect(lastPing()).toContain("没能同步");
    expect(lastPing()).not.toContain("已完成");
  });

  it("终稿落成但致命故障标志仍开着（此刻仍未恢复）→ 同样按没同步报，不报喜", async () => {
    await runTurnWithHealth({
      taskId: "t_failvis_contradict",
      health: {
        finalizeOk: true,
        fatalActive: true,
        lastError: new Error("rate limited"),
      },
    });
    expect(infoTexts()).toHaveLength(1);
    expect(infoTexts()[0]).toContain("rate limited");
    expect(lastPing()).toContain("没能同步");
    expect(lastPing()).not.toContain("已完成");
  });

  it("没同步时：app 内 info 先于飞书追发（追发走同一条 lark 单飞队列，黑洞时可能排满 30s——app 内提示不能被它拖慢）", async () => {
    await runTurnWithHealth({
      taskId: "t_failvis_order",
      health: { finalizeOk: false, lastError: new Error("boom") },
    });
    const infoOrder = writeEventAndPublish.mock.invocationCallOrder[0]!;
    const pingOrder = sendTextMessage.mock.invocationCallOrder[0]!;
    expect(infoOrder).toBeLessThan(pingOrder);
  });

  it("失败原因里的换行 / 连续空白被折叠成一行（info 是单行提示）", async () => {
    await runTurnWithHealth({
      taskId: "t_failvis_oneline",
      health: {
        finalizeOk: false,
        lastError: new Error("第一行\n\n   第二行\t第三行"),
      },
    });
    const info = infoTexts()[0]!;
    expect(info).toContain("第一行 第二行 第三行");
    expect(info).not.toMatch(/[\n\t]/);
  });

  it("失败原因是几十 KB 的 execFile 错误（message 带整卡 --data）时，info 只带一行摘要：≤ 400 字、不含整卡正文", async () => {
    const BIG_MARK = "整卡正文标记";
    const huge = new LarkApiError(
      `Command failed: lark-cli api PUT /x --data ${"a".repeat(500)}${BIG_MARK}${"字".repeat(30_000)}`,
      { code: 99991400 },
    );
    await runTurnWithHealth({
      taskId: "t_failvis_huge",
      health: { finalizeOk: false, lastError: huge },
    });
    const infos = infoTexts();
    expect(infos).toHaveLength(1);
    expect(infos[0]!.length).toBeLessThanOrEqual(400);
    expect(infos[0]).not.toContain(BIG_MARK);

    // 致命故障提示同理
    writeEventAndPublish.mockClear();
    const createOpts = (
      cardFactory.create.mock.calls.at(-1) as unknown as [
        string,
        {
          onFatal?: (info: {
            consecutiveFails: number;
            error: unknown;
            fatalKind: string;
          }) => void;
        },
      ]
    )[1];
    createOpts.onFatal!({ consecutiveFails: 0, error: huge, fatalKind: "gone" });
    await flush();
    const brk = infoTexts();
    expect(brk).toHaveLength(1);
    expect(brk[0]!.length).toBeLessThanOrEqual(400);
    expect(brk[0]).not.toContain(BIG_MARK);
  });

  it("致命故障一发生就当场写 info（不等 finalize）；回调里写 info 失败也不传播", async () => {
    const taskId = "t_breaker_info";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "问"));
    publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: "答" });
    await flush();
    const createOpts = (
      cardFactory.create.mock.calls[0] as unknown as [
        string,
        {
          onFatal?: (info: {
            consecutiveFails: number;
            error: unknown;
            fatalKind: string;
          }) => void;
        },
      ]
    )[1];
    expect(typeof createOpts.onFatal).toBe("function");

    createOpts.onFatal!({
      consecutiveFails: 0,
      error: new LarkApiError("The card entity does not exist", { code: 200740 }),
      fatalKind: "gone",
    });
    await flush();
    const infos = infoTexts();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("飞书卡片无法继续更新");
    expect(infos[0]).toContain("The card entity does not exist");
    // 此刻这一轮还没结束：没有追发
    expect(sendTextMessage).not.toHaveBeenCalled();

    // 写 info 自己失败：回调吞掉，不抛、不留未处理的 rejection（vitest 会把后者判红）
    writeEventAndPublish.mockRejectedValueOnce(new Error("disk full"));
    expect(() =>
      createOpts.onFatal!({
        consecutiveFails: 0,
        error: new Error("x"),
        fatalKind: "gone",
      }),
    ).not.toThrow();
    await flush();
  });

  // R1-7：多图回显按位序，慢的先完成也不打乱
  it("echo 多图按原 paths 位序收集 image_key", async () => {
    uploadImage.mockImplementation(async (p: string) => {
      const name = p.split("/").pop() ?? p;
      // 第二张更快完成——旧实现会先 push 乱序
      const delay = name === "b.png" ? 5 : 40;
      await new Promise((r) => setTimeout(r, delay));
      return `key_${name}`;
    });
    const taskId = "t_img_order";
    publishTaskStreamEvent(
      taskId,
      makeEvent("user_reply", "多图", {
        images: [
          { absPath: "/tmp/a.png", relPath: "uploads/a.png" },
          { absPath: "/tmp/b.png", relPath: "uploads/b.png" },
          { absPath: "/tmp/c.png", relPath: "uploads/c.png" },
        ],
      }),
    );
    await flush();
    publishTaskStreamEvent(taskId, makeEvent("thinking", "看图"));
    await flush();
    const card = cardFactory.cards[0]!;
    await vi.waitFor(() => expect(card.start).toHaveBeenCalled());
    const startArg = card.start.mock.calls[0]?.[0] as {
      echoImageKeys?: string[];
    };
    expect(startArg.echoImageKeys).toEqual([
      "key_a.png",
      "key_b.png",
      "key_c.png",
    ]);
  });

  // R1-4：stop → runStatus idle → finalize outcome=stopped
  it("done ok=true 且 runStatus≠awaiting_user → finalize outcome=stopped", async () => {
    const taskId = "t_stopped";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "停我"));
    publishTaskStreamEvent(taskId, {
      kind: "assistant_delta",
      text: "半截",
    });
    await flush();
    const card = cardFactory.cards[0]!;
    publishTaskStreamEvent(taskId, {
      kind: "done",
      ok: true,
      task: {
        id: taskId,
        title: "测对话",
        mode: "chat",
        runStatus: "idle",
      } as never,
    });
    await flush();
    expect(card.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, outcome: "stopped" }),
    );
  });

  it("done ok=true 且 runStatus=awaiting_user → 不传 outcome stopped", async () => {
    const taskId = "t_natural";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "正常"));
    publishTaskStreamEvent(taskId, {
      kind: "assistant_delta",
      text: "完",
    });
    await flush();
    const card = cardFactory.cards[0]!;
    publishTaskStreamEvent(taskId, {
      kind: "done",
      ok: true,
      task: {
        id: taskId,
        title: "测对话",
        mode: "chat",
        runStatus: "awaiting_user",
      } as never,
    });
    await flush();
    expect(card.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
    );
    const arg = card.finalize.mock.calls[0]?.[0] as { outcome?: string };
    expect(arg.outcome).toBeUndefined();
  });
});

describe("流式开关冻结", () => {
  it("流式开关本轮定稿：中途改 settings 不影响本轮 create opts", async () => {
    const taskId = "t_stream_freeze";
    publishTaskStreamEvent(taskId, makeEvent("user_reply", "hi"));
    publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: "答" });
    await flush();
    expect(cardFactory.create).toHaveBeenCalledWith(taskId, {
      title: "测对话",
      streaming: true,
      onFatal: expect.any(Function),
    });
    expect(isFeishuBridgeStreamingEnabled).toHaveBeenCalledTimes(1);

    // 中途关掉流式——本轮已 started，不应再读盘 / 重建句柄
    vi.mocked(isFeishuBridgeStreamingEnabled).mockResolvedValue(false);
    publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: "续" });
    await flush();
    expect(cardFactory.create).toHaveBeenCalledTimes(1);
    expect(isFeishuBridgeStreamingEnabled).toHaveBeenCalledTimes(1);
    expect(cardFactory.cards[0]!.pushAnswer).toHaveBeenCalled();
  });
});

describe("流式完成追发短文本", () => {
  /** 跑一轮 user_reply → delta → done；elapsedMs 控制 Date.now 相对起点的流逝 */
  const runTurnToDone = async (opts: {
    taskId: string;
    elapsedMs: number;
    ok?: boolean;
    runStatus?: string;
    answer?: string;
  }): Promise<void> => {
    const {
      taskId,
      elapsedMs,
      ok = true,
      runStatus = "awaiting_user",
      answer = "答",
    } = opts;
    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      publishTaskStreamEvent(taskId, makeEvent("user_reply", "问"));
      await flush();
      // 流逝后再推 delta/done——turnStartedAt 已在 user_reply 时钉在 t0
      nowSpy.mockReturnValue(t0 + elapsedMs);
      publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: answer });
      await flush();
      publishTaskStreamEvent(taskId, {
        kind: "done",
        ok,
        task: {
          id: taskId,
          title: "测对话",
          mode: "chat",
          runStatus,
        } as never,
      });
      await flush();
    } finally {
      nowSpy.mockRestore();
    }
  };

  it("done ok → sendTextMessage 文案含「已完成」", async () => {
    await runTurnToDone({ taskId: "t_ping_ok", elapsedMs: 83_000 });
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("已完成"),
    );
    const text = String(sendTextMessage.mock.calls[0]?.[1] ?? "");
    expect(text).toMatch(/1m23s/);
  });

  it("秒回短轮也追发（2026-07-21 用户拍板去掉 30s 门槛）", async () => {
    await runTurnToDone({ taskId: "t_ping_short", elapsedMs: 10_000 });
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("已完成"),
    );
  });

  it("done ok=false → 文案含「处理失败」", async () => {
    await runTurnToDone({
      taskId: "t_ping_fail",
      elapsedMs: 31_000,
      ok: false,
    });
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith(
      "ou_owner",
      expect.stringContaining("处理失败"),
    );
  });

  it("outcome=stopped → 不追发", async () => {
    await runTurnToDone({
      taskId: "t_ping_stopped",
      elapsedMs: 60_000,
      runStatus: "idle",
    });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("非流式模式 → 不追发", async () => {
    vi.mocked(isFeishuBridgeStreamingEnabled).mockResolvedValue(false);
    await runTurnToDone({ taskId: "t_ping_nostream", elapsedMs: 60_000 });
    expect(cardFactory.create).toHaveBeenCalledWith("t_ping_nostream", {
      title: "测对话",
      streaming: false,
      onFatal: expect.any(Function),
    });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  // R14 P1-1：卡片没同步时追发不能报喜；非流式卡没发出去时更要追发（否则飞书里什么都收不到）
  it("非流式 + 卡片没发出去（finalizeOk=false）→ 仍追发，明说没同步", async () => {
    vi.mocked(isFeishuBridgeStreamingEnabled).mockResolvedValue(false);
    await runTurnWithHealth({
      taskId: "t_ping_nostream_fail",
      health: { finalizeOk: false },
    });
    // 正文文字补发 1 条 + 收尾提示 1 条
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(lastPing()).toContain("没能同步");
  });

  it("流式 + 没同步：⚠️ 文案带耗时、不再报「已完成」", async () => {
    await runTurnWithHealth({
      taskId: "t_ping_unsynced",
      health: { finalizeOk: false },
    });
    // 正文文字补发 1 条 + 收尾提示 1 条（提示在最后）
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    // 补发已把完整回复发出去：收尾文案如实说，不再让用户「回 Flowship 查看」
    expect(lastPing()).toContain("⚠️ 飞书卡片没能同步，完整回复已用文字版发在上面（");
    expect(lastPing()).not.toContain("请回 Flowship 查看");
    expect(lastPing()).not.toContain("已完成");
  });

  it("没同步、且没发出文字补发（结果未知：finalizeOk=undefined 仅致命态未恢复）：仍是「请回 Flowship 查看」的原文案", async () => {
    await runTurnWithHealth({
      taskId: "t_ping_unsynced_nofb",
      health: { finalizeOk: undefined, fatalActive: true },
    });
    expect(sendTextMessage).toHaveBeenCalledTimes(1); // 只有收尾提示、没有补发
    expect(lastPing()).toContain("⚠️ 回复没能同步到飞书卡片，请回 Flowship 查看（");
  });

  it("没同步时「❌ 处理失败」也明说卡片不可用（重试按钮可能没出来）", async () => {
    await runTurnWithHealth({
      taskId: "t_ping_fail_unsynced",
      health: { finalizeOk: false },
      ok: false,
    });
    expect(lastPing()).toContain("处理失败");
    expect(lastPing()).toContain("没能同步");
    expect(lastPing()).not.toContain("可在卡片重试");
  });

  it("有待答问题：同步正常 →「有问题等你回答」；没同步 → 同时说明选项按钮可能不可用", async () => {
    getPendingAsk.mockReturnValue({ askId: "a1" } as never);
    await runTurnWithHealth({ taskId: "t_ping_ask_ok", health: {} });
    expect(lastPing()).toBe("🙋 有问题等你回答");

    sendTextMessage.mockClear();
    await runTurnWithHealth({
      taskId: "t_ping_ask_unsynced",
      health: { finalizeOk: false },
    });
    expect(lastPing()).toContain("有问题等你回答");
    expect(lastPing()).toContain("没能同步");
  });

  it("用户 stop 的轮次：即使卡片没同步也不追发（人是自己停的），但 app 内 info 仍写", async () => {
    await runTurnWithHealth({
      taskId: "t_ping_stopped_unsynced",
      health: { finalizeOk: false },
      runStatus: "idle",
    });
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(infoTexts()).toHaveLength(1);
  });
});
describe("splitTextForFallback：文字补发的分块", () => {
  it("不超过块长 → 原样一块；空串 → 无块", () => {
    expect(splitTextForFallback("短文本", 10)).toEqual(["短文本"]);
    expect(splitTextForFallback("", 10)).toEqual([]);
  });

  it("超长：每块 ≤ size、拼回去不丢字（硬切时保序无损）", () => {
    const text = "甲".repeat(25);
    const chunks = splitTextForFallback(text, 10);
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
    expect(chunks).toHaveLength(3);
    expect(chunks.join("")).toBe(text);
  });

  it("优先在换行处断开（窗口后半段内的最后一个换行），换行本身不带进下一块", () => {
    const text = `${"甲".repeat(7)}\n${"乙".repeat(7)}`;
    expect(splitTextForFallback(text, 10)).toEqual(["甲".repeat(7), "乙".repeat(7)]);
  });

  it("硬切点落在代理对中间（emoji）→ 回退一位，不把一个字符拆成两半", () => {
    const text = `${"a".repeat(9)}😀${"b".repeat(5)}`; // 😀 占 2 个码元，落在 9~10
    const chunks = splitTextForFallback(text, 10);
    expect(chunks[0]).toBe("a".repeat(9));
    expect(chunks[1]!.startsWith("😀")).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

// 终稿没落到飞书卡片（card-stream 已对限流 / 超时退避重试过仍失败 / 卡没了 / 没权限）：
// 正文以普通文本消息分块补发，再发收尾提示——否则用户在飞书里只剩一张停在中间态的卡
describe("终稿没落成 → 正文文字补发", () => {
  const sentTexts = (): string[] =>
    (sendTextMessage.mock.calls as unknown as Array<[string, string]>).map((c) => c[1]);

  it("短正文：补发 1 条（带说明头 + 原文）→ 收尾提示在最后；收件人是属主", async () => {
    await runTurnWithHealth({
      taskId: "t_fb_short",
      health: { finalizeOk: false },
      answer: "这是完整答案",
    });
    const texts = sentTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("飞书卡片没能同步，以下是完整回复");
    expect(texts[0]).toContain("这是完整答案");
    expect(texts[0]).not.toContain("共 "); // 单段不带「共 N 段」
    expect(texts[1]).toContain("完整回复已用文字版发在上面");
    expect(texts[1]).not.toContain("请回 Flowship 查看");
    expect(sendTextMessage.mock.calls.every((c) => c[0] === "ou_owner")).toBe(true);
  });

  it("长正文：按块保序补发（优先在换行处断、每块留足长度余量）→ 收尾提示最后；拼起来不丢字", async () => {
    const answer = Array.from({ length: 5 }, (_, i) => String(i).repeat(2_000)).join("\n");
    await runTurnWithHealth({ taskId: "t_fb_long", health: { finalizeOk: false }, answer });
    const texts = sentTexts();
    // 每行 2000 字、行间换行：窗口 3500 内最后一个换行在第 2000 位（≥ 半窗）→ 在换行处断开，一行一块 → 5 块；+ 收尾提示
    expect(texts).toHaveLength(6);
    expect(texts[0]).toContain("共 5 段");
    for (let i = 1; i < 5; i += 1) expect(texts[i]).toContain(`（${i + 1}/5）`);
    expect(texts[5]).toContain("完整回复已用文字版发在上面");
    for (const t of texts.slice(0, 5)) expect(t.length).toBeLessThan(3_700); // 正文 ≤3500 + 头
    const digits = texts.slice(0, 5).join("").replace(/\D/g, "");
    // 每种数字各 2000 个都在（头里的「5 段」「（2/5）」等数字会多出几个，所以只断言不少于）
    for (let d = 0; d < 5; d += 1) {
      expect(digits.split(String(d)).length - 1).toBeGreaterThanOrEqual(2_000);
    }
  });

  it("超长到块数封顶（8 块）：末块带「未在飞书发送」说明，不再刷屏", async () => {
    const answer = "字".repeat(3_500 * 8 + 500);
    await runTurnWithHealth({ taskId: "t_fb_cap", health: { finalizeOk: false }, answer });
    const texts = sentTexts();
    expect(texts).toHaveLength(9); // 8 块 + 收尾提示
    expect(texts[7]).toContain("完整回复请回 Flowship 查看");
    expect(texts[6]).not.toContain("未在飞书发送");
    expect(texts[8]).toContain("⚠️ 回复没能同步到飞书卡片");
  });

  it("正文里的 ![alt](img_key) 折成「[图片：alt]」（纯文本渲染不了图片）", async () => {
    await runTurnWithHealth({
      taskId: "t_fb_img",
      health: { finalizeOk: false },
      answer: "见图 ![架构图](img_v3_abc) 和 ![](img_v3_def) 结束",
    });
    const first = sentTexts()[0]!;
    expect(first).toContain("见图 [图片：架构图] 和 [图片] 结束");
    expect(first).not.toContain("img_v3_");
  });

  it("补发失败只 warn：停在失败的那一块（不发缺了中间的后续块）、不抛，收尾提示照发、app 内 info 照落", async () => {
    sendTextMessage.mockReset();
    sendTextMessage
      .mockResolvedValueOnce({ chat_id: "oc_x", message_id: "om_1" })
      .mockRejectedValueOnce(new Error("lark 又挂了"))
      .mockResolvedValue({ chat_id: "oc_x", message_id: "om_ping" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runTurnWithHealth({
        taskId: "t_fb_fail",
        health: { finalizeOk: false },
        answer: "字".repeat(3_500 * 3), // 3 块
      });
      const texts = sentTexts();
      // 第 1 块成功、第 2 块失败 → 第 3 块不发；再加收尾提示
      expect(texts).toHaveLength(3);
      expect(texts[0]).toContain("共 3 段");
      expect(texts[1]).toContain("（2/3）");
      // 只发出一部分：收尾文案不能说「完整回复已发」，沿用「请回 Flowship 查看」
      expect(texts[2]).toContain("⚠️ 回复没能同步到飞书卡片，请回 Flowship 查看");
      expect(texts[2]).not.toContain("完整回复已用文字版发");
      // 卡片没同步 1 条 + 文字版补发中途失败 1 条（带已发段数与原因）
      expect(infoTexts()).toHaveLength(2);
      expect(infoTexts()[1]).toContain("文字版补发中途失败");
      expect(infoTexts()[1]).toContain("1/3");
      expect(infoTexts()[1]).toContain("lark 又挂了");
      expect(warn.mock.calls.some((c) => String(c[0]).includes("终稿文字补发失败"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["终稿已落成（finalizeOk=true）", { finalizeOk: true }, true, "awaiting_user"],
    ["结果未知（finalizeOk=undefined、仅致命态未恢复）：卡片可能其实已到位，免得重复刷屏", { finalizeOk: undefined, fatalActive: true }, true, "awaiting_user"],
    ["失败轮（ok=false）：answerText 只是半截", { finalizeOk: false }, false, "awaiting_user"],
    ["用户自己停的（stopped）", { finalizeOk: false }, true, "idle"],
  ])("不补发：%s", async (_label, health, ok, runStatus) => {
    await runTurnWithHealth({
      taskId: `t_fb_skip_${Math.random().toString(36).slice(2, 6)}`,
      health,
      ok,
      runStatus,
      answer: "不该被文字补发的正文",
    });
    expect(sentTexts().some((t) => t.includes("以下是完整回复"))).toBe(false);
    expect(sentTexts().some((t) => t.includes("不该被文字补发的正文"))).toBe(false);
  });
});

describe("文字补发：成功 / 失败的如实收尾（文案 + app 内留痕 + 瞬时失败重发一次）", () => {
  const sentTexts = (): string[] =>
    (sendTextMessage.mock.calls as unknown as Array<[string, string]>).map((c) => c[1]);
  const rateLimited = (): InstanceType<typeof LarkApiError> =>
    new LarkApiError("rate limited", { code: 99991400 });

  beforeEach(() => {
    __setFallbackRetryDelayForTest(0);
    sendTextMessage.mockReset();
    sendTextMessage.mockResolvedValue({ chat_id: "oc_x", message_id: "om_x" });
  });

  it("补发全部成功：收尾说「完整回复已用文字版发在上面」，不再叫用户去 Flowship 看；不额外写补发失败 info", async () => {
    await runTurnWithHealth({ taskId: "t_fbx_ok", health: { finalizeOk: false }, answer: "完整答案" });
    expect(lastPing()).toContain("完整回复已用文字版发在上面");
    expect(lastPing()).not.toContain("请回 Flowship 查看");
    expect(infoTexts().some((t) => t.includes("文字版补发"))).toBe(false);
  });

  it("补发超长被块数封顶（尾部按设计没发）：收尾仍叫用户去 Flowship 看全文，不说「完整回复已发」；也不算补发失败", async () => {
    await runTurnWithHealth({
      taskId: "t_fbx_trunc",
      health: { finalizeOk: false },
      answer: "字".repeat(3_500 * 8 + 500),
    });
    expect(lastPing()).toContain("请回 Flowship 查看");
    expect(lastPing()).not.toContain("完整回复已用文字版发");
    expect(infoTexts().some((t) => t.includes("文字版补发"))).toBe(false);
  });

  it("第一块就发不出去（auth 这类不可重试的错）：不重试、app 内写「文字版补发也失败」（带原因）、收尾用原文案", async () => {
    sendTextMessage.mockReset();
    sendTextMessage
      .mockRejectedValueOnce(new LarkApiError("Access denied", { code: 99991672 }))
      .mockResolvedValue({ chat_id: "oc_x", message_id: "om_ping" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runTurnWithHealth({ taskId: "t_fbx_none", health: { finalizeOk: false }, answer: "答案" });
      // 补发 1 次（失败、不重试）+ 收尾提示
      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      expect(lastPing()).toContain("⚠️ 回复没能同步到飞书卡片，请回 Flowship 查看");
      const fbInfo = infoTexts().find((t) => t.includes("文字版补发也失败"));
      expect(fbInfo).toBeDefined();
      expect(fbInfo).toContain("Access denied");
      expect(fbInfo).toContain("请在 Flowship 查看");
    } finally {
      warn.mockRestore();
    }
  });

  it("限流 / 瞬时失败：同一块重发一次就成功 → 当作全部成功（收尾如实）；重发的是同一段内容", async () => {
    sendTextMessage.mockReset();
    sendTextMessage
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValue({ chat_id: "oc_x", message_id: "om_x" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runTurnWithHealth({ taskId: "t_fbx_retry_ok", health: { finalizeOk: false }, answer: "答案X" });
      const texts = sentTexts();
      expect(texts).toHaveLength(3); // 补发 ×2（第 1 次限流、第 2 次成功）+ 收尾
      expect(texts[0]).toBe(texts[1]);
      expect(texts[0]).toContain("答案X");
      expect(lastPing()).toContain("完整回复已用文字版发在上面");
      expect(infoTexts().some((t) => t.includes("文字版补发"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("重发一次仍失败：只重一次（不无限重试），按失败处理——app 内留痕 + 收尾原文案", async () => {
    sendTextMessage.mockReset();
    sendTextMessage
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValue({ chat_id: "oc_x", message_id: "om_ping" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runTurnWithHealth({ taskId: "t_fbx_retry_fail", health: { finalizeOk: false }, answer: "答案Y" });
      expect(sendTextMessage).toHaveBeenCalledTimes(3); // 补发 ×2 + 收尾
      expect(lastPing()).toContain("请回 Flowship 查看");
      expect(infoTexts().some((t) => t.includes("文字版补发也失败"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("lark-cli 超时不重发（分不清「没发出」和「回包丢了」，重发还会把黑洞拖长）", async () => {
    sendTextMessage.mockReset();
    sendTextMessage
      .mockRejectedValueOnce(new LarkApiError("lark-cli 超时（30000ms）", { api: "im +messages-send" }))
      .mockResolvedValue({ chat_id: "oc_x", message_id: "om_ping" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runTurnWithHealth({ taskId: "t_fbx_timeout", health: { finalizeOk: false }, answer: "答案Z" });
      expect(sendTextMessage).toHaveBeenCalledTimes(2); // 补发 1 次（超时、不重发）+ 收尾
      expect(infoTexts().some((t) => t.includes("文字版补发也失败"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("transient（断网 / 连接重置：请求可能已被受理、只是回包丢了）不重发——重发会让用户收到重复正文；按补发失败处理", async () => {
    const transient = new Error("socket hang up (ECONNRESET)");
    expect(classifyLarkFailure(transient)).toBe("transient"); // 前提：这类错误确实归 transient
    sendTextMessage.mockReset();
    sendTextMessage
      .mockRejectedValueOnce(transient)
      .mockResolvedValue({ chat_id: "oc_x", message_id: "om_ping" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runTurnWithHealth({ taskId: "t_fbx_transient", health: { finalizeOk: false }, answer: "答案T" });
      // 补发 1 次（transient、不重发）+ 收尾 = 2；若重发就是 3
      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      expect(sentTexts().filter((t) => t.includes("答案T"))).toHaveLength(1);
      expect(infoTexts().some((t) => t.includes("文字版补发也失败"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("本轮没有可补发的正文（空答案）：不算补发失败，不写补发失败 info", async () => {
    await runTurnWithHealth({ taskId: "t_fbx_empty", health: { finalizeOk: false }, answer: "  " });
    expect(infoTexts().some((t) => t.includes("文字版补发"))).toBe(false);
  });

  it("写补发失败 info 自己失败：只 warn、不抛、收尾提示照发", async () => {
    sendTextMessage.mockReset();
    sendTextMessage
      .mockRejectedValueOnce(new Error("lark 挂了"))
      .mockResolvedValue({ chat_id: "oc_x", message_id: "om_ping" });
    // 第 1 次 info（卡片没同步）正常，第 2 次（补发失败）写盘失败
    writeEventAndPublish
      .mockResolvedValueOnce({ id: "ev_ok", kind: "info", text: "", createdAt: 0, taskId: "t_fbx_info_fail" })
      .mockRejectedValueOnce(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runTurnWithHealth({ taskId: "t_fbx_info_fail", health: { finalizeOk: false }, answer: "答案W" });
      expect(lastPing()).toContain("请回 Flowship 查看");
      expect(warn.mock.calls.some((c) => String(c[0]).includes("写补发失败 info 失败"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("finalizeTurn 总预算：黑洞时不把补发 / 追发每段都等满（占着全局单飞队列）", () => {
  const sentTexts = (): string[] =>
    (sendTextMessage.mock.calls as unknown as Array<[string, string]>).map((c) => c[1]);
  const OK = { chat_id: "oc_x", message_id: "om_x" };
  /**
   * 每次发送「耗掉」若干毫秒。预算用单调时钟（performance.now），所以只伪造 performance
   * （定时器照常，flush 的 setTimeout 才能走）；vi.advanceTimersByTime 推进伪造的单调时钟。
   */
  const sendConsuming = (ms: number) =>
    sendTextMessage.mockImplementation(async () => {
      vi.advanceTimersByTime(ms);
      return OK;
    });
  const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  beforeEach(() => {
    __setFallbackRetryDelayForTest(0);
    sendTextMessage.mockReset();
    vi.useFakeTimers({ toFake: ["performance"] });
  });

  it("补发到一半预算用尽：不再发后续块（停在已发的），app 内写「中途失败、只发出前 N/M 段」，完成追发也放弃并 warn", async () => {
    __setFinalizeBudgetForTest(8_000);
    sendConsuming(9_000); // 第 1 块发完预算就没了
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const answer = Array.from({ length: 3 }, (_, i) => String(i).repeat(2_000)).join("\n");
      await runTurnWithHealth({ taskId: "t_budget_mid", health: { finalizeOk: false }, answer });
      expect(sendTextMessage).toHaveBeenCalledTimes(1); // 只发了第 1 块；第 2、3 块与收尾追发都没发
      expect(sentTexts()[0]).toContain("共 3 段");
      expect(infoTexts().some((t) => t.includes("中途失败") && t.includes("前 1/3 段"))).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("完成追发失败"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("补发已全部发完、但预算也用尽：收尾追发放弃（warn），不再占队列", async () => {
    __setFinalizeBudgetForTest(8_000);
    sendConsuming(9_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runTurnWithHealth({ taskId: "t_budget_ping", health: { finalizeOk: false }, answer: "短答案" });
      expect(sendTextMessage).toHaveBeenCalledTimes(1); // 只有补发这一条
      expect(String(sendTextMessage.mock.calls[0]?.[1])).toContain("短答案");
      expect(warn.mock.calls.some((c) => String(c[0]).includes("完成追发失败"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("剩余预算不足默认 30s 超时：单次发送的超时被压到剩余值（不让最后一发把总预算拖爆）；预算充裕时不传第三参（行为同旧）", async () => {
    sendTextMessage.mockResolvedValue(OK);
    // 充裕（默认 60s）：只有 (openId, text) 两个参数
    await runTurnWithHealth({ taskId: "t_budget_plenty", health: { finalizeOk: false }, answer: "答案" });
    expect(sendTextMessage.mock.calls.length).toBeGreaterThan(0);
    for (const c of sendTextMessage.mock.calls) expect(c).toHaveLength(2);

    sendTextMessage.mockClear();
    __setFinalizeBudgetForTest(10_000);
    await runTurnWithHealth({ taskId: "t_budget_tight", health: { finalizeOk: false }, answer: "答案" });
    const first = sendTextMessage.mock.calls[0] as unknown as [string, string, { timeoutMs: number }];
    expect(first[2].timeoutMs).toBeLessThanOrEqual(10_000);
    expect(first[2].timeoutMs).toBeGreaterThanOrEqual(3_000);
    // 单调时钟算出的剩余是小数；execFile 的 timeout 必须是整数（小数会抛 ERR_OUT_OF_RANGE，让补发整条失败）
    expect(Number.isInteger(first[2].timeoutMs)).toBe(true);
  });

  it("单次超时一定是整数：单调时钟算出的剩余是小数（前一发耗掉 1234.567ms），传给 lark 的 timeoutMs 必须取整（小数会让 execFile 抛 ERR_OUT_OF_RANGE、补发整条失败）", async () => {
    __setFinalizeBudgetForTest(20_000);
    sendConsuming(1234.567);
    const answer = Array.from({ length: 3 }, (_, i) => String(i).repeat(2_000)).join("\n");
    await runTurnWithHealth({ taskId: "t_budget_fraction", health: { finalizeOk: false }, answer });
    const calls = sendTextMessage.mock.calls as unknown as Array<[string, string, { timeoutMs?: number }?]>;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const withTimeout = calls.filter((c) => c[2] !== undefined);
    expect(withTimeout.length).toBeGreaterThanOrEqual(2); // 剩余都 < 30s，每发都带压缩后的超时
    for (const c of withTimeout) expect(Number.isInteger(c[2]?.timeoutMs)).toBe(true);
  });

  it("预算充裕（默认 60s）：多块补发 + 收尾追发照常全发（预算不误伤正常路径）", async () => {
    sendTextMessage.mockResolvedValue(OK);
    const answer = Array.from({ length: 3 }, (_, i) => String(i).repeat(2_000)).join("\n");
    await runTurnWithHealth({ taskId: "t_budget_ok", health: { finalizeOk: false }, answer });
    expect(sendTextMessage).toHaveBeenCalledTimes(4); // 3 块 + 收尾
  });

  it("单调时钟：墙钟（Date.now）整段向前跳一小时（休眠唤醒 / 校时）不会让预算「瞬间耗尽」而跳过补发 / 追发", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"] }); // 只伪造墙钟；performance 保持真实
    sendTextMessage.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 3_600_000); // 每次发送期间墙钟跳 1 小时
      return OK;
    });
    const answer = Array.from({ length: 3 }, (_, i) => String(i).repeat(2_000)).join("\n");
    await runTurnWithHealth({ taskId: "t_budget_wallclock", health: { finalizeOk: false }, answer });
    expect(sendTextMessage).toHaveBeenCalledTimes(4); // 3 块 + 收尾追发都发了（旧 Date.now 逻辑下第 2 块起就被拒）
  });

  it("发送永不返回（队列排队 / 内部重试都算在内）：到预算就不再等，补发按失败收尾，finalizeTurn 不被拖死", async () => {
    vi.useRealTimers();
    __setFinalizeBudgetForTest(300, 50); // 300ms 预算、最小剩余门槛压到 50ms，让单测在真实时间里快速到点
    sendTextMessage.mockImplementation(() => new Promise<never>(() => undefined));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runTurnWithHealth({ taskId: "t_budget_hang", health: { finalizeOk: false }, answer: "短答案" });
      await sleepReal(800); // > 预算
      expect(sendTextMessage).toHaveBeenCalledTimes(1); // 只尝试了补发这一条，卡住后没有再发追发
      expect(infoTexts().some((t) => t.includes("预算") || t.includes("补发"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("getBotAppInfo 永不返回：同样受预算约束（不无限等），补发 / 追发都放弃、一条也没发", async () => {
    vi.useRealTimers();
    __setFinalizeBudgetForTest(300, 50);
    getBotAppInfo.mockImplementationOnce(() => new Promise<never>(() => undefined));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runTurnWithHealth({ taskId: "t_budget_info_hang", health: { finalizeOk: false }, answer: "短答案" });
      await sleepReal(800);
      expect(sendTextMessage).not.toHaveBeenCalled();
      expect(infoTexts().some((t) => t.includes("预算") || t.includes("补发"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
