/**
 * 思考实时态（thinking_delta）的前端纯函数：最近一行提取 + 状态行推导。
 *
 * 背景（2026-10-10 实测）：一段 65s 的思考，服务端第 6s 就收到首个增量，但整段攒到结束
 * 才落一条 thinking 事件——界面这 70s 一直写「等待模型响应… 已等待 62s」。
 * 这里钉死两件事：① 实时帧能拼出「最近一行」；② 状态行在思考进行中说「思考中」而不是
 * 「正在启动… / 处理中…」，但不盖掉更具体的信息（工具在跑 / 压缩中 / 正文在流）。
 */
import { describe, expect, it } from "vitest";

import { deriveActiveStatus, PROCESSING_PLACEHOLDER_LABEL } from "../src/lib/chat-turns";
import {
  COMPACTION_RUNNING_LABEL,
  compactionEventMeta,
} from "../src/lib/compaction-display";
import {
  appendThinkingText,
  THINKING_LINE_MAX,
  THINKING_LIVE_LABEL,
  THINKING_TAIL_MAX,
  THINKING_TEXT_MAX,
  thinkingTailToLine,
  thinkingTextToLine,
} from "../src/lib/thinking-live";
import type { TaskEvent } from "../src/lib/types";

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind" | "text">,
): TaskEvent => ({ ts: 1, ...partial });

describe("thinkingTailToLine", () => {
  it("空 / 全空白 → 空串（调用方据此只显示「思考中」、不带细节）", () => {
    expect(thinkingTailToLine("")).toBe("");
    expect(thinkingTailToLine("  \n\t \n")).toBe("");
  });

  it("取最后一个非空行（忽略尾部空行）", () => {
    expect(thinkingTailToLine("第一行\n第二行\n\n  \n")).toBe("第二行");
  });

  it("压掉行内连续空白", () => {
    expect(thinkingTailToLine("a   b\t\tc")).toBe("a b c");
  });

  it("超长取行尾（不是行首）并加前缀省略号——长段落期间才看得出「在往下写」", () => {
    const long = `${"a".repeat(100)}END`;
    const line = thinkingTailToLine(long);
    expect(line).toBe(`…${long.slice(-THINKING_LINE_MAX)}`);
    expect(line.endsWith("END")).toBe(true);
    expect(line.startsWith("…")).toBe(true);
  });

  it("恰好等于上限不截断、不加省略号", () => {
    const exact = "x".repeat(THINKING_LINE_MAX);
    expect(thinkingTailToLine(exact)).toBe(exact);
  });

  it("切点落在 emoji（代理对）中间时丢掉孤立的低代理项，不显示成 �", () => {
    // "x😀yz" = x, \ud83d, \ude00, y, z（5 个 code unit）；max=3 → 从 \ude00 起切
    const line = thinkingTailToLine("x😀yz", 3);
    expect(line).toBe("…yz");
    expect(line).not.toMatch(/[\udc00-\udfff]/);
  });
});

