/**
 * 第八轮 L3-01 / L3-03 / L3-04 / L3-05：群答疑旁路限流与回放提示的口径修正。
 *
 * - L3-05：空 messageId 此前直接放行、不计数（限流器 fail-open；入口现在到不了，换入口就是后门）。
 *   改为合成 id 照常计数；合成 id 与真实 id 互不冲突；空 id 退还不了——保守不退（窗口 10 分钟自然过期）。
 * - L3-04(d)：`groupBypassSenderKey` 在 id 和名字都没有时此前返回 `name:undefined`，现返回 `anon:`。
 * - L3-04(c)：`enqueueGroupQuestion` 的发送人槽位 key 此前是裸 `openId || name`，与限流 key 不是一回事；
 *   现统一调 `groupBypassSenderKey`。
 * - L3-04(b)：排队回放被限流丢弃的群内提示——**发送成功后才认领名额**；pump 一轮最多单发 3 条、其余合并成一句
 *   （不再依次 await 最多 10 条阻塞入向）。
 * - L3-01 / L3-03(a)：「不改代码、写进文档」的两条的事实核实（关联回执只计总限额的边界；无活会话的回执会入队、
 *   回放时登记若已被焚就按普通消息处理），这里钉成现状用例。
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
  GROUP_BYPASS_RATE_LIMITED,
  pumpGroupQuestionQueue,
  routeGroupInboundMessage,
} = await import("@/lib/server/feishu-bridge/group-route");
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
const SECRET_BODY = "机密正文-不该进限流提示-r8-4d1f";

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
const botMsg = (
  sender: string,
  id: string,
  over: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => msg(sender, id, { sender_type: "app", ...over } as never);

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
const sentTexts = (): string[] =>
  sendTextToChat.mock.calls.map((c) => String((c as unknown[])[1]));
/** 让 task 处于「旁路答疑在飞」的忙线态；返回解除函数（可重复调） */
const goBusy = (): (() => void) => {
  const inFlight = { cancelled: false, cancel: () => {} };
  registerRestrictedQuestion(TASK, inFlight);
  const release = () => unregisterRestrictedQuestion(TASK, inFlight);
  busyReleasers.push(release);
  return release;
};

const admit = (
  sender: string,
  messageId: string,
  now?: number,
  extra: { correlatedReceipt?: boolean } = {},
) => shared.admitGroupBypassRun(TASK, { sender, messageId, ...extra }, now);

// ───────────────────────── L3-05：空 messageId 不再 fail-open ─────────────────────────

