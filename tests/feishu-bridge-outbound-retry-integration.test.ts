/**
 * R3-1 跨层集成：outbound（真实 finalizeTurn 顺序）→ 真 card-stream（真守卫/真链）
 *
 * 两轮 review 漏掉重试按钮死路的根因：outbound 测试 mock 卡片句柄（只断言
 * appendRetryButton 被调过）、card-stream 测试又是「先 append 后 finalize」——
 * 没有用例走 outbound 的真实调用顺序。本文件只 mock lark-api，其余全真。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-outbound-int-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const getTask = vi.hoisted(() =>
  vi.fn(async (id: string) => ({
    id,
    title: "集成测对话",
    mode: "chat" as const,
    model: { id: "grok-4" },
  })),
);

// writeEventAndPublish → appendEvent（落盘 + commit 回调里 publish）。假实现只做「造事件 → 调 commit」，
// 让 outbound 写的 info 能走到 task-stream 订阅者（R14 P1-1 跨层用例要观察它）
const appendEvent = vi.hoisted(() =>
  vi.fn(
    async (
      _taskId: string,
      ev: Record<string, unknown>,
      _lease: unknown,
      onCommit?: (event: unknown) => void,
    ) => {
      const event = {
        id: `ev_int_${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        seq: 0,
        ...ev,
      };
      onCommit?.(event);
      return event;
    },
  ),
);

vi.mock("@/lib/server/task-fs", () => ({ getTask, appendEvent }));

vi.mock("@/lib/server/feishu-bridge/bridge-config", () => {
  const bridgeDir = path.join(
    process.env.FLOWSHIP_DATA_DIR ?? "/tmp",
    "feishu-bridge",
  );
  return {
    isFeishuChatBridgeEnabled: async () => true,
    isFeishuBridgeStreamingEnabled: async () => true,
    isFeishuBridgeKeepAwakeEnabled: async () => true,
    isBridgeTestInstance: () => true,
    getBridgeDataDir: async () => {
      const { promises: fsp } = await import("node:fs");
      await fsp.mkdir(bridgeDir, { recursive: true });
      return bridgeDir;
    },
  };
});

const larkMocks = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    createCardEntity: vi.fn<AnyFn>(async () => ({ card_id: "card_int" })),
    sendCardMessage: vi.fn<AnyFn>(async () => ({
      chat_id: "oc_int",
      message_id: "om_int",
    })),
    sendTextMessage: vi.fn<AnyFn>(async () => ({
      chat_id: "oc_int",
      message_id: "om_text_int",
    })),
    updateCardEntity: vi.fn<AnyFn>(async () => undefined),
    updateCardElementContent: vi.fn<AnyFn>(async () => undefined),
    patchCardSettings: vi.fn<AnyFn>(async () => undefined),
    batchUpdateCard: vi.fn<AnyFn>(async () => undefined),
    getBotAppInfo: vi.fn<AnyFn>(async () => ({
      appId: "cli_int",
      ownerOpenId: "ou_int",
    })),
    uploadImage: vi.fn<AnyFn>(async () => "img_key_int"),
  };
});

vi.mock("@/lib/server/feishu-bridge/lark-api", () => larkMocks);

const {
  ensureFeishuOutboundRegistered,
  __resetFeishuOutboundForTest,
  __setBridgeEnabledForTest,
  handleFeishuOutboundEvent,
} = await import("@/lib/server/feishu-bridge/outbound");
const { __setCardStreamTimersForTest, __setFinalRetryDelaysForTest } =
  await import("@/lib/server/feishu-bridge/card-stream");
const { __resetCardSeqForTest } = await import(
  "@/lib/server/feishu-bridge/card-seq"
);
const { LarkApiError } = await import("@/lib/server/feishu-bridge/types");
const { subscribeAllTaskStreams } = await import("@/lib/server/task-stream");

const makeEvent = (
  kind: string,
  text: string,
  meta?: Record<string, unknown>,
) => ({
  kind: "event" as const,
  event: {
    id: `ev_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    kind: kind as never,
    text,
    meta,
  },
});

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  await __resetCardSeqForTest();
  __resetFeishuOutboundForTest();
  for (const fn of Object.values(larkMocks)) fn.mockClear();
  // 「永久失败」用例对写类 mock 设了 mockRejectedValue，mockClear 不清实现——
  // 复位成成功，免得失败串到后面的用例（终稿重试用例要自己控制第几发失败）
  for (const fn of [
    larkMocks.updateCardEntity,
    larkMocks.updateCardElementContent,
    larkMocks.patchCardSettings,
    larkMocks.batchUpdateCard,
  ]) {
    fn.mockReset();
    fn.mockResolvedValue(undefined);
  }
  __setBridgeEnabledForTest(true);
  // 节流 timer 立即执行，避免 250ms 真等待
  __setCardStreamTimersForTest((cb) => {
    cb();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  ensureFeishuOutboundRegistered();
});

afterEach(async () => {
  __setCardStreamTimersForTest(null);
  __setFinalRetryDelaysForTest(null);
  __resetFeishuOutboundForTest();
  await __resetCardSeqForTest();
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("outbound → 真 card-stream：失败轮重试按钮", () => {
  it("done ok=false：重试按钮真渲染（batch add_elements）且 finalize 全量 PUT 保留、footer 带错误摘要", async () => {
    const taskId = "t_int_retry";
    await handleFeishuOutboundEvent(taskId, makeEvent("user_reply", "会失败的一问"));
    await handleFeishuOutboundEvent(taskId, {
      kind: "assistant_delta",
      text: "答到一半",
    });
    // 等 start 链（建卡→发消息→card-map 落盘）与 pendingOps 排空
    await vi.waitFor(() => expect(larkMocks.sendCardMessage).toHaveBeenCalled());

    await handleFeishuOutboundEvent(
      taskId,
      makeEvent("error", "Chat agent 异常：网络断了"),
    );
    await handleFeishuOutboundEvent(taskId, {
      kind: "done",
      ok: false,
      task: { id: taskId, title: "集成测对话", mode: "chat" } as never,
    });

    // 1) 重试按钮的 batch add_elements 真发出去了（旧 bug：finalize 后守卫短路、永不发）
    const addCalls = (
      larkMocks.batchUpdateCard.mock.calls as unknown as Array<
        [
          string,
          Array<{
            action: string;
            params: { elements?: Array<{ element_id?: string }> };
          }>,
        ]
      >
    ).filter((c) => c[1]?.some((a) => a.action === "add_elements"));
    expect(
      addCalls.some((c) =>
        c[1].some((a) =>
          a.params.elements?.some((e) => e.element_id === "btn_retry"),
        ),
      ),
    ).toBe(true);

    // 2) finalize 的全量 PUT 带上按钮（appendedElements 快照）+ red + footer 错误摘要
    const entityCalls = larkMocks.updateCardEntity.mock.calls as unknown as Array<
      [
        string,
        {
          header: { template: string };
          body: {
            elements: Array<{
              tag?: string;
              element_id?: string;
              content?: string;
            }>;
          };
        },
        number,
      ]
    >;
    expect(entityCalls.length).toBeGreaterThan(0);
    const finalJson = entityCalls.at(-1)![1];
    expect(finalJson.header.template).toBe("red");
    expect(
      finalJson.body.elements.some((e) => e.element_id === "btn_retry"),
    ).toBe(true);
    const footer = finalJson.body.elements.find(
      (e) => e.element_id === "md_footer",
    );
    expect(footer?.content).toContain("处理失败：Chat agent 异常：网络断了");

    // 3) 正常关流收尾仍执行
    expect(larkMocks.patchCardSettings).toHaveBeenCalled();
  });

  it("done ok=true：不追加重试按钮（对照）", async () => {
    const taskId = "t_int_ok";
    await handleFeishuOutboundEvent(taskId, makeEvent("user_reply", "正常一问"));
    await handleFeishuOutboundEvent(taskId, {
      kind: "assistant_delta",
      text: "顺利答完",
    });
    await vi.waitFor(() => expect(larkMocks.sendCardMessage).toHaveBeenCalled());
    await handleFeishuOutboundEvent(taskId, {
      kind: "done",
      ok: true,
      task: {
        id: taskId,
        title: "集成测对话",
        mode: "chat",
        runStatus: "awaiting_user",
      } as never,
    });

    const allBatchEls = (
      larkMocks.batchUpdateCard.mock.calls as unknown as Array<
        [
          string,
          Array<{
            action: string;
            params: { elements?: Array<{ element_id?: string }> };
          }>,
        ]
      >
    ).flatMap((c) => c[1] ?? []);
    expect(
      allBatchEls.some((a) =>
        a.params.elements?.some((e) => e.element_id === "btn_retry"),
      ),
    ).toBe(false);
    const entityCalls = larkMocks.updateCardEntity.mock.calls as unknown as Array<
      [string, { header: { template: string } }]
    >;
    expect(entityCalls.at(-1)![1].header.template).toBe("green");
  });
});

/**
 * R14 P1-1 跨层：真 outbound + 真 card-stream（失败间隔重试 / finalizeOk 的真实取值）+ 假 lark。
 * outbound 单测用假句柄（getHealth 返回设定值）、card-stream 单测直接测句柄——
 * 「onFatal 真的接到 card-stream、unsynced 的判据读到的就是真句柄的值」只有这里能钉住。
 */
