/**
 * 低磁盘读数的轮询调度（R14 B2-4c）：src/lib/low-disk-poller.ts
 * 依赖全部注入（fetch / 定时器 / 时钟 / 可见性），用手写假时钟直接单测——useLowDisk 只是把它接到 fetch / window 事件 / React state 上。
 *   A. start：立刻取一次（不看可见性）、排下一次
 *   B. 定时：到点再取；间隔从「上一次取完」算起；页面不可见时到点不取、仍排下一次
 *   C. nudge（窗口聚焦 / 变可见）：防抖、取完重排（定时器不累积）
 *   D. 同一时刻最多一个请求在飞
 *   E. 取不到（null / 抛错）：不动状态、照常排下一次
 *   F. stop：清定时器、迟到结果丢弃、nudge 无效；stop 后可重新 start
 *   G. 默认值取自 lib/low-disk（间隔 / 防抖），也可注入覆盖
 * ⚠ 假时钟 + 假 fetch：没有在真实浏览器 / Electron 里跑过。
 */
import { describe, expect, it } from "vitest";

import { LOW_DISK_MIN_GAP_MS, LOW_DISK_POLL_INTERVAL_MS, type DiskReading } from "@/lib/low-disk";
import { createLowDiskPoller } from "@/lib/low-disk-poller";

const r = (level: DiskReading["level"], freeMB: number | null): DiskReading => ({ level, freeMB });

/** 让已排队的微任务（await 链）跑完 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

type FetchMode = "ok" | "null" | "throw" | "hang";

const makeHarness = (opts: { intervalMs?: number; minGapMs?: number } = {}) => {
  let now = 1_000_000;
  let visible = true;
  let nextId = 1;
  let mode: FetchMode = "ok";
  let value: DiskReading = r("critical", 300);
  const timers = new Map<number, { at: number; fn: () => void }>();
  const readings: DiskReading[] = [];
  const fetchTimes: number[] = [];
  const hanging: Array<(v: DiskReading | null) => void> = [];

  const poller = createLowDiskPoller({
    fetchReading: () => {
      fetchTimes.push(now);
      if (mode === "throw") return Promise.reject(new Error("boom"));
      if (mode === "null") return Promise.resolve(null);
      if (mode === "hang") return new Promise<DiskReading | null>((resolve) => hanging.push(resolve));
      return Promise.resolve(value);
    },
    onReading: (x) => readings.push(x),
    isVisible: () => visible,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    ...opts,
  });

  /** 推进假时钟；途中到点的定时器按时间顺序触发 */
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
      await flush();
    }
    now = target;
    await flush();
  };

  return {
    poller,
    readings,
    fetchTimes,
    timers,
    hanging,
    advance,
    now: () => now,
    nextTimerAt: (): number | null => {
      const ats = [...timers.values()].map((t) => t.at);
      return ats.length === 0 ? null : Math.min(...ats);
    },
    setVisible: (v: boolean) => {
      visible = v;
    },
    setMode: (m: FetchMode) => {
      mode = m;
    },
    setValue: (v: DiskReading) => {
      value = v;
    },
  };
};

describe("A. start", () => {
  it("立刻取一次并把读数交给 onReading，然后排下一次（一个定时器）", async () => {
    const h = makeHarness();
    h.poller.start();
    await flush();
    expect(h.fetchTimes).toHaveLength(1);
    expect(h.readings).toEqual([r("critical", 300)]);
    expect(h.timers.size).toBe(1);
    expect(h.nextTimerAt()).toBe(h.now() + LOW_DISK_POLL_INTERVAL_MS);
  });

  it("挂载取数不看可见性（页面刚挂上、visibilityState 还没稳定也要有首个读数）", async () => {
    const h = makeHarness();
    h.setVisible(false);
    h.poller.start();
    await flush();
    expect(h.fetchTimes).toHaveLength(1);
    expect(h.readings).toHaveLength(1);
  });
});

