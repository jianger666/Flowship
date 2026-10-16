/**
 * G3-05：属主二次消息在主链正忙时，不能先顶掉在飞那一轮的属主单格登记。
 *
 * 缺陷：属主 task 型主链在跑时的二次群消息（busyReason 被属主豁免）仍在注入**之前**
 * `rememberGroupReply` 占属主那一格，把在飞那一轮（第一条消息）的登记挤进 handle.previous；
 * 注入返回 202（进 task 待送达队列、没有 run 开跑）后才 `restoreGroupReply` 放回。
 * 这个窗口里属主主链的 delta / done 都按 runTag=null 落在**新登记**上：
 *   - delta 攒进了随后被摘掉的新登记 → 第一轮回群的答案缺一段；
 *   - done 恰好落在窗口里 → 新登记被 flush（带着不全的文本）、第一轮的登记永远放不回来。
 *
 * 走真实 route + 真实出向 tap，只 mock 注入与发群消息；在 handleTaskQuestionInject 的 mock
 * 里「注入返回前」驱动出向事件来构造这个窗口。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-route-owner-busy-registration-${Date.now()}`,
  "data",
);

const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  routeGroupInboundMessage,
} = await import("@/lib/server/feishu-bridge/group-route");
const {
  __resetGroupOutboundForTest,
  __setGroupOutboundDepsForTest,
  handleGroupOutboundEvent,
} = await import("@/lib/server/feishu-bridge/group-outbound");
const { __resetGroupReplyStateForTest, listGroupReplies } = await import(
  "@/lib/server/feishu-bridge/group-shared"
);
const { __resetGroupRosterForTest } = await import(
  "@/lib/server/feishu-bridge/group-roster"
);

const OWNER = "ou_owner";
const BOT = "ou_bot";
const CHAT = "oc_req_group";
const TASK = "task-1";

let runStatus: "idle" | "running" = "idle";
/** 当前 action（缺省没有）；收尾态用例里置成 awaiting_ack */
let currentAction: { id: string; status: string } | null = null;

const taskSummary = (): TaskSummary =>
  ({
    id: TASK,
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    repoPaths: ["/tmp/repo"],
    currentActionId: null,
    mrs: [],
    actionCount: 0,
    feishuStoryUrl: "https://project.feishu.cn/space/story/detail/10001",
  }) as TaskSummary;
const fullTask = (): Task =>
  ({
    ...taskSummary(),
    currentActionId: currentAction?.id ?? null,
    actions: currentAction ? [currentAction] : [],
    events: [],
  }) as unknown as Task;

const ownerMsg = (id: string, content = "@Flowship 继续"): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: id,
  create_time: String(Date.now()),
  chat_id: CHAT,
  chat_type: "group",
  message_type: "text",
  sender_id: OWNER,
  sender_name: "属主",
  content,
  mentions: [{ key: "@_user_1", openId: BOT, name: "Flowship" }],
});

const ctx = {
  parseContent: async (m: FeishuInboundMessage) => ({
    text: m.content,
    images: [],
    attachments: [],
  }),
  loadBootContext: async () => ({ apiKey: "sk-test", model: { id: "m1" } }),
};

const ok200 = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 });
const queued202 = () =>
  new Response(JSON.stringify({ ok: true, queued: true }), { status: 202 });

let handleTaskQuestionInject: ReturnType<typeof vi.fn>;
let sendTextToChat: ReturnType<typeof vi.fn>;
let sendMarkdown: ReturnType<typeof vi.fn>;

const delta = (text: string) =>
  handleGroupOutboundEvent(TASK, { kind: "assistant_delta", text } as never);
const done = () =>
  handleGroupOutboundEvent(TASK, { kind: "done", task: fullTask(), ok: true } as never);
const sentMarkdown = (): string[] =>
  sendMarkdown.mock.calls.map((c) => String((c as unknown[])[1]));

beforeEach(() => {
  runStatus = "idle";
  currentAction = null;
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
  handleTaskQuestionInject = vi.fn(async () => ok200());
  sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
  sendMarkdown = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_md" }));
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
    handleTaskQuestionInject,
  } as never);
  __setGroupOutboundDepsForTest({
    isBridgeEnabled: async () => true,
    sendMarkdown,
    sendText: sendTextToChat,
    fetchRoster: async () => ({ members: [] }),
    resolveOwner: async () => undefined,
    getSelfOpenId: async () => null,
    pumpGroupQuestionQueue: async () => {},
  } as never);
});

afterEach(() => {
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  __setGroupRouteDepsForTest(null);
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
});

/** 第一条属主消息：任务空闲 → 注入成功、登记 R1（属主单格）、随后任务进入 running */
const startFirstRun = async () => {
  const r1 = await routeGroupInboundMessage(ownerMsg("om_o1", "@Flowship 先查一下"), ctx);
  expect(r1).toMatchObject({ kind: "sent" });
  expect(listGroupReplies(TASK)).toHaveLength(1);
  expect(listGroupReplies(TASK)[0]).toMatchObject({ sourceMessageId: "om_o1" });
  runStatus = "running";
  await delta("前半句，");
};

