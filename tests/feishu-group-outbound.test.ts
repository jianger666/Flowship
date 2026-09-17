/**
 * 需求群回流（第二批 · 出向）：ask 卡发群 / 回答回群 / 推进产物回群
 *
 * 全部 mock 外部调用——**禁止真调飞书**。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/lib/types";

// 掉落汇总写 tab 走真实落盘太重——mock 掉，只断言写了什么（十六轮 P3）
const writeEventAndPublish = vi.hoisted(() =>
  vi.fn(async () => ({ id: "ev_mock" })),
);

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `feishu-group-outbound-${Date.now()}`,
  "data",
);

const {
  __resetGroupOutboundForTest,
  __setGroupOutboundDepsForTest,
  askOptsFromGroupEvent,
  ensureFeishuGroupOutboundRegistered,
  handleDroppedQuestionReply,
  handleGroupOutboundEvent,
  reviewExpiredGroupAdvance,
} = await import("@/lib/server/feishu-bridge/group-outbound");

const {
  __resetGroupAdvancePickForTest,
  bindGroupAdvancePickAction,
  releaseGroupAdvancePickByAction,
  __resetGroupArtifactCardDedupForTest,
  __resetGroupReplyStateForTest,
  claimGroupAdvancePick,
  claimGroupArtifactCard,
  GROUP_REPLY_MAX_PER_TASK,
  GROUP_REPLY_TTL_MS,
  hasGroupAdvanceReplyFor,
  listGroupReplies,
  peekGroupReplyByToken,
  rememberGroupReply,
  restoreGroupReply,
  setGroupQuestionDroppedHandler,
  truncateForGroup,
} = await import("@/lib/server/feishu-bridge/group-shared");

// 生产读取点本尊——「固定策略」用例不 mock 它们，直接接进依赖里验真实取值
const { isAdvanceResultToGroupEnabled, isAskToGroupEnabled } = await import(
  "@/lib/server/feishu-bridge/bridge-config"
);

const CHAT = "oc_req_group";
const REQUESTER = { openId: "ou_zhang", name: "张三" };

const fullTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "task-1",
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

/** 无参声明的 vi.fn 其 mock.calls 被推成 []——取实参统一走这个断言 helper */
const callArgs = (fn: unknown, i = 0): unknown[] =>
  ((fn as { mock: { calls: unknown[][] } }).mock.calls as unknown[][])[i] ?? [];

const baseDeps = (over: Record<string, unknown> = {}) => ({
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
  isBridgeEnabled: async () => true,
  isAskToGroupEnabled: async () => true,
  isAdvanceResultToGroupEnabled: async () => true,
  readArtifact: async () => "# 复核报告\n\n没发现问题",
  ...over,
});

const askEvent = (meta: Record<string, unknown>) =>
  ({
    kind: "event" as const,
    event: {
      id: "e1",
      seq: 1,
      at: Date.now(),
      kind: "ask_user_request" as const,
      text: "Q1",
      meta,
    },
  }) as never;

beforeEach(() => {
  __resetGroupReplyStateForTest();
  __resetGroupArtifactCardDedupForTest();
  __resetGroupAdvancePickForTest();
  writeEventAndPublish.mockClear();
});

afterEach(() => {
  // 先摘 tap / 过期收口钩子，再恢复默认依赖——留着钩子会让在飞的收口打到真依赖上
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  __resetGroupReplyStateForTest();
  __resetGroupArtifactCardDedupForTest();
  __resetGroupAdvancePickForTest();
});

// assistant_delta 是每 token 一发：不缓存的话一轮回答要读几百次 config.json
describe("桥接开关读盘节流", () => {
  it("连发多条 delta 只读一次开关（8s TTL）", async () => {
    const isBridgeEnabled = vi.fn(async () => true);
    __setGroupOutboundDepsForTest(baseDeps({ isBridgeEnabled }) as never);
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "owner",
    });

    for (let i = 0; i < 20; i++) {
      await handleGroupOutboundEvent("task-1", {
        kind: "assistant_delta",
        text: `块${i}`,
      } as never);
    }

    expect(isBridgeEnabled).toHaveBeenCalledTimes(1);
  });
});

describe("askOptsFromGroupEvent", () => {
  it("抠出 askId + questions；缺字段返 null", () => {
    expect(
      askOptsFromGroupEvent({
        askId: "ask-1",
        questions: [
          { id: "q1", question: "用哪个方案", options: [{ id: "a", label: "A" }] },
        ],
      }),
    ).toEqual({
      askId: "ask-1",
      questions: [
        { id: "q1", question: "用哪个方案", options: [{ id: "a", label: "A" }] },
      ],
    });
    expect(askOptsFromGroupEvent({ questions: [] })).toBeNull();
    expect(askOptsFromGroupEvent(undefined)).toBeNull();
  });
});

describe("ask 卡发群", () => {
  it("开关开 + 任务绑了群 → 发群答题卡并记 card-map（含 ask 索引）", async () => {
    const sendAskCard = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_card",
      card_id: "c1",
    }));
    const rememberAskCard = vi.fn(async () => undefined);
    __setGroupOutboundDepsForTest(
      baseDeps({ sendAskCard, rememberAskCard }) as never,
    );

    await handleGroupOutboundEvent(
      "task-1",
      askEvent({
        askId: "ask-1",
        questions: [{ id: "q1", question: "用哪个方案" }],
      }),
    );
    expect(sendAskCard).toHaveBeenCalledTimes(1);
    expect(callArgs(sendAskCard)[0]).toBe(CHAT);
    // 路由判据 routeTaskId 记空串（群卡不参与 p2p 回复锚定）；
    // ask 索引记真 (taskId, askId)——不管从哪个入口答完 / 跳过，都能反查到这张卡置终态
    expect(callArgs(rememberAskCard)[0]).toMatchObject({
      routeTaskId: "",
      askTaskId: "task-1",
      askId: "ask-1",
      cardId: "c1",
      messageId: "om_card",
    });
  });

  // 设置页「问题同步到需求群」已砍（2026-07-28）：固定关。不 mock 开关、直接接
  // 生产读取点，锁死「agent 每次提问不再自动往群里发卡」——要别人帮忙靠手动分享
  it("固定策略：接真实读取点 → 绑了群也不发答题卡", async () => {
    const sendAskCard = vi.fn();
    __setGroupOutboundDepsForTest(
      baseDeps({ sendAskCard, isAskToGroupEnabled }) as never,
    );
    await handleGroupOutboundEvent(
      "task-1",
      askEvent({ askId: "ask-1", questions: [{ id: "q1", question: "Q" }] }),
    );
    expect(sendAskCard).not.toHaveBeenCalled();
  });

  it("任务没绑需求群 → 不发群", async () => {
    const sendAskCard = vi.fn();
    __setGroupOutboundDepsForTest(
      baseDeps({ sendAskCard, getBoundGroupChatId: async () => null }) as never,
    );
    await handleGroupOutboundEvent(
      "task-1",
      askEvent({ askId: "ask-1", questions: [{ id: "q1", question: "Q" }] }),
    );
    expect(sendAskCard).not.toHaveBeenCalled();
  });

  it("桥接总开关关 → 整条群链不跑", async () => {
    const sendAskCard = vi.fn();
    __setGroupOutboundDepsForTest(
      baseDeps({ sendAskCard, isBridgeEnabled: async () => false }) as never,
    );
    await handleGroupOutboundEvent(
      "task-1",
      askEvent({ askId: "ask-1", questions: [{ id: "q1", question: "Q" }] }),
    );
    expect(sendAskCard).not.toHaveBeenCalled();
  });
});

