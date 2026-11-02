/**
 * useTaskWatch：重连等待可被 visibilitychange / online 唤醒（评审 K6）。
 *
 * 旧写法：干净断流后的 1s 等待 / 失败退避只靠 setTimeout。窗口隐藏超过 5 分钟后 Chromium 会把定时器节流到约每分钟一次，
 * 用户回来后最长要停在断开状态约 1 分钟。
 *
 * 现在：等待期间同时监听 `document` 的 visibilitychange（变回可见）和 `window` 的 online，任一触发就立刻结束等待、马上重连；
 * 等待结束（到点 / 被唤醒 / 卸载）必摘监听、不泄漏；SSR（无 window / document）安全。
 *
 * 本文件**真跑 hook**（tests/helpers/react-hook-stub.ts 的 dispatcher 桩 + 假时钟），不是镜像。
 * 时间线（退避 = 第 n 次失败后等 min(1500n, 12000)ms）：fetch #1 @0 失败 → 等 1.5s → #2 @1.5s。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listenWatchWake,
  useTaskWatch,
  type UseTaskWatchCallbacks,
} from "@/hooks/use-task-watch";
import { WATCH_CLEAN_RECONNECT_DELAY_MS } from "@/lib/task-terminal";
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

/** 记录当前挂着的监听器数量的 EventTarget（验证「摘干净、不泄漏」） */
class TrackedTarget extends EventTarget {
  private readonly active = new Map<string, Set<unknown>>();
  /** 测试里改它来模拟页面 visible / hidden（document.hidden 读的是下面的 getter） */
  isHidden = false;
  get hidden(): boolean {
    return this.isHidden;
  }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, opts?: unknown) {
    if (listener) {
      const set = this.active.get(type) ?? new Set();
      set.add(listener);
      this.active.set(type, set);
    }
    super.addEventListener(type, listener, opts as AddEventListenerOptions);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, opts?: unknown) {
    this.active.get(type)?.delete(listener);
    super.removeEventListener(type, listener, opts as EventListenerOptions);
  }
  count(type: string): number {
    return this.active.get(type)?.size ?? 0;
  }
}

/** 建连（吐 bootstrap task 帧）后一直挂着 */
const hangingResponse = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({ type: "task", task: TASK }));
      },
    }),
    { status: 200, headers: SSE_HEADERS },
  );

/** 建连后存活 liveMs，然后服务端正常关流（clean EOF） */
const closedAfterResponse = (liveMs: number): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({ type: "task", task: TASK }));
        setTimeout(() => {
          try {
            controller.close();
          } catch {
            /* 连接已被客户端取消 */
          }
        }, liveMs);
      },
    }),
    { status: 200, headers: SSE_HEADERS },
  );

const mounted: HookHarness[] = [];
let win: TrackedTarget;
let doc: TrackedTarget;

