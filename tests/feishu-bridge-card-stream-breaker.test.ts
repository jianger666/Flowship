/**
 * card-stream：flush 合并 + 失败熔断（R14 P1-1 / A1 · Q12a-01..04）
 *
 * 线上形态：飞书限流 / 断网 / 黑洞时，节流器照 250ms 一次地发整卡 PUT（argv 可达数十 KB），
 * 失败既不回滚「已推」快照也不退避，needHeader 路径还把 headerDirty 粘住——一轮长回复下来
 * 几千个 lark-cli 子进程；它们又全排在进程级单飞队列里，别的任务的飞书写操作一起陪等。
 * finalize 失败更是没有任何对外信号（只 console.warn），用户只会收到一条「✅ 已完成」。
 *
 * 这里用假时间 + 假 lark-api 钉住：
 *   合并（不丢最后一次内容）/ 熔断（阈值、半开探测、退避翻倍封顶、恢复清零）/
 *   失败回滚后补发完整全量 / finalize 与 append 在熔断中仍强试一次 /
 *   对外健康度 / 超时参数 / 5 分钟永久失败的请求总量。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CardStreamHandle,
  CardStreamOptions,
} from "@/lib/server/feishu-bridge/types";

const TMP = path.join(os.tmpdir(), `feishu-bridge-breaker-${Date.now()}`);
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

const { createCardStream, __setCardStreamTimersForTest } = await import(
  "@/lib/server/feishu-bridge/card-stream"
);
const { flushCardSeqToDisk } = await import(
  "@/lib/server/feishu-bridge/card-seq"
);
const { LarkApiError } = await import("@/lib/server/feishu-bridge/types");

/** card-stream 自己当前挂着的定时器（card-seq 等模块也会挂定时器，不能直接数全局的） */
const pending = new Set<ReturnType<typeof setTimeout>>();
const pendingTimers = (): number => pending.size;

/** 本用例累计到的正文全量（pushAnswer 要求单调增长） */
let answer = "";
/** 每次 +700 字：一次就越过 600 字阈值，push 即入 flush，不用等 250ms */
const grow = (stream: CardStreamHandle, chars = 700): void => {
  answer += "答".repeat(chars);
  stream.pushAnswer(answer);
};

/** 让已排好的微任务 / 假时间 0ms 定时器跑完 */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

const gate = (): { p: Promise<void>; release: () => void } => {
  let release!: () => void;
  const p = new Promise<void>((r) => {
    release = r;
  });
  return { p, release };
};

const rateLimited = (): InstanceType<typeof LarkApiError> =>
  new LarkApiError("rate limited", { code: 99991400 });

let seq = 0;
const startStream = async (
  over: Partial<CardStreamOptions> = {},
): Promise<CardStreamHandle> => {
  seq += 1;
  const stream = createCardStream(`t_brk_${seq}`, { title: "测", ...over });
  await stream.start();
  return stream;
};

/**
 * 首个 pushAnswer 会触发 indigo→blue 的 header 整卡 PUT；先热身一发成功的 flush，
 * 让后面的用例走纯内容 PUT 路径，并把调用计数清零。
 */
const warmUp = async (stream: CardStreamHandle): Promise<void> => {
  grow(stream);
  await settle();
  updateCardEntity.mockClear();
  updateCardElementContent.mockClear();
  batchUpdateCard.mockClear();
  patchCardSettings.mockClear();
};

/** 让正文 content PUT 连续失败 3 次 → 熔断打开（窗口 2s） */
const tripBreaker = async (stream: CardStreamHandle): Promise<void> => {
  updateCardElementContent.mockRejectedValue(rateLimited());
  for (let i = 0; i < 3; i++) {
    grow(stream);
    await settle();
  }
};

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
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
  createCardEntity.mockResolvedValue({ card_id: "card_test" });
  sendCardMessage.mockResolvedValue({
    chat_id: "oc_test",
    message_id: "om_test",
  });
  getBotAppInfo.mockResolvedValue({
    appId: "cli_test",
    ownerOpenId: "ou_test",
  });
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
  // 长时间推进假时间会触发 card-seq 的落盘定时器，异步写盘在用例结束后还在飞——
  // 等它写完，否则下个用例删数据目录会撞 ENOTEMPTY
  await flushCardSeqToDisk();
});

describe("初始健康度", () => {
  it("没发生过失败：全部归零；start 失败只记账、不抛", async () => {
    const stream = createCardStream("t_brk_init", { title: "测" });
    expect(stream.getHealth()).toEqual({
      failCount: 0,
      consecutiveFails: 0,
      breakerOpen: false,
      breakerEverOpened: false,
      finalizeOk: undefined,
      lastError: undefined,
    });

    createCardEntity.mockRejectedValueOnce(new Error("no net"));
    await expect(stream.start()).resolves.toBeUndefined();
    expect(stream.getHealth()).toMatchObject({
      failCount: 1,
      consecutiveFails: 1,
      breakerOpen: false,
    });
    expect(stream.getHealth().lastError).toBeInstanceOf(Error);
  });
});

