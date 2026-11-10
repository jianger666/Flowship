/**
 * 群答疑出向（question 登记）：发累积全文（已收段落 + 当前段）+ 流式群卡（照私聊卡版式）。
 *
 * 2026-11-09 改：此前「只发最后一次工具调用之后那段」，流式卡上永远只有一句话、每调一次工具整句被换掉
 *（用户截图反馈）；现在群里看到的是累积全文（只增不换），思考 / 工具进折叠面板。下面凡写「最终段」的
 * 历史描述都以这条为准。
 *
 * 背景（2026-10-14 对接后端机器人「安若流年」）：旧设计整轮文字全发、无条件真 @ 回提问人、
 * 失败也 @ 一句「去 Flowship 看事件流」→ 两个机器人互 @ 成环、对端上下文被带偏。
 * 2026-11-06 用户拍板「协议不用管、让 AI 自己判断」：回复协议（@名字换真 @ / 需属主确认标记 / NO_REPLY 变体）
 * 整套下线，系统只剩三件事——首行 NO_REPLY 不发、真人提问人开头固定 @、其余原样发（群里跟私聊一样流式）。
 * 这里钉死：
 * - 答案 = 累积全文：各段落（按工具调用分段）用空行拼起来（assistant_message 落盘版早 / 晚于 tool_call 都不重复、不丢字）
 * - 机器人提问人失败 / 空回答静默；真人只收中性提示，群里绝不出现 Flowship / 事件流
 * - 首行 NO_REPLY 不发群；真人提问人固定 @；agent 自己写的 @ 标签原样放行
 * - 流式：判定要说话才起卡、卡上推累积全文（只增不换）、过程区进折叠面板、收尾整卡定稿；开关 = 任务级覆盖 > 全局
 * - 超长切 ≤3 条、每条 ≤1800 字、尾巴不提 Flowship
 *
 * 全部 mock 外部调用——**禁止真调飞书**（流式卡也是假的）。
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

const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ id: string } | null>>(async () => ({
    id: "ev_owned",
  })),
);

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeEventAndPublish, writeOwnedEventAndPublish };
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
  handleDroppedQuestionReply,
  handleGroupOutboundEvent,
  splitGroupReplyChunks,
} = await import("@/lib/server/feishu-bridge/group-outbound");

const {
  __resetGroupReplyStateForTest,
  listGroupReplies,
  rememberGroupReply,
} = await import("@/lib/server/feishu-bridge/group-shared");

const CHAT = "oc_req_group";
const TASK = "task-1";
const HUMAN = { openId: "ou_zhang", name: "张三" };
const BOT = { openId: "ou_anruo", name: "安若流年" };
const OWNER = { openId: "ou_owner", name: "宿主小王" };
/** 真人提问人的固定 @ 前缀（含尾随空格） */
const HUMAN_AT = '<at user_id="ou_zhang">张三</at> ';

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
  // 默认关流式：走「一次性发文本卡」那条老路；流式用例自己传开关 + 假流
  isStreamingEnabled: async () => false,
  createGroupCardStream: () => {
    throw new Error("测试不该走真流式卡（用 makeStreams() 的假流）");
  },
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
  writeOwnedEventAndPublish.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  __resetGroupReplyStateForTest();
});

