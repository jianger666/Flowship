/**
 * card-stream：按失败类别处置（R14 B4-3 · Q12a-06 / Q12a-07）
 *
 * B1 的熔断对所有失败一视同仁（连续 3 次失败跳闸、退避探测）。但有几类失败「再试也没用」或「可自愈」，
 * 一视同仁既白打请求、又让用户等一个注定不会来的恢复：
 *   - too_long（卡片体积 / Windows 命令行超限）：熔断 + 终稿收紧（正文 10k → 5k → 2.5k 字逐档重发）；
 *   - gone / auth（卡没了 / 没权限）：致命，终稿也不发（白等一个超时），app 内说清原因；
 *   - seq_conflict（300317）：抬高该卡序号、马上重发一次（一轮最多一次）；
 *   - stream_closed（流式被飞书关掉，200850 / 300309）：把 streaming_mode 重新打开再补推，有次数 / 间隔上限。
 * 限流 / 瞬时 / 未知仍走 B1 的 3 连败熔断（对照用例）。
 *
 * 假时间 + 假 lark-api，不联网、不起子进程。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CardStreamHandle, CardStreamOptions } from "@/lib/server/feishu-bridge/types";

const TMP = path.join(os.tmpdir(), `feishu-bridge-kinds-${Date.now()}`);
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
    createCardEntity: vi.fn<AnyFn>(async () => ({ card_id: "card_kinds" })),
    sendCardMessage: vi.fn<AnyFn>(async () => ({ chat_id: "oc_test", message_id: "om_test" })),
    batchUpdateCard: vi.fn<AnyFn>(async () => undefined),
    getBotAppInfo: vi.fn<AnyFn>(async () => ({ appId: "cli_test", ownerOpenId: "ou_test" })),
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

const { createCardStream, __setCardStreamTimersForTest } = await import(
  "@/lib/server/feishu-bridge/card-stream"
);
const { flushCardSeqToDisk, __resetCardSeqForTest } = await import(
  "@/lib/server/feishu-bridge/card-seq"
);
const { LarkApiError } = await import("@/lib/server/feishu-bridge/types");
const { findAskCards } = await import("@/lib/server/feishu-bridge/card-map");

const pending = new Set<ReturnType<typeof setTimeout>>();
const pendingTimers = (): number => pending.size;

let answer = "";
/** 每次 +700 字：一次越过 600 字阈值，push 即入 flush */
const grow = (stream: CardStreamHandle, chars = 700): void => {
  answer += "答".repeat(chars);
  stream.pushAnswer(answer);
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(0);
};

let seqNo = 0;
const startStream = async (over: Partial<CardStreamOptions> = {}): Promise<CardStreamHandle> => {
  seqNo += 1;
  const stream = createCardStream(`t_kinds_${seqNo}`, { title: "测", ...over });
  await stream.start();
  return stream;
};

/** 首个 pushAnswer 会触发 header 整卡 PUT；先热身一发成功的 flush，再清零计数 */
const warmUp = async (stream: CardStreamHandle): Promise<void> => {
  grow(stream);
  await settle();
  for (const m of [updateCardEntity, updateCardElementContent, batchUpdateCard, patchCardSettings]) {
    m.mockClear();
  }
};

// ---- 错误样例 ----
const argvTooLong = (): InstanceType<typeof LarkApiError> =>
  new LarkApiError("命令行过长（约 41000 字符，Windows 上限 32767），未发送给 lark-cli", {
    code: "ARGV_TOO_LONG",
    api: "api PUT /open-apis/cardkit/v1/cards/c",
  });
const sizeLimit = (): InstanceType<typeof LarkApiError> =>
  new LarkApiError("Card content exceeds limit.", { code: 200860 });
const cardGone = (): InstanceType<typeof LarkApiError> =>
  new LarkApiError("The card entity does not exist", { code: 200740 });
const noScope = (consoleUrl?: string): InstanceType<typeof LarkApiError> =>
  new LarkApiError("Access denied", { code: 99991672, consoleUrl });
const seqConflict = (): InstanceType<typeof LarkApiError> =>
  new LarkApiError("The sequence number for operating on the card did not increment consecutively", {
    code: 300317,
  });
const streamClosed = (code: number = 300309): InstanceType<typeof LarkApiError> =>
  new LarkApiError(code === 300309 ? "Card streaming closed" : "Card streaming timeout", { code });
const rateLimited = (): InstanceType<typeof LarkApiError> =>
  new LarkApiError("rate limited", { code: 99991400 });

