/**
 * 非属主并入属主同一会话 —— 入向（group-route）路由决策。
 *
 * 钉死的语义：
 * - 非属主 + task 型 + 活会话在场 + 不是答 pendingAsk / 关联回执 → 并入同会话：
 *   restrictToQuestion:false + groupNonOwner:{name}；抬头只标身份（约束段由注入链送达时追加）；
 *   meta 带 groupNonOwnerTurn（出向据此现建登记）、不带 restrictedRunTag / advancePreempted；
 *   群侧**不预登记**（登记由出向从 user_reply 事件现建）；
 *   queueIfBusy.source=group_other（带 senderKey / clientItemId）；忙时不被群侧忙线闸拒收
 * - 没有活会话 → 原只读旁路不变（降级通道）：restrictToQuestion:true、预登记 restricted
 * - 属主 / 答 pendingAsk 不受影响；机器人：设置「受理其他机器人」关 → 仍被准入闸拒（放开后的语义见 group-bots-allowed.test.ts）
 * - 202 排队：限流名额不退（重放不再过准入闸，不能让排队绕过 per-sender 滑动窗）
 * - 带图 + 主链正忙：不排队、忙线拒收；空闲带图照常直送
 *
 * 全 mock 外部调用——禁止真调飞书。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-same-session-route-${Date.now()}`,
  "data",
);

const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  GROUP_TASK_RUNNING,
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
const { __setGroupBotsAllowedForTest } = await import(
  "@/lib/server/group-non-owner-guard-config"
);

const OWNER = "ou_owner";
const BOT = "ou_bot";
const CHAT = "oc_req_group";
const STRANGER = "ou_stranger";

const groupMsg = (
  overrides: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: "om_g1",
  create_time: String(Date.now()),
  chat_id: CHAT,
  chat_type: "group",
  message_type: "text",
  sender_id: STRANGER,
  sender_name: "李四",
  content: "@Flowship 这个接口返回啥？",
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

const IMG = { data: "aGVsbG8=", mimeType: "image/png", filename: "a.png" };
const ctx = {
  parseContent: async (m: FeishuInboundMessage) => ({
    text: m.content,
    images: [],
    attachments: [],
  }),
  loadBootContext: async () => ({ apiKey: "sk-test", model: { id: "m1" } }),
};
const ctxWithImage = {
  ...ctx,
  parseContent: async (m: FeishuInboundMessage) => ({
    text: m.content,
    images: [IMG],
    attachments: [],
  }),
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

const bodyOf = (fn: unknown, i = 0): Record<string, unknown> =>
  (callArgs(fn, i)[1] ?? {}) as Record<string, unknown>;
const optsOf = (fn: unknown, i = 0): Record<string, unknown> =>
  (callArgs(fn, i)[2] ?? {}) as Record<string, unknown>;
const metaOf = (fn: unknown, i = 0): Record<string, unknown> =>
  (optsOf(fn, i).userReplyMetaExtra ?? {}) as Record<string, unknown>;
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
  __setGroupBotsAllowedForTest(null);
  __setGroupRouteDepsForTest(null);
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
  __resetGroupAdvancePickForTest();
  __resetOutboundRegistryForTest();
  agentSessions.delete("task-1");
});

describe("非属主 + 活会话 → 并入同会话", () => {
  it("注入参数：groupNonOwner + 非只读通道；抬头只标身份、不带「只答疑」尾巴；meta 标记；不预登记", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);

    const r = await routeGroupInboundMessage(groupMsg(), ctx);

    expect(r).toMatchObject({ kind: "sent", taskId: "task-1" });
    const opts = optsOf(handleTaskQuestionInject);
    expect(opts).toMatchObject({
      restrictToQuestion: false,
      // openId 随行：机器人变体提示词要给出 @ 标签的固定写法（回复协议下线后系统不再替它 @名字 换真 @）
      groupNonOwner: { name: "李四", openId: STRANGER },
    });
    // 抬头只标身份（约束段由注入链送达时按设置开关追加）
    const text = String(bodyOf(handleTaskQuestionInject).text);
    expect(text.startsWith("[群消息·来自 李四（非任务所有者）]\n")).toBe(true);
    expect(text).not.toContain("只答疑");
    // 飞书消息 id 当直送幂等键
    expect(bodyOf(handleTaskQuestionInject).clientItemId).toBe("om_g1");
    // meta：出向据此现建登记；不是旁路问题（无 restrictedRunTag）、不是「被推进占格」
    const meta = metaOf(handleTaskQuestionInject);
    expect(meta).toMatchObject({
      source: "feishu_group",
      groupChatId: CHAT,
      groupSender: "李四",
      groupSenderOpenId: STRANGER,
      feishuMessageId: "om_g1",
      groupNonOwnerTurn: true,
    });
    expect(meta).not.toHaveProperty("restrictedRunTag");
    expect(meta).not.toHaveProperty("advancePreempted");
    // 群侧不预登记（登记由出向从 user_reply 事件现建）
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("queueIfBusy：source=group_other，带 senderKey（稳定 id）与 clientItemId（飞书 message_id）", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);
    await routeGroupInboundMessage(groupMsg(), ctx);
    expect(optsOf(handleTaskQuestionInject).queueIfBusy).toMatchObject({
      source: "group_other",
      senderName: "李四",
      senderKey: STRANGER,
      clientItemId: "om_g1",
    });
  });

  it("主链在跑：不被群侧忙线闸拒收；202 排队 → 回「这轮跑完就答你」、结果 queued、没有登记", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () => queuedRes());
    const sendTextToChat = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_r",
    }));
    __setGroupRouteDepsForTest(
      baseDeps({
        handleTaskQuestionInject,
        sendTextToChat,
        getTask: async () => fullTask({ runStatus: "running" }),
        listTasks: async () => [taskSummary({ runStatus: "running" })],
      }) as never,
    );

    const r = await routeGroupInboundMessage(groupMsg(), ctx);

    expect(r).toMatchObject({ kind: "queued", taskId: "task-1" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(sentTexts(sendTextToChat)).toHaveLength(1);
    expect(sentTexts(sendTextToChat)[0]).toContain("这轮跑完就答你");
    expect(sentTexts(sendTextToChat)[0]).not.toContain(GROUP_TASK_RUNNING);
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("注入链拒了（如 409 没有可用会话 / 队满）→ 原文回群、结果 failed", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ error: "排队的人太多了（最多 5 条），等这一轮处理完再 @ 我" }, 409),
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
    expect(sentTexts(sendTextToChat).join("\n")).toContain("排队的人太多了");
  });

  it("没有速率限制：同一人连发 6 条（旧的 per-sender 滑动窗是 4 次）全部排进 task 待送达队列、逐条注入", async () => {
    // 2026-11-06：旁路 / 并入同会话的 per-sender 滑动窗限流已整套删除（用户：「什么熔断机制都可以去掉」）。
    // 积压上限由 task 待送达队列自己的容量与「每人排队槽位」管，不在群路由里按时间窗计数。
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () => queuedRes());
    __setGroupRouteDepsForTest(
      baseDeps({
        handleTaskQuestionInject,
        getTask: async () => fullTask({ runStatus: "running" }),
        listTasks: async () => [taskSummary({ runStatus: "running" })],
      }) as never,
    );
    const n = 6;
    for (let i = 0; i < n; i++) {
      const r = await routeGroupInboundMessage(
        groupMsg({ message_id: `om_q${i}` }),
        ctx,
      );
      expect(r).toMatchObject({ kind: "queued" });
    }
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(n);
  });
});

describe("带图", () => {
  it("主链正忙 + 带图 → 不排队，群里回忙线、不注入", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () => queuedRes());
    const sendTextToChat = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_r",
    }));
    __setGroupRouteDepsForTest(
      baseDeps({
        handleTaskQuestionInject,
        sendTextToChat,
        getTask: async () => fullTask({ runStatus: "running" }),
        listTasks: async () => [taskSummary({ runStatus: "running" })],
      }) as never,
    );
    const r = await routeGroupInboundMessage(groupMsg(), ctxWithImage);
    expect(r).toMatchObject({ kind: "skipped", taskId: "task-1" });
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(sentTexts(sendTextToChat)[0]).toContain(GROUP_TASK_RUNNING);
  });

  it("空闲 + 带图 → 照常直送（不排队也不拒）", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);
    const r = await routeGroupInboundMessage(groupMsg(), ctxWithImage);
    expect(r).toMatchObject({ kind: "sent" });
    expect(bodyOf(handleTaskQuestionInject).images).toHaveLength(1);
    expect(optsOf(handleTaskQuestionInject)).toMatchObject({
      groupNonOwner: { name: "李四" },
    });
  });
});

describe("不受影响的路径", () => {
  it("没有活会话 → 原只读旁路不变（降级通道）：restrictToQuestion:true、无 groupNonOwner、预登记 restricted", async () => {
    // 不 set agentSessions
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);

    await routeGroupInboundMessage(groupMsg(), ctx);

    const opts = optsOf(handleTaskQuestionInject);
    expect(opts).toMatchObject({ restrictToQuestion: true });
    expect(opts).not.toHaveProperty("groupNonOwner");
    expect(opts).not.toHaveProperty("queueIfBusy");
    expect(metaOf(handleTaskQuestionInject)).not.toHaveProperty(
      "groupNonOwnerTurn",
    );
    expect(metaOf(handleTaskQuestionInject)).toHaveProperty("restrictedRunTag");
    // 旁路仍然预登记（restricted、非 sameSession）
    const regs = listGroupReplies("task-1");
    expect(regs).toHaveLength(1);
    expect(regs[0]!.sameSession).toBeFalsy();
    expect(regs[0]!.runTag).toBeTruthy();
  });

  it("属主本人：仍是 group_owner 语义，不带 groupNonOwner / groupNonOwnerTurn", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);

    await routeGroupInboundMessage(
      groupMsg({ sender_id: OWNER, sender_name: "宿主" }),
      ctx,
    );

    const opts = optsOf(handleTaskQuestionInject);
    expect(opts).toMatchObject({ restrictToQuestion: false });
    expect(opts).not.toHaveProperty("groupNonOwner");
    expect(opts.queueIfBusy).toMatchObject({ source: "group_owner" });
    expect(metaOf(handleTaskQuestionInject)).not.toHaveProperty(
      "groupNonOwnerTurn",
    );
    expect(bodyOf(handleTaskQuestionInject)).not.toHaveProperty("clientItemId");
  });

  it("设置「受理其他机器人」关：机器人发言人（非属主）被准入闸拒收：不注入、不回群", async () => {
    __setGroupBotsAllowedForTest(false);
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    const sendTextToChat = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_r",
    }));
    __setGroupRouteDepsForTest(
      baseDeps({ handleTaskQuestionInject, sendTextToChat }) as never,
    );
    const r = await routeGroupInboundMessage(
      groupMsg({
        sender_id: "ou_otherbot",
        sender_name: "别家机器人",
        sender_type: "app",
      }),
      ctx,
    );
    expect(r).toMatchObject({ kind: "skipped" });
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(sendTextToChat).not.toHaveBeenCalled();
  });

  it("有待答 pendingAsk：这条是在答提问，不并入同会话（走 injectPendingAskText）", async () => {
    agentSessions.set("task-1", {} as never);
    const injectPendingAskText = vi.fn(async () => ({ ok: true as const }));
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    __setGroupRouteDepsForTest(
      baseDeps({
        injectPendingAskText,
        handleTaskQuestionInject,
        getPendingAsk: () => ({ askId: "ask-1", questions: [] }),
      }) as never,
    );
    await routeGroupInboundMessage(groupMsg(), ctx);
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
  });

  it("有待答 pendingAsk：不走同会话的「不预登记」口径——仍按答题老路径预登记回群凭据（判定里 !hasPendingAsk 不能丢）", async () => {
    // 第 20 轮评审 M7b：光断言「走了 injectPendingAskText」杀不死「同会话判定漏掉 !hasPendingAsk」的突变——
    // 答 ask 的分支排在前面、照样会先 return。区别在回群登记：同会话**不预登记**（由出向从 user_reply 事件现建），
    // 答题老路径**预登记**。这里钉预登记还在，且没有给这条消息打同会话标记。
    agentSessions.set("task-1", {} as never);
    const injectPendingAskText = vi.fn(async () => ({ ok: true as const }));
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    __setGroupRouteDepsForTest(
      baseDeps({
        injectPendingAskText,
        handleTaskQuestionInject,
        getPendingAsk: () => ({ askId: "ask-1", questions: [] }),
      }) as never,
    );
    await routeGroupInboundMessage(groupMsg(), ctx);
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
    expect(listGroupReplies("task-1").length).toBeGreaterThan(0);
    expect(listGroupReplies("task-1").every((e) => e.sameSession !== true)).toBe(true);
  });

  it("对照：没有 pendingAsk 时同一条消息走同会话——不预登记（登记由出向现建）", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);
    await routeGroupInboundMessage(groupMsg(), ctx);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });
});
