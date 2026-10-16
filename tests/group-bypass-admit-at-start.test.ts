/**
 * 第六轮必修 3：群答疑限流口径修正——名额只在旁路 run「真正启动」的那一刻扣。
 *
 * 口径（对照 group-route.ts injectGroupMessage 里 admit 的位置）：
 *  - 忙线 / 队满 / 槽位 / 启动凭据都通过之后、起 run 之前才计；被忙线或队满拒收、被限流丢弃的都不占名额；
 *  - 排队入队时不计，回放真正起 run 时计一次（回放遇限流静默丢弃该条，不卡后面别人的排队项）；
 *  - 另有每发送人子限额（窗内最多启动 4 次，总上限 12 不变）；
 *  - 同一 message_id 重投不重复计数；
 *  - 起 run 失败（注入抛错 / 非 200）退还名额。
 *
 * 全部走真实的 routeGroupInboundMessage / pumpGroupQuestionQueue，只 mock 最外层的注入与发群消息；
 * 时间类用例用假 Date（不真实等待）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

// 限流 info 事件走真实落盘太重——mock 掉写入口，只断言写了什么
const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn(async () => ({ id: "ev_mock" })),
);
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeOwnedEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "group-bypass-admit-")),
  "data",
);

const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  GROUP_BYPASS_RATE_LIMITED,
  GROUP_RESTRICTED_QUESTION_RUNNING,
  pumpGroupQuestionQueue,
  routeGroupInboundMessage,
} = await import("@/lib/server/feishu-bridge/group-route");
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
const SECRET_BODY = "机密正文-不该进限流提示-7f3a";

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
/** 机器人发件人（sender_type=app） */
const botMsg = (
  sender: string,
  id: string,
  over: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => msg(sender, id, { sender_type: "app", ...over } as never);

const ctx = {
  // 正文含 [图] 就带一张图——带图的问题不入队、忙时直接忙线拒收
  parseContent: async (m: FeishuInboundMessage) => ({
    text: m.content,
    images: m.content.includes("[图]")
      ? [{ data: "aGVsbG8=", mimeType: "image/png" }]
      : [],
    attachments: [],
  }),
  loadBootContext: async () => ({ apiKey: "sk-test", model: { id: "m1" } }),
};
const ctxNoBoot = { ...ctx, loadBootContext: async () => null };

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
  writeOwnedEventAndPublish.mockClear();
  handleTaskQuestionInject = vi.fn(async () => okResp());
  injectPendingAskText = vi.fn(async () => ({ ok: true as const }));
  sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
  installDeps();
});

afterEach(() => {
  vi.useRealTimers();
  while (busyReleasers.length > 0) busyReleasers.pop()!();
  __setGroupRouteDepsForTest(null);
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  shared.__resetGroupReplyStateForTest();
});

const route = (
  m: FeishuInboundMessage,
  c: Parameters<typeof routeGroupInboundMessage>[1] = ctx,
) => routeGroupInboundMessage(m, c);
const sentTexts = (): string[] =>
  sendTextToChat.mock.calls.map((c) => String((c as unknown[])[1]));
const infoEvents = () =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => (c as unknown[])[2] as { kind: string; text: string })
    .filter((e) => e.kind === "info");

/** 本用例里还没解除的忙线登记：afterEach 兜底全部摘掉，断言提前失败也不会把忙线态泄漏给后面的用例 */
const busyReleasers: Array<() => void> = [];
/** 让 task 处于「旁路答疑在飞」的忙线态；返回解除函数（可重复调） */
const goBusy = (): (() => void) => {
  const inFlight = { cancelled: false, cancel: () => {} };
  registerRestrictedQuestion(TASK, inFlight);
  const release = () => unregisterRestrictedQuestion(TASK, inFlight);
  busyReleasers.push(release);
  return release;
};

