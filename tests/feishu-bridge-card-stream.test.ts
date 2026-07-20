/**
 * card-stream：节流 / sequence 递增 / 前缀不回改 / 超长截断 / finalize
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-stream-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

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
  buildStreamingCardJson,
  coloredModelLabel,
  createCardStream,
  __setCardStreamTimersForTest,
} = await import("@/lib/server/feishu-bridge/card-stream");

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  updateCardElementContent.mockReset();
  updateCardEntity.mockReset();
  patchCardSettings.mockReset();
  createCardEntity.mockReset();
  sendCardMessage.mockReset();
  batchUpdateCard.mockReset();
  getBotAppInfo.mockReset();
  updateCardElementContent.mockResolvedValue(undefined);
  updateCardEntity.mockResolvedValue(undefined);
  patchCardSettings.mockResolvedValue(undefined);
  batchUpdateCard.mockResolvedValue(undefined);
  createCardEntity.mockResolvedValue({ card_id: "card_test" });
  sendCardMessage.mockResolvedValue({
    chat_id: "oc_test",
    message_id: "om_test",
  });
  getBotAppInfo.mockResolvedValue({
    appId: "cli_test",
    ownerOpenId: "ou_test",
  });
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

describe("buildStreamingCardJson Hermes 样式", () => {
  it("分区顺序：quote → panel → answer → hr → footer；面板带边框", () => {
    const card = buildStreamingCardJson({
      title: "聊",
      subtitle: "正在执行终端：pnpm lint",
      template: "blue",
      quoteMd: "> 💬 你在 app：hi",
      processText: "> `Shell` · running\n> pnpm lint",
      answerText: "正文",
      footerText: "3s · smoke",
    });
    const ids = (
      card.body as { elements: Array<{ element_id?: string; tag?: string }> }
    ).elements.map((e) => e.element_id ?? e.tag);
    expect(ids).toEqual([
      "md_quote",
      "panel_process",
      "md_answer",
      "main_divider",
      "md_footer",
    ]);
    const panel = (
      card.body as {
        elements: Array<{
          element_id?: string;
          header?: { title?: { tag?: string; content?: string } };
          border?: { color?: string };
          padding?: string;
        }>;
      }
    ).elements.find((e) => e.element_id === "panel_process");
    expect(panel?.header?.title?.tag).toBe("plain_text");
    expect(panel?.header?.title?.content).toContain("思考与工具 · 1 次工具调用");
    expect(panel?.border?.color).toBe("grey");
    expect(panel?.padding).toBe("8px 8px 8px 8px");
    const footer = (
      card.body as {
        elements: Array<{ element_id?: string; text_size?: string }>;
      }
    ).elements.find((e) => e.element_id === "md_footer");
    expect(footer?.text_size).toBe("x-small");
    // 有 subtitle 才挂 header.subtitle
    expect(
      (card.header as { subtitle?: { content: string } }).subtitle?.content,
    ).toBe("正在执行终端：pnpm lint");
  });

  it("空 subtitle 不写 header.subtitle；模型着色", () => {
    const card = buildStreamingCardJson({
      title: "聊",
      subtitle: "",
      template: "blue",
      answerText: "x",
    });
    expect(
      (card.header as { subtitle?: unknown }).subtitle,
    ).toBeUndefined();
    expect(coloredModelLabel("gpt-5.5")).toBe(
      '<font color="blue">gpt-5.5</font>',
    );
    expect(coloredModelLabel("MiniMax M2.7")).toBe("MiniMax M2.7");
  });

  it("面板标题恒带工具次数（0 次也显示、Hermes 同款）；indigo summary 思考中", () => {
    const card = buildStreamingCardJson({
      title: "聊",
      subtitle: "",
      template: "indigo",
      processText: "**思考 1** · running\n想",
    });
    const panel = (
      card.body as {
        elements: Array<{
          element_id?: string;
          header?: { title?: { content?: string } };
        }>;
      }
    ).elements.find((e) => e.element_id === "panel_process");
    expect(panel?.header?.title?.content).toBe("思考与工具 · 0 次工具调用");
    expect(
      (card.config as { summary: { content: string } }).summary.content,
    ).toBe("思考中");
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

    // 首次正文 flush：indigo→blue 转 header → 全量 PUT（内容随卡带上）
    stream.pushAnswer("A");
    while (pending.length) pending.shift()!();
    await vi.waitFor(() => expect(updateCardEntity).toHaveBeenCalled());

    // 后续 flush 走 element 流式 PUT
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
    // 全量 PUT 的 seq 也在同一分配器：element seq 必大于 entity seq
    const entitySeq = (
      updateCardEntity.mock.calls[0] as unknown as [string, unknown, number]
    )[2];
    expect(Math.min(...seqs)).toBeGreaterThan(entitySeq);
  });

  // Hermes 全态：thinking indigo → 正文开始 in_progress blue
  it("start 时 header indigo「思考中」、正文一开始转 blue", async () => {
    const stream = createCardStream("task_tmpl", { title: "t", openId: "ou" });
    await stream.start();
    const createJson = createCardEntity.mock.calls[0]![0] as {
      header: { template: string };
      config: { summary: { content: string } };
    };
    expect(createJson.header.template).toBe("indigo");
    expect(createJson.config.summary.content).toBe("思考中");

    stream.pushAnswer("正文来了");
    await vi.waitFor(() => expect(updateCardEntity).toHaveBeenCalled());
    const entity = updateCardEntity.mock.calls.at(-1)![1] as {
      header: { template: string };
    };
    expect(entity.header.template).toBe("blue");
  });

  it("push 缩短文本不会回改已推前缀", async () => {
    const pending: Array<() => void> = [];
    __setCardStreamTimersForTest((cb) => {
      pending.push(cb);
      return pending.length as unknown as ReturnType<typeof setTimeout>;
    });
    const stream = createCardStream("task_2", { title: "t", openId: "ou" });
    await stream.start();
    // 先消化 indigo→blue 的首刷全量 PUT
    stream.pushAnswer("hello");
    while (pending.length) pending.shift()!();
    await vi.waitFor(() => expect(updateCardEntity).toHaveBeenCalled());
    stream.pushAnswer("hello world");
    while (pending.length) pending.shift()!();
    await vi.waitFor(() =>
      expect(updateCardElementContent).toHaveBeenCalled(),
    );
    updateCardElementContent.mockClear();
    stream.pushAnswer("hello");
    while (pending.length) pending.shift()!();
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
    // 未经 timer 直接 flush（首刷带 indigo→blue header → 全量 PUT）
    await vi.waitFor(() => expect(updateCardEntity).toHaveBeenCalled());
    expect(pending.length).toBe(0);
  });

  it("finalize：刷余量 + 关 streaming + header/footer", async () => {
    process.env.FLOWSHIP_TEST = "1";
    const stream = createCardStream("task_fin", { title: "聊", openId: "ou" });
    await stream.start();
    stream.pushAnswer("最终回复");
    await vi.waitFor(() => expect(updateCardEntity).toHaveBeenCalled());
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
    expect(cardJson.header.subtitle.content).toBe("已完成");
    expect(cardJson.header.template).toBe("green");
    const footer = cardJson.body.elements.find((e) => e.element_id === "md_footer");
    // 深链入口已砍（2026-07-20 用户拍板）：footer 只剩耗时 · 模型
    expect(footer?.content).not.toContain("在 app 中打开");
    expect(footer?.content).toContain("composer");
    // Hermes 完成 footer：耗时裸数字（无「耗时」前缀）+ · 分隔
    expect(footer?.content).toMatch(/2m5s/);
    expect(footer?.content).not.toContain("耗时 ");
    expect(patchCardSettings).toHaveBeenCalled();
    const settingsCalls = patchCardSettings.mock.calls as unknown as Array<
      [string, { config: { streaming_mode: boolean } }, number]
    >;
    expect(settingsCalls[0]![1].config.streaming_mode).toBe(false);
    delete process.env.FLOWSHIP_TEST;
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
    // T7：提示文案带灰字包装
    expect(
      multiEls.some((e) => e.content?.includes("请直接回复文字作答")),
    ).toBe(true);
  });

  // R1-1a：全量 PUT 必须带回 ask 元素
  it("全量 PUT（headerDirty）保留已追加的 ask 按钮元素", async () => {
    const stream = createCardStream("task_ask_put", { title: "t", openId: "ou" });
    await stream.start();
    await stream.appendAskUser({
      askId: "ask_keep",
      questions: [
        {
          id: "q1",
          question: "选？",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    });
    expect(updateCardEntity).toHaveBeenCalled();
    const entityCalls = updateCardEntity.mock.calls as unknown as Array<
      [
        string,
        {
          body: {
            elements: Array<{ tag?: string; element_id?: string }>;
          };
          header: { template: string };
        },
      ]
    >;
    const cardJson = entityCalls.at(-1)![1];
    expect(cardJson.body.elements.some((e) => e.tag === "button")).toBe(true);
    const hrIdx = cardJson.body.elements.findIndex(
      (e) => e.element_id === "main_divider",
    );
    const btnIdx = cardJson.body.elements.findIndex((e) => e.tag === "button");
    expect(btnIdx).toBeGreaterThanOrEqual(0);
    expect(btnIdx).toBeLessThan(hrIdx);
    expect(cardJson.header.template).toBe("orange");
  });

  // R1-1b：pending ask 未清时 finalize 保持等待态
  it("pending 未清时 finalize 保持 orange「等待选择」、仍关 streaming", async () => {
    const { registerPendingAsk, clearPendingAsk } = await import(
      "@/lib/server/chat-pending"
    );
    const taskId = "task_ask_pend";
    registerPendingAsk(taskId, {
      askId: "ask_p",
      questions: [
        {
          id: "q1",
          question: "？",
          options: [{ id: "a", label: "A" }],
          allowText: true,
        },
      ],
    });
    try {
      const stream = createCardStream(taskId, { title: "t", openId: "ou" });
      await stream.start();
      await stream.appendAskUser({
        askId: "ask_p",
        questions: [
          {
            id: "q1",
            question: "？",
            options: [{ id: "a", label: "A" }],
          },
        ],
      });
      updateCardEntity.mockClear();
      await stream.finalize({
        ok: true,
        durationMs: 3000,
        model: "gpt-5.5",
      });
      const entityCalls = updateCardEntity.mock.calls as unknown as Array<
        [
          string,
          {
            header: { subtitle?: { content: string }; template: string };
            body: {
              elements: Array<{
                tag?: string;
                element_id?: string;
                content?: string;
              }>;
            };
          },
        ]
      >;
      const cardJson = entityCalls.at(-1)![1];
      expect(cardJson.header.template).toBe("orange");
      // Hermes waiting：subtitle 空，summary「等待选择」靠 template/config.summary
      expect(cardJson.header.subtitle).toBeUndefined();
      expect(
        (cardJson as { config?: { summary?: { content?: string } } }).config
          ?.summary?.content,
      ).toBe("等待选择");
      expect(cardJson.body.elements.some((e) => e.tag === "button")).toBe(true);
      const footer = cardJson.body.elements.find(
        (e) => e.element_id === "md_footer",
      );
      expect(footer?.content).toContain("gpt-5.5");
      expect(patchCardSettings).toHaveBeenCalled();
    } finally {
      clearPendingAsk(taskId);
    }
  });

  // R1-4：stopped 终态灰卡
  it("finalize outcome=stopped → grey「已停止」", async () => {
    const stream = createCardStream("task_stop", { title: "t", openId: "ou" });
    await stream.start();
    stream.pushAnswer("半截");
    await vi.waitFor(() => expect(updateCardEntity).toHaveBeenCalled());
    await stream.finalize({
      ok: true,
      outcome: "stopped",
      durationMs: 1000,
    });
    const entityCalls = updateCardEntity.mock.calls as unknown as Array<
      [
        string,
        { header: { subtitle?: { content: string }; template: string } },
      ]
    >;
    const cardJson = entityCalls.at(-1)![1];
    expect(cardJson.header.template).toBe("grey");
    expect(cardJson.header.subtitle?.content).toBe("已停止");
  });

  // R1-1c + R1-13d：append 与 finalize 交错按链序
  it("appendAskUser 与 finalize 交错时按链序执行（finalize 在 append 后）", async () => {
    const order: string[] = [];
    batchUpdateCard.mockImplementation(async () => {
      order.push("batch");
      await new Promise((r) => setTimeout(r, 30));
    });
    updateCardEntity.mockImplementation(async () => {
      order.push("entity");
    });
    patchCardSettings.mockImplementation(async () => {
      order.push("settings");
    });

    const stream = createCardStream("task_race", { title: "t", openId: "ou" });
    await stream.start();
    const askP = stream.appendAskUser({
      askId: "ask_r",
      questions: [
        {
          id: "q1",
          question: "？",
          options: [{ id: "a", label: "A" }],
        },
      ],
    });
    const finP = stream.finalize({ ok: true, durationMs: 100 });
    await Promise.all([askP, finP]);

    expect(order[0]).toBe("batch");
    expect(order.at(-1)).toBe("settings");
    const batchIdx = order.indexOf("batch");
    const settingsIdx = order.lastIndexOf("settings");
    expect(batchIdx).toBeLessThan(settingsIdx);
  });

  // R1-13d：三通道交错同卡 sequence 严格递增
  it("process/answer/header 三通道交错时同卡 sequence 严格递增", async () => {
    const pending: Array<() => void> = [];
    __setCardStreamTimersForTest((cb) => {
      pending.push(cb);
      return pending.length as unknown as ReturnType<typeof setTimeout>;
    });
    const stream = createCardStream("task_seq3", { title: "t", openId: "ou" });
    await stream.start();

    stream.pushProcess("> `Shell` · running\n> x");
    stream.pushAnswer("正文一段");
    stream.setHeaderStatus("正在执行终端：x", "blue");
    while (pending.length) pending.shift()!();
    await vi.waitFor(() => expect(updateCardEntity).toHaveBeenCalled());

    updateCardElementContent.mockClear();
    batchUpdateCard.mockClear();
    updateCardEntity.mockClear();
    stream.pushProcess("> `Shell` · completed\n> x");
    stream.pushAnswer("正文一段续");
    while (pending.length) pending.shift()!();
    // 思考区走 batch update_element；正文仍走流式 content PUT
    await vi.waitFor(() => {
      expect(batchUpdateCard.mock.calls.length).toBeGreaterThan(0);
      expect(updateCardElementContent.mock.calls.length).toBeGreaterThan(0);
    });

    // 前缀分叉（running→completed）仍会推送：batch 的 content 含 completed
    const processBatch = batchUpdateCard.mock.calls[0] as unknown as [
      string,
      Array<{
        action: string;
        params: { element: { content?: string } };
      }>,
      number,
    ];
    expect(processBatch[1][0]?.action).toBe("update_element");
    expect(processBatch[1][0]?.params.element.content).toContain("completed");

    const answerSeqs = (
      updateCardElementContent.mock.calls as unknown as Array<
        [string, string, string, number]
      >
    ).map((c) => c[3]);
    const processSeqs = (
      batchUpdateCard.mock.calls as unknown as Array<[string, unknown, number]>
    ).map((c) => c[2]);
    const flushSeqs = [...processSeqs, ...answerSeqs].sort((a, b) => a - b);
    for (let i = 1; i < flushSeqs.length; i++) {
      expect(flushSeqs[i]!).toBeGreaterThan(flushSeqs[i - 1]!);
    }
    // 正文打字机仍只打 md_answer
    for (const c of updateCardElementContent.mock.calls as unknown as Array<
      [string, string, string, number]
    >) {
      expect(c[1]).toBe("md_answer");
    }

    stream.setHeaderStatus("收尾", "blue");
    stream.pushAnswer("正文一段续完");
    while (pending.length) pending.shift()!();
    await vi.waitFor(() => expect(updateCardEntity).toHaveBeenCalled());
    const allSeqs = [
      ...(
        updateCardEntity.mock.calls as unknown as Array<[string, unknown, number]>
      ).map((c) => c[2]),
      ...(
        updateCardElementContent.mock.calls as unknown as Array<
          [string, string, string, number]
        >
      ).map((c) => c[3]),
      ...(
        batchUpdateCard.mock.calls as unknown as Array<[string, unknown, number]>
      ).map((c) => c[2]),
    ];
    expect(new Set(allSeqs).size).toBe(allSeqs.length);
    expect(Math.max(...allSeqs)).toBeGreaterThan(Math.min(...allSeqs));
  });

  it("思考区 flush 走 batch update_element，不走嵌套流式 PUT", async () => {
    const stream = createCardStream("task_proc_batch", {
      title: "t",
      openId: "ou",
    });
    await stream.start();
    batchUpdateCard.mockClear();
    updateCardElementContent.mockClear();
    stream.pushProcess("**思考 1** · running\n先想一步");
    await vi.waitFor(() => expect(batchUpdateCard).toHaveBeenCalled());
    expect(updateCardElementContent).not.toHaveBeenCalled();
    const call = batchUpdateCard.mock.calls[0] as unknown as [
      string,
      Array<{
        action: string;
        params: {
          element_id: string;
          element: { tag: string; content: string; text_size?: string };
        };
      }>,
      number,
    ];
    expect(call[1][0]?.action).toBe("update_element");
    expect(call[1][0]?.params.element_id).toBe("md_process");
    expect(call[1][0]?.params.element.content).toContain("先想一步");
    expect(call[1][0]?.params.element.text_size).toBe("small");
  });

  // P0：纯思考轮（无工具）finalize 后 process 内容必须保留
  it("纯思考轮 finalize 后 process 内容保留（全量 PUT + batch 回写同源）", async () => {
    const pending: Array<() => void> = [];
    __setCardStreamTimersForTest((cb) => {
      pending.push(cb);
      return pending.length as unknown as ReturnType<typeof setTimeout>;
    });

    const thinking =
      "**思考 1** · completed\n用户在 Flowship Chat 任务中问候。我将用中文自然回复。";
    const stream = createCardStream("task_pure_think", {
      title: "纯思考轮",
      openId: "ou",
    });
    await stream.start();

    // 模拟真机时序：思考进节流窗 → 正文触发 indigo→blue 全量 PUT → finalize 抢在 timer 前
    stream.pushProcess(thinking);
    stream.pushAnswer("hello啊，有什么我可以帮你的？");
    // 不消化 timer——直接 finalize（复现「节流窗内 finalize 抢跑」）
    await stream.finalize({
      ok: true,
      durationMs: 1800,
      model: "composer-2",
    });

    const entityCalls = updateCardEntity.mock.calls as unknown as Array<
      [
        string,
        {
          body: {
            elements: Array<{
              element_id?: string;
              elements?: Array<{ element_id?: string; content?: string }>;
              content?: string;
            }>;
          };
        },
      ]
    >;
    const finalCard = entityCalls.at(-1)![1];
    const panel = finalCard.body.elements.find(
      (e) => e.element_id === "panel_process",
    );
    const processMd = panel?.elements?.find((e) => e.element_id === "md_process");
    expect(processMd?.content).toContain("用户在 Flowship Chat 任务中问候");
    expect(processMd?.content).toContain("**思考 1**");

    // finalize 后必须 batch 回写 md_process（防 CardKit 全量 PUT 抹嵌套 content）
    const processBatches = (
      batchUpdateCard.mock.calls as unknown as Array<
        [
          string,
          Array<{
            action: string;
            params: { element_id?: string; element?: { content?: string } };
          }>,
        ]
      >
    ).filter((c) =>
      c[1]?.some(
        (a) =>
          a.action === "update_element" &&
          a.params.element_id === "md_process" &&
          (a.params.element?.content ?? "").includes("用户在 Flowship Chat"),
      ),
    );
    expect(processBatches.length).toBeGreaterThan(0);
  });

  // R1-13d：finalize 与在途 flush 不乱序
  it("finalize 与在途 flush 交错不乱序（链上互斥）", async () => {
    const pending: Array<() => void> = [];
    __setCardStreamTimersForTest((cb) => {
      pending.push(cb);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });

    const stream = createCardStream("task_fin_race", {
      title: "t",
      openId: "ou",
    });
    await stream.start();
    // 先消化首刷（indigo→blue header 全量 PUT），让在途 flush 走 element PUT
    stream.pushAnswer("在途");
    while (pending.length) pending.shift()!();
    await vi.waitFor(() => expect(updateCardEntity).toHaveBeenCalled());

    const order: string[] = [];
    let flushGate: (() => void) | null = null;
    updateCardElementContent.mockImplementation(async () => {
      order.push("flush");
      await new Promise<void>((resolve) => {
        flushGate = resolve;
      });
    });
    updateCardEntity.mockImplementation(async () => {
      order.push("finalize-entity");
    });
    patchCardSettings.mockImplementation(async () => {
      order.push("finalize-settings");
    });

    stream.pushAnswer("在途文本");
    while (pending.length) pending.shift()!();
    await vi.waitFor(() => expect(flushGate).toBeTruthy());

    const finP = stream.finalize({ ok: true, durationMs: 10 });
    flushGate!();
    await finP;

    expect(order[0]).toBe("flush");
    expect(order.slice(1)).toEqual(["finalize-entity", "finalize-settings"]);
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
    await vi.waitFor(() => expect(updateCardEntity).toHaveBeenCalled());
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
