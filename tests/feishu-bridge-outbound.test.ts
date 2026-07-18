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

vi.mock("@/lib/server/task-fs", () => ({
  getTask,
}));

vi.mock("@/lib/server/feishu-bridge/bridge-config", () => ({
  isFeishuChatBridgeEnabled: vi.fn(async () => true),
  getDeepLink: (taskId: string) => `flowship://tasks/${taskId}`,
  getBridgeDataDir: async () => "/tmp/feishu-bridge-test",
  isBridgeTestInstance: () => true,
  isFeishuBridgeKeepAwakeEnabled: async () => true,
}));

type CardMock = {
  start: ReturnType<typeof vi.fn>;
  pushProcess: ReturnType<typeof vi.fn>;
  pushAnswer: ReturnType<typeof vi.fn>;
  setHeaderStatus: ReturnType<typeof vi.fn>;
  appendAskUser: ReturnType<typeof vi.fn>;
  appendRetryButton: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  getFailCount: () => number;
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

const {
  ensureFeishuOutboundRegistered,
  __resetFeishuOutboundForTest,
  __setCreateCardStreamForTest,
  __setUploadImageForTest,
  __setBridgeEnabledForTest,
  handleFeishuOutboundEvent,
  formatElapsed,
  replaceLocalImagesInMarkdown,
} = await import("@/lib/server/feishu-bridge/outbound");

const { publishTaskStreamEvent } = await import("@/lib/server/task-stream");

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
  uploadImage.mockClear();
  __setCreateCardStreamForTest(
    cardFactory.create as unknown as Parameters<
      typeof __setCreateCardStreamForTest
    >[0],
  );
  __setUploadImageForTest(uploadImage);
  __setBridgeEnabledForTest(true);
  ensureFeishuOutboundRegistered();
});

afterEach(() => {
  __resetFeishuOutboundForTest();
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
    expect(processText).toContain("🧠 分析需求");

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
    expect(process2).toContain("🔧 Shell：");
    expect(card.setHeaderStatus).toHaveBeenCalled();
    const header = String(card.setHeaderStatus.mock.calls.at(-1)?.[0] ?? "");
    expect(header).toContain("执行工具(1)");
    expect(header).toContain("Shell");
    expect(header).toContain("已运行");

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
    expect(process3).toContain("✓");

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
});