const mount = (callbacks: UseTaskWatchCallbacks = {}): HookHarness => {
  const harness = createHookHarness();
  mounted.push(harness);
  harness.render(() => useTaskWatch("t1", callbacks, true, 0));
  harness.flushEffects();
  return harness;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  win = new TrackedTarget();
  doc = new TrackedTarget();
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
});
afterEach(() => {
  for (const h of mounted.splice(0)) h.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("失败退避：visibilitychange / online 唤醒", () => {
  /** fetch #1 失败（退避 1.5s）、之后每次都连上并挂着 */
  const failFirstThenHang = () => {
    let fetchCount = 0;
    const fetchMock = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount === 1) throw new TypeError("network down");
      return hangingResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    return { count: () => fetchCount };
  };

  it("基线：没有唤醒信号时要等满退避（1.5s）才发第 2 次连接", async () => {
    const p = failFirstThenHang();
    mount();
    await vi.advanceTimersByTimeAsync(200);
    expect(p.count()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_400);
    expect(p.count()).toBe(2);
  });

  it("等待中 document 变回可见 → 立刻重连（不等定时器）", async () => {
    const p = failFirstThenHang();
    mount();
    await vi.advanceTimersByTimeAsync(200);
    expect(p.count()).toBe(1);
    expect(doc.count("visibilitychange")).toBe(1);

    doc.isHidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.count()).toBe(2); // 才过了 200ms，退避还剩 1.3s
  });

  it("等待中 window 触发 online → 立刻重连", async () => {
    const p = failFirstThenHang();
    mount();
    await vi.advanceTimersByTimeAsync(200);
    expect(p.count()).toBe(1);
    expect(win.count("online")).toBe(1);

    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.count()).toBe(2);
  });

  it("visibilitychange 但页面仍是隐藏的（变成 hidden）不算：继续等定时器", async () => {
    const p = failFirstThenHang();
    mount();
    await vi.advanceTimersByTimeAsync(200);
    doc.isHidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.count()).toBe(1);
    // 定时器到点照常重连
    await vi.advanceTimersByTimeAsync(1_400);
    expect(p.count()).toBe(2);
  });

  it("唤醒后原定时器不再多发一次连接；同一时刻 visible + online 两个信号只重连一次", async () => {
    const p = failFirstThenHang();
    mount();
    await vi.advanceTimersByTimeAsync(200);
    doc.isHidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.count()).toBe(2);
    // 越过原定时器的到点时刻：连接是挂着的，不应有第 3 次
    await vi.advanceTimersByTimeAsync(5_000);
    expect(p.count()).toBe(2);
  });

  it("等待结束（唤醒 / 到点）就把监听摘干净；连接挂着期间没有任何常驻监听", async () => {
    failFirstThenHang();
    mount();
    await vi.advanceTimersByTimeAsync(200);
    expect(doc.count("visibilitychange")).toBe(1);
    expect(win.count("online")).toBe(1);

    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("online")).toBe(0);

    // 连接挂着：再来信号也不会发新连接
    await vi.advanceTimersByTimeAsync(10_000);
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("online")).toBe(0);
  });

  it("到点结束的等待同样摘监听（不靠唤醒也不泄漏）", async () => {
    failFirstThenHang();
    mount();
    await vi.advanceTimersByTimeAsync(200);
    expect(win.count("online")).toBe(1);
    await vi.advanceTimersByTimeAsync(1_400); // 退避到点
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("online")).toBe(0);
  });

  it("等待中卸载：监听摘干净、之后的信号不再触发重连", async () => {
    const p = failFirstThenHang();
    const harness = mount();
    await vi.advanceTimersByTimeAsync(200);
    expect(doc.count("visibilitychange")).toBe(1);
    expect(win.count("online")).toBe(1);

    harness.unmount();
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("online")).toBe(0);

    doc.isHidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(p.count()).toBe(1); // 卸载后没有新连接
  });
});

describe("干净断流后的重连等待（WATCH_CLEAN_RECONNECT_DELAY_MS）：同样可被唤醒", () => {
  it("连接稳定存活后被服务端正常关流 → 1s 等待中变回可见，立刻重连而不是等满 1s", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        // 第 1 条连接稳定存活 3s（> 稳定窗口 2s）后正常关流；之后的挂着
        return fetchCount === 1 ? closedAfterResponse(3_000) : hangingResponse();
      }),
    );
    mount();
    await vi.advanceTimersByTimeAsync(3_100); // 3s 关流 → 进入 1s 的干净重连等待
    expect(fetchCount).toBe(1);
    expect(win.count("online")).toBe(1);

    doc.isHidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCount).toBe(2); // 距关流才 100ms，远不到 WATCH_CLEAN_RECONNECT_DELAY_MS
    expect(WATCH_CLEAN_RECONNECT_DELAY_MS).toBeGreaterThan(100);
    expect(doc.count("visibilitychange")).toBe(0);
  });
});

