/**
 * R1-13c 护栏：全局 tap（subscribeAllTaskStreams）的两条关键语义。
 *
 * 飞书桥接 outbound 依赖：
 * 1. 无 per-task SSE 订阅者时 tap 仍收到 fanout（推送不能依赖有人开着 watch 页面）
 * 2. tap 回调抛异常不得影响 per-task SSE 订阅者（旁路故障不污染主链）
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  publish,
  subscribeAllTaskStreams,
  subscribeTaskStream,
  type TaskStreamEvent,
} from "@/lib/server/task-stream";

const mkEvent = (text: string): TaskStreamEvent => ({
  kind: "assistant_delta",
  text,
});

describe("subscribeAllTaskStreams 全局 tap", () => {
  // 逐用例登记退订，避免污染其他测试的 globalThis listeners
  const unsubs: Array<() => void> = [];

  afterEach(() => {
    while (unsubs.length > 0) unsubs.pop()?.();
  });

  it("无 per-task SSE 订阅者时 tap 仍收到 fanout", () => {
    const taskId = `tap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const seen: Array<{ taskId: string; text: string }> = [];
    unsubs.push(
      subscribeAllTaskStreams((tid, ev) => {
        if (tid !== taskId) return; // 其他测试可能并发 publish、只看自己的
        if (ev.kind === "assistant_delta") seen.push({ taskId: tid, text: ev.text });
      }),
    );

    publish(taskId, mkEvent("hello"));

    expect(seen).toEqual([{ taskId, text: "hello" }]);
  });

  it("tap 抛异常不影响 per-task SSE 订阅者收到事件", () => {
    const taskId = `tap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sseSeen: string[] = [];
    unsubs.push(
      subscribeAllTaskStreams(() => {
        throw new Error("tap 故意炸（构造）");
      }),
    );
    unsubs.push(
      subscribeTaskStream(taskId, (ev) => {
        if (ev.kind === "assistant_delta") sseSeen.push(ev.text);
      }),
    );

    // tap 在 SSE 订阅者之后 fanout；两边都不应被对方异常打断
    expect(() => publish(taskId, mkEvent("still-alive"))).not.toThrow();
    expect(sseSeen).toEqual(["still-alive"]);
  });

  it("退订后 tap 不再收到事件", () => {
    const taskId = `tap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let count = 0;
    const unsub = subscribeAllTaskStreams((tid) => {
      if (tid === taskId) count += 1;
    });

    publish(taskId, mkEvent("a"));
    unsub();
    publish(taskId, mkEvent("b"));

    expect(count).toBe(1);
  });
});