/** 在卡片 JSON 里按 element_id 找元素的 content（嵌套在 panel 里也找得到） */
const contentOf = (node: unknown, elementId: string): string | undefined => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = contentOf(item, elementId);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (rec.element_id === elementId && typeof rec.content === "string") return rec.content;
    for (const v of Object.values(rec)) {
      const hit = contentOf(v, elementId);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
};
const answerOf = (cardJson: unknown): string => contentOf(cardJson, "md_answer") ?? "";
/** 第 n 次 updateCardEntity 调用里的整卡 JSON */
const entityJson = (n: number): unknown => (updateCardEntity.mock.calls[n] as unknown as [string, unknown])[1];
/** 第 n 次 updateCardEntity 调用的 sequence */
const entitySeq = (n: number): number => (updateCardEntity.mock.calls[n] as unknown as [string, unknown, number])[2];
const contentSeq = (n: number): number =>
  (updateCardElementContent.mock.calls[n] as unknown as [string, string, string, number])[3];

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  await __resetCardSeqForTest();
  for (const m of [
    updateCardElementContent,
    updateCardEntity,
    patchCardSettings,
    createCardEntity,
    sendCardMessage,
    batchUpdateCard,
    getBotAppInfo,
  ]) {
    m.mockReset();
  }
  updateCardElementContent.mockResolvedValue(undefined);
  updateCardEntity.mockResolvedValue(undefined);
  patchCardSettings.mockResolvedValue(undefined);
  batchUpdateCard.mockResolvedValue(undefined);
  createCardEntity.mockResolvedValue({ card_id: "card_kinds" });
  sendCardMessage.mockResolvedValue({ chat_id: "oc_test", message_id: "om_test" });
  getBotAppInfo.mockResolvedValue({ appId: "cli_test", ownerOpenId: "ou_test" });
  answer = "";
  pending.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
  __setCardStreamTimersForTest(
    (cb, ms) => {
      const id = setTimeout(() => {
        pending.delete(id);
        cb();
      }, ms);
      pending.add(id);
      return id;
    },
    (id) => {
      pending.delete(id);
      clearTimeout(id);
    },
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  __setCardStreamTimersForTest(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  await flushCardSeqToDisk();
});

describe("too_long：内容超限 → 熔断 + 终稿收紧", () => {
  it("流式中途一发撞上 ARGV_TOO_LONG：当场熔断（不等 3 连败）、立刻通知一次、之后零请求零定时器", async () => {
    const onBreakerOpen = vi.fn();
    const stream = await startStream({ onBreakerOpen });
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(argvTooLong());
    grow(stream);
    await settle();

    expect(stream.getHealth()).toMatchObject({
      breakerOpen: true,
      fatalKind: "too_long",
      consecutiveFails: 0,
      failCount: 1,
    });
    expect(onBreakerOpen).toHaveBeenCalledTimes(1);
    expect(onBreakerOpen.mock.calls[0]![0]).toMatchObject({ fatalKind: "too_long", retryInMs: 0 });
    expect(pendingTimers()).toBe(0);

    for (const m of [updateCardElementContent, updateCardEntity, batchUpdateCard, patchCardSettings]) m.mockClear();
    for (let i = 0; i < 5; i += 1) {
      grow(stream);
      await settle();
    }
    await vi.advanceTimersByTimeAsync(120_000); // 没有半开探测：致命故障不会自己恢复
    expect(updateCardElementContent).not.toHaveBeenCalled();
    expect(updateCardEntity).not.toHaveBeenCalled();
    expect(batchUpdateCard).not.toHaveBeenCalled();
    expect(pendingTimers()).toBe(0);
  });

  it("飞书侧回卡片体积超限（200860）同样是致命：不论是哪一类写调用（这里是 header 整卡 PUT）", async () => {
    const onBreakerOpen = vi.fn();
    const stream = await startStream({ onBreakerOpen });
    updateCardEntity.mockRejectedValueOnce(sizeLimit()); // 首个 pushAnswer 触发 header 整卡 PUT
    grow(stream);
    await settle();
    expect(stream.getHealth()).toMatchObject({ breakerOpen: true, fatalKind: "too_long" });
    expect(onBreakerOpen).toHaveBeenCalledTimes(1);
  });

  it("致命后 finalize：第一发就用收紧后的内容（正文 ≤ 10000 字、过程区 ≤ 5000 字、带截断提示），成功后恢复且标记 truncated", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(argvTooLong());
    grow(stream, 30_000);
    await settle();
    stream.pushProcess("过".repeat(20_000));
    await settle();
    expect(stream.getHealth().fatalKind).toBe("too_long");
    for (const m of [updateCardElementContent, updateCardEntity, batchUpdateCard]) m.mockClear();

    await stream.finalize({ ok: true });

    expect(updateCardEntity).toHaveBeenCalledTimes(1); // 第一发就够，不白撞
    const text = answerOf(entityJson(0));
    expect(text.length).toBe(10_000);
    expect(text).toContain("内容过长，完整回复在 app 内查看");
    expect(text.startsWith("答".repeat(100))).toBe(true); // 留的是开头
    const processPut = (batchUpdateCard.mock.calls[0] as unknown as [string, Array<{ params: { element: { content: string } } }>])[1];
    expect(processPut[0]!.params.element.content.length).toBe(5000);
    expect(stream.getHealth()).toMatchObject({
      finalizeOk: true,
      truncated: true,
      breakerOpen: false,
      fatalKind: undefined,
    });
  });

  it("终稿还是被拒：逐档收紧 10000 → 5000 → 2500 字重发，第 3 发成功", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(argvTooLong());
    grow(stream, 30_000);
    await settle();
    updateCardEntity.mockClear();
    updateCardEntity.mockRejectedValueOnce(sizeLimit()).mockRejectedValueOnce(argvTooLong());

    await stream.finalize({ ok: true });

    expect(updateCardEntity).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((i) => answerOf(entityJson(i)).length)).toEqual([10_000, 5000, 2500]);
    expect(stream.getHealth()).toMatchObject({ finalizeOk: true, truncated: true });
  });

  it("三档都被拒：不再重试（共 3 发），finalizeOk=false，原因留着", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(argvTooLong());
    grow(stream, 30_000);
    await settle();
    updateCardEntity.mockClear();
    updateCardEntity.mockRejectedValue(sizeLimit());

    await stream.finalize({ ok: true });

    expect(updateCardEntity).toHaveBeenCalledTimes(3);
    const h = stream.getHealth();
    expect(h.finalizeOk).toBe(false);
    expect((h.lastError as InstanceType<typeof LarkApiError>).code).toBe(200860);
  });

  it("没有中途致命、终稿这一发才撞上超限：第一发带全文，被拒后收紧到第一档重发", async () => {
    const stream = await startStream();
    await warmUp(stream);
    grow(stream, 30_000); // flush 成功，内容 30700 字
    await settle();
    updateCardEntity.mockClear();
    updateCardEntity.mockRejectedValueOnce(sizeLimit());

    await stream.finalize({ ok: true });

    expect(updateCardEntity).toHaveBeenCalledTimes(2);
    expect(answerOf(entityJson(0)).length).toBe(30_700);
    expect(answerOf(entityJson(1)).length).toBe(10_000);
    expect(stream.getHealth()).toMatchObject({ finalizeOk: true, truncated: true });
  });

  it("内容本来就不长：收紧不会截（truncated 不置位），照样发完", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(argvTooLong());
    grow(stream); // 只有 1400 字
    await settle();
    updateCardEntity.mockClear();

    await stream.finalize({ ok: true });

    expect(answerOf(entityJson(0)).length).toBe(1400);
    expect(stream.getHealth()).toMatchObject({ finalizeOk: true });
    expect(stream.getHealth().truncated).toBeUndefined();
  });

  it("非流式：建卡这一发被拒（超限）→ 收紧后重发，卡只发一次", async () => {
    const stream = await startStream({ streaming: false });
    stream.pushAnswer("答".repeat(30_000));
    createCardEntity.mockClear();
    createCardEntity.mockRejectedValueOnce(sizeLimit());

    await stream.finalize({ ok: true });

    expect(createCardEntity).toHaveBeenCalledTimes(2);
    const lens = createCardEntity.mock.calls.map((c) => answerOf((c as unknown as [unknown])[0]).length);
    expect(lens).toEqual([30_000, 10_000]);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
    expect(stream.getHealth()).toMatchObject({ finalizeOk: true, truncated: true });
  });

  it("致命的 too_long 之后，任何一次写成功（这里是强试的重试按钮）就是恢复的证据：熔断关、致命标记清", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(argvTooLong());
    grow(stream);
    await settle();
    expect(stream.getHealth().breakerOpen).toBe(true);

    await stream.appendRetryButton("再试");

    expect(batchUpdateCard).toHaveBeenCalledTimes(1);
    expect(stream.getHealth()).toMatchObject({ breakerOpen: false, fatalKind: undefined });
  });
});

