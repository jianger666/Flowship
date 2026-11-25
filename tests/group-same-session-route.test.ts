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
 *   （唯一的例外：开关关 + 真人 + 有落盘锚点时先唤醒再并入，见文件末尾「开关已关 + 休眠会话」）
 * - 属主 / 答 pendingAsk 不受影响；机器人：设置「受理其他机器人」关 → 仍被准入闸拒（放开后的语义见 group-bots-allowed.test.ts）
 * - 202 排队：限流名额不退（重放不再过准入闸，不能让排队绕过 per-sender 滑动窗）
 * - 带图 + 主链正忙：图还是待下载句柄 → 进群问题队（零下载），主链空闲后回放才下载直送；
 *   已下载好的 base64 仍不排、忙线拒收；队满 / 同人超槽落回拒收；空闲带图照常直送
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
  pumpGroupQuestionQueue,
  routeGroupInboundMessage,
} = await import("@/lib/server/feishu-bridge/group-route");
const {
  __resetGroupAdvancePickForTest,
  __resetGroupReplyStateForTest,
  __resetThrottleForTest,
  groupQuestionQueueLength,
  listGroupReplies,
} = await import("@/lib/server/feishu-bridge/group-shared");
const { __resetOutboundRegistryForTest, registerOutboundQuestion } = await import(
  "@/lib/server/feishu-bridge/group-outbound-registry"
);
const { agentSessions, runningTasks } = await import("@/lib/server/task-stream");
const { __setGroupBotsAllowedForTest } = await import(
  "@/lib/server/group-non-owner-guard-config"
);
const { GROUP_REPLY_WHERE, OWNER_GROUP_NOTE, buildOwnerGroupNote } = await import(
  "@/lib/group-non-owner-prompt"
);
const { __resetOwnTenantKeyForTest, learnOwnTenantKey } = await import(
  "@/lib/server/feishu-bridge/restricted-qa-gate"
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

  // 真实链路里非属主一律 deferDownloads 预解析：图是「待下载」的句柄，下载在闸门全过之后。
  // 上面那两条用的是「已经下载好的 base64」（ctxWithImage），那种仍不排；这里钉死待下载的图。
  const downloads: string[] = [];
  const ctxDeferredImage = {
    ...ctx,
    parseContent: async (
      m: FeishuInboundMessage,
      opts?: { deferDownloads?: boolean },
    ) => {
      const download = async () => {
        downloads.push(m.message_id);
        return { text: m.content, images: [IMG], attachments: [] };
      };
      if (!opts?.deferDownloads) return download();
      return {
        text: m.content,
        images: [],
        attachments: [],
        deferred: { hasImages: true, resolve: download },
      };
    },
  };

  it("主链正忙 + 带图（待下载）→ 进群问题队：回「在排队了」、零下载、不注入；pump 遇忙静默；空闲后才下载并直送", async () => {
    // 2026-11-18 邹丽君 @ 机器人带截图，正撞上属主那一轮的收尾窗口：旧口径是「带图一律拒收」，
    // 她只收到一句「任务正在跑、等这一轮结束再问」，消息没排队也没记录，石沉大海。
    downloads.length = 0;
    agentSessions.set("task-1", {} as never);
    let running = true;
    const handleTaskQuestionInject = vi.fn(async () =>
      jsonRes({ ok: true }, 200),
    );
    const sendTextToChat = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_r",
    }));
    __setGroupRouteDepsForTest(
      baseDeps({
        handleTaskQuestionInject,
        sendTextToChat,
        getTask: async () =>
          fullTask({ runStatus: running ? "running" : "idle" }),
        listTasks: async () => [
          taskSummary({ runStatus: running ? "running" : "idle" }),
        ],
      }) as never,
    );

    const r = await routeGroupInboundMessage(groupMsg(), ctxDeferredImage);

    expect(r).toMatchObject({ kind: "queued", taskId: "task-1" });
    expect(sentTexts(sendTextToChat)).toHaveLength(1);
    expect(sentTexts(sendTextToChat)[0]).toContain("在排队了");
    expect(sentTexts(sendTextToChat)[0]).not.toContain(GROUP_TASK_RUNNING);
    expect(downloads).toEqual([]); // 排队期间不下载、不占内存
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(groupQuestionQueueLength("task-1")).toBe(1);

    // 还在忙：pump 静默放回队首（不刷屏、不下载）
    await pumpGroupQuestionQueue("task-1");
    expect(sentTexts(sendTextToChat)).toHaveLength(1);
    expect(downloads).toEqual([]);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(groupQuestionQueueLength("task-1")).toBe(1);

    // 主链空闲：回放时才下载，图随注入直送（走并入同会话的通道）
    running = false;
    await pumpGroupQuestionQueue("task-1");
    expect(downloads).toEqual(["om_g1"]);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(bodyOf(handleTaskQuestionInject).images).toHaveLength(1);
    expect(optsOf(handleTaskQuestionInject)).toMatchObject({
      groupNonOwner: { name: "李四" },
    });
    expect(groupQuestionQueueLength("task-1")).toBe(0);
  });

  it("主链正忙 + 带图（待下载）但同一人已占满 2 个槽 → 落回忙线拒收（原口径）", async () => {
    downloads.length = 0;
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

    for (const id of ["om_i1", "om_i2"]) {
      const ok = await routeGroupInboundMessage(
        groupMsg({ message_id: id }),
        ctxDeferredImage,
      );
      expect(ok).toMatchObject({ kind: "queued" });
    }
    const third = await routeGroupInboundMessage(
      groupMsg({ message_id: "om_i3" }),
      ctxDeferredImage,
    );

    expect(third).toMatchObject({ kind: "skipped", error: GROUP_TASK_RUNNING });
    expect(groupQuestionQueueLength("task-1")).toBe(2);
    expect(sentTexts(sendTextToChat).at(-1)).toContain(GROUP_TASK_RUNNING);
    expect(downloads).toEqual([]);
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

describe("所有者群消息：尾注经 agentContext 送达（规矩随消息走，不常驻提示词）", () => {
  const ownerMsg = () => groupMsg({ sender_id: OWNER, sender_name: "宿主" });

  it.each([true, false])(
    "task 型所有者（活会话在场：%s）→ options.agentContext = OWNER_GROUP_NOTE；气泡文本里没有它（只给 agent 看）",
    async (live) => {
      if (live) agentSessions.set("task-1", {} as never);
      const handleTaskQuestionInject = vi.fn(async () =>
        jsonRes({ ok: true }, 200),
      );
      __setGroupRouteDepsForTest(
        baseDeps({ handleTaskQuestionInject }) as never,
      );

      await routeGroupInboundMessage(ownerMsg(), ctx);

      expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
      expect(optsOf(handleTaskQuestionInject).agentContext).toBe(
        OWNER_GROUP_NOTE,
      );
      expect(String(bodyOf(handleTaskQuestionInject).text)).not.toContain(
        OWNER_GROUP_NOTE,
      );
    },
  );

  it("chat 型所有者：handleChatReplyInject 的 options.agentContext = OWNER_GROUP_NOTE（userReplyMetaExtra 照旧）", async () => {
    const handleChatReplyInject = vi.fn(async () => jsonRes({ ok: true }, 200));
    __setGroupRouteDepsForTest(
      baseDeps({
        handleChatReplyInject,
        listTasks: async () => [taskSummary({ mode: "chat" })],
        getTask: async () => fullTask({ mode: "chat" }),
      }) as never,
    );

    await routeGroupInboundMessage(ownerMsg(), ctx);

    expect(handleChatReplyInject).toHaveBeenCalledTimes(1);
    const opts = optsOf(handleChatReplyInject);
    expect(opts.agentContext).toBe(OWNER_GROUP_NOTE);
    expect(opts).toHaveProperty("userReplyMetaExtra");
  });

  it.each([true, false])(
    "非所有者（活会话在场：%s，即并入同会话 / 只读旁路）→ 不带 agentContext：他们的尾注由注入链按设置开关现读追加，不走这里",
    async (live) => {
      if (live) agentSessions.set("task-1", {} as never);
      const handleTaskQuestionInject = vi.fn(async () =>
        jsonRes({ ok: true }, 200),
      );
      __setGroupRouteDepsForTest(
        baseDeps({ handleTaskQuestionInject }) as never,
      );

      await routeGroupInboundMessage(groupMsg(), ctx);

      expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
      expect(optsOf(handleTaskQuestionInject)).not.toHaveProperty(
        "agentContext",
      );
    },
  );
});

describe("所有者尾注：只写为真的半句（评审：排队 / 回复他人消息时不能说谎）", () => {
  it("构造器：两个半句各自按需带；都不为真 → 空串（调用方据此不带 agentContext）；全量形态 = OWNER_GROUP_NOTE", () => {
    expect(buildOwnerGroupNote()).toBe(OWNER_GROUP_NOTE);
    const identityOnly = buildOwnerGroupNote({ replyToGroup: false });
    const replyOnly = buildOwnerGroupNote({ identity: false });
    expect(identityOnly).toContain("任务所有者本人在需求群里说的");
    expect(identityOnly).not.toContain(GROUP_REPLY_WHERE);
    expect(replyOnly).toContain(GROUP_REPLY_WHERE);
    expect(replyOnly).not.toContain("任务所有者本人在需求群里说的");
    expect(buildOwnerGroupNote({ identity: false, replyToGroup: false })).toBe("");
    // 每个变体都是括号包好的完整一句，且都比全量短（不会因为拆变体多付钱）
    for (const n of [identityOnly, replyOnly]) {
      expect(n.startsWith("（") && n.endsWith("）")).toBe(true);
      expect(n.length).toBeLessThan(OWNER_GROUP_NOTE.length);
    }
  });

  it("所有者的消息预期会排队（主链在跑，没有回群登记）→ 只带身份、不说「会发到该群」", async () => {
    agentSessions.set("task-1", {} as never);
    const handleTaskQuestionInject = vi.fn(async () => queuedRes());
    __setGroupRouteDepsForTest(
      baseDeps({
        handleTaskQuestionInject,
        getTask: async () => fullTask({ runStatus: "running" }),
        listTasks: async () => [taskSummary({ runStatus: "running" })],
      }) as never,
    );

    await routeGroupInboundMessage(
      groupMsg({ sender_id: OWNER, sender_name: "宿主" }),
      ctx,
    );

    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    const note = String(optsOf(handleTaskQuestionInject).agentContext);
    expect(note).toBe(buildOwnerGroupNote({ replyToGroup: false }));
    expect(note).toContain("任务所有者本人在需求群里说的");
    expect(note).not.toContain("原文发到该群");
  });

  it("所有者消息正常直送（有回群登记）→ 两个半句都带（对照）", async () => {
    const handleTaskQuestionInject = vi.fn(async () => jsonRes({ ok: true }, 200));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject }) as never);

    await routeGroupInboundMessage(
      groupMsg({ sender_id: OWNER, sender_name: "宿主" }),
      ctx,
    );

    expect(optsOf(handleTaskQuestionInject).agentContext).toBe(OWNER_GROUP_NOTE);
  });
});

