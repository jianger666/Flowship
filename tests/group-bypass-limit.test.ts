/**
 * G3-02：每个发送人最多占 2 个排队槽（超出走原「满了」口径：真人收忙线文案、机器人静默）；总队长上限 10 照旧。
 *
 * 2026-11-06：原来的「② 非属主旁路 run 的 10 分钟滑动窗限流（总 12 次 / 每人 4 次）」已按用户决定整套删除
 *（「什么熔断机制都可以去掉」——互 @ 的防护交给提示词与「对机器人静默」），对应用例（admitGroupBypassRun /
 * releaseGroupBypassRun / 滑动窗状态 / 限流 info）随之删除；本文件只留排队槽位与发送人 key 口径。
 *
 * 路由级用例走真实 routeGroupInboundMessage / pump，只 mock 最外层的注入与发群消息。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

// 旁路限流的 info 事件走真实落盘太重——mock 掉写入口，只断言写了什么
const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn(async () => ({ id: "ev_mock" })),
);
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeOwnedEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-bypass-limit-${Date.now()}`,
  "data",
);

const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  routeGroupInboundMessage,
} = await import("@/lib/server/feishu-bridge/group-route");
// 这份文件的用例都钉在「机器人发件人一律被准入闸拒绝」的口径上（P0 硬化）。2026-11-04 起设置「受理群里其他机器人的 @」
// 默认开，所以这里显式把它钉回关——只改 setup、断言一字未动；放开后的语义见 tests/group-bots-allowed.test.ts。
const { __setGroupBotsAllowedForTest } = await import(
  "@/lib/server/group-non-owner-guard-config"
);
const shared = await import("@/lib/server/feishu-bridge/group-shared");
const { __resetGroupRosterForTest } = await import(
  "@/lib/server/feishu-bridge/group-roster"
);
const { registerRestrictedQuestion, unregisterRestrictedQuestion } = await import(
  "@/lib/server/task-stream"
);

const OWNER = "ou_owner";
const BOT = "ou_bot";
const CHAT = "oc_req_group";
const TASK = "task-1";

const taskSummary = (): TaskSummary =>
  ({
    id: TASK,
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
  }) as TaskSummary;
const fullTask = (): Task =>
  ({ ...taskSummary(), actions: [], events: [] }) as unknown as Task;

const msg = (
  sender: string,
  id: string,
  over: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: id,
  create_time: String(Date.now()),
  chat_id: CHAT,
  chat_type: "group",
  message_type: "text",
  sender_id: sender,
  sender_name: sender,
  content: "@Flowship 埋点查了吗",
  mentions: [{ key: "@_user_1", openId: BOT, name: "Flowship" }],
  ...over,
});

const ctx = {
  parseContent: async (m: FeishuInboundMessage) => ({
    text: m.content,
    images: [],
    attachments: [],
  }),
  loadBootContext: async () => ({ apiKey: "sk-test", model: { id: "m1" } }),
};

let handleTaskQuestionInject: ReturnType<typeof vi.fn>;
let injectPendingAskText: ReturnType<typeof vi.fn>;
let sendTextToChat: ReturnType<typeof vi.fn>;

const installDeps = (over: Record<string, unknown> = {}) =>
  __setGroupRouteDepsForTest({
    getBotAppInfo: async () => ({ appId: "cli_self", ownerOpenId: OWNER }),
    getBotOpenId: async () => BOT,
    getBotDisplayName: async () => "Flowship",
    fetchGroupRoster: vi.fn(async (chatId: string) => ({
      chatId,
      members: [],
      fetchedAt: Date.now(),
      source: "none" as const,
    })),
    sendTextToChat,
    listTasks: async () => [taskSummary()],
    getTask: async () => fullTask(),
    getBoundGroupChatId: async () => CHAT,
    getPendingAsk: () => null,
    injectPendingAskText,
    handleTaskQuestionInject,
    ...over,
  } as never);

beforeEach(() => {
  __setGroupBotsAllowedForTest(false);
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  shared.__resetGroupReplyStateForTest();
  writeOwnedEventAndPublish.mockClear();
  handleTaskQuestionInject = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  injectPendingAskText = vi.fn(async () => ({ ok: true as const }));
  sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
  installDeps();
});

afterEach(() => {
  vi.useRealTimers();
  __setGroupRouteDepsForTest(null);
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  shared.__resetGroupReplyStateForTest();
});

const sentTexts = (): string[] =>
  sendTextToChat.mock.calls.map((c) => String((c as unknown[])[1]));

describe("G3-02 ①：每个发送人最多占 2 个排队槽", () => {
  const withBusy = async (fn: () => Promise<void>) => {
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(TASK, inFlight);
    try {
      await fn();
    } finally {
      unregisterRestrictedQuestion(TASK, inFlight);
    }
  };

  it("同一人第 3 个排队问题被拒（走忙线口径），别人仍可排", async () => {
    await withBusy(async () => {
      expect(
        await routeGroupInboundMessage(msg("ou_li", "om_1"), ctx),
      ).toMatchObject({ kind: "queued" });
      expect(
        await routeGroupInboundMessage(msg("ou_li", "om_2"), ctx),
      ).toMatchObject({ kind: "queued" });
      const third = await routeGroupInboundMessage(msg("ou_li", "om_3"), ctx);
      expect(third).toMatchObject({ kind: "skipped" });
      expect(shared.groupQuestionQueueLength(TASK)).toBe(2);
      // 真人超槽位：收到忙线文案（与「队满」同口径）
      expect(sentTexts().some((t) => t.includes("群答疑还在跑"))).toBe(true);
      // 别人不受影响
      expect(
        await routeGroupInboundMessage(msg("ou_wang", "om_4"), ctx),
      ).toMatchObject({ kind: "queued" });
      expect(shared.groupQuestionQueueLength(TASK)).toBe(3);
    });
  });

  it("总队长上限 10 照旧：10 个不同发送人排满后第 11 个落回忙线拒收（原『队满』口径）", async () => {
    // feishu-group-inbound 里同名用例是单一发送人连发 10 条——有了发送人槽位后要换人发
    await withBusy(async () => {
      for (let i = 0; i < 10; i++) {
        expect(
          await routeGroupInboundMessage(msg(`ou_s${i}`, `om_f${i}`), ctx),
        ).toMatchObject({ kind: "queued" });
      }
      expect(shared.groupQuestionQueueLength(TASK)).toBe(10);
      const overflow = await routeGroupInboundMessage(msg("ou_s10", "om_over"), ctx);
      expect(overflow).toMatchObject({ kind: "skipped" });
      expect(sentTexts().some((t) => t.includes("群答疑还在跑"))).toBe(true);
      expect(shared.groupQuestionQueueLength(TASK)).toBe(10);
      expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    });
  });

  it("机器人发件人在旁路忙线时也不占排队槽位：准入闸先于忙线 / 排队，整条静默（P0 硬化新语义，原「超槽位照常拒绝」）", async () => {
    await withBusy(async () => {
      const bot = (id: string) =>
        msg("ou_otherbot", id, { sender_type: "app" } as never);
      sendTextToChat.mockClear();
      for (const id of ["om_b1", "om_b2", "om_b3"]) {
        expect(await routeGroupInboundMessage(bot(id), ctx)).toMatchObject({
          kind: "skipped",
          error: "群答疑未放行（已静默忽略）",
        });
      }
      expect(sendTextToChat).not.toHaveBeenCalled();
      expect(shared.groupQuestionQueueLength(TASK)).toBe(0);
    });
  });
});

describe("G3-02 纯函数层", () => {
  const entry = (id: string, openId = "ou_li") => ({
    messageId: id,
    chatId: CHAT,
    text: `问题 ${id}`,
    parsed: { text: "q", images: [], attachments: [] } as never,
    requester: { openId, name: openId },
    boot: null,
  });
  const cap = { maxPerSender: shared.GROUP_QUESTION_QUEUE_MAX_PER_SENDER };

  it("常量口径：每人 2 个槽 / 总队长 10；限流常量已删除（不再导出）", () => {
    expect(shared.GROUP_QUESTION_QUEUE_MAX_PER_SENDER).toBe(2);
    expect(shared.GROUP_QUESTION_QUEUE_MAX).toBe(10);
    const exported = shared as unknown as Record<string, unknown>;
    for (const gone of [
      "GROUP_BYPASS_RUN_WINDOW_MS",
      "GROUP_BYPASS_RUN_WINDOW_MAX",
      "GROUP_BYPASS_RUN_WINDOW_MAX_PER_SENDER",
      "admitGroupBypassRun",
      "releaseGroupBypassRun",
      "claimGroupBypassDropHint",
      "peekGroupBypassDropHint",
    ]) {
      expect(exported[gone], gone).toBeUndefined();
    }
  });

  it("发送人槽位：第 3 个 queued:false/sender_limit；重投已在队的 id 仍幂等；出队后腾出槽位", () => {
    expect(shared.enqueueGroupQuestion(TASK, entry("a1"), Date.now(), cap).queued).toBe(true);
    expect(shared.enqueueGroupQuestion(TASK, entry("a2"), Date.now(), cap).queued).toBe(true);
    const over = shared.enqueueGroupQuestion(TASK, entry("a3"), Date.now(), cap);
    expect(over).toMatchObject({ queued: false, reason: "sender_limit" });
    // 在槽位满时重投 a1：幂等、不被当成超限
    expect(shared.enqueueGroupQuestion(TASK, entry("a1"), Date.now(), cap)).toMatchObject({
      queued: true,
      position: 1,
    });
    // 出队一个 → 腾出槽位
    shared.shiftGroupQuestionQueue(TASK);
    expect(shared.enqueueGroupQuestion(TASK, entry("a3"), Date.now(), cap).queued).toBe(true);
  });

  it("过期条目不占槽位（先清过期再数）", () => {
    const old = 1_000_000;
    shared.enqueueGroupQuestion(TASK, entry("a1"), old, cap);
    shared.enqueueGroupQuestion(TASK, entry("a2"), old, cap);
    const later = old + shared.GROUP_QUESTION_QUEUE_TTL_MS + 1;
    expect(shared.enqueueGroupQuestion(TASK, entry("a3"), later, cap).queued).toBe(true);
  });

  it("不传 maxPerSender 时不限发送人（纯队列函数的原行为不变）", () => {
    for (let i = 0; i < shared.GROUP_QUESTION_QUEUE_MAX; i++) {
      expect(shared.enqueueGroupQuestion(TASK, entry(`m${i}`)).queued).toBe(true);
    }
  });

  it("groupBypassSenderKey：open_id → 其余稳定 ID 格（bot open_id / app_id）→ 展示名（带 name: 前缀，K2-09）", () => {
    const key = shared.groupBypassSenderKey;
    expect(key({ openId: "ou_a", name: "甲" }, ["ou_a", "ou_b", "cli_c"])).toBe("ou_a");
    expect(key({ openId: "", name: "机器人甲" }, [undefined, "", "cli_c"])).toBe("cli_c");
    expect(key({ openId: "", name: "机器人甲" }, ["", "ou_botopen", "cli_c"])).toBe(
      "ou_botopen",
    );
    expect(key({ openId: "", name: "机器人甲" })).toBe("name:机器人甲");
    expect(key({ openId: "", name: "机器人甲" }, [undefined, undefined])).toBe("name:机器人甲");
  });

});
