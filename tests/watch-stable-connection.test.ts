/**
 * useTaskWatch：重连预算「撑过稳定窗口才清零」（R14 B6-1 / Q16-01 ③ + 终态保护）
 *
 * 旧写法：首个合法 bootstrap task 帧一到（onConnectionEstablished）就把重连预算整个清零。
 * 于是「建连后立刻被掐断 / 回调立刻抛错」的连接，每轮都先清零、再断开记成第 1 次失败——
 * 预算永远攒不到 6 次，hook 永不进入「休眠待重连」、不弹提示，只是每 ~1.5s 静默无限重连（还每轮漏一条连接，见 Q16-01 ①）。
 *
 * 现在：建连只记时刻；连接结束时才结算——撑过 WATCH_STABLE_CONNECTION_MS（2s）才清零预算，
 * 没撑过的按失败累计，6 次后进入休眠并提示一次。
 *
 * 本文件**真跑 hook**（tests/helpers/react-hook-stub.ts 的 dispatcher 桩 + 假时钟）——
 * ownership-r40 / r41 里的 hook「镜像」测试自带清零回调、不读 hook 源码，改 hook 不会让它们变红，保证不了这里的语义。
 *
 * 时间线（退避 = 第 n 次失败后等 min(1500n, 12000)ms；第 6 次失败即耗尽）：
 *   fetch #1 @0 → 失败 → 等 1.5s → #2 @1.5s → 等 3s → #3 @4.5s → 等 4.5s → #4 @9s → 等 6s → #5 @15s → 等 7.5s → #6 @22.5s → 第 6 次失败 = 耗尽
 *   （流存活的时间要叠加进去；休眠后 WATCH_DORMANT_RETRY_INTERVAL_MS 的兜底定时到点自动唤醒）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useTaskWatch,
  type UseTaskWatchCallbacks,
} from "@/hooks/use-task-watch";
import {
  isStableWatchConnection,
  WATCH_DORMANT_RETRY_INTERVAL_MS,
  WATCH_MAX_TRANSIENT_FAILURES,
  WATCH_STABLE_CONNECTION_MS,
} from "@/lib/task-terminal";
import { settleWatchBudget, type WatchBudget } from "@/lib/watch-reconnect";
import type { Task } from "@/lib/types";

import { createHookHarness, type HookHarness } from "./helpers/react-hook-stub";

const enc = new TextEncoder();
const frame = (payload: unknown) =>
  enc.encode(`data: ${JSON.stringify(payload)}\n\n`);

const stubTask = (repoStatus: string): Task =>
  ({
    id: "t1",
    title: "t1",
    mode: "chat",
    runStatus: "idle",
    repoStatus,
    events: [],
    repoPaths: [],
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as Task;

const ACTIVE = stubTask("idle");
const MERGED = stubTask("merged");
const SSE_HEADERS = { "Content-Type": "text/event-stream" };

interface Probe {
  fetchCount: number;
  /** 底层 source 的 cancel 被调用的次数（= 客户端真的把这条连接关了） */
  cancelCount: number;
}
/** 返回流 = 这次连上了；返回 Error = 这次连不上（fetch reject，从未建连） */
type MakeBody = (probe: Probe) => ReadableStream<Uint8Array> | Error;

/** 建连（吐 bootstrap task 帧）后存活 liveMs，然后被掐断（reader error） */
const droppedAfter =
  (liveMs: number): MakeBody =>
  (probe) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({ type: "task", task: ACTIVE }));
        setTimeout(() => {
          try {
            controller.error(new Error("stream dropped"));
          } catch {
            /* 连接已被客户端取消 */
          }
        }, liveMs);
      },
      cancel() {
        probe.cancelCount += 1;
      },
    });

/** 吐出 payloads 后存活 liveMs（0 = 立刻），然后服务端正常关流（clean EOF） */
const closedAfter =
  (
    liveMs: number,
    payloads: unknown[] = [{ type: "task", task: ACTIVE }],
  ): MakeBody =>
  (probe) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of payloads) controller.enqueue(frame(p));
        const close = () => {
          try {
            controller.close();
          } catch {
            /* 连接已被客户端取消 */
          }
        };
        if (liveMs === 0) close();
        else setTimeout(close, liveMs);
      },
      cancel() {
        probe.cancelCount += 1;
      },
    });

/** 建连后不关闭、不断开：一条挂着的长连接 */
const hanging: MakeBody = (probe) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame({ type: "task", task: ACTIVE }));
    },
    cancel() {
      probe.cancelCount += 1;
    },
  });

const mounted: HookHarness[] = [];

