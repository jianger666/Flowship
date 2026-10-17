/**
 * 「往群里发」失败要让属主看得见——所有发群出口共用一个（group-failure-notice）。
 *
 * 背景：群里文字都是卡片（建卡实体 → 发 interactive），依赖 `cardkit:card:write`；权限缺失 /
 * 接口故障时发不出去，群里一片沉默，而失败原先只有 console.warn。入向回执（replyToGroup）早先已经会
 * 在任务事件流留一条 info（见 group-reply-failure-notice.test.ts），2026-10-17 复审指出
 * 「只在一处对属主可见」——出向（答疑回复 / 推进回执 / 问群卡）和卡片回调的回执也要走同一条路。
 *
 * 刻意不测、也不做的：纯文本降级出口——「群里别再新加 text / post 出口」是已定的决定。
 *
 * 外部调用全 mock（禁止真调飞书）；任务落盘事件只记「写了什么」。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ id: string } | null>>(async () => ({
    id: "ev_owned",
  })),
);
const writeEventAndPublish = vi.hoisted(() =>
  vi.fn(async () => ({ id: "ev_mock" })),
);

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeOwnedEventAndPublish, writeEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-send-failure-notice-${Date.now()}`,
  "data",
);

const { noteGroupSendFailure } = await import(
  "@/lib/server/feishu-bridge/group-failure-notice"
);
const {
  __resetGroupOutboundForTest,
  __setGroupOutboundDepsForTest,
  handleGroupOutboundEvent,
  reviewExpiredGroupAdvance,
  sendAskCardToGroup,
} = await import("@/lib/server/feishu-bridge/group-outbound");
const {
  __resetGroupAdvancePickForTest,
  __resetGroupArtifactCardDedupForTest,
  __resetGroupReplyStateForTest,
  __resetThrottleForTest,
  rememberGroupReply,
  throttleOncePerMinute,
} = await import("@/lib/server/feishu-bridge/group-shared");
const { LarkApiError } = await import("@/lib/server/feishu-bridge/types");

const CHAT = "oc_req_group";
const TASK = "task-1";
const REQUESTER = { openId: "ou_zhang", name: "张三" };

const SCOPE_ERR =
  "app scope not applied for the required scope(s): cardkit:card:write. Please apply in the console.";

const taskWith = (status: "awaiting_ack" | "error"): Task =>
  ({
    id: TASK,
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    repoPaths: ["/tmp/repo"],
    mrs: [],
    actions: [
      {
        id: "act-9",
        type: "review",
        status,
        userInstruction: "",
        artifactPath: "actions/3-review.md",
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    events: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as Task;

const baseDeps = (over: Record<string, unknown> = {}) => ({
  getTask: async () => taskWith("awaiting_ack"),
  getBoundGroupChatId: async () => CHAT,
  resolveSenderName: async () => "小明",
  sendAskCard: vi.fn(async () => ({
    chat_id: CHAT,
    message_id: "om_card",
    card_id: "c1",
  })),
  sendText: vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" })),
  sendMarkdown: vi.fn(async () => ({ chat_id: CHAT, message_id: "om_md" })),
  shareToGroup: vi.fn(async () => ({})),
  rememberAskCard: vi.fn(async () => undefined),
  isBridgeEnabled: async () => true,
  isAskToGroupEnabled: async () => true,
  isAdvanceResultToGroupEnabled: async () => true,
  readArtifact: async () => "# 复核报告\n\n没发现问题",
  fetchRoster: async () => ({ members: [] }),
  resolveOwner: async () => undefined,
  getSelfOpenId: async () => null,
  ...over,
});

/** 只看「没发出去」这类 info（outbound 里别的路径也可能写 info，不在本文件关心范围） */
const failureNotices = (): Array<{ taskId: unknown; text: string }> =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => ({
      taskId: c[0],
      ev: c[2] as { kind?: string; text?: string } | undefined,
    }))
    .filter((x) => x.ev?.kind === "info" && x.ev.text?.includes("没发出去"))
    .map((x) => ({ taskId: x.taskId, text: x.ev!.text! }));

const resetAll = () => {
  __resetGroupReplyStateForTest();
  __resetGroupArtifactCardDedupForTest();
  __resetGroupAdvancePickForTest();
  __resetThrottleForTest();
};

beforeEach(() => {
  resetAll();
  writeOwnedEventAndPublish.mockReset();
  writeOwnedEventAndPublish.mockImplementation(async () => ({ id: "ev_owned" }));
  writeEventAndPublish.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  resetAll();
  vi.restoreAllMocks();
});

