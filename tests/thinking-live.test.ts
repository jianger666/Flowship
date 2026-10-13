/**
 * 思考实时态（thinking_delta）的前端纯函数：累积 + 状态行推导。
 *
 * 背景（2026-10-10 实测）：一段 65s 的思考，服务端第 6s 就收到首个增量，但整段攒到结束
 * 才落一条 thinking 事件——界面这 70s 一直写「等待模型响应… 已等待 62s」。
 * 这里钉死三件事：
 *   ① 实时帧能累积成本段原文，且吐字用的「累计坐标」在截尾后仍然精确；
 *   ② 状态行在思考进行中说「思考中 · 计时」而不是「正在启动… / 处理中…」，
 *      但不盖掉更具体的信息（工具在跑 / 压缩中 / 正文在流）；
 *   ③ 状态行**不带思考原文**（2026-10-12 用户截图：组内思考行和输入框上方状态行
 *      同一行字上下各出现一遍）——原文只在工作过程组的思考行里展示。
 */
import { describe, expect, it } from "vitest";

import { deriveActiveStatus, PROCESSING_PLACEHOLDER_LABEL } from "../src/lib/chat-turns";
import {
  COMPACTION_RUNNING_LABEL,
  compactionEventMeta,
} from "../src/lib/compaction-display";
import {
  advanceLiveThinking,
  appendThinkingText,
  liveThinkingOffset,
  liveThinkingTotal,
  revealLiveThinking,
  THINKING_LIVE_LABEL,
  THINKING_TEXT_MAX,
  type LiveThinking,
} from "../src/lib/thinking-live";
import type { TaskEvent } from "../src/lib/types";

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind" | "text">,
): TaskEvent => ({ ts: 1, ...partial });

describe("appendThinkingText", () => {
  it("未超上限原样拼接；一行被切成两个 chunk 也能拼回来", () => {
    let text = appendThinkingText("", "正在分析性能");
    text = appendThinkingText(text, "数据，看看哪一段慢");
    expect(text).toBe("正在分析性能数据，看看哪一段慢");
  });

  it("长思考逐 chunk 追加：文本有界、保留的是尾部（最新内容）", () => {
    // 实测一段 65s 的思考有 1111 条 token 级 chunk、约 7.8K 字；更长的思考不能让内存无限增长
    let text = "";
    for (let i = 0; i < 5000; i++) text = appendThinkingText(text, `token${i} `);
    expect(text.length).toBeLessThanOrEqual(THINKING_TEXT_MAX);
    expect(text.endsWith("token4999 ")).toBe(true);
    // 保留的是尾部、不是随便一段：最前面的 token 早被挤掉
    expect(text).not.toContain("token0 ");
  });

  it("恰好等于上限不截断", () => {
    const exact = "x".repeat(THINKING_TEXT_MAX);
    expect(appendThinkingText(exact, "")).toBe(exact);
    expect(appendThinkingText("x".repeat(THINKING_TEXT_MAX - 1), "x")).toBe(exact);
  });

  it("一次性超大 chunk 也只留尾部", () => {
    const text = appendThinkingText("", `头${"x".repeat(THINKING_TEXT_MAX)}尾`);
    expect(text.length).toBe(THINKING_TEXT_MAX);
    expect(text.endsWith("尾")).toBe(true);
    expect(text).not.toContain("头");
  });

  it("切点落在 emoji（代理对）中间时丢掉孤立的低代理项，不显示成 �", () => {
    // 😀 = 高代理 + 低代理共 2 个 code unit；总长 MAX+1 → 切掉第一个（高代理）后开头是孤立低代理
    const text = appendThinkingText(`😀${"a".repeat(THINKING_TEXT_MAX - 1)}`, "");
    expect(text).toBe("a".repeat(THINKING_TEXT_MAX - 1));
    expect(text).not.toMatch(/[\udc00-\udfff]/);
  });
});

