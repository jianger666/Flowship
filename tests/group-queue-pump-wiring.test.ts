/**
 * 群问题排队 × 真实 pump 的接线测试（第五轮 G3-01 / G3-03 / G3-04 / G3-02 / G3-05）
 *
 * 既有契约测试把 pump 或出向 tap 其中一边 mock 掉了（feishu-group-outbound 把 pump 换成 spy、
 * feishu-group-inbound 直接调 pump），「出向帧 → 预筛 → 真 pump → 真 injectGroupMessage」
 * 这条接线没人走过，G3-01 / G3-03 就是漏在这里。本文件两头都用真的，只桩外部 IO
 * （飞书发消息 / 注入链 / 任务读取 / 事件落盘）。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

// 节流 info 事件走 writeOwnedEventAndPublish（真落盘要有任务目录）——mock 掉、只断言写了什么
const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({
    id: "ev_mock",
  })),
);
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeOwnedEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-queue-pump-wiring-${Date.now()}`,
  "data",
);

const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  pumpGroupQuestionQueue,
  routeGroupInboundMessage,
} = await import("@/lib/server/feishu-bridge/group-route");
const {
  __resetGroupOutboundForTest,
  __setGroupOutboundDepsForTest,
  handleGroupOutboundEvent,
} = await import("@/lib/server/feishu-bridge/group-outbound");
const {
  __resetGroupReplyStateForTest,
  __resetThrottleForTest,
  appendGroupReplyAnswer,
  groupQuestionQueueLength,
  listGroupQuestionQueueView,
  listGroupReplies,
} = await import("@/lib/server/feishu-bridge/group-shared");
const { __resetGroupRosterForTest } = await import(
  "@/lib/server/feishu-bridge/group-roster"
);

// ----------------- fixtures -----------------

const OWNER = "ou_owner";
const BOT = "ou_bot";
const LI = "ou_li_si";
const WANG = "ou_wang_wu";
const CHAT = "oc_req_group";
const OTHER_CHAT = "oc_other_group";

const groupMsg = (over: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: "om_g1",
  create_time: String(Date.now()),
  chat_id: CHAT,
  chat_type: "group",
  message_type: "text",
  sender_id: OWNER,
  sender_name: "张三",
  content: "@Flowship 这个接口什么时候好",
  mentions: [{ key: "@_user_1", openId: BOT, name: "Flowship" }],
  ...over,
});
const fromLi = (id: string, content = "@Flowship 埋点查了吗") =>
  groupMsg({ message_id: id, sender_id: LI, sender_name: "李四", content });
const fromWang = (id: string, content = "@Flowship 缓存怎么算") =>
  groupMsg({ message_id: id, sender_id: WANG, sender_name: "王五", content });
const fromOwner = (id: string, content = "@Flowship 再看下这个") =>
  groupMsg({ message_id: id, sender_id: OWNER, sender_name: "张三", content });

const taskSummary = (): TaskSummary =>
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

/** 外部 IO 全桩掉；任务忙闲 / 待答提问由用例通过 state 控制 */
const state: { running: boolean; pendingAsk: unknown } = {
  running: false,
  pendingAsk: null,
};

const okResp = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 });

const setup = (over: Record<string, unknown> = {}) => {
  const handleTaskQuestionInject = vi.fn<(...a: unknown[]) => Promise<Response>>(
    async () => okResp(),
  );
  const injectPendingAskText = vi.fn<
    (...a: unknown[]) => Promise<{ ok: true }>
  >(async () => ({ ok: true as const }));
  const sendTextToChat = vi.fn<
    (...a: unknown[]) => Promise<{ chat_id: string; message_id: string }>
  >(async () => ({
    chat_id: CHAT,
    message_id: "om_r",
  }));
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
    // 两个任务绑两个群：窗口 / 队列 per-task 隔离的用例要用
    listTasks: async () => [
      taskSummary(),
      { ...taskSummary(), id: "task-2", updatedAt: Date.now() - 1000 },
    ],
    getTask: async (id: string) =>
      fullTask({ id, runStatus: state.running ? "running" : "idle" } as never),
    getBoundGroupChatId: async (t: { id: string }) =>
      t.id === "task-2" ? OTHER_CHAT : CHAT,
    getPendingAsk: () => state.pendingAsk,
    injectPendingAskText,
    handleTaskQuestionInject,
    isAdvanceResultToGroupEnabled: async () => true,
    ...over,
  } as never);
  // 出向只开桥接；pump 依赖不覆盖 = 走默认的真 pumpGroupQuestionQueue（动态 import group-route）
  __setGroupOutboundDepsForTest({ isBridgeEnabled: async () => true } as never);
  return { handleTaskQuestionInject, injectPendingAskText, sendTextToChat };
};