describe("B. 定时", () => {
  it("到点再取一次；差 1ms 不取", async () => {
    const h = makeHarness();
    h.poller.start();
    await flush();
    await h.advance(LOW_DISK_POLL_INTERVAL_MS - 1);
    expect(h.fetchTimes).toHaveLength(1);
    await h.advance(1);
    expect(h.fetchTimes).toHaveLength(2);
    expect(h.timers.size).toBe(1);
  });

  it("间隔从「上一次取完」算起：取数慢（2 分钟）也不会叠请求、下一次在取完之后再过一个间隔", async () => {
    const h = makeHarness();
    h.setMode("hang");
    h.poller.start();
    await flush();
    expect(h.timers.size).toBe(0); // 在飞期间还没排下一次
    await h.advance(120_000);
    h.hanging[0]!(r("critical", 250));
    await flush();
    expect(h.readings).toEqual([r("critical", 250)]);
    expect(h.nextTimerAt()).toBe(h.now() + LOW_DISK_POLL_INTERVAL_MS);
    // 从开始取数算已过 2 分钟 + 5 分钟 − 1ms：还没到
    h.setMode("ok");
    await h.advance(LOW_DISK_POLL_INTERVAL_MS - 1);
    expect(h.fetchTimes).toHaveLength(1);
    await h.advance(1);
    expect(h.fetchTimes).toHaveLength(2);
  });

  it("页面不可见时到点不取、仍排下一次；回到前台 nudge 立刻补取", async () => {
    const h = makeHarness();
    h.poller.start();
    await flush();
    h.setVisible(false);
    await h.advance(LOW_DISK_POLL_INTERVAL_MS);
    expect(h.fetchTimes).toHaveLength(1); // 到点没取
    expect(h.timers.size).toBe(1); // 但还排着，没断
    h.setVisible(true);
    h.poller.nudge();
    await flush();
    expect(h.fetchTimes).toHaveLength(2);
  });

  it("一直不可见也一直排着：之后任意一次回到前台都能补上", async () => {
    const h = makeHarness();
    h.poller.start();
    await flush();
    h.setVisible(false);
    await h.advance(LOW_DISK_POLL_INTERVAL_MS * 3);
    expect(h.fetchTimes).toHaveLength(1);
    expect(h.timers.size).toBe(1);
  });
});

describe("C. nudge", () => {
  it("防抖：距上次开始取数不足 30s 不取，满 30s 取", async () => {
    const h = makeHarness();
    h.poller.start();
    await flush();
    h.poller.nudge();
    await flush();
    expect(h.fetchTimes).toHaveLength(1);
    await h.advance(LOW_DISK_MIN_GAP_MS - 1);
    h.poller.nudge();
    await flush();
    expect(h.fetchTimes).toHaveLength(1);
    await h.advance(1);
    h.poller.nudge();
    await flush();
    expect(h.fetchTimes).toHaveLength(2);
  });

  it("防抖从「开始取数」算起：取数慢（2 分钟）、取完立刻 nudge，已经超过 30s，要取", async () => {
    const h = makeHarness();
    h.setMode("hang");
    h.poller.start();
    await flush();
    await h.advance(120_000);
    h.hanging[0]!(r("critical", 250));
    await flush();
    expect(h.fetchTimes).toHaveLength(1);
    h.setMode("ok");
    h.poller.nudge();
    await flush();
    expect(h.fetchTimes).toHaveLength(2);
  });

  it("页面不可见时 nudge 不取（visibilitychange 到 hidden 也会触发 nudge）", async () => {
    const h = makeHarness();
    h.poller.start();
    await flush();
    await h.advance(LOW_DISK_MIN_GAP_MS);
    h.setVisible(false);
    h.poller.nudge();
    await flush();
    expect(h.fetchTimes).toHaveLength(1);
  });

  it("nudge 取完会重排下一次，且定时器不累积（始终只有一个）", async () => {
    const h = makeHarness();
    h.poller.start();
    await flush();
    for (let i = 0; i < 4; i++) {
      await h.advance(LOW_DISK_MIN_GAP_MS);
      h.poller.nudge();
      await flush();
      expect(h.timers.size).toBe(1);
      expect(h.nextTimerAt()).toBe(h.now() + LOW_DISK_POLL_INTERVAL_MS);
    }
    expect(h.fetchTimes).toHaveLength(5);
  });
});

describe("D. 同一时刻最多一个请求在飞", () => {
  it("取数挂着时 nudge 不发第二个请求", async () => {
    const h = makeHarness();
    h.setMode("hang");
    h.poller.start();
    await flush();
    await h.advance(LOW_DISK_MIN_GAP_MS * 2);
    h.poller.nudge();
    await flush();
    expect(h.fetchTimes).toHaveLength(1);
    expect(h.timers.size).toBe(0); // 在飞期间 nudge 完全无副作用：不发请求，也不另排定时器
  });

  it("nudge 触发的取数挂着时，旧定时器到点也不发第三个请求（只重排）", async () => {
    const h = makeHarness();
    h.poller.start(); // ok：排上定时器
    await flush();
    h.setMode("hang");
    await h.advance(LOW_DISK_MIN_GAP_MS);
    h.poller.nudge(); // 第 2 次，挂着
    await flush();
    expect(h.fetchTimes).toHaveLength(2);
    await h.advance(LOW_DISK_POLL_INTERVAL_MS); // 旧定时器到点：在飞 → 不再发
    expect(h.fetchTimes).toHaveLength(2);
    expect(h.timers.size).toBe(1); // 重排了，没断
    h.hanging[0]!(r("critical", 200));
    await flush();
    expect(h.readings.at(-1)).toEqual(r("critical", 200));
    expect(h.timers.size).toBe(1);
  });
});

