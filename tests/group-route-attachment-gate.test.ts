/**
 * P1：群里非属主的附件，必须先过鉴权 / 限流 / 忙线闸门、通过了才下载。
 *
 * 旧实现在第 5 步一律先 `parseContent`（= 下载图 / 文件 / 视频），再判是不是属主、要不要限流：
 * 陌生人（或对端机器人）刷文件会占满全局单飞的 lark 队列，拖住属主的消息；被限流 / 拒收的消息也白下了一遍。
 * 现在非属主只做「预解析」（`deferDownloads`：拿正文 + 知道有没有资源，不下载），
 * 闸门全过之后在 injectGroupMessage 里 `deferred.resolve()` 才真正下载。属主本人照旧即时下载。
 *
 * 这里走真实 routeGroupInboundMessage / pump，只 mock 外层依赖；`parseContent` 换成会记录「谁真的下载了」的假实现
 * （router 侧 deferDownloads 本身的行为在 feishu-bridge-router.test.ts 钉）。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

// 旁路限流的 info 事件走真实落盘太重——mock 掉写入口
const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn(async () => ({ id: "ev_mock" })),
);
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeOwnedEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-route-attachment-gate-${Date.now()}`,
  "data",
);

const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  GROUP_ADVANCE_NOT_OWNER,
  GROUP_CHAT_NOT_OWNER,
  pumpGroupQuestionQueue,
  routeGroupInboundMessage,
} = await import("@/lib/server/feishu-bridge/group-route");
const shared = await import("@/lib/server/feishu-bridge/group-shared");
const { __resetGroupRosterForTest } = await import(
  "@/lib/server/feishu-bridge/group-roster"
);
const { registerRestrictedQuestion, unregisterRestrictedQuestion } = await import(
  "@/lib/server/task-stream"
);

import type { ParsedInboundContent } from "@/lib/server/feishu-bridge/router";

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
// 群答疑默认关闭（P0 硬化）：本文件测非属主附件闸，夹具显式开启
const fullTask = (over: Partial<Task> = {}): Task =>
  ({ ...taskSummary(), actions: [], events: [], ...over }) as unknown as Task;

/** 消息正文里带 `[附件]` / `[图]` 标记 = 这条消息有待下载的文件 / 图片（假 parseContent 据此造资源） */
const msg = (
  sender: string,
  id: string,
  content = "@Flowship 看下这个 [附件]",
  over: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: id,
  create_time: String(Date.now()),
  chat_id: CHAT,
  chat_type: "group",
  message_type: "post",
  sender_id: sender,
  sender_name: sender,
  content,
  mentions: [{ key: "@_user_1", openId: BOT, name: "Flowship" }],
  ...over,
});

// ---- 假 parseContent：记录调用方式与「真下载」----
/** 真正发生「下载」的 messageId（deferred.resolve() 被调、或非 defer 模式立即下载） */
let downloads: string[] = [];
/** 每次 parseContent 的调用：是否带 deferDownloads */
let parseCalls: Array<{ id: string; opts: { deferDownloads?: boolean } | undefined }> = [];
/** 下载结果的覆盖（失败 / unsupported / 额外文案用例用）；返回 undefined = 默认结果 */
let downloadOverride:
  | ((m: FeishuInboundMessage) => Promise<ParsedInboundContent | undefined>)
  | null = null;

const IMG = { data: "aGVsbG8=", mimeType: "image/png", filename: "p.png" };
const filePath = (id: string): string => `/bridge/attachments/${id}/ab12cd-x.pdf`;

const parseContent = async (
  m: FeishuInboundMessage,
  opts?: { deferDownloads?: boolean },
): Promise<ParsedInboundContent> => {
  parseCalls.push({ id: m.message_id, opts });
  const hasImg = m.content.includes("[图]");
  const hasFile = m.content.includes("[附件]");
  const text = m.content.replace("[图]", "").replace("[附件]", "").trim();
  if (!hasImg && !hasFile) return { text, images: [], attachments: [] };
  const download = async (): Promise<ParsedInboundContent> => {
    downloads.push(m.message_id);
    const over = downloadOverride ? await downloadOverride(m) : undefined;
    if (over) return over;
    return {
      text,
      images: hasImg ? [IMG] : [],
      attachments: hasFile ? [filePath(m.message_id)] : [],
    };
  };
  if (!opts?.deferDownloads) return download();
  return {
    text,
    images: [],
    attachments: [],
    deferred: { hasImages: hasImg, resolve: download },
  };
};

