/**
 * P1-01 护栏：subscribe 先于「快照读取」时，中间 publish 的事件必须进 buffer、不丢。
 *
 * 不测 watch-task route（无 HTTP 基建），只验证 subscribeTaskStream 在
 * 异步间隙里仍能 fanout——路由侧「先订后读」正依赖这一点。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  publish,
  subscribeTaskStream,
  type TaskStreamEvent,
} from "@/lib/server/task-stream";

describe("subscribeTaskStream 订阅先行", () => {
  const unsubs: Array<() => void> = [];

  afterEach(() => {
    while (unsubs.length > 0) unsubs.pop()?.();
  });

  it("getTask 模拟 await 期间 publish 的事件进 buffer、回放不丢", async () => {
    const taskId = `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const buffered: TaskStreamEvent[] = [];
    let bootstrapping = true;
    const live: TaskStreamEvent[] = [];

    unsubs.push(
      subscribeTaskStream(taskId, (ev) => {
        if (bootstrapping) {
          buffered.push(ev);
          return;
        }
        live.push(ev);
      }),
    );

    // 模拟 getTask(id) 的异步窗口：订阅已挂、快照还没返回
    publish(taskId, { kind: "error", message: "during-getTask" });
    publish(taskId, {
      kind: "event",
      event: {
        id: "e-mid",
        ts: 1,
        kind: "info",
        text: "mid",
      },
    });
    await Promise.resolve(); // 假装 await getTask

    expect(buffered).toHaveLength(2);
    expect(live).toHaveLength(0);

    // 快照发完 → 关 bootstrap → 回放 buffer → 转直通（与 route 同序）
    bootstrapping = false;
    for (const ev of buffered) live.push(ev);
    buffered.length = 0;

    publish(taskId, { kind: "error", message: "after-live" });

    expect(live.map((e) => (e.kind === "error" ? e.message : e.kind))).toEqual([
      "during-getTask",
      "event",
      "after-live",
    ]);
  });

  it("未订阅时 publish 静默、不抛", () => {
    expect(() =>
      publish(`no-sub-${Date.now()}`, { kind: "error", message: "noop" }),
    ).not.toThrow();
  });
});
