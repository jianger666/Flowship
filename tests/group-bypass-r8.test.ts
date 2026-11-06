/**
 * 第八轮 L3-01 / L3-03 / L3-04：群答疑旁路的口径修正（排队槽位 key / 发送人 key / 关联回执的入队与回放）。
 *
 * 2026-11-06：旁路 run 的滑动窗限流（总 12 次 / 每人 4 次）整套删除（用户：「什么熔断机制都可以去掉」），
 * 原来这里的 L3-05（空 messageId 合成 id 计数）、L3-04(b)（回放被限流丢弃的群内提示）、L3-01（回执只计总限额）
 * 三块随之删除；以下保留的与限流无关：
 * - L3-04(d)：`groupBypassSenderKey` 在 id 和名字都没有时返回 `anon:`（不是 `name:undefined`）。
 * - L3-04(c)：`enqueueGroupQuestion` 的发送人槽位 key 统一调 `groupBypassSenderKey`。
 * - L3-01 / L3-03(a)：无活会话的回执会入队、回放时登记若已被焚就按普通消息处理。
 *
 * 路由级用例走真实 routeGroupInboundMessage / pumpGroupQuestionQueue，只 mock 最外层的注入、
 * 发群消息与落盘的 info 事件；时间不真实等待。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn(async () => ({ id: "ev_mock" })),
);
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeOwnedEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "group-bypass-r8-")),
  "data",
);

const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  pumpGroupQuestionQueue,
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
const {
  __resetOutboundRegistryForTest,
  burnCorrelatedEntry,
  listLiveOutboundQuestions,
  registerOutboundQuestion,
} = await import("@/lib/server/feishu-bridge/group-outbound-registry");
const { agentSessions, registerRestrictedQuestion, unregisterRestrictedQuestion } =
  await import("@/lib/server/task-stream");

const OWNER = "ou_owner";
const BOT = "ou_bot";
const CHAT = "oc_req_group";
const TASK = "task-1";
const TAOZI = "ou_taozi";

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

const okResp = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

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
  __resetOutboundRegistryForTest();
  writeOwnedEventAndPublish.mockClear();
  handleTaskQuestionInject = vi.fn(async () => okResp());
  injectPendingAskText = vi.fn(async () => ({ ok: true as const }));
  sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
  installDeps();
});

const busyReleasers: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  while (busyReleasers.length > 0) busyReleasers.pop()!();
  agentSessions.delete(TASK);
  __setGroupRouteDepsForTest(null);
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  shared.__resetGroupReplyStateForTest();
  __resetOutboundRegistryForTest();
});

const route = (m: FeishuInboundMessage) => routeGroupInboundMessage(m, ctx);
/** 让 task 处于「旁路答疑在飞」的忙线态；返回解除函数（可重复调） */
const goBusy = (): (() => void) => {
  const inFlight = { cancelled: false, cancel: () => {} };
  registerRestrictedQuestion(TASK, inFlight);
  const release = () => unregisterRestrictedQuestion(TASK, inFlight);
  busyReleasers.push(release);
  return release;
};

// ───────────────────────── L3-04(d)：无 id 无名的发送人 key ─────────────────────────

describe("L3-04(d)：groupBypassSenderKey 在 id 和名字都没有时返回 anon:", () => {
  const key = shared.groupBypassSenderKey;
  const noName = undefined as unknown as string;

  it("名字缺失 / 空串 / 全空白 → anon:（不是 name:undefined）", () => {
    expect(key({ openId: "", name: noName })).toBe("anon:");
    expect(key({ openId: "", name: "" })).toBe("anon:");
    expect(key({ openId: "", name: "   " })).toBe("anon:");
    expect(key({ openId: "", name: noName }, [undefined, ""])).toBe("anon:");
  });

  it("有名字仍退到 name:；有稳定 id 的口径不变", () => {
    expect(key({ openId: "", name: "机器人甲" })).toBe("name:机器人甲");
    expect(key({ openId: "ou_a", name: noName })).toBe("ou_a");
    expect(key({ openId: "", name: noName }, ["", "cli_c"])).toBe("cli_c");
  });

  it("无 id 无名的发送人共用同一个 anon: 桶（保守聚合），不与任何真实 id / name: 桶撞", () => {
    const entry = (id: string, requester: { openId: string; name: string }) => ({
      messageId: id,
      chatId: CHAT,
      text: `问题 ${id}`,
      parsed: { text: "q", images: [], attachments: [] } as never,
      requester,
      boot: null,
    });
    const cap = { maxPerSender: 1 };
    shared.__resetGroupReplyStateForTest();
    // 每人最多 1 槽：无 id 无名的 a 占了 anon: 桶，另一个无 id 无名的 b 被拒（同桶）
    expect(shared.enqueueGroupQuestion(TASK, entry("n1", { openId: "", name: noName }), Date.now(), cap).queued).toBe(true);
    expect(shared.enqueueGroupQuestion(TASK, entry("n2", { openId: "", name: "" }), Date.now(), cap)).toMatchObject({
      queued: false,
      reason: "sender_limit",
    });
    // 真实 id / 有名字的（name: 桶）不受影响
    expect(shared.enqueueGroupQuestion(TASK, entry("n3", { openId: "ou_other", name: "x" }), Date.now(), cap).queued).toBe(true);
    expect(shared.enqueueGroupQuestion(TASK, entry("n4", { openId: "", name: "甲" }), Date.now(), cap).queued).toBe(true);
  });
});

