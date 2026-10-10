/**
 * 客户端分发：SSE thinking_delta 帧 → onThinkingDelta(text, eventId)
 *
 * 帧里带 eventId（这段思考落盘后那条 thinking 事件的 id）：前端用它给合成的「进行中的思考行」
 * 当 React key——和落盘行同一个 id，落盘那一刻是同一个节点。所以**没有 id 的帧必须丢弃**：
 * 留着它会让合成行拿到 undefined / 空串当 key（多段思考互相冲突、也永远对不上落盘行）。
 *
 * 用真实的 watchTaskStream + stub 掉的 fetch（帧格式与 watch-task route 一致）。
 * 跟 restricted-run-signal.test.ts 的「客户端分发」同一套做法。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { watchTaskStream } from "@/lib/task-store";

/** 拼一段 SSE 响应体 */
const sseResponse = (payloads: unknown[]): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
};

const watchWith = async (
  payloads: unknown[],
): Promise<Array<{ text: string; eventId: string }>> => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      sseResponse([{ type: "task", task: { id: "t1", events: [] } }, ...payloads]),
    ),
  );
  const got: Array<{ text: string; eventId: string }> = [];
  await watchTaskStream("t1", {
    onThinkingDelta: (text, eventId) => got.push({ text, eventId }),
  });
  return got;
};

describe("SSE thinking_delta → onThinkingDelta(text, eventId)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("带 eventId 的帧：增量文本和 id 一起转发，同一段的多帧 id 相同", async () => {
    const got = await watchWith([
      { type: "thinking_delta", text: "先看", eventId: "e_1" },
      { type: "thinking_delta", text: "数据", eventId: "e_1" },
      { type: "thinking_delta", text: "下一段", eventId: "e_2" },
    ]);

    expect(got).toEqual([
      { text: "先看", eventId: "e_1" },
      { text: "数据", eventId: "e_1" },
      { text: "下一段", eventId: "e_2" },
    ]);
  });

  it("没有 eventId / eventId 为空串或非字符串的帧一律丢弃（没 id 就对不上落盘行、还会让 React key 冲突）", async () => {
    const got = await watchWith([
      { type: "thinking_delta", text: "缺 id" },
      { type: "thinking_delta", text: "空 id", eventId: "" },
      { type: "thinking_delta", text: "数字 id", eventId: 42 },
      { type: "thinking_delta", text: "null id", eventId: null },
      { type: "thinking_delta", text: "合法", eventId: "e_ok" },
    ]);

    expect(got).toEqual([{ text: "合法", eventId: "e_ok" }]);
  });

  it("缺 text 的帧也丢弃（既有口径：别把 undefined 当成一段空思考）", async () => {
    const got = await watchWith([
      { type: "thinking_delta", eventId: "e_1" },
      { type: "thinking_delta", text: 123, eventId: "e_1" },
    ]);

    expect(got).toEqual([]);
  });
});