describe("发累积全文（已收段落 + 当前段，按工具调用分段、空行拼接）", () => {
  it("中途旁白也进群、按时间序用空行拼：一条消息、每段恰好一份", async () => {
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
    expect(body).toBe(
      `${HUMAN_AT}我先查一下接口文档…\n\n再看看埋点配置。\n\n结论：接口周五联调。`,
    );
  });

  it("真实顺序（delta → assistant_message → tool_call）：落盘版不重复、不丢字", async () => {
    use();
    const tag = register();
    await delta("第一段旁白", tag);
    await message("第一段旁白", tag);
    await toolCall(tag);
    // tool_call 之后：当前段清空，上一段收进 closedSegments（lastSegment 仍记最近一段），待认领列表为空（落盘版已见过）
    const [entry] = listGroupReplies(TASK);
    expect(entry!.answer).toBe("");
    expect(entry!.lastSegment).toBe("第一段旁白");
    expect(entry!.closedSegments).toEqual(["第一段旁白"]);
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
    // 两段各一份：晚到的落盘版既不重复追加进新段，也不把已收段落吞掉
    expect(body).toBe(`${HUMAN_AT}第一段旁白\n\n最终答复`);
    expect(body.match(/最终答复/g)).toHaveLength(1);
    expect(body.match(/第一段旁白/g)).toHaveLength(1);
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
    expect(body).toBe(`${HUMAN_AT}第一段旁白\n\n最终答复`);
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
    expect(entry!.closedSegments).toEqual(["只有落盘版的一段"]);
  });

  it("最后一次工具调用之后没再说话 → 已收的那段照发（恰好一份、不重复）", async () => {
    const deps = use();
    const tag = register();
    await delta("答案写在工具调用之前", tag);
    await toolCall(tag);
    await message("答案写在工具调用之前", tag); // 晚到的落盘版
    await toolCall(tag); // 连续工具调用、中间没有文字：已收段落不能被清掉
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
    expect(listGroupReplies(TASK)[0]!.closedSegments).toBeUndefined();
  });

  it("先旁白、最后一段写成 NO_REPLY → 整轮静默（旁白不当答案发出去），汇总存全部原话", async () => {
    const deps = use();
    const tag = register(HUMAN);
    await delta("我先看看这条是不是问我的…", tag);
    await toolCall(tag);
    await delta("NO_REPLY", tag);
    await done(true, tag);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    const s = summaryOf()!;
    expect(s.noReply).toBe(true);
    expect(s.ok).toBe(true);
    expect(s.answer).toBe("我先看看这条是不是问我的…\n\nNO_REPLY");
  });

  it("中间某一段是 NO_REPLY、最后一段正常说话 → 只丢那一段，其余照发", async () => {
    const deps = use();
    const tag = register(BOT, true);
    await delta("前情提要", tag);
    await toolCall(tag);
    await delta("NO_REPLY", tag);
    await toolCall(tag);
    await delta("最终结论", tag);
    await done(true, tag);
    expect(sentTexts(deps.sendMarkdown)).toEqual(["前情提要\n\n最终结论"]);
  });

  it("closedSegments 有上限（200）：超了丢最早的，不无限涨", async () => {
    use();
    const tag = register(BOT, true);
    for (let i = 0; i < 205; i += 1) {
      await delta(`段${i}`, tag);
      await toolCall(tag);
    }
    const closed = listGroupReplies(TASK)[0]!.closedSegments!;
    expect(closed).toHaveLength(200);
    expect(closed[0]).toBe("段5");
    expect(closed.at(-1)).toBe("段204");
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

describe("NO_REPLY：首行就是它 → 群里什么都不发", () => {
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

  it.each([
    ["带反引号 / 强调 / 标点", "`**NO_REPLY**`。"],
    ["小写加空格", "no reply"],
    ["哨兵之后另起行的自我解释也不外发", "NO_REPLY\n对方只是确认，没问问题"],
  ])("%s → 静默", async (_name, text) => {
    const deps = use();
    const tag = register(HUMAN);
    await delta(text, tag);
    await done(true, tag);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    expect(summaryOf()!.noReply).toBe(true);
  });

  it("哨兵不在首行 / 和别的字写在同一行 → 当正常回复照发（宁可多发也不吞真回复）", async () => {
    const deps = use();
    const t1 = register(BOT, true);
    await delta("先说结论：字段 a 必填。\nNO_REPLY", t1);
    await done(true, t1);
    expect(sentTexts(deps.sendMarkdown)[0]).toContain("先说结论");

    const t2 = register(BOT, true);
    await delta("NO_REPLY：对方只是确认", t2);
    await done(true, t2);
    expect(sentTexts(deps.sendMarkdown)[1]).toBe("NO_REPLY：对方只是确认");
  });
});

describe("@：真人提问人固定 @，机器人不补，agent 自己写的标签原样放行", () => {
  it("真人提问人 → 开头固定 @（不用 agent 写）；汇总 mentioned = 提问人", async () => {
    const deps = use();
    const tag = register(HUMAN);
    await delta("接口周五联调", tag);
    await done(true, tag);
    expect(sentTexts(deps.sendMarkdown)[0]).toBe(
      '<at user_id="ou_zhang">张三</at> 接口周五联调',
    );
    expect(summaryOf()!.mentioned).toEqual(["张三"]);
  });

  it("真人提问人：agent 自己 @ 了别人也照样补提问人前缀（系统只管前缀，正文原样）", async () => {
    const deps = use();
    const tag = register(HUMAN);
    await delta('<at user_id="ou_li">李四</at> 这块请你确认下口径', tag);
    await done(true, tag);
    expect(sentTexts(deps.sendMarkdown)[0]).toBe(
      '<at user_id="ou_zhang">张三</at> <at user_id="ou_li">李四</at> 这块请你确认下口径',
    );
  });

  it("agent 写 `@名字`（不是标签）→ 不再被换成真 @，原样当文字发出", async () => {
    const deps = use();
    const tag = register(HUMAN);
    await delta("@李四 麻烦看下", tag);
    await done(true, tag);
    const body = sentTexts(deps.sendMarkdown)[0]!;
    expect(body).toContain("@李四 麻烦看下");
    expect(body).not.toContain('user_id="ou_li"');
  });

  it("机器人提问人：不补前缀（防环）；agent 自己写了标签 → 原样放行", async () => {
    const deps = use();
    const tag = register(BOT, true);
    await delta("字段 a 必填", tag);
    await done(true, tag);
    expect(sentTexts(deps.sendMarkdown)[0]).toBe("字段 a 必填");
    expect(summaryOf()!.mentioned).toBeUndefined();

    writeEventAndPublish.mockClear();
    const tag2 = register(BOT, true);
    await delta('<at user_id="ou_anruo">安若流年</at> 字段 a 必填', tag2);
    await done(true, tag2);
    expect(sentTexts(deps.sendMarkdown)[1]).toBe(
      '<at user_id="ou_anruo">安若流年</at> 字段 a 必填',
    );
  });

  it("atRequester === false 的旧登记：不补前缀", async () => {
    const deps = use();
    const h = rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: HUMAN.openId,
      requesterName: HUMAN.name,
      atRequester: false,
      kind: "question",
      channel: "restricted",
      sourceMessageId: "om_q",
    })!;
    await delta("接口周五联调", h.runTag!);
    await done(true, h.runTag!);
    expect(sentTexts(deps.sendMarkdown)[0]).toBe("接口周五联调");
  });
});

describe("回复协议已下线：旧标记不再有任何效果", () => {
  it("`[[需属主确认：…]]` 原样当文字发出；不写 groupNeedsOwner 事件、汇总没有 needsOwner", async () => {
    const deps = use();
    const tag = register(HUMAN);
    await delta("这个要宿主确认，已转告。\n[[需属主确认：是否本周五上线]]", tag);
    await done(true, tag);
    expect(sentTexts(deps.sendMarkdown)[0]).toContain("[[需属主确认：是否本周五上线]]");
    expect(
      writeEventAndPublish.mock.calls.some(
        (c) => (c[1] as { meta?: Record<string, unknown> }).meta?.groupNeedsOwner,
      ),
    ).toBe(false);
    expect(summaryOf()!.needsOwner).toBeUndefined();
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
    const tag = register(HUMAN);
    const startedAt = Date.now();
    await delta('<at user_id="ou_li">李四</at> 字段 a 必填', tag);
    vi.setSystemTime(new Date(startedAt + 4200));
    await done(true, tag);

    const s = summaryOf()!;
    expect(s.askerIsBot).toBe(false);
    // mentioned = 系统自动 @ 的提问人（agent 自己写的标签不计）
    expect(s.mentioned).toEqual(["张三"]);
    expect(s.startedAt).toBe(startedAt);
    expect(s.durationMs).toBe(4200);
    expect(s.ok).toBe(true);
    // tab 里 @ 标签还原成 @名字，群里发的是真 @
    expect(s.answer).toBe("@张三 @李四 字段 a 必填");
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

// ----------------- 流式群卡（假流：不碰飞书） -----------------

type FakeStream = {
  chatId: string;
  /** createGroupCardStream 的第二参（卡片标题） */
  title?: string;
  pushes: string[];
  /** pushProcess 收到的过程区 markdown（按推送顺序） */
  processes: string[];
  /** finalize 收到的块 */
  finalized: string[][];
  /** finalize 收到的收尾选项（与 finalized 一一对应） */
  finalizeOpts: Array<Record<string, unknown> | undefined>;
  push: (text: string) => void;
  pushProcess: (text: string) => void;
  finalize: (
    chunks: string[],
    opts?: Record<string, unknown>,
  ) => Promise<{
    delivered: boolean;
    error?: unknown;
    streamed: boolean;
  }>;
  isStarted: () => boolean;
  getIds: () => { cardId?: string; messageId?: string };
};

const makeStreams = (
  result: { delivered: boolean; error?: unknown; streamed: boolean } = {
    delivered: true,
    streamed: true,
  },
) => {
  const created: FakeStream[] = [];
  const factory = (chatId: string, opts?: { title?: string }): never => {
    const st: FakeStream = {
      chatId,
      title: opts?.title,
      pushes: [],
      processes: [],
      finalized: [],
      finalizeOpts: [],
      push: (text) => {
        st.pushes.push(text);
      },
      pushProcess: (text) => {
        st.processes.push(text);
      },
      finalize: async (chunks, finOpts) => {
        st.finalized.push(chunks);
        st.finalizeOpts.push(finOpts);
        return result;
      },
      isStarted: () => st.pushes.length > 0,
      getIds: () => ({}),
    };
    created.push(st);
    return st as never;
  };
  return { created, factory };
};

const useStreaming = (
  over: Record<string, unknown> = {},
  streamResult?: { delivered: boolean; error?: unknown; streamed: boolean },
) => {
  const streams = makeStreams(streamResult);
  const deps = use({
    isStreamingEnabled: async () => true,
    createGroupCardStream: streams.factory,
    ...over,
  });
  return { deps, ...streams };
};

describe("流式群卡：边出边推、收尾整卡换终稿", () => {
  it("delta 逐段推给流式卡（按 chat_id 建一张）；done 收尾成终稿，不再另发文本卡", async () => {
    const { deps, created } = useStreaming();
    const tag = register(HUMAN);
    await delta("结论：", tag);
    await delta("接口周五联调。", tag);
    await done(true, tag);

    expect(created).toHaveLength(1);
    expect(created[0]!.chatId).toBe(CHAT);
    // 每次推「累积全文」（含真人提问人的固定前缀），不是增量
    expect(created[0]!.pushes).toEqual([
      '<at user_id="ou_zhang">张三</at> 结论：',
      '<at user_id="ou_zhang">张三</at> 结论：接口周五联调。',
    ]);
    expect(created[0]!.finalized).toEqual([
      ['<at user_id="ou_zhang">张三</at> 结论：接口周五联调。'],
    ]);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    const s = summaryOf()!;
    expect(s.ok).toBe(true);
    expect(s.mentioned).toEqual(["张三"]);
    expect(s.answer).toBe("@张三 结论：接口周五联调。");
  });

  it("机器人提问人：推流不带前缀", async () => {
    const { created } = useStreaming();
    const tag = register(BOT, true);
    await delta("字段 a 必填", tag);
    await done(true, tag);
    expect(created[0]!.pushes).toEqual(["字段 a 必填"]);
    expect(created[0]!.finalized).toEqual([["字段 a 必填"]]);
  });

  it("首行还没写完（可能是 NO_REPLY）→ 先不起卡；写成 NO_REPLY → 始终不起卡、不发群", async () => {
    const { deps, created } = useStreaming();
    const tag = register(BOT, true);
    await delta("NO", tag);
    await delta("_REP", tag);
    expect(created).toHaveLength(0);
    await delta("LY", tag);
    expect(created).toHaveLength(0);
    await done(true, tag);
    expect(created).toHaveLength(0);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    expect(summaryOf()!.noReply).toBe(true);
  });

  it("NO_REPLY + 自我解释：始终不起卡", async () => {
    const { deps, created } = useStreaming();
    const tag = register(HUMAN);
    await delta("NO_REPLY\n", tag);
    await delta("对方只是确认", tag);
    await done(true, tag);
    expect(created).toHaveLength(0);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
  });

  it("「N」开头但其实是正常回复（Nginx…）→ 第二个字就认出来、起卡", async () => {
    const { created } = useStreaming();
    const tag = register(BOT, true);
    await delta("N", tag);
    expect(created).toHaveLength(0);
    await delta("ginx 配置在 conf.d 下", tag);
    expect(created).toHaveLength(1);
    expect(created[0]!.pushes).toEqual(["Nginx 配置在 conf.d 下"]);
  });

  it("工具调用前后：卡上推累积全文、只增不换（前一次永远是后一次的前缀）；终稿 = 全部段落", async () => {
    const { created } = useStreaming();
    const tag = register(BOT, true);
    await delta("我先查一下接口文档…", tag);
    await message("我先查一下接口文档…", tag);
    await toolCall(tag);
    await delta("结论：周五联调。", tag);
    await message("结论：周五联调。", tag);
    await done(true, tag);
    expect(created).toHaveLength(1);
    expect(created[0]!.pushes).toEqual([
      "我先查一下接口文档…",
      "我先查一下接口文档…\n\n结论：周五联调。",
    ]);
    // 只增不换：每一帧都以上一帧为前缀（打字机 / 用户看到的不会整句被替换）
    const p = created[0]!.pushes;
    for (let i = 1; i < p.length; i += 1) expect(p[i]!.startsWith(p[i - 1]!)).toBe(true);
    const fin = "我先查一下接口文档…\n\n结论：周五联调。";
    expect(created[0]!.finalized).toEqual([[fin]]);
    // 整份累积全文进卡（不是第 1 块）
    expect(created[0]!.finalizeOpts[0]).toMatchObject({ body: fin, outcome: "ok" });
  });

  it("没有 delta、只有落盘版（兜底路径）也会推给流式卡", async () => {
    const { created } = useStreaming();
    const tag = register(BOT, true);
    await message("只有落盘版的一段", tag);
    expect(created[0]!.pushes).toEqual(["只有落盘版的一段"]);
    await done(true, tag);
    expect(created[0]!.finalized).toEqual([["只有落盘版的一段"]]);
  });

  it("起卡之后新一段写成 NO_REPLY：不把 NO_REPLY 字样推上卡；终稿 = 静默，卡保持已推内容并收尾", async () => {
    const { deps, created } = useStreaming();
    const tag = register(BOT, true);
    await delta("我先查一下…", tag);
    await toolCall(tag);
    await delta("NO_REPLY", tag);
    await done(true, tag);
    expect(created[0]!.pushes).toEqual(["我先查一下…"]);
    // 收尾 = 不带任何新块、不带 body（卡保持已有内容）
    expect(created[0]!.finalized).toEqual([[]]);
    expect(created[0]!.finalizeOpts[0]).not.toHaveProperty("body");
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    expect(summaryOf()!.noReply).toBe(true);
  });

  it("超长终稿：切块仍传给 finalize（卡落不下去时的文本卡兜底），但卡里放整份累积全文", async () => {
    const { created } = useStreaming();
    const tag = register(HUMAN);
    const text = ["甲".repeat(1500), "乙".repeat(1500), "丙".repeat(1500)].join("\n\n");
    await delta(text, tag);
    await done(true, tag);
    const [chunks] = created[0]!.finalized;
    expect(chunks).toHaveLength(3);
    expect(chunks![0]).toContain('<at user_id="ou_zhang">张三</at>');
    expect(chunks![1]).not.toContain("<at");
    expect(created[0]!.finalizeOpts[0]!.body).toBe(
      `<at user_id="ou_zhang">张三</at> ${text}`,
    );
  });

  it("同一条登记的流只建一次；两条登记各自一张卡、互不串", async () => {
    const { created } = useStreaming();
    const t1 = register(HUMAN);
    const t2 = register({ openId: "ou_li", name: "李四" });
    await delta("给张三的答复", t1);
    await delta("给李四的答复", t2);
    await delta("，续", t1);
    expect(created).toHaveLength(2);
    expect(created[0]!.pushes.at(-1)).toBe('<at user_id="ou_zhang">张三</at> 给张三的答复，续');
    expect(created[1]!.pushes.at(-1)).toBe('<at user_id="ou_li">李四</at> 给李四的答复');
    await done(true, t2);
    expect(created[1]!.finalized).toHaveLength(1);
    expect(created[0]!.finalized).toHaveLength(0);
    await done(true, t1);
    expect(created[0]!.finalized).toHaveLength(1);
  });

  it("属主主链上的问题登记（无 origin）同样流式", async () => {
    const { created } = useStreaming();
    rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: HUMAN.openId,
      requesterName: HUMAN.name,
      kind: "question",
      channel: "owner",
    });
    await handleGroupOutboundEvent(TASK, {
      kind: "assistant_delta",
      text: "属主这轮的答复",
    } as never);
    expect(created).toHaveLength(1);
    expect(created[0]!.pushes[0]).toContain("属主这轮的答复");
  });

  it("advance 登记不走流式（推进结果仍是分享卡）", async () => {
    const { created } = useStreaming();
    rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: OWNER.openId,
      requesterName: OWNER.name,
      kind: "advance",
      channel: "owner",
    });
    await handleGroupOutboundEvent(TASK, {
      kind: "assistant_delta",
      text: "推进旁白",
    } as never);
    expect(created).toHaveLength(0);
  });
});

// ----------------- 过程区（思考与工具折叠面板，照私聊卡） -----------------

const thinking = (text: string, origin?: string) =>
  handleGroupOutboundEvent(TASK, {
    kind: "event",
    ...(origin ? { origin } : {}),
    event: { id: `e-th-${++seq}`, seq, ts: Date.now(), kind: "thinking", text },
  } as never);
const toolStart = (
  callId: string,
  name: string,
  args: string,
  origin?: string,
) =>
  handleGroupOutboundEvent(TASK, {
    kind: "event",
    ...(origin ? { origin } : {}),
    event: {
      id: `e-tc-${++seq}`,
      seq,
      ts: Date.now(),
      kind: "tool_call",
      text: `调用 ${name}`,
      meta: { callId, name, args },
    },
  } as never);
/** 真实 tool_result 的 meta 里带 args（buildToolResultMeta），text 只是「工具完成 X」 */
const toolEnd = (
  callId: string,
  name: string,
  status: "ok" | "error",
  origin?: string,
  args?: string,
) =>
  handleGroupOutboundEvent(TASK, {
    kind: "event",
    ...(origin ? { origin } : {}),
    event: {
      id: `e-tr-${++seq}`,
      seq,
      ts: Date.now(),
      kind: "tool_result",
      text: status === "error" ? `工具失败 ${name}` : `工具完成 ${name}`,
      meta: { callId, name, status, ...(args ? { args } : {}) },
    },
  } as never);

describe("流式群卡：过程区（思考与工具折叠面板）", () => {
  it("先调工具后开口：过程事件本身不建卡；开口建卡时带上任务标题与此前攒下的过程区", async () => {
    const { created } = useStreaming();
    const tag = register(BOT, true);
    await thinking("先看一下仓库结构", tag);
    await toolStart("c1", "Shell", JSON.stringify({ command: "ls src" }), tag);
    await toolEnd("c1", "Shell", "ok", tag, JSON.stringify({ command: "ls src" }));
    expect(created).toHaveLength(0); // 还没开口：群里零消息（NO_REPLY 零消息语义不被过程事件破坏）
    await delta("结论：入口在 src/app", tag);
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe("登录优化");
    const proc = created[0]!.processes.at(-1)!;
    expect(proc).toContain("**思考 1** · completed");
    expect(proc).toContain("先看一下仓库结构");
    expect(proc).toContain("`Shell` · completed");
    expect(proc).toContain("ls src");
    // 先给过程区、再给正文（建卡的首帧就带过程区）
    expect(created[0]!.processes.length).toBeGreaterThan(0);
    expect(created[0]!.pushes).toEqual(["结论：入口在 src/app"]);
  });

  it("已起卡后：tool_call 推 running，tool_result 回填 completed / failed", async () => {
    const { created } = useStreaming();
    const tag = register(BOT, true);
    await delta("我查一下", tag);
    await toolStart("c1", "Read", JSON.stringify({ path: "a.ts" }), tag);
    expect(created[0]!.processes.at(-1)).toContain("`Read` · running");
    await toolEnd("c1", "Read", "ok", tag);
    expect(created[0]!.processes.at(-1)).toContain("`Read` · completed");
    await toolStart("c2", "Shell", JSON.stringify({ command: "false" }), tag);
    await toolEnd("c2", "Shell", "error", tag);
    const last = created[0]!.processes.at(-1)!;
    expect(last).toContain("`Read` · completed");
    expect(last).toContain("`Shell` · failed");
  });

  it("连续几条 thinking（中间没有工具）合并成同一段「思考 N」；被工具隔开才新开一段", async () => {
    const { created } = useStreaming();
    const tag = register(BOT, true);
    await delta("开头", tag);
    await thinking("第一句思考", tag);
    await thinking("第二句思考", tag);
    await toolStart("c1", "Read", "{}", tag);
    await thinking("工具后的思考", tag);
    const proc = created[0]!.processes.at(-1)!;
    expect(proc).toContain("**思考 1** · completed\n第一句思考\n\n第二句思考");
    expect(proc).toContain("**思考 2** · completed\n工具后的思考");
  });

  it("过程区没变就不重复推（同一帧重复事件 / 纯 delta 不触发）", async () => {
    const { created } = useStreaming();
    const tag = register(BOT, true);
    await delta("开口", tag);
    const n = created[0]!.processes.length;
    await delta("，继续", tag);
    await delta("，再继续", tag);
    expect(created[0]!.processes).toHaveLength(n);
  });

  it("别的 run（属主主链 / 别人的旁路）的过程事件不进本条登记的卡", async () => {
    const { created } = useStreaming();
    const tag = register(BOT, true);
    const other = register({ openId: "ou_li", name: "李四" });
    await delta("本条在说", tag);
    const n = created[0]!.processes.length;
    await toolStart("x1", "Shell", JSON.stringify({ command: "rm -rf /tmp/x" }), other);
    await toolStart("x2", "Shell", JSON.stringify({ command: "whoami" })); // 属主主链：无 origin
    await thinking("别人的思考", other);
    expect(created).toHaveLength(1);
    expect(created[0]!.processes).toHaveLength(n);
    expect(created[0]!.processes.join("\n")).not.toMatch(/rm -rf|whoami|别人的思考/);
  });

  it("属主主链的卡不收「找不到登记的 origin」的过程事件（对不上 runTag 一律丢弃，不回落到属主那格）", async () => {
    const { created } = useStreaming();
    rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: HUMAN.openId,
      requesterName: HUMAN.name,
      kind: "question",
      channel: "owner",
    });
    await handleGroupOutboundEvent(TASK, {
      kind: "assistant_delta",
      text: "属主这轮的答复",
    } as never);
    expect(created).toHaveLength(1);
    const n = created[0]!.processes.length;
    await toolStart("z1", "Shell", JSON.stringify({ command: "cat /etc/passwd" }), "tok_unregistered");
    await thinking("陌生 run 的思考", "tok_unregistered");
    expect(created[0]!.processes).toHaveLength(n);
    expect(created[0]!.processes.join("\n")).not.toMatch(/passwd|陌生 run/);
    // 属主主链自己的事件照常进
    await toolStart("z2", "Read", JSON.stringify({ path: "a.ts" }));
    expect(created[0]!.processes.at(-1)).toContain("`Read` · running");
  });

  it("NO_REPLY + 只调了工具：不起卡、群里零消息（过程区也不会单独留一张卡）", async () => {
    const { deps, created } = useStreaming();
    const tag = register(BOT, true);
    await thinking("这条不关我事？", tag);
    await toolStart("c1", "Read", "{}", tag);
    await toolEnd("c1", "Read", "ok", tag);
    await delta("NO_REPLY", tag);
    await done(true, tag);
    expect(created).toHaveLength(0);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    expect(summaryOf()!.noReply).toBe(true);
  });

  it("流式开关关：过程事件不起卡、不推过程区；done 照旧一次性发文本卡（老路径）", async () => {
    const { deps, created } = useStreaming({ isStreamingEnabled: async () => false });
    const tag = register(BOT, true);
    await thinking("想一下", tag);
    await toolStart("c1", "Read", "{}", tag);
    await delta("答复", tag);
    await done(true, tag);
    expect(created).toHaveLength(0);
    expect(sentTexts(deps.sendMarkdown)).toEqual(["答复"]);
  });

  it("advance 登记的过程事件不起流式状态（推进走分享卡、不走答疑卡）", async () => {
    const { created } = useStreaming();
    rememberGroupReply(TASK, {
      chatId: CHAT,
      requesterOpenId: OWNER.openId,
      requesterName: OWNER.name,
      kind: "advance",
      channel: "owner",
    });
    await thinking("推进中的思考");
    await toolStart("c1", "Shell", "{}");
    expect(created).toHaveLength(0);
  });

  it("收尾带耗时与模型：outcome=ok、durationMs=这一轮耗时、model=任务模型", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    const { created } = useStreaming({
      getTask: async () => ({ ...fullTask(), model: { id: "claude-sonnet-5" } }),
    });
    const tag = register(BOT, true);
    const t0 = Date.now();
    await delta("答复", tag);
    vi.setSystemTime(new Date(t0 + 12_345));
    await done(true, tag);
    expect(created[0]!.finalizeOpts[0]).toMatchObject({
      outcome: "ok",
      durationMs: 12_345,
      model: "claude-sonnet-5",
      body: "答复",
    });
  });
});

