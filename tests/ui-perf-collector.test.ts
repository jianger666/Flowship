/**
 * 前端流畅度采集器（纯逻辑）：长任务 / 慢交互 / 回前台追赶 / 心跳抽样。
 *
 * 钉死的语义：
 * - 只在「有信号」时上报：长任务 ≥150ms 或有 ≥250ms 的、慢交互 ≥200ms、回前台 3s 内长任务累计 ≥300ms
 * - 没信号时每 N 个可见窗口抽一条「健康心跳」——「没卡」本身也是需要的数据，但不能刷屏
 * - 页面全程不可见的窗口不上报、也不推进心跳（后台没数据意义）
 * - 页面规模探针（heap / DOM 节点数）只在决定上报时才调（DOM 全量计数不便宜）
 */
import { describe, expect, it, vi } from "vitest";

import { createUiPerfCollector } from "@/lib/ui-perf-collector";

const mk = (over: { at?: number; visible?: boolean; heartbeatEvery?: number } = {}) =>
  createUiPerfCollector({ at: 0, visible: true, ...over });

describe("长任务", () => {
  it("单个 260ms 长任务 → 有信号，汇总正确，之后窗口复位", () => {
    const c = mk();
    c.onLongTask(260, 1000);
    const s = c.flush(30_000, "interval");
    expect(s).not.toBeNull();
    expect(s!.longTasks).toEqual({ n: 1, sumMs: 260, maxMs: 260, n100: 1, n250: 1 });
    expect(s!.windowMs).toBe(30_000);
    expect(s!.visibleMs).toBe(30_000);
    expect(s!.heartbeat).toBeUndefined();
    // 复位：下一个窗口没有新数据 → 无信号
    expect(c.flush(60_000, "interval")).toBeNull();
  });

  it("多个长任务：n / sum / max / n100 / n250 分档", () => {
    const c = mk();
    for (const d of [60, 120, 180, 300, 90]) c.onLongTask(d, 1000);
    const s = c.flush(30_000, "interval")!;
    expect(s.longTasks).toEqual({ n: 5, sumMs: 750, maxMs: 300, n100: 3, n250: 1 });
  });

  it("只有 120ms 的小长任务（<150ms 阈值）不算信号 → 不上报", () => {
    const c = mk();
    c.onLongTask(120, 1000);
    expect(c.flush(30_000, "interval")).toBeNull();
  });

  it("≥150ms 的单个长任务就是信号（即使没到 250）", () => {
    const c = mk();
    c.onLongTask(150, 1000);
    expect(c.flush(30_000, "interval")).not.toBeNull();
  });

  it("非法时长（NaN / 负数 / Infinity / 非数字）被忽略", () => {
    const c = mk();
    c.onLongTask(Number.NaN, 1);
    c.onLongTask(-5, 1);
    c.onLongTask(Number.POSITIVE_INFINITY, 1);
    c.onLongTask("300" as unknown as number, 1);
    expect(c.flush(30_000, "interval")).toBeNull();
  });
});

describe("慢交互（输入 / 点击到下一次绘制）", () => {
  it("≥200ms 的交互是信号；n / p50（线性插值）/ max / n200 正确", () => {
    const c = mk();
    c.onInput(100);
    c.onInput(300);
    const s = c.flush(30_000, "interval")!;
    expect(s.inputs).toEqual({ n: 2, p50Ms: 200, maxMs: 300, n200: 1 });
  });

  it("交互都很快（<200ms）→ 不是信号", () => {
    const c = mk();
    c.onInput(40);
    c.onInput(90);
    expect(c.flush(30_000, "interval")).toBeNull();
  });

  it("单窗口交互样本有上限（防无限增长），超出丢最早的", () => {
    const c = mk();
    for (let i = 0; i < 1000; i++) c.onInput(10);
    c.onInput(500); // 最后一个慢交互不能因为上限被丢
    const s = c.flush(30_000, "interval")!;
    expect(s.inputs.maxMs).toBe(500);
    expect(s.inputs.n200).toBe(1);
    expect(s.inputs.n).toBeLessThanOrEqual(1001);
  });
});

