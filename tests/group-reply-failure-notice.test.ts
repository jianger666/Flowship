/**
 * 回群失败要让属主看得见（第三轮 review #2 的 (c) 方案）。
 *
 * 背景：群里文字现在一律走卡片（建卡实体 → 发 interactive），依赖 `cardkit:card:write`。
 * 权限缺失 / cardkit 故障时，连「缺机器人权限」这种提示自己也发不出去，群里一片沉默，
 * 而失败原先只有一条 console.warn。现在 `replyToGroup` 失败时会在任务事件流里留一条 info。
 *
 * 刻意不测、也不做的：纯文本降级出口——「群里别再新加 text / post 出口」是已定的决定。
 *
 * 路由级用例：走真实 routeGroupInboundMessage（忙线时的入队回执就是一条走 replyToGroup 的系统回执），
 * 只 mock 最外层的发群与落盘事件。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

// 只声明签名（不写占位形参，免得 lint 报未使用）：下面要读 mock.calls 里的第 1~3 个入参
const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({
    id: "ev_mock",
  })),
);
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeOwnedEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "group-reply-failure-")),
  "data",
);

const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  routeGroupInboundMessage,
} = await import("@/lib/server/feishu-bridge/group-route");
const shared = await import("@/lib/server/feishu-bridge/group-shared");
const { __resetGroupRosterForTest } = await import(
  "@/lib/server/feishu-bridge/group-roster"
);
const { __resetOutboundRegistryForTest } = await import(
  "@/lib/server/feishu-bridge/group-outbound-registry"
);
const { agentSessions, registerRestrictedQuestion, unregisterRestrictedQuestion } =
  await import("@/lib/server/task-stream");
const { LarkApiError } = await import("@/lib/server/feishu-bridge/types");

const OWNER = "ou_owner";
const BOT = "ou_bot";
const CHAT = "oc_req_group";
const TASK = "task-1";

const taskSummary = (): TaskSummary =>
  ({
    id: TASK,
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

const fullTask = (): Task =>
  ({ ...taskSummary(), actions: [], events: [] }) as unknown as Task;

const msg = (
  sender: string,
  id: string,
  over: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: id,
  create_time: String(Date.now()),
  chat_id: CHAT,
  chat_type: "group",
  message_type: "text",
  sender_id: sender,
  sender_name: sender,
  content: "@Flowship 埋点查了吗",
  mentions: [{ key: "@_user_1", openId: BOT, name: "Flowship" }],
  ...over,
});

const ctx = {
  parseContent: async (m: FeishuInboundMessage) => ({
    text: m.content,
    images: [],
    attachments: [],
  }),
  loadBootContext: async () => ({ apiKey: "sk-test", model: { id: "m1" } }),
};

const okResp = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

let sendTextToChat: ReturnType<typeof vi.fn>;

const installDeps = (over: Record<string, unknown> = {}) =>
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
    injectPendingAskText: vi.fn(async () => ({ ok: true as const })),
    handleTaskQuestionInject: vi.fn(async () => okResp()),
    ...over,
  } as never);

const busyReleasers: Array<() => void> = [];
/** 让 task 处于「旁路答疑在飞」的忙线态：下一条非属主提问会入队、并走 replyToGroup 回一条入队回执 */
const goBusy = (): void => {
  const inFlight = { cancelled: false, cancel: () => {} };
  registerRestrictedQuestion(TASK, inFlight);
  busyReleasers.push(() => unregisterRestrictedQuestion(TASK, inFlight));
};

const resetAll = () => {
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  shared.__resetGroupReplyStateForTest();
  shared.__resetThrottleForTest();
  __resetOutboundRegistryForTest();
};

beforeEach(() => {
  resetAll();
  writeOwnedEventAndPublish.mockReset();
  writeOwnedEventAndPublish.mockImplementation(async () => ({ id: "ev_mock" }));
  sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
  installDeps();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  while (busyReleasers.length > 0) busyReleasers.pop()!();
  agentSessions.delete(TASK);
  __setGroupRouteDepsForTest(null);
  resetAll();
  vi.restoreAllMocks();
});