describe("advanceLiveThinking：累积一帧（chat-view 的 pushThinkingDelta 只是它外面套一层 state）", () => {
  it("本段首帧（没有上一态）：id / 原文 / 累计数 / 起点时刻都来自这一帧", () => {
    expect(advanceLiveThinking(null, "e1", "先看", 1000)).toEqual({
      id: "e1",
      text: "先看",
      total: 2,
      since: 1000,
    });
  });

  it("同一段（id 相同）：原文拼接、累计数累加、起点不变（合成事件的 ts 与状态行计时不能随帧漂移）", () => {
    const a = advanceLiveThinking(null, "e1", "先看", 1000);
    const b = advanceLiveThinking(a, "e1", "数据", 1250);
    const c = advanceLiveThinking(b, "e1", "再说", 1500);
    expect(c).toEqual({ id: "e1", text: "先看数据再说", total: 6, since: 1000 });
  });

  it("id 变了 = 新的一段：上一段没来得及清掉的文本不能接在前面；累计数与起点都从头算", () => {
    const old = advanceLiveThinking(null, "e1", "上一段的内容", 1000);
    const next = advanceLiveThinking(old, "e2", "新", 5000);
    expect(next).toEqual({ id: "e2", text: "新", total: 1, since: 5000 });
  });

  it("不改入参", () => {
    const prev: LiveThinking = { id: "e1", text: "ab", total: 2, since: 1 };
    const snapshot = JSON.stringify(prev);
    advanceLiveThinking(prev, "e1", "cd", 2);
    expect(JSON.stringify(prev)).toBe(snapshot);
  });

  it("累计数不受截尾影响：超过上限后 text 只留尾部，total 仍是真实收到的总字数", () => {
    let live: LiveThinking | null = null;
    let full = "";
    for (let i = 0; i < 5000; i++) {
      const chunk = `token${i} `;
      full += chunk;
      live = advanceLiveThinking(live, "e1", chunk, 1000 + i);
    }
    expect(full.length).toBeGreaterThan(THINKING_TEXT_MAX);
    expect(live!.text.length).toBeLessThanOrEqual(THINKING_TEXT_MAX);
    expect(liveThinkingTotal(live!)).toBe(full.length);
  });

  it("坐标精确：text[i] 的累计坐标 = offset + i，即 full.slice(offset) 恰好等于 text（吐字位置靠它换算窗口内下标）", () => {
    let live: LiveThinking | null = null;
    let full = "";
    for (let i = 0; i < 5000; i++) {
      const chunk = `token${i} `;
      full += chunk;
      live = advanceLiveThinking(live, "e1", chunk, 1000);
    }
    const offset = liveThinkingOffset(live!);
    expect(offset).toBeGreaterThan(0);
    expect(full.slice(offset)).toBe(live!.text);
  });

  it("坐标精确（含 emoji）：截尾多丢一个孤立低代理项时，偏移也把它算进去，full.slice(offset) 仍等于 text", () => {
    // 让截断点恰好落在 😀 的两个代码单元之间：先铺满，再塞一个 😀，再补 a 把它顶到截断点
    let live = advanceLiveThinking(null, "e1", "x".repeat(THINKING_TEXT_MAX - 1), 1);
    live = advanceLiveThinking(live, "e1", "😀", 2);
    live = advanceLiveThinking(live, "e1", "a", 3);
    const full = `${"x".repeat(THINKING_TEXT_MAX - 1)}😀a`;
    expect(live.text).not.toMatch(/^[\udc00-\udfff]/);
    expect(full.slice(liveThinkingOffset(live))).toBe(live.text);
  });

  it("没截过尾：偏移为 0", () => {
    const live = advanceLiveThinking(null, "e1", "没超", 1);
    expect(liveThinkingOffset(live)).toBe(0);
  });
});

describe("liveThinkingTotal / liveThinkingOffset：缺省值", () => {
  it("没有 total（手捏的 / 旧形状）：按 text.length，偏移为 0", () => {
    const live: LiveThinking = { id: "e", text: "abc", since: 1 };
    expect(liveThinkingTotal(live)).toBe(3);
    expect(liveThinkingOffset(live)).toBe(0);
  });

  it("total 为 0 也是有效值，不被当成缺省", () => {
    const live: LiveThinking = { id: "e", text: "", since: 1, total: 0 };
    expect(liveThinkingTotal(live)).toBe(0);
  });
});