describe("flush 合并", () => {
  it("在途 flush 期间到达的 push 不会丢：op 开始执行时才清合并标记，之后新 push 还能再排一个", async () => {
    const stream = await startStream();
    await warmUp(stream);
    const g1 = gate();
    const g2 = gate();
    updateCardElementContent
      .mockImplementationOnce(async () => {
        await g1.p;
      })
      .mockImplementationOnce(async () => {
        await g2.p;
      });

    grow(stream); // flush #1 在途（挂在 g1）
    await settle();
    expect(updateCardElementContent).toHaveBeenCalledTimes(1);

    grow(stream); // 在途期间 push → 排队 flush #2
    grow(stream); // 并进 #2
    await settle();
    expect(updateCardElementContent).toHaveBeenCalledTimes(1);

    g1.release();
    await settle(); // #2 开始执行（挂在 g2）
    expect(updateCardElementContent).toHaveBeenCalledTimes(2);

    grow(stream); // #2 在途期间又 push → 必须还能再排 #3，否则这段内容要等到 finalize 才上屏
    await settle();
    g2.release();
    await settle();
    expect(updateCardElementContent).toHaveBeenCalledTimes(3);
    // 最新全量一次到位
    expect(updateCardElementContent.mock.calls.at(-1)![2]).toBe(answer);
  });
});

