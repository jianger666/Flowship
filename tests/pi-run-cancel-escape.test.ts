/**
 * PiRunAdapter：取消逃生口 + stream() 事件驱动（不再 16ms 轮询）。
 *
 * ① 取消逃生口：chat-runner / task-runner 的 cancelEscape 只罩着 `run.wait()`，而它排在 `for await (run.stream())` 之后。
 *    pi 在 abort 之后若不再吐终态事件，stream 永不结束 → consume 走不到 wait、逃生口永不触发 → 停止键救不回来。
 *    现在适配器在 cancel() 之后起一个宽限计时器，到点仍未收尾就自己按 cancelled 收尾（stream 自然结束 + wait 返回 cancelled）。
 *    只在取消之后才起计时：没人取消永远不触发。
 * ② stream() 改事件驱动：push / settle 唤醒消费者，空闲时没有定时器空转。用假定时器钉死——
 *    假定时器下一个都不推进，消息仍必须及时到达（旧轮询实现里 setTimeout(16) 永远不触发 → 消费者卡死）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PI_CANCEL_SETTLE_GRACE_MS, PiRunAdapter } from "@/lib/server/custom-agent-backend";

type Ev = Record<string, unknown>;

const newRun = (abort: () => Promise<void> = async () => {}): PiRunAdapter =>
  new PiRunAdapter(
    { state: { messages: [], errorMessage: undefined }, abort } as never,
    {} as never,
  );

const textDelta = (delta: string): Ev => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});

/** 让已就绪的微任务 / 唤醒链都跑完（假定时器下不能靠 setTimeout） */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** 后台消费 stream()，返回 { got, done } 供断言 */
const consume = (run: PiRunAdapter) => {
  const state = { got: [] as unknown[], done: false };
  void (async () => {
    for await (const m of run.stream()) state.got.push(m);
    state.done = true;
  })();
  return state;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("取消逃生口", () => {
  it("cancel 后 pi 一直不吐终态：宽限期满 → wait 返回 cancelled、stream 自然结束（改前：永远挂着）", async () => {
    const abort = vi.fn(async () => {}); // abort 本身成功返回，但 pi 之后没有 agent_settled
    const run = newRun(abort);
    const s = consume(run);
    let result: unknown;
    void run.wait().then((r) => (result = r));

    await run.cancel();
    expect(abort).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PI_CANCEL_SETTLE_GRACE_MS - 1);
    await flushMicrotasks();
    expect(result, "宽限内不提前收尾").toBeUndefined();
    expect(s.done).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await flushMicrotasks();
    expect(result).toEqual({ status: "cancelled" });
    expect(s.done, "stream 随之自然结束，consume 才走得到 wait").toBe(true);
  });

  it("abort 自己卡死（永不返回）也一样：逃生口不依赖 abort 的 promise", async () => {
    const run = newRun(() => new Promise<void>(() => {}));
    const s = consume(run);
    let result: unknown;
    void run.wait().then((r) => (result = r));

    void run.cancel(); // 不 await：abort 永不 resolve
    await vi.advanceTimersByTimeAsync(PI_CANCEL_SETTLE_GRACE_MS + 1);
    await flushMicrotasks();
    expect(result).toEqual({ status: "cancelled" });
    expect(s.done).toBe(true);
  });

  it("没人取消 → 计时器不存在、永远不会自己收尾（长 shell / 慢模型不受影响）", async () => {
    const run = newRun();
    const s = consume(run);
    let result: unknown;
    void run.wait().then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(0);
    expect(result).toBeUndefined();
    expect(s.done).toBe(false);
  });

  it("cancel 后 pi 正常及时收尾（agent_settled）→ 按既有语义 cancelled，逃生计时器已清", async () => {
    const run = newRun();
    await run.cancel();
    expect(vi.getTimerCount()).toBe(1);
    run.onEvent({ type: "agent_settled" } as never);
    await expect(run.wait()).resolves.toEqual({ status: "cancelled" });
    expect(vi.getTimerCount(), "settle 清掉逃生计时器").toBe(0);
  });

  it("已收尾的 run 再 cancel：不起计时器", async () => {
    const run = newRun();
    run.onEvent(textDelta("hi") as never);
    run.onEvent({ type: "agent_settled" } as never);
    await run.wait();
    await run.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("重复 cancel 只起一个计时器", async () => {
    const run = newRun();
    await run.cancel();
    await run.cancel();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("stream() 事件驱动", () => {
  it("没有定时器推进也能及时拿到后到的消息（改前：setTimeout(16) 卡住）", async () => {
    const run = newRun();
    const s = consume(run);
    await flushMicrotasks();
    expect(s.got).toHaveLength(0);

    run.onEvent(textDelta("a") as never);
    await flushMicrotasks();
    expect(s.got).toHaveLength(1);

    run.onEvent(textDelta("b") as never);
    run.onEvent(textDelta("c") as never);
    await flushMicrotasks();
    expect(s.got).toHaveLength(3);
    expect(vi.getTimerCount(), "空闲等待不再占定时器").toBe(0);
  });

  it("settle 叫醒挂着的消费者：缓冲吐完后返回", async () => {
    const run = newRun();
    const s = consume(run);
    run.onEvent(textDelta("x") as never);
    await flushMicrotasks();
    run.onEvent({ type: "agent_settled" } as never);
    await flushMicrotasks();
    expect(s.got).toHaveLength(1);
    expect(s.done).toBe(true);
  });

  it("收尾之后才开始消费：缓冲整段吐完再结束（不丢消息）", async () => {
    const run = newRun();
    run.onEvent(textDelta("1") as never);
    run.onEvent(textDelta("2") as never);
    run.onEvent({ type: "agent_settled" } as never);
    const s = consume(run);
    await flushMicrotasks();
    expect(s.got).toHaveLength(2);
    expect(s.done).toBe(true);
  });
});