/** 断言「总额 12 一个没少」：12 个互不相同的发送人依次启动全过、第 13 个被总限额拦下 */
const expectFullTotalQuotaIntact = async (prefix: string, first?: string) => {
  for (let i = 0; i < 12; i++) {
    const sender = i === 0 && first ? first : `ou_${prefix}${i}`;
    const r = await route(msg(sender, `om_${prefix}_go${i}`));
    expect(r, `第 ${i + 1} 个启动`).toMatchObject({ kind: "sent" });
  }
  expect(await route(msg(`ou_${prefix}_over`, `om_${prefix}_over`))).toMatchObject({
    kind: "skipped",
    error: GROUP_BYPASS_RATE_LIMITED,
  });
};

describe("① 被拒收 / 排队 / 凭据不全的消息不占名额", () => {
  it("同一发送人被忙线拒收 13 次（带图不入队）→ 一个名额都不占", async () => {
    const release = goBusy();
    for (let i = 0; i < 13; i++) {
      const r = await route(msg("ou_x", `om_img${i}`, { content: "@Flowship 看图 [图]" }));
      expect(r, `第 ${i + 1} 次`).toMatchObject({
        kind: "skipped",
        error: GROUP_RESTRICTED_QUESTION_RUNNING,
      });
    }
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    release();
    // 总额仍是满的 12（含被拒 13 次的 ou_x 自己）
    await expectFullTotalQuotaIntact("a", "ou_x");
  });

  it("同一发送人被『槽位 / 忙线』拒收 13 次（2 个入队、其余忙线拒）→ 取消排队后名额一个没占", async () => {
    const release = goBusy();
    const results = [];
    for (let i = 0; i < 13; i++) {
      results.push(await route(msg("ou_x", `om_t${i}`)));
    }
    expect(results.filter((r) => r.kind === "queued")).toHaveLength(2);
    expect(
      results.filter(
        (r) => r.kind === "skipped" && r.error === GROUP_RESTRICTED_QUESTION_RUNNING,
      ),
    ).toHaveLength(11);
    // 排队的两条被取消（UI「取消」）：它们从没起过 run，不该占名额
    expect(shared.removeGroupQuestionFromQueue(TASK, "om_t0")).toBe(true);
    expect(shared.removeGroupQuestionFromQueue(TASK, "om_t1")).toBe(true);
    release();
    await expectFullTotalQuotaIntact("b", "ou_x");
  });

  it("队满拒收（10 个槽被占满后的新消息）不占名额", async () => {
    const release = goBusy();
    for (let i = 0; i < 10; i++) {
      expect(await route(msg(`ou_s${i}`, `om_q${i}`))).toMatchObject({ kind: "queued" });
    }
    for (let i = 0; i < 5; i++) {
      expect(await route(msg(`ou_late${i}`, `om_late${i}`))).toMatchObject({
        kind: "skipped",
        error: GROUP_RESTRICTED_QUESTION_RUNNING,
      });
    }
    for (let i = 0; i < 10; i++) {
      expect(shared.removeGroupQuestionFromQueue(TASK, `om_q${i}`)).toBe(true);
    }
    release();
    await expectFullTotalQuotaIntact("c");
  });

  it("入队不计：排队的问题被取消后，名额原样（入队时不扣、回放起 run 时才扣）", async () => {
    const release = goBusy();
    for (let i = 0; i < 3; i++) {
      expect(await route(msg(`ou_q${i}`, `om_qq${i}`))).toMatchObject({ kind: "queued" });
    }
    for (let i = 0; i < 3; i++) shared.removeGroupQuestionFromQueue(TASK, `om_qq${i}`);
    release();
    await expectFullTotalQuotaIntact("d");
  });

  it("启动凭据拿不到（loadBootContext → null）：忙线拒收、不占名额", async () => {
    const release = goBusy();
    expect(await route(msg("ou_x", "om_noboot"), ctxNoBoot)).toMatchObject({
      kind: "skipped",
      error: GROUP_RESTRICTED_QUESTION_RUNNING,
    });
    expect(shared.groupQuestionQueueLength(TASK)).toBe(0);
    release();
    await expectFullTotalQuotaIntact("e");
  });
});