const sentTexts = (fn: ReturnType<typeof vi.fn>): string[] =>
  fn.mock.calls.map((c) => String((c as unknown[])[1] ?? ""));
const injectedTexts = (fn: ReturnType<typeof vi.fn>): string[] =>
  fn.mock.calls.map(
    (c) => ((c as unknown[][])[1] as { text?: string })?.text ?? "",
  );

const doneFrame = () =>
  ({ kind: "done", task: fullTask(), ok: true }) as never;
const taskFrame = () => ({ kind: "task", task: fullTask() }) as never;

beforeEach(() => {
  state.running = false;
  state.pendingAsk = null;
  writeOwnedEventAndPublish.mockClear();
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
  __resetThrottleForTest();
});

afterEach(() => {
  vi.useRealTimers();
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  __setGroupRouteDepsForTest(null);
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
});

// ----------------- G3-01：无登记的 run 收口也要泵 -----------------

describe("G3-01：属主 app 里发起的 run（无登记）结束 → done 帧经真 pump 放行排队问题", () => {
  it("非属主问题排队 → run 结束的 done 帧到达 → 真 pump 回放（不靠下一条群 @、不等 30 分钟超时）", async () => {
    const { handleTaskQuestionInject } = setup();
    state.running = true;
    const r = await routeGroupInboundMessage(fromLi("om_q1", "@Flowship 埋点查了吗"), ctx);
    expect(r).toMatchObject({ kind: "queued" });
    expect(groupQuestionQueueLength("task-1")).toBe(1);
    // 前提：排队的问题不建登记、属主 app 里发起的 run 也没有登记——预筛若只认登记，done 永远到不了泵
    expect(listGroupReplies("task-1")).toHaveLength(0);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();

    state.running = false; // run 收口
    await handleGroupOutboundEvent("task-1", doneFrame());

    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(injectedTexts(handleTaskQuestionInject)[0]).toContain("埋点查了吗");
    expect(
      (handleTaskQuestionInject.mock.calls[0] as unknown[][])[2],
    ).toMatchObject({ restrictToQuestion: true });
    expect(groupQuestionQueueLength("task-1")).toBe(0);
  });

  it("动作终态帧（action / task）同样能把队首放出来", async () => {
    const { handleTaskQuestionInject } = setup();
    state.running = true;
    await routeGroupInboundMessage(fromLi("om_q1"), ctx);
    state.running = false;
    await handleGroupOutboundEvent("task-1", {
      kind: "action",
      action: { id: "act-1", status: "awaiting_ack" },
    } as never);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(groupQuestionQueueLength("task-1")).toBe(0);
  });
});

// ----------------- G3-03：pump 遇忙静默 -----------------

describe("G3-03：pump 回放遇忙 → 静默放回队首，不再对真人发忙线文案", () => {
  it("三条入口（直接 pump / 出向帧 / 新消息到达顺带 draining）遇忙都不发群消息、不丢队首", async () => {
    const { handleTaskQuestionInject, sendTextToChat } = setup();
    state.running = true;
    await routeGroupInboundMessage(fromLi("om_q1"), ctx);
    expect(sentTexts(sendTextToChat as never)).toHaveLength(1); // 入队 ack
    sendTextToChat.mockClear();
    const before = listGroupQuestionQueueView("task-1");
    expect(before.map((v) => v.id)).toEqual(["om_q1"]);

    await pumpGroupQuestionQueue("task-1");
    await pumpGroupQuestionQueue("task-1");
    await handleGroupOutboundEvent("task-1", taskFrame());
    await handleGroupOutboundEvent("task-1", doneFrame());

    // 注释和文档写的是「静默」：忙就悄悄放回、不回群，否则每泵一次就再 @ 他一遍
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    // 同一条、入队时间不变地躺在队首
    expect(listGroupQuestionQueueView("task-1")).toEqual(before);
  });

  it("新消息到达（4.25 顺带 draining）时队首仍忙：群里只该出现给新人的那句排队 ack", async () => {
    const { sendTextToChat } = setup();
    state.running = true;
    await routeGroupInboundMessage(fromLi("om_q1"), ctx);
    sendTextToChat.mockClear();

    const r = await routeGroupInboundMessage(fromWang("om_q2"), ctx);
    expect(r).toMatchObject({ kind: "queued" });
    const texts = sentTexts(sendTextToChat as never);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(`user_id="${WANG}"`);
    expect(texts[0]).toContain("排队");
    // 李四（队首）不该再被忙线文案 @ 一遍
    expect(texts.some((t) => t.includes(`user_id="${LI}"`))).toBe(false);
    expect(listGroupQuestionQueueView("task-1").map((v) => v.id)).toEqual([
      "om_q1",
      "om_q2",
    ]);
  });

  it("旁路答疑在飞时 pump 遇忙同样静默（GROUP_RESTRICTED_QUESTION_RUNNING 那条分支）", async () => {
    const { sendTextToChat } = setup();
    const { registerRestrictedQuestion, unregisterRestrictedQuestion } =
      await import("@/lib/server/task-stream");
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion("task-1", inFlight);
    try {
      await routeGroupInboundMessage(fromLi("om_q1"), ctx);
      sendTextToChat.mockClear();
      await pumpGroupQuestionQueue("task-1");
      expect(sendTextToChat).not.toHaveBeenCalled();
      expect(groupQuestionQueueLength("task-1")).toBe(1);
    } finally {
      unregisterRestrictedQuestion("task-1", inFlight);
    }
  });
});

