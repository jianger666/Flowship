/**
 * 第七轮 K2-01 / K2-02 / K2-08 / K2-09：群答疑旁路限流的四处口径修正。
 *
 * - K2-01：命中出问登记的关联回执（托办回执）——无活会话时走只读旁路起 run，此前计入个人限额，
 *   同一发送人 10 分钟内第 5 次回执被静默丢掉；拍板：只计总限额、不计个人限额。
 * - K2-02：排队回放遇限流被丢弃，但入队时已回过「答完就答你」——对真人提问人补一句节流提示
 *   （每窗每人一条）；机器人提问人保持静默（防环）；即时到达的消息被限流仍静默（没承诺过）。
 * - K2-08：个人限额的 info 节流按发送人分桶（此前所有人共用一个计时，B 撞线被 A 吞掉）。
 * - K2-09：空 messageId 不计数、不记 stamp（计了也退不掉）——**这半已被第八轮 L3-05 推翻**（改为合成 id
 *   照常计数，见 tests/group-bypass-r8.test.ts，下面两条用例已翻转）；发送人 key 退到展示名时加 `name:`
 *   前缀，不与 open_id / 机器人 id 撞桶（展示名是用户可改的自由文本）。
 *
 * 路由级用例走真实 routeGroupInboundMessage / pumpGroupQuestionQueue，只 mock 最外层的注入、
 * 发群消息与落盘的 info 事件；时间用假 Date，不真实等待。
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
  fs.mkdtempSync(path.join(os.tmpdir(), "group-bypass-r7-")),
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
const { __resetOutboundRegistryForTest, registerOutboundQuestion } = await import(
  "@/lib/server/feishu-bridge/group-outbound-registry"
);
const { agentSessions, registerRestrictedQuestion, unregisterRestrictedQuestion } =
  await import("@/lib/server/task-stream");

const OWNER = "ou_owner";
const BOT = "ou_bot";
const CHAT = "oc_req_group";
const TASK = "task-1";
const TAOZI = "ou_taozi";
const SECRET_BODY = "机密正文-不该进限流提示-9c2e";

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
const infoEvents = () =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => (c as unknown[])[2] as { kind: string; text: string })
    .filter((e) => e.kind === "info");

const busyReleasers: Array<() => void> = [];
/** 让 task 处于「旁路答疑在飞」的忙线态；返回解除函数（可重复调） */
const goBusy = (): (() => void) => {
  const inFlight = { cancelled: false, cancel: () => {} };
  registerRestrictedQuestion(TASK, inFlight);
  const release = () => unregisterRestrictedQuestion(TASK, inFlight);
  busyReleasers.push(release);
  return release;
};

/** admitGroupBypassRun 的短写 */
const admit = (
  sender: string,
  messageId: string,
  now?: number,
  extra: { correlatedReceipt?: boolean } = {},
) => shared.admitGroupBypassRun(TASK, { sender, messageId, ...extra }, now);

/** 登一条出问登记 → 下一条 TAOZI 的回执会命中（命中送达即焚，每轮要重登） */
const regQ = (messageId = "om_q1") => {
  const r = registerOutboundQuestion({
    taskId: TASK,
    chatId: CHAT,
    messageId,
    target: TAOZI,
    keywords: ["学号"],
  });
  expect(r.ok).toBe(true);
};
const receipt = (id: string) =>
  msg(TAOZI, id, { sender_name: "桃子哥", content: "@Flowship 学号 EAA5E7" });