describe("熔断：阈值 / 退避 / 恢复", () => {
  it("连续 3 次失败 → 熔断打开；之后无论 push 多少次都不再发请求", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    expect(updateCardElementContent).toHaveBeenCalledTimes(3);
    expect(stream.getHealth()).toMatchObject({
      breakerOpen: true,
      consecutiveFails: 3,
      breakerEverOpened: true,
    });

    for (let i = 0; i < 50; i++) {
      grow(stream);
      await settle();
    }
    expect(updateCardElementContent).toHaveBeenCalledTimes(3);
  });

  it("中间只要有一次成功就清零连续计数：2 败 + 1 成 + 2 败 → 不开熔断", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited());
    for (let i = 0; i < 5; i++) {
      grow(stream);
      await settle();
    }
    expect(updateCardElementContent).toHaveBeenCalledTimes(5);
    expect(stream.getHealth()).toMatchObject({
      breakerOpen: false,
      consecutiveFails: 2,
      breakerEverOpened: false,
    });
    expect(stream.getFailCount()).toBe(4);
  });

  it("到期半开探测失败 → 立刻再跳闸、退避翻倍 2s→4s→8s→16s→30s 封顶；窗口内零请求、到期恰好一发探测", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    let calls = 3;
    expect(updateCardElementContent).toHaveBeenCalledTimes(calls);

    for (const windowMs of [2000, 4000, 8000, 16000, 30000, 30000]) {
      grow(stream); // 窗口内持续有新内容
      await vi.advanceTimersByTimeAsync(windowMs - 1);
      expect(updateCardElementContent).toHaveBeenCalledTimes(calls); // 窗口内零请求
      await vi.advanceTimersByTimeAsync(1); // 到期 → 半开探测
      calls += 1;
      expect(updateCardElementContent).toHaveBeenCalledTimes(calls); // 恰好一发
      expect(stream.getHealth().breakerOpen).toBe(true); // 探测失败 → 立刻再跳闸
    }
  });

  it("探测成功 → 恢复：熔断解除、连续计数清零，之后恢复正常 250ms / 字数节流", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    updateCardElementContent.mockResolvedValue(undefined); // lark 恢复
    await vi.advanceTimersByTimeAsync(2000); // 探测
    expect(stream.getHealth()).toMatchObject({
      breakerOpen: false,
      consecutiveFails: 0,
    });
    const before = updateCardElementContent.mock.calls.length;
    grow(stream);
    await settle();
    expect(updateCardElementContent).toHaveBeenCalledTimes(before + 1);
  });

  it("探测成功后退避清零：再次跳闸又从 2s 起，不是接着上次的 16s", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    // 探测失败两次：窗口涨到 8s
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(stream.getHealth().breakerOpen).toBe(true);
    // 恢复成功
    updateCardElementContent.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(8000);
    expect(stream.getHealth().breakerOpen).toBe(false);

    // 再次连续失败 3 次 → 新窗口应是 2s
    updateCardElementContent.mockRejectedValue(rateLimited());
    for (let i = 0; i < 3; i++) {
      grow(stream);
      await settle();
    }
    const calls = updateCardElementContent.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1999);
    expect(updateCardElementContent).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1);
    expect(updateCardElementContent).toHaveBeenCalledTimes(calls + 1);
  });

  it("熔断期间同一时刻只有一个探测定时器，不随 push 次数增长", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    expect(pendingTimers()).toBe(1);
    for (let i = 0; i < 200; i++) grow(stream);
    await settle();
    expect(pendingTimers()).toBe(1);
  });

  it("跳闸后即使再没有新 push 也会自己探测；探测补发的是完整全量（失败那发不会因快照已推进而被吞）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    expect(updateCardElementContent).toHaveBeenCalledTimes(3);

    updateCardElementContent.mockResolvedValue(undefined); // lark 恢复，之后再没有任何 push
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateCardElementContent).toHaveBeenCalledTimes(4);
    expect(updateCardElementContent.mock.calls.at(-1)![2]).toBe(answer);
    expect(stream.getHealth()).toMatchObject({
      breakerOpen: false,
      consecutiveFails: 0,
    });
  });

  it("header 整卡 PUT 失败 → headerDirty 粘住：恢复后补发整卡 PUT，且带最新 header", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardEntity.mockRejectedValue(rateLimited());
    for (let i = 0; i < 3; i++) {
      stream.setHeaderStatus(`步骤${i}`, "blue");
      await vi.advanceTimersByTimeAsync(250); // setHeaderStatus 走 250ms 节流
    }
    expect(updateCardEntity).toHaveBeenCalledTimes(3);
    expect(stream.getHealth().breakerOpen).toBe(true);

    updateCardEntity.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateCardEntity).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(updateCardEntity.mock.calls.at(-1)![1])).toContain(
      "步骤2",
    );
    expect(stream.getHealth().breakerOpen).toBe(false);
  });

  it("onBreakerOpen：小抖动（3 连败跳闸、首次探测就恢复）不通知", async () => {
    const onBreakerOpen = vi.fn();
    const stream = await startStream({ onBreakerOpen });
    await warmUp(stream);
    await tripBreaker(stream); // 第 1 次跳闸
    expect(stream.getHealth().breakerOpen).toBe(true);
    expect(onBreakerOpen).not.toHaveBeenCalled();

    updateCardElementContent.mockResolvedValue(undefined); // 2s 后的首次探测成功
    await vi.advanceTimersByTimeAsync(2000);
    expect(stream.getHealth()).toMatchObject({
      breakerOpen: false,
      consecutiveFails: 0,
      breakerEverOpened: true, // 开过熔断，只是没打扰用户
    });
    expect(onBreakerOpen).not.toHaveBeenCalled();
  });

  it("onBreakerOpen：首次探测仍失败才通知一次（每张卡最多一次：之后继续失败 / 恢复后再跳闸都不重复）", async () => {
    const onBreakerOpen = vi.fn();
    const stream = await startStream({ onBreakerOpen });
    await warmUp(stream);
    await tripBreaker(stream);
    expect(onBreakerOpen).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000); // 首次探测仍失败 → 第 2 次跳闸
    expect(onBreakerOpen).toHaveBeenCalledTimes(1);
    expect(onBreakerOpen).toHaveBeenCalledWith({
      consecutiveFails: 4,
      retryInMs: 4000,
      error: expect.any(LarkApiError),
    });

    await vi.advanceTimersByTimeAsync(4000); // 第 2 次探测仍失败 → 第 3 次跳闸：不重复
    expect(onBreakerOpen).toHaveBeenCalledTimes(1);

    updateCardElementContent.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(8000); // 恢复
    expect(stream.getHealth().breakerOpen).toBe(false);
    await tripBreaker(stream); // 恢复后再次 3 连败跳闸
    await vi.advanceTimersByTimeAsync(2000); // 首次探测又失败：满足通知条件，但这张卡已通知过
    expect(stream.getHealth().breakerOpen).toBe(true);
    expect(onBreakerOpen).toHaveBeenCalledTimes(1);
  });

  it("onBreakerOpen 回调自己抛错：不破坏状态机——探测定时器照常排上、之后仍能恢复", async () => {
    const onBreakerOpen = vi.fn(() => {
      throw new Error("cb boom");
    });
    const stream = await startStream({ onBreakerOpen });
    await warmUp(stream);
    await tripBreaker(stream);
    await vi.advanceTimersByTimeAsync(2000); // 首次探测仍失败 → 第 2 次跳闸 → 回调抛错
    expect(onBreakerOpen).toHaveBeenCalledTimes(1);
    expect(stream.getHealth().breakerOpen).toBe(true);
    expect(pendingTimers()).toBe(1); // 回调抛错没打断 recordFailure：下一次探测照常排上了

    updateCardElementContent.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(4000);
    expect(stream.getHealth().breakerOpen).toBe(false);
  });

  it("header 整卡 PUT 的成功也算恢复：连败 2 次后成功一次 → 连续失败清零，再败 2 次不跳闸", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardEntity.mockRejectedValue(rateLimited());
    for (let i = 0; i < 2; i++) {
      stream.setHeaderStatus(`步骤${i}`, "blue");
      await vi.advanceTimersByTimeAsync(250); // setHeaderStatus 走 250ms 节流
    }
    expect(stream.getHealth().consecutiveFails).toBe(2);

    updateCardEntity.mockResolvedValue(undefined);
    stream.setHeaderStatus("步骤2", "blue");
    await vi.advanceTimersByTimeAsync(250);
    expect(stream.getHealth().consecutiveFails).toBe(0); // header 路径的成功也清零

    updateCardEntity.mockRejectedValue(rateLimited());
    for (let i = 3; i < 5; i++) {
      stream.setHeaderStatus(`步骤${i}`, "blue");
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(stream.getHealth()).toMatchObject({
      consecutiveFails: 2,
      breakerOpen: false,
    });
  });

  it("跳闸时若还挂着一个待决的节流定时器：探测定时器取代它，不并存", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValue(rateLimited());
    for (let i = 0; i < 2; i++) {
      grow(stream);
      await settle();
    }
    // 第 3 次 flush 挂在途中；这期间来了一个小增量（< 600 字）→ 排上 250ms 节流定时器
    const g = gate();
    updateCardElementContent.mockImplementationOnce(async () => {
      await g.p;
      throw rateLimited();
    });
    grow(stream);
    await settle();
    answer += "小增量";
    stream.pushAnswer(answer);
    expect(pendingTimers()).toBe(1);

    g.release(); // 第 3 次失败 → 跳闸 → 排探测
    await settle();
    expect(stream.getHealth().breakerOpen).toBe(true);
    expect(pendingTimers()).toBe(1); // 只剩探测定时器：节流定时器被清掉了
  });
});

