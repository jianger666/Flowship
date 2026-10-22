/**
 * N9-3：收件箱轮询器（tick / 回前台补拉 / 上次发起时刻）的行为测试。
 *
 * 以前这三处接线直接写在 use-mr-inbox 的 effect 里，只有源码文本断言，拦不住这几类改动：删 `lastFetchAt` 赋值 /
 * tick 判定反转 / tick 不调 refresh / 补拉阈值改 10 分钟 / 恒补拉 / onVisible 去掉「可见才补拉」。
 * 现在抽成 `createInboxPoller`（环境全部注入），用 vitest fake timers 直接驱动，
 * 不需要 jsdom；`createDomInboxPoller`（真实 document / window 那一层）用 `vi.stubGlobal` 驱动。
 *
 * `refresh` 桩与 hook 里的 scanOnce 一致：先 `poller.noteFetchStarted()` 再计数——
 * 这样「删掉 noteFetchStarted → 托盘退化成每 5 分钟扫」这类变异能被看见。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MR_INBOX_HIDDEN_POLL_INTERVAL_MS,
  MR_INBOX_POLL_INTERVAL_MS,
} from "@/lib/mr-inbox";
import {
  createDomInboxPoller,
  createInboxPoller,
  type InboxPoller,
} from "@/lib/mr-inbox-poller";

const MIN = 60 * 1000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 可控环境：可见性 / 壳内与否可随时改，可见性监听可手动触发 */
const makeHarness = (init: { visible: boolean; inShell: boolean }) => {
  const state = { ...init, listeners: new Set<() => void>() };
  const poller = createInboxPoller({
    isVisible: () => state.visible,
    isInShell: () => state.inShell,
    now: () => Date.now(),
    setIntervalFn: (fn, ms) => setInterval(fn, ms),
    clearIntervalFn: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    subscribeVisibility: (fn) => {
      state.listeners.add(fn);
      return () => {
        state.listeners.delete(fn);
      };
    },
  });
  const scans: number[] = [];
  /** 与 hook 的 scanOnce 一致：记发起时刻 + 计数 */
  const refresh = () => {
    poller.noteFetchStarted();
    scans.push(Date.now() - T0);
  };
  /** 改可见性并触发 visibilitychange（真实浏览器里状态先变、事件后到） */
  const setVisible = (visible: boolean) => {
    state.visible = visible;
    for (const l of [...state.listeners]) l();
  };
  return { poller, state, scans, refresh, setVisible };
};

const minutes = (...ms: number[]) => ms.map((m) => m * MIN);

describe("createInboxPoller：tick 节奏", () => {
  it("start 立刻拉一次（不用等第一拍）", () => {
    const h = makeHarness({ visible: true, inShell: false });
    h.poller.start(h.refresh);
    expect(h.scans).toEqual([0]);
  });

  it("窗口可见：每 5 分钟一拍都扫（壳内 / 浏览器一样）", () => {
    for (const inShell of [true, false]) {
      vi.setSystemTime(T0); // 每轮从同一个起点算
      const h = makeHarness({ visible: true, inShell });
      const stop = h.poller.start(h.refresh);
      vi.advanceTimersByTime(30 * MIN);
      expect(h.scans).toEqual(minutes(0, 5, 10, 15, 20, 25, 30));
      stop();
    }
  });

  it("壳内一直不可见（托盘）：每 10 分钟扫一次——靠 noteFetchStarted 记的发起时刻隔拍", () => {
    const h = makeHarness({ visible: false, inShell: true });
    h.poller.start(h.refresh);
    vi.advanceTimersByTime(60 * MIN);
    expect(h.scans).toEqual(minutes(0, 10, 20, 30, 40, 50, 60));
    // 间隔常量与实际节奏一致
    expect(h.scans[1] - h.scans[0]).toBe(MR_INBOX_HIDDEN_POLL_INTERVAL_MS);
  });

  it("浏览器标签页一直不可见：只有启动那一次，之后一次都不扫", () => {
    const h = makeHarness({ visible: false, inShell: false });
    h.poller.start(h.refresh);
    vi.advanceTimersByTime(60 * MIN);
    expect(h.scans).toEqual([0]);
  });

  it("壳内：可见 → 收进托盘 → 再打开，节奏平滑衔接", () => {
    const h = makeHarness({ visible: true, inShell: true });
    h.poller.start(h.refresh);
    vi.advanceTimersByTime(12 * MIN); // 0 / 5 / 10 各扫一次
    h.setVisible(false); // 12 分钟收进托盘：切走那一下不扫
    vi.advanceTimersByTime(48 * MIN); // 到 60 分钟
    // 托盘段：最后一次扫描在 10 分钟，之后 15（距上次 5，不扫）→ 20（10，扫）→ 30 → …
    expect(h.scans).toEqual(minutes(0, 5, 10, 20, 30, 40, 50, 60));
    h.setVisible(true); // 60 分钟刚扫过：回前台不重复扫
    expect(h.scans.length).toBe(8);
    vi.advanceTimersByTime(5 * MIN); // 可见后回到每拍都扫
    expect(h.scans.at(-1)).toBe(65 * MIN);
  });
});

