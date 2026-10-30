import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskWatch, type UseTaskWatchCallbacks } from "@/hooks/use-task-watch";
import { watchTaskStream } from "@/lib/task-store";
import type { Task } from "@/lib/types";

import { createHookHarness, type HookHarness } from "./helpers/react-hook-stub";

const enc = new TextEncoder();
const frame = (payload: unknown) => enc.encode(`data: ${JSON.stringify(payload)}\n\n`);
const TASK = {
  id: "t1",
  title: "t1",
  mode: "chat",
  runStatus: "idle",
  repoStatus: "developing",
  events: [],
  repoPaths: [],
  createdAt: 0,
  updatedAt: 0,
} as unknown as Task;
const SSE_HEADERS = { "Content-Type": "text/event-stream" };

describe("watchTaskStream：cancel 悬挂时不被拖住（不 await reader.cancel）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("底层 source.cancel() 返回永不 resolve 的 promise：回调抛错后仍在 500ms 内原样抛出原错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(frame({ type: "task", task: TASK }));
              },
              cancel() {
                return new Promise<void>(() => {});
              },
            }),
            { status: 200, headers: SSE_HEADERS },
          ),
      ),
    );
    const boom = new Error("回调炸了");
    const outcome = await Promise.race([
      watchTaskStream("t1", {
        onTaskUpdate: () => {
          throw boom;
        },
      }).then(
        () => "resolved" as const,
        (e: unknown) => e,
      ),
      new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), 500)),
    ]);
    expect(outcome).toBe(boom);
  });
});

describe("useTaskWatch：休眠后重连成功 → 撤掉常驻提示", () => {
  const mounted: HookHarness[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  });
  afterEach(() => {
    for (const h of mounted.splice(0)) h.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("前 6 次连不上 → 休眠并提示 1 次；60s 兜底唤醒后第 7 次建连成功 → onWatchDormantEnd 恰 1 次（带 taskId）", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount <= 6) throw new TypeError("network down");
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame({ type: "task", task: TASK }));
            },
          }),
          { status: 200, headers: SSE_HEADERS },
        );
      }),
    );
    const onWatchException = vi.fn();
    const onWatchDormantEnd = vi.fn();
    const callbacks: UseTaskWatchCallbacks = { onWatchException, onWatchDormantEnd };
    const harness = createHookHarness();
    mounted.push(harness);
    harness.render(() => useTaskWatch("t1", callbacks, true, 0));
    harness.flushEffects();

    await vi.advanceTimersByTimeAsync(40_000); // 第 6 次失败 ≈22.5s：耗尽 → 休眠 + 提示一次
    expect(fetchCount).toBe(6);
    expect(onWatchException).toHaveBeenCalledTimes(1);
    expect(onWatchDormantEnd).not.toHaveBeenCalled(); // 还在休眠：提示常驻

    await vi.advanceTimersByTimeAsync(60_000); // 休眠起 60s 兜底定时（≈82.5s）→ 第 7 次连接 → bootstrap 到达
    expect(fetchCount).toBe(7);
    expect(onWatchDormantEnd).toHaveBeenCalledTimes(1);
    expect(onWatchDormantEnd).toHaveBeenCalledWith("t1");
  });
});
