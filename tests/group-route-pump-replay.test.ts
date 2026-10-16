/**
 * 群问题排队回放（pump）的两条边界——走真实 pumpGroupQuestionQueue / injectGroupMessage：
 *
 * - G3-03：fromPump 遇忙必须静默放回队首。原实现 fromPump 不入队后直接落到
 *   `replyToGroup(busyReason)`，每次 pump 遇忙都再对真人发一遍忙线文案
 *   （注释与 docs/feishu-group-collab.md 写的是「静默」）。
 * - G3-04：回放的排队问题遇到 pending ask 时，`hasPendingAsk` 没按 fromPump 排除，
 *   这条问题会被当成 agent ask_user 的答案吞掉，提问人得不到答疑。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-route-pump-replay-${Date.now()}`,
  "data",
);

const {
  __setGroupRouteDepsForTest,
  GROUP_RESTRICTED_QUESTION_RUNNING,
  GROUP_TASK_RUNNING,
  pumpGroupQuestionQueue,
} = await import("@/lib/server/feishu-bridge/group-route");
const {
  __resetGroupReplyStateForTest,
  enqueueGroupQuestion,
  groupQuestionQueueLength,
  listGroupQuestionQueueView,
} = await import("@/lib/server/feishu-bridge/group-shared");
const { registerRestrictedQuestion, unregisterRestrictedQuestion } = await import(
  "@/lib/server/task-stream"
);

const CHAT = "oc_req_group";
const TASK = "task-1";

const fullTask = (over: Partial<Task> = {}): Task =>
  ({
    id: TASK,
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    repoPaths: ["/tmp/repo"],
    mrs: [],
    actions: [],
    events: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    feishuStoryUrl: "https://project.feishu.cn/space/story/detail/10001",
    ...over,
  }) as unknown as Task;

const seedQueued = (
  messageId = "om_q1",
  text = "埋点查了吗",
  over: Record<string, unknown> = {},
) =>
  enqueueGroupQuestion(TASK, {
    messageId,
    chatId: CHAT,
    text,
    parsed: { text, images: [], attachments: [] } as never,
    requester: { openId: "ou_li", name: "李四" },
    boot: { apiKey: "k", model: { id: "m" } },
    ...over,
  });

let handleTaskQuestionInject: ReturnType<typeof vi.fn>;
let injectPendingAskText: ReturnType<typeof vi.fn>;
let sendTextToChat: ReturnType<typeof vi.fn>;

const installDeps = (over: Record<string, unknown> = {}) =>
  __setGroupRouteDepsForTest({
    handleTaskQuestionInject,
    injectPendingAskText,
    sendTextToChat,
    getTask: async () => fullTask(),
    getPendingAsk: () => null,
    ...over,
  } as never);

beforeEach(() => {
  __resetGroupReplyStateForTest();
  handleTaskQuestionInject = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  injectPendingAskText = vi.fn(async () => ({ ok: true as const }));
  sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
  installDeps();
});

afterEach(() => {
  __setGroupRouteDepsForTest(null);
  __resetGroupReplyStateForTest();
});

const sentTexts = (): string[] =>
  sendTextToChat.mock.calls.map((c) => String((c as unknown[])[1]));

describe("G3-03：fromPump 遇忙静默放回，不再对真人发忙线文案", () => {
  it("旁路答疑在飞：pump 不回群、队首原样放回、不注入", async () => {
    seedQueued();
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(TASK, inFlight);
    try {
      await pumpGroupQuestionQueue(TASK);
    } finally {
      unregisterRestrictedQuestion(TASK, inFlight);
    }
    // 静默：真人也不该被每次 pump 刷一遍「等这一轮结束再问」
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(sentTexts().join("\n")).not.toContain(GROUP_RESTRICTED_QUESTION_RUNNING);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    // 放回队首、没丢
    expect(groupQuestionQueueLength(TASK)).toBe(1);
    expect(listGroupQuestionQueueView(TASK)[0]?.id).toBe("om_q1");
  });

  it("task 主链在跑（runStatus=running）：同样静默放回", async () => {
    installDeps({ getTask: async () => fullTask({ runStatus: "running" }) });
    seedQueued();
    await pumpGroupQuestionQueue(TASK);
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(sentTexts().join("\n")).not.toContain(GROUP_TASK_RUNNING);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(groupQuestionQueueLength(TASK)).toBe(1);
  });

  it("连 pump 多次（done / action 帧连着到）也不累积忙线文案；忙完后照常按序注入", async () => {
    seedQueued("om_q1", "第一个问题");
    seedQueued("om_q2", "第二个问题");
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(TASK, inFlight);
    try {
      await pumpGroupQuestionQueue(TASK);
      await pumpGroupQuestionQueue(TASK);
      await pumpGroupQuestionQueue(TASK);
    } finally {
      unregisterRestrictedQuestion(TASK, inFlight);
    }
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(groupQuestionQueueLength(TASK)).toBe(2);
    // 放回的是队首：FIFO 不被打乱
    expect(listGroupQuestionQueueView(TASK).map((e) => e.id)).toEqual([
      "om_q1",
      "om_q2",
    ]);

    await pumpGroupQuestionQueue(TASK);
    const texts = handleTaskQuestionInject.mock.calls.map(
      (c) => ((c as unknown[])[1] as { text: string }).text,
    );
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("第一个问题");
    expect(texts[1]).toContain("第二个问题");
    expect(groupQuestionQueueLength(TASK)).toBe(0);
  });
});

describe("G3-04：回放的排队问题不被 pending ask 吞成 agent 提问的答案", () => {
  it("有未答 ask_user 时回放：不走 injectPendingAskText，改走只读答疑旁路", async () => {
    installDeps({ getPendingAsk: () => ({ askId: "ask-1", questions: [] }) });
    seedQueued("om_q1", "埋点查了吗");

    await pumpGroupQuestionQueue(TASK);

    // 没被当成答案吞掉
    expect(injectPendingAskText).not.toHaveBeenCalled();
    // 提问人得到答疑：问题进了只读旁路（restrictToQuestion），而不是丢了
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    const [, body, opts] = handleTaskQuestionInject.mock.calls[0] as unknown as [
      string,
      { text: string },
      { restrictToQuestion?: boolean; restrictedRunTag?: string },
    ];
    expect(body.text).toContain("埋点查了吗");
    expect(opts.restrictToQuestion).toBe(true);
    // 回群登记挂在旁路 token 上（不是属主通道），回答才投得回提问人
    expect(opts.restrictedRunTag).toBeTruthy();
    expect(groupQuestionQueueLength(TASK)).toBe(0);
  });

  it("对照：非回放的普通群消息遇 pending ask，仍当 ask 答案（这条路径不能被误改）", async () => {
    installDeps({ getPendingAsk: () => ({ askId: "ask-1", questions: [] }) });
    const { routeGroupInboundMessage } = await import(
      "@/lib/server/feishu-bridge/group-route"
    );
    // 与 feishu-group-inbound 同款最小入口：非属主群消息 → pending ask 当答案
    const mkMsg = () => ({
      type: "im.message.receive_v1",
      message_id: "om_live",
      create_time: String(Date.now()),
      chat_id: CHAT,
      chat_type: "group",
      message_type: "text",
      sender_id: "ou_li",
      sender_name: "李四",
      content: "@Flowship 选方案 B",
      mentions: [{ key: "@_user_1", openId: "ou_bot", name: "Flowship" }],
    });
    installDeps({
      getPendingAsk: () => ({ askId: "ask-1", questions: [] }),
      getBotAppInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_owner" }),
      getBotOpenId: async () => "ou_bot",
      getBotDisplayName: async () => "Flowship",
      listTasks: async () => [
        {
          ...fullTask(),
          actionCount: 0,
        } as never,
      ],
      getBoundGroupChatId: async () => CHAT,
    });
    const r = await routeGroupInboundMessage(mkMsg() as never, {
      parseContent: async (m: { content: string }) => ({
        text: m.content,
        images: [],
        attachments: [],
      }),
      loadBootContext: async () => ({ apiKey: "k", model: { id: "m" } }),
    } as never);
    expect(r).toMatchObject({ kind: "sent" });
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
  });
});