describe("L3-05：空 messageId 用合成 id 照常计数（不是放行不计）", () => {
  it("同一发送人空 id 连调：前 4 次放行并计数，第 5 次被个人限额拒", () => {
    const t0 = 7_000_000;
    for (let i = 0; i < 4; i++) {
      expect(admit("ou_x", "", t0 + i), `第 ${i + 1} 次`).toEqual({
        allowed: true,
        notify: false,
        counted: true,
      });
    }
    expect(admit("ou_x", "", t0 + 10)).toMatchObject({
      allowed: false,
      scope: "sender",
    });
  });

  it("不同发送人空 id 连调 14 次：前 12 次放行，第 13 次起被总限额拒", () => {
    const t0 = 7_100_000;
    for (let i = 0; i < 12; i++) {
      expect(admit(`ou_${i}`, "", t0 + i).allowed, `第 ${i + 1} 次`).toBe(true);
    }
    for (let i = 12; i < 14; i++) {
      expect(admit(`ou_${i}`, "", t0 + i), `第 ${i + 1} 次`).toMatchObject({
        allowed: false,
        scope: "total",
      });
    }
  });

  it("空 id 与带 id 的调用共用同一份额度：2 个空 id + 2 个带 id 之后，同一发送人第 5 次被拒", () => {
    const t0 = 7_200_000;
    admit("ou_x", "", t0);
    admit("ou_x", "", t0 + 1);
    admit("ou_x", "om_a", t0 + 2);
    admit("ou_x", "om_b", t0 + 3);
    expect(admit("ou_x", "om_c", t0 + 4)).toMatchObject({ allowed: false, scope: "sender" });
  });

  it("合成 id 互不冲突：两次空 id 调用不会被当成「同一条消息重投」而吞成一次", () => {
    const t0 = 7_300_000;
    expect(admit("ou_x", "", t0)).toMatchObject({ counted: true });
    expect(admit("ou_x", "", t0 + 1)).toMatchObject({ counted: true });
    // 若被当重投，第二次是 counted:false，个人额度会比实际少记一次
    for (let i = 0; i < 2; i++) admit("ou_x", `om_${i}`, t0 + 10 + i);
    expect(admit("ou_x", "om_over", t0 + 20)).toMatchObject({ allowed: false, scope: "sender" });
  });

  it("合成 id 不与真实 id 冲突：任何字面形态的真实 id（含 anon:N）仍被当新到计数、重投仍幂等", () => {
    const t0 = 7_400_000;
    // 先放几个合成 stamp
    for (let i = 0; i < 3; i++) admit("ou_x", "", t0 + i);
    // 真实 id 取各种 anon:N 形态（合成 id 若落进同一命名空间就会被当成重投、counted:false）；
    // 每个用不同发送人，避免撞个人限额
    for (let n = 1; n <= 6; n++) {
      expect(admit(`ou_y${n}`, `anon:${n}`, t0 + 10 + n), `真实 id anon:${n}`).toMatchObject({
        allowed: true,
        counted: true,
      });
    }
    // 真实 id 的重投照旧幂等
    expect(admit("ou_y1", "anon:1", t0 + 30)).toMatchObject({ allowed: true, counted: false });
  });

  it("退还：release('') 为 false；release 一个真实 id 不会误摘合成 stamp（空 id 的名额保守不退）", () => {
    const t0 = 7_500_000;
    expect(shared.releaseGroupBypassRun(TASK, "")).toBe(false);
    for (let i = 0; i < 4; i++) admit("ou_x", "", t0 + i);
    // 没有任何真实 id 对得上：anon:1 是真实 id 命名空间里的字面串，不是合成 stamp
    expect(shared.releaseGroupBypassRun(TASK, "anon:1")).toBe(false);
    // 4 个合成 stamp 都还在
    expect(admit("ou_x", "om_next", t0 + 10)).toMatchObject({ allowed: false, scope: "sender" });
  });

  it("空 id 的 stamp 按窗口过期：窗口滑过后额度恢复（保守不退不是永久占位）", () => {
    const t0 = 7_600_000;
    for (let i = 0; i < 4; i++) admit("ou_x", "", t0 + i);
    expect(admit("ou_x", "", t0 + 10)).toMatchObject({ allowed: false });
    const slid = t0 + shared.GROUP_BYPASS_RUN_WINDOW_MS + 100;
    expect(admit("ou_x", "", slid)).toMatchObject({ allowed: true, counted: true });
  });

  it("空 id 的关联回执同样计总限额、不计个人限额", () => {
    const t0 = 7_700_000;
    for (let i = 0; i < 6; i++) {
      expect(
        admit(TAOZI, "", t0 + i, { correlatedReceipt: true }),
        `回执 ${i + 1}`,
      ).toMatchObject({ allowed: true, counted: true });
    }
    // 回执不占个人额度：普通消息仍可启动 4 次
    for (let i = 0; i < 4; i++) {
      expect(admit(TAOZI, `om_n${i}`, t0 + 10 + i)).toMatchObject({ allowed: true });
    }
    expect(admit(TAOZI, "om_n4", t0 + 20)).toMatchObject({ allowed: false, scope: "sender" });
  });
});

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
    const t0 = 7_800_000;
    const anon = key({ openId: "", name: noName });
    for (let i = 0; i < 4; i++) admit(anon, `om_${i}`, t0 + i);
    expect(admit(key({ openId: "", name: "" }), "om_4", t0 + 10)).toMatchObject({
      allowed: false,
      scope: "sender",
    });
    expect(admit("ou_other", "om_o", t0 + 11)).toMatchObject({ allowed: true });
    expect(admit(key({ openId: "", name: "甲" }), "om_n", t0 + 12)).toMatchObject({
      allowed: true,
    });
  });
});