describe("finalize / append 在熔断中仍强试一次", () => {
  it("熔断中 finalize：不先刷余量，但整卡 PUT 照发；成功则 finalizeOk=true 且熔断解除", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    updateCardElementContent.mockClear();
    updateCardEntity.mockClear();
    patchCardSettings.mockClear();
    updateCardElementContent.mockResolvedValue(undefined); // lark 恢复

    await stream.finalize({ ok: true, durationMs: 1000 });

    expect(updateCardElementContent).not.toHaveBeenCalled(); // 熔断中 doFlush 直接放过
    expect(updateCardEntity).toHaveBeenCalledTimes(1); // 整卡 PUT 带终稿
    expect(JSON.stringify(updateCardEntity.mock.calls[0]![1])).toContain(
      answer.slice(0, 20),
    );
    expect(patchCardSettings).toHaveBeenCalledTimes(1);
    expect(stream.getHealth()).toMatchObject({
      finalizeOk: true,
      breakerOpen: false,
      consecutiveFails: 0,
    });
  });

  it("finalize 整卡 PUT 失败 → finalizeOk=false、lastError 是原错误、不抛、不再往下发 patch", async () => {
    const stream = await startStream();
    await warmUp(stream);
    const err = rateLimited();
    updateCardEntity.mockRejectedValue(err);

    await expect(stream.finalize({ ok: true })).resolves.toBeUndefined();

    expect(stream.getHealth()).toMatchObject({ finalizeOk: false, lastError: err });
    expect(stream.getFailCount()).toBe(1);
    expect(patchCardSettings).not.toHaveBeenCalled();
  });

  it("终稿内容已落成、只是关 streaming_mode 失败 → finalizeOk 仍为 true（内容完整，不该报没同步）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    patchCardSettings.mockRejectedValue(rateLimited());

    await stream.finalize({ ok: true });

    expect(stream.getHealth().finalizeOk).toBe(true);
    expect(stream.getFailCount()).toBe(1); // 失败仍计入累计
  });

  it("非流式：建卡失败 → finalizeOk=false；成功 → true", async () => {
    const bad = createCardStream("t_brk_ns_bad", { title: "测", streaming: false });
    await bad.start();
    bad.pushAnswer("答案");
    createCardEntity.mockRejectedValueOnce(new Error("boom"));
    await bad.finalize({ ok: true });
    expect(bad.getHealth()).toMatchObject({ finalizeOk: false });
    expect(sendCardMessage).not.toHaveBeenCalled();

    const good = createCardStream("t_brk_ns_ok", { title: "测", streaming: false });
    await good.start();
    good.pushAnswer("答案");
    await good.finalize({ ok: true });
    expect(good.getHealth()).toMatchObject({ finalizeOk: true });
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
  });

  it("熔断中 appendRetryButton 仍发 batch（强试一次），成功即恢复", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    batchUpdateCard.mockClear();

    await stream.appendRetryButton("重试这句");

    expect(batchUpdateCard).toHaveBeenCalledTimes(1);
    expect(stream.getHealth()).toMatchObject({
      breakerOpen: false,
      consecutiveFails: 0,
    });
  });

  it("熔断中 appendAskUser 仍发 batch + header 整卡 PUT（强试一次），成功即恢复", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    batchUpdateCard.mockClear();
    updateCardEntity.mockClear();

    await stream.appendAskUser({
      askId: "ask_1",
      questions: [
        {
          id: "q1",
          question: "选哪个？",
          options: [{ id: "a", label: "甲" }],
        },
      ],
    });

    expect(batchUpdateCard).toHaveBeenCalledTimes(1);
    expect(updateCardEntity).toHaveBeenCalledTimes(1);
    expect(stream.getHealth()).toMatchObject({
      breakerOpen: false,
      consecutiveFails: 0,
    });
  });

  it("finalize 之后不残留任何定时器（熔断期的探测定时器被清掉）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    expect(pendingTimers()).toBe(1);

    await stream.finalize({ ok: true });
    expect(pendingTimers()).toBe(0);

    // 失败的 finalize 也一样：它的 recordFailure 不能在 finalized 前再排一个探测
    const stream2 = await startStream();
    await warmUp(stream2);
    updateCardEntity.mockRejectedValue(rateLimited());
    updateCardElementContent.mockRejectedValue(rateLimited());
    await tripBreaker(stream2);
    await stream2.finalize({ ok: true });
    expect(pendingTimers()).toBe(0);
  });
});