// ----------------- G3-04：回放的排队问题不能被当成 ask_user 的答案 -----------------

describe("G3-04：回放的排队问题遇到 pending ask，不被当成 agent ask_user 的答案吞掉", () => {
  it("agent 中途 ask_user（run 仍在跑）时 done 帧触发 pump：不走答案通道、静默放回", async () => {
    const { handleTaskQuestionInject, injectPendingAskText, sendTextToChat } =
      setup();
    state.running = true;
    await routeGroupInboundMessage(fromLi("om_q1", "@Flowship 埋点查了吗"), ctx);
    sendTextToChat.mockClear();

    // agent 调了 ask_user：done 是 turn 级的、此刻也会发，run 还挂着等人答
    state.pendingAsk = { askId: "ask-1" };
    await handleGroupOutboundEvent("task-1", doneFrame());

    expect(injectPendingAskText).not.toHaveBeenCalled();
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(groupQuestionQueueLength("task-1")).toBe(1);
  });

  it("pending ask 在、任务不忙：回放走只读答疑旁路（restrictToQuestion），ask 答案通道不碰", async () => {
    const { handleTaskQuestionInject, injectPendingAskText } = setup();
    state.running = true;
    await routeGroupInboundMessage(fromLi("om_q1", "@Flowship 埋点查了吗"), ctx);
    state.running = false;
    state.pendingAsk = { askId: "ask-1" };

    await pumpGroupQuestionQueue("task-1");

    expect(injectPendingAskText).not.toHaveBeenCalled();
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(
      (handleTaskQuestionInject.mock.calls[0] as unknown[][])[2],
    ).toMatchObject({ restrictToQuestion: true });
    expect(groupQuestionQueueLength("task-1")).toBe(0);
  });

  it("对照：实时到达（非回放）的非属主消息遇到 pending ask 仍当答案——设计不变", async () => {
    const { handleTaskQuestionInject, injectPendingAskText } = setup();
    state.pendingAsk = { askId: "ask-1" };
    const r = await routeGroupInboundMessage(fromLi("om_live", "@Flowship 选方案 A"), ctx);
    expect(r).toMatchObject({ kind: "sent" });
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
  });
});

// ----------------- G3-02：发送人槽位 + 旁路 run 滑动窗 -----------------

describe("G3-02：每发送人最多 2 个排队槽", () => {
  it("同一发送人第 3 条落回忙线拒收（原口径），别的发送人仍能排；重投不占槽", async () => {
    const { sendTextToChat } = setup();
    state.running = true;
    expect(await routeGroupInboundMessage(fromLi("om_1"), ctx)).toMatchObject({ kind: "queued" });
    expect(await routeGroupInboundMessage(fromLi("om_2"), ctx)).toMatchObject({ kind: "queued" });
    sendTextToChat.mockClear();

    const third = await routeGroupInboundMessage(fromLi("om_3"), ctx);
    expect(third).toMatchObject({ kind: "skipped" });
    expect(groupQuestionQueueLength("task-1")).toBe(2);
    // 超槽位的那条按原忙线口径回一句（真人才回）
    expect(sentTexts(sendTextToChat as never)).toHaveLength(1);

    // 别人不受影响
    expect(await routeGroupInboundMessage(fromWang("om_4"), ctx)).toMatchObject({ kind: "queued" });
    expect(groupQuestionQueueLength("task-1")).toBe(3);
    // 飞书重投已在队里的 om_1：幂等、不被槽位上限误拒
    expect(await routeGroupInboundMessage(fromLi("om_1"), ctx)).toMatchObject({ kind: "queued" });
    expect(groupQuestionQueueLength("task-1")).toBe(3);
  });
});

