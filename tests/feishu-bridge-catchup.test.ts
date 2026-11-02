/**
 * review P1#3：断线补拉分页 + 本人 user 过滤 + 总量 cap
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-catchup-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const larkApi = vi.hoisted(() => vi.fn());
const getBotAppInfo = vi.hoisted(() =>
  vi.fn(async () => ({ appId: "cli_x", ownerOpenId: "ou_owner" })),
);

vi.mock("@/lib/server/feishu-bridge/lark-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/feishu-bridge/lark-api")>();
  return {
    ...actual,
    larkApi,
    getBotAppInfo,
    sendTextMessage: vi.fn(async () => ({ chat_id: "c", message_id: "m" })),
  };
});

const { catchUpMissedMessages, defaultMessageHandler } = await import(
  "@/lib/server/feishu-bridge/inbound"
);
const { __setRouterDepsForTest } = await import(
  "@/lib/server/feishu-bridge/router"
);
const { baseRouterDeps, failInjectResponse, okInjectResponse } = await import(
  "./helpers/feishu-bridge-harness"
);
const { rememberP2pChatId, __resetBridgeStateForTest } = await import(
  "@/lib/server/feishu-bridge/bridge-state"
);
const { setLastProcessedTs, getLastProcessedTs } = await import(
  "@/lib/server/feishu-bridge/card-map"
);
const { hasProcessedMessageId } = await import(
  "@/lib/server/feishu-bridge/bridge-state"
);

const makeItem = (
  id: string,
  opts: {
    senderId?: string;
    senderType?: string;
  } = {},
) => ({
  message_id: id,
  create_time: String(Date.now()),
  chat_id: "oc_p2p",
  msg_type: "text",
  sender: {
    id: opts.senderId ?? "ou_owner",
    sender_type: opts.senderType ?? "user",
  },
  body: { content: JSON.stringify({ text: id }) },
});

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  await __resetBridgeStateForTest();
  larkApi.mockReset();
  getBotAppInfo.mockClear();
  await rememberP2pChatId("oc_p2p");
  // 5 分钟前——落在补拉窗口内
  await setLastProcessedTs(String(Date.now() - 5 * 60 * 1000));
});

afterEach(async () => {
  __setRouterDepsForTest(null);
  await __resetBridgeStateForTest();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("catchUpMissedMessages", () => {
  it("跟随 has_more/page_token 翻页，过滤非本人 / 非 user", async () => {
    const got: string[] = [];
    larkApi
      .mockResolvedValueOnce({
        data: {
          items: [
            makeItem("om_1"),
            makeItem("om_bot", { senderType: "app" }),
            makeItem("om_other", { senderId: "ou_other" }),
          ],
          has_more: true,
          page_token: "tok_2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [makeItem("om_2")],
          has_more: false,
        },
      });

    await catchUpMissedMessages(async (msg) => {
      got.push(msg.message_id);
    });

    expect(larkApi).toHaveBeenCalledTimes(2);
    const secondParams = (
      larkApi.mock.calls[1] as unknown as [string, string, { params: Record<string, unknown> }]
    )[2].params;
    expect(secondParams.page_token).toBe("tok_2");
    expect(secondParams.page_size).toBe(50);
    expect(got).toEqual(["om_1", "om_2"]);
  });

  it("某条消息处理抛错：只丢这一条，同页后面的消息与后续页照常处理（以前一条抛错整轮补拉就中断了）", async () => {
    const got: string[] = [];
    larkApi
      .mockResolvedValueOnce({
        data: {
          items: [makeItem("om_a"), makeItem("om_boom"), makeItem("om_c")],
          has_more: true,
          page_token: "tok_2",
        },
      })
      .mockResolvedValueOnce({ data: { items: [makeItem("om_d")], has_more: false } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await catchUpMissedMessages(async (msg) => {
        if (msg.message_id === "om_boom") throw new Error("boom");
        got.push(msg.message_id);
      });
      expect(got).toEqual(["om_a", "om_c", "om_d"]);
      expect(larkApi).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("om_boom"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  describe("拿不到 p2p chatId 时的跳过：如实区分「确实没有记录」与「bridge-state 读不出来」", () => {
    const canMakeUnreadable =
      process.platform !== "win32" && (process.getuid?.() ?? 1) !== 0;
    const warnTexts = (spy: { mock: { calls: unknown[][] } }): string[] =>
      spy.mock.calls.map((c) => String(c[0]));

    it("确实没有记录（bridge-state 里没存过 chatId）：日志「尚无 p2p chatId」，不调接口", async () => {
      await __resetBridgeStateForTest(); // 删掉 beforeEach 里记的 chatId
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await catchUpMissedMessages(async () => undefined);
        expect(warnTexts(warn).some((t) => t.includes("尚无 p2p chatId"))).toBe(true);
        expect(larkApi).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it.skipIf(!canMakeUnreadable)(
      "bridge-state 读不出来：不谎报「尚无 p2p chatId」，如实说读不出来、离线消息需重发（card-map 里没有 chatId，无别的来源可补，仍跳过）",
      async () => {
        const stateFile = path.join(TMP, "data", "feishu-bridge", "bridge-state.json");
        await fs.chmod(stateFile, 0o000);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
          await catchUpMissedMessages(async () => undefined);
          const texts = warnTexts(warn);
          expect(texts.some((t) => t.includes("尚无 p2p chatId"))).toBe(false);
          expect(texts.some((t) => t.includes("读不出来") && t.includes("补拉跳过"))).toBe(true);
          expect(larkApi).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
          await fs.chmod(stateFile, 0o600);
        }
      },
    );

    it("bridge-state 内容损坏：同样如实说读不出来（而不是「尚无 chatId」）", async () => {
      const stateFile = path.join(TMP, "data", "feishu-bridge", "bridge-state.json");
      await fs.writeFile(stateFile, "{not json", "utf-8");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await catchUpMissedMessages(async () => undefined);
        const texts = warnTexts(warn);
        expect(texts.some((t) => t.includes("尚无 p2p chatId"))).toBe(false);
        expect(texts.some((t) => t.includes("读不出来"))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("handler 正常返回 retryable_failed（不抛）也算批内失败：其后的消息不再推进游标；已处理 / 不需重试的（handled）不触发", async () => {
    larkApi.mockResolvedValueOnce({
      data: { items: [makeItem("om_ok1"), makeItem("om_retry"), makeItem("om_after1"), makeItem("om_after2")], has_more: false },
    });
    const seen: Array<{ id: string; skip: boolean | undefined }> = [];
    await catchUpMissedMessages(async (msg, opts) => {
      seen.push({ id: msg.message_id, skip: opts?.skipCursorAdvance });
      return msg.message_id === "om_retry" ? "retryable_failed" : "handled";
    });
    expect(seen).toEqual([
      { id: "om_ok1", skip: undefined },
      { id: "om_retry", skip: undefined }, // 失败的这条自己照常处理（没抛、只是返回失败）
      { id: "om_after1", skip: true },
      { id: "om_after2", skip: true },
    ]);
  });

  describe("端到端（真 defaultMessageHandler + 路由）：可重试失败后面有成功消息 → 游标停在失败点、失败那条下次补拉重投", () => {
    const oneActiveChat = () =>
      [
        {
          id: "task-1",
          title: "t",
          mode: "chat",
          repoStatus: "developing",
          runStatus: "idle",
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ] as never;
    const itemAt = (id: string, ts: number) => ({ ...makeItem(id), create_time: String(ts) });

    it("A 成功 → B 503（可重试）→ C 成功：游标停在 A；B 没标记、C 已标记（不重复注入）；B 恢复后下次补拉只重投 B", async () => {
      const t0 = Date.now() - 3 * 60_000;
      const tA = t0 + 1_000;
      const tB = t0 + 2_000;
      const tC = t0 + 3_000;
      await setLastProcessedTs(String(t0));

      let bFails = true;
      const injected: string[] = [];
      __setRouterDepsForTest(
        baseRouterDeps({
          listTasks: async () => oneActiveChat(),
          handleChatReplyInject: async (_id, body) => {
            const text = (body as { text?: string }).text ?? "";
            if (text === "om_B" && bFails) return failInjectResponse(503, "upstream");
            injected.push(text);
            return okInjectResponse();
          },
        }),
      );
      const items = [itemAt("om_A", tA), itemAt("om_B", tB), itemAt("om_C", tC)];
      larkApi.mockResolvedValue({ data: { items, has_more: false } });
      // makeItem 的 body.content 是 {text: id}，这里直接以 id 作文本，所以注入的 text 就是 om_A / om_B / om_C
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await catchUpMissedMessages(defaultMessageHandler);
        expect(injected).toEqual(["om_A", "om_C"]); // B 的注入 503 了
        expect(await hasProcessedMessageId("om_A")).toBe(true);
        expect(await hasProcessedMessageId("om_B")).toBe(false);
        expect(await hasProcessedMessageId("om_C")).toBe(true); // C 已处理，重放时靠去重跳过
        expect(await getLastProcessedTs()).toBe(String(tA)); // 游标停在失败点之前（A），没被 C 推到 tC
        expect(warn.mock.calls.some((c) => String(c[0]).includes("可重试失败") && String(c[0]).includes("om_B"))).toBe(true);

        // 下次补拉（B 恢复）：只有 B 被重投，A / C 不重复注入；游标随后推进
        bFails = false;
        injected.length = 0;
        await catchUpMissedMessages(defaultMessageHandler);
        expect(injected).toEqual(["om_B"]);
        expect(await hasProcessedMessageId("om_B")).toBe(true);
        expect(await getLastProcessedTs()).toBe(String(tB));
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("本批出现过抛错后，后面的消息不再推进补拉游标（游标停在最早失败那条之前，失败的那条下次补拉能重放；已处理的靠去重表跳过）", async () => {
    const seen: Array<[string, boolean]> = [];
    larkApi.mockResolvedValueOnce({
      data: {
        items: [makeItem("om_a"), makeItem("om_boom"), makeItem("om_c"), makeItem("om_d")],
        has_more: false,
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await catchUpMissedMessages(async (msg, opts) => {
        seen.push([msg.message_id, opts?.skipCursorAdvance === true]);
        if (msg.message_id === "om_boom") throw new Error("boom");
      });
    } finally {
      warn.mockRestore();
    }
    // 失败之前的照常（可推进游标）；失败那条自己与之后的都被告知「别推进游标」
    expect(seen).toEqual([
      ["om_a", false],
      ["om_boom", false],
      ["om_c", true],
      ["om_d", true],
    ]);
  });

  it("没有任何失败时：全程允许推进游标（行为同旧）", async () => {
    const seen: boolean[] = [];
    larkApi.mockResolvedValueOnce({
      data: { items: [makeItem("om_1"), makeItem("om_2")], has_more: false },
    });
    await catchUpMissedMessages(async (_msg, opts) => {
      seen.push(opts?.skipCursorAdvance === true);
    });
    expect(seen).toEqual([false, false]);
  });

  it("持续失败也计入总量 cap：每条都抛错时到 200 条尝试就停翻页，不会无休止翻下去", async () => {
    const page = (start: number) =>
      Array.from({ length: 50 }, (_, i) => makeItem(`om_f${start + i}`));
    for (let p = 0; p < 6; p += 1) {
      larkApi.mockResolvedValueOnce({
        data: { items: page(p * 50), has_more: true, page_token: `t${p + 2}` },
      });
    }
    let attempts = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await catchUpMissedMessages(async () => {
        attempts += 1;
        throw new Error("always");
      });
      expect(attempts).toBe(200);
      expect(larkApi).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("总量 cap 200 后停止翻页", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => makeItem(`om_${i}`));
    const page2 = Array.from({ length: 50 }, (_, i) =>
      makeItem(`om_${50 + i}`),
    );
    const page3 = Array.from({ length: 50 }, (_, i) =>
      makeItem(`om_${100 + i}`),
    );
    const page4 = Array.from({ length: 50 }, (_, i) =>
      makeItem(`om_${150 + i}`),
    );
    const page5 = Array.from({ length: 50 }, (_, i) =>
      makeItem(`om_${200 + i}`),
    );
    larkApi
      .mockResolvedValueOnce({
        data: { items: page1, has_more: true, page_token: "t2" },
      })
      .mockResolvedValueOnce({
        data: { items: page2, has_more: true, page_token: "t3" },
      })
      .mockResolvedValueOnce({
        data: { items: page3, has_more: true, page_token: "t4" },
      })
      .mockResolvedValueOnce({
        data: { items: page4, has_more: true, page_token: "t5" },
      })
      .mockResolvedValueOnce({
        data: { items: page5, has_more: true, page_token: "t6" },
      });

    let n = 0;
    await catchUpMissedMessages(async () => {
      n += 1;
    });
    expect(n).toBe(200);
    // 第 4 页注入满 200 后应停止，不再请求第 5 页
    expect(larkApi).toHaveBeenCalledTimes(4);
  });
});