describe("K2-01：命中出问登记的关联回执只计总限额、不计个人限额", () => {
  it("纯函数：同一发送人 6 次回执（无活会话时都走旁路）全部放行，个人限额 4 不拦回执", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) {
      expect(admit(TAOZI, `om_r${i}`, t0 + i, { correlatedReceipt: true })).toEqual({
        allowed: true,
        notify: false,
        counted: true,
      });
    }
  });

  it("纯函数：回执仍计总限额——满 12 后第 13 个（哪怕是回执）被总限额拦下", () => {
    const t0 = 1_100_000;
    for (let i = 0; i < 12; i++) {
      expect(
        admit(TAOZI, `om_r${i}`, t0 + i, { correlatedReceipt: true }).allowed,
      ).toBe(true);
    }
    expect(admit(TAOZI, "om_r12", t0 + 100, { correlatedReceipt: true })).toMatchObject({
      allowed: false,
      scope: "total",
    });
    // 普通消息同样被总限额拦：回执占的是同一份总额
    expect(admit("ou_other", "om_o", t0 + 101)).toMatchObject({
      allowed: false,
      scope: "total",
    });
  });

  it("纯函数：回执不占个人额度——6 次回执后同一发送人仍可普通启动 4 次，第 5 次才被个人限额拦", () => {
    const t0 = 1_200_000;
    for (let i = 0; i < 6; i++) {
      admit(TAOZI, `om_r${i}`, t0 + i, { correlatedReceipt: true });
    }
    for (let i = 0; i < 4; i++) {
      expect(admit(TAOZI, `om_n${i}`, t0 + 10 + i)).toMatchObject({
        allowed: true,
        counted: true,
      });
    }
    expect(admit(TAOZI, "om_n4", t0 + 20)).toMatchObject({
      allowed: false,
      scope: "sender",
    });
  });

  it("纯函数：普通消息的个人限额口径不变（第 5 次仍被拦）；回执重投同样幂等", () => {
    const t0 = 1_300_000;
    for (let i = 0; i < 4; i++) admit("ou_x", `om_x${i}`, t0 + i);
    expect(admit("ou_x", "om_x4", t0 + 10)).toMatchObject({ allowed: false, scope: "sender" });
    expect(admit(TAOZI, "om_dup", t0 + 20, { correlatedReceipt: true })).toMatchObject({
      counted: true,
    });
    expect(admit(TAOZI, "om_dup", t0 + 21, { correlatedReceipt: true })).toMatchObject({
      allowed: true,
      counted: false,
    });
  });

  it("路由：无活会话时同一发送人连发 6 轮回执（每轮重登）全部放行，且走只读旁路（restrictToQuestion）", async () => {
    for (let i = 0; i < 6; i++) {
      regQ();
      const r = await route(receipt(`om_ex${i}`));
      expect(r, `第 ${i + 1} 轮`).toMatchObject({ kind: "sent" });
    }
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(6);
    const opts = handleTaskQuestionInject.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts).toMatchObject({ restrictToQuestion: true, correlatedAnswer: true });
    expect(infoEvents()).toHaveLength(0);
  });

  it("路由：回执照计总限额——12 个别人先占满总额后，回执被总限额静默丢弃", async () => {
    for (let i = 0; i < 12; i++) {
      expect(await route(msg(`ou_u${i}`, `om_u${i}`))).toMatchObject({ kind: "sent" });
    }
    regQ();
    expect(await route(receipt("om_late"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
  });

  it("路由：回执不占个人额度——同一发送人 6 轮回执之后，普通消息仍能启动 4 次、第 5 次被个人限额拦", async () => {
    for (let i = 0; i < 6; i++) {
      regQ();
      expect(await route(receipt(`om_ex${i}`))).toMatchObject({ kind: "sent" });
    }
    for (let i = 0; i < 4; i++) {
      expect(
        await route(msg(TAOZI, `om_n${i}`, { sender_name: "桃子哥" })),
        `普通第 ${i + 1} 次`,
      ).toMatchObject({ kind: "sent" });
    }
    expect(await route(msg(TAOZI, "om_n4", { sender_name: "桃子哥" }))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
  });
});

describe("K2-02：排队回放被限流丢弃后，对真人提问人回一句节流提示（每窗每人一条）", () => {
  /** ou_x 先用满个人 4 次；随后忙线期间 ou_x 排 2 条（om_x4 / om_x5），放行后回放被个人限额丢弃 */
  const arrangeReplayDrop = async (sender = "ou_x", mk = msg) => {
    for (let i = 0; i < 4; i++) {
      expect(await route(mk(sender, `om_${sender}_${i}`))).toMatchObject({ kind: "sent" });
    }
    const release = goBusy();
    expect(
      await route(
        mk(sender, `om_${sender}_q0`, { content: `@Flowship ${SECRET_BODY}` }),
      ),
    ).toMatchObject({ kind: "queued" });
    expect(await route(mk(sender, `om_${sender}_q1`))).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();
  };

  it("真人：回放被个人限额丢弃 → 群里 @ 他回一句（不带原文）；同窗内第二条被丢的不再重复提示", async () => {
    await arrangeReplayDrop("ou_x", (s, id, o) =>
      msg(s, id, { sender_name: "王小明", ...o }),
    );
    handleTaskQuestionInject.mockClear();

    await pumpGroupQuestionQueue(TASK);

    // 两条都没注入（回放遇限流丢弃）
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(shared.groupQuestionQueueLength(TASK)).toBe(0);
    // 但只提示一次：@ 提问人、点明限流与没被回答、不回显原文
    const texts = sentTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('<at user_id="ou_x">王小明</at>');
    expect(texts[0]).toContain("限流");
    expect(texts[0]).toContain("没有被回答");
    expect(texts[0]).not.toContain(SECRET_BODY);
  });

  it("另一个真人在同窗内回放被丢 → 各自收到自己的一条（节流按人，不是按窗口一刀切）", async () => {
    // x 占满个人额度并排 1 条；y 占满个人额度并排 1 条
    const mk = (s: string, id: string, o: Partial<FeishuInboundMessage> = {}) =>
      msg(s, id, o);
    for (const who of ["ou_x", "ou_y"]) {
      for (let i = 0; i < 4; i++) {
        expect(await route(mk(who, `om_${who}_${i}`))).toMatchObject({ kind: "sent" });
      }
    }
    const release = goBusy();
    expect(await route(mk("ou_x", "om_x_q"))).toMatchObject({ kind: "queued" });
    expect(await route(mk("ou_y", "om_y_q"))).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();

    await pumpGroupQuestionQueue(TASK);

    const texts = sentTexts();
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes('user_id="ou_x"'))).toBe(true);
    expect(texts.some((t) => t.includes('user_id="ou_y"'))).toBe(true);
  });

  it("窗口滑过后（10 分钟）同一个人再被丢，可再收到一条", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 3_000_000;
    vi.setSystemTime(t0);
    await arrangeReplayDrop();
    await pumpGroupQuestionQueue(TASK);
    expect(sentTexts()).toHaveLength(1);

    // 窗口滑过：ou_x 的 4 次早已出窗；再用满 4 次、再排一条、再被丢
    vi.setSystemTime(t0 + 10 * 60 * 1000 + 1000);
    for (let i = 0; i < 4; i++) {
      expect(await route(msg("ou_x", `om_again_${i}`))).toMatchObject({ kind: "sent" });
    }
    const release = goBusy();
    expect(await route(msg("ou_x", "om_again_q"))).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();
    await pumpGroupQuestionQueue(TASK);
    expect(sentTexts()).toHaveLength(1);
  });

  it("窗口没滑过时再被丢不重复提示（9 分钟后仍在窗内）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 4_000_000;
    vi.setSystemTime(t0);
    await arrangeReplayDrop();
    await pumpGroupQuestionQueue(TASK);
    expect(sentTexts()).toHaveLength(1);

    vi.setSystemTime(t0 + 9 * 60 * 1000);
    const release = goBusy();
    expect(await route(msg("ou_x", "om_late_q"))).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();
    await pumpGroupQuestionQueue(TASK);
    expect(sentTexts()).toEqual([]);
  });

  it("总限额丢弃的回放同样提示，文案点明是群答疑总量限流", async () => {
    // 12 个不同的人占满总额；忙线期间 ou_late 排队，放行后回放撞总限额
    for (let i = 0; i < 12; i++) {
      expect(await route(msg(`ou_u${i}`, `om_u${i}`))).toMatchObject({ kind: "sent" });
    }
    const release = goBusy();
    expect(
      await route(msg("ou_late", "om_late", { sender_name: "李雷" })),
    ).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();
    handleTaskQuestionInject.mockClear();

    await pumpGroupQuestionQueue(TASK);

    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    const texts = sentTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('<at user_id="ou_late">李雷</at>');
    expect(texts[0]).toContain("限流");
    expect(texts[0]).toContain("12");
  });

  it("机器人提问人：回放被丢弃仍整条静默（防环），且不吃掉它的提示名额", async () => {
    for (let i = 0; i < 4; i++) {
      expect(await route(botMsg("ou_bota", `om_a${i}`))).toMatchObject({ kind: "sent" });
    }
    const release = goBusy();
    expect(await route(botMsg("ou_bota", "om_aq"))).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();
    handleTaskQuestionInject.mockClear();

    await pumpGroupQuestionQueue(TASK);

    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(sendTextToChat).not.toHaveBeenCalled();
  });

  it("即时到达的消息被限流仍静默（没承诺过『答完就答你』，不新增群内回执）", async () => {
    for (let i = 0; i < 4; i++) {
      expect(await route(msg("ou_x", `om_x${i}`))).toMatchObject({ kind: "sent" });
    }
    sendTextToChat.mockClear();
    expect(await route(msg("ou_x", "om_x4"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
    expect(sendTextToChat).not.toHaveBeenCalled();
  });

  it("即时被限流不吃提示名额：之后同一个人的回放被丢，仍能收到那一条", async () => {
    for (let i = 0; i < 4; i++) {
      expect(await route(msg("ou_x", `om_x${i}`))).toMatchObject({ kind: "sent" });
    }
    // 即时到达被限流（静默）
    expect(await route(msg("ou_x", "om_live"))).toMatchObject({ kind: "skipped" });
    const release = goBusy();
    expect(await route(msg("ou_x", "om_q"))).toMatchObject({ kind: "queued" });
    release();
    sendTextToChat.mockClear();
    await pumpGroupQuestionQueue(TASK);
    expect(sentTexts()).toHaveLength(1);
  });
});

describe("K2-08：个人限额的 info 节流按发送人分桶", () => {
  it("纯函数：A 撞线 notify:true 后，B 撞线也 notify:true；各自每窗只一次；窗滑过后可再提示", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 4; i++) admit("ou_a", `om_a${i}`, t0 + i);
    for (let i = 0; i < 4; i++) admit("ou_b", `om_b${i}`, t0 + 10 + i);

    expect(admit("ou_a", "om_a4", t0 + 20)).toEqual({
      allowed: false,
      notify: true,
      scope: "sender",
    });
    // B 撞线：此前共用计时，这里会是 notify:false（被 A 吞掉）
    expect(admit("ou_b", "om_b4", t0 + 21)).toEqual({
      allowed: false,
      notify: true,
      scope: "sender",
    });
    // 各自每窗只一次
    expect(admit("ou_a", "om_a5", t0 + 22)).toMatchObject({ notify: false });
    expect(admit("ou_b", "om_b5", t0 + 23)).toMatchObject({ notify: false });

    // 窗口滑过：A 再用满 4 次、再撞线，可再提示一次
    const slid = t0 + shared.GROUP_BYPASS_RUN_WINDOW_MS + 100;
    for (let i = 0; i < 4; i++) admit("ou_a", `om_a_again${i}`, slid + i);
    expect(admit("ou_a", "om_a_again4", slid + 10)).toMatchObject({
      allowed: false,
      notify: true,
      scope: "sender",
    });
  });

  it("纯函数：个人 / 总限额的 notify 仍各自独立（总额提示不被个人提示吞）", () => {
    const t0 = 5_500_000;
    for (let i = 0; i < 4; i++) admit("ou_a", `om_a${i}`, t0 + i);
    expect(admit("ou_a", "om_a4", t0 + 10)).toMatchObject({ notify: true, scope: "sender" });
    for (let i = 0; i < 8; i++) admit(`ou_o${i}`, `om_o${i}`, t0 + 20 + i);
    expect(admit("ou_late", "om_late", t0 + 40)).toEqual({
      allowed: false,
      notify: true,
      scope: "total",
    });
  });

  it("路由：A、B 各自撞线各写一条个人限额 info（点各自的名字），同一人窗内不重复写", async () => {
    const mk = (s: string, name: string, id: string) =>
      msg(s, id, { sender_name: name, content: `@Flowship ${SECRET_BODY}` });
    for (let i = 0; i < 4; i++) {
      expect(await route(mk("ou_a", "甲", `om_a${i}`))).toMatchObject({ kind: "sent" });
    }
    for (let i = 0; i < 4; i++) {
      expect(await route(mk("ou_b", "乙", `om_b${i}`))).toMatchObject({ kind: "sent" });
    }
    expect(await route(mk("ou_a", "甲", "om_a4"))).toMatchObject({ kind: "skipped" });
    expect(await route(mk("ou_b", "乙", "om_b4"))).toMatchObject({ kind: "skipped" });
    expect(await route(mk("ou_a", "甲", "om_a5"))).toMatchObject({ kind: "skipped" });
    expect(await route(mk("ou_b", "乙", "om_b5"))).toMatchObject({ kind: "skipped" });

    const infos = infoEvents();
    expect(infos).toHaveLength(2);
    expect(infos[0]!.text).toContain("甲");
    expect(infos[1]!.text).toContain("乙");
    expect(infos.map((e) => e.text).join("\n")).not.toContain(SECRET_BODY);
  });
});