const mountWatch = (callbacks: UseTaskWatchCallbacks, makeBody: MakeBody) => {
  const probe: Probe = { fetchCount: 0, cancelCount: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      probe.fetchCount += 1;
      const body = makeBody(probe);
      if (body instanceof Error) throw body;
      return new Response(body, {
        status: 200,
        headers: SSE_HEADERS,
      });
    }),
  );
  const harness = createHookHarness();
  mounted.push(harness);
  harness.render(() => useTaskWatch("t1", callbacks, true, 0));
  harness.flushEffects();
  return { probe, harness };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  // 休眠等待（createDormantWaiter）直接读全局 window / document
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { hidden: false }),
  );
});

afterEach(() => {
  for (const h of mounted.splice(0)) h.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isStableWatchConnection / settleWatchBudget（纯函数）", () => {
  it("稳定窗口常量 = 2000ms（改它要同步改文档里「watch SSE 重连」的不变量行）", () => {
    expect(WATCH_STABLE_CONNECTION_MS).toBe(2_000);
  });

  it.each<[establishedAt: number | null, endedAt: number, stable: boolean]>([
    // null = 从未建连：不算
    [null, 5_000, false],
    // 0 是合法的建连时刻（假时钟从 0 起）——不能被当成「没建连」
    [0, 1_999, false],
    [0, 2_000, true],
    [1_000, 2_999, false],
    [1_000, 3_000, true],
    // 系统时钟被回拨（这里回拨 4s，绝对值也超过窗口）：差为负，不能算稳定
    [5_000, 1_000, false],
  ])("建连 @%s、结束 @%s → 稳定=%s", (establishedAt, endedAt, stable) => {
    expect(isStableWatchConnection(establishedAt, endedAt)).toBe(stable);
  });

  const dirty = (): WatchBudget => ({
    unavailableAttempts: 3,
    transientFailures: 4,
    unavailableNotified: true,
  });

  it("settleWatchBudget：撑过稳定窗口 → 预算清零并返回 true", () => {
    const budget = dirty();
    expect(settleWatchBudget(budget, 0, 2_000)).toBe(true);
    expect(budget).toEqual({
      unavailableAttempts: 0,
      transientFailures: 0,
      unavailableNotified: false,
    });
  });

  it("settleWatchBudget：没撑过 / 从未建连 → 预算原样、返回 false", () => {
    for (const [establishedAt, endedAt] of [
      [0, 1_999],
      [null, 9_999],
    ] as const) {
      const budget = dirty();
      expect(settleWatchBudget(budget, establishedAt, endedAt)).toBe(false);
      expect(budget).toEqual(dirty());
    }
  });
});

describe("useTaskWatch（真跑 hook + 假时钟）：建连后撑不过稳定窗口 → 按失败累计", () => {
  it("建连后 1999ms 就被掐断：第 6 次后进入休眠并提示一次，之后到点自动唤醒重连", async () => {
    const onWatchException = vi.fn();
    const { probe } = mountWatch({ onWatchException }, droppedAfter(1_999));

    // 第 6 次失败发生在 ≈34.5s（22.5s 退避 + 6×1999ms 存活）；此时已耗尽、进入休眠
    await vi.advanceTimersByTimeAsync(40_000);
    expect(probe.fetchCount).toBe(WATCH_MAX_TRANSIENT_FAILURES);
    // 修前：onWatchException 恒为 0、fetch 无限增长（每轮建连即清零）
    expect(onWatchException).toHaveBeenCalledTimes(1);
    // 带 resume 句柄 = 已进入休眠（调用方据此挂「重连」按钮）
    expect(typeof onWatchException.mock.calls[0]?.[1]).toBe("function");

    // 休眠期间不再重连（兜底定时 60s 一次，首次在 ≈94.5s）
    await vi.advanceTimersByTimeAsync(50_000);
    expect(probe.fetchCount).toBe(WATCH_MAX_TRANSIENT_FAILURES);

    // 兜底定时到点：页面可见且在线 → 自动唤醒，发出第 7 次连接
    await vi.advanceTimersByTimeAsync(6_000);
    expect(probe.fetchCount).toBe(WATCH_MAX_TRANSIENT_FAILURES + 1);
    expect(WATCH_DORMANT_RETRY_INTERVAL_MS).toBe(60_000);
  });

  it("建连后 <2s 被服务端正常关流（clean EOF）：同样按失败累计，第 6 次后休眠；提示文案是「建立后立即断开」", async () => {
    const onWatchException = vi.fn();
    const { probe } = mountWatch({ onWatchException }, closedAfter(1_999));

    await vi.advanceTimersByTimeAsync(40_000);
    expect(probe.fetchCount).toBe(WATCH_MAX_TRANSIENT_FAILURES);
    expect(onWatchException).toHaveBeenCalledTimes(1);
    const err = onWatchException.mock.calls[0]?.[0] as Error;
    expect(err.message).toContain("建立后");
    expect(err.message).not.toContain("建立前");
  });

  it("回调抛错（连接挂着不关）：每一轮都取消上一条连接（不泄漏），失败累计到第 6 次后休眠", async () => {
    const onWatchException = vi.fn();
    const { probe } = mountWatch(
      {
        onTaskUpdate: () => {
          throw new Error("一条脏事件把 reducer 炸了");
        },
        onWatchException,
      },
      hanging,
    );

    await vi.advanceTimersByTimeAsync(40_000);
    expect(probe.fetchCount).toBe(WATCH_MAX_TRANSIENT_FAILURES);
    // 修前：cancelCount 恒为 0（每轮留下 1 条没关的连接）
    expect(probe.cancelCount).toBe(probe.fetchCount);
    // 修前：永不休眠、无提示
    expect(onWatchException).toHaveBeenCalledTimes(1);
  });
});

