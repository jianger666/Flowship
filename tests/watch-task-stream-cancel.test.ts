/**
 * watchTaskStream：回调抛错 / 读流失败时必须把底层连接取消（R14 B6-1 / Q16-01 ①）
 *
 * 旧写法：finally 里只 `reader.releaseLock()`——锁放了，HTTP 连接并没有关。
 * 回调（onTaskUpdate / onEvent / onDone…）一抛错，异常冒出 watchTaskStream，hook 退避后重连，上一条连接却还开着：
 * 服务端 watch-task 路由的订阅者只在「请求 abort / ReadableStream.cancel / 终态关流」时退订，
 * 客户端既不 cancel 也不 abort，订阅者就留在服务端的 Map 里，每重连一轮多漏 1 个（审查方复跑：订阅者 1→5）。
 *
 * 现在：不是自然读到 EOF 就退出（回调抛错 / read 抛错 / 被 abort）→ `reader.cancel()`，
 * 并吞掉 cancel 自己的 rejection（流已 errored 时它会返回 rejected promise，不能盖掉原错误、也不能变成 unhandledRejection）。
 *
 * 观测手法：
 *  - 「连接真的被关了」= 底层 source 的 cancel() 被调用（流保持打开时，reader.cancel() 才会走到它）；
 *  - 「自然 EOF 不该多做事」= spy ReadableStreamDefaultReader.prototype.cancel，自然结束时一次都不能调。
 * 跟 task-store-storage-degraded.test.ts 一样用真实的 watchTaskStream + stub 掉的 fetch。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { watchTaskStream, type TaskStreamCallbacks } from "@/lib/task-store";
import type { Task } from "@/lib/types";

const enc = new TextEncoder();
const frame = (payload: unknown) =>
  enc.encode(`data: ${JSON.stringify(payload)}\n\n`);

const TASK = {
  id: "t1",
  title: "t1",
  mode: "chat",
  runStatus: "idle",
  repoStatus: "idle",
  events: [],
  repoPaths: [],
  createdAt: 0,
  updatedAt: 0,
} as unknown as Task;

const SSE_HEADERS = { "Content-Type": "text/event-stream" };

interface Probe {
  /** 底层 source 的 cancel 被调用的次数（= 客户端真的把连接关了） */
  sourceCancel: number;
}

/** 连接保持打开（不 close）的流：一次性吐出若干帧后挂着，像一条正常的长连接 */
const openConnection = (probe: Probe, payloads: unknown[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of payloads) controller.enqueue(frame(p));
      },
      cancel() {
        probe.sourceCancel += 1;
      },
    }),
    { status: 200, headers: SSE_HEADERS },
  );

const stubFetch = (make: (init?: RequestInit) => Response) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => make(init)),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("回调抛错 → 取消底层连接（Q16-01 ①）", () => {
  const BOOT = { type: "task", task: TASK };
  const cases: Array<{
    label: string;
    payloads: unknown[];
    callbacks: (boom: Error) => TaskStreamCallbacks;
  }> = [
    {
      label: "onTaskUpdate（bootstrap 首帧）抛错",
      payloads: [BOOT],
      callbacks: (boom) => ({
        onTaskUpdate: () => {
          throw boom;
        },
      }),
    },
    {
      label: "onEvent（bootstrap 之后的事件帧）抛错",
      payloads: [BOOT, { type: "event", event: { id: "e1", text: "hi" } }],
      callbacks: (boom) => ({
        onEvent: () => {
          throw boom;
        },
      }),
    },
    {
      label: "onDone 抛错",
      payloads: [BOOT, { type: "done", task: TASK, ok: true }],
      callbacks: (boom) => ({
        onDone: () => {
          throw boom;
        },
      }),
    },
  ];

  it.each(cases)(
    "$label：原样抛出，底层连接被取消恰 1 次",
    async ({ payloads, callbacks }) => {
      const probe: Probe = { sourceCancel: 0 };
      stubFetch(() => openConnection(probe, payloads));
      const boom = new Error("回调炸了");
      await expect(watchTaskStream("t1", callbacks(boom))).rejects.toBe(boom);
      expect(probe.sourceCancel).toBe(1);
    },
  );

  it("连抛 5 轮（模拟 hook 每轮重连）：每轮都关掉上一条连接，不累积泄漏", async () => {
    const probe: Probe = { sourceCancel: 0 };
    stubFetch(() => openConnection(probe, [BOOT]));
    for (let round = 1; round <= 5; round++) {
      await expect(
        watchTaskStream("t1", {
          onTaskUpdate: () => {
            throw new Error(`round ${round}`);
          },
        }),
      ).rejects.toThrow(`round ${round}`);
      // 修前：恒为 0（每轮留下 1 条没关的连接）
      expect(probe.sourceCancel).toBe(round);
    }
  });
});

describe("不该多做事的路径", () => {
  it("自然读到 EOF：正常 resolve，reader.cancel 一次都不调", async () => {
    const cancelSpy = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame({ type: "task", task: TASK }));
              controller.close();
            },
          }),
          { status: 200, headers: SSE_HEADERS },
        ),
    );
    await expect(watchTaskStream("t1", {})).resolves.toEqual({
      established: true,
    });
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("读流中途抛错（网络掐断）：抛出原错误；cancel 自己的 rejection 被吞掉，不产生 unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let step = 0;
      stubFetch(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (step === 0) {
                  step = 1;
                  controller.enqueue(frame({ type: "task", task: TASK }));
                  return;
                }
                controller.error(new Error("stream dropped"));
              },
            }),
            { status: 200, headers: SSE_HEADERS },
          ),
      );
      await expect(watchTaskStream("t1", {})).rejects.toThrow("stream dropped");
      // 给被吞掉的 rejection 一个机会冒成 unhandledRejection（process 事件在宏任务边界触发）
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("被 abort：仍抛 AbortError（cancel 的 rejection 不能盖掉它）", async () => {
    const ac = new AbortController();
    stubFetch((init) => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(frame({ type: "task", task: TASK }));
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("Aborted", "AbortError")),
            );
          },
        }),
        { status: 200, headers: SSE_HEADERS },
      );
    });
    await expect(
      watchTaskStream("t1", { onTaskUpdate: () => ac.abort() }, ac.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