describe("createInboxPoller：回前台补拉（onVisibilityChange）", () => {
  it("数据已超过一拍（浏览器标签页切走很久）：变成可见立刻补拉", () => {
    const h = makeHarness({ visible: false, inShell: false });
    h.poller.start(h.refresh);
    vi.advanceTimersByTime(20 * MIN);
    expect(h.scans).toEqual([0]);
    h.setVisible(true);
    expect(h.scans).toEqual([0, 20 * MIN]);
  });

  it("数据还新（距上次发起不到一拍）：变成可见不补拉——阈值是 MR_INBOX_POLL_INTERVAL_MS", () => {
    const h = makeHarness({ visible: false, inShell: false });
    h.poller.start(h.refresh);
    // 差 1 毫秒到阈值：不补
    vi.advanceTimersByTime(MR_INBOX_POLL_INTERVAL_MS - 1);
    h.setVisible(true);
    expect(h.scans).toEqual([0]);
    // 恰好到阈值：补
    h.setVisible(false);
    vi.advanceTimersByTime(1);
    h.setVisible(true);
    expect(h.scans).toEqual([0, MR_INBOX_POLL_INTERVAL_MS]);
  });

  it("补拉之后的发起时刻被记下：紧接着再切走再切回不重复补拉", () => {
    const h = makeHarness({ visible: false, inShell: false });
    h.poller.start(h.refresh);
    vi.advanceTimersByTime(20 * MIN);
    h.setVisible(true); // 补拉（20）
    h.setVisible(false);
    vi.advanceTimersByTime(2 * MIN);
    h.setVisible(true); // 距上次才 2 分钟
    expect(h.scans).toEqual([0, 20 * MIN]);
  });

  it("变成不可见（或不可见时来了事件）：不扫，即使数据已经很旧——标签页不可见不扫的承诺", () => {
    const h = makeHarness({ visible: false, inShell: false });
    h.poller.start(h.refresh);
    vi.advanceTimersByTime(20 * MIN);
    h.setVisible(false); // 仍不可见的 visibilitychange（数据已 20 分钟旧）
    h.setVisible(false);
    expect(h.scans).toEqual([0]);
  });
});

describe("createInboxPoller：停止与重启", () => {
  it("停止后：定时器清掉、可见性监听取消，再也不扫", () => {
    const h = makeHarness({ visible: true, inShell: true });
    const stop = h.poller.start(h.refresh);
    vi.advanceTimersByTime(5 * MIN);
    expect(h.scans).toEqual(minutes(0, 5));
    expect(h.state.listeners.size).toBe(1);
    stop();
    expect(h.state.listeners.size).toBe(0);
    vi.advanceTimersByTime(60 * MIN);
    h.setVisible(false);
    h.setVisible(true);
    expect(h.scans).toEqual(minutes(0, 5));
  });

  it("重启用新传入的 refresh：旧 refresh 不再被调（hook 里 refresh 身份会随依赖变）", () => {
    const h = makeHarness({ visible: true, inShell: false });
    const oldCalls: number[] = [];
    const stop = h.poller.start(() => {
      h.poller.noteFetchStarted();
      oldCalls.push(Date.now() - T0);
    });
    stop();
    h.poller.start(h.refresh);
    vi.advanceTimersByTime(10 * MIN);
    expect(oldCalls).toEqual([0]); // 只有当初那次立即拉
    expect(h.scans).toEqual(minutes(0, 5, 10));
  });

  it("同一个对象的发起时刻跨 start / stop 保留（不会因 effect 重跑清零）", () => {
    const h = makeHarness({ visible: false, inShell: false });
    const stop = h.poller.start(h.refresh); // 0 扫一次并记下发起时刻
    vi.advanceTimersByTime(3 * MIN);
    stop();
    const restarted: number[] = [];
    // 重启时的立即拉：这个 refresh 刻意不记发起时刻，补拉判断依据只能是第一次扫描记下的那个
    h.poller.start(() => {
      restarted.push(Date.now() - T0);
    });
    vi.advanceTimersByTime(MR_INBOX_POLL_INTERVAL_MS - 3 * MIN - 1); // 现在距第一次扫描差 1ms 到一拍
    h.setVisible(true);
    expect(restarted).toEqual([3 * MIN]); // 只有重启那一次；没补拉 → 还认得第一次的发起时刻
    vi.advanceTimersByTime(1); // 恰好一拍
    h.setVisible(false);
    h.setVisible(true);
    expect(restarted).toEqual([3 * MIN, MR_INBOX_POLL_INTERVAL_MS]);
  });
});