describe("回答回群", () => {
  it("攒 delta → done 时 @ 提问人发回群（post markdown，不是纯文本）", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    const sendText = vi.fn();
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown, sendText }) as never);
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "owner",
    });

    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "接口预计",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "周五联调",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
    });

    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    const body = callArgs(sendMarkdown)[1] as string;
    expect(body).toContain('<at user_id="ou_zhang">张三</at>');
    expect(body).toContain("接口预计周五联调");
  });

  it("markdown 标记原样发出去（** / ` / 列表），交给飞书 post md 渲染", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown }) as never);
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "**中性/基准**走 `uuid`\n- 英文\n- 中文",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
    });
    const body = callArgs(sendMarkdown)[1] as string;
    expect(body).toContain("**中性/基准**");
    expect(body).toContain("`uuid`");
    expect(body).toContain("- 英文");
  });

  it("没有登记的任务 done 不回群（不打扰无关任务）", async () => {
    const sendText = vi.fn();
    const sendMarkdown = vi.fn();
    __setGroupOutboundDepsForTest(baseDeps({ sendText, sendMarkdown }) as never);
    await handleGroupOutboundEvent("task-other", {
      kind: "done",
      task: fullTask(),
      ok: true,
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it("跑失败 → 回群说明去 app 看，不发空答案", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown }) as never);
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: false,
    });
    expect(callArgs(sendMarkdown)[1]).toContain("没跑成功");
  });

  it("失败轮 tab 存群里看到的正文（不存半截输出）", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown }) as never);
    const h = rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "restricted",
      sourceMessageId: "om_q1",
    })!;
    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "半截输出",
      origin: h.runTag!,
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: false,
      origin: h.runTag!,
    });
    const summary = (
      callArgs(writeEventAndPublish)[1] as {
        meta: { groupQaSummary: Record<string, unknown> };
      }
    ).meta.groupQaSummary;
    expect(summary.ok).toBe(false);
    expect(summary.answer).toContain("没跑成功");
    expect(summary.answer).not.toContain("半截输出");
  });

  it("空回答轮 tab 存 fallback（不留空白轮）", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown }) as never);
    const h = rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "restricted",
      sourceMessageId: "om_q2",
    })!;
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
      origin: h.runTag!,
    });
    const summary = (
      callArgs(writeEventAndPublish)[1] as {
        meta: { groupQaSummary: Record<string, unknown> };
      }
    ).meta.groupQaSummary;
    expect(summary.ok).toBe(true);
    expect(summary.answer).toContain("已处理完成");
  });

  it("done 后登记摘掉——同一任务下一轮不再误回群", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown }) as never);
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "owner",
    });
    const done = { kind: "done" as const, task: fullTask(), ok: true };
    await handleGroupOutboundEvent("task-1", done);
    await handleGroupOutboundEvent("task-1", done);
    expect(sendMarkdown).toHaveBeenCalledTimes(1);
  });
});

