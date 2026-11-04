/**
 * 设置「受理群里其他机器人的 @」（feishuGroupAllowBots，默认开，2026-11-04 起）。
 *
 * 分层钉死：
 * - 准入闸 decideRestrictedQaAdmission：allowBots 缺省 / false = 老口径（拒）；true 才放过机器人；租户 / 外部闸照常
 * - 设置读取 isGroupBotsAllowed：文件不存在 → 默认开；显式 false → 关；缺字段 → 开；**文件坏 → 关（fail-closed）**
 * - 路由（真实 routeGroupInboundMessage、mock 注入与发群消息）：
 *   · 有活会话：机器人并入同会话（groupNonOwner.isBot=true、抬头写「机器人，」、meta 带 groupSenderIsBot）；系统回执静默
 *   · 忙：入 group_other 队列（senderIsBot），不向群里回「收到」（对机器人静默）
 *   · 没有活会话：走只读旁路（降级通道），不是唤醒；机器人同样受 per-sender 限流
 *   · 设置关：机器人整条静默被拒（对照）
 * - 提示词：机器人变体约束段（必须自己写 @名字、没问实质问题 NO_REPLY、不客套）；真人变体字面不变
 *
 * 全 mock 外部调用——禁止真调飞书。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

const TMP = mkdtempSync(path.join(os.tmpdir(), "fe-group-bots-allowed-"));
const DATA = path.join(TMP, "data");
mkdirSync(DATA, { recursive: true });
process.env.FLOWSHIP_DATA_DIR = DATA;

const { decideRestrictedQaAdmission } = await import(
  "@/lib/server/feishu-bridge/restricted-qa-gate"
);
const { __setGroupBotsAllowedForTest, isGroupBotsAllowed } = await import(
  "@/lib/server/group-non-owner-guard-config"
);
const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  GROUP_RESTRICTED_QA_DENIED,
  routeGroupInboundMessage,
} = await import("@/lib/server/feishu-bridge/group-route");
const {
  __resetGroupAdvancePickForTest,
  __resetGroupReplyStateForTest,
  __resetThrottleForTest,
  GROUP_BYPASS_RUN_WINDOW_MAX_PER_SENDER,
  listGroupReplies,
} = await import("@/lib/server/feishu-bridge/group-shared");
const { __resetOutboundRegistryForTest } = await import(
  "@/lib/server/feishu-bridge/group-outbound-registry"
);
const { agentSessions } = await import("@/lib/server/task-stream");
const { buildNonOwnerGuardFootnote, buildNonOwnerGroupHeader } = await import(
  "@/lib/group-non-owner-prompt"
);

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------- 准入闸（纯函数）

describe("准入闸：allowBots", () => {
  const botInput = { senderIsBot: true };

  it("缺省 / false = 老口径：机器人被拒（旧调用点与旧单测零影响）", () => {
    expect(decideRestrictedQaAdmission(botInput)).toEqual({
      allow: false,
      reason: "bot_sender",
    });
    expect(decideRestrictedQaAdmission({ ...botInput, allowBots: false })).toEqual({
      allow: false,
      reason: "bot_sender",
    });
  });

  it("allowBots:true：机器人放行；真人不受影响", () => {
    expect(decideRestrictedQaAdmission({ ...botInput, allowBots: true })).toEqual({
      allow: true,
    });
    expect(decideRestrictedQaAdmission({ senderIsBot: false, allowBots: true })).toEqual({
      allow: true,
    });
  });

  it("放开机器人不等于放开别的闸：租户不一致 / 外部成员照样拒（原因顺序里 bot_sender 不再挡在前面）", () => {
    expect(
      decideRestrictedQaAdmission({
        ...botInput,
        allowBots: true,
        senderTenantKey: "t_a",
        ownTenantKey: "t_b",
      }),
    ).toEqual({ allow: false, reason: "tenant_mismatch" });
    expect(
      decideRestrictedQaAdmission({ ...botInput, allowBots: true, senderExternal: true }),
    ).toEqual({ allow: false, reason: "external_member" });
  });
});

// ---------------------------------------------------------------- 设置读取

describe("isGroupBotsAllowed（读真实设置文件）", () => {
  const cfg = path.join(DATA, "config.json");
  beforeEach(() => __setGroupBotsAllowedForTest(null));
  afterEach(() => rmSync(cfg, { force: true }));

  it("设置文件不存在（首次启动）→ 默认开", async () => {
    expect(await isGroupBotsAllowed()).toBe(true);
  });

  it("文件在、没有这个字段 → 开（缺省 = 开）", async () => {
    writeFileSync(cfg, JSON.stringify({ feishuChatBridge: true }));
    expect(await isGroupBotsAllowed()).toBe(true);
  });

  it("显式 false → 关；显式 true → 开", async () => {
    writeFileSync(cfg, JSON.stringify({ feishuGroupAllowBots: false }));
    expect(await isGroupBotsAllowed()).toBe(false);
    writeFileSync(cfg, JSON.stringify({ feishuGroupAllowBots: true }));
    expect(await isGroupBotsAllowed()).toBe(true);
  });

  it("文件坏（JSON 不合法）→ 关（fail-closed：这是放开准入、读不准就别放）", async () => {
    writeFileSync(cfg, "{ not json");
    expect(await isGroupBotsAllowed()).toBe(false);
  });

  it("读设置**抛错**（不是 status 非 ok，而是 readSettingsFile 直接 reject）：机器人 → 关（fail-closed）；提示词开关 → 开（默认）", async () => {
    // 第 20 轮评审 M5b：现有用例只钉了 status !== "ok" 分支，没钉 catch 分支；
    // 文档写的是「两者都 fail-closed」。用 doMock 换掉 settings-fs，在全新模块实例里验证
    vi.resetModules();
    vi.doMock("@/lib/server/settings-fs", () => ({
      readSettingsFile: async () => {
        throw new Error("EIO: simulated disk failure");
      },
    }));
    try {
      const fresh = await import("@/lib/server/group-non-owner-guard-config");
      fresh.__setGroupBotsAllowedForTest(null);
      expect(await fresh.isGroupBotsAllowed()).toBe(false);
      // 提示词开关是相反方向的 fail-safe：读不到 → 取默认（开），宁可多约束
      expect(await fresh.isGroupNonOwnerGuardEnabled()).toBe(true);
    } finally {
      vi.doUnmock("@/lib/server/settings-fs");
      vi.resetModules();
    }
  });

  it("单测覆盖优先于读盘（false 钉住老口径、null 还原）", async () => {
    writeFileSync(cfg, JSON.stringify({ feishuGroupAllowBots: true }));
    __setGroupBotsAllowedForTest(false);
    expect(await isGroupBotsAllowed()).toBe(false);
    __setGroupBotsAllowedForTest(null);
    expect(await isGroupBotsAllowed()).toBe(true);
  });
});

// ---------------------------------------------------------------- 提示词

describe("提示词：机器人变体", () => {
  it("机器人变体：必须自己写 @名字 / 没问实质问题 NO_REPLY / 别客套；仍是最后一段的约束（只答疑、不改文件）", () => {
    const t = buildNonOwnerGuardFootnote("别家机器人", { isBot: true });
    expect(t).toContain("机器人「别家机器人」");
    expect(t).toContain("必须在正文里写 @别家机器人");
    expect(t).toContain("NO_REPLY");
    expect(t).toContain("别回「收到」");
    expect(t).toContain("不修改任何文件");
    expect(t).toContain("不调用 submit_work");
    expect(t.endsWith("处理完自然结束本轮回复。）")).toBe(true);
  });

  it("真人变体字面不变：不提机器人、有「想 @ 提问人就写」", () => {
    const t = buildNonOwnerGuardFootnote("李四");
    expect(t).toContain("非任务所有者「李四」");
    expect(t).toContain("想 @ 提问人就写 @李四");
    expect(t).not.toContain("机器人");
    // isBot:false 与不传等价
    expect(buildNonOwnerGuardFootnote("李四", { isBot: false })).toBe(t);
  });

  it("抬头：机器人写「机器人，」", () => {
    expect(buildNonOwnerGroupHeader({ name: "别家机器人", isBot: true })).toBe(
      "[群消息·来自 别家机器人（机器人，非任务所有者）]",
    );
  });
});

// ---------------------------------------------------------------- 路由

const OWNER = "ou_owner";
const BOT = "ou_bot";
const CHAT = "oc_req_group";
const OTHER_BOT = "ou_otherbot";

const botMsg = (over: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage =>
  ({
    type: "im.message.receive_v1",
    message_id: "om_b1",
    create_time: String(Date.now()),
    chat_id: CHAT,
    chat_type: "group",
    message_type: "text",
    sender_id: OTHER_BOT,
    sender_name: "别家机器人",
    sender_type: "app",
    content: "@Flowship 这个接口返回啥？",
    mentions: [{ key: "@_user_1", openId: BOT, name: "Flowship" }],
    ...over,
  }) as FeishuInboundMessage;

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
const queuedRes = () => jsonRes({ ok: true, queued: true, itemId: "tq_1", position: 1 }, 202);

const baseDeps = (over: Record<string, unknown> = {}) => ({
  getBotAppInfo: async () => ({ appId: "cli_self", ownerOpenId: OWNER }),
  getBotOpenId: async () => BOT,
  getBotDisplayName: async () => "Flowship",
  sendTextToChat: vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" })),
  sendCardToChat: vi.fn(async () => ({ chat_id: CHAT, message_id: "om_card", card_id: "c1" })),
  listTasks: async () => [taskSummary()],
  getTask: async () => fullTask(),
  getBoundGroupChatId: async () => CHAT,
  listAdvanceOptions: vi.fn(async () => []),
  getPendingAsk: () => null,
  injectPendingAskText: vi.fn(async () => ({ ok: true as const })),
  handleChatReplyInject: vi.fn(async () => jsonRes({ ok: true }, 200)),
  handleTaskQuestionInject: vi.fn(async () => jsonRes({ ok: true }, 200)),
  advanceTask: vi.fn(async () => ({ action: { id: "act-1" } })),
  isAdvanceResultToGroupEnabled: async () => true,
  ...over,
});
const callArgs = (fn: unknown, i = 0): unknown[] =>
  ((fn as { mock: { calls: unknown[][] } }).mock.calls as unknown[][])[i] ?? [];
const bodyOf = (fn: unknown, i = 0) => (callArgs(fn, i)[1] ?? {}) as Record<string, unknown>;
const optsOf = (fn: unknown, i = 0) => (callArgs(fn, i)[2] ?? {}) as Record<string, unknown>;
const metaOf = (fn: unknown, i = 0) =>
  (optsOf(fn, i).userReplyMetaExtra ?? {}) as Record<string, unknown>;

beforeEach(() => {
  __setGroupBotsAllowedForTest(true);
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
  __resetGroupAdvancePickForTest();
  __resetThrottleForTest();
});
afterEach(() => {
  __setGroupBotsAllowedForTest(null);
  __setGroupRouteDepsForTest(null);
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
  __resetGroupAdvancePickForTest();
  __resetOutboundRegistryForTest();
  agentSessions.delete("task-1");
});

describe("路由：设置开（默认）+ 有活会话 → 机器人并入同会话", () => {
  it("注入参数：groupNonOwner.isBot=true、非只读通道；抬头写「机器人，」；meta 带 groupSenderIsBot + groupNonOwnerTurn；不预登记；系统回执静默", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () => jsonRes({ ok: true }, 200));
    const sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject, sendTextToChat }) as never);

    const r = await routeGroupInboundMessage(botMsg(), ctx);

    expect(r).toMatchObject({ kind: "sent", taskId: "task-1" });
    expect(optsOf(handleTaskQuestionInject)).toMatchObject({
      restrictToQuestion: false,
      groupNonOwner: { name: "别家机器人", isBot: true },
    });
    expect(String(bodyOf(handleTaskQuestionInject).text).startsWith(
      "[群消息·来自 别家机器人（机器人，非任务所有者）]\n",
    )).toBe(true);
    expect(metaOf(handleTaskQuestionInject)).toMatchObject({
      groupSenderIsBot: true,
      groupNonOwnerTurn: true,
      groupSenderOpenId: OTHER_BOT,
    });
    expect(listGroupReplies("task-1")).toHaveLength(0);
    expect(sendTextToChat).not.toHaveBeenCalled();
  });

  it("主链在跑：入 group_other 队列（senderIsBot），群里**不回**「收到，这轮跑完就答你」（对机器人静默防环）", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () => queuedRes());
    const sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
    __setGroupRouteDepsForTest(
      baseDeps({
        handleTaskQuestionInject,
        sendTextToChat,
        getTask: async () => fullTask({ runStatus: "running" }),
        listTasks: async () => [taskSummary({ runStatus: "running" })],
      }) as never,
    );
    const r = await routeGroupInboundMessage(botMsg(), ctx);
    expect(r).toMatchObject({ kind: "queued", taskId: "task-1" });
    expect(optsOf(handleTaskQuestionInject).queueIfBusy).toMatchObject({
      source: "group_other",
      senderIsBot: true,
      senderKey: OTHER_BOT,
    });
    expect(sendTextToChat).not.toHaveBeenCalled();
  });

  it("机器人同样受 per-sender 限流（防互 @ 成环的速率兜底）：同一机器人窗口内第 N+1 次被静默丢弃", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () => queuedRes());
    const sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
    __setGroupRouteDepsForTest(
      baseDeps({
        handleTaskQuestionInject,
        sendTextToChat,
        getTask: async () => fullTask({ runStatus: "running" }),
        listTasks: async () => [taskSummary({ runStatus: "running" })],
      }) as never,
    );
    const n = GROUP_BYPASS_RUN_WINDOW_MAX_PER_SENDER;
    for (let i = 0; i < n; i++) {
      const r = await routeGroupInboundMessage(botMsg({ message_id: `om_b${i}` }), ctx);
      expect(r).toMatchObject({ kind: "queued" });
    }
    const over = await routeGroupInboundMessage(botMsg({ message_id: "om_over" }), ctx);
    expect(over.kind).not.toBe("queued");
    expect(over.kind).not.toBe("sent");
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(n);
    // 限流丢弃对机器人静默（不给对端喂噪音）
    expect(sendTextToChat).not.toHaveBeenCalled();
  });

  it("没有活会话：走只读旁路（降级通道）——不是唤醒；预登记 restricted 且标记机器人", async () => {
    // 不 set agentSessions
    const handleTaskQuestionInject = vi.fn(async () => jsonRes({ ok: true }, 200));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);
    await routeGroupInboundMessage(botMsg(), ctx);
    const opts = optsOf(handleTaskQuestionInject);
    expect(opts).toMatchObject({ restrictToQuestion: true });
    expect(opts).not.toHaveProperty("groupNonOwner");
    expect(metaOf(handleTaskQuestionInject)).toMatchObject({ groupSenderIsBot: true });
    const regs = listGroupReplies("task-1");
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ requesterIsBot: true });
  });
});

describe("路由：设置关 → 机器人整条静默被拒（对照）", () => {
  it("有活会话也一样：不注入、不排队、不回群，结果 skipped + GROUP_RESTRICTED_QA_DENIED", async () => {
    __setGroupBotsAllowedForTest(false);
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () => jsonRes({ ok: true }, 200));
    const sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject, sendTextToChat }) as never);
    const r = await routeGroupInboundMessage(botMsg(), ctx);
    expect(r).toMatchObject({ kind: "skipped", error: GROUP_RESTRICTED_QA_DENIED });
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(sendTextToChat).not.toHaveBeenCalled();
  });

  it("设置读不到（文件坏）同样拒（fail-closed）：走真实读取而不是覆盖", async () => {
    __setGroupBotsAllowedForTest(null);
    writeFileSync(path.join(DATA, "config.json"), "{ not json");
    try {
      agentSessions.set("task-1", {} as never);
      const handleTaskQuestionInject = vi.fn(async () => jsonRes({ ok: true }, 200));
      __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);
      const r = await routeGroupInboundMessage(botMsg(), ctx);
      expect(r).toMatchObject({ kind: "skipped", error: GROUP_RESTRICTED_QA_DENIED });
      expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    } finally {
      rmSync(path.join(DATA, "config.json"), { force: true });
    }
  });

  it("真人不受这个设置影响（设置关时真人照常并入同会话，且不为它读设置）", async () => {
    __setGroupBotsAllowedForTest(false);
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () => jsonRes({ ok: true }, 200));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);
    const r = await routeGroupInboundMessage(
      botMsg({ sender_id: "ou_stranger", sender_name: "李四", sender_type: undefined }),
      ctx,
    );
    expect(r).toMatchObject({ kind: "sent" });
    expect(optsOf(handleTaskQuestionInject)).toMatchObject({
      groupNonOwner: { name: "李四" },
    });
    expect(optsOf(handleTaskQuestionInject).groupNonOwner).not.toHaveProperty("isBot");
  });
});