describe("G3-05：属主二次消息遇主链正忙", () => {
  it("注入返回 202 前窗口内的 delta 不丢：第一轮回群答案完整", async () => {
    await startFirstRun();
    handleTaskQuestionInject.mockImplementationOnce(async () => {
      // 注入还没返回时，在飞那一轮的主链继续流式输出
      await delta("窗口内的半句，");
      return queued202();
    });

    const r2 = await routeGroupInboundMessage(ownerMsg("om_o2"), ctx);
    expect(r2).toMatchObject({ kind: "queued" });
    // 入队回执照旧
    expect(sendTextToChat.mock.calls.map((c) => String((c as unknown[])[1])).join("\n")).toContain(
      "当前这轮跑完就处理",
    );

    await delta("尾巴。");
    await done();

    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    const body = sentMarkdown()[0]!;
    expect(body).toContain("前半句，");
    expect(body).toContain("窗口内的半句，");
    expect(body).toContain("尾巴。");
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });

  it("done 恰好落在窗口里：第一轮的登记照常收口，不被新登记顶替后丢失", async () => {
    await startFirstRun();
    handleTaskQuestionInject.mockImplementationOnce(async () => {
      await delta("收尾句。");
      await done();
      return queued202();
    });

    const r2 = await routeGroupInboundMessage(ownerMsg("om_o2"), ctx);
    expect(r2).toMatchObject({ kind: "queued" });

    // 恰好一条回群，且是第一轮的完整答案（不是只剩窗口内那一小段）
    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    const body = sentMarkdown()[0]!;
    expect(body).toContain("前半句，");
    expect(body).toContain("收尾句。");
    // 没有残留的幽灵登记
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });

  it("注入失败（500）：第一轮登记原样还在，答案照常回群", async () => {
    await startFirstRun();
    handleTaskQuestionInject.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: "写盘失败" }), { status: 500 }),
    );
    const r2 = await routeGroupInboundMessage(ownerMsg("om_o2"), ctx);
    expect(r2).toMatchObject({ kind: "failed" });
    expect(listGroupReplies(TASK)).toHaveLength(1);
    expect(listGroupReplies(TASK)[0]).toMatchObject({ sourceMessageId: "om_o1" });

    await delta("尾巴。");
    await done();
    expect(sentMarkdown()[0]).toContain("前半句，");
  });

  it("对照：busy 判定与注入之间主链恰好收尾、注入真起跑（200）→ 这条消息仍要有登记，答案回群", async () => {
    await startFirstRun();
    handleTaskQuestionInject.mockImplementationOnce(async () => ok200());
    const r2 = await routeGroupInboundMessage(ownerMsg("om_o2", "@Flowship 再补一个"), ctx);
    expect(r2).toMatchObject({ kind: "sent" });
    // 新登记属于第二条消息
    const list = listGroupReplies(TASK);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sourceMessageId: "om_o2", requesterOpenId: OWNER });

    await delta("第二轮的答案。");
    await done();
    expect(sentMarkdown()).toHaveLength(1);
    expect(sentMarkdown()[0]).toContain("第二轮的答案。");
  });

  it("对照：收尾窗口（当前 action 已 awaiting_ack、run 还没退）仍是『注入前登记』——注入会等 run 退出后真发出去，新 run 最早的 delta 不能落空", async () => {
    // 这条路径 task-question-inject 走 waitingForDrain：等 runner 退出 → 真 send → 200，
    // 不会入 task 待送达队列；若在这里也跳过预登记，注入返回前流出的 delta 就丢了
    currentAction = { id: "act-1", status: "awaiting_ack" };
    runStatus = "running";
    handleTaskQuestionInject.mockImplementationOnce(async () => {
      await delta("新 run 最早的一句。");
      return ok200();
    });
    const r = await routeGroupInboundMessage(ownerMsg("om_o9", "@Flowship 再补一个"), ctx);
    expect(r).toMatchObject({ kind: "sent" });
    await done();
    expect(sentMarkdown()).toHaveLength(1);
    expect(sentMarkdown()[0]).toContain("新 run 最早的一句。");
  });

  it("对照：任务空闲时的属主消息仍是『注入前登记』——注入返回前流出的 delta 不丢", async () => {
    handleTaskQuestionInject.mockImplementationOnce(async () => {
      // 注入返回之前 agent 已开始输出（先登记再注入正是为这个窗口）
      await delta("抢跑的一句。");
      return ok200();
    });
    const r = await routeGroupInboundMessage(ownerMsg("om_o1"), ctx);
    expect(r).toMatchObject({ kind: "sent" });
    await done();
    expect(sentMarkdown()).toHaveLength(1);
    expect(sentMarkdown()[0]).toContain("抢跑的一句。");
  });
});