describe("超时参数", () => {
  it("流式更新类调用带 8s 短超时；终稿类（整卡 PUT / 思考区回写 / 关流式）带 15s", async () => {
    const stream = await startStream();
    stream.pushProcess("想".repeat(700)); // 过程区变化 → batch 回写
    grow(stream); // 首个正文 → header 脏 → 整卡 PUT + 内容 PUT
    await settle();

    expect(updateCardEntity.mock.calls.at(-1)![3]).toEqual({ timeoutMs: 8000 });
    expect(batchUpdateCard.mock.calls.at(-1)![3]).toEqual({ timeoutMs: 8000 });
    expect(updateCardElementContent.mock.calls.at(-1)![4]).toEqual({
      timeoutMs: 8000,
    });

    // 纯内容 flush 也是 8s
    updateCardElementContent.mockClear();
    grow(stream);
    await settle();
    expect(updateCardElementContent.mock.calls.at(-1)![4]).toEqual({
      timeoutMs: 8000,
    });

    // append 的 batch 是 8s
    batchUpdateCard.mockClear();
    await stream.appendRetryButton("再来");
    expect(batchUpdateCard.mock.calls.at(-1)![3]).toEqual({ timeoutMs: 8000 });

    // 终稿三连都是 15s
    updateCardEntity.mockClear();
    batchUpdateCard.mockClear();
    await stream.finalize({ ok: true });
    expect(updateCardEntity.mock.calls.at(-1)![3]).toEqual({ timeoutMs: 15000 });
    expect(batchUpdateCard.mock.calls.at(-1)![3]).toEqual({ timeoutMs: 15000 });
    expect(patchCardSettings.mock.calls.at(-1)![3]).toEqual({ timeoutMs: 15000 });
  });
});

describe("风暴验收", () => {
  it("永久失败 + 5 分钟持续 push：请求总量被熔断压到个位数十（改前每 250ms 一发 ≈ 1200）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValue(rateLimited());
    updateCardEntity.mockRejectedValue(rateLimited());
    batchUpdateCard.mockRejectedValue(rateLimited());

    for (let t = 0; t < 300_000; t += 100) {
      grow(stream, 300); // 每 100ms 300 字：约每 200ms 越过一次字数阈值
      stream.setHeaderStatus(`第${t}步`); // header 也一直是脏的
      await vi.advanceTimersByTimeAsync(100);
    }

    const total =
      updateCardElementContent.mock.calls.length +
      updateCardEntity.mock.calls.length +
      batchUpdateCard.mock.calls.length;
    expect(total).toBeLessThanOrEqual(25);
    expect(stream.getHealth().breakerOpen).toBe(true);

    // finalize 在持续失败下照样能收尾：失败如实标记、不抛、不挂
    await expect(
      stream.finalize({ ok: false, error: "x" }),
    ).resolves.toBeUndefined();
    expect(stream.getHealth().finalizeOk).toBe(false);
  });
});