describe("G3-02：非属主旁路 run 的 10 分钟滑动窗（窗内最多 12 个）", () => {
  const runOne = (i: number) =>
    routeGroupInboundMessage(
      groupMsg({
        message_id: `om_w${i}`,
        // 轮换发送人：这条用例测的是 per-task 窗，不是 per-sender 槽位
        sender_id: `ou_s${i % 6}`,
        sender_name: `同事${i % 6}`,
        content: `@Flowship 问题 ${i}`,
      }),
      ctx,
    );
  const infoCalls = () =>
    writeOwnedEventAndPublish.mock.calls.filter(
      (c) => (c[2] as { kind?: string } | undefined)?.kind === "info",
    );

  it("第 13 个起静默丢弃（不回群、不进注入链），只写一条节流 info；窗口滑过后恢复", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-15T08:00:00Z").getTime();
    vi.setSystemTime(t0);
    const { handleTaskQuestionInject, sendTextToChat } = setup();

    for (let i = 1; i <= 12; i++) {
      expect(await runOne(i)).toMatchObject({ kind: "sent" });
    }
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(12);
    sendTextToChat.mockClear();

    const r13 = await runOne(13);
    expect(r13).toMatchObject({ kind: "skipped" });
    const r14 = await runOne(14);
    expect(r14).toMatchObject({ kind: "skipped" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(12);
    // 静默：群里一个字都不回（也不 @ 提问人）
    expect(sendTextToChat).not.toHaveBeenCalled();
    // 每窗最多一条 info（给属主看的，不进群）
    expect(infoCalls()).toHaveLength(1);

    // 窗口滑过：恢复放行
    vi.setSystemTime(t0 + 10 * 60 * 1000 + 1);
    expect(await runOne(15)).toMatchObject({ kind: "sent" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(13);
  });

  it("属主自己不受限；窗口耗尽期间属主消息照常注入", async () => {
    const { handleTaskQuestionInject } = setup();
    for (let i = 1; i <= 12; i++) await runOne(i);
    expect(await runOne(13)).toMatchObject({ kind: "skipped" });
    const before = handleTaskQuestionInject.mock.calls.length;
    const r = await routeGroupInboundMessage(fromOwner("om_owner_1"), ctx);
    expect(r).toMatchObject({ kind: "sent" });
    expect(handleTaskQuestionInject.mock.calls.length).toBe(before + 1);
  });

  it("窗是 per-task：别的任务不共享额度", async () => {
    const { handleTaskQuestionInject } = setup();
    for (let i = 1; i <= 12; i++) await runOne(i);
    expect(await runOne(13)).toMatchObject({ kind: "skipped" });
    // 另一个任务（另一群）的非属主提问不受影响
    const r = await routeGroupInboundMessage(
      groupMsg({
        message_id: "om_other_task",
        chat_id: OTHER_CHAT,
        sender_id: LI,
        sender_name: "李四",
      }),
      ctx,
    );
    expect(r).toMatchObject({ kind: "sent" });
    expect(handleTaskQuestionInject.mock.calls.length).toBe(13);
  });
});

// ----------------- G3-05：属主二次消息入队前顶掉单格登记的窗口 -----------------

describe("G3-05：属主二次消息在注入窗口内不丢上一轮的 delta", () => {
  it("A 在跑、属主 B 消息入队（202）：注入 await 期间 A 的 delta 仍归 A 的登记，回滚后不丢", async () => {
    const { handleTaskQuestionInject } = setup();
    // A：属主第一句，注入成功、agent 开跑
    const a = await routeGroupInboundMessage(fromOwner("om_a", "@Flowship 先查接口"), ctx);
    expect(a).toMatchObject({ kind: "sent" });
    const tokenA = listGroupReplies("task-1")[0]!.token;
    appendGroupReplyAnswer("task-1", null, "第一段，");

    // B：A 还在跑 → 属主忙线豁免、注入链入 task 待送达队列（202）。
    // 注入链的 await 期间 A 的 run 照常流 delta（属主主链事件不带 origin，只认单格）
    state.running = true;
    handleTaskQuestionInject.mockImplementationOnce(async () => {
      appendGroupReplyAnswer("task-1", null, "第二段");
      return new Response(
        JSON.stringify({ ok: true, queued: true, itemId: "tq_1", position: 1 }),
        { status: 202 },
      );
    });
    const b = await routeGroupInboundMessage(fromOwner("om_b", "@Flowship 再补一个"), ctx);
    expect(b).toMatchObject({ kind: "queued" });

    // B 没跑起来 → 登记回滚成 A 的；A 在窗口内收到的 delta 一个字都不能丢
    const replies = listGroupReplies("task-1");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.token).toBe(tokenA);
    expect(replies[0]!.answer).toBe("第一段，第二段");
  });
});