describe("gone / auth：致命，终稿也不发", () => {
  it("卡片不存在（200740）：当场致命 + 通知一次；之后零请求；finalize 不发任何请求，finalizeOk=false，原因留着", async () => {
    const onBreakerOpen = vi.fn();
    const stream = await startStream({ onBreakerOpen });
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(cardGone());
    grow(stream);
    await settle();

    expect(stream.getHealth()).toMatchObject({ breakerOpen: true, fatalKind: "gone", consecutiveFails: 0 });
    expect(onBreakerOpen).toHaveBeenCalledTimes(1);
    expect(onBreakerOpen.mock.calls[0]![0]).toMatchObject({ fatalKind: "gone" });

    for (const m of [updateCardElementContent, updateCardEntity, batchUpdateCard, patchCardSettings]) m.mockClear();
    grow(stream);
    await settle();
    await stream.finalize({ ok: true });

    for (const m of [updateCardElementContent, updateCardEntity, batchUpdateCard, patchCardSettings]) {
      expect(m).not.toHaveBeenCalled();
    }
    const h = stream.getHealth();
    expect(h.finalizeOk).toBe(false);
    expect(h.breakerOpen).toBe(true);
    expect((h.lastError as InstanceType<typeof LarkApiError>).code).toBe(200740);
    expect(pendingTimers()).toBe(0);
  });

  it("卡没了之后 appendAskUser / appendRetryButton 也不发请求（按钮发不出去，别白等一个超时）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(cardGone());
    grow(stream);
    await settle();
    batchUpdateCard.mockClear();
    updateCardEntity.mockClear();

    await stream.appendRetryButton("x");
    await stream.appendAskUser({ askId: "a1", questions: [{ id: "q1", question: "选哪个？" }] });

    expect(batchUpdateCard).not.toHaveBeenCalled();
    expect(updateCardEntity).not.toHaveBeenCalled();
  });

  it("没权限（99991672）：致命；通知里的错误带着引导链接（consoleUrl 不被瘦身丢掉）；finalize 不发", async () => {
    const onBreakerOpen = vi.fn();
    const stream = await startStream({ onBreakerOpen });
    await warmUp(stream);
    const url = "https://open.feishu.cn/app/cli_x/auth?q=cardkit:card:write";
    updateCardElementContent.mockRejectedValueOnce(noScope(url));
    grow(stream);
    await settle();

    expect(stream.getHealth()).toMatchObject({ breakerOpen: true, fatalKind: "auth" });
    const info = onBreakerOpen.mock.calls[0]![0] as { fatalKind: string; error: InstanceType<typeof LarkApiError> };
    expect(info.fatalKind).toBe("auth");
    expect(info.error).toBeInstanceOf(LarkApiError);
    expect(info.error.consoleUrl).toBe(url);
    expect(info.error.raw).toBeUndefined();

    updateCardEntity.mockClear();
    await stream.finalize({ ok: true });
    expect(updateCardEntity).not.toHaveBeenCalled();
    expect(stream.getHealth().finalizeOk).toBe(false);
  });

  it("只有权限违规清单、没有错误码的失败也是 auth", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(
      new LarkApiError("denied", { permissionViolations: [{ subject: "cardkit:card:write" }] }),
    );
    grow(stream);
    await settle();
    expect(stream.getHealth().fatalKind).toBe("auth");
  });

  it("引导链接过长时限到 400 字（慢变量不能无限占内存 / 刷屏）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(noScope(`https://open.feishu.cn/${"a".repeat(2000)}`));
    grow(stream);
    await settle();
    const err = stream.getHealth().lastError as InstanceType<typeof LarkApiError>;
    expect(err.consoleUrl!.length).toBeLessThanOrEqual(400);
  });

  it.each([
    ["卡片不存在", cardGone],
    ["没权限", () => noScope()],
    ["命令行超长", argvTooLong],
  ])("start 阶段的 %s 不走致命通道：只计 1 次失败、不通知（还没有卡可停；finalize 按 startFailed 收口）", async (_label, make) => {
    const onBreakerOpen = vi.fn();
    createCardEntity.mockRejectedValueOnce(make());
    const stream = createCardStream("t_kinds_start", { title: "测", onBreakerOpen });
    await stream.start();
    expect(stream.getHealth()).toMatchObject({ breakerOpen: false, consecutiveFails: 1, failCount: 1 });
    expect(stream.getHealth().fatalKind).toBeUndefined();
    expect(onBreakerOpen).not.toHaveBeenCalled();
    await stream.finalize({ ok: true });
    expect(stream.getHealth().finalizeOk).toBe(false);
  });
});