describe("appendThinkingText", () => {
  it("未超上限原样拼接；一行被切成两个 chunk 也能拼回来", () => {
    let text = appendThinkingText("", "正在分析性能");
    text = appendThinkingText(text, "数据，看看哪一段慢");
    expect(text).toBe("正在分析性能数据，看看哪一段慢");
    expect(thinkingTextToLine(text)).toBe("正在分析性能数据，看看哪一段慢");
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

describe("thinkingTextToLine（从整段累积原文派生「最近一行」）", () => {
  it("短文本：与 thinkingTailToLine 一致", () => {
    const t = "第一行\n第二行";
    expect(thinkingTextToLine(t)).toBe(thinkingTailToLine(t));
    expect(thinkingTextToLine(t)).toBe("第二行");
  });

  it("上万字的长文本：依旧取到最新一行，不被截尾影响", () => {
    let text = "";
    for (let i = 0; i < 3000; i++) text += `第 ${i} 步：检查数据\n`;
    expect(text.length).toBeGreaterThan(THINKING_TAIL_MAX * 10);
    expect(thinkingTextToLine(text)).toBe("第 2999 步：检查数据");
  });

  it("最后一行比尾部窗口还长：取行尾 THINKING_LINE_MAX 字并加省略号", () => {
    const text = `开头\n${"a".repeat(THINKING_TAIL_MAX * 2)}END`;
    const line = thinkingTextToLine(text);
    expect(line.startsWith("…")).toBe(true);
    expect(line.endsWith("END")).toBe(true);
    expect(line.length).toBe(THINKING_LINE_MAX + 1);
  });

  it("空 / 全空白 → 空串", () => {
    expect(thinkingTextToLine("")).toBe("");
    expect(thinkingTextToLine("\n\n  \n")).toBe("");
  });

  it("已知且无害的例外：末尾连续 THINKING_TAIL_MAX 个字符全是空白时窗口里没有非空行 → 空串", () => {
    // 等同「在思考、暂无可展示的行」，状态行只说「思考中」；真实思考末尾不会有这么长的空白
    expect(thinkingTextToLine(`有内容\n${" ".repeat(THINKING_TAIL_MAX + 10)}`)).toBe("");
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

  it("回车后模型在思考、事件流尾还是 user_reply：「正在启动…」→「思考中」+ 最近一行", () => {
    expect(deriveActiveStatus([user])).toEqual({ label: "正在启动…" });
    expect(deriveActiveStatus([user], undefined, { thinking: "先看数据" })).toEqual({
      label: THINKING_LIVE_LABEL,
      detail: "先看数据",
    });
  });

  it("工具跑完后模型在思考：「处理中…」→「思考中」", () => {
    expect(deriveActiveStatus([user, call, result])).toEqual({
      label: PROCESSING_PLACEHOLDER_LABEL,
    });
    expect(
      deriveActiveStatus([user, call, result], undefined, { thinking: "再读一个文件" }),
    ).toEqual({ label: THINKING_LIVE_LABEL, detail: "再读一个文件" });
  });

  it("插话之后又进入新一段思考：「正在回复…」→「思考中」", () => {
    const aside = ev({ id: "a", kind: "assistant_message", text: "我先看看", ts: 2 });
    expect(deriveActiveStatus([user, aside])).toEqual({ label: "正在回复…" });
    expect(deriveActiveStatus([user, aside], undefined, { thinking: "接着想" })).toEqual({
      label: THINKING_LIVE_LABEL,
      detail: "接着想",
    });
  });

  it("在思考但还没有可展示的行（空串）：只说「思考中」、不带 detail", () => {
    const status = deriveActiveStatus([user], undefined, { thinking: "" });
    expect(status).toEqual({ label: THINKING_LIVE_LABEL });
    expect(status).not.toHaveProperty("detail");
  });

  it("没在思考（undefined / null）：行为与原来完全一致", () => {
    const base = deriveActiveStatus([user, call, result]);
    expect(deriveActiveStatus([user, call, result], undefined, {})).toEqual(base);
    expect(
      deriveActiveStatus([user, call, result], undefined, { thinking: null }),
    ).toEqual(base);
    expect(
      deriveActiveStatus([user, call, result], undefined, { thinking: undefined }),
    ).toEqual(base);
  });

  it("不盖更具体的信息：工具正在跑 → 仍是「正在执行 shell」", () => {
    const status = deriveActiveStatus([user, call], undefined, { thinking: "想点别的" });
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
      thinking: "想点别的",
    });
    expect(status?.label).toBe(COMPACTION_RUNNING_LABEL);
  });

  it("正文已经在流（streaming）：是在回复、不是在思考——兜住实时帧晚到的竞态", () => {
    const aside = ev({ id: "a", kind: "assistant_message", text: "答", ts: 2 });
    const status = deriveActiveStatus([user, aside], undefined, {
      streaming: true,
      thinking: "残留",
    });
    expect(status).toEqual({ label: "正在回复…" });
  });

  it("空事件流 → null（没有任何可说的）", () => {
    expect(deriveActiveStatus([], undefined, { thinking: "x" })).toBeNull();
  });

  it("已落盘的 thinking 事件仍按原逻辑给「思考中」（行首摘要），不被实时态改写", () => {
    const done = ev({
      id: "t",
      kind: "thinking",
      text: "第一行\n第二行很长的思考内容",
      ts: 2,
    });
    expect(deriveActiveStatus([user, done])).toEqual({
      label: "思考中",
      detail: "第二行很长的思考内容",
    });
    // 同时有实时帧：落盘 thinking 已是「思考中」，不属于被覆盖的空等文案
    expect(deriveActiveStatus([user, done], undefined, { thinking: "新的一行" })).toEqual({
      label: "思考中",
      detail: "第二行很长的思考内容",
    });
  });
});