describe("探测定时器的生命周期边界", () => {
  const callCounts = (): number[] =>
    [updateCardElementContent, updateCardEntity, batchUpdateCard, patchCardSettings].map(
      (m) => m.mock.calls.length,
    );

  it("finalize 之后再推进 10 分钟：请求数不再增加，也没有任何定时器", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    await stream.finalize({ ok: true });
    const mark = callCounts();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(callCounts()).toEqual(mark);
    expect(pendingTimers()).toBe(0);
  });

  it("finalize 排在一个正在失败的 flush 后面：失败跳闸时排的探测定时器，被 finalize 收尾清掉，不漏到 finalize 之后", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValue(rateLimited());
    for (let i = 0; i < 2; i++) {
      grow(stream);
      await settle();
    }
    expect(stream.getHealth().breakerOpen).toBe(false); // 已连败 2 次，再败一次就跳闸

    // 第 3 次 flush 卡在途中；finalize 排在它后面；随后让它失败 → 跳闸（此刻 finalized 仍是 false，会排探测）
    const g = gate();
    updateCardElementContent.mockImplementationOnce(async () => {
      await g.p;
      throw rateLimited();
    });
    grow(stream);
    await settle();
    const fin = stream.finalize({ ok: true });
    g.release();
    await fin;

    expect(stream.getHealth().breakerEverOpened).toBe(true);
    expect(pendingTimers()).toBe(0);
    const mark = callCounts();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(callCounts()).toEqual(mark);
  });

  it("没有 finalize、没有新 push、lark 永久失败：自驱探测最多 10 次就停，之后零请求零定时器", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream); // 3 次失败
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(updateCardElementContent).toHaveBeenCalledTimes(3 + 10);
    expect(pendingTimers()).toBe(0);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(updateCardElementContent).toHaveBeenCalledTimes(3 + 10);
    expect(pendingTimers()).toBe(0);
  });

  it("自驱停了之后又来了新 push：由 push 驱动重新探测（还活着的流不会永远没有恢复机会）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream);
    await vi.advanceTimersByTimeAsync(30 * 60_000); // 自驱探测已封顶、熔断窗口早已过期
    expect(updateCardElementContent).toHaveBeenCalledTimes(13);

    grow(stream); // 半开：这一发本身就是探测（仍失败）
    await settle();
    expect(updateCardElementContent).toHaveBeenCalledTimes(14);
    expect(pendingTimers()).toBe(0); // 自驱已封顶，失败后不再自己续约

    grow(stream); // 熔断窗内的 push：不发请求，但重新排上探测
    await settle();
    expect(updateCardElementContent).toHaveBeenCalledTimes(14);
    expect(pendingTimers()).toBe(1);

    updateCardElementContent.mockResolvedValue(undefined); // lark 恢复
    await vi.advanceTimersByTimeAsync(30_000);
    expect(updateCardElementContent).toHaveBeenCalledTimes(15);
    expect(stream.getHealth().breakerOpen).toBe(false);
  });
});

describe("失败原因瘦身（lark-cli 的 execFile 错误 message 动辄几十 KB）", () => {
  const BIG_MARK = "整卡正文标记";
  /** 模拟 execFile 的 Command failed：message 带整卡 --data，raw 挂着 stdout / stderr 全文 */
  const hugeError = (): InstanceType<typeof LarkApiError> =>
    new LarkApiError(
      `Command failed: lark-cli api PUT /x --data ${"a".repeat(500)}${BIG_MARK}${"字".repeat(30_000)}`,
      {
        code: 99991400,
        api: "api PUT /open-apis/cardkit/v1/cards/:id",
        logId: "log_abc",
        fieldViolations: [{ field: "body.elements[3].content", description: "invalid" }],
        raw: { stdout: `${BIG_MARK}${"x".repeat(30_000)}`, stderr: "y".repeat(30_000) },
      },
    );

  it("LarkApiError：lastError / onBreakerOpen 的 error / console.warn 都被截断，不保留 raw，结构化字段保留", async () => {
    const onBreakerOpen = vi.fn();
    const stream = await startStream({ onBreakerOpen });
    await warmUp(stream);
    updateCardElementContent.mockRejectedValue(hugeError());
    for (let i = 0; i < 3; i++) {
      grow(stream);
      await settle();
    }
    await vi.advanceTimersByTimeAsync(2000); // 首次探测仍失败 → 第 2 次跳闸 → onBreakerOpen

    const err = stream.getHealth().lastError as InstanceType<typeof LarkApiError>;
    expect(err).toBeInstanceOf(LarkApiError);
    expect(err.message.length).toBeLessThanOrEqual(240);
    expect(err.message).not.toContain(BIG_MARK);
    expect(err.raw).toBeUndefined();
    // 违规字段路径会被 describeLarkError 拼进用户可见的提示——瘦身不能悄悄把它丢掉
    expect(err).toMatchObject({
      code: 99991400,
      api: "api PUT /open-apis/cardkit/v1/cards/:id",
      logId: "log_abc",
      fieldViolations: [{ field: "body.elements[3].content", description: "invalid" }],
    });

    const cbErr = onBreakerOpen.mock.calls[0]![0].error as InstanceType<typeof LarkApiError>;
    expect(cbErr.message.length).toBeLessThanOrEqual(240);
    expect(cbErr.raw).toBeUndefined();

    const warned = vi.mocked(console.warn).mock.calls.flat().map(String);
    expect(warned.length).toBeGreaterThan(0);
    for (const w of warned) expect(w.length).toBeLessThanOrEqual(300);
  });

  it("普通 Error 与非 Error 的抛出物同样被截断", async () => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(new Error("e".repeat(30_000)));
    grow(stream);
    await settle();
    expect((stream.getHealth().lastError as Error).message.length).toBeLessThanOrEqual(240);

    updateCardElementContent.mockRejectedValueOnce("s".repeat(30_000));
    grow(stream);
    await settle();
    expect(String(stream.getHealth().lastError).length).toBeLessThanOrEqual(240);
  });
});