const ctx = {
  parseContent,
  loadBootContext: async () => ({ apiKey: "sk-test", model: { id: "m1" } }),
};

let handleTaskQuestionInject: ReturnType<typeof vi.fn>;
let injectPendingAskText: ReturnType<typeof vi.fn>;
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
    injectPendingAskText,
    handleTaskQuestionInject,
    ...over,
  } as never);

beforeEach(() => {
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  shared.__resetGroupReplyStateForTest();
  writeOwnedEventAndPublish.mockClear();
  downloads = [];
  parseCalls = [];
  downloadOverride = null;
  handleTaskQuestionInject = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  injectPendingAskText = vi.fn(async () => ({ ok: true as const }));
  sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
  installDeps();
});

afterEach(() => {
  __setGroupRouteDepsForTest(null);
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  shared.__resetGroupReplyStateForTest();
});

const sentTexts = (): string[] =>
  sendTextToChat.mock.calls.map((c) => String((c as unknown[])[1]));
/** handleTaskQuestionInject 第 n 次调用的载荷（第 2 个参数） */
const injectedPayload = (n = 0) =>
  (handleTaskQuestionInject.mock.calls[n] as unknown[])[1] as {
    text: string;
    images?: unknown[];
    attachments?: string[];
  };

describe("非属主：预解析不下载，闸门全拦下的消息零下载", () => {
  it("非属主 → 以 deferDownloads 预解析（不下载）；属主 → 不带 defer、即时下载（旧行为）", async () => {
    await routeGroupInboundMessage(msg("ou_stranger", "om_s1"), ctx);
    await routeGroupInboundMessage(msg(OWNER, "om_o1"), ctx);

    expect(parseCalls).toEqual([
      { id: "om_s1", opts: { deferDownloads: true } },
      { id: "om_o1", opts: undefined },
    ]);
  });

  it("非属主发「推进」命令（被属主闸拒绝）：零下载", async () => {
    const r = await routeGroupInboundMessage(
      msg("ou_stranger", "om_adv", "@Flowship 推进 [附件]"),
      ctx,
    );

    expect(r).toMatchObject({ kind: "skipped", error: GROUP_ADVANCE_NOT_OWNER });
    expect(downloads).toEqual([]);
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
  });

  it("chat 型任务 + 非属主（被 chat 闸拒绝）：零下载", async () => {
    installDeps({ getTask: async () => fullTask({ mode: "chat" }) });

    const r = await routeGroupInboundMessage(msg("ou_stranger", "om_chat"), ctx);

    expect(r).toMatchObject({ kind: "skipped", error: GROUP_CHAT_NOT_OWNER });
    expect(downloads).toEqual([]);
    expect(sentTexts().some((t) => t.includes(GROUP_CHAT_NOT_OWNER))).toBe(true);
  });

  it("旁路滑动窗限流（总限额 12 次）已满：第 13 个带附件的被静默丢弃，零下载", async () => {
    for (let i = 0; i < 12; i++) {
      // 纯文本：占满名额，不涉及下载
      const r = await routeGroupInboundMessage(
        msg(`ou_u${i}`, `om_t${i}`, "@Flowship 查下埋点"),
        ctx,
      );
      expect(r).toMatchObject({ kind: "sent" });
    }
    downloads = [];
    sendTextToChat.mockClear();

    const r = await routeGroupInboundMessage(msg("ou_u13", "om_att13"), ctx);

    expect(r).toMatchObject({ kind: "skipped" });
    expect(downloads).toEqual([]); // 被限流的陌生人附件白下一遍的老问题
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(12);
    expect(sendTextToChat).not.toHaveBeenCalled(); // 限流静默
  });

  it("个人限额（每人 4 次）已满：同一人第 5 个带附件的被丢弃，零下载", async () => {
    for (let i = 0; i < 4; i++) {
      await routeGroupInboundMessage(
        msg("ou_chatty", `om_c${i}`, "@Flowship 问题"),
        ctx,
      );
    }
    downloads = [];

    const r = await routeGroupInboundMessage(msg("ou_chatty", "om_c_att"), ctx);

    expect(r).toMatchObject({ kind: "skipped" });
    expect(downloads).toEqual([]);
  });

  it("忙线 + 带图（带图不排队）：忙线拒收，零下载", async () => {
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(TASK, inFlight);
    try {
      const r = await routeGroupInboundMessage(
        msg("ou_stranger", "om_busy_img", "@Flowship 看图 [图]"),
        ctx,
      );
      expect(r).toMatchObject({ kind: "skipped" });
      expect(downloads).toEqual([]);
      expect(sentTexts().some((t) => t.includes("群答疑还在跑"))).toBe(true);
    } finally {
      unregisterRestrictedQuestion(TASK, inFlight);
    }
  });

  it("忙线 + 只有文件：照常排队（入队时零下载）；回放起 run 时才下载一次，附件随注入送达", async () => {
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(TASK, inFlight);
    try {
      const r = await routeGroupInboundMessage(
        msg("ou_stranger", "om_q1", "@Flowship 看下文件 [附件]"),
        ctx,
      );
      expect(r).toMatchObject({ kind: "queued" });
    } finally {
      unregisterRestrictedQuestion(TASK, inFlight);
    }
    expect(downloads).toEqual([]); // 排队期间不下载（也不在内存里躺着附件）
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();

    await pumpGroupQuestionQueue(TASK);

    expect(downloads).toEqual(["om_q1"]);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    expect(injectedPayload().attachments).toEqual([filePath("om_q1")]);
    expect(shared.groupQuestionQueueLength(TASK)).toBe(0);
  });
});

