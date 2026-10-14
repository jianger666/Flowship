/**
 * 群答疑出向（question 登记）新策略：只发最终段 + 按回复协议落地。
 *
 * 背景（2026-10-14 对接后端机器人「安若流年」）：旧设计整轮文字全发、无条件真 @ 回提问人、
 * 失败也 @ 一句「去 Flowship 看事件流」→ 两个机器人互 @ 成环、对端上下文被带偏。
 * 这里钉死新语义：
 * - 答案 = 最后一次工具调用之后那段（assistant_message 落盘版早 / 晚于 tool_call 都不重复、不丢字）
 * - 机器人提问人失败 / 空回答静默；真人只收中性提示，群里绝不出现 Flowship / 事件流
 * - NO_REPLY 不发群；@名字 → 真 @；需属主确认写主事件流 info
 * - 超长切 ≤3 条、每条 ≤1800 字、尾巴不提 Flowship
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
  `group-outbound-reply-${Date.now()}`,
  "data",
);

const {
  GROUP_REPLY_CHUNK_MAX,
  GROUP_REPLY_MAX_CHUNKS,
  __resetGroupOutboundForTest,
  __setGroupOutboundDepsForTest,
  handleGroupOutboundEvent,
  splitGroupReplyChunks,
} = await import("@/lib/server/feishu-bridge/group-outbound");

const {
  __resetGroupReplyStateForTest,
  listGroupReplies,
  rememberGroupReply,
} = await import("@/lib/server/feishu-bridge/group-shared");

const { isHiddenFromEventStream } = await import("@/lib/event-stream-hidden");

const CHAT = "oc_req_group";
const TASK = "task-1";
const HUMAN = { openId: "ou_zhang", name: "张三" };
const BOT = { openId: "ou_anruo", name: "安若流年" };
const OWNER = { openId: "ou_owner", name: "宿主小王" };
const SELF = "ou_self_bot";

const ROSTER_MEMBERS = [
  { openId: HUMAN.openId, name: HUMAN.name, kind: "user" as const },
  { openId: "ou_li", name: "李四", kind: "user" as const },
  { openId: BOT.openId, name: BOT.name, kind: "bot" as const },
  { openId: OWNER.openId, name: OWNER.name, kind: "user" as const },
];

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
  readArtifact: async () => "# 报告",
  pumpGroupQuestionQueue: vi.fn(async () => {}),
  fetchRoster: async () => ({ members: ROSTER_MEMBERS }),
  resolveOwner: async () => OWNER,
  getSelfOpenId: async () => SELF,
  ...over,
});

const use = (over: Record<string, unknown> = {}) => {
  const deps = baseDeps(over);
  __setGroupOutboundDepsForTest(deps as never);
  return deps;
};

/** 登记一条旁路答疑（restricted）：返回 runTag */
const register = (
  who: { openId: string; name: string } = HUMAN,
  isBot = false,
): string => {
  const h = rememberGroupReply(TASK, {
    chatId: CHAT,
    requesterOpenId: who.openId,
    requesterName: who.name,
    ...(isBot ? { requesterIsBot: true } : {}),
    kind: "question",
    channel: "restricted",
    sourceMessageId: "om_q",
  })!;
  return h.runTag!;
};

let seq = 0;
const delta = (text: string, origin: string) =>
  handleGroupOutboundEvent(TASK, {
    kind: "assistant_delta",
    text,
    origin,
  } as never);
const message = (text: string, origin: string) =>
  handleGroupOutboundEvent(TASK, {
    kind: "event",
    origin,
    event: {
      id: `e-msg-${++seq}`,
      seq,
      ts: Date.now(),
      kind: "assistant_message",
      text,
    },
  } as never);
const toolCall = (origin?: string) =>
  handleGroupOutboundEvent(TASK, {
    kind: "event",
    ...(origin ? { origin } : {}),
    event: {
      id: `e-tool-${++seq}`,
      seq,
      ts: Date.now(),
      kind: "tool_call",
      text: "调用 read",
      meta: { callId: `c${seq}`, name: "read" },
    },
  } as never);
const done = (ok: boolean, origin: string) =>
  handleGroupOutboundEvent(TASK, {
    kind: "done",
    task: fullTask(),
    ok,
    origin,
  } as never);

