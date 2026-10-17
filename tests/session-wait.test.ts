/**
 * 会话级可中断等待（`wait` 工具的运行时）：时序 / 提前结束 / 清理 / 文案
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WAIT_MAX_SECONDS,
  activeWaitCount,
  formatWaitResult,
  interruptWaits,
  normalizeWaitSeconds,
  runWait,
} from "@/lib/server/session-wait";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
});

afterEach(() => {
  // 任何一条用例漏清都会在这里露出来：全局表和定时器都必须是空的
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("normalizeWaitSeconds", () => {
  it("正常值四舍五入取整；小于 1 的正数抬到 1", () => {
    expect(normalizeWaitSeconds(30)).toEqual({ seconds: 30, clamped: false });
    expect(normalizeWaitSeconds(2.6)).toEqual({ seconds: 3, clamped: false });
    expect(normalizeWaitSeconds(0.2)).toEqual({ seconds: 1, clamped: false });
  });

  it("超上限不报错、钳到上限并标 clamped（由返回文案告诉模型）", () => {
    expect(normalizeWaitSeconds(WAIT_MAX_SECONDS)).toEqual({
      seconds: WAIT_MAX_SECONDS,
      clamped: false,
    });
    expect(normalizeWaitSeconds(WAIT_MAX_SECONDS + 1)).toEqual({
      seconds: WAIT_MAX_SECONDS,
      clamped: true,
    });
    expect(normalizeWaitSeconds(86_400)).toEqual({
      seconds: WAIT_MAX_SECONDS,
      clamped: true,
    });
  });

  it("非数字 / NaN / Infinity / 0 / 负数 → null（调用方报用法错误）", () => {
    for (const bad of [
      undefined,
      null,
      "30",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -5,
      {},
    ]) {
      expect(normalizeWaitSeconds(bad)).toBeNull();
    }
  });
});

describe("runWait：到点", () => {
  it("等够 plannedMs 后 done，elapsed = 实际墙钟，登记表清空", async () => {
    const p = runWait({ key: "t1", plannedMs: 5000 });
    expect(activeWaitCount("t1")).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(activeWaitCount("t1")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({
      status: "done",
      elapsedMs: 5000,
      plannedMs: 5000,
    });
    expect(activeWaitCount("t1")).toBe(0);
  });

  it("没有 key 也能等（只是只能被定时器 / signal 结束）", async () => {
    const p = runWait({ plannedMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ status: "done" });
  });
});

describe("interruptWaits：提前结束", () => {
  it.each(["skip", "steer", "cancel"] as const)(
    "%s：立刻结束、带实际已等时长、清掉定时器和登记",
    async (reason) => {
      const p = runWait({ key: "t1", plannedMs: 60_000 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(interruptWaits("t1", reason)).toBe(1);
      await expect(p).resolves.toEqual({
        status: reason,
        elapsedMs: 3000,
        plannedMs: 60_000,
      });
      expect(activeWaitCount("t1")).toBe(0);
      // afterEach 里 getTimerCount() === 0：定时器已被清，不会 60s 后再 resolve 一次
    },
  );

  it("只唤醒同一个 key；别的任务的等待不受影响", async () => {
    const a = runWait({ key: "task-a", plannedMs: 10_000 });
    const b = runWait({ key: "task-b", plannedMs: 10_000 });
    expect(interruptWaits("task-a", "skip")).toBe(1);
    await expect(a).resolves.toMatchObject({ status: "skip" });
    expect(activeWaitCount("task-b")).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(b).resolves.toMatchObject({ status: "done" });
  });

  it("同一个任务并行多个等待：一次全部唤醒，返回数量", async () => {
    const ps = [
      runWait({ key: "t1", plannedMs: 10_000 }),
      runWait({ key: "t1", plannedMs: 20_000 }),
      runWait({ key: "t1", plannedMs: 30_000 }),
    ];
    expect(activeWaitCount("t1")).toBe(3);
    expect(interruptWaits("t1", "cancel")).toBe(3);
    const outs = await Promise.all(ps);
    expect(outs.map((o) => o.status)).toEqual(["cancel", "cancel", "cancel"]);
    expect(activeWaitCount("t1")).toBe(0);
  });

  it("无人在等 / key 为空 → 0，不抛（停止 / 插话路径可以无脑调）", () => {
    expect(interruptWaits("nobody", "cancel")).toBe(0);
    expect(interruptWaits(undefined, "steer")).toBe(0);
    expect(interruptWaits(null, "skip")).toBe(0);
    expect(interruptWaits("", "skip")).toBe(0);
  });

  it("已经结束的等待再被唤醒是空操作：只结算一次，不会 resolve 第二次", async () => {
    const p = runWait({ key: "t1", plannedMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ status: "done" });
    expect(interruptWaits("t1", "skip")).toBe(0);
  });

  it("等到点的同一刻被唤醒：先到先得，只有一个结局", async () => {
    const p = runWait({ key: "t1", plannedMs: 1000 });
    interruptWaits("t1", "steer");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ status: "steer", elapsedMs: 0 });
  });
});

describe("runWait：scope（agent 实例级，run 被取消 / 会话被关时叫醒）", () => {
  it("按 scope 叫醒：任务级 key 下的登记也一并清掉（反之亦然），不留尾巴", async () => {
    const byScope = runWait({ key: "t1", scope: "inst-a", plannedMs: 60_000 });
    expect(activeWaitCount("t1")).toBe(1);
    expect(activeWaitCount("inst-a")).toBe(1);
    expect(interruptWaits("inst-a", "cancel")).toBe(1);
    await expect(byScope).resolves.toMatchObject({ status: "cancel" });
    expect(activeWaitCount("t1")).toBe(0);
    expect(activeWaitCount("inst-a")).toBe(0);

    const byKey = runWait({ key: "t1", scope: "inst-b", plannedMs: 60_000 });
    expect(interruptWaits("t1", "skip")).toBe(1);
    await expect(byKey).resolves.toMatchObject({ status: "skip" });
    expect(activeWaitCount("inst-b")).toBe(0);
  });

  it("同一任务的新旧两个实例：叫醒旧实例只醒旧的，新实例刚开始的等待不被误伤", async () => {
    const oldWait = runWait({ key: "t1", scope: "inst-old", plannedMs: 60_000 });
    const newWait = runWait({ key: "t1", scope: "inst-new", plannedMs: 60_000 });
    expect(interruptWaits("inst-old", "cancel")).toBe(1);
    await expect(oldWait).resolves.toMatchObject({ status: "cancel" });
    expect(activeWaitCount("t1")).toBe(1);
    expect(activeWaitCount("inst-new")).toBe(1);
    // 用户侧按任务叫醒则两个实例的都醒（用户点「跳过」不区分实例）
    expect(interruptWaits("t1", "skip")).toBe(1);
    await expect(newWait).resolves.toMatchObject({ status: "skip" });
  });

  it("只有 scope 没有 key 也行；key 与 scope 同名不会重复登记", async () => {
    const onlyScope = runWait({ scope: "inst-x", plannedMs: 5000 });
    expect(interruptWaits("inst-x", "cancel")).toBe(1);
    await expect(onlyScope).resolves.toMatchObject({ status: "cancel" });

    const same = runWait({ key: "same", scope: "same", plannedMs: 5000 });
    expect(activeWaitCount("same")).toBe(1);
    expect(interruptWaits("same", "skip")).toBe(1);
    await expect(same).resolves.toMatchObject({ status: "skip" });
    expect(activeWaitCount("same")).toBe(0);
  });

  it("到点自然结束：两档登记都摘干净", async () => {
    const p = runWait({ key: "t1", scope: "inst-a", plannedMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ status: "done" });
    expect(activeWaitCount("t1")).toBe(0);
    expect(activeWaitCount("inst-a")).toBe(0);
  });
});

describe("runWait：AbortSignal（pi 的 execute 有 signal）", () => {
  it("等待中 abort → cancel，并摘掉监听", async () => {
    const ac = new AbortController();
    const p = runWait({ key: "t1", plannedMs: 60_000, signal: ac.signal });
    await vi.advanceTimersByTimeAsync(2000);
    ac.abort();
    await expect(p).resolves.toEqual({
      status: "cancel",
      elapsedMs: 2000,
      plannedMs: 60_000,
    });
    expect(activeWaitCount("t1")).toBe(0);
  });

  it("进门时 signal 已 abort：不登记、不起定时器，直接 cancel", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = runWait({ key: "t1", plannedMs: 60_000, signal: ac.signal });
    expect(activeWaitCount("t1")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(p).resolves.toMatchObject({ status: "cancel", elapsedMs: 0 });
  });

  it("正常到点后再 abort 无副作用（监听已摘）", async () => {
    const ac = new AbortController();
    const p = runWait({ key: "t1", plannedMs: 1000, signal: ac.signal });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ status: "done" });
    expect(() => ac.abort()).not.toThrow();
  });
});

describe("formatWaitResult：返回给模型的文案", () => {
  const out = (
    status: "done" | "skip" | "steer" | "cancel",
    elapsedMs = 12_000,
    plannedMs = 60_000,
  ) => ({ status, elapsedMs, plannedMs });

  it("四种结局各有固定前缀，模型一眼分得清", () => {
    expect(formatWaitResult(out("done", 60_000))).toMatch(/^\[WAIT_DONE\]/);
    expect(formatWaitResult(out("skip"))).toMatch(/^\[WAIT_SKIPPED\]/);
    expect(formatWaitResult(out("steer"))).toMatch(/^\[WAIT_INTERRUPTED\]/);
    expect(formatWaitResult(out("cancel"))).toMatch(/^\[WAIT_CANCELLED\]/);
  });

  it("done：提醒「等待只是睡觉、不会替你检查」，别让模型以为等完就等于好了", () => {
    const t = formatWaitResult(out("done", 60_000));
    expect(t).toContain("已等待 1m0s");
    expect(t).toContain("自己去确认");
  });

  it("skip：说清别再重复等同一件事；steer：先处理新消息（用户插话 / 后台结果）、还要等再调一次", () => {
    const skip = formatWaitResult(out("skip"));
    expect(skip).toContain("已等 12s / 计划 1m0s");
    expect(skip).toContain("不要再为同一件事重复等待");
    // 跳过 ≠ 条件已满足：只说「直接继续」模型会当它已就绪、在没好的东西上往下做
    expect(skip).toContain("不表示你要等的事已经完成");
    expect(skip).toContain("先自己确认一次");
    expect(skip).not.toContain("直接继续往下做");
    const steer = formatWaitResult(out("steer"));
    expect(steer).toContain("先读并处理这条新消息");
    // 来源不只是用户：后台子代理交回结果也会叫醒它，文案不能一口咬定「用户发来」
    expect(steer).toContain("后台子代理");
    expect(steer).toContain("再调一次 wait");
  });

  it("cancel：明说立刻结束本轮、不要再调任何工具（这次返回的对象是一个已被取消的 run）", () => {
    const t = formatWaitResult(out("cancel"));
    expect(t).toContain("立刻结束本轮");
    expect(t).toContain("不要再调用任何工具");
  });

  it("reason 原样带上（trim 过）；空白 reason 不留空括号", () => {
    expect(formatWaitResult(out("done"), { reason: "  等 CI  " })).toContain(
      "（等 CI）",
    );
    expect(formatWaitResult(out("done"), { reason: "   " })).not.toContain("（");
    expect(formatWaitResult(out("done"))).not.toContain("（");
  });

  it("钳过上限的，文案里要说一句，免得模型以为真等了它要的那么久", () => {
    const t = formatWaitResult(out("done", WAIT_MAX_SECONDS * 1000), {
      clamped: true,
    });
    expect(t).toContain(`单次上限 ${WAIT_MAX_SECONDS}s`);
    expect(formatWaitResult(out("done"))).not.toContain("单次上限");
  });
});