const route = (m: FeishuInboundMessage) => routeGroupInboundMessage(m, ctx);

/** 只看「回群失败」这类 info（路由里别的路径也可能写 info，不在本文件关心范围） */
const failureNotices = (): string[] =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => c[2] as { kind?: string; text?: string } | undefined)
    .filter((ev) => ev?.kind === "info" && ev.text?.includes("没发出去"))
    .map((ev) => ev!.text!);

describe("回群失败 → 任务事件流留一条 info", () => {
  it("缺 cardkit 权限：翻成人话（缺哪个 scope），写到群关联的任务上；路由本身不受影响", async () => {
    sendTextToChat.mockRejectedValue(
      new Error(
        "app scope not applied for the required scope(s): cardkit:card:write. Please apply in the console.",
      ),
    );
    goBusy();
    const res = await route(msg("ou_x", "om_1"));
    // 失败只是回执没发出去：入队本身照常成功
    expect(res).toMatchObject({ kind: "queued" });

    const notices = failureNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("缺机器人权限：cardkit:card:write");
    // 写到了群关联的任务（不是别的任务），且走 owner 语境（lease 恒真的写入口）
    const call = writeOwnedEventAndPublish.mock.calls.find((c) =>
      String((c[2] as { text?: string } | undefined)?.text ?? "").includes("没发出去"),
    )!;
    expect(call[0]).toBe(TASK);
    expect((call[1] as () => boolean)()).toBe(true);
  });

  it("其它错误：带上飞书错误码与 log_id，方便去飞书侧定位", async () => {
    sendTextToChat.mockRejectedValue(
      new LarkApiError("create card failed", {
        code: 230099,
        api: "api POST /open-apis/cardkit/v1/cards",
        logId: "20261016abc",
      }),
    );
    goBusy();
    await route(msg("ou_x", "om_1"));
    const [notice] = failureNotices();
    expect(notice).toContain("飞书 230099");
    expect(notice).toContain("log_id=20261016abc");
    expect(notice).toContain("cardkit:card:write");
  });

  it("同一个群一分钟内只记一条：连发的回执全挂时不刷屏", async () => {
    sendTextToChat.mockRejectedValue(new Error("lark 5xx"));
    goBusy();
    await route(msg("ou_x", "om_1"));
    await route(msg("ou_y", "om_2"));
    await route(msg("ou_z", "om_3"));
    // 三条回执都尝试发了、都失败了
    expect(sendTextToChat.mock.calls.length).toBeGreaterThanOrEqual(3);
    // 但事件流里只有一条
    expect(failureNotices()).toHaveLength(1);
  });

  it("发送成功不留任何痕迹", async () => {
    goBusy();
    await route(msg("ou_x", "om_1"));
    expect(sendTextToChat).toHaveBeenCalled();
    expect(failureNotices()).toHaveLength(0);
  });

  it("群没关联任何本机任务：没地方可写，只留 warn，不抛", async () => {
    installDeps({
      listTasks: async () => [],
      sendTextToChat: vi.fn(async () => {
        throw new Error("lark 5xx");
      }),
    });
    goBusy();
    // 群没关联任务 → 路由本身会走「没关联」分支；关键只是：不因记录失败而抛
    await expect(route(msg("ou_x", "om_1"))).resolves.toBeDefined();
    expect(failureNotices()).toHaveLength(0);
  });

  it("写事件本身炸了也不抛：回群失败的原有语义（只 warn、返回 false）不变", async () => {
    sendTextToChat.mockRejectedValue(new Error("lark 5xx"));
    writeOwnedEventAndPublish.mockRejectedValue(new Error("disk full"));
    goBusy();
    await expect(route(msg("ou_x", "om_1"))).resolves.toMatchObject({
      kind: "queued",
    });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("记录发群失败时出错"),
      "disk full",
    );
  });

  it("对机器人的系统回执本来就静默（不算失败）：不发、也不记", async () => {
    goBusy();
    await route(
      msg("ou_botx", "om_1", { sender_type: "app" } as Partial<FeishuInboundMessage>),
    );
    expect(failureNotices()).toHaveLength(0);
  });
});