describe("流式群卡：开关（任务级覆盖 > 全局）", () => {
  it("全局关 → 不起卡，done 时一次性发文本卡（老路径）", async () => {
    const { deps, created } = useStreaming({ isStreamingEnabled: async () => false });
    const tag = register(HUMAN);
    await delta("接口周五联调", tag);
    await done(true, tag);
    expect(created).toHaveLength(0);
    expect(sentTexts(deps.sendMarkdown)).toEqual([
      '<at user_id="ou_zhang">张三</at> 接口周五联调',
    ]);
  });

  it("任务级 true 盖过全局关", async () => {
    const { deps, created } = useStreaming({
      isStreamingEnabled: async () => false,
      getTask: async () => ({ ...fullTask(), feishuGroupStreaming: true }),
    });
    const tag = register(HUMAN);
    await delta("接口周五联调", tag);
    await done(true, tag);
    expect(created).toHaveLength(1);
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
  });

  it("任务级 false 盖过全局开", async () => {
    const { deps, created } = useStreaming({
      isStreamingEnabled: async () => true,
      getTask: async () => ({ ...fullTask(), feishuGroupStreaming: false }),
    });
    const tag = register(HUMAN);
    await delta("接口周五联调", tag);
    await done(true, tag);
    expect(created).toHaveLength(0);
    expect(sentTexts(deps.sendMarkdown)).toHaveLength(1);
  });

  it("任务级没设 → 跟随全局；读任务 / 读全局都抛错 → 按开处理（流式失败也有兜底）", async () => {
    const { created } = useStreaming({
      getTask: async () => {
        throw new Error("disk");
      },
      isStreamingEnabled: async () => {
        throw new Error("settings");
      },
    });
    const tag = register(HUMAN);
    await delta("接口周五联调", tag);
    expect(created).toHaveLength(1);
  });

  it("开关只在本轮第一个 delta 读一次：中途改开关不影响这一轮", async () => {
    let on = true;
    const { created } = useStreaming({ isStreamingEnabled: async () => on });
    const tag = register(HUMAN);
    await delta("一", tag);
    on = false;
    await delta("二", tag);
    expect(created).toHaveLength(1);
    expect(created[0]!.pushes).toHaveLength(2);
  });
});

