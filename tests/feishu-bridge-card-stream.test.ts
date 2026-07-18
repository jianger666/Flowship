/**
 * card-stream：节流 / sequence 递增 / 前缀不回改 / 超长截断 / finalize
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-stream-${Date.now()}`);
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP, "data");

const {
  updateCardElementContent,
  updateCardEntity,
  patchCardSettings,
  createCardEntity,
  sendCardMessage,
  batchUpdateCard,
  getBotAppInfo,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    updateCardElementContent: vi.fn<AnyFn>(async () => undefined),
    updateCardEntity: vi.fn<AnyFn>(async () => undefined),
    patchCardSettings: vi.fn<AnyFn>(async () => undefined),
    createCardEntity: vi.fn<AnyFn>(async () => ({ card_id: "card_test" })),
    sendCardMessage: vi.fn<AnyFn>(async () => ({
      chat_id: "oc_test",
      message_id: "om_test",
    })),
    batchUpdateCard: vi.fn<AnyFn>(async () => undefined),
    getBotAppInfo: vi.fn<AnyFn>(async () => ({
      appId: "cli_test",
      ownerOpenId: "ou_test",
    })),
  };
});

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({
  updateCardElementContent,
  updateCardEntity,
  patchCardSettings,
  createCardEntity,
  sendCardMessage,
  batchUpdateCard,
  getBotAppInfo,
}));

const {
  applyPrefixGuard,
  closeUnclosedCodeFence,
  truncateForCard,
  createCardStream,
  __setCardStreamTimersForTest,
} = await import("@/lib/server/feishu-bridge/card-stream");

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  updateCardElementContent.mockClear();
  updateCardEntity.mockClear();
  patchCardSettings.mockClear();
  createCardEntity.mockClear();
  sendCardMessage.mockClear();
  batchUpdateCard.mockClear();
  createCardEntity.mockResolvedValue({ card_id: "card_test" });
  __setCardStreamTimersForTest((cb) => {
    cb();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

afterEach(() => {
  __setCardStreamTimersForTest(null);
});

describe("prefix / truncate helpers", () => {
  it("前缀守卫：不回缩短文本", () => {
    expect(applyPrefixGuard("abc", "abcd")).toBe("abcd");
    expect(applyPrefixGuard("abcd", "ab")).toBe("abcd");
    expect(applyPrefixGuard("", "x")).toBe("x");
  });

  it("超长截断带提示", () => {
    const long = "字".repeat(100_000);
    const out = truncateForCard(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith("内容过长，完整回复在 app 内查看")).toBe(true);
  });
});

describe("createCardStream", () => {
  it("start 建卡并发消息，sequence 在 push 中严格递增", async () => {
    const pending: Array<() => void> = [];
    __setCardStreamTimersForTest((cb) => {
      pending.push(cb);
      return pending.length as unknown as ReturnType<typeof setTimeout>;
    });

    const stream = createCardStream("task_1", {
      title: "测",
      openId: "ou_x",
    });
    await stream.start({ echoText: "hello" });
    expect(createCardEntity).toHaveBeenCalledOnce();
    expect(sendCardMessage).toHaveBeenCalledWith("ou_x", "card_test");
    expect(stream.getIds()).toEqual({
      messageId: "om_test",
      cardId: "card_test",
    });

    stream.pushAnswer("A");
    stream.pushAnswer("AB");
    stream.pushAnswer("ABC");
    while (pending.length) pending.shift()!();
    await vi.waitFor(() => expect(updateCardElementContent).toHaveBeenCalled());

    const calls = updateCardElementContent.mock.calls as unknown as Array<
      [string, string, string, number]
    >;
    const seqs = calls.map((c) => c[3]);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
    expect(calls.at(-1)?.[2]).toBe("ABC");
  });

  it("push 缩短文本不会回改已推前缀", async () => {
    const stream = createCardStream("task_2", { title: "t", openId: "ou" });
    await stream.start();
    stream.pushAnswer("hello world");
    await vi.waitFor(() =>
      expect(updateCardElementContent).toHaveBeenCalled(),
    );
    updateCardElementContent.mockClear();
    stream.pushAnswer("hello");
    await new Promise((r) => setTimeout(r, 5));
    expect(updateCardElementContent).not.toHaveBeenCalled();
  });

  it("攒够 600 字符先于 timer flush", async () => {
    const pending: Array<() => void> = [];
    __setCardStreamTimersForTest((cb) => {
      pending.push(cb);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const stream = createCardStream("task_3", { title: "t", openId: "ou" });
    await stream.start();
    stream.pushAnswer("x".repeat(600));
    await vi.waitFor(() =>
      expect(updateCardElementContent).toHaveBeenCalled(),
    );
    expect(pending.length).toBe(0);
  });

  it("finalize：刷余量 + 关 streaming + header/footer", async () => {
    process.env.FE_AI_FLOW_TEST = "1";
    const stream = createCardStream("task_fin", { title: "聊", openId: "ou" });
    await stream.start();
    stream.pushAnswer("最终回复");
    await vi.waitFor(() =>
      expect(updateCardElementContent).toHaveBeenCalled(),
    );
    await stream.finalize({
      ok: true,
      durationMs: 125000,
      model: "composer",
    });
    expect(updateCardEntity).toHaveBeenCalled();
    const entityCalls = updateCardEntity.mock.calls as unknown as Array<
      [string, {
        header: { subtitle: { content: string }; template: string };
        body: { elements: Array<{ element_id?: string; content?: string }> };
      }, number]
    >;
    const cardJson = entityCalls.at(-1)![1];
    expect(cardJson.header.subtitle.content).toBe("✅ 完成");
    expect(cardJson.header.template).toBe("green");
    const footer = cardJson.body.elements.find((e) => e.element_id === "md_footer");
    expect(footer?.content).toContain("flowship-test://tasks/task_fin");
    expect(footer?.content).toContain("composer");
    expect(patchCardSettings).toHaveBeenCalled();
    const settingsCalls = patchCardSettings.mock.calls as unknown as Array<
      [string, { config: { streaming_mode: boolean } }, number]
    >;
    expect(settingsCalls[0]![1].config.streaming_mode).toBe(false);
    delete process.env.FE_AI_FLOW_TEST;
  });

  it("lark 失败静默降级、failCount 递增", async () => {
    createCardEntity.mockRejectedValueOnce(new Error("boom"));
    const stream = createCardStream("task_fail", { title: "t", openId: "ou" });
    await stream.start();
    expect(stream.getFailCount()).toBeGreaterThanOrEqual(1);
    expect(stream.getIds().cardId).toBeUndefined();
    stream.pushAnswer("x");
    expect(updateCardElementContent).not.toHaveBeenCalled();
  });

  // review P1#5：多题不渲染按钮
  it("appendAskUser 单题渲染按钮、多题仅 markdown + 文字作答提示", async () => {
    const stream = createCardStream("task_ask", { title: "t", openId: "ou" });
    await stream.start();
    batchUpdateCard.mockClear();

    await stream.appendAskUser({
      askId: "ask_single",
      questions: [
        {
          id: "q1",
          question: "选一个？",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    });
    const singleEls = (
      batchUpdateCard.mock.calls[0] as unknown as [
        string,
        Array<{ params: { elements: Array<{ tag: string; content?: string }> } }>,
      ]
    )[1][0]!.params.elements;
    expect(singleEls.some((e) => e.tag === "button")).toBe(true);

    batchUpdateCard.mockClear();
    await stream.appendAskUser({
      askId: "ask_multi",
      questions: [
        { id: "q1", question: "题一？", options: [{ id: "a", label: "A" }] },
        { id: "q2", question: "题二？", options: [{ id: "b", label: "B" }] },
      ],
    });
    const multiEls = (
      batchUpdateCard.mock.calls[0] as unknown as [
        string,
        Array<{ params: { elements: Array<{ tag: string; content?: string }> } }>,
      ]
    )[1][0]!.params.elements;
    expect(multiEls.every((e) => e.tag !== "button")).toBe(true);
    expect(
      multiEls.some((e) => e.content === "请直接回复文字作答"),
    ).toBe(true);
  });

  // review P2#6：finalize 补未闭合围栏
  it("finalize 对未闭合 ``` 围栏补闭合", async () => {
    expect(closeUnclosedCodeFence("```ts\nconst x = 1")).toBe(
      "```ts\nconst x = 1\n```",
    );
    expect(closeUnclosedCodeFence("```ts\nconst x = 1\n```")).toBe(
      "```ts\nconst x = 1\n```",
    );

    const stream = createCardStream("task_fence", { title: "t", openId: "ou" });
    await stream.start();
    stream.pushAnswer("```js\nconsole.log(1)");
    await vi.waitFor(() =>
      expect(updateCardElementContent).toHaveBeenCalled(),
    );
    await stream.finalize({ ok: true, durationMs: 1000 });
    const entityCalls = updateCardEntity.mock.calls as unknown as Array<
      [
        string,
        {
          body: {
            elements: Array<{ element_id?: string; content?: string }>;
          };
        },
      ]
    >;
    const cardJson = entityCalls.at(-1)![1];
    const answer = cardJson.body.elements.find(
      (e) => e.element_id === "md_answer",
    );
    expect(answer?.content).toContain("```js\nconsole.log(1)\n```");
  });
});
