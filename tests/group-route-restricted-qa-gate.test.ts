/**
 * 群答疑（受限问答 / 旁路）准入闸——路由级，走真实 routeGroupInboundMessage / pump，
 * 只 mock 最外层的注入与发群消息 / 事件写盘：
 *
 * ① 默认放行（第 11 轮起**没有「按群开关」**：用户决定「答疑默认开、不要开关」）：已绑定需求群里的非属主真人 @ 机器人 →
 *   放行并以受限问答（restrictToQuestion）注入；盘上老 meta 里残留的 `feishuGroupRestrictedQa`（true / false / 缺省）
 *   一律被忽略、不会再挡放行（路由层绝不能再看它）；属主自己不受影响。
 * ② 发件人校验：机器人发件人拒（静默忽略：不回群、不注入、不排队、不占限流名额，只给属主留一条节流的 info 事件
 *   meta.subkind=restricted_qa_denied）；租户两边都拿到且不一致拒；任一边拿不到不拦；租户本机信息由「属主自己的群消息」学来。
 *   注意（R7-2）：生产里真正生效的只有机器人发件人拒；租户这一道要事件带「确属发件人」的 tenant_key，
 *   当前 lark-cli compact 事件里没有，生产里恒不拦——下面的租户用例钉的是「将来数据源补上后的语义」。
 * - 放行范围：答 pendingAsk 不经早期闸（它在答属主的提问），但 no_pending 落回旁路时补过闸（机器人发件人仍拒）；
 * - 排队回放：排队的真人问题在回放时同样放行并注入；机器人发件人根本进不了队。
 */
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
  os.tmpdir(),
  `group-route-restricted-qa-gate-${Date.now()}`,
  "data",
);

const {
  GROUP_RESTRICTED_QA_DENIED,
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
const { __resetOwnTenantKeyForTest } = await import(
  "@/lib/server/feishu-bridge/restricted-qa-gate"
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

/**
 * 任务夹具。`legacyQa` 模拟「盘上老 meta 里残留的旧开关字段」（true / false / 不设）：
 * 字段已不在 Task 类型里，读盘时也会被丢弃；这里直接塞进对象，是为了证明路由层不会再看它。
 */
const taskWith = (legacyQa?: boolean): Task =>
  ({
    ...taskSummary(),
    actions: [],
    events: [],
    ...(legacyQa === undefined ? {} : { feishuGroupRestrictedQa: legacyQa }),
  }) as unknown as Task;

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
const botMsg = (id: string, over: Partial<FeishuInboundMessage> = {}) =>
  msg("ou_otherbot", id, { sender_type: "app", ...over } as never);

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

const installDeps = (legacyQa?: boolean, over: Record<string, unknown> = {}) =>
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
    getTask: async () => taskWith(legacyQa),
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
  __resetOwnTenantKeyForTest();
  shared.__resetGroupReplyStateForTest();
  shared.__resetThrottleForTest();
  writeOwnedEventAndPublish.mockClear();
  handleTaskQuestionInject = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  injectPendingAskText = vi.fn(async () => ({ ok: true as const }));
  sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
  installDeps();
});

afterEach(() => {
  __setGroupRouteDepsForTest(null);
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  __resetOwnTenantKeyForTest();
  shared.__resetGroupReplyStateForTest();
  shared.__resetThrottleForTest();
});

const denyEvents = () =>
  writeOwnedEventAndPublish.mock.calls
    .map(
      (c) =>
        (c as unknown[])[2] as {
          kind: string;
          text: string;
          meta?: { subkind?: string; reason?: string };
        },
    )
    .filter((e) => e.kind === "info" && e.meta?.subkind === "restricted_qa_denied");

const expectSilentlyDenied = (r: unknown) => {
  expect(r).toMatchObject({ kind: "skipped", error: GROUP_RESTRICTED_QA_DENIED });
  expect(handleTaskQuestionInject).not.toHaveBeenCalled();
  expect(injectPendingAskText).not.toHaveBeenCalled();
  expect(sendTextToChat).not.toHaveBeenCalled();
  expect(shared.groupQuestionQueueLength(TASK)).toBe(0);
};