describe("noteGroupSendFailure 本体", () => {
  it("缺 cardkit 权限翻成人话；带上「是哪类消息」；写到指定任务、owner 语境", async () => {
    await noteGroupSendFailure(TASK, CHAT, new Error(SCOPE_ERR), "答疑回复");
    const [n] = failureNotices();
    expect(n!.taskId).toBe(TASK);
    expect(n!.text).toContain("群里答疑回复没发出去");
    expect(n!.text).toContain("缺机器人权限：cardkit:card:write");
    const call = writeOwnedEventAndPublish.mock.calls[0]!;
    expect((call[1] as () => boolean)()).toBe(true);
  });

  it("不带 what：沿用入向回执原来的文案", async () => {
    await noteGroupSendFailure(TASK, CHAT, new Error("lark 5xx"));
    expect(failureNotices()[0]!.text).toContain("群里有一条回复没发出去：lark 5xx");
  });

  it("其它错误带飞书错误码与 log_id", async () => {
    await noteGroupSendFailure(
      TASK,
      CHAT,
      new LarkApiError("create card failed", {
        code: 230099,
        api: "api POST /open-apis/cardkit/v1/cards",
        logId: "20261017abc",
      }),
    );
    const [n] = failureNotices();
    expect(n!.text).toContain("飞书 230099");
    expect(n!.text).toContain("log_id=20261017abc");
  });

  it("同一个群一分钟只记一条（各出口共用同一个节流 key，不刷屏）；换个群各记各的", async () => {
    await noteGroupSendFailure(TASK, CHAT, new Error("a"));
    await noteGroupSendFailure(TASK, CHAT, new Error("b"), "回执");
    expect(failureNotices()).toHaveLength(1);
    await noteGroupSendFailure(TASK, "oc_other", new Error("c"));
    expect(failureNotices()).toHaveLength(2);
  });

  it("与入向回执共用节流：入向已记过这个群，出向本分钟内不再记", async () => {
    // 入向 group-route 用的就是这个 key——共用才不会「入向一条 + 出向一条」同一分钟刷两遍
    expect(throttleOncePerMinute(`group-reply-failed:${CHAT}`)).toBe(true);
    await noteGroupSendFailure(TASK, CHAT, new Error("lark 5xx"));
    expect(failureNotices()).toHaveLength(0);
  });

  it("taskId 为空：什么都不写、也不占节流（调用方没解析出任务时不能把名额吃掉）", async () => {
    await noteGroupSendFailure("", CHAT, new Error("x"));
    expect(failureNotices()).toHaveLength(0);
    expect(throttleOncePerMinute(`group-reply-failed:${CHAT}`)).toBe(true);
  });

  it("写事件本身炸了也不抛（它跑在已经出错的路径上）", async () => {
    writeOwnedEventAndPublish.mockRejectedValue(new Error("disk full"));
    await expect(
      noteGroupSendFailure(TASK, CHAT, new Error("lark 5xx")),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("记录发群失败时出错"),
      "disk full",
    );
  });
});