describe("seq_conflict：抬高序号、马上重发一次", () => {
  it("一次 300317：不计入连续失败、不跳闸；马上重发，序号比失败那发高出 ≥ 1000，成功后一切归零", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(seqConflict());
    grow(stream);
    await settle();

    expect(updateCardElementContent).toHaveBeenCalledTimes(2); // 失败 + 重发
    expect(contentSeq(1)).toBeGreaterThanOrEqual(contentSeq(0) + 1000);
    expect(stream.getHealth()).toMatchObject({ consecutiveFails: 0, failCount: 1, breakerOpen: false });
    expect(stream.getHealth().fatalKind).toBeUndefined();
    // 重发带的是完整全量
    const sent = (updateCardElementContent.mock.calls[1] as unknown as [string, string, string])[2];
    expect(sent).toBe(answer);
  });

  it("重发还是 300317：一轮只自愈一次，第二次按普通失败计（不死循环）；成功之后又可以再自愈", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent
      .mockRejectedValueOnce(seqConflict())
      .mockRejectedValueOnce(seqConflict());
    grow(stream);
    await settle();
    expect(updateCardElementContent).toHaveBeenCalledTimes(2);
    expect(stream.getHealth()).toMatchObject({ consecutiveFails: 1, failCount: 2, breakerOpen: false });

    // 下一发成功：自愈额度复位
    grow(stream);
    await settle();
    expect(updateCardElementContent).toHaveBeenCalledTimes(3);
    expect(stream.getHealth().consecutiveFails).toBe(0);

    updateCardElementContent.mockRejectedValueOnce(seqConflict());
    grow(stream);
    await settle();
    expect(updateCardElementContent).toHaveBeenCalledTimes(5); // 又自愈了一次：失败 + 重发
    expect(stream.getHealth().consecutiveFails).toBe(0);
  });

  it("终稿撞 300317：抬高序号后原地重发一次，成功就是 finalizeOk", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardEntity.mockRejectedValueOnce(seqConflict());

    await stream.finalize({ ok: true });

    expect(updateCardEntity).toHaveBeenCalledTimes(2);
    expect(entitySeq(1)).toBeGreaterThanOrEqual(entitySeq(0) + 1000);
    expect(stream.getHealth()).toMatchObject({ finalizeOk: true, breakerOpen: false });
  });

  it("终稿连着两次 300317：只重发一次，之后记失败（finalizeOk=false）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardEntity.mockRejectedValue(seqConflict());

    await stream.finalize({ ok: true });

    expect(updateCardEntity).toHaveBeenCalledTimes(2);
    expect(stream.getHealth().finalizeOk).toBe(false);
  });
});

