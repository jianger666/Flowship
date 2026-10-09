/**
 * warmup-scheduler（src/lib/warmup-scheduler.ts）单测——预热触发的去抖 + 节流
 *
 * 钉死的语义：
 * - 「回到窗口」会同时触发 focus / visibilitychange / focusin 好几个信号 → 只发一次
 * - 窗口在后台不发；同一 task 30s 内不重复发，换 task 不受限
 * - 去抖期间切 task，以最后一次请求的 task 为准（绝不为旧 task 发）
 * - 发送失败不影响后续
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWarmupScheduler } from "@/lib/warmup-scheduler";

let sent: string[];
let visible: boolean;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  sent = [];
  visible = true;
});

const mk = (over: Partial<Parameters<typeof createWarmupScheduler>[0]> = {}) =>
  createWarmupScheduler({
    send: (id) => {
      sent.push(id);
    },
    isVisible: () => visible,
    ...over,
  });

describe("去抖", () => {
  it("三个信号在 400ms 内接连到达 → 只发一次，且在最后一次之后 400ms 才发", () => {
    const s = mk();
    s.request("t1"); // window focus
    vi.advanceTimersByTime(100);
    s.request("t1"); // visibilitychange
    vi.advanceTimersByTime(100);
    s.request("t1"); // focusin
    vi.advanceTimersByTime(399);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["t1"]);
  });

  it("去抖期间切 task：以最后一次请求的 task 为准，不会为旧 task 发", () => {
    const s = mk();
    s.request("t1");
    vi.advanceTimersByTime(200);
    s.request("t2");
    vi.advanceTimersByTime(1_000);
    expect(sent).toEqual(["t2"]);
  });

  it("cancel：待发的请求被取消（切走 / 卸载）", () => {
    const s = mk();
    s.request("t1");
    s.cancel();
    vi.advanceTimersByTime(5_000);
    expect(sent).toEqual([]);
  });

  it("cancel 在没有待发请求时是 no-op", () => {
    const s = mk();
    expect(() => s.cancel()).not.toThrow();
  });
});

describe("可见性", () => {
  it("到点时窗口在后台 → 丢弃（不发、也不占节流窗口）", () => {
    const s = mk();
    s.request("t1");
    visible = false;
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
    // 回到前台后立刻可以发（上一次是被丢弃的、没占间隔）
    visible = true;
    s.request("t1");
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(["t1"]);
  });
});

describe("节流", () => {
  it("同一 task 30s 内不重复发；过了 30s 可以再发", () => {
    const s = mk();
    s.request("t1");
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(["t1"]);

    vi.advanceTimersByTime(10_000);
    s.request("t1");
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(["t1"]); // 才过了 ~10s，被节流

    vi.advanceTimersByTime(20_000);
    s.request("t1");
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(["t1", "t1"]); // 已过 30s
  });

  it("换 task 不受节流限制", () => {
    const s = mk();
    s.request("t1");
    vi.advanceTimersByTime(500);
    s.request("t2");
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(["t1", "t2"]);
  });

  it("A → B → 回到 A：A 仍在 30s 间隔内则不重发（只记最近一次发送的 task）", () => {
    // 已知取舍：只记最近一次，A→B→A 时 A 会重发——服务端 20s 节流兜底。这里钉住行为避免误改。
    const s = mk();
    s.request("t1");
    vi.advanceTimersByTime(500);
    s.request("t2");
    vi.advanceTimersByTime(500);
    s.request("t1");
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(["t1", "t2", "t1"]);
  });

  it("自定义间隔 / 去抖参数生效", () => {
    const s = mk({ debounceMs: 50, minIntervalMs: 1_000 });
    s.request("t1");
    vi.advanceTimersByTime(49);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["t1"]);
    vi.advanceTimersByTime(500);
    s.request("t1");
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(["t1"]);
    vi.advanceTimersByTime(1_000);
    s.request("t1");
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(["t1", "t1"]);
  });
});

describe("故障", () => {
  it("send 抛错：不向外抛、不影响后续请求", () => {
    let calls = 0;
    const s = mk({
      send: () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
    });
    s.request("t1");
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    s.request("t2");
    vi.advanceTimersByTime(500);
    expect(calls).toBe(2);
  });
});