describe("失败原因摘要：剥掉命令行、留 stderr 末行（Command failed 形态）", () => {
  const ARGV = `Command failed: lark-cli api PUT /open-apis/cardkit/v1/cards/x --data {"card":"${"a".repeat(30_000)}"}`;
  const API = "api PUT /open-apis/cardkit/v1/cards/:id";

  /** 让一次 content PUT 抛 err，返回句柄记下的 lastError */
  const failOnce = async (err: unknown): Promise<unknown> => {
    const stream = await startStream();
    await warmUp(stream);
    updateCardElementContent.mockRejectedValueOnce(err);
    grow(stream);
    await settle();
    return stream.getHealth().lastError;
  };

  it("raw.stderr 有内容：取最后一条有内容的行（跳过尾部空行）", async () => {
    const stderr = "lark-cli: warning x\nError: connect ECONNRESET\n\n";
    const e = (await failOnce(
      // message 后半是 Node 拼进去的（可能被截断 / 合并），raw.stderr 是完整原文——优先取后者
      new LarkApiError(`${ARGV}\nError: (truncated…`, { api: API, raw: { stdout: "", stderr } }),
    )) as InstanceType<typeof LarkApiError>;
    expect(e.message).toBe("Error: connect ECONNRESET");
    expect(e.api).toBe(API);
  });

  it("raw 缺失、stderr 只跟在 message 的换行后面：同样取到末行（LarkApiError 与普通 Error 都是）", async () => {
    const withApi = (await failOnce(
      new LarkApiError(`${ARGV}\nError: socket hang up\n`, { api: API }),
    )) as Error;
    expect(withApi.message).toBe("Error: socket hang up");
    const plain = (await failOnce(new Error(`${ARGV}\nError: socket hang up\n`))) as Error;
    expect(plain.message).toBe("Error: socket hang up");
  });

  it("stderr 是空的：退回「lark-cli 调用失败（命令标签）」，绝不带 argv", async () => {
    const withApi = (await failOnce(
      new LarkApiError(ARGV, { api: API, raw: { stdout: "", stderr: "" } }),
    )) as Error;
    expect(withApi.message).toBe(`lark-cli 调用失败（${API}）`);
    const plain = (await failOnce(new Error(ARGV))) as Error;
    expect(plain.message).toBe("lark-cli 调用失败");
  });

  it("不是 Command failed 形态的 message：原样（折叠空白）", async () => {
    const e = (await failOnce(
      new LarkApiError("rate limited  \n  retry later", { code: 99991400 }),
    )) as Error;
    expect(e.message).toBe("rate limited retry later");
  });

  it("console.warn 日志同样用摘要：有原因、没有 argv", async () => {
    const stderr = "Error: connect ECONNRESET\n";
    await failOnce(
      new LarkApiError(`${ARGV}\n${stderr}`, { api: API, raw: { stdout: "", stderr } }),
    );
    const warned = vi.mocked(console.warn).mock.calls.flat().map(String);
    expect(warned.some((w) => w.includes("ECONNRESET"))).toBe(true);
    for (const w of warned) expect(w).not.toContain("--data");
  });
});

describe("start 就失败：这一轮飞书里没有卡，finalize 必须记成没同步（不能留 undefined 让上层照报「已完成」）", () => {
  const noCardWrites = (): void => {
    expect(updateCardEntity).not.toHaveBeenCalled();
    expect(updateCardElementContent).not.toHaveBeenCalled();
    expect(batchUpdateCard).not.toHaveBeenCalled();
    expect(patchCardSettings).not.toHaveBeenCalled();
  };

  it("createCardEntity 失败：start → push → finalize 后 finalizeOk=false、原因可读、没有任何卡片更新调用", async () => {
    createCardEntity.mockRejectedValueOnce(
      new LarkApiError("no permission", { code: 99991672 }),
    );
    const stream = createCardStream("t_start_fail_create", { title: "测" });
    await stream.start();
    expect(stream.getHealth().finalizeOk).toBeUndefined(); // finalize 之前还没有结论
    grow(stream); // 卡没建出来：push 是空操作
    await settle();
    await stream.finalize({ ok: true });

    const h = stream.getHealth();
    expect(h.finalizeOk).toBe(false);
    expect((h.lastError as Error).message).toContain("no permission");
    expect(sendCardMessage).not.toHaveBeenCalled();
    noCardWrites();
  });

  it("createCardEntity 成功、sendCardMessage 失败：同样 finalizeOk=false，且不会对没发出去的卡做任何更新", async () => {
    sendCardMessage.mockRejectedValueOnce(
      new LarkApiError("bot not in chat", { code: 230002 }),
    );
    const stream = createCardStream("t_start_fail_send", { title: "测" });
    await stream.start();
    grow(stream);
    await settle();
    await stream.finalize({ ok: true });

    expect(stream.getHealth().finalizeOk).toBe(false);
    expect((stream.getHealth().lastError as Error).message).toContain("bot not in chat");
    expect(stream.getIds().cardId).toBeUndefined();
    noCardWrites();
  });

  it("对照：start 成功 → finalize 前是 undefined、finalize 后是 true", async () => {
    const stream = await startStream();
    expect(stream.getHealth().finalizeOk).toBeUndefined();
    await stream.finalize({ ok: true });
    expect(stream.getHealth().finalizeOk).toBe(true);
  });

  it("从未 start 的句柄 finalize：finalizeOk 仍是 undefined（只有「start 失败」才记 false）", async () => {
    const stream = createCardStream("t_never_started", { title: "测" });
    await stream.finalize({ ok: true });
    expect(stream.getHealth().finalizeOk).toBeUndefined();
    noCardWrites();
  });

  it("start 失败后重复 finalize：结论不变、不重复写", async () => {
    createCardEntity.mockRejectedValueOnce(new Error("boom"));
    const stream = createCardStream("t_start_fail_twice", { title: "测" });
    await stream.start();
    await stream.finalize({ ok: true });
    await stream.finalize({ ok: true });
    expect(stream.getHealth().finalizeOk).toBe(false);
    noCardWrites();
  });

  it("start 失败后又重新 start 成功：这一轮有卡了，finalize 照常落成 → finalizeOk=true", async () => {
    createCardEntity.mockRejectedValueOnce(new Error("boom"));
    const stream = createCardStream("t_start_retry", { title: "测" });
    await stream.start(); // 失败：started=false，允许再次 start
    expect(stream.getIds().cardId).toBeUndefined();
    await stream.start(); // 重试成功
    expect(stream.getIds().cardId).toBeTruthy();
    await stream.finalize({ ok: true });
    expect(stream.getHealth().finalizeOk).toBe(true);
    expect(updateCardEntity).toHaveBeenCalled();
  });
});