// 复审（第三批）：传输层失败且解析不出 JSON 时，Node 的 message 是 `Command failed: <完整命令行>\n<stderr>`——
// 300 字被命令行占满、真正原因和飞书码被截掉，还带着本机路径和请求体；固定的 cardkit 后缀对
// 「机器人不在群 / 限流 / 超时」也这么写会误导
describe("失败原因怎么读（Command failed / 退出码 / 固定后缀）", () => {
  const CMD =
    "/Users/chenlujiang/.flowship/bin/lark-cli api POST /open-apis/cardkit/v1/cards --data " +
    JSON.stringify({ type: "card_json", data: JSON.stringify({ body: "群回复正文".repeat(30) }) });

  const lastNotice = (): string => {
    const all = failureNotices();
    expect(all.length).toBeGreaterThan(0);
    return all[all.length - 1]!.text;
  };

  it("Command failed + stderr：只取 stderr 首行；命令行（本机路径 / 请求体）不进事件", async () => {
    const err = new LarkApiError(`Command failed: ${CMD}\nError: socket hang up\n    at foo`, {
      code: 1,
      api: "api POST /open-apis/cardkit/v1/cards",
      raw: { stdout: "", stderr: "Error: socket hang up\n    at foo" },
    });
    await noteGroupSendFailure(TASK, CHAT, err, "回执");
    const text = lastNotice();
    expect(text).toContain("Error: socket hang up");
    expect(text).not.toContain("Command failed");
    expect(text).not.toContain("/Users/chenlujiang");
    expect(text).not.toContain("card_json");
    expect(text).not.toContain("群回复正文");
    // 退出码 1 不是飞书错误码
    expect(text).not.toContain("飞书 1");
    // 接口名这类定位信息保留
    expect(text).toContain("cardkit/v1/cards");
  });

  it("Command failed 但 stderr 为空：说「没有错误输出」，而不是把命令行贴出来", async () => {
    const err = new LarkApiError(`Command failed: ${CMD}`, {
      code: 1,
      raw: { stdout: "", stderr: "" },
    });
    await noteGroupSendFailure(TASK, CHAT, err);
    const text = lastNotice();
    expect(text).toContain("lark-cli 调用失败（没有错误输出）");
    expect(text).not.toContain("/Users/chenlujiang");
  });

  it("普通 Error 带多行 Command failed：同样取命令行之后的首个非空行", async () => {
    await noteGroupSendFailure(TASK, CHAT, new Error(`Command failed: ${CMD}\n\n  ETIMEDOUT  \nmore`));
    const text = lastNotice();
    expect(text).toContain("ETIMEDOUT");
    expect(text).not.toContain("/Users/chenlujiang");
  });

  it("缺 scope 的文案只出现在 stderr 里（message 是 Command failed）：照样翻成人话", async () => {
    const err = new LarkApiError(`Command failed: ${CMD}`, {
      code: 1,
      raw: { stdout: "", stderr: SCOPE_ERR },
    });
    await noteGroupSendFailure(TASK, CHAT, err);
    const text = lastNotice();
    expect(text).toContain("缺机器人权限：cardkit:card:write");
    expect(text).not.toContain("/Users/chenlujiang");
  });

  it("超时（raw 是 { stdout, stderr }、code 是系统错误名）：不显示成「飞书 ETIMEDOUT」", async () => {
    const err = new LarkApiError("lark-cli 超时（30000ms）", {
      code: "ETIMEDOUT",
      api: "im +messages-send",
      raw: { stdout: undefined, stderr: undefined },
    });
    await noteGroupSendFailure(TASK, CHAT, err);
    const text = lastNotice();
    expect(text).toContain("lark-cli 超时（30000ms）");
    expect(text).not.toContain("飞书 ETIMEDOUT");
  });

  it("已解析出的飞书业务错误（raw 是响应体）：飞书码照常显示", async () => {
    const err = new LarkApiError("bot not in chat", {
      code: 230002,
      api: "im +messages-send",
      logId: "log-abc",
      raw: { code: 230002, msg: "bot not in chat" },
    });
    await noteGroupSendFailure(TASK, CHAT, err);
    const text = lastNotice();
    expect(text).toContain("飞书 230002");
    expect(text).toContain("log_id=log-abc");
  });

  it("固定的「走卡片、需要 cardkit:card:write」后缀只在跟 cardkit 有关时才带", async () => {
    // 机器人不在群：与 cardkit 无关——不能把人往「缺 cardkit 权限」上引
    await noteGroupSendFailure(
      TASK,
      "oc_a",
      new LarkApiError("bot not in chat", { code: 230002, api: "im +messages-send", raw: { code: 230002 } }),
    );
    // 限流 / 超时同理
    await noteGroupSendFailure(TASK, "oc_b", new Error("rate limited"));
    // 建卡实体失败：有关
    await noteGroupSendFailure(
      TASK,
      "oc_c",
      new LarkApiError("create card failed", { code: 99991, api: "api POST /open-apis/cardkit/v1/cards" }),
    );
    const texts = failureNotices().map((n) => n.text);
    expect(texts).toHaveLength(3);
    expect(texts[0]).not.toContain("cardkit:card:write");
    expect(texts[1]).not.toContain("cardkit:card:write");
    expect(texts[2]).toContain("cardkit:card:write");
    // 无关的也要给个能往下查的出口
    expect(texts[0]).toContain("详情见应用日志");
  });

  it("原因整体仍受 300 字上限（超长的 Feishu 报错不顶满事件）", async () => {
    await noteGroupSendFailure(TASK, CHAT, new Error("x".repeat(2000)));
    const text = lastNotice();
    expect(text.length).toBeLessThan(500);
  });
});