describe("revealLiveThinking：把「已显示到哪里」切成给界面的那一份（use-smooth-thinking 渲染期的全部派生逻辑）", () => {
  const mk = (text: string, over: Partial<LiveThinking> = {}): LiveThinking => ({
    id: "e",
    text,
    since: 7,
    ...over,
  });

  it("还没显示任何字：文本为空，id / since 保持，total 退到偏移处", () => {
    expect(revealLiveThinking(mk("abcdef"), 0)).toEqual({
      id: "e",
      since: 7,
      text: "",
      total: 0,
    });
  });

  it("显示到中间：只露前一部分", () => {
    const out = revealLiveThinking(mk("abcdef"), 3);
    expect(out).toEqual({ id: "e", since: 7, text: "abc", total: 3 });
  });

  it("已显示到末尾（或更多）：原对象原样返回——引用稳定，下游 memo 不必重算", () => {
    const live = mk("abcdef");
    expect(revealLiveThinking(live, 6)).toBe(live);
    expect(revealLiveThinking(live, 999)).toBe(live);
  });

  it("窗口被截尾后用累计坐标：偏移 10、已显示到 13 → 露出窗口内的前 3 个字", () => {
    const live = mk("abcdef", { total: 16 }); // 偏移 = 16 - 6 = 10
    const out = revealLiveThinking(live, 13);
    expect(out.text).toBe("abc");
    expect(out.total).toBe(13);
    expect(liveThinkingOffset(out)).toBe(10);
  });

  it("显示位置落在窗口起点前面（头部在没来得及显示时就被截尾丢了）：当作 0", () => {
    const live = mk("abcdef", { total: 16 });
    const out = revealLiveThinking(live, 4);
    expect(out.text).toBe("");
    expect(out.total).toBe(10);
  });

  it("不变量扫描：不论位置落在哪（含负数 / 越界），文本总是原文前缀，偏移不变，total = 偏移 + 长度", () => {
    for (const total of [undefined, 16]) {
      const live = mk("abcdef", total === undefined ? {} : { total });
      const offset = liveThinkingOffset(live);
      for (let revealed = -5; revealed <= 25; revealed++) {
        const out = revealLiveThinking(live, revealed);
        expect(live.text.startsWith(out.text)).toBe(true);
        expect(liveThinkingOffset(out)).toBe(offset);
        expect(liveThinkingTotal(out)).toBe(offset + out.text.length);
        // 位置越靠后露出越多（单调）
        if (revealed > -5) {
          expect(out.text.length).toBeGreaterThanOrEqual(
            revealLiveThinking(live, revealed - 1).text.length,
          );
        }
      }
    }
  });

  it("切点落在 emoji 中间：把低代理项一并带上，不会闪出一帧 �", () => {
    const live = mk("a😀b"); // a(0) 😀(1,2) b(3)
    expect(revealLiveThinking(live, 2).text).toBe("a😀");
    expect(revealLiveThinking(live, 1).text).toBe("a");
    expect(revealLiveThinking(live, 3).text).toBe("a😀");
  });

  it("脏值（NaN / ±Infinity）一律按 0：宁可少显示，也不让 NaN 渗进切片与坐标", () => {
    const live = mk("abcdef");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const out = revealLiveThinking(live, bad);
      expect(out.text).toBe("");
      expect(out.total).toBe(0);
    }
  });

  it("不改入参", () => {
    const live = mk("abcdef", { total: 16 });
    const snapshot = JSON.stringify(live);
    revealLiveThinking(live, 12);
    expect(JSON.stringify(live)).toBe(snapshot);
  });
});