// 第四轮双审共识 P1：登记是 task 级单格、没有「在等哪一轮 run」的身份 →
// 属主 run 与旁路答疑并行时错投 / 丢答。收敛成 token 化协议后这一族全钉在这里。
describe("token 化投递（属主主链 vs 旁路答疑 run）", () => {
  /** 非属主答疑的登记：runTag = 自己的 token，旁路 run 的事件带它当 origin */
  const rememberRestricted = (requester: { openId: string; name: string }) =>
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: requester.openId,
      requesterName: requester.name,
      kind: "question",
      channel: "restricted",
    });

  it("旁路答疑在飞时属主 run 的 done 先到 → 登记还在、不发错文", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    const sendText = vi.fn();
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown, sendText }) as never);
    const handle = rememberRestricted(REQUESTER)!;

    // 属主那一轮（app 里点的推进）：delta + done 都不带 origin
    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "属主这轮的产物正文",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
    });

    // 一个字都不许发给同事，登记原样挂着等自己的 done
    expect(sendMarkdown).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    const [entry] = listGroupReplies("task-1");
    expect(entry).toMatchObject({ token: handle.token, answer: "" });

    // 旁路自己的 done 到了才回群，且回的是自己攒的文本
    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "缓存 5 分钟过期",
      origin: handle.runTag!,
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
      origin: handle.runTag!,
    });
    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    const body = callArgs(sendMarkdown)[1] as string;
    expect(body).toContain("缓存 5 分钟过期");
    expect(body).not.toContain("属主这轮的产物正文");
  });

  it("两条登记并存（属主 + 旁路）各投各的、互不串文", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown }) as never);
    // 属主在群里问了一句（走属主主链）
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: "ou_owner",
      requesterName: "张三",
      kind: "question",
      channel: "owner",
    });
    // 同事也问了一句（走只读旁路 run）
    const other = rememberRestricted({ openId: "ou_li", name: "李四" })!;

    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "属主答案",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "同事答案",
      origin: other.runTag!,
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
      origin: other.runTag!,
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
    });

    expect(sendMarkdown).toHaveBeenCalledTimes(2);
    const first = callArgs(sendMarkdown, 0)[1] as string;
    const second = callArgs(sendMarkdown, 1)[1] as string;
    // 先收口的是旁路那轮：@ 李四、只带同事的答案
    expect(first).toContain("李四");
    expect(first).toContain("同事答案");
    expect(first).not.toContain("属主答案");
    // 属主那轮随后收口：@ 张三、只带属主的答案
    expect(second).toContain("张三");
    expect(second).toContain("属主答案");
    expect(second).not.toContain("同事答案");
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("stop 补发的 done（属主终态 owner、不带 origin）不误 flush 旁路登记", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    const sendText = vi.fn();
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown, sendText }) as never);
    const handle = rememberRestricted(REQUESTER)!;

    // stop-task 收尾无条件补发的那一帧
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
    });

    expect(sendMarkdown).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(listGroupReplies("task-1")).toHaveLength(1);
    expect(listGroupReplies("task-1")[0]?.token).toBe(handle.token);
  });

  it("多位同事先后提问 → 各自 token 各自投递（先答完的先回）", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown }) as never);
    const a = rememberRestricted({ openId: "ou_a", name: "李四" })!;
    const b = rememberRestricted({ openId: "ou_b", name: "王五" })!;
    expect(a.runTag).not.toBe(b.runTag);

    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "答 A",
      origin: a.runTag!,
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "答 B",
      origin: b.runTag!,
    });
    // B 先跑完
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
      origin: b.runTag!,
    });
    expect(callArgs(sendMarkdown, 0)[1] as string).toContain("王五");
    expect(callArgs(sendMarkdown, 0)[1] as string).toContain("答 B");
    // A 的登记不受影响
    expect(listGroupReplies("task-1")).toHaveLength(1);
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
      origin: a.runTag!,
    });
    expect(callArgs(sendMarkdown, 1)[1] as string).toContain("答 A");
  });

  it("assistant_message 兜底同样认 origin（旁路的完整消息不进属主登记）", async () => {
    __setGroupOutboundDepsForTest(baseDeps() as never);
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: "ou_owner",
      requesterName: "张三",
      kind: "question",
      channel: "owner",
    });
    const other = rememberRestricted({ openId: "ou_li", name: "李四" })!;

    await handleGroupOutboundEvent("task-1", {
      kind: "event",
      origin: other.runTag!,
      event: {
        id: "e-msg",
        seq: 1,
        ts: Date.now(),
        kind: "assistant_message",
        text: "旁路的完整回答",
      },
    } as never);

    const byToken = Object.fromEntries(
      listGroupReplies("task-1").map((e) => [e.token, e.answer]),
    );
    expect(byToken[other.token]).toBe("旁路的完整回答");
    // 属主那条一个字都没被写进去
    expect(
      Object.entries(byToken).find(([token]) => token !== other.token)?.[1],
    ).toBe("");
  });
});

describe("推进产物回群", () => {
  const taskWithAction = () =>
    fullTask({
      actions: [
        {
          id: "act-9",
          n: 3,
          type: "review",
          status: "awaiting_ack",
          userInstruction: "",
          artifactPath: "actions/3-review.md",
          startedAt: Date.now(),
          endedAt: null,
        },
      ],
    } as never);

  it("开关开 → 读 artifact 走 share 卡回群（kind=artifact）", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupOutboundDepsForTest(
      baseDeps({ shareToGroup, getTask: async () => taskWithAction() }) as never,
    );
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      actionId: "act-9",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: taskWithAction(),
      ok: true,
    });
    expect(shareToGroup).toHaveBeenCalledTimes(1);
    expect(callArgs(shareToGroup)[1]).toMatchObject({
      kind: "artifact",
      title: "复核",
    });
    expect(
      (callArgs(shareToGroup)[1] as { content: string }).content,
    ).toContain("复核报告");
  });

  it("播报抢占占坑 → 发起人收到一句交代（卡片不 @ 人，不能让他干等，review 十一轮-1）", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
    __setGroupOutboundDepsForTest(
      baseDeps({
        shareToGroup,
        sendText,
        getTask: async () => taskWithAction(),
      }) as never,
    );
    // 播报侧先占坑：done flush 占不到
    expect(claimGroupArtifactCard("task-1", "act-9")).toBe(true);
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      actionId: "act-9",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: taskWithAction(),
      ok: true,
    });
    // 卡没发第二遍，但发起人被 @ 了一句交代
    expect(shareToGroup).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    const body = callArgs(sendText)[1] as string;
    expect(body).toContain("刚交卷，产物见上卡");
    expect(body).toContain('<at user_id="ou_zhang">张三</at>');
  });

  it("收口放选择卡坑：同卡跑完 A 还能再点 B（十四轮 P2）", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupOutboundDepsForTest(
      baseDeps({ shareToGroup, getTask: async () => taskWithAction() }) as never,
    );
    // 属主点卡跑 A：占坑 + 登记带 pick↔action
    expect(
      claimGroupAdvancePick("pick-1", "复核", {
        taskId: "task-1",
        actionKey: "review",
      }),
    ).toEqual({ ok: true });
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      actionId: "act-9",
      advancePickId: "pick-1",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: taskWithAction(),
      ok: true,
    });
    expect(shareToGroup).toHaveBeenCalledTimes(1);
    // A 跑完放坑：同卡点 B 不再回“已在跑”
    expect(
      claimGroupAdvancePick("pick-1", "出方案", {
        taskId: "task-1",
        actionKey: "plan",
      }),
    ).toEqual({ ok: true });
  });

  it("pick↔记录 id 映射：按 action 放坑、跨任务不串坑", async () => {
    // claim 只知道 taskId+actionKey（按钮 value），收口只知道 actionId（记录 id）
    expect(
      claimGroupAdvancePick("pick-2", "复核", {
        taskId: "task-1",
        actionKey: "review",
      }),
    ).toEqual({ ok: true });
    bindGroupAdvancePickAction("pick-2", "act-99");
    // 没放之前同卡再点照样拦
    expect(
      claimGroupAdvancePick("pick-2", "出方案", {
        taskId: "task-1",
        actionKey: "plan",
      }),
    ).toEqual({ ok: false, startedLabel: "复核" });
    // 跨任务的放坑不误伤
    releaseGroupAdvancePickByAction("task-other", "act-99");
    expect(
      claimGroupAdvancePick("pick-2", "出方案", {
        taskId: "task-1",
        actionKey: "plan",
      }),
    ).toEqual({ ok: false, startedLabel: "复核" });
    // 同 task 同 action 放坑后可重选
    releaseGroupAdvancePickByAction("task-1", "act-99");
    expect(
      claimGroupAdvancePick("pick-2", "出方案", {
        taskId: "task-1",
        actionKey: "plan",
      }),
    ).toEqual({ ok: true });
  });

  // 设置页「群内推进结果回群」已砍（2026-07-28）：固定开。群里点了推进却看不到结果、
  // 这功能就废了——不 mock 开关、直接接生产读取点锁死
  it("固定策略：接真实读取点 → 群内推进产物照常回群", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupOutboundDepsForTest(
      baseDeps({
        shareToGroup,
        getTask: async () => taskWithAction(),
        isAdvanceResultToGroupEnabled,
      }) as never,
    );
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      actionId: "act-9",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: taskWithAction(),
      ok: true,
    });
    expect(shareToGroup).toHaveBeenCalledTimes(1);
    expect(callArgs(shareToGroup)[1]).toMatchObject({ kind: "artifact" });
  });

  it("开关关 → 不发产物", async () => {
    const shareToGroup = vi.fn();
    const sendText = vi.fn();
    __setGroupOutboundDepsForTest(
      baseDeps({
        shareToGroup,
        sendText,
        getTask: async () => taskWithAction(),
        isAdvanceResultToGroupEnabled: async () => false,
      }) as never,
    );
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      actionId: "act-9",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: taskWithAction(),
      ok: true,
    });
    expect(shareToGroup).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("播报已占坑（同一 action）→ flush 不再发第二张一样的卡", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupOutboundDepsForTest(
      baseDeps({ shareToGroup, getTask: async () => taskWithAction() }) as never,
    );
    // 自动播报侧先占坑（它正在发这份产物）
    expect(claimGroupArtifactCard("task-1", "act-9")).toBe(true);
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      actionId: "act-9",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: taskWithAction(),
      ok: true,
    });
    expect(shareToGroup).not.toHaveBeenCalled();
  });

  it("flush 先占坑再发；发失败退坑（下轮 / 播报还能再试）", async () => {
    __setGroupOutboundDepsForTest(
      baseDeps({
        getTask: async () => taskWithAction(),
        shareToGroup: async () => {
          throw new Error("飞书超时");
        },
      }) as never,
    );
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      actionId: "act-9",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: taskWithAction(),
      ok: true,
    });
    // 退坑了 → 后手（播报）还能占到
    expect(claimGroupArtifactCard("task-1", "act-9")).toBe(true);
  });

  it("share 失败 → 降级发一条文本、不抛", async () => {
    const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
    __setGroupOutboundDepsForTest(
      baseDeps({
        getTask: async () => taskWithAction(),
        sendText,
        shareToGroup: async () => {
          throw new Error("bot 不在群");
        },
      }) as never,
    );
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      actionId: "act-9",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: taskWithAction(),
      ok: true,
    });
    expect(callArgs(sendText)[1]).toContain("产物没发出来");
  });
});