describe("可见时长与回前台追赶", () => {
  it("visibleMs = 窗口内所有可见区间之和", () => {
    const c = mk({ at: 0, visible: true });
    c.setVisible(false, 4000);
    c.setVisible(true, 10_000);
    c.onLongTask(400, 10_500); // 制造信号让它上报
    const s = c.flush(12_000, "interval")!;
    expect(s.windowMs).toBe(12_000);
    expect(s.visibleMs).toBe(6000); // 0–4000 + 10000–12000
  });

  it("回前台 3s 内的长任务累计进 afterShowMs；超过 3s 的不计", () => {
    const c = mk({ at: 0, visible: false });
    c.setVisible(true, 10_000);
    c.onLongTask(400, 10_500);
    c.onLongTask(200, 11_000);
    c.onLongTask(500, 14_000); // 回前台后 4s、不计
    const s = c.flush(20_000, "interval")!;
    expect(s.afterShowMs).toBe(600);
  });

  it("回前台追赶 ≥300ms 本身就是信号（即使单个长任务 <150ms）", () => {
    const c = mk({ at: 0, visible: false });
    c.setVisible(true, 10_000);
    for (let i = 0; i < 4; i++) c.onLongTask(100, 10_100 + i * 200);
    const s = c.flush(20_000, "interval")!;
    expect(s.afterShowMs).toBe(400);
  });

  it("没发生过回前台则不带 afterShowMs", () => {
    const c = mk();
    c.onLongTask(300, 1000);
    expect(c.flush(30_000, "interval")!.afterShowMs).toBeUndefined();
  });

  it("页面全程不可见的窗口：不上报，也不推进心跳计数", () => {
    const c = mk({ at: 0, visible: false, heartbeatEvery: 2 });
    expect(c.flush(30_000, "interval")).toBeNull();
    expect(c.flush(60_000, "interval")).toBeNull();
    expect(c.flush(90_000, "interval")).toBeNull();
    // 变可见后：第 1 个可见空窗口不报、第 2 个才是心跳（说明前面不可见的没被计入）
    c.setVisible(true, 90_000);
    expect(c.flush(120_000, "interval")).toBeNull();
    expect(c.flush(150_000, "interval")?.heartbeat).toBe(true);
  });
});

describe("心跳（没卡的数据也要有，但不刷屏）", () => {
  it("每 N 个可见的无信号窗口出一条 heartbeat，并复位计数", () => {
    const c = mk({ heartbeatEvery: 3 });
    expect(c.flush(30_000, "interval")).toBeNull();
    expect(c.flush(60_000, "interval")).toBeNull();
    const hb = c.flush(90_000, "interval");
    expect(hb?.heartbeat).toBe(true);
    expect(hb!.longTasks.n).toBe(0);
    // 复位后重新数
    expect(c.flush(120_000, "interval")).toBeNull();
    expect(c.flush(150_000, "interval")).toBeNull();
    expect(c.flush(180_000, "interval")?.heartbeat).toBe(true);
  });

  it("有信号的窗口上报后，也会重置心跳计数（刚报过就不必再报心跳）", () => {
    const c = mk({ heartbeatEvery: 2 });
    expect(c.flush(30_000, "interval")).toBeNull(); // 空窗口 1
    c.onLongTask(300, 31_000);
    expect(c.flush(60_000, "interval")?.heartbeat).toBeUndefined(); // 信号窗口、重置
    expect(c.flush(90_000, "interval")).toBeNull(); // 空窗口 1（重新数）
    expect(c.flush(120_000, "interval")?.heartbeat).toBe(true); // 空窗口 2 → 心跳
  });
});

describe("不同 reason", () => {
  it("hidden / pagehide / switch：有信号 → 上报并带对应 reason", () => {
    for (const reason of ["hidden", "pagehide", "switch"] as const) {
      const c = mk();
      c.onLongTask(400, 100);
      expect(c.flush(5000, reason)?.reason).toBe(reason);
    }
  });

  it("hidden / pagehide / switch：无信号 → 不上报（切后台不产噪声）", () => {
    for (const reason of ["hidden", "pagehide", "switch"] as const) {
      const c = mk();
      expect(c.flush(5000, reason)).toBeNull();
    }
  });
});