// ───────────────────────── L3-04(c)：排队槽位 key = groupBypassSenderKey ─────────────────────────

describe("L3-04(c)：enqueueGroupQuestion 的发送人槽位 key = groupBypassSenderKey", () => {
  type Req = { openId: string; name: string; senderIds?: Array<string | undefined> };
  const noName = undefined as unknown as string;
  const entry = (id: string, r: Req) => ({
    messageId: id,
    chatId: CHAT,
    text: `问题 ${id}`,
    parsed: { text: "q", images: [], attachments: [] } as never,
    requester: { openId: r.openId, name: r.name },
    ...(r.senderIds ? { senderIds: r.senderIds } : {}),
    boot: null,
  });
  /** 真实探测：每人最多 1 槽时，b 能不能在 a 之后入队（被 sender_limit 拒 = 同槽） */
  const sameSlot = (a: Req, b: Req): boolean => {
    shared.__resetGroupReplyStateForTest();
    const cap = { maxPerSender: 1 };
    expect(shared.enqueueGroupQuestion(TASK, entry("s1", a), Date.now(), cap).queued).toBe(true);
    const r = shared.enqueueGroupQuestion(TASK, entry("s2", b), Date.now(), cap);
    return !r.queued && r.reason === "sender_limit";
  };
  const slotKey = (r: Req) => shared.groupBypassSenderKey(r, r.senderIds);

  const cases: Array<{ title: string; a: Req; b: Req; same: boolean }> = [
    {
      title: "同 open_id、不同展示名 → 同槽",
      a: { openId: "ou_a", name: "甲", senderIds: ["ou_a"] },
      b: { openId: "ou_a", name: "乙" },
      same: true,
    },
    {
      title: "不同 open_id → 不同槽",
      a: { openId: "ou_a", name: "甲" },
      b: { openId: "ou_b", name: "甲" },
      same: false,
    },
    {
      title: "两个无 open_id 的机器人：展示名相同、稳定 id 不同 → 不同槽（此前按名字连坐）",
      a: { openId: "", name: "机器人", senderIds: ["", "cli_a"] },
      b: { openId: "", name: "机器人", senderIds: ["", "cli_b"] },
      same: false,
    },
    {
      title: "同一机器人改名（稳定 id 相同）→ 同槽（此前改名就多占一个槽）",
      a: { openId: "", name: "旧名", senderIds: [undefined, "ou_botopen"] },
      b: { openId: "", name: "新名", senderIds: ["", "ou_botopen"] },
      same: true,
    },
    {
      title: "展示名写成别人的 open_id 的无 id 发送人，与真 ou_victim → 不同槽（此前同 key 连坐）",
      a: { openId: "ou_victim", name: "x" },
      b: { openId: "", name: "ou_victim" },
      same: false,
    },
    {
      title: "无 id、同名 → 同槽（name: 桶）",
      a: { openId: "", name: "路人" },
      b: { openId: "", name: "路人" },
      same: true,
    },
    {
      title: "无 id 无名（缺失 vs 空串）→ 同一个 anon: 槽",
      a: { openId: "", name: "" },
      b: { openId: "", name: noName },
      same: true,
    },
  ];

  it.each(cases)("$title", ({ a, b, same }) => {
    expect(sameSlot(a, b)).toBe(same);
    // 槽位相同 ⇔ groupBypassSenderKey 相同
    expect(slotKey(a) === slotKey(b)).toBe(same);
  });

  it("满槽后的拒收仍走原口径（sender_limit），不同槽的人不受影响", () => {
    const cap = { maxPerSender: shared.GROUP_QUESTION_QUEUE_MAX_PER_SENDER };
    const botA: Req = { openId: "", name: "机器人", senderIds: ["", "cli_a"] };
    const botB: Req = { openId: "", name: "机器人", senderIds: ["", "cli_b"] };
    expect(shared.enqueueGroupQuestion(TASK, entry("a1", botA), Date.now(), cap).queued).toBe(true);
    expect(shared.enqueueGroupQuestion(TASK, entry("a2", botA), Date.now(), cap).queued).toBe(true);
    expect(shared.enqueueGroupQuestion(TASK, entry("a3", botA), Date.now(), cap)).toMatchObject({
      queued: false,
      reason: "sender_limit",
    });
    // 同名但不同稳定 id 的另一个机器人，槽位是它自己的
    expect(shared.enqueueGroupQuestion(TASK, entry("b1", botB), Date.now(), cap).queued).toBe(true);
  });
});

