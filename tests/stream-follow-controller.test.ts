/**
 * 贴底跟随控制器的「合批 + 闸门」行为（2026-07-28）
 *
 * 只测不碰 DOM 的那一半：跟随态托管 + rAF 合批。
 * 老实现是每来一个 SSE chunk 就同步调一次 scrollToIndex——Virtuoso 每次都会重启
 * 一遍滚动状态机（注册 listRefresh 订阅 + 1200ms 兜底定时器），一秒几十次就是掉帧。
 * 手势识别的纯函数在 tests/scroll-follow.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStreamFollowController } from "@/hooks/use-stream-follow";

/** 手动驱动的 rAF 桩：排队的回调攒着，flush() 时一次性跑完（模拟「下一帧」） */
let queued: Array<() => void> = [];

beforeEach(() => {
  queued = [];
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    queued.push(cb);
    return queued.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flushFrame = () => {
  const pending = queued;
  queued = [];
  for (const cb of pending) cb();
};

const setup = () => {
  const scrollToBottom = vi.fn();
  const ctrl = createStreamFollowController({ current: scrollToBottom });
  return { ctrl, scrollToBottom };
};

describe("createStreamFollowController", () => {
  it("默认跟随最新（进来就在底部看最新）", () => {
    const { ctrl } = setup();
    expect(ctrl.isFollowing()).toBe(true);
  });

  it("一帧内请求多少次都只贴底一次（SSE 一秒能推几十个 chunk）", () => {
    const { ctrl, scrollToBottom } = setup();
    for (let i = 0; i < 20; i++) ctrl.requestScrollToBottom();
    expect(scrollToBottom).not.toHaveBeenCalled();
    flushFrame();
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("合批不会饿死：上一帧跑完后下一帧还能再排（chunk 比帧还密时也得跟上）", () => {
    const { ctrl, scrollToBottom } = setup();
    ctrl.requestScrollToBottom();
    flushFrame();
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
  });

  it("排队后用户上滚导致停跟随 → 这一帧的贴底作废（别把人拽回去）", () => {
    const { ctrl, scrollToBottom } = setup();
    ctrl.requestScrollToBottom();
    ctrl.setFollowing(false);
    flushFrame();
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("订阅者只在跟随态真的翻转时收到通知", async () => {
    const { ctrl } = setup();
    const onChange = vi.fn();
    const unsubscribe = ctrl.subscribe(onChange);

    ctrl.setFollowing(true); // 同值、不通知
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();

    ctrl.setFollowing(false);
    // 通知走微任务（允许渲染期写跟随态而不触发 React 跨组件更新告警）
    expect(onChange).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(ctrl.getSnapshot()).toBe(false);

    unsubscribe();
    ctrl.setFollowing(true);
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("dispose 后不再通知（组件卸载 / 切 task 重建）", async () => {
    const { ctrl } = setup();
    const onChange = vi.fn();
    ctrl.subscribe(onChange);
    ctrl.dispose();
    ctrl.setFollowing(false);
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });
});
