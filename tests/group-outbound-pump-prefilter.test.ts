/**
 * G3-01：出向 tap 的相关性预筛不能把「群问题排队非空」的 done / task / action 帧挡掉。
 *
 * 缺陷：预筛 `!hasGroupReplies(taskId)` 排在 done / task / action 分支之前就 return。
 * 非属主的排队问题不建回群登记，属主在 app 里发起的 run 也没有登记——于是 app 里的 run
 * 一结束没人触发排空，排队的同事问题要等下一条群 @ 或 30 分钟后回「超时作废」。
 *
 * 这里走**真实 pump**（出向默认依赖 → 动态 import group-route → 真 injectGroupMessage），
 * 只 mock 最外层的 handleTaskQuestionInject / 发群消息，不 mock pump 本身。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-outbound-pump-prefilter-${Date.now()}`,
  "data",
);

const { __resetGroupOutboundForTest, __setGroupOutboundDepsForTest, handleGroupOutboundEvent } =
  await import("@/lib/server/feishu-bridge/group-outbound");
const { __setGroupRouteDepsForTest } = await import(
  "@/lib/server/feishu-bridge/group-route"
);
const {
  __resetGroupReplyStateForTest,
  enqueueGroupQuestion,
  groupQuestionQueueLength,
  listGroupReplies,
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

const seedQueued = (messageId = "om_q1", text = "埋点查了吗") =>
  enqueueGroupQuestion(TASK, {
    messageId,
    chatId: CHAT,
    text,
    parsed: { text, images: [], attachments: [] } as never,
    requester: { openId: "ou_li", name: "李四" },
    boot: { apiKey: "k", model: { id: "m" } },
  });

let handleTaskQuestionInject: ReturnType<typeof vi.fn>;
let sendTextToChat: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetGroupReplyStateForTest();
  handleTaskQuestionInject = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
  __setGroupRouteDepsForTest({
    handleTaskQuestionInject,
    sendTextToChat,
    getTask: async () => fullTask(),
    getPendingAsk: () => null,
  } as never);
  // 只开桥接开关；pumpGroupQuestionQueue 保持默认依赖 = 真实 pump
  __setGroupOutboundDepsForTest({ isBridgeEnabled: async () => true });
});

afterEach(() => {
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  __setGroupRouteDepsForTest(null);
  __resetGroupReplyStateForTest();
});

describe("G3-01：无登记 + 队列非空 的 done / task / action 帧必须 pump（真实 pump）", () => {
  it("done 帧：无回群登记、队列非空 → 真实 pump 把队首注入", async () => {
    seedQueued();
    // 前置：确实是「无登记」的场景（属主在 app 里发起的 run / 非属主排队都不建登记）
    expect(listGroupReplies(TASK)).toHaveLength(0);
    expect(groupQuestionQueueLength(TASK)).toBe(1);

    await handleGroupOutboundEvent(TASK, {
      kind: "done",
      task: fullTask(),
      ok: true,
    });

    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    const [, body] = handleTaskQuestionInject.mock.calls[0] as unknown as [
      string,
      { text: string },
    ];
    expect(body.text).toContain("埋点查了吗");
    expect(groupQuestionQueueLength(TASK)).toBe(0);
  });

  it("task 帧：无登记 + 队列非空 → pump", async () => {
    seedQueued();
    await handleGroupOutboundEvent(TASK, {
      kind: "task",
      task: fullTask(),
    } as never);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(groupQuestionQueueLength(TASK)).toBe(0);
  });

  it("action 帧：无登记 + 队列非空 → pump", async () => {
    seedQueued();
    await handleGroupOutboundEvent(TASK, {
      kind: "action",
      action: { id: "act-1", status: "awaiting_ack" },
    } as never);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(groupQuestionQueueLength(TASK)).toBe(0);
  });

  it("高频帧（assistant_delta / event）即使队列非空也不触发 pump（预筛仍要拦住）", async () => {
    seedQueued();
    await handleGroupOutboundEvent(TASK, {
      kind: "assistant_delta",
      text: "一个 token",
    } as never);
    await handleGroupOutboundEvent(TASK, {
      kind: "event",
      event: { id: "e1", seq: 1, at: Date.now(), kind: "assistant_message", text: "x" },
    } as never);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(groupQuestionQueueLength(TASK)).toBe(1);
  });

  it("队列为空 + 无登记：done 帧什么都不做（预筛原行为不变）", async () => {
    await handleGroupOutboundEvent(TASK, {
      kind: "done",
      task: fullTask(),
      ok: true,
    });
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(sendTextToChat).not.toHaveBeenCalled();
  });

  it("桥接总开关关掉：队列非空也不 pump（开关判定仍排在预筛之后）", async () => {
    __setGroupOutboundDepsForTest({ isBridgeEnabled: async () => false });
    seedQueued();
    await handleGroupOutboundEvent(TASK, {
      kind: "done",
      task: fullTask(),
      ok: true,
    });
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(groupQuestionQueueLength(TASK)).toBe(1);
  });

  it("pump 时旁路答疑仍在飞：放回队首、不丢（预筛放行不改变 pump 的忙判定）", async () => {
    seedQueued();
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(TASK, inFlight);
    try {
      await handleGroupOutboundEvent(TASK, {
        kind: "done",
        task: fullTask(),
        ok: true,
      });
      expect(handleTaskQuestionInject).not.toHaveBeenCalled();
      expect(groupQuestionQueueLength(TASK)).toBe(1);
    } finally {
      unregisterRestrictedQuestion(TASK, inFlight);
    }
  });
});
