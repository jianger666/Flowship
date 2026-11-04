/**
 * 非属主并入属主同一会话 —— 出向（group-outbound）：回群登记从 user_reply 事件现建。
 *
 * 钉死的语义：
 * - 带 groupNonOwnerTurn 的主链 user_reply（无 origin）→ 现建 restricted 登记（sameSession），
 *   不预登记、不占属主单格；这一轮主链帧（delta / tool_call / message / done 都不带 origin）按 turns 表对号入座
 * - done → 回群（@ 提问人）；不写群问答 tab 汇总（新数据不进 tab）
 * - 属主那一格（runTag=null）的登记全程不被碰
 * - 上一轮没等到 done 就来了新的主链 user_reply → 上一轮收口成失败（不让发言人干等）
 * - 旁路答疑的问题事件（restrictedRunTag）不是主链新一轮：既不建登记也不打断
 * - 桥接关掉时 done 也会清 turn
 * - task 队列里排着的非属主消息被丢（过期 / 停止 / 删除 / 失败）→ 给发言人回一句（机器人静默）
 *
 * 全部 mock 外部调用——**禁止真调飞书**。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

const writeEventAndPublish = vi.hoisted(() =>
  vi.fn<(taskId: string, ev: unknown) => Promise<{ id: string }>>(async () => ({
    id: "ev_mock",
  })),
);

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-same-session-outbound-${Date.now()}`,
  "data",
);

const {
  __resetGroupOutboundForTest,
  __setGroupOutboundDepsForTest,
  handleGroupOutboundEvent,
  handleGroupOtherDropped,
} = await import("@/lib/server/feishu-bridge/group-outbound");

const {
  __resetGroupReplyStateForTest,
  listGroupReplies,
  rememberGroupReply,
} = await import("@/lib/server/feishu-bridge/group-shared");

const CHAT = "oc_req_group";
const TASK = "task-1";
const STRANGER = { openId: "ou_stranger", name: "陌生人" };
const OTHER = { openId: "ou_other", name: "路人乙" };
const OWNER = { openId: "ou_owner", name: "宿主小王" };
const BOTASKER = { openId: "ou_otherbot", name: "别家机器人" };

const fullTask = (): Task =>
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
  }) as unknown as Task;

const sentTexts = (fn: unknown): string[] =>
  ((fn as { mock: { calls: unknown[][] } }).mock.calls as unknown[][]).map(
    (c) => c[1] as string,
  );

let bridgeEnabled = true;
const baseDeps = () => ({
  getTask: async () => fullTask(),
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
  isBridgeEnabled: async () => bridgeEnabled,
  isAskToGroupEnabled: async () => true,
  isAdvanceResultToGroupEnabled: async () => true,
  readArtifact: async () => "# 报告",
  pumpGroupQuestionQueue: vi.fn(async () => {}),
  fetchRoster: async () => ({
    members: [
      { openId: STRANGER.openId, name: STRANGER.name, kind: "user" as const },
      { openId: OTHER.openId, name: OTHER.name, kind: "user" as const },
      { openId: OWNER.openId, name: OWNER.name, kind: "user" as const },
      { openId: BOTASKER.openId, name: BOTASKER.name, kind: "bot" as const },
    ],
  }),
  resolveOwner: async () => OWNER,
  getSelfOpenId: async () => "ou_self_bot",
});

const use = () => {
  const deps = baseDeps();
  __setGroupOutboundDepsForTest(deps as never);
  return deps;
};

let seq = 0;
const nonOwnerUserReply = (
  who: { openId: string; name: string } = STRANGER,
  extra: Record<string, unknown> = {},
  messageId = `om_${++seq}`,
) =>
  handleGroupOutboundEvent(TASK, {
    kind: "event",
    event: {
      id: `e-ur-${++seq}`,
      seq,
      ts: Date.now(),
      kind: "user_reply",
      text: "[群消息·来自 x（非任务所有者）]\n这个接口返回啥？",
      meta: {
        source: "feishu_group",
        feishuMessageId: messageId,
        groupChatId: CHAT,
        groupSender: who.name,
        groupSenderOpenId: who.openId,
        groupNonOwnerTurn: true,
        ...extra,
      },
    },
  } as never);
const ownerUserReply = (meta: Record<string, unknown> = {}) =>
  handleGroupOutboundEvent(TASK, {
    kind: "event",
    event: {
      id: `e-ur-${++seq}`,
      seq,
      ts: Date.now(),
      kind: "user_reply",
      text: "继续",
      meta,
    },
  } as never);
const delta = (text: string) =>
  handleGroupOutboundEvent(TASK, { kind: "assistant_delta", text } as never);
const message = (text: string) =>
  handleGroupOutboundEvent(TASK, {
    kind: "event",
    event: {
      id: `e-msg-${++seq}`,
      seq,
      ts: Date.now(),
      kind: "assistant_message",
      text,
    },
  } as never);
const toolCall = () =>
  handleGroupOutboundEvent(TASK, {
    kind: "event",
    event: {
      id: `e-tool-${++seq}`,
      seq,
      ts: Date.now(),
      kind: "tool_call",
      text: "调用 read",
      meta: { callId: `c${seq}`, name: "read" },
    },
  } as never);
const done = (ok: boolean) =>
  handleGroupOutboundEvent(TASK, {
    kind: "done",
    task: fullTask(),
    ok,
  } as never);

const hasSummaryWrite = (): boolean =>
  writeEventAndPublish.mock.calls.some(
    (c) =>
      !!(c[1] as { meta?: { groupQaSummary?: unknown } }).meta?.groupQaSummary,
  );

beforeEach(() => {
  bridgeEnabled = true;
  __resetGroupReplyStateForTest();
  writeEventAndPublish.mockClear();
});

afterEach(() => {
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  __resetGroupReplyStateForTest();
});

describe("user_reply 现建登记 + 主链帧对号入座", () => {
  it("非属主一轮：user_reply → delta → done，回群 @ 提问人，且不写群问答 tab 汇总", async () => {
    const deps = use();
    await nonOwnerUserReply();
    // 登记已现建：restricted 通道（runTag 非空）、sameSession、不占属主那一格
    const [entry] = listGroupReplies(TASK);
    expect(entry).toMatchObject({
      requesterOpenId: STRANGER.openId,
      requesterName: STRANGER.name,
      kind: "question",
      sameSession: true,
    });
    expect(entry!.runTag).toBeTruthy();

    // 主链帧都不带 origin
    await delta("接口返回");
    await delta("用户信息 JSON。");
    await message("接口返回用户信息 JSON。");
    await done(true);

    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toContain("接口返回用户信息 JSON。");
    expect(body).toContain(STRANGER.openId);
    expect(hasSummaryWrite()).toBe(false);
    // 回完登记即摘
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });

  it("只发最终段：中途旁白（工具调用之前）不进群", async () => {
    const deps = use();
    await nonOwnerUserReply();
    await delta("我先翻下代码…");
    await message("我先翻下代码…");
    await toolCall();
    await delta("结论：周五联调。");
    await message("结论：周五联调。");
    await done(true);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toContain("结论：周五联调。");
    expect(body).not.toContain("我先翻下代码");
  });

  it("失败的一轮：真人提问人收到中性提示、仍不写 tab 汇总", async () => {
    const deps = use();
    await nonOwnerUserReply();
    await delta("半截");
    await done(false);
    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sentTexts(deps.sendMarkdown)[0]).toContain("没答上来");
    expect(hasSummaryWrite()).toBe(false);
  });

  it("机器人提问人失败静默（防互 @ 成环）", async () => {
    const deps = use();
    await nonOwnerUserReply(STRANGER, { groupSenderIsBot: true });
    await done(false);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
  });

  it("机器人提问人 + agent 选择 NO_REPLY：群里零消息（不客套、防互 @ 成环）", async () => {
    const deps = use();
    await nonOwnerUserReply(BOTASKER, { groupSenderIsBot: true });
    expect(listGroupReplies(TASK)[0]).toMatchObject({ requesterIsBot: true, sameSession: true });
    await delta("NO_REPLY");
    await message("NO_REPLY");
    await done(true);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    expect(hasSummaryWrite()).toBe(false);
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });

  it("机器人提问人 + 回答里没写 @：不自动补 @（对端看不见 = 有意的防环）", async () => {
    const deps = use();
    await nonOwnerUserReply(BOTASKER, { groupSenderIsBot: true });
    await delta("返回用户信息 JSON。");
    await message("返回用户信息 JSON。");
    await done(true);
    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toContain("返回用户信息 JSON。");
    expect(body).not.toContain(BOTASKER.openId);
  });

  it("机器人提问人 + 回答里自己写了 @名字：真 @ 上它（它才看得见）", async () => {
    const deps = use();
    await nonOwnerUserReply(BOTASKER, { groupSenderIsBot: true });
    await delta(`@${BOTASKER.name} 返回用户信息 JSON。`);
    await message(`@${BOTASKER.name} 返回用户信息 JSON。`);
    await done(true);
    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sentTexts(deps.sendMarkdown)[0]!).toContain(BOTASKER.openId);
  });

  it("缺 groupChatId / groupSenderOpenId 的 user_reply 不建登记（fail-closed）", async () => {
    use();
    await nonOwnerUserReply(STRANGER, { groupChatId: "" });
    await nonOwnerUserReply({ openId: "", name: "x" });
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });

  it("没有 groupNonOwnerTurn 标记的 user_reply 不建登记（属主话照旧）", async () => {
    use();
    await ownerUserReply({ source: "feishu_group", groupChatId: CHAT });
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });
});

describe("非属主一轮收口后 turns 已清", () => {
  it("done 之后没有 user_reply 起点的主链帧（advance / 定时起的 run）算属主那一格，不会被当成上一个陌生人那轮", async () => {
    // 第 20 轮评审 M10：done 不清 turns 的突变存活——旧 turn 残留会把后面属主的帧错配到旧 runTag 上
    const deps = use();
    await nonOwnerUserReply();
    await delta("给陌生人的回答");
    await done(true);
    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sentTexts(deps.sendMarkdown)[0]).toContain(STRANGER.openId);

    // 之后属主那一格登记，主链起新一轮（没有任何 user_reply 事件）
    rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: OWNER.openId,
      requesterName: OWNER.name,
      kind: "question",
      channel: "owner",
    });
    await delta("给属主的回答");
    await done(true);

    expect(deps.sendMarkdown).toHaveBeenCalledTimes(2);
    const second = sentTexts(deps.sendMarkdown)[1]!;
    expect(second).toContain("给属主的回答");
    expect(second).toContain(OWNER.openId);
    expect(second).not.toContain(STRANGER.openId);
  });
});

describe("属主那一格不被碰", () => {
  it("属主单格登记在场：非属主一轮的 delta / done 不会攒进或冲掉它", async () => {
    const deps = use();
    // 属主那一格（channel=owner → runTag=null）
    rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: OWNER.openId,
      requesterName: OWNER.name,
      kind: "question",
      channel: "owner",
    });
    await nonOwnerUserReply();
    await delta("给陌生人的回答");
    await done(true);

    // 回给陌生人，而不是属主
    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sentTexts(deps.sendMarkdown)[0]).toContain(STRANGER.openId);
    // 属主那一格原样还在、一个字没攒
    const left = listGroupReplies(TASK);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ runTag: null, answer: "" });
  });

  it("done 之后 turn 清掉：属主随后的主链 delta 归属主那一格", async () => {
    use();
    await nonOwnerUserReply();
    await done(true);
    rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: OWNER.openId,
      requesterName: OWNER.name,
      kind: "question",
      channel: "owner",
    });
    await ownerUserReply();
    await delta("属主的回答");
    const owner = listGroupReplies(TASK).find((e) => e.runTag === null);
    expect(owner?.answer).toBe("属主的回答");
  });
});

describe("逐条：一条一轮、各回各的", () => {
  it("两个人各一轮（done 隔开）：各自收到自己那条", async () => {
    const deps = use();
    await nonOwnerUserReply(STRANGER);
    await delta("回答 A");
    await done(true);
    await nonOwnerUserReply(OTHER);
    await delta("回答 B");
    await done(true);

    const sends = (
      deps.sendMarkdown as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    expect(sends).toHaveLength(2);
    expect(sends[0]![1]).toContain("回答 A");
    expect(sends[0]![1]).toContain(STRANGER.openId);
    expect(sends[1]![1]).toContain("回答 B");
    expect(sends[1]![1]).toContain(OTHER.openId);
  });
});

describe("被打断 / 旁路 / 开关", () => {
  it("上一轮没等到 done 就来了新的主链 user_reply：上一轮收口成失败，不让发言人干等", async () => {
    const deps = use();
    await nonOwnerUserReply(STRANGER);
    await delta("答到一半");
    // 属主在 app 里「立即发送」之类：新的主链 user_reply（无 restrictedRunTag、非非属主）
    await ownerUserReply();
    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sentTexts(deps.sendMarkdown)[0]).toContain("没答上来");
    expect(listGroupReplies(TASK)).toHaveLength(0);
    // turn 已清：后续主链 delta 不再有去处
    await delta("属主那一轮");
    expect(listGroupReplies(TASK)).toHaveLength(0);
  });

  it("旁路答疑的问题事件（restrictedRunTag）不是主链新一轮：不打断、不建登记", async () => {
    const deps = use();
    await nonOwnerUserReply(STRANGER);
    await delta("答着");
    await ownerUserReply({
      source: "feishu_group",
      restrictedRunTag: "tag-bypass",
      groupChatId: CHAT,
    });
    // 还在这一轮里
    await delta("答完。");
    await done(true);
    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sentTexts(deps.sendMarkdown)[0]).toContain("答着答完。");
  });

  it("桥接关掉期间的 done 也清 turn：之后属主的主链 delta 不会被旧 turn 吞去", async () => {
    // 桥接开关有 8s 缓存：只伪造 Date，让缓存可控过期
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      use();
      await nonOwnerUserReply();
      const stale = listGroupReplies(TASK)[0]!;
      bridgeEnabled = false;
      vi.setSystemTime(Date.now() + 9_000);
      await done(true); // 桥接关：不发群，但 turn 必须清
      bridgeEnabled = true;
      vi.setSystemTime(Date.now() + 9_000);
      rememberGroupReply(TASK, {
        chatId: CHAT,
        requesterOpenId: OWNER.openId,
        requesterName: OWNER.name,
        kind: "question",
        channel: "owner",
      });
      await ownerUserReply();
      await delta("属主的回答");
      const list = listGroupReplies(TASK);
      expect(list.find((e) => e.runTag === null)?.answer).toBe("属主的回答");
      expect(list.find((e) => e.token === stale.token)?.answer).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("task 队列里排着的非属主消息被丢 → 回发言人一句", () => {
  const info = (over: Record<string, unknown> = {}) =>
    ({
      taskId: TASK,
      reason: "expired",
      meta: {
        groupChatId: CHAT,
        groupSender: STRANGER.name,
        groupSenderOpenId: STRANGER.openId,
        feishuMessageId: "om_q",
      },
      senderIsBot: false,
      ...over,
    }) as never;

  const flush = () => new Promise((r) => setTimeout(r, 20));

  it.each([
    ["expired", "过期"],
    ["stopped", "停止"],
    ["deleted", "移出队列"],
    ["failed", "没处理上"],
    ["closed", "已经结束"],
  ])("%s → 往群里 @ 发言人回一句", async (reason, kw) => {
    const deps = use();
    handleGroupOtherDropped(info({ reason }));
    await flush();
    expect(deps.sendText).toHaveBeenCalledTimes(1);
    const text = sentTexts(deps.sendText)[0]!;
    expect(text).toContain(STRANGER.openId);
    expect(text).toContain(kw);
  });

  it("failed 带原因", async () => {
    const deps = use();
    handleGroupOtherDropped(info({ reason: "failed", detail: "会话已关闭" }));
    await flush();
    expect(sentTexts(deps.sendText)[0]).toContain("会话已关闭");
  });

  it("机器人发言人静默", async () => {
    const deps = use();
    handleGroupOtherDropped(info({ senderIsBot: true }));
    await flush();
    expect(deps.sendText).not.toHaveBeenCalled();
  });

  it("meta 缺 groupChatId / openId → 什么都不发", async () => {
    const deps = use();
    handleGroupOtherDropped(info({ meta: { groupSender: "x" } }));
    handleGroupOtherDropped(info({ meta: undefined }));
    await flush();
    expect(deps.sendText).not.toHaveBeenCalled();
  });
});