describe("① 默认放行（没有按群开关）", () => {
  it("缺省（任务上没有任何开关字段）：非属主真人 @ 机器人 → 放行，并以受限问答（restrictToQuestion）注入", async () => {
    const r = await routeGroupInboundMessage(msg("ou_li", "om_ok"), ctx);
    expect(r).toMatchObject({ kind: "sent" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    const opts = handleTaskQuestionInject.mock.calls[0]![2] as { restrictToQuestion?: boolean };
    expect(opts.restrictToQuestion).toBe(true);
    expect(denyEvents()).toHaveLength(0);
    expect(shared.groupQuestionQueueLength(TASK)).toBe(0);
  });

  it.each([[false], [true]])(
    "老 meta 里残留 feishuGroupRestrictedQa=%s：字段被忽略，照样放行（证明路由层不再看这个字段）",
    async (legacy) => {
      installDeps(legacy);
      const r = await routeGroupInboundMessage(msg("ou_li", "om_legacy"), ctx);
      expect(r).toMatchObject({ kind: "sent" });
      expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
      const opts = handleTaskQuestionInject.mock.calls[0]![2] as { restrictToQuestion?: boolean };
      expect(opts.restrictToQuestion).toBe(true);
      expect(denyEvents()).toHaveLength(0);
    },
  );

  it("被拒的机器人消息不占旁路限流名额：之后同一个真人照常能连发满 4 次个人额度", async () => {
    for (let i = 0; i < 6; i++) {
      expectSilentlyDenied(await routeGroupInboundMessage(botMsg(`om_d${i}`), ctx));
    }
    handleTaskQuestionInject.mockClear();
    for (let i = 0; i < 4; i++) {
      expect(
        await routeGroupInboundMessage(msg("ou_li", `om_ok${i}`), ctx),
      ).toMatchObject({ kind: "sent" });
    }
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(4);
  });

  it("属主自己的消息：照常注入，且不走受限通道", async () => {
    const r = await routeGroupInboundMessage(msg(OWNER, "om_owner"), ctx);
    expect(r).toMatchObject({ kind: "sent" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    const opts = handleTaskQuestionInject.mock.calls[0]![2] as { restrictToQuestion?: boolean };
    expect(opts.restrictToQuestion).not.toBe(true);
    expect(denyEvents()).toHaveLength(0);
  });
});

describe("② 发件人校验", () => {
  it("机器人发件人（sender_type=app）：拒，原因 bot_sender；事件文案不泄漏消息原文", async () => {
    const r = await routeGroupInboundMessage(botMsg("om_b1"), ctx);
    expectSilentlyDenied(r);
    const evs = denyEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0]!.meta?.reason).toBe("bot_sender");
    expect(evs[0]!.text).not.toContain("埋点查了吗");
  });

  it("事件限频：同一原因一分钟内只写 1 条，不刷盘；消息仍每条都被拒", async () => {
    for (let i = 0; i < 5; i++) {
      expectSilentlyDenied(await routeGroupInboundMessage(botMsg(`om_n${i}`), ctx));
    }
    expect(denyEvents()).toHaveLength(1);
  });

  it("机器人发件人在旁路忙线时也不排队（闸先于忙线判定）", async () => {
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(TASK, inFlight);
    try {
      const r = await routeGroupInboundMessage(botMsg("om_b2"), ctx);
      expectSilentlyDenied(r);
    } finally {
      unregisterRestrictedQuestion(TASK, inFlight);
    }
  });

  it("租户：属主先发过（学到本租户 t_own）→ 非属主 t_other 被拒 tenant_mismatch；t_own 放行", async () => {
    expect(
      await routeGroupInboundMessage(
        msg(OWNER, "om_o", { sender_tenant_key: "t_own" } as never),
        ctx,
      ),
    ).toMatchObject({ kind: "sent" });
    handleTaskQuestionInject.mockClear();

    const denied = await routeGroupInboundMessage(
      msg("ou_ext", "om_x1", { sender_tenant_key: "t_other" } as never),
      ctx,
    );
    expectSilentlyDenied(denied);
    expect(denyEvents()[0]!.meta?.reason).toBe("tenant_mismatch");

    const ok = await routeGroupInboundMessage(
      msg("ou_in", "om_x2", { sender_tenant_key: "t_own" } as never),
      ctx,
    );
    expect(ok).toMatchObject({ kind: "sent" });
  });

  it("租户：属主还没发过（本租户未知）→ 即使事件带 tenant_key 也不拦（不猜）", async () => {
    const r = await routeGroupInboundMessage(
      msg("ou_ext", "om_x3", { sender_tenant_key: "t_other" } as never),
      ctx,
    );
    expect(r).toMatchObject({ kind: "sent" });
  });

  it("租户：本租户已知但事件不带 tenant_key → 不拦", async () => {
    await routeGroupInboundMessage(
      msg(OWNER, "om_o2", { sender_tenant_key: "t_own" } as never),
      ctx,
    );
    const r = await routeGroupInboundMessage(msg("ou_in", "om_x4"), ctx);
    expect(r).toMatchObject({ kind: "sent" });
  });

  it("本租户只从「属主的真人消息」学：非属主带的 tenant_key 学不进去（否则外部人先发一条就能把本租户改成自己的）", async () => {
    // 属主还没发过 → 本租户未知。两个非属主分别带不同 tenant_key：都该放行（谁也不是「本租户」）
    expect(
      await routeGroupInboundMessage(
        msg("ou_a", "om_e1", { sender_tenant_key: "t_a" } as never),
        ctx,
      ),
    ).toMatchObject({ kind: "sent" });
    expect(
      await routeGroupInboundMessage(
        msg("ou_b", "om_e2", { sender_tenant_key: "t_b" } as never),
        ctx,
      ),
    ).toMatchObject({ kind: "sent" });
    expect(denyEvents()).toHaveLength(0);
  });

  it("机器人属主身份学不进本租户（只学 !senderIsBot 的属主消息）", async () => {
    // 属主 open_id 但标成 app 发件人（异常数据）：不学
    await routeGroupInboundMessage(
      msg(OWNER, "om_ob", { sender_type: "app", sender_tenant_key: "t_bot" } as never),
      ctx,
    );
    const r = await routeGroupInboundMessage(
      msg("ou_in", "om_after", { sender_tenant_key: "t_real" } as never),
      ctx,
    );
    expect(r).toMatchObject({ kind: "sent" });
  });
});

describe("放行范围与迟到闸", () => {
  it("非属主答 pendingAsk：照常当答案（不经早期闸，它在答属主的提问）", async () => {
    installDeps(undefined, { getPendingAsk: () => ({ askId: "ask-1", questions: [] }) });
    const r = await routeGroupInboundMessage(msg("ou_li", "om_ans"), ctx);
    expect(r).toMatchObject({ kind: "sent" });
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(denyEvents()).toHaveLength(0);
  });

  const noPendingDeps = () => ({
    getPendingAsk: () => ({ askId: "ask-1", questions: [] }),
    injectPendingAskText: vi.fn(async () => ({
      ok: false as const,
      reason: "no_pending" as const,
      error: "no pending",
    })),
  });

  it("pendingAsk 撞 no_pending 落回旁路：机器人发件人 → 迟到闸拒绝，不起旁路、不回群", async () => {
    installDeps(undefined, noPendingDeps());
    const r = await routeGroupInboundMessage(botMsg("om_np_bot"), ctx);
    expect(r).toMatchObject({ kind: "skipped", error: GROUP_RESTRICTED_QA_DENIED });
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(denyEvents()).toHaveLength(1);
    expect(denyEvents()[0]!.meta?.reason).toBe("bot_sender");
  });

  it("pendingAsk 撞 no_pending 落回旁路：真人 → 迟到闸放行，照常起受限答疑（不看老 meta 残留的开关）", async () => {
    installDeps(false, noPendingDeps());
    const r = await routeGroupInboundMessage(msg("ou_li", "om_np_human"), ctx);
    expect(r).toMatchObject({ kind: "sent" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    const opts = handleTaskQuestionInject.mock.calls[0]![2] as { restrictToQuestion?: boolean };
    expect(opts.restrictToQuestion).toBe(true);
    expect(denyEvents()).toHaveLength(0);
  });

  it("排队回放：入队时旁路在忙，排队的真人问题回放时同样放行并以受限问答注入（老 meta 残留 false 也不挡）", async () => {
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(TASK, inFlight);
    try {
      expect(await routeGroupInboundMessage(msg("ou_li", "om_q1"), ctx)).toMatchObject({
        kind: "queued",
      });
    } finally {
      unregisterRestrictedQuestion(TASK, inFlight);
    }
    expect(shared.groupQuestionQueueLength(TASK)).toBe(1);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();

    // 回放时盘上任务带着老 meta 残留的 false：照样放行
    installDeps(false);
    await pumpGroupQuestionQueue(TASK);

    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    const opts = handleTaskQuestionInject.mock.calls[0]![2] as { restrictToQuestion?: boolean };
    expect(opts.restrictToQuestion).toBe(true);
    expect(shared.groupQuestionQueueLength(TASK)).toBe(0);
    expect(denyEvents()).toHaveLength(0);
  });

  it("机器人发件人进不了队：旁路忙线时机器人消息被闸静默拒、队列保持为空", async () => {
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(TASK, inFlight);
    try {
      expectSilentlyDenied(await routeGroupInboundMessage(botMsg("om_q_bot"), ctx));
    } finally {
      unregisterRestrictedQuestion(TASK, inFlight);
    }
    await pumpGroupQuestionQueue(TASK);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(shared.groupQuestionQueueLength(TASK)).toBe(0);
  });
});