describe("useTaskWatch（真跑 hook + 假时钟）：撑过稳定窗口 → 清零，行为不变", () => {
  it("建连后正好撑过 2000ms 才被掐断：每轮都清零，永不耗尽、不提示（边界：>= 而不是 >）", async () => {
    const onWatchException = vi.fn();
    const { probe } = mountWatch({ onWatchException }, droppedAfter(2_000));

    await vi.advanceTimersByTimeAsync(200_000);
    expect(onWatchException).not.toHaveBeenCalled();
    // 每轮 ≈ 2s 存活 + 1.5s 退避 → 200s 内仍在持续重连
    expect(probe.fetchCount).toBeGreaterThan(40);
  });

  it("非终态任务建连后撑过 2s 被正常关流：清零，1s 后照常重连，不提示", async () => {
    const onWatchException = vi.fn();
    const { probe } = mountWatch({ onWatchException }, closedAfter(2_000));

    await vi.advanceTimersByTimeAsync(100_000);
    expect(onWatchException).not.toHaveBeenCalled();
    // 每轮 ≈ 2s 存活 + 1s 干净重连间隔
    expect(probe.fetchCount).toBeGreaterThan(20);
  });

  it("建连撑过 2s 后被掐断、随后服务一直连不上：只在断开那一刻清零，之后 6 次建连前失败照常耗尽并提示一次（建连时刻不能跨轮残留）", async () => {
    const onWatchException = vi.fn();
    const { probe } = mountWatch({ onWatchException }, (p) =>
      p.fetchCount === 1
        ? droppedAfter(WATCH_STABLE_CONNECTION_MS)(p)
        : new TypeError("network down"),
    );

    // #1 @0 建连存活 2s → 断开时清零并记成第 1 次失败 → 退避 1.5s → #2 @3.5s（连不上）…… #6 @24.5s 第 6 次失败 = 耗尽
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe.fetchCount).toBe(WATCH_MAX_TRANSIENT_FAILURES);
    // 若上一轮的建连时刻残留到后面「从未建连」的轮次，后面每次失败都会被当成「撑过窗口」清零 → 永不耗尽、fetch 无限增长
    expect(onWatchException).toHaveBeenCalledTimes(1);
    expect(typeof onWatchException.mock.calls[0]?.[1]).toBe("function");
  });
});

describe("useTaskWatch（真跑 hook + 假时钟）：终态流毫秒级关闭 ≠ 掉线（终态陷阱）", () => {
  it("任务已 merged：bootstrap + done 后服务端立刻关流——只连 1 次，不当成「建连后立刻断开」去重连", async () => {
    const onDone = vi.fn();
    const onWatchException = vi.fn();
    const { probe } = mountWatch(
      { onDone, onWatchException },
      closedAfter(0, [
        { type: "task", task: MERGED },
        { type: "done", task: MERGED, ok: true },
      ]),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe.fetchCount).toBe(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onWatchException).not.toHaveBeenCalled();
  });

  it("任务已被删（task_deleted 帧后关流）：只连 1 次，不重连", async () => {
    const onTaskDeleted = vi.fn();
    const onWatchException = vi.fn();
    const { probe } = mountWatch(
      { onTaskDeleted, onWatchException },
      closedAfter(0, [
        { type: "task", task: ACTIVE },
        { type: "task_deleted", taskId: "t1" },
      ]),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe.fetchCount).toBe(1);
    expect(onTaskDeleted).toHaveBeenCalledTimes(1);
    expect(onWatchException).not.toHaveBeenCalled();
  });
});