// 第五轮双审 P1-A（同族第四次投影）：flush 的触发器曾是 turn 级的 `done`——agent 跑到
// 一半调 ask_user 就会正常结束 turn 发一帧 done(ok=true)，登记当场被收走：群里收到
// 「agent 半程旁白冒充的产物卡」、防重坑还被自己占死、真产物永远发不进群。
// 收敛成「advance 只在 action 落终态时收口」，成败由 action 状态定、不看 done 的 ok。
describe("推进收口看 action 状态（ask_user 中途的 done 不算跑完）", () => {
  /** 指定状态 / 产物路径的单 action 任务快照 */
  const taskAt = (
    status: "running" | "awaiting_ack" | "completed" | "error" | "cancelled",
    artifactPath: string | null = "actions/3-review.md",
  ) =>
    fullTask({
      currentActionId: "act-9",
      actions: [
        {
          id: "act-9",
          n: 3,
          type: "review",
          status,
          userInstruction: "",
          artifactPath,
          startedAt: Date.now(),
          endedAt: null,
        },
      ],
    } as never);

  const rememberAdvance = () =>
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      actionId: "act-9",
      channel: "owner",
    });

  it("ask_user 中途的 done → 不收登记、不发假产物", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
    // artifact 还没写、action 仍在跑（agent 在等答案）
    const task = taskAt("running", null);
    __setGroupOutboundDepsForTest(
      baseDeps({ shareToGroup, sendText, getTask: async () => task }) as never,
    );
    rememberAdvance();

    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "我先看看这块代码",
    });
    await handleGroupOutboundEvent("task-1", { kind: "done", task, ok: true });

    expect(shareToGroup).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(listGroupReplies("task-1")).toHaveLength(1);
  });

  it("ask_user 中途的 done 不占防重坑（自动播报仍占得到）", async () => {
    const task = taskAt("running", null);
    __setGroupOutboundDepsForTest(
      baseDeps({ getTask: async () => task }) as never,
    );
    rememberAdvance();
    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "我先看看这块代码",
    });
    await handleGroupOutboundEvent("task-1", { kind: "done", task, ok: true });
    expect(claimGroupArtifactCard("task-1", "act-9")).toBe(true);
  });

  it("后置检查落 awaiting_ack 的那帧 task → 收口发真产物", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    let task = taskAt("running", null);
    __setGroupOutboundDepsForTest(
      baseDeps({ shareToGroup, getTask: async () => task }) as never,
    );
    rememberAdvance();

    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "我先看看这块代码",
    });
    await handleGroupOutboundEvent("task-1", { kind: "done", task, ok: true });

    // 用户答完 ask、agent 交卷、后置检查把 awaiting_ack 落盘
    task = taskAt("awaiting_ack");
    await handleGroupOutboundEvent("task-1", { kind: "task", task });

    expect(shareToGroup).toHaveBeenCalledTimes(1);
    expect(callArgs(shareToGroup)[1]).toMatchObject({
      kind: "artifact",
      title: "复核",
    });
    expect(
      (callArgs(shareToGroup)[1] as { content: string }).content,
    ).toContain("复核报告");
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("action 帧也能收口（awaiting_ack 只发一次、登记摘掉）", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    const task = taskAt("awaiting_ack");
    __setGroupOutboundDepsForTest(
      baseDeps({ shareToGroup, getTask: async () => task }) as never,
    );
    rememberAdvance();
    const frame = { kind: "action" as const, action: task.actions[0]! };
    await handleGroupOutboundEvent("task-1", frame);
    await handleGroupOutboundEvent("task-1", frame);
    expect(shareToGroup).toHaveBeenCalledTimes(1);
  });

  it("action 被标 error / cancelled → 回失败文案（不看 done 的 ok）", async () => {
    const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
    const shareToGroup = vi.fn(async () => ({}));
    const task = taskAt("cancelled", null);
    __setGroupOutboundDepsForTest(
      baseDeps({ sendText, shareToGroup, getTask: async () => task }) as never,
    );
    rememberAdvance();
    await handleGroupOutboundEvent("task-1", { kind: "done", task, ok: true });
    expect(shareToGroup).not.toHaveBeenCalled();
    expect(callArgs(sendText)[1]).toContain("没跑成功");
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("done(ok=false) 立刻收口——有的失败路径来不及标 action", async () => {
    const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
    const task = taskAt("running", null);
    __setGroupOutboundDepsForTest(
      baseDeps({ sendText, getTask: async () => task }) as never,
    );
    rememberAdvance();
    await handleGroupOutboundEvent("task-1", { kind: "done", task, ok: false });
    expect(callArgs(sendText)[1]).toContain("没跑成功");
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("终态但没产物 → 按文本回旁白，绝不冒充产物卡、也不占防重坑", async () => {
    const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
    const shareToGroup = vi.fn(async () => ({}));
    const task = taskAt("awaiting_ack", null);
    __setGroupOutboundDepsForTest(
      baseDeps({ sendText, shareToGroup, getTask: async () => task }) as never,
    );
    rememberAdvance();
    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "这轮只看了下、没出文档",
    });
    await handleGroupOutboundEvent("task-1", { kind: "done", task, ok: true });

    expect(shareToGroup).not.toHaveBeenCalled();
    expect(callArgs(sendText)[1]).toContain("这轮只看了下、没出文档");
    expect(claimGroupArtifactCard("task-1", "act-9")).toBe(true);
  });

  it("actionId 还没补记（advanceTask 未返回）→ 继续等，不拿当前 action 顶包", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    // 任务当前 action 是上一轮已交卷的产物——绝不能被这条登记误发
    const task = taskAt("awaiting_ack");
    __setGroupOutboundDepsForTest(
      baseDeps({ shareToGroup, getTask: async () => task }) as never,
    );
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", { kind: "done", task, ok: true });
    expect(shareToGroup).not.toHaveBeenCalled();
    expect(listGroupReplies("task-1")).toHaveLength(1);
  });

  it("question 登记不被 task / action 帧收口（它只认 done）", async () => {
    const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
    const task = taskAt("awaiting_ack");
    __setGroupOutboundDepsForTest(
      baseDeps({ sendText, getTask: async () => task }) as never,
    );
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", { kind: "task", task });
    expect(sendText).not.toHaveBeenCalled();
    expect(listGroupReplies("task-1")).toHaveLength(1);
  });
});