/** 汇总事件的 meta.groupQaSummary（没写返 undefined） */
const summaryOf = (): Record<string, unknown> | undefined => {
  for (const call of writeEventAndPublish.mock.calls) {
    const meta = (
      call[1] as { meta?: { groupQaSummary?: Record<string, unknown> } }
    ).meta;
    if (meta?.groupQaSummary) return meta.groupQaSummary;
  }
  return undefined;
};

beforeEach(() => {
  __resetGroupReplyStateForTest();
  writeEventAndPublish.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  __resetGroupReplyStateForTest();
});

describe("只发最终段（最后一次工具调用之后）", () => {
  it("中途旁白不进群：只发工具调用之后的那段", async () => {
    const deps = use();
    const tag = register();
    await delta("我先查一下接口文档…", tag);
    await message("我先查一下接口文档…", tag);
    await toolCall(tag);
    await delta("再看看埋点配置。", tag);
    await message("再看看埋点配置。", tag);
    await toolCall(tag);
    await delta("结论：接口周五联调。", tag);
    await message("结论：接口周五联调。", tag);
    await done(true, tag);

    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toContain("结论：接口周五联调。");
    expect(body).not.toContain("我先查一下");
    expect(body).not.toContain("埋点配置");
  });

  it("真实顺序（delta → assistant_message → tool_call）：落盘版不重复、不丢字", async () => {
    use();
    const tag = register();
    await delta("第一段旁白", tag);
    await message("第一段旁白", tag);
    await toolCall(tag);
    // tool_call 之后：当前段清空，上一段收进 lastSegment，待认领列表为空（落盘版已见过）
    const [entry] = listGroupReplies(TASK);
    expect(entry!.answer).toBe("");
    expect(entry!.lastSegment).toBe("第一段旁白");
    expect(entry!.awaitingMessages ?? []).toEqual([]);
    await delta("最终", tag);
    await delta("答复", tag);
    await message("最终答复", tag);
    expect(listGroupReplies(TASK)[0]!.answer).toBe("最终答复");
  });

  it("落盘版晚于 tool_call 到达：不把上一段重复追加进新段", async () => {
    const deps = use();
    const tag = register();
    await delta("第一段旁白", tag);
    await toolCall(tag); // 落盘版还没到
    await message("第一段旁白", tag); // 晚到的重复
    expect(listGroupReplies(TASK)[0]!.answer).toBe("");
    await delta("最终答复", tag);
    await message("最终答复", tag);
    await done(true, tag);
    expect(sentTexts(deps.sendMarkdown)).toHaveLength(1);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toContain("最终答复");
    expect(body).not.toContain("第一段旁白");
    // 没有重复（"最终答复最终答复"）
    expect(body.match(/最终答复/g)).toHaveLength(1);
  });

  it("落盘版晚到且新段 delta 已经开始：仍认出重复、新段不被吞", async () => {
    const deps = use();
    const tag = register();
    await delta("第一段旁白", tag);
    await toolCall(tag);
    await delta("最终答复", tag); // 新段 delta 先到
    await message("第一段旁白", tag); // 上一段的落盘版此刻才到
    await message("最终答复", tag);
    expect(listGroupReplies(TASK)[0]!.answer).toBe("最终答复");
    await done(true, tag);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toContain("最终答复");
    expect(body).not.toContain("第一段旁白");
  });

  it("没有 delta 只有落盘版（兜底）：照常追加；工具调用后收段", async () => {
    use();
    const tag = register();
    await message("只有落盘版的一段", tag);
    expect(listGroupReplies(TASK)[0]!.answer).toBe("只有落盘版的一段");
    await toolCall(tag);
    const [entry] = listGroupReplies(TASK);
    expect(entry!.answer).toBe("");
    expect(entry!.lastSegment).toBe("只有落盘版的一段");
  });

  it("最后一次工具调用之后没再说话 → 回退上一非空段（恰好一份、不重复）", async () => {
    const deps = use();
    const tag = register();
    await delta("答案写在工具调用之前", tag);
    await toolCall(tag);
    await message("答案写在工具调用之前", tag); // 晚到的落盘版
    await toolCall(tag); // 连续工具调用、中间没有文字：lastSegment 不能被清掉
    await done(true, tag);
    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toContain("答案写在工具调用之前");
    expect(body.match(/答案写在工具调用之前/g)).toHaveLength(1);
  });

  it("别的 run（属主主链 / 别人的旁路）的 tool_call 不截断本条登记", async () => {
    use();
    const tag = register();
    const other = register({ openId: "ou_li", name: "李四" });
    await delta("本条还在说", tag);
    await toolCall(); // 属主主链：无 origin
    await toolCall(other); // 另一位同事的旁路 run
    expect(
      listGroupReplies(TASK).find((e) => e.runTag === tag)!.answer,
    ).toBe("本条还在说");
  });

  it("advance 登记不分段（推进旁白仍整轮累积，收口另有判据）", async () => {
    use();
    rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: OWNER.openId,
      requesterName: OWNER.name,
      kind: "advance",
      channel: "owner",
    });
    await handleGroupOutboundEvent(TASK, {
      kind: "assistant_delta",
      text: "推进旁白一",
    } as never);
    await toolCall();
    await handleGroupOutboundEvent(TASK, {
      kind: "assistant_delta",
      text: "推进旁白二",
    } as never);
    expect(listGroupReplies(TASK)[0]!.answer).toBe("推进旁白一推进旁白二");
  });
});