// ───────────────────────── L3-04(c)：排队槽位 key 与限流 key 同口径 ─────────────────────────

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
  const limitKey = (r: Req) => shared.groupBypassSenderKey(r, r.senderIds);

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
    // 同时就是限流 key 的等价关系：槽位 key 相同 ⇔ 限流 key 相同
    expect(limitKey(a) === limitKey(b)).toBe(same);
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

describe("L3-04(b)：回放丢弃提示的认领与批量", () => {
  /** 12 个不同的人占满总额（每人 1 次，不触个人限额） */
  const fillTotal = async () => {
    for (let i = 0; i < 12; i++) {
      expect(await route(msg(`ou_u${i}`, `om_u${i}`))).toMatchObject({ kind: "sent" });
    }
  };
  /** 忙线期间这些人各排 1 条（机器人用 botMsg）；放行后清空 mock 计数，等待 pump */
  const queueLate = async (
    senders: Array<{ id: string; bot?: boolean }>,
    idPrefix = "om_late",
  ) => {
    const release = goBusy();
    for (const s of senders) {
      const mk = s.bot ? botMsg : msg;
      expect(
        await route(
          mk(s.id, `${idPrefix}_${s.id}`, {
            sender_name: s.id,
            content: `@Flowship ${SECRET_BODY}`,
          }),
        ),
        s.id,
      ).toMatchObject({ kind: "queued" });
    }
    release();
    sendTextToChat.mockClear();
    handleTaskQuestionInject.mockClear();
  };
  const atTags = (t: string): string[] => t.match(/<at user_id="[^"]+">/g) ?? [];
  const humans = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `ou_late${i}` }));

  it("发送失败不耗名额：同一个人下一条被丢弃的回放仍能收到提示；同批同人只尝试一次（不重试刷屏）", async () => {
    // ou_x 个人额度用满 + 排 2 条
    for (let i = 0; i < 4; i++) {
      expect(await route(msg("ou_x", `om_x${i}`))).toMatchObject({ kind: "sent" });
    }
    const release = goBusy();
    expect(await route(msg("ou_x", "om_xq0"))).toMatchObject({ kind: "queued" });
    expect(await route(msg("ou_x", "om_xq1"))).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();
    sendTextToChat.mockRejectedValueOnce(new Error("lark 5xx"));

    await pumpGroupQuestionQueue(TASK);
    // 两条都被丢弃、但同批同人只尝试发一次（失败了也不在同一批里重试）
    expect(sendTextToChat).toHaveBeenCalledTimes(1);

    // 名额没耗：x 再排一条、再被丢 → 这次发得出去（入队 ack 也走 sendTextToChat，排完队再清计数）
    const release2 = goBusy();
    expect(await route(msg("ou_x", "om_xq2"))).toMatchObject({ kind: "queued" });
    release2();
    sendTextToChat.mockClear();
    await pumpGroupQuestionQueue(TASK);
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('user_id="ou_x"');

    // 发成功了才耗：再来一条又被丢，不再提示
    const release3 = goBusy();
    expect(await route(msg("ou_x", "om_xq3"))).toMatchObject({ kind: "queued" });
    release3();
    sendTextToChat.mockClear();
    await pumpGroupQuestionQueue(TASK);
    expect(sendTextToChat).not.toHaveBeenCalled();
  });

  it("3 个人被丢：各收到自己的一条，不出现合并句", async () => {
    await fillTotal();
    await queueLate(humans(3));
    await pumpGroupQuestionQueue(TASK);
    const texts = sentTexts();
    expect(texts).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(texts[i]).toContain(`user_id="ou_late${i}"`);
      expect(atTags(texts[i]!)).toHaveLength(1);
    }
  });

  it("5 个人被丢：前 3 人各一条，其余 2 人合并成一句（共 4 次发送，不是 5 次）；合并句 @ 到被丢的每个人、不回显原文", async () => {
    await fillTotal();
    await queueLate(humans(5));
    await pumpGroupQuestionQueue(TASK);
    const texts = sentTexts();
    expect(texts).toHaveLength(4);
    for (let i = 0; i < 3; i++) {
      expect(texts[i]).toContain(`user_id="ou_late${i}"`);
      expect(atTags(texts[i]!)).toHaveLength(1);
    }
    const merged = texts[3]!;
    expect(atTags(merged)).toEqual(['<at user_id="ou_late3">', '<at user_id="ou_late4">']);
    expect(merged).toContain("没有被回答");
    expect(merged).toContain("限流");
    expect(merged).not.toContain(SECRET_BODY);
    // 都没真的起 run
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
  });

  it("4 个人被丢：第 4 人不合并——按单发文案发（共 4 次发送、每条只 @ 一个人，不出现「你们 / 这几条」）；名额照常认领", async () => {
    await fillTotal();
    await queueLate(humans(4));
    await pumpGroupQuestionQueue(TASK);
    const texts = sentTexts();
    expect(texts).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(texts[i], `第 ${i + 1} 条`).toContain(`user_id="ou_late${i}"`);
      expect(atTags(texts[i]!), `第 ${i + 1} 条`).toHaveLength(1);
      expect(texts[i], `第 ${i + 1} 条`).toContain("你排队的这条");
      expect(texts[i], `第 ${i + 1} 条`).not.toContain("你们");
    }

    // 第 4 人（只因超过 3 条单发预算才落到「其余」里）同窗内再被丢，不再收到
    const release = goBusy();
    expect(await route(msg("ou_late3", "om_late3_again"))).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();
    await pumpGroupQuestionQueue(TASK);
    expect(sendTextToChat).not.toHaveBeenCalled();
  });

  it("10 个人被丢：一轮最多 4 次发送（3 单发 + 1 合并句，合并句里 7 个人）", async () => {
    await fillTotal();
    await queueLate(humans(10));
    await pumpGroupQuestionQueue(TASK);
    const texts = sentTexts();
    expect(texts).toHaveLength(4);
    expect(atTags(texts[3]!)).toHaveLength(7);
    // 10 个人每人恰好被 @ 一次（没有丢谁、也没有重复 @）
    const all = texts.flatMap(atTags);
    expect(new Set(all).size).toBe(10);
    expect(all).toHaveLength(10);
  });

  it("合并句成功后，被合并的人也算已提示：同窗内再被丢不再收到", async () => {
    await fillTotal();
    await queueLate(humans(5));
    await pumpGroupQuestionQueue(TASK);
    expect(sentTexts()).toHaveLength(4);

    // ou_late4（只在合并句里被点名）再排一条、再被总限额丢
    const release = goBusy();
    expect(await route(msg("ou_late4", "om_late4_again"))).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();
    await pumpGroupQuestionQueue(TASK);
    expect(sendTextToChat).not.toHaveBeenCalled();
  });

  it("合并句发送失败：被合并的人名额都不耗，下一次被丢仍能收到；已单发成功的 3 人照常耗掉", async () => {
    await fillTotal();
    await queueLate(humans(5));
    // 第 4 次发送（合并句）失败，前 3 次成功
    let n = 0;
    sendTextToChat.mockImplementation(async () => {
      n += 1;
      if (n === 4) throw new Error("lark 5xx");
      return { chat_id: CHAT, message_id: `om_r${n}` };
    });
    await pumpGroupQuestionQueue(TASK);
    expect(n).toBe(4);

    sendTextToChat.mockImplementation(async () => ({ chat_id: CHAT, message_id: "om_x" }));
    const release = goBusy();
    // late3 / late4（合并句失败）和 late0（单发已成功）各再排一条
    for (const id of ["ou_late3", "ou_late4", "ou_late0"]) {
      expect(await route(msg(id, `om_again_${id}`))).toMatchObject({ kind: "queued" });
    }
    release();
    sendTextToChat.mockClear();
    await pumpGroupQuestionQueue(TASK);
    const texts = sentTexts();
    // late0 已提示过 → 不再发；late3 / late4 名额没耗 → 这次收到（2 人 ≤ 3，各自单发）
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes('user_id="ou_late3"'))).toBe(true);
    expect(texts.some((t) => t.includes('user_id="ou_late4"'))).toBe(true);
    expect(texts.some((t) => t.includes('user_id="ou_late0"'))).toBe(false);
  });

  it("机器人提问人整条静默、不占那 3 条预算也不占名额：4 个机器人 + 2 个真人 → 真人各收一条", async () => {
    await fillTotal();
    await queueLate([
      { id: "ou_bota", bot: true },
      { id: "ou_botb", bot: true },
      { id: "ou_botc", bot: true },
      { id: "ou_botd", bot: true },
      { id: "ou_h1" },
      { id: "ou_h2" },
    ]);
    await pumpGroupQuestionQueue(TASK);
    const texts = sentTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('user_id="ou_h1"');
    expect(texts[1]).toContain('user_id="ou_h2"');
  });

  it("单发文案沿用原口径：个人限额点明个人限流、总限额点明总量与上限 12", async () => {
    // 个人限额：ou_x 用满 4 次后回放被丢
    for (let i = 0; i < 4; i++) {
      expect(await route(msg("ou_x", `om_x${i}`))).toMatchObject({ kind: "sent" });
    }
    const release = goBusy();
    expect(await route(msg("ou_x", "om_xq"))).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();
    await pumpGroupQuestionQueue(TASK);
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain("个人");

    // 总限额：另一窗口里总额占满后回放被丢
    shared.__resetGroupReplyStateForTest();
    await fillTotal();
    await queueLate(humans(1));
    await pumpGroupQuestionQueue(TASK);
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain("12");
    expect(sentTexts()[0]).not.toContain("个人");
  });

  it("合并句点明限流 + 名额上限（总 12 / 每人 4），不区分被丢的是哪种限额", async () => {
    await fillTotal();
    await queueLate(humans(5));
    await pumpGroupQuestionQueue(TASK);
    const merged = sentTexts()[3]!;
    expect(merged).toContain("12");
    expect(merged).toContain("4");
    expect(merged).toContain("限流");
  });
});