describe("appendAskUser / appendRetryButton 的超时参数与失败计入", () => {
  const askOpts = {
    askId: "a1",
    questions: [
      { id: "q", question: "选哪个？", options: [{ id: "x", label: "X" }] },
    ],
  };

  it("appendAskUser 的 batch 与随后的整卡 PUT 都带短超时（8s）：不让一次黑洞请求占住单飞队列", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await stream.appendAskUser(askOpts);

    const batchCall = batchUpdateCard.mock.calls.find((c) =>
      JSON.stringify(c[1]).includes("add_elements"),
    ) as unknown as [string, unknown, number, { timeoutMs?: number }];
    expect(batchCall[3]).toEqual({ timeoutMs: 8000 });
    const putCall = updateCardEntity.mock.calls.at(-1) as unknown as [
      string,
      unknown,
      number,
      { timeoutMs?: number },
    ];
    expect(putCall[3]).toEqual({ timeoutMs: 8000 });
  });

  it("appendAskUser 失败也计入连续失败与 lastError（不是只有 flush 才算）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    batchUpdateCard.mockRejectedValue(new LarkApiError("ask boom", { code: 1 }));
    await stream.appendAskUser(askOpts);
    expect(stream.getHealth().consecutiveFails).toBe(1);
    expect((stream.getHealth().lastError as Error).message).toBe("ask boom");
  });

  it("appendRetryButton 失败也计入连续失败与 lastError", async () => {
    const stream = await startStream();
    await warmUp(stream);
    batchUpdateCard.mockRejectedValue(new LarkApiError("retry boom", { code: 2 }));
    await stream.appendRetryButton("上一句");
    expect(stream.getHealth().consecutiveFails).toBe(1);
    expect((stream.getHealth().lastError as Error).message).toBe("retry boom");
  });
});

describe("失败回滚：思考区（process）和正文（answer）的「已推」快照各自回滚", () => {
  it("只有思考区变化时 batch 连败 3 次跳闸，恢复后的探测必须把思考区补发（process 的快照也要回滚）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    batchUpdateCard.mockRejectedValue(rateLimited());
    let process = "";
    for (let i = 0; i < 3; i++) {
      process += "思".repeat(700);
      stream.pushProcess(process);
      await settle();
    }
    expect(batchUpdateCard).toHaveBeenCalledTimes(3);
    expect(stream.getHealth().breakerOpen).toBe(true);

    // 恢复：到期探测。快照没回滚的话，「已推」已经等于「应推」，探测会判成没变化直接放过，思考区一直空到 finalize
    batchUpdateCard.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(2000);
    expect(batchUpdateCard).toHaveBeenCalledTimes(4);
    const probe = batchUpdateCard.mock.calls.at(-1) as unknown as [string, unknown];
    expect(JSON.stringify(probe[1])).toContain(process);
    expect(stream.getHealth().breakerOpen).toBe(false);
  });

  it("只有正文变化时 content PUT 连败 3 次跳闸，恢复后的探测必须把正文补发（answer 的快照也要回滚）", async () => {
    const stream = await startStream();
    await warmUp(stream);
    await tripBreaker(stream); // 3 次 grow 都失败
    expect(updateCardElementContent).toHaveBeenCalledTimes(3);

    updateCardElementContent.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateCardElementContent).toHaveBeenCalledTimes(4);
    const probe = updateCardElementContent.mock.calls.at(-1) as unknown as [
      string,
      string,
      string,
    ];
    expect(probe[2]).toBe(answer);
  });
});
