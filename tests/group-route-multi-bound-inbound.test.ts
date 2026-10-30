/**
 * 群入向：同一个群绑了多个任务时，消息进「活着」的那个，并给它的属主留一条提示（B4-4 / Q12b-02 的接线部分）
 *
 * 走真实的 routeGroupInboundMessage（反查 → 提示 → 注入），只 mock 注入与发群消息、以及「写事件」：
 *  - 群里 @ 的消息进哪个任务：同群有任务在等用户回答 → 进它，而不是 updatedAt 最新的空闲任务（原来的口径会串到刚被碰过的那个）；
 *  - 受理任务的事件流里写一条 info「这个群同时绑定了 N 个任务…」，30 分钟内同一组合只写一次；
 *  - 只绑了一个任务的群：没有任何额外事件（零回归）；
 *  - 提示写不进去（落盘失败）不能打断群问答。
 * 选谁、怎么挑的细节在 group-route-multi-bound.test.ts；提示文案与节流在 group-multi-bound-notice.test.ts。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ id: string } | null>>(async () => ({ id: "ev_owned" })),
);

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeOwnedEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-route-multi-bound-inbound-${Date.now()}`,
  "data",
);

const { __resetGroupChatCacheForTest, __setGroupRouteDepsForTest, routeGroupInboundMessage } = await import(
  "@/lib/server/feishu-bridge/group-route"
);
const { __resetGroupMultiBoundNoticeForTest } = await import(
  "@/lib/server/feishu-bridge/group-multi-bound-notice"
);
const { __resetGroupReplyStateForTest } = await import("@/lib/server/feishu-bridge/group-shared");
const { __resetGroupRosterForTest } = await import("@/lib/server/feishu-bridge/group-roster");

const OWNER = "ou_owner";
const BOT = "ou_bot";
const CHAT = "oc_shared";
const STORY = "https://project.feishu.cn/space/story/detail/10001";
const NOW = Date.now();

type Spec = { id: string; updatedAt: number; hasPendingAsk?: boolean };
let specs: Spec[] = [];

const summaryOf = (s: Spec): TaskSummary =>
  ({
    id: s.id,
    title: `任务 ${s.id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    updatedAt: s.updatedAt,
    createdAt: s.updatedAt,
    repoPaths: ["/tmp/repo"],
    currentActionId: null,
    mrs: [],
    actionCount: 0,
    feishuStoryUrl: STORY,
    feishuGroupChatId: CHAT,
    ...(s.hasPendingAsk ? { hasPendingAsk: true } : {}),
  }) as TaskSummary;

const fullTask = (id: string): Task | null => {
  const s = specs.find((x) => x.id === id);
  return s ? ({ ...summaryOf(s), actions: [], events: [] } as unknown as Task) : null;
};

const ownerMsg = (id: string): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: id,
  create_time: String(Date.now()),
  chat_id: CHAT,
  chat_type: "group",
  message_type: "text",
  sender_id: OWNER,
  sender_name: "属主",
  content: "@Flowship 进度怎么样",
  mentions: [{ key: "@_user_1", openId: BOT, name: "Flowship" }],
});

const ctx = {
  parseContent: async (m: FeishuInboundMessage) => ({ text: m.content, images: [], attachments: [] }),
  loadBootContext: async () => ({ apiKey: "sk-test", model: { id: "m1" } }),
};

let handleTaskQuestionInject: ReturnType<typeof vi.fn>;

const multiBoundEvents = () =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => ({ taskId: String(c[0]), event: c[2] as { kind?: string; text?: string } }))
    .filter((c) => c.event.kind === "info" && String(c.event.text).includes("同时绑定了"));

beforeEach(() => {
  specs = [];
  writeOwnedEventAndPublish.mockClear();
  writeOwnedEventAndPublish.mockImplementation(async () => ({ id: "ev_owned" }));
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
  __resetGroupMultiBoundNoticeForTest();
  handleTaskQuestionInject = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
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
    sendTextToChat: vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" })),
    listTasks: async () => specs.map(summaryOf),
    getTask: async (id: string) => fullTask(id),
    getBoundGroupChatId: async () => CHAT,
    getPendingAsk: () => null,
    handleTaskQuestionInject,
  } as never);
});

afterEach(() => {
  __setGroupRouteDepsForTest(null);
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  __resetGroupReplyStateForTest();
  __resetGroupMultiBoundNoticeForTest();
  vi.restoreAllMocks();
});

describe("同一个群绑了两个任务", () => {
  it("较旧的任务有待回答的提问 → 群消息进它（不是更新的空闲任务），并在它的事件流里留一条提示", async () => {
    specs = [
      { id: "idle-new", updatedAt: NOW },
      { id: "asking-old", updatedAt: NOW - 60_000, hasPendingAsk: true },
    ];
    const r = await routeGroupInboundMessage(ownerMsg("om_1"), ctx);
    expect(r).toMatchObject({ kind: "sent", taskId: "asking-old" });
    expect(handleTaskQuestionInject.mock.calls[0]![0]).toBe("asking-old");

    const events = multiBoundEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.taskId).toBe("asking-old");
    expect(events[0]!.event.text).toContain("这个群同时绑定了 2 个任务（本任务和「任务 idle-new」）");
    expect(events[0]!.event.text).toContain("这条进了本任务");
  });

  it("都空闲 → 仍进 updatedAt 最新的（原口径），提示写在它的事件流里", async () => {
    specs = [
      { id: "idle-new", updatedAt: NOW },
      { id: "idle-old", updatedAt: NOW - 60_000 },
    ];
    const r = await routeGroupInboundMessage(ownerMsg("om_1"), ctx);
    expect(r).toMatchObject({ kind: "sent", taskId: "idle-new" });
    expect(multiBoundEvents().map((e) => e.taskId)).toEqual(["idle-new"]);
  });

  it("连着问几句：提示 30 分钟内只写一次", async () => {
    specs = [
      { id: "a", updatedAt: NOW },
      { id: "b", updatedAt: NOW - 1000 },
    ];
    await routeGroupInboundMessage(ownerMsg("om_1"), ctx);
    await routeGroupInboundMessage(ownerMsg("om_2"), ctx);
    await routeGroupInboundMessage(ownerMsg("om_3"), ctx);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(3);
    expect(multiBoundEvents()).toHaveLength(1);
  });

  it("过了 30 分钟窗口再问一句：再写一条提示（入向链用的是当前时间、不是固定值；29 分钟内仍不写）", async () => {
    specs = [
      { id: "a", updatedAt: NOW },
      { id: "b", updatedAt: NOW - 1000 },
    ];
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      await routeGroupInboundMessage(ownerMsg("om_1"), ctx);
      expect(multiBoundEvents()).toHaveLength(1);
      vi.setSystemTime(NOW + 29 * 60_000);
      await routeGroupInboundMessage(ownerMsg("om_2"), ctx);
      expect(multiBoundEvents()).toHaveLength(1);
      vi.setSystemTime(NOW + 31 * 60_000);
      await routeGroupInboundMessage(ownerMsg("om_3"), ctx);
      expect(multiBoundEvents()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("写提示失败（落盘出错）不打断群问答：消息照常注入、返回 sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeOwnedEventAndPublish.mockImplementation(async () => {
      throw new Error("磁盘满了");
    });
    specs = [
      { id: "a", updatedAt: NOW },
      { id: "b", updatedAt: NOW - 1000 },
    ];
    const r = await routeGroupInboundMessage(ownerMsg("om_1"), ctx);
    expect(r).toMatchObject({ kind: "sent", taskId: "a" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
  });
});

describe("只绑了一个任务的群：零回归", () => {
  it("正常注入，没有任何「同时绑定」事件", async () => {
    specs = [{ id: "only", updatedAt: NOW }];
    const r = await routeGroupInboundMessage(ownerMsg("om_1"), ctx);
    expect(r).toMatchObject({ kind: "sent", taskId: "only" });
    expect(multiBoundEvents()).toEqual([]);
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
  });
});
