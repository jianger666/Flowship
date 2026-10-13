/** 启动诊断：时间线 / 主线程卡顿监测 / 首页请求记录器（electron-app/boot-diag.mjs，纯函数 + 注入时钟）。 */
import { describe, expect, it } from "vitest";

import {
  createBootTimeline,
  createLagMonitor,
  createRequestRecorder,
  formatLagSummary,
  formatRequestSummary,
} from "../electron-app/boot-diag.mjs";

describe("createBootTimeline", () => {
  it("按时间排序、给出相邻差值——「慢在哪一段」直接读出来", () => {
    let t = 0;
    const tl = createBootTimeline({ now: () => t });
    t = 2.1;
    tl.mark("appReady");
    t = 2.4;
    tl.mark("splash");
    t = 20.4;
    tl.mark("serverReady");
    expect(tl.summary()).toBe("appReady=2.1s(+2.1) splash=2.4s(+0.3) serverReady=20.4s(+18.0)");
  });

  it("同名里程碑只记第一次（重试 / 重复触发不覆盖最早的时间点）", () => {
    let t = 1;
    const tl = createBootTimeline({ now: () => t });
    tl.mark("serverSpawn");
    t = 9;
    tl.mark("serverSpawn");
    expect(tl.get("serverSpawn")).toBe(1);
    expect(tl.has("serverSpawn")).toBe(true);
    expect(tl.has("nope")).toBe(false);
  });

  it("乱序打点也按发生时间排（异步里程碑先后不固定）", () => {
    let t = 0;
    const tl = createBootTimeline({ now: () => t });
    t = 5;
    tl.mark("b");
    t = 3;
    tl.mark("a");
    expect(tl.entries().map(([n]) => n)).toEqual(["a", "b"]);
    expect(tl.summary()).toBe("a=3.0s(+3.0) b=5.0s(+2.0)");
  });

  it("没有任何里程碑时不抛错", () => {
    expect(createBootTimeline({ now: () => 0 }).summary()).toBe("（无）");
  });

  it("默认时钟取 process.uptime()（基准是主进程启动，appReady 才包含 exe 被扫描 + Chromium 初始化）", () => {
    const tl = createBootTimeline();
    tl.mark("x");
    const v = tl.get("x") as number;
    expect(v).toBeGreaterThan(0);
    expect(Math.abs(v - process.uptime())).toBeLessThan(5);
  });
});