describe("流式群卡：失败 / 空回答 / 被摘", () => {
  it("真人提问人失败：已起的卡保留已累积正文、末尾补中性提示，header 置失败态；汇总 ok:false 且 answer 不含半截内容", async () => {
    const { created, deps } = useStreaming();
    const tag = register(HUMAN);
    await delta("半截输出", tag);
    await done(false, tag);
    const hint = '<at user_id="ou_zhang">张三</at> 这轮我没答上来，麻烦再 @ 我一次';
    // 文本卡兜底块仍只有提示（卡落不下去时群里至少有一句人话）
    expect(created[0]!.finalized).toEqual([[hint]]);
    expect(created[0]!.finalizeOpts[0]).toMatchObject({
      outcome: "failed",
      body: `<at user_id="ou_zhang">张三</at> 半截输出\n\n${hint}`,
    });
    expect(deps.sendMarkdown).not.toHaveBeenCalled();
    const s = summaryOf()!;
    expect(s.ok).toBe(false);
    expect(String(s.answer)).not.toContain("半截输出");
  });


  it("机器人提问人失败：卡保持已有内容收尾（不补任何文字）；汇总 ok:false", async () => {
    const { created } = useStreaming();
    const tag = register(BOT, true);
    await delta("半截输出", tag);
    await done(false, tag);
    expect(created[0]!.finalized).toEqual([[]]);
    // 卡内容不动（不带 body），但 header 置失败态
    expect(created[0]!.finalizeOpts[0]).toMatchObject({ outcome: "failed" });
    expect(created[0]!.finalizeOpts[0]).not.toHaveProperty("body");
    expect(summaryOf()!.ok).toBe(false);
  });

  it("没起过卡就失败：真人走文本卡发中性提示（不经流式卡）", async () => {
    const { created, deps } = useStreaming();
    const tag = register(HUMAN);
    await done(false, tag);
    expect(created).toHaveLength(0);
    expect(sentTexts(deps.sendMarkdown)).toEqual([
      '<at user_id="ou_zhang">张三</at> 这轮我没答上来，麻烦再 @ 我一次',
    ]);
  });

  it("流式卡收尾失败（delivered:false）：留「答疑回复没发出去」+ 汇总 ok:false", async () => {
    const { created } = useStreaming({}, { delivered: false, error: new Error("boom"), streamed: true });
    // 换一个群：失败提示按「群 + 类别」每分钟节流，别被前面用例的同群失败吃掉名额
    const h = rememberGroupReply(TASK, {
      chatId: "oc_stream_fail_group",
      requesterOpenId: HUMAN.openId,
      requesterName: HUMAN.name,
      kind: "question",
      channel: "restricted",
      sourceMessageId: "om_q",
    })!;
    await delta("接口周五联调", h.runTag!);
    await done(true, h.runTag!);
    expect(created[0]!.finalized).toHaveLength(1);
    expect(summaryOf()!.ok).toBe(false);
    expect(
      writeOwnedEventAndPublish.mock.calls.some((c) => {
        const ev = c[2] as { text?: string } | undefined; // (taskId, lease, ev)
        return String(ev?.text ?? "").includes("答疑回复没发出去");
      }),
    ).toBe(true);
  });

  it("登记被摘（过期 / 被挤）：已起的卡收尾成已有内容，不挂着「生成中」", async () => {
    const { created } = useStreaming();
    const tag = register(HUMAN);
    await delta("答到一半", tag);
    const [entry] = listGroupReplies(TASK);
    handleDroppedQuestionReply(TASK, entry!, "expired");
    await Promise.resolve();
    expect(created[0]!.finalized).toEqual([[]]);
  });

  it("流式状态表不泄漏：收口（起过卡 / NO_REPLY / 没开流式）、被摘之后都清空", async () => {
    const streamsSize = (): number =>
      (
        (globalThis as unknown as Record<string, { streams: Map<string, unknown> } | undefined>)[
          "__flowshipFeishuGroupOutboundV1__"
        ]?.streams ?? new Map()
      ).size;
    useStreaming();
    const t1 = register(HUMAN);
    await delta("说话了", t1);
    expect(streamsSize()).toBe(1);
    await done(true, t1);
    expect(streamsSize()).toBe(0);

    const t2 = register(BOT, true);
    await delta("NO_REPLY\n", t2);
    expect(streamsSize()).toBe(1); // 沉默也占一格状态（开关读过一次）
    await done(true, t2);
    expect(streamsSize()).toBe(0);

    const t3 = register(HUMAN);
    await delta("答到一半", t3);
    const entry = listGroupReplies(TASK).find((e) => e.runTag === t3)!;
    handleDroppedQuestionReply(TASK, entry, "evicted");
    expect(streamsSize()).toBe(0);
  });

  it("收口后流式状态已清：同一条 token 之后再来 delta 不会复活旧卡", async () => {
    const { created } = useStreaming();
    const tag = register(HUMAN);
    await delta("一", tag);
    await done(true, tag);
    expect(created).toHaveLength(1);
    await delta("迟到的 delta", tag);
    expect(created).toHaveLength(1);
  });
});