describe("非属主答 pendingAsk 也过限流闸：被拦下的零下载、不动 pendingAsk；答成功不占名额", () => {
  const withPendingAsk = () =>
    installDeps({ getPendingAsk: () => ({ askId: "ask-1", questions: [] }) });

  it("旁路窗总限额（12 次）已被刷满：非属主带图答 pendingAsk 被静默丢弃——零下载、不消费 pendingAsk、群里不回", async () => {
    for (let i = 0; i < 12; i++) {
      const r = await routeGroupInboundMessage(
        msg(`ou_u${i}`, `om_f${i}`, "@Flowship 查下埋点"),
        ctx,
      );
      expect(r).toMatchObject({ kind: "sent" });
    }
    downloads = [];
    sendTextToChat.mockClear();
    withPendingAsk();

    const r = await routeGroupInboundMessage(
      msg("ou_late", "om_ask_att", "@Flowship 选这个 [附件]"),
      ctx,
    );

    expect(r).toMatchObject({ kind: "skipped" });
    expect(downloads).toEqual([]); // 旧实现：pendingAsk 免检，这里白下一遍
    expect(injectPendingAskText).not.toHaveBeenCalled();
    expect(sendTextToChat).not.toHaveBeenCalled(); // 限流静默
  });

  it("个人限额（每人 4 次）已满：同一人带图答 pendingAsk 同样被丢弃，零下载", async () => {
    for (let i = 0; i < 4; i++) {
      await routeGroupInboundMessage(msg("ou_chatty", `om_pc${i}`, "@Flowship 问题"), ctx);
    }
    downloads = [];
    withPendingAsk();

    const r = await routeGroupInboundMessage(
      msg("ou_chatty", "om_pc_att", "@Flowship 选 B [图]"),
      ctx,
    );

    expect(r).toMatchObject({ kind: "skipped" });
    expect(downloads).toEqual([]);
    expect(injectPendingAskText).not.toHaveBeenCalled();
  });

  it("答 pendingAsk 成功不占名额（它不起旁路 run）：同一人连答 6 次（> 个人上限 4）都成功，之后他的普通提问仍被受理", async () => {
    withPendingAsk();
    for (let i = 0; i < 6; i++) {
      const r = await routeGroupInboundMessage(
        msg("ou_helper", `om_pa${i}`, "@Flowship 选这个 [图]"),
        ctx,
      );
      expect(r).toMatchObject({ kind: "sent" });
    }
    expect(injectPendingAskText).toHaveBeenCalledTimes(6);
    expect(downloads).toHaveLength(6);

    installDeps(); // 没有待答提问了：回到普通旁路提问
    const normal = await routeGroupInboundMessage(
      msg("ou_helper", "om_after", "@Flowship 再问个问题"),
      ctx,
    );
    expect(normal).toMatchObject({ kind: "sent" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
  });

  it("答 pendingAsk 失败（非 no_pending）：名额同样退还，不白占", async () => {
    injectPendingAskText.mockImplementation(async () => ({
      ok: false as const,
      reason: "failed" as const,
      error: "注入失败",
    }));
    withPendingAsk();
    for (let i = 0; i < 6; i++) {
      const r = await routeGroupInboundMessage(
        msg("ou_helper", `om_pf${i}`, "@Flowship 选这个"),
        ctx,
      );
      expect(r).toMatchObject({ kind: "failed" });
    }
    // 6 次失败都没占名额：个人额度（4）没被吃掉，随后普通提问仍受理
    installDeps();
    expect(
      await routeGroupInboundMessage(msg("ou_helper", "om_pf_after", "@Flowship 再问"), ctx),
    ).toMatchObject({ kind: "sent" });
  });

  it("答 pendingAsk 撞 no_pending 落回旁路：名额沿用准入点 ① 扣的那一个（个人上限 4：第 5 条被丢弃，且不重复扣）", async () => {
    injectPendingAskText.mockImplementation(async () => ({
      ok: false as const,
      reason: "no_pending" as const,
      error: "没有待答提问",
    }));
    withPendingAsk();
    for (let i = 0; i < 4; i++) {
      expect(
        await routeGroupInboundMessage(msg("ou_race", `om_race${i}`, "@Flowship 选这个"), ctx),
      ).toMatchObject({ kind: "sent" });
    }
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(4);
    expect(
      await routeGroupInboundMessage(msg("ou_race", "om_race4", "@Flowship 选这个"), ctx),
    ).toMatchObject({ kind: "skipped" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(4);
  });

  it("属主答 pendingAsk 不过限流闸（属主不受限）：窗口刷满后仍即时下载并送达", async () => {
    for (let i = 0; i < 12; i++) {
      await routeGroupInboundMessage(msg(`ou_u${i}`, `om_g${i}`, "@Flowship 查下埋点"), ctx);
    }
    downloads = [];
    withPendingAsk();

    const r = await routeGroupInboundMessage(msg(OWNER, "om_owner_ask", "@Flowship 选 A [图]"), ctx);

    expect(r).toMatchObject({ kind: "sent" });
    expect(downloads).toEqual(["om_owner_ask"]);
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
  });
});

describe("非属主：闸门全过 → 才下载一次、注入带上资源", () => {
  it("带文件：下载一次，附件路径进注入载荷；正文兜底不丢", async () => {
    const r = await routeGroupInboundMessage(msg("ou_stranger", "om_ok_file"), ctx);

    expect(r).toMatchObject({ kind: "sent" });
    expect(downloads).toEqual(["om_ok_file"]);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
    const payload = injectedPayload();
    expect(payload.attachments).toEqual([filePath("om_ok_file")]);
    expect(payload.images).toBeUndefined();
    expect(payload.text).toContain("非任务所有者");
    expect(payload.text).toContain("看下这个");
  });

  it("带图：下载一次，images 进注入载荷", async () => {
    const r = await routeGroupInboundMessage(
      msg("ou_stranger", "om_ok_img", "@Flowship 看图 [图]"),
      ctx,
    );

    expect(r).toMatchObject({ kind: "sent" });
    expect(downloads).toEqual(["om_ok_img"]);
    expect(injectedPayload().images).toEqual([IMG]);
    expect(injectedPayload().attachments).toBeUndefined();
  });

  it("纯文本（无资源）：不带 deferred、不下载，行为不变", async () => {
    const r = await routeGroupInboundMessage(
      msg("ou_stranger", "om_plain", "@Flowship 埋点查了吗"),
      ctx,
    );
    expect(r).toMatchObject({ kind: "sent" });
    expect(downloads).toEqual([]);
    expect(injectedPayload().attachments).toBeUndefined();
  });

  it("属主本人：即时下载（不走延后）、附件随注入送达", async () => {
    const r = await routeGroupInboundMessage(msg(OWNER, "om_owner_att"), ctx);

    expect(r).toMatchObject({ kind: "sent" });
    expect(downloads).toEqual(["om_owner_att"]);
    expect(injectedPayload().attachments).toEqual([filePath("om_owner_att")]);
  });

  it("答 pendingAsk 的非属主带图回复（合法的受限通道）：下载后图片随答案送达", async () => {
    installDeps({ getPendingAsk: () => ({ askId: "ask-1", questions: [] }) });

    const r = await routeGroupInboundMessage(
      msg("ou_stranger", "om_ask_img", "@Flowship 选这个 [图]"),
      ctx,
    );

    expect(r).toMatchObject({ kind: "sent" });
    expect(downloads).toEqual(["om_ask_img"]);
    expect(injectPendingAskText).toHaveBeenCalledTimes(1);
    expect((injectPendingAskText.mock.calls[0] as unknown[])[3]).toEqual([IMG]);
  });
});

describe("非属主：下载阶段失败 / 不支持 → 回执 + 退还旁路名额，不起 run", () => {
  it("下载抛错：failed 且 retryable（等补拉重投）、群里回原因、不注入", async () => {
    downloadOverride = async () => {
      throw new Error("lark 下载超时");
    };

    const r = await routeGroupInboundMessage(msg("ou_stranger", "om_dl_fail"), ctx);

    expect(r).toMatchObject({ kind: "failed", retryable: true });
    expect((r as { error?: string }).error).toContain("解析消息失败：lark 下载超时");
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(sentTexts().some((t) => t.includes("lark 下载超时"))).toBe(true);
  });

  it("下载后判不支持（如文件超 50MB）：failed（不可重试）、群里回原文案、不注入", async () => {
    downloadOverride = async () => ({
      text: "",
      images: [],
      attachments: [],
      unsupported: "文件超过 50MB 上限",
    });

    const r = await routeGroupInboundMessage(msg("ou_stranger", "om_big"), ctx);

    expect(r).toMatchObject({ kind: "failed", error: "文件超过 50MB 上限" });
    expect((r as { retryable?: boolean }).retryable).toBeUndefined();
    expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    expect(sentTexts().some((t) => t.includes("文件超过 50MB 上限"))).toBe(true);
  });

  it("下载失败不占名额：12 条下载失败之后，下一条正常消息照常受理（名额已退还）", async () => {
    downloadOverride = async () => {
      throw new Error("lark 下载超时");
    };
    for (let i = 0; i < 12; i++) {
      const r = await routeGroupInboundMessage(msg(`ou_f${i}`, `om_f${i}`), ctx);
      expect(r).toMatchObject({ kind: "failed" });
    }
    downloadOverride = null;

    const r = await routeGroupInboundMessage(
      msg("ou_next", "om_next", "@Flowship 正常问题"),
      ctx,
    );

    expect(r).toMatchObject({ kind: "sent" }); // 若名额没退还，这里是 skipped（被限流）
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(1);
  });

  it("下载后不支持同样退还名额", async () => {
    downloadOverride = async () => ({
      text: "",
      images: [],
      attachments: [],
      unsupported: "文件超过 50MB 上限",
    });
    for (let i = 0; i < 12; i++) {
      await routeGroupInboundMessage(msg(`ou_g${i}`, `om_g${i}`), ctx);
    }
    downloadOverride = null;

    const r = await routeGroupInboundMessage(
      msg("ou_next", "om_next2", "@Flowship 正常问题"),
      ctx,
    );
    expect(r).toMatchObject({ kind: "sent" });
  });
});
