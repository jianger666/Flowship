/**
 * 「待判定」槽的生命周期（src/components/browser/typed-visit-recorder.ts）：登记 → 状态推送复核 → 到点复核 → 记 / 弃。
 * 时钟与定时器都是手动推进的假实现，不依赖真实时间。
 */
import { describe, expect, it, vi } from "vitest";

import { createTypedVisitRecorder, RECHECK_SLACK_MS } from "@/components/browser/typed-visit-recorder";
import { TYPED_VISIT_LOADING_GRACE_MS, TYPED_VISIT_TTL_MS, type PendingTypedVisit } from "@/components/browser/typed-visit";
import type { TabInfo } from "@/lib/browser-bridge-types";

const T0 = 1_000_000;
const START = "https://start.example/home";
const TYPED = "https://example.com/a";

const tab = (over: Partial<TabInfo> = {}): TabInfo => ({
  id: "t1",
  url: START,
  title: "",
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true,
  ...over,
});
const pend = (over: Partial<PendingTypedVisit> = {}): PendingTypedVisit => ({ url: TYPED, tabId: "t1", startUrl: START, startedAt: T0, ...over });

/** 手动时钟 + 手动定时器：advance(ms) 把时间往前推，并按到点顺序触发定时器 */
const harness = (recordImpl: (v: { url: string; title: string }) => Promise<unknown> = async () => ({})) => {
  let clock = T0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const record = vi.fn(recordImpl);
  const recorder = createTypedVisitRecorder({
    record,
    now: () => clock,
    schedule: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    cancel: (h) => {
      timers.delete(h as number);
    },
  });
  const advance = (ms: number) => {
    const target = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = Math.max(clock, due[1].at);
      due[1].fn();
    }
    clock = target;
  };
  return { recorder, record, advance, timers, now: () => clock };
};