describe("K2-09：发送人 key 退到展示名时加 name: 前缀（空 messageId 放行不计数那半已被第八轮 L3-05 翻转）", () => {
  // 第七轮把「空 messageId 直接放行、不计数、不记 stamp」钉成了规格（理由：计了就永久占位）。
  // 第八轮 L3-05 推翻：那是限流器 fail-open；stamp 按窗口过期、不是永久占位。两条用例照原场景翻成相反断言，
  // 更完整的覆盖（合成 id 不与真实 id 冲突 / 退还 / 窗口过期 / 回执）在 tests/group-bypass-r8.test.ts。
  it("【L3-05 翻转】空 messageId 照常计数：2 次空 id + 10 次带 id 就占满总额 12，第 13 次被总限额拒", () => {
    const t0 = 6_000_000;
    const counted = { allowed: true, notify: false, counted: true };
    expect(admit("ou_x", "", t0)).toEqual(counted);
    expect(admit("ou_x", "", t0 + 1)).toEqual(counted);
    for (let i = 0; i < 10; i++) {
      expect(admit(`ou_${i}`, `om_${i}`, t0 + 10 + i)).toMatchObject({
        allowed: true,
        counted: true,
      });
    }
    expect(admit("ou_12", "om_12", t0 + 100)).toMatchObject({ allowed: false, scope: "total" });
  });

  it("【L3-05 翻转】空 messageId 占个人额度：同一发送人空 id 调 6 次，前 4 次放行、后 2 次被个人限额拒，之后带 id 的也启动不了", () => {
    const t0 = 6_100_000;
    for (let i = 0; i < 4; i++) {
      expect(admit("ou_x", "", t0 + i), `空 id 第 ${i + 1} 次`).toMatchObject({
        allowed: true,
        counted: true,
      });
    }
    for (let i = 4; i < 6; i++) {
      expect(admit("ou_x", "", t0 + i), `空 id 第 ${i + 1} 次`).toMatchObject({
        allowed: false,
        scope: "sender",
      });
    }
    expect(admit("ou_x", "om_x0", t0 + 20)).toMatchObject({ allowed: false, scope: "sender" });
  });

  it("groupBypassSenderKey：退到展示名时带 name: 前缀；有稳定 id 的口径不变", () => {
    const key = shared.groupBypassSenderKey;
    expect(key({ openId: "", name: "机器人甲" })).toBe("name:机器人甲");
    expect(key({ openId: "", name: "机器人甲" }, [undefined, ""])).toBe("name:机器人甲");
    expect(key({ openId: "ou_a", name: "甲" }, ["ou_a", "cli_c"])).toBe("ou_a");
    expect(key({ openId: "", name: "甲" }, ["", "ou_botopen", "cli_c"])).toBe("ou_botopen");
    // 展示名伪装成别人的 open_id，也不会与真 open_id 同 key
    expect(key({ openId: "", name: "ou_victim" })).not.toBe(
      key({ openId: "ou_victim", name: "x" }),
    );
  });

  it("路由：展示名写成别人 open_id 的无 id 发送人，不与真 ou_real 共用个人额度", async () => {
    // 真 ou_real 用满个人 4 次
    for (let i = 0; i < 4; i++) {
      expect(await route(msg("ou_real", `om_real${i}`))).toMatchObject({ kind: "sent" });
    }
    expect(await route(msg("ou_real", "om_real4"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
    // 无 sender_id、展示名恰好叫 ou_real：这是另一个发送人（走 name: 桶），不该被 ou_real 的额度连坐
    for (let i = 0; i < 4; i++) {
      expect(
        await route(msg("", `om_fake${i}`, { sender_name: "ou_real" })),
        `展示名伪装者第 ${i + 1} 次`,
      ).toMatchObject({ kind: "sent" });
    }
  });
});