describe("outbound → 真 card-stream：飞书卡片掉线的对外信号（R14 P1-1）", () => {
  /** 收集该 task 在事件流里落的 info（致命故障提示 / 终态提示都是 info） */
  const collectInfos = (
    taskId: string,
  ): { texts: string[]; stop: () => void } => {
    const texts: string[] = [];
    const stop = subscribeAllTaskStreams((tid, ev) => {
      if (tid === taskId && ev.kind === "event" && ev.event.kind === "info") {
        texts.push(ev.event.text ?? "");
      }
    });
    return { texts, stop };
  };

  const startTurn = async (taskId: string): Promise<void> => {
    await handleFeishuOutboundEvent(taskId, makeEvent("user_reply", "一问"));
    await handleFeishuOutboundEvent(taskId, {
      kind: "assistant_delta",
      text: "开头",
    });
    await vi.waitFor(() => expect(larkMocks.sendCardMessage).toHaveBeenCalled());
  };

  const finishTurn = (taskId: string): Promise<void> =>
    handleFeishuOutboundEvent(taskId, {
      kind: "done",
      ok: true,
      task: {
        id: taskId,
        title: "集成测对话",
        mode: "chat",
        runStatus: "awaiting_user",
      } as never,
    });

  const pingTexts = (): string[] =>
    (larkMocks.sendTextMessage.mock.calls as unknown as Array<[string, string]>).map(
      (c) => c[1],
    );

  it("对照：lark 一切正常 → 没有 info，追发「✅ 已完成」", async () => {
    const taskId = "t_int_breaker_ok";
    const { texts, stop } = collectInfos(taskId);
    try {
      await startTurn(taskId);
      await handleFeishuOutboundEvent(taskId, {
        kind: "assistant_delta",
        text: "答".repeat(700),
      });
      await finishTurn(taskId);
      expect(texts).toEqual([]);
      expect(pingTexts()).toHaveLength(1);
      expect(pingTexts()[0]).toContain("✅ 已完成");
    } finally {
      stop();
    }
  });

  it("lark 永久失败：普通失败不吵（中途不落 info）、失败间隔内不狂发 → 终稿也没落成 → 先落终态 info 再追发 ⚠️", async () => {
    const taskId = "t_int_breaker_down";
    const err = new LarkApiError("rate limited", { code: 99991400 });
    for (const m of [
      larkMocks.updateCardEntity,
      larkMocks.updateCardElementContent,
      larkMocks.batchUpdateCard,
      larkMocks.patchCardSettings,
    ]) {
      m.mockRejectedValue(err);
    }
    appendEvent.mockClear();
    // 终稿对限流会退避重发 2 次（默认 1s / 3s 真等待）：这里只关心重发次数与收尾信号，退避间隔压成 0
    __setFinalRetryDelaysForTest([0, 0]);
    // 失败后的重试定时器改成手动触发（本文件默认的「立即执行」会让重试在失败当场无限循环）。
    // 带 clear：被取代的节流定时器要从表里删掉，否则手动触发时会连它一起放行
    const timers = new Map<number, () => void>();
    let timerId = 0;
    __setCardStreamTimersForTest(
      (cb) => {
        timerId += 1;
        timers.set(timerId, cb);
        return timerId as unknown as ReturnType<typeof setTimeout>;
      },
      (id) => {
        timers.delete(id as unknown as number);
      },
    );
    const fireTimers = (): void => {
      const cbs = [...timers.values()];
      timers.clear();
      for (const cb of cbs) cb();
    };
    const { texts, stop } = collectInfos(taskId);
    try {
      await startTurn(taskId);
      // 持续输出：每次 +700 字（越过 600 字阈值 → 没失败时 push 即 flush）
      for (let i = 0; i < 12; i++) {
        await handleFeishuOutboundEvent(taskId, {
          kind: "assistant_delta",
          text: "答".repeat(700),
        });
        await new Promise((r) => setTimeout(r, 10));
      }
      // 1) 首发失败后，继续输出也不再发请求（只等失败间隔的重试定时器）；普通失败不通知
      expect(larkMocks.updateCardEntity.mock.calls.length).toBe(1);
      expect(texts).toEqual([]);

      // 2) 重试定时器到期（手动触发）→ 再发一次、仍失败：还是不通知；再触发一次凑够 3 次连续失败
      for (const expected of [2, 3]) {
        fireTimers();
        await vi.waitFor(() =>
          expect(larkMocks.updateCardEntity.mock.calls.length).toBe(expected),
        );
        await vi.waitFor(() => expect(timers.size).toBe(1)); // 失败后又排好了下一次重试
      }
      expect(texts).toEqual([]);
      const beforeFinish = larkMocks.updateCardEntity.mock.calls.length;
      expect(beforeFinish).toBe(3);

      // 3) done：已连续失败 3 次（飞书已知不通）→ finalize 不先刷余量，整卡 PUT 强试一次（失败）；
      //    限流属瞬时失败，再退避重发 2 次（共 3 发）仍失败
      //    → 终稿没落成 → 先落终态 info；正文以文字补发（不再只剩一句「请回 Flowship 查看」）、最后追发 ⚠️
      await finishTurn(taskId);
      expect(larkMocks.updateCardEntity.mock.calls.length).toBe(beforeFinish + 3);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("飞书卡片没能同步完整回复");
      expect(texts[0]).toContain("rate limited");
      expect(timers.size).toBe(0); // finalize 收尾清掉了失败期的重试定时器
      // 正文共 8402 字（12×700 + 「开头」）→ 3 段文字补发（每段 ≤3500 字，保序）+ 最后 1 条 ⚠️ 收尾提示
      expect(pingTexts()).toHaveLength(4);
      expect(pingTexts()[0]).toContain("以下是完整回复（文字版，共 3 段）");
      expect(pingTexts()[0]).toContain("开头"); // startTurn 推的首段正文在第一段
      expect(pingTexts()[1]).toContain("（2/3）");
      expect(pingTexts()[2]).toContain("（3/3）");
      // 3 段都发成功 → 收尾如实说「完整回复已用文字版发在上面」（不再叫用户回 Flowship 看）
      expect(pingTexts()[3]).toContain("⚠️ 飞书卡片没能同步，完整回复已用文字版发在上面");
      expect(pingTexts()[3]).not.toContain("✅");
      // app 内提示不能被追发拖慢：终态 info（第 1 次 appendEvent）先于追发
      expect(appendEvent.mock.invocationCallOrder[0]!).toBeLessThan(
        larkMocks.sendTextMessage.mock.invocationCallOrder[0]!,
      );
    } finally {
      stop();
    }
  });

  it("建卡就失败（createCardEntity 抛错）：这一轮飞书里没有卡 → 追发 ⚠️ 而不是「✅ 已完成」，并落终态 info", async () => {
    const taskId = "t_int_start_fail";
    larkMocks.createCardEntity.mockRejectedValueOnce(
      new LarkApiError("no permission", { code: 99991672 }),
    );
    const { texts, stop } = collectInfos(taskId);
    try {
      await handleFeishuOutboundEvent(taskId, makeEvent("user_reply", "一问"));
      await handleFeishuOutboundEvent(taskId, {
        kind: "assistant_delta",
        text: "答".repeat(700),
      });
      await vi.waitFor(() => expect(larkMocks.createCardEntity).toHaveBeenCalled());
      await finishTurn(taskId);

      // 卡一张都没发出去，更谈不上更新
      expect(larkMocks.sendCardMessage).not.toHaveBeenCalled();
      expect(larkMocks.updateCardEntity).not.toHaveBeenCalled();
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("没能同步完整回复");
      expect(texts[0]).toContain("no permission");
      // 正文以文字补发（飞书里一张卡都没有，正文只在 app 里）+ 最后一条仍是 ⚠️ 收尾提示
      expect(pingTexts()).toHaveLength(2);
      expect(pingTexts()[0]).toContain("以下是完整回复");
      expect(pingTexts()[0]).toContain("答".repeat(700));
      expect(pingTexts()[1]).toContain("⚠️ 飞书卡片没能同步，完整回复已用文字版发在上面");
      expect(pingTexts()[1]).not.toContain("✅");
    } finally {
      stop();
    }
  });

  it("终稿限流一次后重试成功：卡片落成、不补发文字、追发仍是「✅ 已完成」", async () => {
    const taskId = "t_int_final_retry_ok";
    __setFinalRetryDelaysForTest([0, 0]);
    const { texts, stop } = collectInfos(taskId);
    try {
      await startTurn(taskId);
      // 只让「终稿」那一发（header 转绿 = finalize 的整卡 PUT）吃一次限流。
      // 不能用 mockClear + mockRejectedValueOnce：startTurn 只等到「卡已发出」，建卡链后面
      // 紧跟的首发整卡 PUT（蓝色「生成中」）在慢机器上会落在 mockClear 之后，被它抢走这次限流，
      // 终稿反而一发成功、总次数也变成 3（CI 上就这么偶发红过）。
      let finalRateLimited = false;
      larkMocks.updateCardEntity.mockImplementation(
        async (_cardId: string, json: { header?: { template?: string } }) => {
          if (!finalRateLimited && json?.header?.template === "green") {
            finalRateLimited = true;
            throw new LarkApiError("rate limited", { code: 99991400 });
          }
          return undefined;
        },
      );
      await finishTurn(taskId);

      // 终稿整卡 PUT：限流一发 + 重试一发成功（蓝色的中途 PUT 不计）
      const finalPuts = (
        larkMocks.updateCardEntity.mock.calls as unknown as Array<
          [string, { header?: { template?: string } }]
        >
      ).filter((c) => c[1]?.header?.template === "green");
      expect(finalPuts).toHaveLength(2);
      expect(finalRateLimited).toBe(true);
      expect(texts).toEqual([]);
      expect(pingTexts()).toHaveLength(1);
      expect(pingTexts()[0]).toContain("✅ 已完成");
    } finally {
      stop();
    }
  });
});