describe("登记 → 状态推送 → 记", () => {
  it("提交时还没离开出发地：等；状态推送来了（新页面已打开）→ 记，且只记一次", () => {
    const h = harness();
    h.recorder.update([tab()]);
    h.recorder.begin(pend());
    expect(h.record).not.toHaveBeenCalled();
    h.recorder.update([tab({ url: TYPED, title: "Example A" })]);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith({ url: TYPED, title: "Example A" });
    // 之后再来状态推送（标题 / 图标更新…）不会重复记
    h.recorder.update([tab({ url: TYPED, title: "Example A (2)" })]);
    h.recorder.update([tab({ url: TYPED, title: "Example A (3)" })]);
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it("登记那一刻状态已经是「打开了」（重敲当前页的地址）→ 立刻记，不干等下一次推送", () => {
    const h = harness();
    h.recorder.update([tab({ url: TYPED, title: "Same Page" })]);
    h.recorder.begin(pend({ startUrl: TYPED }));
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith({ url: TYPED, title: "Same Page" });
  });

  it("没有登记任何待判定时，状态推送什么都不做", () => {
    const h = harness();
    h.recorder.update([tab({ url: TYPED, title: "A" })]);
    h.recorder.update([tab({ url: "https://other.example/", title: "B" })]);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(0);
  });

  it("打开失败（loadFailed）→ 弃，不记；之后的推送也不会再回头记它", () => {
    const h = harness();
    h.recorder.update([tab()]);
    h.recorder.begin(pend());
    h.recorder.update([tab({ url: TYPED, title: "example.com", loadFailed: true })]);
    h.recorder.update([tab({ url: TYPED, title: "example.com" })]); // 即使后来状态看着像成功，这次判定已经结案
    expect(h.record).not.toHaveBeenCalled();
  });

  it("无痕标签 / 标签没了 → 弃", () => {
    const a = harness();
    a.recorder.update([tab()]);
    a.recorder.begin(pend());
    a.recorder.update([tab({ url: TYPED, incognito: true })]);
    expect(a.record).not.toHaveBeenCalled();

    const b = harness();
    b.recorder.update([tab()]);
    b.recorder.begin(pend());
    b.recorder.update([]);
    b.recorder.update([tab({ url: TYPED, title: "A" })]);
    expect(b.record).not.toHaveBeenCalled();
  });

  it("后一次登记覆盖前一次：只有最新的那个会被记", () => {
    const h = harness();
    h.recorder.update([tab()]);
    h.recorder.begin(pend({ url: "https://first.example/" }));
    h.recorder.begin(pend({ url: "https://second.example/" }));
    h.recorder.update([tab({ url: "https://second.example/", title: "Second" })]);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith({ url: "https://second.example/", title: "Second" });
  });
});

describe("到点复核：只会被时间解开的「等」", () => {
  it("页面挂着不返回的子资源（url 已是新页面、loading 一直 true、不再有状态推送）：到宽限那一刻自己复核 → 记", () => {
    const h = harness();
    h.recorder.update([tab()]);
    h.recorder.begin(pend());
    h.recorder.update([tab({ url: TYPED, title: "Slow", loading: true })]);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(1);

    h.advance(TYPED_VISIT_LOADING_GRACE_MS - 1);
    expect(h.record).not.toHaveBeenCalled();
    h.advance(1 + RECHECK_SLACK_MS);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith({ url: TYPED, title: "Slow" });
    expect(h.timers.size).toBe(0);
  });

  it("一直等不到结果（比如变成了下载、url 没变）：到 TTL 作废并停止计时，不留悬空定时器", () => {
    const h = harness();
    h.recorder.update([tab()]);
    h.recorder.begin(pend());
    expect(h.timers.size).toBe(1);

    h.advance(TYPED_VISIT_LOADING_GRACE_MS + RECHECK_SLACK_MS + 1); // 宽限到点：仍是等（没离开出发地），再排下一个（TTL）
    expect(h.record).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(1);

    h.advance(TYPED_VISIT_TTL_MS);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(0);

    // 作废之后新的状态推送不会让它复活
    h.recorder.update([tab({ url: TYPED, title: "Late" })]);
    expect(h.record).not.toHaveBeenCalled();
  });

  it("状态推送来了就重排计时（不会累积多个定时器）", () => {
    const h = harness();
    h.recorder.update([tab()]);
    h.recorder.begin(pend());
    for (let i = 0; i < 10; i++) h.recorder.update([tab({ url: TYPED, title: `T${i}`, loading: true })]);
    expect(h.timers.size).toBe(1);
  });

  it("结案（记 / 弃）后计时被取消", () => {
    const h = harness();
    h.recorder.update([tab()]);
    h.recorder.begin(pend());
    expect(h.timers.size).toBe(1);
    h.recorder.update([tab({ url: TYPED, title: "A" })]);
    expect(h.timers.size).toBe(0);
  });

  it("dispose：取消计时、丢掉待判定；之后即使到点 / 来推送也不记", () => {
    const h = harness();
    h.recorder.update([tab()]);
    h.recorder.begin(pend());
    h.recorder.update([tab({ url: TYPED, title: "Slow", loading: true })]);
    h.recorder.dispose();
    expect(h.timers.size).toBe(0);
    h.advance(TYPED_VISIT_TTL_MS * 2);
    h.recorder.update([tab({ url: TYPED, title: "Slow" })]);
    expect(h.record).not.toHaveBeenCalled();
  });
});

describe("记录失败不外溢", () => {
  it("record 异步 reject：吞掉（没有未处理的 rejection），待判定照常结案", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = harness(async () => Promise.reject(new Error("磁盘不可写")));
      h.recorder.update([tab()]);
      h.recorder.begin(pend());
      h.recorder.update([tab({ url: TYPED, title: "A" })]);
      await new Promise((r) => setTimeout(r, 10));
      expect(h.record).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      // 之后同样的状态不会重试
      h.recorder.update([tab({ url: TYPED, title: "A" })]);
      expect(h.record).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("record 同步抛错：同样吞掉", () => {
    const h = harness();
    h.record.mockImplementationOnce(() => {
      throw new Error("sync boom");
    });
    h.recorder.update([tab()]);
    h.recorder.begin(pend());
    expect(() => h.recorder.update([tab({ url: TYPED, title: "A" })])).not.toThrow();
    expect(h.record).toHaveBeenCalledTimes(1);
  });
});

describe("默认的时钟与定时器", () => {
  it("不注入 now / schedule / cancel 也能工作（用真实的 Date.now / setTimeout）", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      const record = vi.fn(async () => ({}));
      const recorder = createTypedVisitRecorder({ record });
      recorder.update([tab()]);
      recorder.begin(pend());
      recorder.update([tab({ url: TYPED, title: "Slow", loading: true })]);
      expect(record).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(TYPED_VISIT_LOADING_GRACE_MS + RECHECK_SLACK_MS);
      expect(record).toHaveBeenCalledTimes(1);
      recorder.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