describe("开关已关 + 休眠会话 → 先接回会话、再按同会话并入（只对非属主真人）", () => {
  const dormantTask = (over: Partial<Task> = {}): Task =>
    fullTask({ sessionAgentId: "agent_persisted", ...over });

  /** 唤醒桩：成功时把会话摆进表里（模拟 resume 成功），并记下调用顺序 */
  const makeWake = (ok: boolean, order: string[] = []) =>
    vi.fn(async () => {
      order.push("wake");
      if (ok) agentSessions.set("task-1", {} as never);
      return ok;
    });

  /** 开关关 + 休眠任务（有锚点、没在跑、表里没会话）的默认摆法；over 覆盖任意依赖 */
  const setup = (over: Record<string, unknown> = {}) => {
    const order: string[] = [];
    const wakeTaskSessionForGroup = makeWake(true, order);
    const handleTaskQuestionInject = vi.fn(async () => {
      order.push("inject");
      return jsonRes({ ok: true }, 200);
    });
    __setGroupRouteDepsForTest(
      baseDeps({
        handleTaskQuestionInject,
        wakeTaskSessionForGroup,
        isGroupNonOwnerGuardEnabled: async () => false,
        getTask: async () => dormantTask(),
        ...over,
      }) as never,
    );
    return { order, wakeTaskSessionForGroup, handleTaskQuestionInject };
  };

  it("成功：先唤醒再注入；唤醒凭据取自服务端 loadBootContext；按同会话口径并入（不是旁路）", async () => {
    const { order, wakeTaskSessionForGroup, handleTaskQuestionInject } = setup();

    const r = await routeGroupInboundMessage(groupMsg(), ctx);

    expect(r).toMatchObject({ kind: "sent", taskId: "task-1" });
    expect(order).toEqual(["wake", "inject"]);
    // 凭据来自服务端设置（ctx.loadBootContext），不来自发言人
    expect(callArgs(wakeTaskSessionForGroup)).toEqual([
      "task-1",
      { apiKey: "sk-test", model: { id: "m1" } },
    ]);
    expect(optsOf(handleTaskQuestionInject)).toMatchObject({
      restrictToQuestion: false,
      groupNonOwner: { name: "李四", openId: STRANGER },
    });
    expect(metaOf(handleTaskQuestionInject)).toHaveProperty("groupNonOwnerTurn");
    expect(metaOf(handleTaskQuestionInject)).not.toHaveProperty(
      "restrictedRunTag",
    );
  });

  it("唤醒失败 → 落回只读旁路：restrictToQuestion:true、带 restrictedRunTag，与没有唤醒时一致", async () => {
    const wake = makeWake(false);
    const { handleTaskQuestionInject } = setup({
      wakeTaskSessionForGroup: wake,
    });

    await routeGroupInboundMessage(groupMsg(), ctx);

    expect(wake).toHaveBeenCalledTimes(1);
    const opts = optsOf(handleTaskQuestionInject);
    expect(opts).toMatchObject({ restrictToQuestion: true });
    expect(opts).not.toHaveProperty("groupNonOwner");
    expect(metaOf(handleTaskQuestionInject)).toHaveProperty("restrictedRunTag");
  });

  it("开关开着（默认）→ 一律不唤醒，走只读旁路", async () => {
    const { wakeTaskSessionForGroup, handleTaskQuestionInject } = setup({
      isGroupNonOwnerGuardEnabled: async () => true,
    });

    await routeGroupInboundMessage(groupMsg(), ctx);

    expect(wakeTaskSessionForGroup).not.toHaveBeenCalled();
    expect(optsOf(handleTaskQuestionInject)).toMatchObject({
      restrictToQuestion: true,
    });
  });

  it("机器人发言人（含「同权」）→ 不唤醒：防两个机器人互 @ 把唤醒放大，仍走只读旁路", async () => {
    const { wakeTaskSessionForGroup, handleTaskQuestionInject } = setup();

    await routeGroupInboundMessage(
      groupMsg({
        sender_id: "ou_otherbot",
        sender_name: "别家机器人",
        sender_type: "app",
      }),
      ctx,
    );

    expect(wakeTaskSessionForGroup).not.toHaveBeenCalled();
    expect(optsOf(handleTaskQuestionInject)).toMatchObject({
      restrictToQuestion: true,
    });
  });

  it("没有落盘锚点（从没起过会话 / 被停止清了）→ 不唤醒：这不是「休眠」，没得接", async () => {
    const { wakeTaskSessionForGroup, handleTaskQuestionInject } = setup({
      getTask: async () => fullTask(),
    });

    await routeGroupInboundMessage(groupMsg(), ctx);

    expect(wakeTaskSessionForGroup).not.toHaveBeenCalled();
    expect(optsOf(handleTaskQuestionInject)).toMatchObject({
      restrictToQuestion: true,
    });
  });

  it("任务正在跑（runStatus=running）→ 不唤醒", async () => {
    const { wakeTaskSessionForGroup } = setup({
      getTask: async () => dormantTask({ runStatus: "running" }),
    });

    await routeGroupInboundMessage(groupMsg(), ctx);

    expect(wakeTaskSessionForGroup).not.toHaveBeenCalled();
  });

  it("内存里有在跑的 run（runningTasks 占着：一次性 agent / 启动中，盘上 runStatus 还没写 running）→ 不唤醒", async () => {
    const { wakeTaskSessionForGroup } = setup();
    runningTasks.set("task-1", { instanceId: 1 } as never);
    try {
      await routeGroupInboundMessage(groupMsg(), ctx);
    } finally {
      runningTasks.delete("task-1");
    }

    expect(wakeTaskSessionForGroup).not.toHaveBeenCalled();
  });

  it("属主本人 → 不走唤醒段（属主的休眠会话由注入链带 creds 自己接回）", async () => {
    const { wakeTaskSessionForGroup } = setup();

    await routeGroupInboundMessage(
      groupMsg({ sender_id: OWNER, sender_name: "宿主" }),
      ctx,
    );

    expect(wakeTaskSessionForGroup).not.toHaveBeenCalled();
  });

  it("有待答 pendingAsk → 不唤醒（这条是在答提问，走 injectPendingAskText）", async () => {
    const injectPendingAskText = vi.fn(async () => ({ ok: true as const }));
    const { wakeTaskSessionForGroup } = setup({
      getPendingAsk: () => ({ askId: "ask-1", questions: [] }),
      injectPendingAskText,
    });

    await routeGroupInboundMessage(groupMsg(), ctx);

    expect(wakeTaskSessionForGroup).not.toHaveBeenCalled();
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
  });

  it("拿不到启动凭据（loadBootContext 返回 null）→ 不唤醒，走只读旁路", async () => {
    const { wakeTaskSessionForGroup } = setup();

    await routeGroupInboundMessage(groupMsg(), {
      ...ctx,
      loadBootContext: async () => null,
    });

    expect(wakeTaskSessionForGroup).not.toHaveBeenCalled();
  });

  it("排队回放（pump 重放）→ 不唤醒：回放由出向的 done / 终态事件调起，不在那条链上再阻塞一次 resume，照旧只读旁路", async () => {
    let running = true;
    const wake = makeWake(true);
    const { handleTaskQuestionInject } = setup({
      wakeTaskSessionForGroup: wake,
      getTask: async () =>
        dormantTask({ runStatus: running ? "running" : "idle" }),
      listTasks: async () => [
        taskSummary({ runStatus: running ? "running" : "idle" }),
      ],
    });

    // 任务在跑：休眠任务的非属主问题进群问题队（此刻也不唤醒——在跑）
    const r1 = await routeGroupInboundMessage(groupMsg(), ctx);
    expect(r1).toMatchObject({ kind: "queued" });
    expect(groupQuestionQueueLength("task-1")).toBe(1);
    expect(wake).not.toHaveBeenCalled();

    // 跑完、空闲了：pump 回放。条件上已满足「开关关 + 真人 + 有锚点 + 没在跑」，但回放不唤醒
    running = false;
    await pumpGroupQuestionQueue("task-1");

    expect(wake).not.toHaveBeenCalled();
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(optsOf(handleTaskQuestionInject)).toMatchObject({
      restrictToQuestion: true,
    });
    expect(groupQuestionQueueLength("task-1")).toBe(0);
  });

  it("唤醒抛错 → 不影响路由：这条消息照旧走只读旁路（唤醒是尽力而为，不能把群消息变成路由失败）", async () => {
    const wake = vi.fn(async () => {
      throw new Error("boom: resume exploded");
    });
    const { handleTaskQuestionInject } = setup({ wakeTaskSessionForGroup: wake });

    const r = await routeGroupInboundMessage(groupMsg(), ctx);

    expect(wake).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ kind: "sent", taskId: "task-1" });
    expect(optsOf(handleTaskQuestionInject)).toMatchObject({
      restrictToQuestion: true,
    });
  });

  it("开关开着不取凭据：loadBootContext 比「开关关 + 唤醒失败」少调一次（只有唤醒段多取这一次）", async () => {
    const bootCalls = async (guardOn: boolean): Promise<number> => {
      __resetGroupReplyStateForTest();
      const loadBootContext = vi.fn(async () => ({
        apiKey: "sk-test",
        model: { id: "m1" },
      }));
      setup({
        isGroupNonOwnerGuardEnabled: async () => guardOn,
        wakeTaskSessionForGroup: makeWake(false),
      });
      await routeGroupInboundMessage(groupMsg(), { ...ctx, loadBootContext });
      return loadBootContext.mock.calls.length;
    };

    const on = await bootCalls(true);
    const off = await bootCalls(false);

    expect(off - on).toBe(1);
  });

  it("关联回执（出问登记命中）→ 不唤醒：回执走的是活会话里的数据通道，会话不在不自动拉起", async () => {
    registerOutboundQuestion({
      taskId: "task-1",
      chatId: CHAT,
      messageId: "om_q1",
      target: STRANGER,
    });
    const { wakeTaskSessionForGroup } = setup();

    await routeGroupInboundMessage(groupMsg(), ctx);

    expect(wakeTaskSessionForGroup).not.toHaveBeenCalled();
  });

  it("被准入闸拒绝的发件人（租户不符）→ 静默忽略、不唤醒：被拒的人不能顺手拉起 agent", async () => {
    learnOwnTenantKey("t_own");
    try {
      const { wakeTaskSessionForGroup, handleTaskQuestionInject } = setup();

      const r = await routeGroupInboundMessage(
        groupMsg({ sender_tenant_key: "t_other" } as never),
        ctx,
      );

      expect(r).toMatchObject({ kind: "skipped" });
      expect(wakeTaskSessionForGroup).not.toHaveBeenCalled();
      expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    } finally {
      __resetOwnTenantKeyForTest();
    }
  });

  it("活会话已在 → 不重复唤醒，直接走原同会话路径", async () => {
    agentSessions.set("task-1", {} as never);
    const { wakeTaskSessionForGroup, handleTaskQuestionInject } = setup();

    await routeGroupInboundMessage(groupMsg(), ctx);

    expect(wakeTaskSessionForGroup).not.toHaveBeenCalled();
    expect(optsOf(handleTaskQuestionInject)).toMatchObject({
      restrictToQuestion: false,
      groupNonOwner: { name: "李四" },
    });
  });
});