// ───────────────────────── L3-01 / L3-03(a)：关联回执的边界事实（不改代码，钉现状） ─────────────────────────

describe("L3-01：关联回执只受总限额约束（文档事实，机械核实）", () => {
  it("同一发送人连发 14 条回执：前 12 条放行、后 2 条被总限额拒（notify 只在第 13 条）；之后真人的普通消息被总限额挡", () => {
    const t0 = 8_000_000;
    const results = Array.from({ length: 14 }, (_, i) =>
      admit(TAOZI, `om_r${i}`, t0 + i, { correlatedReceipt: true }),
    );
    expect(results.slice(0, 12).every((r) => r.allowed)).toBe(true);
    expect(results[12]).toEqual({ allowed: false, notify: true, scope: "total" });
    expect(results[13]).toEqual({ allowed: false, notify: false, scope: "total" });
    expect(admit(TAOZI, "om_normal", t0 + 100)).toMatchObject({ allowed: false, scope: "total" });
    expect(admit("ou_someone_else", "om_other", t0 + 101)).toMatchObject({
      allowed: false,
      scope: "total",
    });
  });
});

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

  it("被总限额拒绝的回执不焚登记（丢弃发生在送达之前）：同一发送人的下一条仍是回执", async () => {
    for (let i = 0; i < 12; i++) {
      expect(await route(msg(`ou_u${i}`, `om_u${i}`))).toMatchObject({ kind: "sent" });
    }
    regQ();
    expect(await route(receipt("om_late"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
    expect(listLiveOutboundQuestions(TASK)).toHaveLength(1);
  });

  it("送达即焚：回执 200 之后登记没了；旁路在飞期间同一人的第二条（登记已焚）按普通消息入队，回放计个人额度", async () => {
    // TAOZI 先用满个人额度（普通消息 4 次）
    for (let i = 0; i < 4; i++) {
      expect(await route(msg(TAOZI, `om_n${i}`, { sender_name: "桃子哥" }))).toMatchObject({
        kind: "sent",
      });
    }
    regQ();
    // 回执只计总、不计个人 → 放行，送达后焚
    expect(await route(receipt("om_rc"))).toMatchObject({ kind: "sent" });
    expect(listLiveOutboundQuestions(TASK)).toHaveLength(0);

    // 旁路在飞期间同一人的第二条：登记已焚 → 普通消息 → 忙线入队
    const release = goBusy();
    expect(
      await route(msg(TAOZI, "om_second", { sender_name: "桃子哥" })),
    ).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();
    handleTaskQuestionInject.mockClear();
    await pumpGroupQuestionQueue(TASK);
    // 回放按普通消息计个人额度（已满）→ 被个人限额丢弃；若它还被当回执只计总额，这里会放行起 run
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain("个人");
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
