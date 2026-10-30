import { describe, expect, it } from "vitest";

import {
  EMPTY_REPLY_MESSAGE,
  assistantMessageHasOutput,
  readAssistantError,
  settleErrorFromTranscript,
  stickyErrorAfterMessageEnd,
} from "@/lib/pi-run-settle";

const assistant = (
  stopReason: string,
  errorMessage?: string,
): Record<string, unknown> => ({
  role: "assistant",
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
});

describe("pi-run-settle", () => {
  it("单条 503 assistant 仍算失败", () => {
    const msg = assistant("error", "Endpoint is unavailable");
    expect(readAssistantError(msg)).toBe("Endpoint is unavailable");
    expect(settleErrorFromTranscript([msg], null)).toBe(
      "Endpoint is unavailable",
    );
  });

  it("中途 503 后最后一条是 stop / toolUse → 不当失败", () => {
    const messages = [
      assistant("toolUse"),
      assistant("error", "Endpoint is unavailable"),
      assistant("toolUse"),
      assistant("stop"),
    ];
    expect(settleErrorFromTranscript(messages, "Endpoint is unavailable")).toBeNull();
  });

  it("最后一条仍是 error → 失败（重试耗尽）", () => {
    const messages = [
      assistant("toolUse"),
      assistant("error", "Endpoint is unavailable"),
    ];
    expect(settleErrorFromTranscript(messages, null)).toBe(
      "Endpoint is unavailable",
    );
  });

  it("没有 assistant 时才用粘性错误", () => {
    expect(
      settleErrorFromTranscript([{ role: "user" }], "fetch failed"),
    ).toBe("fetch failed");
    expect(settleErrorFromTranscript([], "  ")).toBeNull();
  });

  it("message_end 成功会清掉粘性 503", () => {
    const afterFail = stickyErrorAfterMessageEnd(
      null,
      assistant("error", "Endpoint is unavailable"),
    );
    expect(afterFail).toBe("Endpoint is unavailable");
    expect(
      stickyErrorAfterMessageEnd(afterFail, assistant("stop")),
    ).toBeNull();
    expect(
      stickyErrorAfterMessageEnd(afterFail, assistant("toolUse")),
    ).toBeNull();
  });

  it("缺 finish_reason 不当失败", () => {
    expect(
      readAssistantError(
        assistant("error", "Stream ended without finish_reason"),
      ),
    ).toBeNull();
  });
});

describe("assistantMessageHasOutput：一条 assistant 消息有没有用户看得见的产出（R14 Q11-01）", () => {
  const msg = (content: unknown, role = "assistant") => ({ role, content });
  const text = (t: string) => ({ type: "text", text: t });
  const thinking = (t: string) => ({ type: "thinking", thinking: t });
  const toolCall = { type: "toolCall", id: "c1", name: "read", arguments: {} };

  it("有非空白正文 → true", () => {
    expect(assistantMessageHasOutput(msg([text("你好")]))).toBe(true);
    expect(assistantMessageHasOutput(msg([text("\n 好 \n")]))).toBe(true);
  });

  it("有工具调用 → true（哪怕一个字都没说）", () => {
    expect(assistantMessageHasOutput(msg([toolCall]))).toBe(true);
  });

  it("只有思考 → false（思考不算产出：用户这边仍是空回复）", () => {
    expect(assistantMessageHasOutput(msg([thinking("想了很久")]))).toBe(false);
  });

  it("空数组 / 空白正文 / 空文本块 → false", () => {
    expect(assistantMessageHasOutput(msg([]))).toBe(false);
    expect(assistantMessageHasOutput(msg([text("")]))).toBe(false);
    expect(assistantMessageHasOutput(msg([text(" \n\t ")]))).toBe(false);
  });

  it("混合：思考 + 空白正文 → false；再加一个工具调用 → true", () => {
    expect(assistantMessageHasOutput(msg([thinking("嗯"), text("  ")]))).toBe(false);
    expect(assistantMessageHasOutput(msg([thinking("嗯"), text("  "), toolCall]))).toBe(true);
  });

  it("content 是字符串（个别消息形态）：非空白 → true，空白 → false", () => {
    expect(assistantMessageHasOutput(msg("直接是字符串"))).toBe(true);
    expect(assistantMessageHasOutput(msg("  \n "))).toBe(false);
  });

  it("不是 assistant（user / toolResult / null / 非对象）→ false，哪怕带着文本", () => {
    expect(assistantMessageHasOutput(msg([text("用户说的")], "user"))).toBe(false);
    expect(assistantMessageHasOutput(msg([text("工具回包")], "toolResult"))).toBe(false);
    expect(assistantMessageHasOutput(null)).toBe(false);
    expect(assistantMessageHasOutput(undefined)).toBe(false);
    expect(assistantMessageHasOutput("文本")).toBe(false);
  });

  it("content 缺失 / 不是数组也不是字符串 / 块里有脏数据 → false，不抛", () => {
    expect(assistantMessageHasOutput({ role: "assistant" })).toBe(false);
    expect(assistantMessageHasOutput(msg(42))).toBe(false);
    expect(assistantMessageHasOutput(msg([null, 1, "x", {}, { type: "text" }, { type: "text", text: 7 }]))).toBe(false);
  });

  it("EMPTY_REPLY_MESSAGE：非空、以关键句开头（runner 只留前 200 字符，错误卡按这句认）", () => {
    expect(EMPTY_REPLY_MESSAGE.startsWith("模型没有返回任何内容")).toBe(true);
  });
});
