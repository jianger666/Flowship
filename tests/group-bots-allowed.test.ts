/**
 * 群里其他机器人的 @：一律受理、和真人一致（2026-11-04 放开；2026-11-05 起连设置项也去掉了，不需要配置）。
 *
 * 分层钉死：
 * - 准入闸 decideRestrictedQaAdmission：allowBots 缺省 / false = 老口径（拒，只剩单测覆盖缝能走到）；true 才放过机器人；租户 / 外部闸照常
 * - isGroupBotsAllowed：**恒为 true**，不读设置文件（旧版本存下的 feishuGroupAllowBots 键、文件坏、读盘抛错都不影响）；
 *   仅 `__setGroupBotsAllowedForTest(false)` 能压成 false（给 6 个老测试文件钉「机器人被拒」旧路径）
 * - 路由（真实 routeGroupInboundMessage、mock 注入与发群消息）：
 *   · 有活会话：机器人并入同会话（groupNonOwner.isBot=true、抬头写「机器人，」、meta 带 groupSenderIsBot）；系统回执静默
 *   · 忙：入 group_other 队列（senderIsBot），不向群里回「收到」（对机器人静默）
 *   · 没有活会话：走只读旁路（降级通道），不是唤醒；机器人同样受 per-sender 限流
 *   · 覆盖缝压成「不受理」：机器人整条静默被拒（对照，生产里走不到）
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

// ---------------------------------------------------------------- 恒受理（没有设置项）

describe("isGroupBotsAllowed（没有设置项：恒受理）", () => {
  const cfg = path.join(DATA, "config.json");
  beforeEach(() => __setGroupBotsAllowedForTest(null));
  afterEach(() => rmSync(cfg, { force: true }));

  it("设置文件不存在（首次启动）→ 受理", async () => {
    expect(await isGroupBotsAllowed()).toBe(true);
  });

  it("旧版本存下的 feishuGroupAllowBots:false 不再起作用（设置项已删，机器人照样受理）", async () => {
    writeFileSync(cfg, JSON.stringify({ feishuChatBridge: true, feishuGroupAllowBots: false }));
    expect(await isGroupBotsAllowed()).toBe(true);
  });

  it("文件坏（JSON 不合法）→ 照样受理（不读盘、没有 fail-closed 这回事）", async () => {
    writeFileSync(cfg, "{ not json");
    expect(await isGroupBotsAllowed()).toBe(true);
  });

  it("读设置**抛错**：机器人照样受理且根本不读盘；提示词开关 → 开（默认，宁可多约束）", async () => {
    // 第 20 轮评审 M5b：提示词开关的 catch 分支要钉；机器人这边不再读盘，用 doMock 换掉 settings-fs 验证「没读」
    vi.resetModules();
    const readSettingsFile = vi.fn(async () => {
      throw new Error("EIO: simulated disk failure");
    });
    vi.doMock("@/lib/server/settings-fs", () => ({ readSettingsFile }));
    try {
      const fresh = await import("@/lib/server/group-non-owner-guard-config");
      fresh.__setGroupBotsAllowedForTest(null);
      expect(await fresh.isGroupBotsAllowed()).toBe(true);
      expect(readSettingsFile).not.toHaveBeenCalled();
      expect(await fresh.isGroupNonOwnerGuardEnabled()).toBe(true);
      expect(readSettingsFile).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("@/lib/server/settings-fs");
      vi.resetModules();
    }
  });

  it("单测覆盖缝：false 钉住老口径、null 还原", async () => {
    __setGroupBotsAllowedForTest(false);
    expect(await isGroupBotsAllowed()).toBe(false);
    __setGroupBotsAllowedForTest(null);
    expect(await isGroupBotsAllowed()).toBe(true);
  });
});

// ---------------------------------------------------------------- 提示词

describe("提示词：机器人变体", () => {
  it("机器人变体：必须自己 @ 它 / 没问实质问题 NO_REPLY / 别客套；仍是最后一段的约束（只答疑、不改文件）", () => {
    const t = buildNonOwnerGuardFootnote("别家机器人", { isBot: true });
    expect(t).toContain("机器人「别家机器人」");
    expect(t).toContain("必须在正文里 @ 它");
    // 回复协议已下线：不再教 `@名字` / 需属主确认标记 / @宿主
    expect(t).not.toContain("[[需属主确认");
    expect(t).not.toContain("@宿主");
    expect(t).toContain("NO_REPLY");
    expect(t).toContain("别回「收到」");
    expect(t).toContain("不修改任何文件");
    expect(t).toContain("不调用 submit_work");
    expect(t.endsWith("处理完自然结束本轮回复。）")).toBe(true);
  });

  it("机器人变体带 open_id 时给出 @ 标签的固定写法（没有 id 就不给）", () => {
    const withId = buildNonOwnerGuardFootnote("别家机器人", { isBot: true, openId: "ou_otherbot" });
    expect(withId).toContain('<at user_id="ou_otherbot">别家机器人</at>');
    expect(buildNonOwnerGuardFootnote("别家机器人", { isBot: true })).not.toContain("<at ");
    // 昵称里的尖括号 / 引号不能破坏标签
    expect(buildNonOwnerGuardFootnote('a<b>"c', { isBot: true, openId: "ou_x" })).toContain(
      '<at user_id="ou_x">abc</at>',
    );
  });

  it("真人变体：系统自动 @ 提问人（不用自己写）、不提机器人", () => {
    const t = buildNonOwnerGuardFootnote("李四");
    expect(t).toContain("非任务所有者「李四」");
    expect(t).toContain("系统会在回复开头自动 @ 提问人");
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

describe("路由：有活会话 → 机器人并入同会话（恒受理）", () => {
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

  it("没有速率限制：同一机器人连发 6 条（旧的 per-sender 滑动窗是 4 次）全部入 task 待送达队列，且对机器人始终静默（防环靠提示词 + 系统回执静默）", async () => {
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
    const n = 6;
    for (let i = 0; i < n; i++) {
      const r = await routeGroupInboundMessage(botMsg({ message_id: `om_b${i}` }), ctx);
      expect(r).toMatchObject({ kind: "queued" });
    }
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(n);
    // 对机器人的系统回执一律静默（不给对端喂噪音）
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

describe("路由：覆盖缝压成「不受理」→ 机器人整条静默被拒（对照，生产里走不到）", () => {
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

  it("设置文件坏也不影响受理：不走覆盖缝、走真实路径，机器人照样并入同会话（不再有 fail-closed）", async () => {
    __setGroupBotsAllowedForTest(null);
    writeFileSync(path.join(DATA, "config.json"), "{ not json");
    try {
      agentSessions.set("task-1", {} as never);
      const handleTaskQuestionInject = vi.fn(async () => jsonRes({ ok: true }, 200));
      __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);
      const r = await routeGroupInboundMessage(botMsg(), ctx);
      expect(r).toMatchObject({ kind: "sent" });
      expect(optsOf(handleTaskQuestionInject)).toMatchObject({
        groupNonOwner: { isBot: true },
      });
    } finally {
      rmSync(path.join(DATA, "config.json"), { force: true });
    }
  });

  it("真人不受影响（覆盖缝压成「不受理」时真人照常并入同会话，且不为它读设置）", async () => {
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