describe("失败 / 空回答：机器人提问人静默，真人只收中性提示", () => {
  it("机器人提问人失败 → 群里不发任何东西，只写汇总 ok:false", async () => {
    const deps = use();
    const tag = register(BOT, true);
    await delta("半截输出", tag);
    await done(false, tag);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    expect(deps.sendText).not.toHaveBeenCalled();
    const s = summaryOf()!;
    expect(s.ok).toBe(false);
    expect(s.askerIsBot).toBe(true);
    expect(String(s.answer)).not.toContain("半截输出");
  });

  it("真人提问人失败 → 中性提示 + 真 @，不含 Flowship / 事件流", async () => {
    const deps = use();
    const tag = register(HUMAN);
    await done(false, tag);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toBe(
      '<at user_id="ou_zhang">张三</at> 这轮我没答上来，麻烦再 @ 我一次',
    );
    expect(body).not.toMatch(/Flowship|事件流/);
    expect(summaryOf()!.ok).toBe(false);
  });

  it("成功但最终文本为空：机器人静默、真人提示再 @ 一次", async () => {
    const deps = use();
    const botTag = register(BOT, true);
    await done(true, botTag);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    expect(summaryOf()!.ok).toBe(true);

    writeEventAndPublish.mockClear();
    const humanTag = register(HUMAN);
    await done(true, humanTag);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toContain("这轮我没整理出回复，麻烦再 @ 我一次");
    expect(body).toContain('<at user_id="ou_zhang">张三</at>');
    expect(body).not.toMatch(/Flowship|事件流|已处理完成/);
  });
});

describe("NO_REPLY 与 @ 解析", () => {
  it("NO_REPLY → 不发群，汇总 noReply:true、answer 存原话、ok:true", async () => {
    const deps = use();
    const tag = register(BOT, true);
    await delta("NO_REPLY", tag);
    await done(true, tag);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    const s = summaryOf()!;
    expect(s.noReply).toBe(true);
    expect(s.ok).toBe(true);
    expect(s.answer).toBe("NO_REPLY");
  });

  it("正文里的 @名字（roster 里有）→ 真 @；写了真 @ 就不再自动补提问人", async () => {
    const deps = use();
    const tag = register(HUMAN);
    await delta("@李四 这块请你确认下口径", tag);
    await done(true, tag);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toContain('<at user_id="ou_li">李四</at>');
    expect(body).not.toContain('user_id="ou_zhang"');
    expect(summaryOf()!.mentioned).toEqual(["李四"]);
  });

  it("机器人提问人没写 @ → 不补（防环）；写了 @名字 → 真 @", async () => {
    const deps = use();
    const tag = register(BOT, true);
    await delta("字段 a 必填", tag);
    await done(true, tag);
    expect(sentTexts(deps.sendMarkdown)[0]).toBe("字段 a 必填");
    expect(summaryOf()!.mentioned).toBeUndefined();

    writeEventAndPublish.mockClear();
    const tag2 = register(BOT, true);
    await delta("@安若流年 字段 a 必填", tag2);
    await done(true, tag2);
    expect(sentTexts(deps.sendMarkdown)[1]).toContain(
      '<at user_id="ou_anruo">安若流年</at>',
    );
    expect(summaryOf()!.mentioned).toEqual(["安若流年"]);
  });

  it("真人提问人没写 @ → 自动补 @ 提问人", async () => {
    const deps = use();
    const tag = register(HUMAN);
    await delta("接口周五联调", tag);
    await done(true, tag);
    expect(sentTexts(deps.sendMarkdown)[0]).toBe(
      '<at user_id="ou_zhang">张三</at> 接口周五联调',
    );
    expect(summaryOf()!.mentioned).toEqual(["张三"]);
  });
});