describe("出向各出口：发不出去 → 事件流留 info", () => {
  const registerQuestion = () =>
    rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "owner",
    });

  const registerAdvance = () =>
    rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      actionId: "act-9",
      channel: "owner",
    });

  const finishTurn = (task: Task) =>
    handleGroupOutboundEvent(TASK, { kind: "done", task, ok: true });

  it("答疑回复：sendMarkdown 失败 → 留一条「答疑回复没发出去」，出向链不抛", async () => {
    __setGroupOutboundDepsForTest(
      baseDeps({
        sendMarkdown: vi.fn(async () => {
          throw new Error(SCOPE_ERR);
        }),
      }) as never,
    );
    registerQuestion();
    await handleGroupOutboundEvent(TASK, {
      kind: "assistant_delta",
      text: "接口预计周五联调",
    } as never);
    await expect(finishTurn(taskWith("awaiting_ack"))).resolves.toBeUndefined();

    const notices = failureNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.taskId).toBe(TASK);
    expect(notices[0]!.text).toContain("答疑回复没发出去");
    expect(notices[0]!.text).toContain("缺机器人权限：cardkit:card:write");
  });

  it("答疑回复发送成功：不留任何痕迹", async () => {
    __setGroupOutboundDepsForTest(baseDeps() as never);
    registerQuestion();
    await handleGroupOutboundEvent(TASK, {
      kind: "assistant_delta",
      text: "接口预计周五联调",
    } as never);
    await finishTurn(taskWith("awaiting_ack"));
    expect(failureNotices()).toHaveLength(0);
  });

  it("推进失败回执发不出去 → 留一条「回执没发出去」（回执本身是 sendText，卡片失败时它也会挂）", async () => {
    const sendText = vi.fn(async () => {
      throw new Error(SCOPE_ERR);
    });
    __setGroupOutboundDepsForTest(
      baseDeps({ sendText, getTask: async () => taskWith("error") }) as never,
    );
    registerAdvance();
    await expect(finishTurn(taskWith("error"))).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(1);
    const notices = failureNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("回执没发出去");
  });

  it("推进回执发送成功：不留痕迹", async () => {
    __setGroupOutboundDepsForTest(
      baseDeps({ getTask: async () => taskWith("error") }) as never,
    );
    registerAdvance();
    await finishTurn(taskWith("error"));
    expect(failureNotices()).toHaveLength(0);
  });

  it("产物卡发不出去：先记「产物没发出去」；随后的兜底回执也挂时被同群节流吃掉，只留一条", async () => {
    const sendText = vi.fn(async () => {
      throw new Error(SCOPE_ERR);
    });
    __setGroupOutboundDepsForTest(
      baseDeps({
        sendText,
        getTask: async () => taskWith("awaiting_ack"),
        shareToGroup: vi.fn(async () => {
          throw new Error(SCOPE_ERR);
        }),
      }) as never,
    );
    registerAdvance();
    await expect(finishTurn(taskWith("awaiting_ack"))).resolves.toBeUndefined();
    // 兜底回执确实尝试发了（原有行为不变）
    expect(sendText).toHaveBeenCalledTimes(1);
    const notices = failureNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("产物没发出去");
  });

  it("推进登记到期的回执发不出去 → 同样留一条", async () => {
    const sendText = vi.fn(async () => {
      throw new Error(SCOPE_ERR);
    });
    // 无对应 action（登记里的 actionId 在任务里找不到）= 走「到期摘 + 回执」那一支
    __setGroupOutboundDepsForTest(
      baseDeps({
        sendText,
        getTask: async () => ({ ...taskWith("awaiting_ack"), actions: [] }),
      }) as never,
    );
    registerAdvance();
    const { listGroupReplies } = await import(
      "@/lib/server/feishu-bridge/group-shared"
    );
    const token = listGroupReplies(TASK)[0]!.token;
    await expect(reviewExpiredGroupAdvance(TASK, token)).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(failureNotices()).toHaveLength(1);
  });

  it("问群卡发不出去：留一条「问群卡没发出去」，异常照旧抛给调用方", async () => {
    const boom = new Error(SCOPE_ERR);
    __setGroupOutboundDepsForTest(
      baseDeps({
        sendAskCard: vi.fn(async () => {
          throw boom;
        }),
      }) as never,
    );
    await expect(
      sendAskCardToGroup(taskWith("awaiting_ack"), "ask-1", [
        { id: "q1", question: "选哪个", options: [{ id: "a", label: "A" }] },
      ] as never),
    ).rejects.toBe(boom);
    const notices = failureNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.taskId).toBe(TASK);
    expect(notices[0]!.text).toContain("问群卡没发出去");
  });

  it("问群卡发送成功 / 任务没绑群：都不留痕迹", async () => {
    __setGroupOutboundDepsForTest(baseDeps() as never);
    await sendAskCardToGroup(taskWith("awaiting_ack"), "ask-1", [
      { id: "q1", question: "选哪个", options: [{ id: "a", label: "A" }] },
    ] as never);
    __setGroupOutboundDepsForTest(
      baseDeps({ getBoundGroupChatId: async () => null }) as never,
    );
    await sendAskCardToGroup(taskWith("awaiting_ack"), "ask-2", [
      { id: "q1", question: "选哪个", options: [{ id: "a", label: "A" }] },
    ] as never);
    expect(failureNotices()).toHaveLength(0);
  });
});