describe("stream_closed：流式被飞书关掉 → 重新打开再补推", () => {
  it.each([
    ["300309 流式已关闭", 300309],
    ["200850 流式超时自动关", 200850],
  ])("%s：用 settings 把 streaming_mode 设回 true，成功后马上补推落下的内容，不计入失败熔断", async (_label, code) => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(streamClosed(code));
    grow(stream);
    await settle();

    expect(patchCardSettings).toHaveBeenCalledTimes(1);
    const call = patchCardSettings.mock.calls[0] as unknown as [string, unknown, number, { timeoutMs: number }];
    expect(call[0]).toBe("card_kinds");
    expect(call[1]).toEqual({ config: { streaming_mode: true, update_multi: true } });
    expect(call[3]).toEqual({ timeoutMs: 8000 });

    expect(updateCardElementContent).toHaveBeenCalledTimes(2); // 失败 + 重开后的补推
    const sent = (updateCardElementContent.mock.calls[1] as unknown as [string, string, string])[2];
    expect(sent).toBe(answer);
    // 序号严格递增：失败那发 < 重开 < 补推
    expect(call[2]).toBeGreaterThan(contentSeq(0));
    expect(contentSeq(1)).toBeGreaterThan(call[2]);
    expect(stream.getHealth()).toMatchObject({ consecutiveFails: 0, failCount: 1, breakerOpen: false });
    expect(stream.getHealth().fatalKind).toBeUndefined();
  });

  it("两次重开至少隔 30 秒：间隔内再被关，按普通失败计（不连环重开）；过了间隔又可以重开", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(streamClosed());
    grow(stream);
    await settle();
    expect(patchCardSettings).toHaveBeenCalledTimes(1);

    updateCardElementContent.mockRejectedValueOnce(streamClosed());
    grow(stream);
    await settle();
    expect(patchCardSettings).toHaveBeenCalledTimes(1); // 间隔没到
    expect(stream.getHealth().consecutiveFails).toBe(1);

    await vi.advanceTimersByTimeAsync(31_000);
    updateCardElementContent.mockRejectedValueOnce(streamClosed());
    grow(stream);
    await settle();
    expect(patchCardSettings).toHaveBeenCalledTimes(2);
  });

  it("一张卡最多重开 8 次：第 9 次转致命（立刻通知一次、之后零请求）；finalize 仍整卡同步，成功后恢复", async () => {
    const onBreakerOpen = vi.fn();
    const stream = await startStream({ onBreakerOpen });
    await warmUp(stream);
    for (let i = 0; i < 8; i += 1) {
      updateCardElementContent.mockRejectedValueOnce(streamClosed());
      grow(stream);
      await settle();
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(patchCardSettings).toHaveBeenCalledTimes(8);
    expect(stream.getHealth().fatalKind).toBeUndefined();

    updateCardElementContent.mockRejectedValueOnce(streamClosed());
    grow(stream);
    await settle();
    expect(patchCardSettings).toHaveBeenCalledTimes(8); // 次数用完，不再重开
    expect(stream.getHealth()).toMatchObject({ breakerOpen: true, fatalKind: "stream_closed" });
    expect(onBreakerOpen).toHaveBeenCalledTimes(1);
    expect(onBreakerOpen.mock.calls[0]![0]).toMatchObject({ fatalKind: "stream_closed" });

    updateCardElementContent.mockClear();
    grow(stream);
    await settle();
    expect(updateCardElementContent).not.toHaveBeenCalled();

    updateCardEntity.mockClear();
    await stream.finalize({ ok: true });
    expect(updateCardEntity).toHaveBeenCalledTimes(1);
    expect(stream.getHealth()).toMatchObject({ finalizeOk: true, breakerOpen: false, fatalKind: undefined });
  });

  it("重开这一发自己失败：计入失败、不递归重开、不补推", async () => {
    const stream = await startStream();
    await warmUp(stream);
    patchCardSettings.mockRejectedValueOnce(new LarkApiError("boom"));
    updateCardElementContent.mockRejectedValueOnce(streamClosed());
    grow(stream);
    await settle();

    expect(patchCardSettings).toHaveBeenCalledTimes(1);
    expect(updateCardElementContent).toHaveBeenCalledTimes(1); // 没有补推
    expect(stream.getHealth()).toMatchObject({ consecutiveFails: 1, failCount: 2 });
  });

  it("重开请求本身又回 300309：同样只试这一次（间隔没到，不递归）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    patchCardSettings.mockRejectedValueOnce(streamClosed());
    updateCardElementContent.mockRejectedValueOnce(streamClosed());
    grow(stream);
    await settle();

    expect(patchCardSettings).toHaveBeenCalledTimes(1);
    expect(stream.getHealth().consecutiveFails).toBe(1);
  });

  it("finalize 期间的失败不分类、不重开：整卡 PUT 回 300309 → finalizeOk=false，没有额外的 settings 请求", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardEntity.mockRejectedValueOnce(streamClosed());

    await stream.finalize({ ok: true });

    expect(patchCardSettings).not.toHaveBeenCalled();
    expect(stream.getHealth().finalizeOk).toBe(false);
  });

  it("重开还在排队时又被关一次（链上排在它前面的下一发 flush 先到）：不再多排一个重开，settings 只发一次", async () => {
    const stream = await startStream();
    await warmUp(stream);
    // 第 1 发 content PUT 悬着；它在途期间再 push 一次，在链上排出第 2 个 flush
    let rejectFirst!: (e: unknown) => void;
    updateCardElementContent.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    updateCardElementContent.mockRejectedValueOnce(streamClosed()); // 第 2 发也被关
    grow(stream);
    await settle();
    grow(stream); // 越过阈值：链上现在是 [第 1 发（悬）, 第 2 个 flush]
    await settle();
    rejectFirst(streamClosed()); // 第 1 发失败 → 「重开」排到链尾（第 2 个 flush 之后）；第 2 个 flush 先跑、也失败
    await settle();
    await settle();

    expect(patchCardSettings).toHaveBeenCalledTimes(1); // 重开只排了一个
    expect(stream.getHealth()).toMatchObject({ consecutiveFails: 0, breakerOpen: false });
  });
});