describe("需属主确认", () => {
  it("写主事件流 info（带 groupNeedsOwner meta、主流可见），群里@属主且剥掉标记，汇总带 needsOwner", async () => {
    const deps = use();
    const tag = register(HUMAN);
    await delta("这个要宿主确认，已转告。\n[[需属主确认：是否本周五上线]]", tag);
    await done(true, tag);

    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).not.toContain("[[需属主确认");
    expect(body).toContain('<at user_id="ou_owner">宿主小王</at>');

    const infoCall = writeEventAndPublish.mock.calls.find(
      (c) =>
        (c[1] as { meta?: Record<string, unknown> }).meta?.groupNeedsOwner,
    );
    expect(infoCall).toBeTruthy();
    // 主事件流写入：taskId 对、没有 lease 参数（不是 owned 事件）
    expect(infoCall![0]).toBe(TASK);
    const ev = infoCall![1] as {
      kind: string;
      text: string;
      meta: { groupNeedsOwner: Record<string, unknown> };
    };
    expect(ev.kind).toBe("info");
    expect(ev.text).toBe(
      "群里有事等你拍板（来自 张三）：是否本周五上线",
    );
    expect(ev.meta.groupNeedsOwner).toEqual({
      runTag: tag,
      askerName: "张三",
      askerOpenId: "ou_zhang",
      note: "是否本周五上线",
    });
    // 必须在主事件流可见：现有隐藏规则不能把它藏掉
    expect(
      isHiddenFromEventStream({
        id: "e",
        seq: 1,
        ts: Date.now(),
        ...ev,
      } as never),
    ).toBe(false);

    expect(summaryOf()!.needsOwner).toBe("是否本周五上线");
  });

  it("发群失败时也照写（属主需要知道）", async () => {
    use({
      sendMarkdown: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const tag = register(HUMAN);
    await delta("先这样。[[需属主确认：要不要加字段]]", tag);
    await done(true, tag);
    expect(
      writeEventAndPublish.mock.calls.some(
        (c) =>
          (c[1] as { meta?: Record<string, unknown> }).meta?.groupNeedsOwner,
      ),
    ).toBe(true);
    expect(summaryOf()!.ok).toBe(false);
  });
});

describe("超长回复切块", () => {
  const para = (ch: string, n: number) => ch.repeat(n);

  it("按段落切成 ≤1800 字的块；短文本不切", () => {
    expect(splitGroupReplyChunks("短回答")).toEqual(["短回答"]);
    const text = [para("甲", 1000), para("乙", 1000), para("丙", 500)].join(
      "\n\n",
    );
    const chunks = splitGroupReplyChunks(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(para("甲", 1000));
    expect(chunks[1]).toBe(`${para("乙", 1000)}\n\n${para("丙", 500)}`);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(GROUP_REPLY_CHUNK_MAX);
    }
  });

  it("单段超长按句号硬切、不丢字", () => {
    const sentence = `${para("字", 99)}。`; // 100 字一句
    const text = sentence.repeat(30); // 3000 字、无空行
    const chunks = splitGroupReplyChunks(text);
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(GROUP_REPLY_CHUNK_MAX);
      expect(c.endsWith("。")).toBe(true);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("超过 3 条：最后一条末尾注明后半已省略，且不提 Flowship", () => {
    const text = Array.from({ length: 6 }, (_, i) => para(String(i), 1500)).join(
      "\n\n",
    );
    const chunks = splitGroupReplyChunks(text);
    expect(chunks).toHaveLength(GROUP_REPLY_MAX_CHUNKS);
    expect(chunks[2]).toMatch(/（内容较长，后半已省略）$/);
    expect(chunks[0]).not.toContain("后半已省略");
    expect(chunks.join("")).not.toContain("Flowship");
  });

  it("硬切不切断 at 标签", () => {
    const tag = '<at user_id="ou_li">李四</at>';
    const text = `${para("甲", 1790)}${tag}${para("乙", 200)}`;
    const chunks = splitGroupReplyChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const opens = (c.match(/<at\b/g) ?? []).length;
      const closes = (c.match(/<\/at>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it("发群：分多条、第一条带真 @、后续不重复 @", async () => {
    const deps = use();
    const tag = register(HUMAN);
    const text = [para("甲", 1500), para("乙", 1500), para("丙", 1500)].join(
      "\n\n",
    );
    await delta(text, tag);
    await done(true, tag);
    const bodies = sentTexts(deps.sendMarkdown);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toContain('<at user_id="ou_zhang">张三</at>');
    expect(bodies[1]).not.toContain("<at");
    expect(bodies[2]).not.toContain("<at");
    for (const b of bodies) expect(b).not.toContain("Flowship");
  });
});

describe("汇总事件新字段", () => {
  it("askerIsBot / mentioned / startedAt / durationMs 都写上；answer 存实际发出的那段", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    const deps = use();
    const tag = register(BOT, true);
    const startedAt = Date.now();
    await delta("@安若流年 字段 a 必填", tag);
    vi.setSystemTime(new Date(startedAt + 4200));
    await done(true, tag);

    const s = summaryOf()!;
    expect(s.askerIsBot).toBe(true);
    expect(s.mentioned).toEqual(["安若流年"]);
    expect(s.startedAt).toBe(startedAt);
    expect(s.durationMs).toBe(4200);
    expect(s.ok).toBe(true);
    // tab 里 @ 标签还原成 @名字，群里发的是真 @
    expect(s.answer).toBe("@安若流年 字段 a 必填");
    expect(sentTexts(deps.sendMarkdown)[0]).toContain("<at user_id=");
    expect(s.runTag).toBe(tag);
    expect(s.questionMessageId).toBe("om_q");
  });

  it("发送失败：汇总 ok:false，答案仍存 tab", async () => {
    use({
      sendMarkdown: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const tag = register(HUMAN);
    await delta("接口周五联调", tag);
    await done(true, tag);
    const s = summaryOf()!;
    expect(s.ok).toBe(false);
    expect(String(s.answer)).toContain("接口周五联调");
  });
});

describe("外部查询拿不到：不抛错、照常发（无真 @ 版本）", () => {
  it("roster / 属主 / 机器人 open_id 全抛错 → 照发，真人提问人仍自动补 @", async () => {
    const boom = async () => {
      throw new Error("lark-cli down");
    };
    const deps = use({
      fetchRoster: boom,
      resolveOwner: boom,
      getSelfOpenId: boom,
    });
    const tag = register(HUMAN);
    await delta("@李四 麻烦看下", tag);
    await done(true, tag);
    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    // 没有 roster：李四认不出，原样保留文本；提问人（登记里自带）仍补真 @
    expect(body).toContain("@李四 麻烦看下");
    expect(body).not.toContain('user_id="ou_li"');
    expect(body).toContain('<at user_id="ou_zhang">张三</at>');
  });

  it("3 秒硬超时：roster 挂死也不阻塞回群", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const never = () => new Promise<never>(() => {});
    const deps = use({
      fetchRoster: never,
      resolveOwner: never,
      getSelfOpenId: never,
    });
    const tag = register(HUMAN);
    await delta("接口周五联调", tag);
    const p = done(true, tag);
    await vi.advanceTimersByTimeAsync(3_000);
    await p;
    expect(deps.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(sentTexts(deps.sendMarkdown)[0]).toBe(
      '<at user_id="ou_zhang">张三</at> 接口周五联调',
    );
  });

  it("owner 拿不到：需属主确认降级成纯文本、事件流照写", async () => {
    const deps = use({ resolveOwner: async () => undefined });
    const tag = register(HUMAN);
    await delta("先这样。[[需属主确认：要不要加字段]]", tag);
    await done(true, tag);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toContain("需要属主确认：要不要加字段");
    expect(body).not.toContain("[[");
    expect(
      writeEventAndPublish.mock.calls.some(
        (c) =>
          (c[1] as { meta?: Record<string, unknown> }).meta?.groupNeedsOwner,
      ),
    ).toBe(true);
  });
});