describe("deriveActiveStatus + 思考实时态", () => {
  const user = ev({ id: "u", kind: "user_reply", text: "q", ts: 1 });
  const call = ev({
    id: "c",
    kind: "tool_call",
    text: "调用 shell",
    ts: 2,
    meta: {
      callId: "x",
      name: "shell",
      args: JSON.stringify({ command: "pnpm lint" }),
    },
  });
  const result = ev({
    id: "r",
    kind: "tool_result",
    text: "完成",
    ts: 3,
    meta: { callId: "x", name: "shell", status: "success" },
  });

  it("回车后模型在思考、事件流尾还是 user_reply：「正在启动…」→「思考中」+ 计时起点，不带原文", () => {
    expect(deriveActiveStatus([user])).toEqual({
      label: "正在启动…",
      yieldToTail: true,
    });
    const status = deriveActiveStatus([user], undefined, { thinkingSince: 1234 });
    expect(status).toEqual({ label: THINKING_LIVE_LABEL, sinceTs: 1234 });
    // 原文在组内思考行里展示；状态行再带一遍 = 上下重复
    expect(status).not.toHaveProperty("detail");
    // 思考态有自己的计时，不让位（让位只属于「正在启动…」）
    expect(status).not.toHaveProperty("yieldToTail");
  });

  it("工具跑完后模型在思考：「正在分析 shell 的结果」→「思考中」，计时起点是这段思考开始的时刻、不是工具完成的时刻", () => {
    expect(deriveActiveStatus([user, call, result])).toEqual({
      label: "正在分析 shell 的结果",
      sinceTs: 3,
    });
    const live = deriveActiveStatus([user, call, result], undefined, {
      thinkingSince: 500,
    });
    expect(live).toEqual({ label: THINKING_LIVE_LABEL, sinceTs: 500 });
  });

  it("空等类文案不论措辞都会被实时思考盖掉：说不清上一个工具时的兜底「处理中…」同样如此", () => {
    // 并行工具：read 回来了、grep 还没回——文案退回「处理中…」（见 chat-turns 的 hasUnpairedToolCall）
    const callA = ev({
      id: "ca",
      kind: "tool_call",
      text: "调用 read",
      ts: 2,
      meta: { callId: "a", name: "read", args: "{}" },
    });
    const callB = ev({
      id: "cb",
      kind: "tool_call",
      text: "调用 grep",
      ts: 3,
      meta: { callId: "b", name: "grep", args: "{}" },
    });
    const resultA = ev({
      id: "ra",
      kind: "tool_result",
      text: "完成",
      ts: 4,
      meta: { callId: "a", name: "read", status: "success" },
    });
    const events = [user, callA, callB, resultA];
    expect(deriveActiveStatus(events)).toEqual({
      label: PROCESSING_PLACEHOLDER_LABEL,
      sinceTs: 4,
    });
    expect(deriveActiveStatus(events, undefined, { thinkingSince: 900 })).toEqual({
      label: THINKING_LIVE_LABEL,
      sinceTs: 900,
    });
  });

  it("插话之后又进入新一段思考：「正在回复…」→「思考中」", () => {
    const aside = ev({ id: "a", kind: "assistant_message", text: "我先看看", ts: 2 });
    expect(deriveActiveStatus([user, aside])).toEqual({ label: "正在回复…" });
    expect(deriveActiveStatus([user, aside], undefined, { thinkingSince: 700 })).toEqual({
      label: THINKING_LIVE_LABEL,
      sinceTs: 700,
    });
  });

  it("起点是脏值（NaN / Infinity）：退化成不带计时的「思考中」，不让走字显示 NaNs", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const status = deriveActiveStatus([user], undefined, { thinkingSince: bad });
      expect(status).toEqual({ label: THINKING_LIVE_LABEL });
      expect(status).not.toHaveProperty("sinceTs");
    }
  });

  it("起点是 0 也是有效的实时态（不能被当成「没在思考」）", () => {
    expect(deriveActiveStatus([user], undefined, { thinkingSince: 0 })).toEqual({
      label: THINKING_LIVE_LABEL,
      sinceTs: 0,
    });
  });

  it("没在思考（undefined / null）：行为与原来完全一致", () => {
    const base = deriveActiveStatus([user, call, result]);
    expect(deriveActiveStatus([user, call, result], undefined, {})).toEqual(base);
    expect(
      deriveActiveStatus([user, call, result], undefined, { thinkingSince: null }),
    ).toEqual(base);
    expect(
      deriveActiveStatus([user, call, result], undefined, { thinkingSince: undefined }),
    ).toEqual(base);
  });

  it("不盖更具体的信息：工具正在跑 → 仍是「正在执行 shell」", () => {
    const status = deriveActiveStatus([user, call], undefined, { thinkingSince: 800 });
    expect(status?.label).toBe("正在执行 shell");
  });

  it("不盖更具体的信息：压缩进行中 → 仍是压缩文案", () => {
    const compaction = ev({
      id: "k",
      kind: "info",
      text: COMPACTION_RUNNING_LABEL,
      ts: 2,
      meta: compactionEventMeta({ start: true }),
    });
    const status = deriveActiveStatus([user, compaction], undefined, {
      thinkingSince: 800,
    });
    expect(status?.label).toBe(COMPACTION_RUNNING_LABEL);
  });

  it("正文已经在流（streaming）：是在回复、不是在思考——兜住实时帧晚到的竞态", () => {
    const aside = ev({ id: "a", kind: "assistant_message", text: "答", ts: 2 });
    const status = deriveActiveStatus([user, aside], undefined, {
      streaming: true,
      thinkingSince: 800,
    });
    expect(status).toEqual({ label: "正在回复…" });
  });

  it("空事件流 → null（没有任何可说的）", () => {
    expect(deriveActiveStatus([], undefined, { thinkingSince: 800 })).toBeNull();
  });

  it("已落盘的 thinking（这一段刚结束、下一个事件还没来）：「思考中」且不带原文——原文就在组内思考行里", () => {
    const done = ev({
      id: "t",
      kind: "thinking",
      text: "第一行\n第二行很长的思考内容",
      ts: 2,
    });
    const status = deriveActiveStatus([user, done]);
    expect(status).toEqual({ label: "思考中" });
    expect(status).not.toHaveProperty("detail");
  });

  it("已落盘的 thinking 之后紧接着又开始新一段实时思考：被盖成带计时的「思考中」（它是空等类）", () => {
    const done = ev({ id: "t", kind: "thinking", text: "上一段", ts: 2 });
    expect(deriveActiveStatus([user, done], undefined, { thinkingSince: 600 })).toEqual({
      label: THINKING_LIVE_LABEL,
      sinceTs: 600,
    });
  });
});

