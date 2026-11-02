/**
 * watchTaskStream 静默死连接看门狗：
 * 代理 / 休眠 / 网络切换悄悄掐掉连接且没有 RST 时，reader.read() 会永远挂住，界面停在断开时的状态。
 * 服务端每 20s 发 `: ping` 注释帧；客户端超过 WATCH_STREAM_IDLE_TIMEOUT_MS 一个字节都没收到就
 * cancel 并抛错，让 use-task-watch 走正常重连。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WATCH_STREAM_IDLE_TIMEOUT_MS, watchTaskStream } from "@/lib/task-store";

const enc = new TextEncoder();
const taskFrame = (task: unknown): Uint8Array =>
  enc.encode(`data: ${JSON.stringify({ type: "task", task })}\n\n`);
const task = { id: "t1", mode: "chat", runStatus: "idle", repoStatus: "developing", events: [] };

/** 手动控制的流：测试里按需 push；cancel 时记下并结束挂起的 read */
const controllableStream = () => {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
    cancel() {
      cancelled();
    },
  });
  return {
    body,
    cancelled,
    push: (b: Uint8Array) => ctrl.enqueue(b),
    close: () => ctrl.close(),
  };
};

const stubFetch = (body: ReadableStream<Uint8Array>) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })),
  );
};

describe("watchTaskStream 静默看门狗", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("超过上限没有任何字节 → cancel 底层连接并抛错（交给 hook 重连）", async () => {
    const s = controllableStream();
    stubFetch(s.body);
    s.push(taskFrame(task));
    const onTaskUpdate = vi.fn();
    const p = watchTaskStream("t1", { onTaskUpdate });
    const assertion = expect(p).rejects.toThrow(/静默超过/);
    await vi.advanceTimersByTimeAsync(WATCH_STREAM_IDLE_TIMEOUT_MS + 10);
    await assertion;
    expect(onTaskUpdate).toHaveBeenCalledTimes(1);
    expect(s.cancelled).toHaveBeenCalled();
  });

  it("心跳（注释帧）持续到达 → 不超时、不重连；服务端正常关流 → 干净返回", async () => {
    const s = controllableStream();
    stubFetch(s.body);
    s.push(taskFrame(task));
    const p = watchTaskStream("t1", {});
    // 每 20s 一帧心跳，跑 5 分钟（远超单次静默上限）
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      s.push(enc.encode(": ping\n\n"));
    }
    s.close();
    await expect(p).resolves.toEqual({ established: true });
    expect(s.cancelled).not.toHaveBeenCalled();
  });

  it("正常结束（EOF）后不残留定时器", async () => {
    const s = controllableStream();
    stubFetch(s.body);
    s.push(taskFrame(task));
    s.close();
    await watchTaskStream("t1", {});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("上限比服务端心跳间隔宽（至少 3 个心跳周期），避免一两次抖动就误重连", () => {
    expect(WATCH_STREAM_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(3 * 20_000);
  });
});