// ───────────────────────── L3-04(b)：回放丢弃提示——发送成功才认领、一轮最多串发 3 条 ─────────────────────────

// ───────────────────────── L3-01 / L3-03(a)：关联回执的边界事实（不改代码，钉现状） ─────────────────────────

describe("L3-01 / L3-03(a)：登记的消费时机与回执入队（文档事实）", () => {
  const regQ = (messageId = "om_q1") => {
    expect(
      registerOutboundQuestion({
        taskId: TASK,
        chatId: CHAT,
        messageId,
        target: TAOZI,
        keywords: ["学号"],
      }).ok,
    ).toBe(true);
  };
  const receipt = (id: string) =>
    msg(TAOZI, id, { sender_name: "桃子哥", content: "@Flowship 学号 EAA5E7" });

  it("送达即焚：回执 200 之后登记没了；旁路在飞期间同一人的第二条（登记已焚）按普通消息入队，回放不带回执标记", async () => {
    regQ();
    expect(await route(receipt("om_rc"))).toMatchObject({ kind: "sent" });
    expect(listLiveOutboundQuestions(TASK)).toHaveLength(0);

    // 旁路在飞期间同一人的第二条：登记已焚 → 普通消息 → 忙线入队
    const release = goBusy();
    expect(
      await route(msg(TAOZI, "om_second", { sender_name: "桃子哥" })),
    ).toMatchObject({ kind: "queued" });
    release();
    handleTaskQuestionInject.mockClear();
    await pumpGroupQuestionQueue(TASK);
    // 回放按普通消息处理：照常起 run，但不再带数据头 / correlatedAnswer（登记早已被上一条回执焚掉）
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    const [, body, opts] = handleTaskQuestionInject.mock.calls[0] as [
      string,
      { text: string },
      Record<string, unknown>,
    ];
    expect(body.text).not.toContain("疑似回执");
    expect(opts.correlatedAnswer).toBeUndefined();
  });

  it("无活会话的回执会入队（入队不焚）；回放时重算 correlated：登记仍在 → 数据头与 correlatedAnswer 保留，送达后焚", async () => {
    regQ();
    const release = goBusy();
    expect(await route(receipt("om_rc1"))).toMatchObject({ kind: "queued" });
    expect(listLiveOutboundQuestions(TASK)).toHaveLength(1);
    release();
    await pumpGroupQuestionQueue(TASK);

    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    const [, body, opts] = handleTaskQuestionInject.mock.calls[0] as [
      string,
      { text: string },
      Record<string, unknown>,
    ];
    expect(body.text).toContain("疑似回执");
    expect(opts).toMatchObject({ correlatedAnswer: true, restrictToQuestion: true });
    expect(listLiveOutboundQuestions(TASK)).toHaveLength(0);
  });

  it("无活会话的回执入队后、回放前登记被焚：回放按普通消息处理——数据头与 correlatedAnswer 丢失", async () => {
    regQ();
    const release = goBusy();
    expect(await route(receipt("om_rc1"))).toMatchObject({ kind: "queued" });
    // 排队期间登记被消费（一问一答 / 另一条消息先吃掉）
    burnCorrelatedEntry(TASK, "om_q1");
    release();
    await pumpGroupQuestionQueue(TASK);

    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    const [, body, opts] = handleTaskQuestionInject.mock.calls[0] as [
      string,
      { text: string },
      Record<string, unknown>,
    ];
    expect(body.text).not.toContain("疑似回执");
    expect(opts.correlatedAnswer).toBeUndefined();
  });
});