describe("正文已经在流时，状态行不能说别的（assistant_message 要整段说完才落盘，期间事件尾部是别的东西）", () => {
  const user = ev({ id: "u", kind: "user_reply", text: "q", ts: 1 });
  const thought = ev({ id: "t", kind: "thinking", text: "想好了", ts: 2 });

  it("事件尾是 user_reply（AI 一上来就直接写正文，没有思考）：正在回复，不是「正在启动…」", () => {
    // 修之前：屏上正文一个字一个字在出，输入框上方写着「正在启动…」
    expect(deriveActiveStatus([user], undefined, { streaming: true })).toEqual({
      label: "正在回复…",
    });
    // 对照：没在流就还是「正在启动…」
    expect(deriveActiveStatus([user])?.label).toBe("正在启动…");
  });

  it("事件尾是已落盘的 thinking（最常见：先想、再写）：正在回复，不是「思考中」", () => {
    // 修之前：整个正文流式期间，状态行都挂着「思考中 · 某段思考的最后一行」
    expect(deriveActiveStatus([user, thought], undefined, { streaming: true })).toEqual({
      label: "正在回复…",
    });
    expect(deriveActiveStatus([user, thought])?.label).toBe("思考中");
  });

  it("流式时的「正在回复…」不带让位标记（它的信息流里已经有正文在出、状态行是唯一一句话，但不是「启动」）", () => {
    expect(
      deriveActiveStatus([user], undefined, { streaming: true }),
    ).not.toHaveProperty("yieldToTail");
  });
});

describe("yieldToTail 让位标记：只属于「正在启动…」", () => {
  const user = ev({ id: "u", kind: "user_reply", text: "q", ts: 1 });
  const call = ev({
    id: "c",
    kind: "tool_call",
    text: "调用 shell",
    ts: 2,
    meta: { callId: "x", name: "shell", args: "{}" },
  });
  const result = ev({
    id: "r",
    kind: "tool_result",
    text: "完成",
    ts: 3,
    meta: { callId: "x", name: "shell", status: "success" },
  });

  it("刚发出、等启动：带标记", () => {
    expect(deriveActiveStatus([user])?.yieldToTail).toBe(true);
  });

  it.each([
    ["工具在跑", [user, call]],
    ["工具跑完等模型", [user, call, result]],
    ["已落盘的思考", [user, ev({ id: "t", kind: "thinking", text: "x", ts: 2 })]],
    ["AI 插话之后", [user, ev({ id: "a", kind: "assistant_message", text: "x", ts: 2 })]],
  ])("%s：不带标记（流里没有别的行替它说话，状态行必须画）", (_name, events) => {
    expect(deriveActiveStatus(events)).not.toHaveProperty("yieldToTail");
  });
});