describe("② 排队回放：入队不计，回放真正起 run 时计一次", () => {
  it("回放计在『回放那一刻』而不是入队那一刻（窗口按回放时间起算），且只计一次", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 2_000_000;
    vi.setSystemTime(t0);
    const release = goBusy();
    for (let i = 0; i < 10; i++) {
      expect(await route(msg(`ou_q${i}`, `om_q${i}`))).toMatchObject({ kind: "queued" });
    }
    expect(shared.groupQuestionQueueLength(TASK)).toBe(10);

    // 9 分钟后空闲、回放 10 条：这 10 次启动各计 1（共 10，不是 20）
    const tReplay = t0 + 9 * 60 * 1000;
    vi.setSystemTime(tReplay);
    release();
    await pumpGroupQuestionQueue(TASK);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(10);
    expect(shared.groupQuestionQueueLength(TASK)).toBe(0);
    // 窗里现在恰好 10 个：还剩 2 个名额，第 3 个新到的被总限额拦下
    expect(await route(msg("ou_n1", "om_n1"))).toMatchObject({ kind: "sent" });
    expect(await route(msg("ou_n2", "om_n2"))).toMatchObject({ kind: "sent" });
    expect(await route(msg("ou_n3", "om_n3"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });

    // 入队时刻（t0）起算的话这批早已出窗（t0+10 分钟）；按回放时刻起算则 t0+11 分钟时仍在窗内
    vi.setSystemTime(t0 + 11 * 60 * 1000);
    expect(await route(msg("ou_n4", "om_n4"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
    // 回放那批 + ou_n1/n2 都是 tReplay 起算：窗口滑过 tReplay + 10 分钟后恢复
    vi.setSystemTime(tReplay + 10 * 60 * 1000 + 1000);
    expect(await route(msg("ou_n5", "om_n5"))).toMatchObject({ kind: "sent" });
  });

  it("回放时发送人已到个人上限：丢弃该条（不注入），只给该真人回一句限流提示（第七轮 K2-02），不卡后面别人的排队项", async () => {
    // ou_x 先用满 4 次个人额度（空闲时直接启动）
    for (let i = 0; i < 4; i++) {
      expect(await route(msg("ou_x", `om_x${i}`))).toMatchObject({ kind: "sent" });
    }
    const release = goBusy();
    // 忙线期间：ou_x 的第 5 条与 ou_y 的 1 条都入队（入队不看限额、也不计）
    expect(await route(msg("ou_x", "om_x4"))).toMatchObject({ kind: "queued" });
    expect(await route(msg("ou_y", "om_y0"))).toMatchObject({ kind: "queued" });
    release();
    handleTaskQuestionInject.mockClear();
    sendTextToChat.mockClear();

    await pumpGroupQuestionQueue(TASK);
    // ou_x 那条超个人上限 → 丢；ou_y 那条照常回放
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(
      (handleTaskQuestionInject.mock.calls[0] as unknown[])[1],
    ).toMatchObject({ text: expect.stringContaining("埋点") });
    expect(shared.groupQuestionQueueLength(TASK)).toBe(0);
    // 第六轮口径是「回放丢弃一个字都不发」，可入队时已承诺过「答完就答你」——丢了不交代就是食言。
    // 第七轮 K2-02：对真人提问人（ou_x）回一句限流提示；ou_y 照常回放、没被丢，不收提示。
    // 每窗每人一条的节流、机器人静默、窗口滑过再提示等细节见 group-bypass-r7.test.ts。
    const texts = sentTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('user_id="ou_x"');
    expect(texts[0]).toContain("限流");
  });
});

describe("③ 每发送人子限额（窗内最多启动 4 次，总上限 12 不变）", () => {
  it("同一发送人第 5 次启动被限（静默 + 一条个人限额 info，不带原文）；其他发送人仍可启动", async () => {
    const mk = (id: string) =>
      msg("ou_x", id, { sender_name: "王小明", content: `@Flowship ${SECRET_BODY}` });
    for (let i = 0; i < 4; i++) {
      expect(await route(mk(`om_x${i}`))).toMatchObject({ kind: "sent" });
    }
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(4);
    sendTextToChat.mockClear();

    const r5 = await route(mk("om_x4"));
    expect(r5).toMatchObject({ kind: "skipped", error: GROUP_BYPASS_RATE_LIMITED });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(4);
    expect(sendTextToChat).not.toHaveBeenCalled();
    // 窗内继续发：仍静默、不再写 info（个人限额每窗最多一条）
    expect(await route(mk("om_x5"))).toMatchObject({ kind: "skipped" });
    expect(sendTextToChat).not.toHaveBeenCalled();
    const infos = infoEvents();
    expect(infos).toHaveLength(1);
    expect(infos[0]!.text).toContain("王小明");
    expect(infos[0]!.text).not.toContain(SECRET_BODY);
    // 个人限额的文案不是总限额那条（总限额文案点名「12」）
    expect(infos[0]!.text).toContain("4");

    // 别人不受影响：再起 8 个不同发送人（总计 12）全过，第 13 个才被总限额拦
    for (let i = 0; i < 8; i++) {
      expect(await route(msg(`ou_o${i}`, `om_o${i}`))).toMatchObject({ kind: "sent" });
    }
    expect(await route(msg("ou_o8", "om_o8"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
    // 总限额再写一条 info（与个人限额各一条）、文案区分
    const after = infoEvents();
    expect(after).toHaveLength(2);
    expect(after[1]!.text).toContain("12");
    expect(after[1]!.text).not.toBe(after[0]!.text);
    expect(after[1]!.text).not.toContain("王小明");
  });

  it("机器人发件人同样受个人限额：有 open_id 按 open_id、没 open_id 退回 app_id；互不串桶；全程静默", async () => {
    // A：有 open_id
    for (let i = 0; i < 4; i++) {
      expect(await route(botMsg("ou_bota", `om_a${i}`))).toMatchObject({ kind: "sent" });
    }
    expect(await route(botMsg("ou_bota", "om_a4"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
    // B：sender_id 为空、只有 app_id
    const appOnly = (id: string, app: string) =>
      botMsg("", id, { sender_app_id: app, sender_name: "" } as never);
    for (let i = 0; i < 4; i++) {
      expect(await route(appOnly(`om_b${i}`, "cli_b"))).toMatchObject({ kind: "sent" });
    }
    expect(await route(appOnly("om_b4", "cli_b"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
    // 另一个 app_id 不串桶
    expect(await route(appOnly("om_c0", "cli_c"))).toMatchObject({ kind: "sent" });
    // 被限的机器人收不到任何回群（系统回执对机器人静默 + 限流本就不回群）
    expect(sentTexts()).toEqual([]);
  });
});

describe("④ 同一 message_id 重投不重复计数", () => {
  it("同一条消息重投 3 次只占 1 个总名额：其后还能再起 11 个不同发送人、第 12 个才被拦", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await route(msg("ou_x", "om_dup"))).toMatchObject({ kind: "sent" });
    }
    for (let i = 0; i < 11; i++) {
      expect(await route(msg(`ou_n${i}`, `om_n${i}`))).toMatchObject({ kind: "sent" });
    }
    expect(await route(msg("ou_n11", "om_n11"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
  });

  it("重投同样不重复计个人额度：m1 重投 3 次 + 另外 3 条 = 该人 4 次，第 5 条（新 id）才被限", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await route(msg("ou_x", "om_dup"))).toMatchObject({ kind: "sent" });
    }
    for (let i = 0; i < 3; i++) {
      expect(await route(msg("ou_x", `om_m${i}`))).toMatchObject({ kind: "sent" });
    }
    expect(await route(msg("ou_x", "om_m3"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
  });
});

describe("⑤ 起 run 失败退还名额", () => {
  it("注入抛错（可重试失败）13 次不占名额：之后 12 个不同发送人仍能全部启动", async () => {
    handleTaskQuestionInject.mockImplementation(async () => {
      throw new Error("boom");
    });
    for (let i = 0; i < 13; i++) {
      expect(await route(msg(`ou_f${i}`, `om_f${i}`))).toMatchObject({
        kind: "failed",
        retryable: true,
      });
    }
    handleTaskQuestionInject.mockImplementation(async () => okResp());
    await expectFullTotalQuotaIntact("g");
  });

  it("注入回 409（起 run 前被 stale 闸拦下）13 次不占名额", async () => {
    handleTaskQuestionInject.mockImplementation(
      async () => new Response(JSON.stringify({ error: "stale" }), { status: 409 }),
    );
    for (let i = 0; i < 13; i++) {
      expect(await route(msg(`ou_f${i}`, `om_f${i}`))).toMatchObject({ kind: "failed" });
    }
    handleTaskQuestionInject.mockImplementation(async () => okResp());
    await expectFullTotalQuotaIntact("h");
  });

  it("失败后飞书重投同一 message_id 重试成功：总共只占 1 个名额", async () => {
    handleTaskQuestionInject.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    expect(await route(msg("ou_x", "om_retry"))).toMatchObject({ kind: "failed" });
    expect(await route(msg("ou_x", "om_retry"))).toMatchObject({ kind: "sent" });
    for (let i = 0; i < 11; i++) {
      expect(await route(msg(`ou_n${i}`, `om_n${i}`))).toMatchObject({ kind: "sent" });
    }
    expect(await route(msg("ou_n11", "om_n11"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
  });
});

describe("⑥ 答 pendingAsk 的竞态落回旁路 run 时也要过准入", () => {
  it("no_pending 落回旁路：计入个人额度，超限时静默丢弃且不留登记", async () => {
    injectPendingAskText.mockImplementation(async () => ({
      ok: false as const,
      reason: "no_pending" as const,
      error: "没有待答提问",
    }));
    installDeps({ getPendingAsk: () => ({ askId: "ask-1", questions: [] }) });
    for (let i = 0; i < 4; i++) {
      expect(await route(msg("ou_x", `om_p${i}`))).toMatchObject({ kind: "sent" });
    }
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(4);
    const r5 = await route(msg("ou_x", "om_p4"));
    expect(r5).toMatchObject({ kind: "skipped", error: GROUP_BYPASS_RATE_LIMITED });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(4);
    // 被限流的这条不能留回群登记（否则下一轮无关的 done 会把别人的回答 @ 给它）
    expect(
      shared.listGroupReplies(TASK).some((e) => e.sourceMessageId === "om_p4"),
    ).toBe(false);
  });
});

describe("⑦ 被限流丢弃的消息不能对回群登记有副作用", () => {
  it("限流丢弃发生在登记之前：已有登记（含容量上限处的最老一条）原样不动", async () => {
    // 12 个不同发送人启动 → 登记表里按容量上限 8 条封顶
    for (let i = 0; i < 12; i++) {
      expect(await route(msg(`ou_n${i}`, `om_n${i}`))).toMatchObject({ kind: "sent" });
    }
    const before = shared.listGroupReplies(TASK).map((e) => e.token);
    expect(before.length).toBeGreaterThanOrEqual(8);
    expect(await route(msg("ou_late", "om_late"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
    expect(shared.listGroupReplies(TASK).map((e) => e.token)).toEqual(before);
  });
});

describe("⑧ 现有总限额口径不变", () => {
  it("12 个不同发送人启动后第 13 个静默丢弃，只写一条总限额 info（文案点名 12）", async () => {
    for (let i = 0; i < 12; i++) {
      expect(await route(msg(`ou_u${i}`, `om_${i}`))).toMatchObject({ kind: "sent" });
    }
    sendTextToChat.mockClear();
    expect(await route(msg("ou_u13", "om_13"))).toMatchObject({
      kind: "skipped",
      error: GROUP_BYPASS_RATE_LIMITED,
    });
    expect(await route(msg("ou_u14", "om_14"))).toMatchObject({ kind: "skipped" });
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(infoEvents()).toHaveLength(1);
    expect(infoEvents()[0]!.text).toContain("12");
  });

  it("属主自己不受限、不占名额", async () => {
    for (let i = 0; i < 15; i++) {
      expect(await route(msg(OWNER, `om_o${i}`, { content: "@Flowship 继续" }))).toMatchObject({
        kind: "sent",
      });
    }
    await expectFullTotalQuotaIntact("i");
  });
});