describe("listenWatchWake：纯函数行为 + SSR 安全", () => {
  it("visible / online 触发 wake；hidden 不触发；摘监听后不再触发且幂等", () => {
    const wake = vi.fn();
    const detach = listenWatchWake(wake);
    doc.isHidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(wake).not.toHaveBeenCalled();
    doc.isHidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(wake).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new Event("online"));
    expect(wake).toHaveBeenCalledTimes(2);

    detach();
    detach(); // 幂等
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("online"));
    expect(wake).toHaveBeenCalledTimes(2);
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("online")).toBe(0);
  });

  it("SSR（没有 window / document）：返回空操作、不抛", () => {
    vi.unstubAllGlobals(); // node 环境本来就没有 window / document
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    const wake = vi.fn();
    let detach: (() => void) | undefined;
    expect(() => {
      detach = listenWatchWake(wake);
    }).not.toThrow();
    expect(() => detach!()).not.toThrow();
    expect(wake).not.toHaveBeenCalled();
  });

  it("只有 window 没有 document（或反之）也安全：整体当 SSR 处理、不挂半截监听", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("window", win);
    const wake = vi.fn();
    const detach = listenWatchWake(wake);
    expect(win.count("online")).toBe(0);
    expect(() => detach()).not.toThrow();
  });
});

describe("退避逐级推进：唤醒只提前「这一次」的等待，不会变成紧循环", () => {
  it("唤醒后的连接再失败 → 下一次等待是第 2 级退避（3s），不是 0；单个信号只提前一次", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount <= 2) throw new TypeError("network down");
        return hangingResponse();
      }),
    );
    mount();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchCount).toBe(1); // 第 1 次失败，等 1.5s

    win.dispatchEvent(new Event("online")); // 提前重连：第 2 次（立刻失败）
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCount).toBe(2);

    // 第 2 次失败后的退避是 3s（min(1500n, 12000)，n=2）：2.9s 内不会有第 3 次
    await vi.advanceTimersByTimeAsync(2_900);
    expect(fetchCount).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchCount).toBe(3);
  });

  it("唤醒后原定时器作废：原到点时刻不干扰紧接着的下一轮等待——下一轮等待中卸载，监听仍摘干净、之后不再有连接", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        throw new TypeError("down");
      }),
    );
    const harness = mount();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchCount).toBe(1); // 第 1 级退避 1.5s（原定时器 @1.5s）
    win.dispatchEvent(new Event("online")); // @200ms 提前重连：第 2 次立刻失败，进入第 2 级退避（到 @3.2s）
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCount).toBe(2);

    // 越过「原定时器」的到点时刻（@1.5s）、但仍在第 2 级等待之中（@2s）：
    // 原定时器若没清，会在这里去动第 2 级等待的状态，让下面的卸载摘不掉它的监听
    await vi.advanceTimersByTimeAsync(1_800);
    expect(fetchCount).toBe(2);
    expect(doc.count("visibilitychange")).toBe(1);
    expect(win.count("online")).toBe(1);

    harness.unmount();
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("online")).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchCount).toBe(2); // 卸载后没有新连接
  });

  it("网络恢复（online）反复触发也只是每次提前一次：每个信号至多换来一次连接尝试，连接挂着时信号不产生任何连接", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        return fetchCount === 1 ? Promise.reject(new TypeError("down")) : hangingResponse();
      }),
    );
    mount();
    await vi.advanceTimersByTimeAsync(100);
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCount).toBe(2);
    for (let i = 0; i < 10; i += 1) {
      win.dispatchEvent(new Event("online"));
      doc.dispatchEvent(new Event("visibilitychange"));
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchCount).toBe(2); // 连接已建立：没有等待在挂着，信号无处可去
  });

  it("503（服务端暂不可用）的退避同样可被唤醒", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return hangingResponse();
      }),
    );
    mount();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchCount).toBe(1);
    expect(doc.count("visibilitychange")).toBe(1);
    doc.isHidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCount).toBe(2);
  });
});

