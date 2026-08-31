/**
 * chat 新会话接续历史切片
 */
import { describe, expect, it } from "vitest";

import {
  formatChatHistorySection,
  HISTORY_INJECT_MAX_CHARS,
  HISTORY_INJECT_MAX_TURNS,
  selectChatHistoryTurns,
} from "@/lib/chat-history-inject";

const ev = (
  kind: string,
  text: string,
  id?: string,
): { id?: string; kind: string; text?: string } => ({
  id,
  kind,
  text,
});

describe("selectChatHistoryTurns", () => {
  it("真正第一句：去掉当前 user_reply 后为空", () => {
    const got = selectChatHistoryTurns(
      [ev("user_reply", "你好", "ev_now")],
      { skipEventId: "ev_now" },
    );
    expect(got.turns).toEqual([]);
    expect(got.truncated).toBe(false);
  });

  it("跳过 thinking / 工具，只留用户和助手正文", () => {
    const got = selectChatHistoryTurns([
      ev("user_reply", "域名是什么"),
      ev("thinking", "想一下"),
      ev("tool_call", "grep"),
      ev("assistant_message", "是 wukongedu.net"),
      ev("user_reply", "你是 qwen 吗", "ev_now"),
    ], { skipEventId: "ev_now" });
    expect(got.turns).toEqual([
      { kind: "user_reply", text: "域名是什么" },
      { kind: "assistant_message", text: "是 wukongedu.net" },
    ]);
    expect(got.truncated).toBe(false);
  });

  it("没有 skipEventId 时按正文去掉末条重复的当前句", () => {
    const got = selectChatHistoryTurns(
      [
        ev("user_reply", "昨天的结论"),
        ev("assistant_message", "线上都是新域"),
        ev("user_reply", "你是 qwen 吗"),
      ],
      { skipUserText: "你是 qwen 吗" },
    );
    expect(got.turns.map((t) => t.text)).toEqual(["昨天的结论", "线上都是新域"]);
  });

  it("超过轮数上限时留最近 N 轮并 truncated", () => {
    const events = Array.from({ length: HISTORY_INJECT_MAX_TURNS + 4 }, (_, i) =>
      ev(i % 2 === 0 ? "user_reply" : "assistant_message", `t${i}`),
    );
    const got = selectChatHistoryTurns(events);
    expect(got.turns).toHaveLength(HISTORY_INJECT_MAX_TURNS);
    expect(got.turns[0].text).toBe("t4");
    expect(got.truncated).toBe(true);
  });

  it("超字符上限时从最老的丢掉", () => {
    const bulky = "x".repeat(HISTORY_INJECT_MAX_CHARS - 2);
    const got = selectChatHistoryTurns([
      ev("user_reply", bulky),
      ev("assistant_message", bulky),
      ev("user_reply", "最近一句"),
    ]);
    expect(got.turns.map((t) => t.text)).toEqual(["最近一句"]);
    expect(got.truncated).toBe(true);
  });
});

describe("formatChatHistorySection", () => {
  it("空切片不输出", () => {
    expect(formatChatHistorySection({ turns: [], truncated: false })).toEqual([]);
  });

  it("接续段标明不是新开，并带用户/你标题", () => {
    const lines = formatChatHistorySection({
      turns: [
        { kind: "user_reply", text: "域名？" },
        { kind: "assistant_message", text: "wukongedu.net" },
      ],
      truncated: false,
    });
    const text = lines.join("\n");
    expect(text).toContain("本窗口已有对话（接续，不是新开）");
    expect(text).toContain("### 用户");
    expect(text).toContain("域名？");
    expect(text).toContain("### 你");
    expect(text).toContain("wukongedu.net");
    expect(text).not.toContain("更早的对话已省略");
  });

  it("truncated 时提示去读事件日志", () => {
    const text = formatChatHistorySection({
      turns: [{ kind: "user_reply", text: "hi" }],
      truncated: true,
    }).join("\n");
    expect(text).toContain("更早的对话已省略");
  });
});