// 第六轮双审 P1-1：`createdAt + 2h` 是死墙钟，`ask_user` 等人回话那段一条流事件都没有
//（所以「有 delta 就续期」治不了它）——超过 2h 后任意一次 peek / has / remember 触发的
// prune 都会把推进登记 splice 掉，且不回群。默认配置下推进登记是群里拿到产物的唯一
// 路径，摘掉 = 永久静默：既没有产物卡也没有失败回执。
describe("推进登记的保活（租约 + 到期收口）", () => {
  /** 指定状态 / 产物路径的单 action 任务快照 */
  const taskAt = (
    status: "running" | "awaiting_ack" | "error",
    artifactPath: string | null = "actions/3-review.md",
  ) =>
    fullTask({
      currentActionId: "act-9",
      actions: [
        {
          id: "act-9",
          n: 3,
          type: "review",
          status,
          userInstruction: "",
          artifactPath,
          startedAt: Date.now(),
          endedAt: null,
        },
      ],
    } as never);

  /** 群内推进的登记（属主通道 + 已补记 actionId） */
  const rememberAdvance = (actionId: string | null = "act-9") =>
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "advance",
      ...(actionId ? { actionId } : {}),
      channel: "owner",
    })!;

  /** 排干微任务队列——过期收口是 fire-and-forget、拿不到 promise 可 await */
  const flushMicrotasks = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it("挂过租约期再落 awaiting_ack → 仍发产物（不再被墙钟静默摘掉）", async () => {
    vi.useFakeTimers();
    try {
      const shareToGroup = vi.fn(async () => ({}));
      let task = taskAt("running", null);
      __setGroupOutboundDepsForTest(
        baseDeps({ shareToGroup, getTask: async () => task }) as never,
      );
      rememberAdvance();
      // agent 中途 ask_user → 自然结束 turn，登记原样挂着等人作答
      await handleGroupOutboundEvent("task-1", { kind: "done", task, ok: true });
      // 人开完会 / 隔夜才在 App 里答：这段纯等待期一条事件都没有、墙钟照走
      vi.advanceTimersByTime(GROUP_REPLY_TTL_MS + 60_000);

      task = taskAt("awaiting_ack");
      await handleGroupOutboundEvent("task-1", { kind: "task", task });

      expect(shareToGroup).toHaveBeenCalledTimes(1);
      expect(listGroupReplies("task-1")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("到期时 action 仍在跑 → 续租满一轮，不摘不打扰", async () => {
    vi.useFakeTimers();
    try {
      const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
      __setGroupOutboundDepsForTest(
        baseDeps({ sendText, getTask: async () => taskAt("running", null) }) as never,
      );
      const handle = rememberAdvance();
      vi.advanceTimersByTime(GROUP_REPLY_TTL_MS + 1000);

      await reviewExpiredGroupAdvance("task-1", handle.token);

      expect(sendText).not.toHaveBeenCalled();
      expect(peekGroupReplyByToken("task-1", handle.token)?.expiresAt).toBe(
        Date.now() + GROUP_REPLY_TTL_MS,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("到期时 action 已终态（收口那帧丢了）→ 补发产物", async () => {
    const shareToGroup = vi.fn(async () => ({}));
    __setGroupOutboundDepsForTest(
      baseDeps({
        shareToGroup,
        getTask: async () => taskAt("awaiting_ack"),
      }) as never,
    );
    const handle = rememberAdvance();

    await reviewExpiredGroupAdvance("task-1", handle.token);

    expect(shareToGroup).toHaveBeenCalledTimes(1);
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("到期时 action 查不到 → 摘登记但必须 @ 回一句，不静默消失", async () => {
    const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
    __setGroupOutboundDepsForTest(
      baseDeps({ sendText, getTask: async () => taskAt("awaiting_ack") }) as never,
    );
    // advanceTask 压根没返回过 action id
    const handle = rememberAdvance(null);

    await reviewExpiredGroupAdvance("task-1", handle.token);

    const body = callArgs(sendText)[1] as string;
    expect(body).toContain('<at user_id="ou_zhang">张三</at>');
    expect(body).toContain("Flowship");
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("「推进结果回群」关掉 → 摘登记也不回执（用户本就不要结果进群）", async () => {
    const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
    __setGroupOutboundDepsForTest(
      baseDeps({
        sendText,
        getTask: async () => taskAt("awaiting_ack"),
        isAdvanceResultToGroupEnabled: async () => false,
      }) as never,
    );
    const handle = rememberAdvance(null);

    await reviewExpiredGroupAdvance("task-1", handle.token);

    expect(sendText).not.toHaveBeenCalled();
    expect(listGroupReplies("task-1")).toHaveLength(0);
  });

  it("读 task 失败 → 什么都不做，登记留着等下一轮再问", async () => {
    const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
    __setGroupOutboundDepsForTest(
      baseDeps({
        sendText,
        getTask: async () => {
          throw new Error("读盘炸了");
        },
      }) as never,
    );
    const handle = rememberAdvance();

    await reviewExpiredGroupAdvance("task-1", handle.token);

    expect(sendText).not.toHaveBeenCalled();
    expect(listGroupReplies("task-1").map((e) => e.token)).toEqual([
      handle.token,
    ]);
  });

  // 本钩子由 `hasGroupReplies` 那次 prune 触发，而那句预筛排在 handleGroupOutboundEvent
  // 的开关判定**之前**——桥接关掉后照样会走到这里，不自己判一次就是继续往群里发东西
  it("桥接总开关关掉 → 到期回执也不发（登记留着、不静默摘）", async () => {
    const sendText = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_t" }));
    __setGroupOutboundDepsForTest(
      baseDeps({
        sendText,
        isBridgeEnabled: async () => false,
        getTask: async () => taskAt("awaiting_ack"),
      }) as never,
    );
    // actionId 没补记 = 本该「摘登记 + @ 一句回执」的那条路
    const handle = rememberAdvance(null);

    await reviewExpiredGroupAdvance("task-1", handle.token);

    expect(sendText).not.toHaveBeenCalled();
    expect(listGroupReplies("task-1").map((e) => e.token)).toEqual([
      handle.token,
    ]);
  });

  it("bootstrap 注册后：租约到点被推给收口器（而不是当场摘掉）", async () => {
    vi.useFakeTimers();
    try {
      __setGroupOutboundDepsForTest(
        baseDeps({ getTask: async () => taskAt("running", null) }) as never,
      );
      ensureFeishuGroupOutboundRegistered();
      const handle = rememberAdvance();
      vi.advanceTimersByTime(GROUP_REPLY_TTL_MS + 1000);

      // 任意一次 peek / has / remember 都会触发租约巡检（这里借只读快照）
      expect(listGroupReplies("task-1")).toHaveLength(1);
      await flushMicrotasks();

      // 收口器判定「还在跑」→ 续租满一轮，而不是只延一个巡检间隔
      expect(peekGroupReplyByToken("task-1", handle.token)?.expiresAt).toBe(
        Date.now() + GROUP_REPLY_TTL_MS,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("登记表本身（并存 / 回滚 / 容量 / 过期）", () => {
  const remember = (
    channel: "owner" | "restricted",
    over: { name?: string; kind?: "question" | "advance"; actionId?: string } = {},
  ) =>
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: "ou_x",
      requesterName: over.name ?? "张三",
      kind: over.kind ?? "question",
      ...(over.actionId ? { actionId: over.actionId } : {}),
      channel,
    })!;

  it("属主通道单格（后到覆盖先到）、旁路通道并存", () => {
    remember("owner", { name: "属主 A" });
    remember("owner", { name: "属主 B" });
    remember("restricted", { name: "同事甲" });
    remember("restricted", { name: "同事乙" });

    const names = listGroupReplies("task-1").map((e) => e.requesterName);
    expect(names).toEqual(["属主 B", "同事甲", "同事乙"]);
  });

  it("旁路那条回滚不碰属主的（反之亦然）", () => {
    const owner = remember("owner", { name: "属主" });
    const other = remember("restricted", { name: "同事" });

    restoreGroupReply("task-1", other);
    expect(listGroupReplies("task-1").map((e) => e.token)).toEqual([
      owner.token,
    ]);
    // 重复回滚是 no-op（自己那条已不在表里）
    restoreGroupReply("task-1", other);
    expect(listGroupReplies("task-1")).toHaveLength(1);
  });

  it("属主通道回滚把被覆盖的那条原样放回（含已攒文本）", () => {
    remember("owner", { name: "属主 A" });
    const b = remember("owner", { name: "属主 B" });
    expect(b.previous?.requesterName).toBe("属主 A");

    restoreGroupReply("task-1", b);
    expect(listGroupReplies("task-1").map((e) => e.requesterName)).toEqual([
      "属主 A",
    ]);
  });

  it("超过每 task 上限 → 丢最老的那条（僵尸登记不许无限攒）", () => {
    for (let i = 0; i < GROUP_REPLY_MAX_PER_TASK + 2; i++) {
      remember("restricted", { name: `同事${i}` });
    }
    const names = listGroupReplies("task-1").map((e) => e.requesterName);
    expect(names).toHaveLength(GROUP_REPLY_MAX_PER_TASK);
    expect(names[0]).toBe("同事2");
  });

  // 第六轮双审 P1-2：owner 通道已经挡住「question 顶掉 advance」，但容量上限那句
  // 裸 shift 不区分 kind——推进占 1 格 + 旁路答疑攒到 8 条，第 9 条就把在飞的推进
  // 挤没了，群里同样永久静默。两处策略必须一致。
  it("容量上限挤不掉在飞的 advance（只丢非 advance 的最老那条）", () => {
    const advance = remember("owner", { kind: "advance", actionId: "act-9" });
    for (let i = 0; i < GROUP_REPLY_MAX_PER_TASK + 2; i++) {
      remember("restricted", { name: `同事${i}` });
    }
    const list = listGroupReplies("task-1");
    expect(list).toHaveLength(GROUP_REPLY_MAX_PER_TASK);
    expect(list.map((e) => e.token)).toContain(advance.token);
    // 挤掉的是最老的旁路答疑，不是推进
    expect(list.map((e) => e.requesterName)).not.toContain("同事0");
  });

  it("过期登记自动摘掉（agent 跑挂后不许永久占位）", () => {
    vi.useFakeTimers();
    try {
      remember("restricted", { name: "同事" });
      expect(listGroupReplies("task-1")).toHaveLength(1);
      vi.advanceTimersByTime(GROUP_REPLY_TTL_MS + 1000);
      expect(listGroupReplies("task-1")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hasGroupAdvanceReplyFor：只认 advance 且 action 对得上（播报让位判定）", () => {
    remember("restricted", { name: "同事" });
    expect(hasGroupAdvanceReplyFor("task-1", "act-9")).toBe(false);
    remember("owner", { kind: "advance", actionId: "act-9" });
    expect(hasGroupAdvanceReplyFor("task-1", "act-9")).toBe(true);
    expect(hasGroupAdvanceReplyFor("task-1", "act-other")).toBe(false);
  });

  // 第五轮双审 P2-3：`!e.actionId` 那条宽判会让「登记刚建、actionId 未补记」的窗口里
  // **任意** action 的自动播报被静默吞掉——收窄成精确相等（真撞上有防重表兜底）
  it("hasGroupAdvanceReplyFor：actionId 还没补记的登记不让位给任何 action", () => {
    remember("owner", { kind: "advance" });
    expect(hasGroupAdvanceReplyFor("task-1", "act-9")).toBe(false);
    expect(hasGroupAdvanceReplyFor("task-1", "")).toBe(false);
  });

  // 群内推进跑到一半 agent 调 ask_user、群里有人作答：那条答案属于同一轮推进，
  // 顶掉推进登记 = 拿一句旁白换掉整份产物卡（P1-A 邻域）
  it("属主那格：在飞的 advance 不被 question 顶掉（返 null = 本次不另开登记）", () => {
    const advance = remember("owner", { kind: "advance", actionId: "act-9" });
    const question = rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: "ou_li",
      requesterName: "李四",
      kind: "question",
      channel: "owner",
    });
    expect(question).toBeNull();
    expect(listGroupReplies("task-1").map((e) => e.token)).toEqual([
      advance.token,
    ]);
    // 旁路通道不受影响——它本就并存
    const bypass = remember("restricted", { name: "同事" });
    expect(listGroupReplies("task-1").map((e) => e.token)).toEqual([
      advance.token,
      bypass.token,
    ]);
  });

  // 顶掉是对的（群里要的是最新那一轮），但被顶掉的那条再也收不到产物——
  // 回执由 group-route 在 advanceTask 成功后补发（见 feishu-group-inbound 用例）
  it("属主那格：后一轮 advance 仍能覆盖前一轮 advance", () => {
    const first = remember("owner", { kind: "advance", actionId: "act-9" });
    const next = remember("owner", { kind: "advance", actionId: "act-10" });
    expect(listGroupReplies("task-1").map((e) => e.token)).toEqual([
      next.token,
    ]);
    // 被顶掉的那条随凭据带走（回执要 @ 它的发起人、失败还要原样放回）
    expect(next.previous?.token).toBe(first.token);
  });

  // 清理链口径表第四行：回滚路径也算一个改表点。advance 的租约在被顶掉期间照走墙钟，
  // 按「过期就不放回」丢掉 = 在回滚路径上偷偷做了一次静默摘除；到期该做的是交给
  // 收口协议问一句 action 状态（放回后下一次 prune 自然会推给出向钩子）
  it("失败回滚：租约已过期的 advance 无条件放回", () => {
    vi.useFakeTimers();
    try {
      const advance = remember("owner", { kind: "advance", actionId: "act-9" });
      const next = remember("owner", { kind: "advance", actionId: "act-10" });
      vi.advanceTimersByTime(GROUP_REPLY_TTL_MS + 1000);

      restoreGroupReply("task-1", next);

      expect(listGroupReplies("task-1").map((e) => e.token)).toEqual([
        advance.token,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("失败回滚：过期的 question 仍然不放回（它没有到期收口协议）", () => {
    vi.useFakeTimers();
    try {
      remember("owner", { name: "属主 A" });
      const b = remember("owner", { name: "属主 B" });
      vi.advanceTimersByTime(GROUP_REPLY_TTL_MS + 1000);

      restoreGroupReply("task-1", b);

      expect(listGroupReplies("task-1")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("掉落问题汇总（十六轮 P3）", () => {
  const questionEntry = (over: Record<string, unknown> = {}) => ({
    chatId: CHAT,
    requesterOpenId: "ou_x",
    requesterName: "同事甲",
    kind: "question",
    answer: "",
    createdAt: Date.now(),
    expiresAt: Date.now() + GROUP_REPLY_TTL_MS,
    token: "tok-1",
    runTag: "tok-1",
    sourceMessageId: "om_q1",
    ...over,
  });

  const summaryOf = (i = 0) =>
    (
      callArgs(writeEventAndPublish, i)[1] as {
        text: string;
        meta: { groupQaSummary: Record<string, unknown> };
      }
    ).meta.groupQaSummary;

  // fire-and-forget 的 handler 落盘前先排干微任务（纯 Promise、不吃假时钟）
  const flushDropped = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it("到期摘 question → 通知钩子带 expired", () => {
    const seen: Array<{ name: string; reason: string }> = [];
    setGroupQuestionDroppedHandler((_taskId, dropped, reason) => {
      seen.push({ name: dropped.requesterName, reason });
    });
    try {
      vi.useFakeTimers();
      try {
        rememberGroupReply("task-1", {
          chatId: CHAT,
          requesterOpenId: "ou_x",
          requesterName: "同事甲",
          kind: "question",
          channel: "restricted",
        });
        vi.advanceTimersByTime(GROUP_REPLY_TTL_MS + 1000);
        expect(listGroupReplies("task-1")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
      expect(seen).toEqual([{ name: "同事甲", reason: "expired" }]);
    } finally {
      setGroupQuestionDroppedHandler(null);
    }
  });

  it("超限挤掉 question → 通知钩子带 evicted（挤的是最老那条）", () => {
    const seen: Array<{ name: string; reason: string }> = [];
    setGroupQuestionDroppedHandler((_taskId, dropped, reason) => {
      seen.push({ name: dropped.requesterName, reason });
    });
    try {
      for (let i = 0; i < GROUP_REPLY_MAX_PER_TASK + 1; i++) {
        rememberGroupReply("task-1", {
          chatId: CHAT,
          requesterOpenId: "ou_x",
          requesterName: `同事${i}`,
          kind: "question",
          channel: "restricted",
        });
      }
      expect(seen).toEqual([{ name: "同事0", reason: "evicted" }]);
    } finally {
      setGroupQuestionDroppedHandler(null);
    }
  });

  it("掉落处理：restricted 按 runTag 配对、写 ok:false、群里零发送", async () => {
    const sendText = vi.fn();
    const sendMarkdown = vi.fn();
    __setGroupOutboundDepsForTest(
      baseDeps({ sendText, sendMarkdown }) as never,
    );
    handleDroppedQuestionReply("task-1", questionEntry() as never, "expired");
    await flushDropped();
    expect(writeEventAndPublish).toHaveBeenCalledTimes(1);
    expect(callArgs(writeEventAndPublish)[0]).toBe("task-1");
    expect(summaryOf()).toMatchObject({
      runTag: "tok-1",
      askerOpenId: "ou_x",
      askerName: "同事甲",
      questionMessageId: "om_q1",
      ok: false,
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it("掉落处理：属主通道没有 runTag → dropped:<token> 另起、靠群消息 id 配对", async () => {
    handleDroppedQuestionReply(
      "task-1",
      questionEntry({ token: "tok-2", runTag: null }) as never,
      "evicted",
    );
    await flushDropped();
    expect(summaryOf()).toMatchObject({
      runTag: "dropped:tok-2",
      questionMessageId: "om_q1",
      ok: false,
    });
  });

  it("掉落处理：advance 不归这条管（收口协议另有去处）", async () => {
    handleDroppedQuestionReply(
      "task-1",
      questionEntry({ kind: "advance" }) as never,
      "expired",
    );
    await flushDropped();
    expect(writeEventAndPublish).not.toHaveBeenCalled();
  });

  it("bootstrap 注册后：过期 question 自动落 ok:false 汇总、群里不回", async () => {
    vi.useFakeTimers();
    try {
      const sendText = vi.fn(async () => ({
        chat_id: CHAT,
        message_id: "om_t",
      }));
      const sendMarkdown = vi.fn(async () => ({
        chat_id: CHAT,
        message_id: "om_m",
      }));
      __setGroupOutboundDepsForTest(
        baseDeps({ sendText, sendMarkdown }) as never,
      );
      ensureFeishuGroupOutboundRegistered();
      rememberGroupReply("task-1", {
        chatId: CHAT,
        requesterOpenId: "ou_x",
        requesterName: "同事甲",
        kind: "question",
        sourceMessageId: "om_q9",
        channel: "restricted",
      });
      vi.advanceTimersByTime(GROUP_REPLY_TTL_MS + 1000);
      expect(listGroupReplies("task-1")).toHaveLength(0);
      await flushDropped();
      expect(writeEventAndPublish).toHaveBeenCalledTimes(1);
      expect(summaryOf()).toMatchObject({ ok: false });
      expect(sendText).not.toHaveBeenCalled();
      expect(sendMarkdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("truncateForGroup", () => {
  it("超长截断并提示去 app 看全文", () => {
    expect(truncateForGroup("短回答")).toBe("短回答");
    const long = "a".repeat(1500);
    const t = truncateForGroup(long);
    expect(t.length).toBeLessThan(long.length);
    expect(t).toContain("Flowship");
  });
});

describe("回群 @（机器人问机器人真 @ 回去，吃掉后静默防环）", () => {
  it("机器人提问 → 回答真 @ 它（一轮结束靠发起方吃掉静默，兜底靠熔断）", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    const sendText = vi.fn();
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown, sendText }) as never);
    const h = rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: "ou_otherbot",
      requesterName: "江涛CLI",
      kind: "question",
      channel: "restricted",
    })!;
    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "埋点已确认上报",
      origin: h.runTag!,
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
      origin: h.runTag!,
    });
    expect(sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    const body = callArgs(sendMarkdown)[1] as string;
    expect(body).toContain("埋点已确认上报");
    // 真 @：发起方登记等答案、吃掉后静默，正常一轮结束
    expect(body).toContain("<at");
  });

  it("缺省（人类提问）→ 照常 @ 提醒", async () => {
    const sendMarkdown = vi.fn(async () => ({
      chat_id: CHAT,
      message_id: "om_md",
    }));
    __setGroupOutboundDepsForTest(baseDeps({ sendMarkdown }) as never);
    const h = rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "restricted",
    })!;
    await handleGroupOutboundEvent("task-1", {
      kind: "assistant_delta",
      text: "接口预计周五联调",
      origin: h.runTag!,
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
      origin: h.runTag!,
    });
    const body = callArgs(sendMarkdown)[1] as string;
    expect(body).toContain('<at user_id="ou_zhang">张三</at>');
    expect(body).toContain("接口预计周五联调");
  });
});

describe("排队 draining", () => {
  it("done / action 帧后泵一次排队", async () => {
    const pumpGroupQuestionQueue = vi.fn(async () => {});
    __setGroupOutboundDepsForTest(
      baseDeps({ pumpGroupQuestionQueue }) as never,
    );
    // 上一轮答完 → 泵（有登记才进分支，这是出向 tap 的既有预筛）
    const h = rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "restricted",
    })!;
    await handleGroupOutboundEvent("task-1", {
      kind: "done",
      task: fullTask(),
      ok: true,
      origin: h.runTag!,
    });
    expect(pumpGroupQuestionQueue).toHaveBeenCalledWith("task-1");
    // action 帧：属主动作有进展就顺手泵
    rememberGroupReply("task-1", {
      chatId: CHAT,
      requesterOpenId: REQUESTER.openId,
      requesterName: REQUESTER.name,
      kind: "question",
      channel: "owner",
    });
    await handleGroupOutboundEvent("task-1", {
      kind: "action",
      action: { id: "act-1", status: "running" },
    } as never);
    expect(pumpGroupQuestionQueue).toHaveBeenCalledTimes(2);
  });
});

describe("review 十二轮：问群卡无群 warn", () => {
  it("没绑群静默跳过，只打 warn 不写事件", async () => {
    const { sendAskCardToGroup } = await import(
      "@/lib/server/feishu-bridge/group-outbound"
    );
    const sendAskCard = vi.fn();
    __setGroupOutboundDepsForTest(
      baseDeps({
        sendAskCard,
        getBoundGroupChatId: async () => null,
      }) as never,
    );
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await sendAskCardToGroup(fullTask(), "ask-1", [
        { id: "q1", question: "选哪个？" },
      ]);
      expect(sendAskCard).not.toHaveBeenCalled();
      expect(
        spy.mock.calls.some((c) => String(c[0]).includes("问群卡无群跳过")),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