describe("createDomInboxPoller：真实 document / window 那一层（stubGlobal，无需 jsdom）", () => {
  const stubDom = (opts: { visible: boolean; shell: boolean }) => {
    const handlers: Array<() => void> = [];
    const doc = {
      visibilityState: opts.visible ? "visible" : "hidden",
      addEventListener: vi.fn((type: string, fn: () => void) => {
        if (type === "visibilitychange") handlers.push(fn);
      }),
      removeEventListener: vi.fn((type: string, fn: () => void) => {
        const i = handlers.indexOf(fn);
        if (type === "visibilitychange" && i >= 0) handlers.splice(i, 1);
      }),
    };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", opts.shell ? { __shell: { platform: "darwin" } } : {});
    return { doc, handlers };
  };

  const run = (poller: InboxPoller) => {
    const scans: number[] = [];
    const stop = poller.start(() => {
      poller.noteFetchStarted();
      scans.push(Date.now() - T0);
    });
    return { scans, stop };
  };

  it("创建对象时不碰 document / window（SSR 阶段 useState 初始化器也会跑）", () => {
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);
    expect(() => createDomInboxPoller()).not.toThrow();
  });

  it("有 window.__shell 且窗口不可见：10 分钟一扫", () => {
    stubDom({ visible: false, shell: true });
    const { scans } = run(createDomInboxPoller());
    vi.advanceTimersByTime(30 * MIN);
    expect(scans).toEqual(minutes(0, 10, 20, 30));
  });

  it("没有 window.__shell 且窗口不可见：只有启动那一次", () => {
    stubDom({ visible: false, shell: false });
    const { scans } = run(createDomInboxPoller());
    vi.advanceTimersByTime(30 * MIN);
    expect(scans).toEqual([0]);
  });

  it("document.visibilityState === 'visible'：每 5 分钟一扫", () => {
    stubDom({ visible: true, shell: false });
    const { scans } = run(createDomInboxPoller());
    vi.advanceTimersByTime(15 * MIN);
    expect(scans).toEqual(minutes(0, 5, 10, 15));
  });

  it("停止后：DOM 层的 clearInterval 真的生效，再推进多久都不再扫（effect 重跑不泄漏 interval）", () => {
    stubDom({ visible: true, shell: false });
    const { scans, stop } = run(createDomInboxPoller());
    vi.advanceTimersByTime(5 * MIN);
    expect(scans).toEqual(minutes(0, 5));
    stop();
    vi.advanceTimersByTime(60 * MIN);
    expect(scans).toEqual(minutes(0, 5));
  });

  it("订阅的是 document 的 visibilitychange；停止时用同一个处理函数取消", () => {
    const { doc, handlers } = stubDom({ visible: false, shell: false });
    const { stop } = run(createDomInboxPoller());
    expect(doc.addEventListener).toHaveBeenCalledTimes(1);
    expect(doc.addEventListener.mock.calls[0]![0]).toBe("visibilitychange");
    const handler = doc.addEventListener.mock.calls[0]![1];
    stop();
    expect(doc.removeEventListener).toHaveBeenCalledWith("visibilitychange", handler);
    expect(handlers).toHaveLength(0);
  });

  it("visibilitychange 到来时读的是当时的 document.visibilityState：变可见且数据旧 → 补拉", () => {
    const { doc, handlers } = stubDom({ visible: false, shell: false });
    const { scans } = run(createDomInboxPoller());
    vi.advanceTimersByTime(20 * MIN);
    expect(scans).toEqual([0]);
    doc.visibilityState = "visible";
    for (const h of handlers) h();
    expect(scans).toEqual([0, 20 * MIN]);
  });
});