describe("createLagMonitor", () => {
  const harness = () => {
    let now = 0;
    let cb: (() => void) | null = null;
    let cleared = false;
    let unrefCalled = false;
    const monitor = createLagMonitor({
      intervalMs: 50,
      stallMs: 250,
      now: () => now,
      setIntervalFn: ((fn: () => void) => {
        cb = fn;
        return {
          unref: () => {
            unrefCalled = true;
          },
        };
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => {
        cleared = true;
      }) as unknown as typeof clearInterval,
    });
    return {
      monitor,
      advance: (ms: number) => {
        now += ms;
        cb?.();
      },
      get cleared() {
        return cleared;
      },
      get unrefCalled() {
        return unrefCalled;
      },
    };
  };

  it("按期触发 = 0 延迟；主线程被占住 N ms 就记下多出来的那部分", () => {
    const h = harness();
    h.monitor.start();
    h.advance(50);
    h.advance(50);
    expect(h.monitor.snapshot().maxMs).toBe(0);
    h.advance(50 + 700); // 本该 50ms 触发、实际晚了 700ms
    h.advance(50 + 300);
    h.advance(50 + 100);
    const s = h.monitor.snapshot();
    expect(s.maxMs).toBe(700);
    expect(s.stalls).toBe(2); // 700 和 300 达到 250 阈值，100 没有
    expect(s.samples).toBe(5);
    expect(s.totalLagMs).toBe(1100);
  });

  it("定时器 unref（观测用，不能拖住进程退出）；stop 会清除；重复 start 不重复挂", () => {
    const h = harness();
    h.monitor.start();
    h.monitor.start();
    expect(h.unrefCalled).toBe(true);
    h.monitor.stop();
    expect(h.cleared).toBe(true);
  });

  it("时钟回拨不产生负延迟", () => {
    const h = harness();
    h.monitor.start();
    h.advance(-20);
    expect(h.monitor.snapshot().maxMs).toBe(0);
  });

  it("formatLagSummary 一行里有最大延迟 / 卡顿次数 / 总延迟", () => {
    const line = formatLagSummary({ maxMs: 699.6, stalls: 2, samples: 5, totalLagMs: 1100, intervalMs: 50, stallMs: 250 });
    expect(line).toBe("mainLoop maxLag=700ms stalls(>=250ms)=2 totalLag=1.1s samples=5");
  });
});

describe("createRequestRecorder", () => {
  const harness = (maxEntries?: number) => {
    let now = 0;
    const rec = createRequestRecorder({ now: () => now, maxEntries });
    return { rec, at: (t: number) => void (now = t) };
  };

  it("记录首字节（ttfb）与总耗时，只留路径、丢弃查询串（可能带 token）", () => {
    const { rec, at } = harness();
    at(0);
    rec.start(1, "http://127.0.0.1:8876/api/tasks?token=secret&x=1#frag", "xhr");
    at(300);
    rec.responseStarted(1, 200, false);
    at(900);
    rec.finish(1);
    const s = rec.snapshot();
    expect(s.n).toBe(1);
    expect(s.slowest[0]).toMatchObject({ path: "/api/tasks", type: "xhr", status: 200, ttfbMs: 300, totalMs: 900 });
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("并发峰值 / 跨度 / 类型分布", () => {
    const { rec, at } = harness();
    at(0);
    rec.start(1, "http://x/a.js", "script");
    rec.start(2, "http://x/b.js", "script");
    rec.start(3, "http://x/api/a", "xhr");
    at(100);
    rec.finish(1);
    at(250);
    rec.finish(2);
    rec.finish(3);
    const s = rec.snapshot();
    expect(s.maxConcurrent).toBe(3);
    expect(s.spanMs).toBe(250);
    expect(s.byType).toEqual({ script: 2, xhr: 1 });
  });

  it("slowest 按总耗时降序、数量受 top 限制", () => {
    const { rec, at } = harness();
    at(0);
    for (let i = 0; i < 6; i++) rec.start(i, `http://x/r${i}`, "xhr");
    // r0 100ms r1 600 r2 300 r3 900 r4 200 r5 50
    const total = [100, 600, 300, 900, 200, 50];
    for (const [i, ms] of total.entries()) {
      at(ms);
      rec.finish(i);
    }
    const top = rec.snapshot({ top: 3 }).slowest;
    expect(top.map((e) => e.path)).toEqual(["/r3", "/r1", "/r2"]);
  });

  it("还没结束的请求也出现在榜单里（标 pending）：一直没回来的请求才是最该看的", () => {
    const { rec, at } = harness();
    at(0);
    rec.start(1, "http://x/api/hang", "xhr");
    rec.start(2, "http://x/fast", "xhr");
    at(10);
    rec.finish(2);
    at(5000);
    const s = rec.snapshot();
    expect(s.pending).toBe(1);
    expect(s.slowest[0]).toMatchObject({ path: "/api/hang", pending: true, totalMs: 5000 });
  });

  it("出错的请求计入 errors 并带上错误名", () => {
    const { rec, at } = harness();
    at(0);
    rec.start(1, "http://x/a", "xhr");
    at(40);
    rec.finish(1, { error: "net::ERR_CONNECTION_REFUSED" });
    const s = rec.snapshot();
    expect(s.errors).toBe(1);
    expect(s.slowest[0].error).toBe("net::ERR_CONNECTION_REFUSED");
  });

  it("同一个 id 重复触发（重定向）保留最早的起点；没见过的 id 的 finish / responseStarted 忽略", () => {
    const { rec, at } = harness();
    at(0);
    rec.start(1, "http://x/a", "xhr");
    at(100);
    rec.start(1, "http://x/a-redirected", "xhr");
    at(200);
    rec.finish(1);
    rec.finish(99);
    rec.responseStarted(99, 200, false);
    const s = rec.snapshot();
    expect(s.n).toBe(1);
    expect(s.slowest[0]).toMatchObject({ path: "/a", totalMs: 200 });
  });

  it("记录条数有上限（防长时间运行内存涨）；超出的计入 dropped", () => {
    const { rec, at } = harness(3);
    at(0);
    for (let i = 0; i < 5; i++) rec.start(i, `http://x/${i}`, "xhr");
    expect(rec.snapshot().dropped).toBe(2);
  });

  it("ttfb 分位数只统计拿到响应头的请求", () => {
    const { rec, at } = harness();
    for (let i = 1; i <= 10; i++) {
      at(0);
      rec.start(i, `http://x/${i}`, "xhr");
      at(i * 10);
      rec.responseStarted(i, 200, false);
      rec.finish(i);
    }
    const s = rec.snapshot();
    expect(s.ttfbP50).toBe(50);
    expect(s.ttfbP95).toBe(100);
    expect(s.ttfbMax).toBe(100);
  });

  it("formatRequestSummary：第一行汇总、后面每个慢请求一行；pending / error 有标记", () => {
    const { rec, at } = harness();
    at(0);
    rec.start(1, "http://x/api/slow", "xhr");
    rec.start(2, "http://x/api/hang", "xhr");
    rec.start(3, "http://x/bad", "image");
    at(1200);
    rec.responseStarted(1, 200, false);
    rec.finish(1);
    rec.finish(3, { error: "net::ERR_FAILED" });
    at(9000);
    const lines = formatRequestSummary(rec.snapshot({ top: 3 }));
    expect(lines[0]).toContain("requests done=2 pending=1 errors=1");
    expect(lines[0]).toContain("byType=xhr:2,image:1");
    expect(lines[1]).toMatch(/^req-slow #1 total=9000ms ttfb=- status=0 type=xhr PENDING \/api\/hang$/);
    expect(lines.join("\n")).toContain("error=net::ERR_FAILED");
    expect(lines.join("\n")).toContain("ttfb=1200ms status=200 type=xhr /api/slow");
  });

  it("没有任何请求时汇总行也不抛错", () => {
    const { rec } = harness();
    const lines = formatRequestSummary(rec.snapshot());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("done=0");
    expect(lines[0]).toContain("byType=（无）");
  });
});
