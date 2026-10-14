/**
 * 群桥接 × task 待送达队列（injectGroupMessage 的 queueIfBusy / 202 分支）
 *
 * 场景（2026-10-14 真实案例：对接后端机器人时回执在 agent 正在跑时被 409 丢掉）：
 * - 属主本人的话：忽略「主链在跑」的群侧忙线闸、带 queueIfBusy 注入；202 queued 后回一句「这轮跑完就处理」、摘登记
 * - 托办回执（喂会话）：同样入队，但静默（回执本来就不回群）、关联登记入队时 burn
 * - chat 模式 202：行为原样（摘登记 + 「排队处理中」回执）
 *
 * 全 mock 外部调用——禁止真调飞书。mock 风格同 feishu-group-inbound.test.ts。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-route-talk-queue-${Date.now()}`,
  "data",
);

const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  GROUP_RESTRICTED_QUESTION_RUNNING,
  GROUP_TASK_RUNNING,
  routeGroupInboundMessage,
} = await import("@/lib/server/feishu-bridge/group-route");
const {
  __resetGroupAdvancePickForTest,
  __resetGroupReplyStateForTest,
  __resetThrottleForTest,
  listGroupReplies,
} = await import("@/lib/server/feishu-bridge/group-shared");
const {
  __resetOutboundRegistryForTest,
  matchCorrelatedAnswer,
  registerOutboundQuestion,
} = await import("@/lib/server/feishu-bridge/group-outbound-registry");
const {
  agentSessions,
  registerRestrictedQuestion,
  unregisterRestrictedQuestion,
} = await import("@/lib/server/task-stream");

const OWNER = "ou_owner";
const BOT = "ou_bot";
const CHAT = "oc_req_group";
const BACKEND_BOT = "ou_backendbot";

const groupMsg = (
  overrides: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: "om_g1",
  create_time: String(Date.now()),
  chat_id: CHAT,
  chat_type: "group",
  message_type: "text",
  sender_id: OWNER,
  sender_name: "张三",
  content: "@Flowship 再补一个字段",
  mentions: [{ key: "@_user_1", openId: BOT, name: "Flowship" }],
  ...overrides,
});

const taskSummary = (over: Partial<TaskSummary> = {}): TaskSummary =>
  ({
    id: "task-1",
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    updatedAt: Date.now(),
    createdAt: Date.now(),
    repoPaths: ["/tmp/repo"],
    currentActionId: null,
    mrs: [],
    actionCount: 0,
    feishuStoryUrl: "https://project.feishu.cn/space/story/detail/10001",
    ...over,
  }) as TaskSummary;

const fullTask = (over: Partial<Task> = {}): Task =>
  ({ ...taskSummary(), actions: [], events: [], ...over }) as unknown as Task;

const callArgs = (fn: unknown, i = 0): unknown[] =>
  ((fn as { mock: { calls: unknown[][] } }).mock.calls as unknown[][])[i] ?? [];

const ctx = {
  parseContent: async (m: FeishuInboundMessage) => ({
    text: m.content,
    images: [],
    attachments: [],
  }),
  loadBootContext: async () => ({ apiKey: "sk-test", model: { id: "m1" } }),
};

const jsonRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status });

const queuedRes = () =>
  jsonRes({ ok: true, queued: true, itemId: "tq_1", position: 1 }, 202);

const baseDeps = (over: Record<string, unknown> = {}) => ({
  getBotAppInfo: async () => ({ appId: "cli_self", ownerOpenId: OWNER }),
  getBotOpenId: async () => BOT,
  getBotDisplayName: async () => "Flowship",
  sendTextToChat: vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" })),
  sendCardToChat: vi.fn(async () => ({
    chat_id: CHAT,
    message_id: "om_card",
    card_id: "c1",
  })),
  listTasks: async () => [taskSummary({ runStatus: "running" })],
  getTask: async () => fullTask({ runStatus: "running" }),
  getBoundGroupChatId: async () => CHAT,
  listAdvanceOptions: vi.fn(async () => []),
  getPendingAsk: () => null,
  injectPendingAskText: vi.fn(async () => ({ ok: true as const })),
  handleChatReplyInject: vi.fn(async () => jsonRes({ ok: true }, 200)),
  handleTaskQuestionInject: vi.fn(async () => queuedRes()),
  advanceTask: vi.fn(async () => ({ action: { id: "act-1" } })),
  isAdvanceResultToGroupEnabled: async () => true,
  ...over,
});

const injectOptsOf = (fn: unknown, i = 0): Record<string, unknown> =>
  (callArgs(fn, i)[2] ?? {}) as Record<string, unknown>;

const sentTexts = (fn: unknown): string[] =>
  ((fn as { mock: { calls: unknown[][] } }).mock.calls as unknown[][]).map((c) =>
    String(c[1]),
  );

beforeEach(() => {
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
  __resetGroupAdvancePickForTest();
  __resetThrottleForTest();
});

afterEach(() => {
  __setGroupRouteDepsForTest(null);
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
  __resetGroupAdvancePickForTest();
  __resetOutboundRegistryForTest();
  agentSessions.delete("task-1");
});

describe("属主本人的群消息 × task 待送达队列", () => {
  it("主链在跑 → 不被群侧忙线闸拒收，带 queueIfBusy 注入；202 queued 后回一句、摘登记", async () => {
    const handleTaskQuestionInject = vi.fn(async () => queuedRes());
    const sendTextToChat = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_r",
    }));
    __setGroupRouteDepsForTest(
      baseDeps({ handleTaskQuestionInject, sendTextToChat }) as never,
    );

    const r = await routeGroupInboundMessage(groupMsg(), ctx);

    expect(r).toMatchObject({ kind: "queued", taskId: "task-1" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(injectOptsOf(handleTaskQuestionInject).queueIfBusy).toEqual({
      source: "group_owner",
      senderName: "张三",
      senderIsBot: undefined,
      preview: "再补一个字段",
    });
    // 属主语义不变：不是只答疑
    expect(injectOptsOf(handleTaskQuestionInject)).toMatchObject({
      restrictToQuestion: false,
    });
    // 群里只回一句「这轮跑完就处理」，没有「任务正在跑」的拒信
    expect(sentTexts(sendTextToChat)).toHaveLength(1);
    expect(sentTexts(sendTextToChat)[0]).toContain("收到，当前这轮跑完就处理");
    expect(sentTexts(sendTextToChat)[0]).not.toContain(GROUP_TASK_RUNNING);
    // 没有 run 开跑 → 回群登记必须摘掉，否则会被下一轮无关的 done 收走
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("预览是正文前 120 字（压空白）", async () => {
    const handleTaskQuestionInject = vi.fn(async () => queuedRes());
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);
    const longText = `第一行\n第二行 ${"字".repeat(200)}`;

    await routeGroupInboundMessage(groupMsg({ content: longText }), ctx);

    const preview = (
      injectOptsOf(handleTaskQuestionInject).queueIfBusy as { preview: string }
    ).preview;
    expect(preview.startsWith("第一行 第二行 ")).toBe(true);
    expect(preview).toHaveLength(120);
  });

  it("排队已满（注入回 409）→ 走原失败路径：回群错误文案、摘登记、不当 queued", async () => {
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ error: "排队已满（最多 10 条），等当前这轮跑完再发" }, 409),
    );
    const sendTextToChat = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_r",
    }));
    __setGroupRouteDepsForTest(
      baseDeps({ handleTaskQuestionInject, sendTextToChat }) as never,
    );

    const r = await routeGroupInboundMessage(groupMsg(), ctx);

    expect(r).toMatchObject({ kind: "failed", taskId: "task-1" });
    expect(sentTexts(sendTextToChat)[0]).toContain("排队已满");
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("旁路答疑在飞时属主仍按原口径被群侧串行闸拒收（只豁免主链在跑）", async () => {
    const handleTaskQuestionInject = vi.fn(async () => queuedRes());
    const sendTextToChat = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_r",
    }));
    __setGroupRouteDepsForTest(
      baseDeps({
        handleTaskQuestionInject,
        sendTextToChat,
        getTask: async () => fullTask({ runStatus: "idle" }),
        listTasks: async () => [taskSummary({ runStatus: "idle" })],
      }) as never,
    );
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion("task-1", inFlight);
    try {
      const r = await routeGroupInboundMessage(groupMsg(), ctx);
      expect(r).toMatchObject({
        kind: "skipped",
        error: GROUP_RESTRICTED_QUESTION_RUNNING,
      });
      expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    } finally {
      unregisterRestrictedQuestion("task-1", inFlight);
    }
  });

  it("非属主的只读答疑旁路不传 queueIfBusy（走群模块自己的队列）", async () => {
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    __setGroupRouteDepsForTest(
      baseDeps({
        handleTaskQuestionInject,
        // 空闲：不触发群侧排队，直接注入
        getTask: async () => fullTask({ runStatus: "idle" }),
        listTasks: async () => [taskSummary({ runStatus: "idle" })],
      }) as never,
    );

    await routeGroupInboundMessage(
      groupMsg({ sender_id: "ou_colleague", sender_name: "李四" }),
      ctx,
    );

    expect(injectOptsOf(handleTaskQuestionInject)).toMatchObject({
      restrictToQuestion: true,
    });
    expect(injectOptsOf(handleTaskQuestionInject)).not.toHaveProperty(
      "queueIfBusy",
    );
  });
});

describe("托办回执（喂回会话）× task 待送达队列", () => {
  const registerBackendQuestion = () => {
    const reg = registerOutboundQuestion({
      taskId: "task-1",
      chatId: CHAT,
      messageId: "om_q1",
      target: BACKEND_BOT,
      keywords: ["接口"],
    });
    expect(reg.ok).toBe(true);
  };
  const receiptFromBot = (over: Partial<FeishuInboundMessage> = {}) =>
    groupMsg({
      message_id: "om_receipt",
      sender_id: BACKEND_BOT,
      sender_name: "后端机器人",
      sender_type: "app",
      content: "@Flowship 接口已上线，字段 foo",
      ...over,
    });
  const stillRegistered = () =>
    matchCorrelatedAnswer({
      taskId: "task-1",
      chatId: CHAT,
      senderIds: [BACKEND_BOT],
      text: "接口已上线",
    }) !== null;

  it("入队静默（不回群、不留回群登记）、关联登记入队即 burn、source=group_reply", async () => {
    registerBackendQuestion();
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () => queuedRes());
    const sendTextToChat = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_r",
    }));
    __setGroupRouteDepsForTest(
      baseDeps({ handleTaskQuestionInject, sendTextToChat }) as never,
    );

    const r = await routeGroupInboundMessage(receiptFromBot(), ctx);

    expect(r).toMatchObject({ kind: "queued", taskId: "task-1" });
    expect(injectOptsOf(handleTaskQuestionInject)).toMatchObject({
      restrictToQuestion: false,
      correlatedAnswer: true,
      queueIfBusy: {
        source: "group_reply",
        senderName: "后端机器人",
        senderIsBot: true,
      },
    });
    // 回执本来就不回群：一句话都不发
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(listGroupReplies("task-1")).toHaveLength(0);
    // 文本已进队列：一问一答关联在入队时就烧掉，复读不会二次消费
    expect(stillRegistered()).toBe(false);
  });

  it("注入直接成功（200）时仍照旧 burn、也带 queueIfBusy（空闲 / 已送达不受影响）", async () => {
    registerBackendQuestion();
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);

    const r = await routeGroupInboundMessage(receiptFromBot(), ctx);

    expect(r).toMatchObject({ kind: "sent", taskId: "task-1" });
    expect(injectOptsOf(handleTaskQuestionInject)).toHaveProperty("queueIfBusy");
    expect(stillRegistered()).toBe(false);
  });

  it("没有 queued 标记的 task 202（旧口径）不 burn、走原防御回执", async () => {
    registerBackendQuestion();
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 202),
    );
    const sendTextToChat = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_r",
    }));
    __setGroupRouteDepsForTest(
      baseDeps({ handleTaskQuestionInject, sendTextToChat }) as never,
    );

    // 发件人是人（桃子哥）才会有回执文案；机器人发件人的系统回执本就静默
    const r = await routeGroupInboundMessage(
      receiptFromBot({
        sender_id: BACKEND_BOT,
        sender_name: "桃子哥",
        sender_type: "user",
      }),
      ctx,
    );

    expect(r).toMatchObject({ kind: "queued" });
    expect(sentTexts(sendTextToChat)[0]).toContain("排队处理中");
    expect(stillRegistered()).toBe(true);
  });
});

describe("chat 模式 202 行为不变", () => {
  it("chat-inject 202 → 摘登记 + 「排队处理中」回执（不走 task 队列文案、不传 queueIfBusy）", async () => {
    const handleChatReplyInject = vi.fn(async () => jsonRes({ ok: true }, 202));
    const handleTaskQuestionInject = vi.fn(async () => queuedRes());
    const sendTextToChat = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_r",
    }));
    __setGroupRouteDepsForTest(
      baseDeps({
        getTask: async () => fullTask({ mode: "chat" }),
        handleChatReplyInject,
        handleTaskQuestionInject,
        sendTextToChat,
      }) as never,
    );

    const r = await routeGroupInboundMessage(groupMsg(), ctx);

    expect(r).toMatchObject({ kind: "queued", taskId: "task-1" });
    expect(handleChatReplyInject).toHaveBeenCalledTimes(1);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(injectOptsOf(handleChatReplyInject)).not.toHaveProperty(
      "queueIfBusy",
    );
    expect(sentTexts(sendTextToChat)).toEqual([
      expect.stringContaining("收到，排队处理中、结果去 Flowship 看"),
    ]);
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("chat 模式回的 body 即便带 queued:true 也只认 chat 文案（task 分支不抢）", async () => {
    const handleChatReplyInject = vi.fn(async () => queuedRes());
    const sendTextToChat = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_r",
    }));
    __setGroupRouteDepsForTest(
      baseDeps({
        getTask: async () => fullTask({ mode: "chat" }),
        handleChatReplyInject,
        sendTextToChat,
      }) as never,
    );

    await routeGroupInboundMessage(groupMsg(), ctx);

    expect(sentTexts(sendTextToChat)[0]).toContain("排队处理中");
    expect(sentTexts(sendTextToChat)[0]).not.toContain("这轮跑完就处理");
  });
});
