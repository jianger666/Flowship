/**
 * 群里问出去的事，对方回来后「在哪儿回」（2026-11-11 用户反馈）：
 *
 * 用户在群里 @ 机器人「你问下国标字段名对不对」→ agent 在同一个群里 @ 国标问了 → 国标在群里回了 →
 * 旧行为：回执被喂回会话后「吃掉就闭嘴」，agent 的结论只出现在 Flowship、群里没有下文（反常识：上下文明明在群里）。
 * 新行为：登记 `expect_group_reply` 时记下「最初是谁（真人）在群里提的」（replyTo），回执命中并喂回活会话时，
 * 这一轮的输出登记成回群（属主通道、@ 最初提问的人）；任务是在 Flowship 里发起的 / 提问人是机器人 = 维持旧行为。
 * 配套：agent 的收尾在同群问完时写 NO_REPLY（不在群里复述「我已经问了」），结论等对方回来再发回群里。
 *
 * 钉死：
 * - 登记：replyTo 只收真人（ou_）、有群 id；机器人 / 脏数据 = 不记、且不影响出问登记本身
 * - 工具：只在「属主通道 question 登记还在 + 提问人不是机器人」时记 replyTo；说明里有 NO_REPLY 规则
 * - 路由：命中且活会话在场 + 同群 → 登记回群（属主通道、真人、@ 最初提问的人）；数据头告诉 agent 受众；
 *   主链正在跑时不预登记（不抢在飞 run 的输出），200 补登记、202 排队保持静默；注入失败摘登记；推进登记不被顶掉
 * - 出向：这一轮的结论真的发回群里并 @ 他；首行 NO_REPLY 则零消息
 *
 * 全 mock 外部调用——禁止真调飞书。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

const writeEventAndPublish = vi.hoisted(() =>
  vi.fn<(taskId: string, ev: unknown) => Promise<{ id: string }>>(async () => ({ id: "ev_mock" })),
);
const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ id: string } | null>>(async () => ({ id: "ev_owned" })),
);
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeEventAndPublish, writeOwnedEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(os.tmpdir(), `group-correlated-reply-to-${Date.now()}`, "data");

const { __resetGroupChatCacheForTest, __setGroupRouteDepsForTest, GROUP_TASK_RUNNING, routeGroupInboundMessage } =
  await import("@/lib/server/feishu-bridge/group-route");
const { __resetGroupOutboundForTest, __setGroupOutboundDepsForTest, handleGroupOutboundEvent } = await import(
  "@/lib/server/feishu-bridge/group-outbound"
);
const { __resetGroupAdvancePickForTest, __resetGroupReplyStateForTest, __resetThrottleForTest, listGroupReplies, rememberGroupReply } =
  await import("@/lib/server/feishu-bridge/group-shared");
const { __resetOutboundRegistryForTest, listLiveOutboundQuestions, matchCorrelatedAnswer, registerOutboundQuestion } = await import(
  "@/lib/server/feishu-bridge/group-outbound-registry"
);
const { agentSessions } = await import("@/lib/server/task-stream");
const { flowShipTools } = await import("@/lib/server/flowship-tools");

const OWNER = "ou_owner";
const BOT = "ou_bot";
const CHAT = "oc_req_group";
const GUOBIAO = "ou_guobiao";
const TASK = "task-1";

const groupMsg = (over: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: "om_g1",
  create_time: String(Date.now()),
  chat_id: CHAT,
  chat_type: "group",
  message_type: "text",
  sender_id: OWNER,
  sender_name: "陈禄江",
  content: "@Flowship 你问下他字段名",
  mentions: [{ key: "@_user_1", openId: BOT, name: "Flowship" }],
  ...over,
});
const receiptFromGuobiao = (over: Partial<FeishuInboundMessage> = {}) =>
  groupMsg({
    message_id: "om_receipt",
    sender_id: GUOBIAO,
    sender_name: "梅国标",
    sender_type: "user",
    content: "@Flowship 是你说的那个字段名",
    ...over,
  });

const taskSummary = (over: Partial<TaskSummary> = {}): TaskSummary =>
  ({
    id: TASK,
    title: "组班",
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
const fullTask = (over: Partial<Task> = {}): Task => ({ ...taskSummary(), actions: [], events: [], ...over }) as unknown as Task;

const ctx = {
  parseContent: async (m: FeishuInboundMessage) => ({ text: m.content, images: [], attachments: [] }),
  loadBootContext: async () => ({ apiKey: "sk-test", model: { id: "m1" } }),
};
const jsonRes = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
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
const runningDeps = (over: Record<string, unknown> = {}) =>
  baseDeps({
    listTasks: async () => [taskSummary({ runStatus: "running" })],
    getTask: async () => fullTask({ runStatus: "running" }),
    ...over,
  });

const callArgs = (fn: unknown, i = 0): unknown[] => ((fn as { mock: { calls: unknown[][] } }).mock.calls as unknown[][])[i] ?? [];
const injectText = (fn: unknown): string => String((callArgs(fn)[1] as { text?: string })?.text ?? "");

const ORIGIN = { requesterOpenId: OWNER, requesterName: "陈禄江", chatId: CHAT };
const registerAsk = (replyTo: unknown = ORIGIN, over: Record<string, unknown> = {}) => {
  const r = registerOutboundQuestion({
    taskId: TASK,
    chatId: CHAT,
    messageId: "om_q1",
    target: GUOBIAO,
    keywords: ["字段"],
    ...(replyTo ? { replyTo: replyTo as never } : {}),
    ...over,
  });
  expect(r.ok).toBe(true);
};
const stillRegistered = () => matchCorrelatedAnswer({ taskId: TASK, chatId: CHAT, senderIds: [GUOBIAO] }) !== null;

beforeEach(() => {
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
  __resetGroupAdvancePickForTest();
  __resetThrottleForTest();
  __resetOutboundRegistryForTest();
  writeEventAndPublish.mockClear();
  writeOwnedEventAndPublish.mockClear();
});
afterEach(() => {
  __setGroupRouteDepsForTest(null);
  __setGroupOutboundDepsForTest(null);
  __resetGroupOutboundForTest();
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
  __resetGroupAdvancePickForTest();
  __resetOutboundRegistryForTest();
  agentSessions.delete(TASK);
});

describe("出问登记：replyTo（最初在群里提这件事的真人）", () => {
  it("真人 + 有群 id → 记下来，命中时随登记带回；listLive 给的是拷贝", () => {
    registerAsk();
    const hit = matchCorrelatedAnswer({ taskId: TASK, chatId: CHAT, senderIds: [GUOBIAO] });
    expect(hit?.entry.replyTo).toEqual(ORIGIN);
    const live = listLiveOutboundQuestions(TASK);
    expect(live[0]!.replyTo).toEqual(ORIGIN);
    live[0]!.replyTo!.requesterName = "被改了";
    expect(listLiveOutboundQuestions(TASK)[0]!.replyTo!.requesterName).toBe("陈禄江");
  });

  it.each([
    ["应用 / 机器人（cli_）不记", { ...ORIGIN, requesterOpenId: "cli_app" }],
    ["不是 open_id 形态不记", { ...ORIGIN, requesterOpenId: "陈禄江" }],
    ["没有群 id 不记", { ...ORIGIN, chatId: "" }],
    ["空对象不记", {}],
    ["字符串不记", "oops"],
  ])("%s：登记本身照常成功，只是没有 replyTo", (_name, replyTo) => {
    registerAsk(replyTo);
    expect(matchCorrelatedAnswer({ taskId: TASK, chatId: CHAT, senderIds: [GUOBIAO] })?.entry.replyTo).toBeUndefined();
  });

  it("名字超长截到 64；不给 replyTo = 旧行为", () => {
    registerAsk({ ...ORIGIN, requesterName: "名".repeat(200) });
    expect(listLiveOutboundQuestions(TASK)[0]!.replyTo!.requesterName).toHaveLength(64);
    __resetOutboundRegistryForTest();
    registerAsk(null);
    expect(listLiveOutboundQuestions(TASK)[0]!.replyTo).toBeUndefined();
  });
});

describe("expect_group_reply 工具：什么时候记 replyTo", () => {
  const def = flowShipTools.find((t) => t.name === "expect_group_reply")!;
  const call = async (args: Record<string, unknown>) => {
    const { writeMeta } = await import("@/lib/server/task-fs-core");
    const { setChatTaskActionHandler } = await import("@/lib/server/chat-pending");
    await writeMeta({
      id: TASK,
      title: "t",
      mode: "task",
      repoStatus: "developing",
      runStatus: "awaiting_user",
      currentActionId: "act_1",
      actions: [{ id: "act_1", n: 1, type: "plan", status: "running", userInstruction: "", artifactPath: "actions/1-plan.md", startedAt: Date.now(), endedAt: null }],
      mrs: [],
      repoPaths: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
    setChatTaskActionHandler(TASK, (async () => {}) as never, "tok-1");
    const r = await def.handler({ task_id: TASK, message_id: "om_x", target: GUOBIAO, ...args }, "tok-1");
    setChatTaskActionHandler(TASK, null);
    return JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
  };
  const replyToOf = () => matchCorrelatedAnswer({ taskId: TASK, chatId: "", senderIds: [GUOBIAO] })?.entry.replyTo;
  const ownerEntry = (over: Record<string, unknown> = {}) =>
    rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: OWNER,
      requesterName: "陈禄江",
      sourceMessageId: "om_g1",
      kind: "question",
      channel: "owner",
      ...over,
    } as never);

  it("属主通道里有真人的 question 登记（用户正在群里等结果）→ 记下", async () => {
    ownerEntry();
    expect((await call({})).ok).toBe(true);
    expect(replyToOf()).toEqual(ORIGIN);
  });

  it.each([
    ["没有任何登记（任务是在 Flowship 里发起的）", () => undefined],
    ["提问人是机器人（防互 @ 成环）", () => ownerEntry({ requesterIsBot: true })],
    ["只有旁路通道（非属主答疑）的登记", () => ownerEntry({ channel: "restricted" })],
    ["属主通道里是推进登记（产物卡才是群里要的结果）", () => ownerEntry({ kind: "advance" })],
  ])("%s → 不记（维持旧行为）", async (_name, setup) => {
    setup();
    expect((await call({})).ok).toBe(true);
    expect(replyToOf()).toBeUndefined();
  });

  it("工具说明里写清楚了：同群问完收尾写 NO_REPLY、结论回来后自动回群 @ 最初提问的人、在 Flowship 里发起的则照常交代", () => {
    const d = def.description;
    expect(d).toContain("NO_REPLY");
    expect(d).toContain("[群消息·来自");
    expect(d).toContain("不要再在群里复述");
    expect(d).toContain("@ 最初提问的人");
    expect(d).toContain("Flowship 里（不是群里）");
  });
});

describe("回执命中并喂回会话：结论发回群里 @ 最初提问的人", () => {
  it("空闲 + 同群 + 有 replyTo → 登记回群（属主通道、真人、对应最初提问的人）；数据头告诉 agent 受众；回执即焚；路由时群里不发任何话", async () => {
    registerAsk();
    agentSessions.set(TASK, {} as never);
    let repliesAtInject = -1; // 空闲 = 注入会立刻起新 run：登记必须赶在注入之前，新 run 最早的 delta 才不落空
    const inject = vi.fn(async () => {
      repliesAtInject = listGroupReplies(TASK).length;
      return jsonRes({ ok: true }, 200);
    });
    const sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject: inject, sendTextToChat }) as never);

    const r = await routeGroupInboundMessage(receiptFromGuobiao(), ctx);

    expect(r).toMatchObject({ kind: "sent", taskId: TASK });
    expect(repliesAtInject).toBe(1);
    const replies = listGroupReplies(TASK);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      chatId: CHAT,
      requesterOpenId: OWNER,
      requesterName: "陈禄江",
      kind: "question",
      runTag: null,
      sourceMessageId: "om_receipt",
    });
    expect(replies[0]!.requesterIsBot).toBeUndefined(); // 真人：出向会在回复开头自动 @ 他
    expect(replies[0]!.sameSession).toBeUndefined();
    const text = injectText(inject);
    expect(text).toContain("托办事项的疑似回执");
    expect(text).toContain("发回群里、@ 最初在群里提这件事的「陈禄江」");
    expect(text).toContain("NO_REPLY");
    expect(text).toContain("是你说的那个字段名");
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(stillRegistered()).toBe(false);
  });

  it("没有 replyTo（Flowship 里发起的）→ 旧行为：不登记回群、数据头不提回群", async () => {
    registerAsk(null);
    agentSessions.set(TASK, {} as never);
    const inject = vi.fn(async () => jsonRes({ ok: true }, 200));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject: inject }) as never);

    await routeGroupInboundMessage(receiptFromGuobiao(), ctx);

    expect(listGroupReplies(TASK)).toHaveLength(0);
    expect(injectText(inject)).toContain("直接讲结论、不复述");
    expect(injectText(inject)).not.toContain("发回群里");
  });

  it("replyTo 的群与回执来的群不是同一个 → 不串群：不登记", async () => {
    registerAsk({ ...ORIGIN, chatId: "oc_other_group" }, { chatId: "" }); // 空 chatId = 通配，回执才进得来
    agentSessions.set(TASK, {} as never);
    const inject = vi.fn(async () => jsonRes({ ok: true }, 200));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject: inject }) as never);

    await routeGroupInboundMessage(receiptFromGuobiao(), ctx);

    expect(callArgs(inject)).not.toHaveLength(0); // 回执仍被喂回会话
    expect(listGroupReplies(TASK)).toHaveLength(0);
    expect(injectText(inject)).not.toContain("发回群里");
  });

  it("会话不在 → 不喂会话、也不登记回群（走只读旁路，旧行为）", async () => {
    registerAsk();
    const inject = vi.fn(async () => jsonRes({ ok: true }, 200));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject: inject }) as never);

    await routeGroupInboundMessage(receiptFromGuobiao(), ctx);

    expect(listGroupReplies(TASK).filter((e) => e.runTag === null)).toHaveLength(0);
    expect(injectText(inject)).not.toContain("发回群里");
  });

  it("主链正在跑 + 注入排队（202）→ 不预登记（不抢在飞 run 的输出）、保持静默、结果去 app", async () => {
    registerAsk();
    agentSessions.set(TASK, {} as never);
    // 在飞的那一轮的登记（属主在群里刚说过话）：必须原封不动
    const inflight = rememberGroupReply(TASK, { chatId: CHAT, requesterOpenId: OWNER, requesterName: "陈禄江", kind: "question", channel: "owner", sourceMessageId: "om_inflight" })!;
    const sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
    // 注入进行中的那个异步窗口里（主链的 delta 此时仍在往外走）：在飞登记必须还是当前那格
    let duringInject: Array<{ token: string; sourceMessageId?: string }> = [];
    const inject = vi.fn(async () => {
      duringInject = listGroupReplies(TASK).map((e) => ({ token: e.token, sourceMessageId: e.sourceMessageId }));
      return queuedRes();
    });
    __setGroupRouteDepsForTest(runningDeps({ handleTaskQuestionInject: inject, sendTextToChat }) as never);

    const r = await routeGroupInboundMessage(receiptFromGuobiao(), ctx);

    expect(r).toMatchObject({ kind: "queued", taskId: TASK });
    expect(duringInject).toEqual([{ token: inflight.token, sourceMessageId: "om_inflight" }]);
    const replies = listGroupReplies(TASK);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.token).toBe(inflight.token); // 没被顶掉
    expect(replies[0]!.sourceMessageId).toBe("om_inflight");
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(stillRegistered()).toBe(false);
  });

  it("预期会排队、注入却直接 200（收尾窗口里真发出去了）→ 补登记", async () => {
    registerAsk();
    agentSessions.set(TASK, {} as never);
    let repliesAtInject = -1;
    const inject = vi.fn(async () => {
      repliesAtInject = listGroupReplies(TASK).length;
      return jsonRes({ ok: true }, 200);
    });
    __setGroupRouteDepsForTest(runningDeps({ handleTaskQuestionInject: inject }) as never);

    const r = await routeGroupInboundMessage(receiptFromGuobiao(), ctx);

    expect(r).toMatchObject({ kind: "sent" });
    expect(repliesAtInject).toBe(0); // 注入前没预登记，是 200 之后补的
    const replies = listGroupReplies(TASK);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ requesterOpenId: OWNER, runTag: null, kind: "question" });
  });

  it("注入失败（非 2xx）→ 摘掉刚建的回群登记（下一轮无关的 done 不会把结果误发进群）", async () => {
    registerAsk();
    agentSessions.set(TASK, {} as never);
    const inject = vi.fn(async () => jsonRes({ error: "会话已失效" }, 409));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject: inject }) as never);

    const r = await routeGroupInboundMessage(receiptFromGuobiao(), ctx);

    expect(r).toMatchObject({ kind: "failed", taskId: TASK });
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });

  it("注入抛异常 → 同样摘掉登记", async () => {
    registerAsk();
    agentSessions.set(TASK, {} as never);
    const inject = vi.fn(async () => {
      throw new Error("boom");
    });
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject: inject }) as never);

    const r = await routeGroupInboundMessage(receiptFromGuobiao(), ctx);

    expect(r).toMatchObject({ kind: "failed" });
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });

  it("属主那一格被在飞的推进登记占着 → 不顶掉它（推进产物卡才是群里要的结果）；这轮回执只留在 app", async () => {
    registerAsk();
    agentSessions.set(TASK, {} as never);
    const adv = rememberGroupReply(TASK, { chatId: CHAT, requesterOpenId: OWNER, requesterName: "陈禄江", kind: "advance", channel: "owner", actionId: "act-9" })!;
    const inject = vi.fn(async () => jsonRes({ ok: true }, 200));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject: inject }) as never);

    await routeGroupInboundMessage(receiptFromGuobiao(), ctx);

    const replies = listGroupReplies(TASK);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ token: adv.token, kind: "advance" });
  });

  it("回执的发件人不是被问的人 → 不命中：不喂会话、不登记回群", async () => {
    registerAsk();
    agentSessions.set(TASK, {} as never);
    const inject = vi.fn(async () => jsonRes({ ok: true }, 200));
    __setGroupRouteDepsForTest(baseDeps({ handleTaskQuestionInject: inject }) as never);

    await routeGroupInboundMessage(receiptFromGuobiao({ sender_id: "ou_stranger", sender_name: "路人" }), ctx);

    expect(listGroupReplies(TASK).filter((e) => e.kind === "question" && e.runTag === null)).toHaveLength(0);
    expect(injectText(inject)).not.toContain("发回群里");
    expect(stillRegistered()).toBe(true);
  });
});

describe("出向：这一轮的结论真的发回群里并 @ 最初提问的人", () => {
  const outboundDeps = () => {
    const deps = {
      getTask: async () => fullTask(),
      getBoundGroupChatId: async () => CHAT,
      resolveSenderName: async () => "x",
      sendAskCard: vi.fn(async () => ({ chat_id: CHAT, message_id: "om_card", card_id: "c1" })),
      sendText: vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" })),
      sendMarkdown: vi.fn(async () => ({ chat_id: CHAT, message_id: "om_md" })),
      shareToGroup: vi.fn(async () => ({})),
      rememberAskCard: vi.fn(async () => undefined),
      isBridgeEnabled: async () => true,
      isAskToGroupEnabled: async () => true,
      isAdvanceResultToGroupEnabled: async () => true,
      readArtifact: async () => "# 报告",
      pumpGroupQuestionQueue: vi.fn(async () => {}),
      isStreamingEnabled: async () => false,
      createGroupCardStream: () => {
        throw new Error("不该走真流式卡");
      },
    };
    __setGroupOutboundDepsForTest(deps as never);
    return deps;
  };
  const delta = (text: string) => handleGroupOutboundEvent(TASK, { kind: "assistant_delta", text } as never);
  const done = () => handleGroupOutboundEvent(TASK, { kind: "done", task: fullTask(), ok: true } as never);
  const sentTexts = (fn: unknown): string[] => ((fn as { mock: { calls: unknown[][] } }).mock.calls as unknown[][]).map((c) => c[1] as string);

  const routeFeed = async () => {
    registerAsk();
    agentSessions.set(TASK, {} as never);
    __setGroupRouteDepsForTest(baseDeps() as never);
    await routeGroupInboundMessage(receiptFromGuobiao(), ctx);
    expect(listGroupReplies(TASK)).toHaveLength(1);
  };

  it("agent 讲结论 → 群里收到一条，开头 @ 陈禄江（不是 @ 被问的国标）；登记随 done 摘掉", async () => {
    const deps = outboundDeps();
    await routeFeed();
    await delta("国标确认了，字段名就是 classGroupingEligible，后端已发布 dev。");
    await done();

    const sent = sentTexts(deps.sendMarkdown);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('<at user_id="ou_owner">陈禄江</at> 国标确认了，字段名就是 classGroupingEligible，后端已发布 dev。');
    expect(sent[0]).not.toContain("ou_guobiao");
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });

  it("agent 判断没什么要补充 → 首行 NO_REPLY：群里零消息（后面给 Flowship 看的说明不外发）", async () => {
    const deps = outboundDeps();
    await routeFeed();
    await delta("NO_REPLY\n国标已确认字段名，Flowship 里记录即可。");
    await done();

    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });

  it("第一轮（用户在群里让去问）：agent 同群问完、收尾 NO_REPLY → 群里不再复述「我已经问了谁」（那条 @ 消息就在群里）", async () => {
    const deps = outboundDeps();
    // 用户在群里的消息 → 属主通道登记（与 group-route 登记属主问题同一格）
    rememberGroupReply(TASK, { chatId: CHAT, requesterOpenId: OWNER, requesterName: "陈禄江", kind: "question", channel: "owner", sourceMessageId: "om_g1" });
    await delta("NO_REPLY\n已在需求群 @梅国标 问他线索详情接口的字段名；等他回来我再讲结论。");
    await done();

    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    expect(deps.sendText).not.toHaveBeenCalled();
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });

  it("GROUP_TASK_RUNNING 仍是主链在跑的判据（预登记规则依赖它；改名要同步）", () => {
    expect(GROUP_TASK_RUNNING).toBeTruthy();
  });
});