describe("页面规模探针", () => {
  it("上报时才调 probe，并把 heapMB / domNodes 带进去", () => {
    const probe = vi.fn(() => ({ heapMB: 123.4, domNodes: 5678 }));
    const c = mk();
    c.onLongTask(300, 100);
    const s = c.flush(30_000, "interval", probe)!;
    expect(probe).toHaveBeenCalledTimes(1);
    expect(s.heapMB).toBe(123.4);
    expect(s.domNodes).toBe(5678);
  });

  it("不上报时不调 probe（DOM 全量计数不便宜）", () => {
    const probe = vi.fn(() => ({ heapMB: 1, domNodes: 1 }));
    const c = mk();
    expect(c.flush(30_000, "interval", probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("probe 抛错不影响上报（只是少这两个字段）", () => {
    const c = mk();
    c.onLongTask(300, 100);
    const s = c.flush(30_000, "interval", () => {
      throw new Error("boom");
    })!;
    expect(s.longTasks.n).toBe(1);
    expect(s.heapMB).toBeUndefined();
    expect(s.domNodes).toBeUndefined();
  });

  it("probe 返回非法值（NaN / 负数）被丢弃", () => {
    const c = mk();
    c.onLongTask(300, 100);
    const s = c.flush(30_000, "interval", () => ({ heapMB: Number.NaN, domNodes: -1 }))!;
    expect(s.heapMB).toBeUndefined();
    expect(s.domNodes).toBeUndefined();
  });
});

describe("流式代码块高亮统计（附带字段，不是信号）", () => {
  const hl = (over: Record<string, number> = {}) => ({
    requests: 120,
    passthrough: 4,
    cacheHits: 2,
    submitted: 14,
    throttled: 100,
    flushed: 12,
    forks: 0,
    costSumMs: 640.4,
    costMaxMs: 88.6,
    costCount: 14,
    slots: 1,
    ...over,
  });
  const signalled = () => {
    const c = mk();
    c.onLongTask(300, 100);
    return c;
  };

  it("有高亮请求：随上报带上，数值取整", () => {
    const s = signalled().flush(30_000, "interval", () => ({ highlight: hl() }))!;
    expect(s.highlight).toEqual(hl({ costSumMs: 640, costMaxMs: 89 }));
  });

  it("心跳样本也带（心跳是它最主要的搭载者）", () => {
    const c = mk({ heartbeatEvery: 1 });
    const s = c.flush(30_000, "interval", () => ({ highlight: hl() }))!;
    expect(s.heartbeat).toBe(true);
    expect(s.highlight?.requests).toBe(120);
  });

  it("窗口内没有高亮请求（requests=0）→ 省略，不留一个全 0 的对象", () => {
    const s = signalled().flush(30_000, "interval", () => ({
      highlight: hl({ requests: 0, submitted: 0, throttled: 0, costSumMs: 0, costMaxMs: 0, costCount: 0 }),
    }))!;
    expect(s.highlight).toBeUndefined();
  });

  it("任一字段缺失 / NaN / 负数 → 整个 highlight 省略（不收半截数据），其余字段照常", () => {
    const bads: Record<string, number>[] = [
      { requests: Number.NaN },
      { throttled: -1 },
      { costMaxMs: Number.POSITIVE_INFINITY },
    ];
    for (const bad of bads) {
      const s = signalled().flush(30_000, "interval", () => ({ heapMB: 50, highlight: hl(bad) }))!;
      expect(s.highlight).toBeUndefined();
      expect(s.heapMB).toBe(50);
    }
    const missing = signalled().flush(30_000, "interval", () => ({
      highlight: { requests: 10 } as unknown as ReturnType<typeof hl>,
    }))!;
    expect(missing.highlight).toBeUndefined();
  });

  it("探针没提供 highlight → 省略；上报本身不受影响", () => {
    const s = signalled().flush(30_000, "interval", () => ({ heapMB: 1 }))!;
    expect(s.highlight).toBeUndefined();
    expect(s.longTasks.n).toBe(1);
  });

  it("高亮统计本身不构成信号：没卡就不上报，探针（即取走统计）也不会被调", () => {
    const probe = vi.fn(() => ({ highlight: hl() }));
    const c = mk();
    expect(c.flush(30_000, "interval", probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("窗口边界", () => {
  it("每次 flush 之后窗口从那一刻重新起算（不管有没有上报）", () => {
    const c = mk();
    expect(c.flush(30_000, "interval")).toBeNull();
    c.onLongTask(300, 31_000);
    const s = c.flush(60_000, "interval")!;
    expect(s.windowMs).toBe(30_000);
    expect(s.visibleMs).toBe(30_000);
  });

  it("样本版本号 v=1", () => {
    const c = mk();
    c.onLongTask(300, 1);
    expect(c.flush(1000, "interval")!.v).toBe(1);
  });
});