describe("致命故障的收尾：健康度标记 / 待决定时器", () => {
  it.each([
    ["too_long（ARGV_TOO_LONG）", argvTooLong],
    ["gone（200740）", cardGone],
    ["auth（99991672）", () => noScope()],
  ])("%s：致命会把 breakerEverOpened 置位（终态提示 / 诊断靠它知道这张卡掉过线）", async (_label, make) => {
    const stream = await startStream();
    await warmUp(stream);
    expect(stream.getHealth().breakerEverOpened).toBe(false);
    updateCardElementContent.mockRejectedValueOnce(make());
    grow(stream);
    await settle();
    expect(stream.getHealth()).toMatchObject({ breakerOpen: true, breakerEverOpened: true });
  });

  it("致命发生时已经排着一个 250ms 节流定时器：当场清掉，不留空转的定时器", async () => {
    const stream = await startStream();
    await warmUp(stream);
    expect(pendingTimers()).toBe(0);
    let rejectPut!: (e: unknown) => void;
    updateCardElementContent.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPut = reject;
        }),
    );
    grow(stream); // 越过阈值：立刻 flush，这一发悬着
    await settle();
    stream.pushAnswer(`${answer}答`); // 在途期间再来一个字：不够阈值 → 排一个 250ms 节流定时器
    expect(pendingTimers()).toBe(1);
    rejectPut(cardGone()); // 悬着的这一发回「卡片不存在」→ 致命
    await settle();
    expect(stream.getHealth().fatalKind).toBe("gone");
    expect(pendingTimers()).toBe(0);
  });
});

describe("对照：限流 / 瞬时 / 未知仍走 B1 的 3 连败熔断（本批没改）", () => {
  it.each([
    ["限流 99991400", rateLimited],
    ["未知错误", () => new Error("boom")],
    ["断网", () => new Error("read ECONNRESET")],
  ])("%s：一次失败只计数，不跳闸、不致命、不重开、不自愈", async (_label, make) => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(make());
    grow(stream);
    await settle();

    expect(stream.getHealth()).toMatchObject({ consecutiveFails: 1, breakerOpen: false, failCount: 1 });
    expect(stream.getHealth().fatalKind).toBeUndefined();
    expect(patchCardSettings).not.toHaveBeenCalled();
    expect(updateCardElementContent).toHaveBeenCalledTimes(1); // 没有立刻重发
  });

  it("新增的健康度字段默认都是 undefined（不影响既有的整体断言）", async () => {
    const stream = await startStream();
    const h = stream.getHealth();
    expect(h.fatalKind).toBeUndefined();
    expect(h.truncated).toBeUndefined();
  });
});

/**
 * 状态机边界（变异预审补洞）：上面的用例守住了「每类失败各走各的策略」，这里守住策略之间的**交界**——
 * 通知只发几次、收尾之后还能不能动、重开排队时再败怎么记、致命标记什么时候才收紧终稿。
 * 每条都是「改错一个守卫，用户就会看到什么」的行为，不是内部实现细节。
 */