describe("E. 取不到：不动状态、照常排下一次", () => {
  it("fetchReading 返回 null：没有 onReading，仍排着，下次到点继续尝试", async () => {
    const h = makeHarness();
    h.setMode("null");
    h.poller.start();
    await flush();
    expect(h.readings).toEqual([]);
    expect(h.timers.size).toBe(1);
    await h.advance(LOW_DISK_POLL_INTERVAL_MS);
    expect(h.fetchTimes).toHaveLength(2);
  });

  it("fetchReading 抛错：不外抛（没有 unhandled rejection）、没有 onReading、仍排着", async () => {
    // poller 内部是 `void run()`：run 里的异常不兜住就会变成 unhandled rejection（控制台红字、vitest 报 Unhandled Errors）
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = makeHarness();
      h.setMode("throw");
      h.poller.start();
      await flush();
      await new Promise<void>((resolve) => setImmediate(resolve)); // 让 Node 有机会派发 unhandledRejection
      expect(unhandled).toEqual([]);
      expect(h.readings).toEqual([]);
      expect(h.timers.size).toBe(1);
      h.setMode("ok");
      await h.advance(LOW_DISK_POLL_INTERVAL_MS);
      expect(h.readings).toEqual([r("critical", 300)]); // 之后恢复就能取到
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("失败不占在飞标记：失败之后 nudge 还能取", async () => {
    const h = makeHarness();
    h.setMode("throw");
    h.poller.start();
    await flush();
    h.setMode("ok");
    await h.advance(LOW_DISK_MIN_GAP_MS);
    h.poller.nudge();
    await flush();
    expect(h.readings).toEqual([r("critical", 300)]);
  });
});

describe("F. stop", () => {
  it("清掉定时器：之后到点不再取、nudge 无效", async () => {
    const h = makeHarness();
    h.poller.start();
    await flush();
    h.poller.stop();
    expect(h.timers.size).toBe(0);
    await h.advance(LOW_DISK_POLL_INTERVAL_MS * 2);
    h.poller.nudge();
    await flush();
    expect(h.fetchTimes).toHaveLength(1);
  });

  it("请求在飞时 stop：迟到的结果丢弃（组件已卸载，不能再 setState），也不再排定时器", async () => {
    const h = makeHarness();
    h.setMode("hang");
    h.poller.start();
    await flush();
    h.poller.stop();
    h.hanging[0]!(r("critical", 100));
    await flush();
    expect(h.readings).toEqual([]);
    expect(h.timers.size).toBe(0);
  });

  it("stop 之后可以重新 start（StrictMode 开发期 effect 会连续 cleanup + 再挂载）", async () => {
    const h = makeHarness();
    h.poller.start();
    await flush();
    h.poller.stop();
    h.poller.start();
    await flush();
    expect(h.fetchTimes).toHaveLength(2);
    expect(h.timers.size).toBe(1);
    await h.advance(LOW_DISK_POLL_INTERVAL_MS);
    expect(h.fetchTimes).toHaveLength(3);
  });
});

describe("G. 默认值与注入", () => {
  it("默认间隔 / 防抖取自 lib/low-disk（5 分钟 / 30 秒）", () => {
    expect(LOW_DISK_POLL_INTERVAL_MS).toBe(5 * 60_000);
    expect(LOW_DISK_MIN_GAP_MS).toBe(30_000);
  });

  it("可以注入 intervalMs / minGapMs 覆盖默认", async () => {
    const h = makeHarness({ intervalMs: 1000, minGapMs: 200 });
    h.poller.start();
    await flush();
    expect(h.nextTimerAt()).toBe(h.now() + 1000);
    await h.advance(199);
    h.poller.nudge();
    await flush();
    expect(h.fetchTimes).toHaveLength(1);
    await h.advance(1);
    h.poller.nudge();
    await flush();
    expect(h.fetchTimes).toHaveLength(2);
  });
});