describe("hidden / onLine 判定", () => {
  it("只有「变回可见」才唤醒：反复切到 hidden 不会提前重连（hidden 判定生效）", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount === 1) throw new TypeError("down");
        return hangingResponse();
      }),
    );
    mount();
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 5; i += 1) {
      doc.isHidden = true;
      doc.dispatchEvent(new Event("visibilitychange"));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCount).toBe(1);
    expect(doc.count("visibilitychange")).toBe(1); // 等待还在、监听还在
  });

  it("online 事件本身就是「网络恢复」的信号：不再额外读 navigator.onLine，直接重连", async () => {
    // 故意把 navigator.onLine 留成 false（某些环境事件先于属性更新）：事件仍然应当触发重连
    vi.stubGlobal("navigator", { onLine: false });
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount === 1) throw new TypeError("down");
        return hangingResponse();
      }),
    );
    mount();
    await vi.advanceTimersByTimeAsync(100);
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCount).toBe(2);
  });

  it("页面变回可见时不看 navigator.onLine（后端在本机 Electron / localhost：onLine=false 不等于连不上）；连不上就回到逐级退避", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount <= 2) throw new TypeError("down");
        return hangingResponse();
      }),
    );
    mount();
    await vi.advanceTimersByTimeAsync(100);
    doc.isHidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCount).toBe(2); // 尝试了一次（失败）
    // 没有变成紧循环：下一次要等第 2 级退避（3s）
    await vi.advanceTimersByTimeAsync(2_900);
    expect(fetchCount).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchCount).toBe(3);
  });
});

describe("监听的生命周期：多轮重连不累积、休眠期不叠加", () => {
  it("连续多轮失败退避（含到点 / 唤醒两种结束方式）：任一时刻每种事件至多挂 1 个监听，不随轮次累积", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        throw new TypeError("down");
      }),
    );
    mount();
    let maxVisibility = 0;
    let maxOnline = 0;
    let sawWaiting = false;
    for (let t = 0; t < 14_000; t += 100) {
      await vi.advanceTimersByTimeAsync(100);
      maxVisibility = Math.max(maxVisibility, doc.count("visibilitychange"));
      maxOnline = Math.max(maxOnline, win.count("online"));
      if (doc.count("visibilitychange") === 1) sawWaiting = true;
      // 中途用 online 唤醒两次，覆盖「唤醒结束等待」这条出口
      if (t === 3_000 || t === 9_000) {
        win.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(0);
        maxVisibility = Math.max(maxVisibility, doc.count("visibilitychange"));
        maxOnline = Math.max(maxOnline, win.count("online"));
      }
    }
    expect(fetchCount).toBeGreaterThanOrEqual(5); // 确实跑了多轮
    expect(sawWaiting).toBe(true);
    expect(maxVisibility).toBe(1);
    expect(maxOnline).toBe(1);
  });

  it("重试预算耗尽进入休眠后：只有休眠等待自己的一对监听（不与退避的监听叠加）；回到前台照常唤醒重连", async () => {
    let fetchCount = 0;
    let healthy = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        if (!healthy) throw new TypeError("down");
        return hangingResponse();
      }),
    );
    const exceptions: Array<{ resume?: () => void }> = [];
    mount({ onWatchException: (_e, resume) => exceptions.push({ resume }) });
    // 连续 6 次失败（退避 1.5+3+4.5+6+7.5s≈22.5s）后进入休眠
    await vi.advanceTimersByTimeAsync(25_000);
    const failedSoFar = fetchCount;
    expect(failedSoFar).toBe(6);
    expect(exceptions.some((e) => typeof e.resume === "function")).toBe(true);
    expect(doc.count("visibilitychange")).toBe(1);
    expect(win.count("online")).toBe(1);

    healthy = true;
    doc.isHidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCount).toBe(failedSoFar + 1); // 休眠被唤醒、重连成功
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("online")).toBe(0);
  });
});

describe("源码契约（仅保留这一条兜底；行为见上）", () => {
  it("useTaskWatch 的重连等待确实经 listenWatchWake 挂监听（不是只在测试里调用）", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.join(process.cwd(), "src/hooks/use-task-watch.ts"), "utf8");
    expect(src).toMatch(/=\s*listenWatchWake\(/);
  });
});