describe("交界：通知次数 / 收尾之后 / 重开排队 / 收紧的边界", () => {
  it("普通熔断已经通知过、之后探测又撞上「卡没了」：致命通知照发——两类通知各自最多一次，不共用「已通知」标记", async () => {
    const onBreakerOpen = vi.fn();
    const stream = await startStream({ onBreakerOpen });
    await warmUp(stream);
    updateCardElementContent.mockRejectedValue(rateLimited());
    for (let i = 0; i < 3; i += 1) {
      grow(stream);
      await settle();
    }
    expect(stream.getHealth().breakerOpen).toBe(true);
    expect(onBreakerOpen).not.toHaveBeenCalled(); // 第 1 次跳闸：小抖动不打扰用户

    await vi.advanceTimersByTimeAsync(2000); // 首次探测仍失败 → 第 2 次跳闸 → 普通通知
    expect(onBreakerOpen).toHaveBeenCalledTimes(1);
    expect(onBreakerOpen.mock.calls[0]![0]).toMatchObject({ retryInMs: 4000 });
    expect(onBreakerOpen.mock.calls[0]![0]).not.toHaveProperty("fatalKind");

    updateCardElementContent.mockRejectedValue(cardGone()); // 下一次探测：卡被删了
    await vi.advanceTimersByTimeAsync(4000);
    expect(stream.getHealth()).toMatchObject({ breakerOpen: true, fatalKind: "gone" });
    expect(onBreakerOpen).toHaveBeenCalledTimes(2); // 「不会好了」比「在退避」更要紧，不能被前一条吞掉
    expect(onBreakerOpen.mock.calls[1]![0]).toMatchObject({ fatalKind: "gone", retryInMs: 0 });
  });

  it("致命通知只发一次：内容超限致命之后，appendAskUser 这一发又撞上「卡没了」，不重复通知", async () => {
    const onBreakerOpen = vi.fn();
    const stream = await startStream({ onBreakerOpen });
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(argvTooLong());
    grow(stream);
    await settle();
    expect(onBreakerOpen).toHaveBeenCalledTimes(1);
    expect(onBreakerOpen.mock.calls[0]![0]).toMatchObject({ fatalKind: "too_long" });

    batchUpdateCard.mockRejectedValueOnce(cardGone()); // 超限不挡 appendAskUser：这一发会发出去，并撞上「卡没了」
    await stream.appendAskUser({ askId: "a1", questions: [{ id: "q1", question: "选哪个？" }] });

    expect(batchUpdateCard).toHaveBeenCalledTimes(1);
    expect(onBreakerOpen).toHaveBeenCalledTimes(1); // 用户已经被告知「这张卡掉线了」，不再刷第二条
  });

  it.each([
    ["内容超限", argvTooLong],
    ["卡没了", cardGone],
    ["没权限", () => noScope()],
  ])("致命（%s）之后再来 push：不排任何探测 / 节流定时器——致命故障没有半开，不留空转的定时器", async (_label, make) => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(make());
    grow(stream);
    await settle();
    expect(stream.getHealth().breakerOpen).toBe(true);
    expect(pendingTimers()).toBe(0);

    grow(stream); // 越过阈值：走 scheduleFlush 的熔断分支，必须立刻就是零定时器（不能等它触发后自己消失）
    expect(pendingTimers()).toBe(0);
    stream.pushAnswer(`${answer}答`); // 不够阈值的小增量：同样不排 250ms 节流
    expect(pendingTimers()).toBe(0);
    await settle();
    expect(pendingTimers()).toBe(0);
  });

  it("没权限之后 appendAskUser / appendRetryButton 同样不发请求（与「卡没了」是同一条规则），致命状态不被误清", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(noScope());
    grow(stream);
    await settle();
    expect(stream.getHealth()).toMatchObject({ breakerOpen: true, fatalKind: "auth" });
    batchUpdateCard.mockClear();
    updateCardEntity.mockClear();

    await stream.appendAskUser({ askId: "a1", questions: [{ id: "q1", question: "选哪个？" }] });
    await stream.appendRetryButton("x");

    expect(batchUpdateCard).not.toHaveBeenCalled();
    expect(updateCardEntity).not.toHaveBeenCalled();
    // 若这里误发了且成功，recordSuccess 会把致命标记清掉、熔断关上——飞书侧其实还是没权限
    expect(stream.getHealth()).toMatchObject({ breakerOpen: true, fatalKind: "auth" });
  });

  it("卡没了、finalize 收尾之后迟到的 appendAskUser：不发请求、不登记 ask 索引（靠 finalized 收口，不是靠致命标记兜底）", async () => {
    const stream = createCardStream("t_kinds_late_ask", { title: "测" });
    await stream.start();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(cardGone());
    grow(stream);
    await settle();
    expect(stream.getHealth().fatalKind).toBe("gone");

    // 对照：致命但还没收尾时，ask 索引照常登记（用户之后在 app 里答题，卡面能置态）——证明下面的「空」不是观测手段失灵
    await stream.appendAskUser({ askId: "a_early", questions: [{ id: "q1", question: "先问的" }] });
    expect(await findAskCards("t_kinds_late_ask", "a_early")).toHaveLength(1);

    await stream.finalize({ ok: true }); // 卡没了：不发请求，本地收口
    for (const m of [updateCardEntity, batchUpdateCard, patchCardSettings, updateCardElementContent]) m.mockClear();

    await stream.appendAskUser({ askId: "a_late", questions: [{ id: "q1", question: "收尾后才问的" }] });
    await stream.appendRetryButton("x");

    expect(batchUpdateCard).not.toHaveBeenCalled();
    expect(updateCardEntity).not.toHaveBeenCalled();
    expect(await findAskCards("t_kinds_late_ask", "a_late")).toEqual([]); // 已收尾的卡不再认领新的提问
  });

  it("finalize 里这一发 flush 才撞上「卡没了」：不分类、不致命、不通知；终稿照常发出并成功（终态里的失败只记账）", async () => {
    const onBreakerOpen = vi.fn();
    const stream = await startStream({ onBreakerOpen });
    await warmUp(stream);
    answer += "补";
    stream.pushAnswer(answer); // 小增量：只排 250ms 节流，不立即 flush；finalize 会清掉它、自己在链上刷
    updateCardElementContent.mockRejectedValueOnce(cardGone()); // 这一发就是 finalize 内的 doFlush
    updateCardEntity.mockClear();

    await stream.finalize({ ok: true });

    expect(updateCardElementContent).toHaveBeenCalledTimes(1);
    expect(updateCardEntity).toHaveBeenCalledTimes(1); // 终稿没被拦（「卡没了」的早退在 flush 之前就判过了）
    expect(answerOf(entityJson(0))).toBe(answer);
    expect(onBreakerOpen).not.toHaveBeenCalled(); // 终稿马上就要成功了，不能这时候喊「卡没了」
    const h = stream.getHealth();
    expect(h).toMatchObject({ finalizeOk: true, breakerOpen: false, breakerEverOpened: false, consecutiveFails: 0 });
    expect(h.fatalKind).toBeUndefined();
  });

  it("重开次数用完转致命：不再多记一次连续失败；终稿第一发带全文（只有内容超限才收紧，别的致命不动内容）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    for (let i = 0; i < 8; i += 1) {
      updateCardElementContent.mockRejectedValueOnce(streamClosed());
      grow(stream);
      await settle();
      await vi.advanceTimersByTimeAsync(31_000);
    }
    updateCardElementContent.mockRejectedValueOnce(streamClosed());
    grow(stream);
    await settle();
    // 转致命就是转致命：这一次失败已经「处理完了」，不再按普通失败多记一笔（否则健康度里连败数虚高）
    expect(stream.getHealth()).toMatchObject({ breakerOpen: true, fatalKind: "stream_closed", consecutiveFails: 0 });

    grow(stream, 15_000); // 致命后的 push 只记在 desired 里（零请求）；总长约 22000 字，超过第一档预算 10000
    await settle();
    updateCardEntity.mockClear();
    await stream.finalize({ ok: true });

    expect(updateCardEntity).toHaveBeenCalledTimes(1);
    const text = answerOf(entityJson(0));
    expect(text).toBe(answer); // 全文，没有被截头
    expect(text).not.toContain("内容过长，完整回复在 app 内查看");
    expect(stream.getHealth()).toMatchObject({ finalizeOk: true });
    expect(stream.getHealth().truncated).toBeUndefined();
  });

  it("重开排队中又被关：第二次失败不计入连续失败（重开已经在路上，不是又一次独立故障）——在重开请求还悬着时就看", async () => {
    const stream = await startStream();
    await warmUp(stream);
    let rejectFirst!: (e: unknown) => void;
    updateCardElementContent.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    updateCardElementContent.mockRejectedValueOnce(streamClosed()); // 第 2 个 flush 也被关
    let releaseReopen!: () => void;
    patchCardSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseReopen = resolve;
        }),
    ); // 重开请求悬着：让我们能在「重开成功、recordSuccess 清零」之前读健康度
    grow(stream);
    await settle();
    grow(stream); // 链上：[第 1 发（悬）, 第 2 个 flush]
    await settle();
    rejectFirst(streamClosed()); // 第 1 发失败 → 重开排到链尾；第 2 个 flush 先跑、再败（此刻重开还在排队）
    await settle();
    await settle();

    expect(patchCardSettings).toHaveBeenCalledTimes(1); // 重开已经在发、停在飞行中
    expect(stream.getHealth()).toMatchObject({ consecutiveFails: 0, breakerOpen: false });

    releaseReopen();
    await settle();
    expect(updateCardElementContent.mock.calls.length).toBeGreaterThanOrEqual(3); // 重开成功后补推了落下的内容
    expect(stream.getHealth()).toMatchObject({ consecutiveFails: 0, breakerOpen: false });
  });

  it("finalize 已排在链上、悬着的那发 PUT 之后才败为「流式被关」：重开不会在终稿之后把流式模式又打开（卡会一直显示生成中）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    let rejectPut!: (e: unknown) => void;
    updateCardElementContent.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPut = reject;
        }),
    );
    grow(stream); // 越过阈值：立刻 flush，这一发悬着
    await settle();
    const fin = stream.finalize({ ok: true }); // 排在悬着的那发后面（此刻 finalize 的 op 还没开始，finalizing 仍是 false）
    rejectPut(streamClosed()); // 悬着的这一发败 → 排了一个重开，落在 finalize 之后
    await fin;
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);

    const modes = patchCardSettings.mock.calls.map(
      (c) => (c as unknown as [string, { config: { streaming_mode: boolean } }])[1].config.streaming_mode,
    );
    expect(modes).toEqual([false]); // 只有 finalize 自己关流式的这一次；排在后面的重开执行时发现已收尾，直接放弃
    expect(stream.getHealth()).toMatchObject({ finalizeOk: true });
  });

  it.each([
    ["正文恰好 10000 字（= 第一档预算）", 9_300, 0, { answerCut: false, processCut: false }],
    ["正文 10001 字（多 1 字）", 9_301, 0, { answerCut: true, processCut: false }],
    ["过程区恰好 5000 字（= 第一档预算的一半）", 700, 5_000, { answerCut: false, processCut: false }],
    ["过程区 5001 字（多 1 字）", 700, 5_001, { answerCut: false, processCut: true }],
  ])("收紧的边界：%s——恰好等于预算不截、多 1 字才截（truncated 只在真截了时置位）", async (_label, answerGrow, processChars, want) => {
    const hint = "内容过长，完整回复在 app 内查看";
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(argvTooLong()); // 致命：收紧到第一档
    grow(stream, answerGrow);
    await settle();
    if (processChars > 0) {
      stream.pushProcess("过".repeat(processChars));
      await settle();
    }
    expect(stream.getHealth().fatalKind).toBe("too_long");
    for (const m of [updateCardEntity, batchUpdateCard]) m.mockClear();

    await stream.finalize({ ok: true });

    const answerText = answerOf(entityJson(0));
    expect(answerText.includes(hint)).toBe(want.answerCut);
    expect(answerText.length).toBe(answer.length > 10_000 ? 10_000 : answer.length);
    if (processChars > 0) {
      const processPut = (
        batchUpdateCard.mock.calls[0] as unknown as [string, Array<{ params: { element: { content: string } } }>]
      )[1];
      const processText = processPut[0]!.params.element.content;
      expect(processText.includes(hint)).toBe(want.processCut);
      expect(processText.length).toBe(Math.min(processChars, 5_000));
    }
    const wantTruncated = want.answerCut || want.processCut;
    expect(stream.getHealth().truncated).toBe(wantTruncated ? true : undefined);
  });

  it("非流式建卡撞 300317：不做序号自愈（这时还没有卡、没有序号可抬）——不重发、不发卡，finalizeOk=false", async () => {
    const stream = await startStream({ streaming: false });
    stream.pushAnswer("答案");
    createCardEntity.mockClear();
    createCardEntity.mockRejectedValueOnce(seqConflict());

    await stream.finalize({ ok: true });

    expect(createCardEntity).toHaveBeenCalledTimes(1);
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(stream.getHealth().finalizeOk).toBe(false);
  });
});
