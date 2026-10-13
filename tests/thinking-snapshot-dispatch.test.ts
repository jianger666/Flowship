/**
 * 客户端分发：SSE thinking_snapshot 帧 → onThinkingSnapshot；event 帧的 replay 标记 → onEvent 的第二个参数
 *
 * 为什么有这两样（2026-10-13「首轮思考很长，切窗口再切回来又从第一个字开始吐」）：
 *   - thinking_snapshot：重新订阅（切对话回来 / SSE 重连）时补发「进行中思考」已发出的文本，
 *     前端接着长，不从头吐；live=null 表示没在思考（前端清残留）；
 *   - replay：bootstrap 回放的历史 event 帧带它——前端不能把「重新读一遍旧账」当成
 *     「刚发生一个落盘事件 = 这段思考结束了」而清掉刚从快照接上的实时态。
 *
 * 帧来自网络、按「不可信输入」处理：字段缺失 / 类型不对的快照整帧丢弃（不回调）——
 * 宁可不动本地状态，也别拿脏数据覆盖它；而 replay 只认严格的布尔 true。
 *
 * 用真实的 watchTaskStream + stub 掉的 fetch，跟 thinking-delta-dispatch.test.ts 同一套做法。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { type TaskEventMeta, watchTaskStream } from "@/lib/task-store";
import type { ThinkingSnapshot } from "@/lib/thinking-live";
import type { TaskEvent } from "@/lib/types";

const sseResponse = (payloads: unknown[]): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
};

const stubFetch = (payloads: unknown[]) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      sseResponse([{ type: "task", task: { id: "t1", events: [] } }, ...payloads]),
    ),
  );

const snapshotsOf = async (payloads: unknown[]): Promise<Array<ThinkingSnapshot | null>> => {
  stubFetch(payloads);
  const got: Array<ThinkingSnapshot | null> = [];
  await watchTaskStream("t1", { onThinkingSnapshot: (s) => got.push(s) });
  return got;
};

const ev = (id: string, kind = "info"): TaskEvent =>
  ({ id, kind, text: id, ts: 1, seq: 1 }) as unknown as TaskEvent;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SSE thinking_snapshot → onThinkingSnapshot", () => {
  it("合法对象：转发为 ThinkingSnapshot（线上字段 eventId → 前端的 id，其余原样）", async () => {
    const got = await snapshotsOf([
      {
        type: "thinking_snapshot",
        live: { eventId: "e_1", text: "先看数据", total: 4, since: 1_700_000_000_000 },
      },
    ]);
    expect(got).toEqual([{ id: "e_1", text: "先看数据", total: 4, since: 1_700_000_000_000 }]);
  });

  it("live 为 null：转发 null（明确的「没在思考」——前端据此清掉本地残留）", async () => {
    expect(await snapshotsOf([{ type: "thinking_snapshot", live: null }])).toEqual([null]);
  });

  it("total 大于 text 长度（服务端截过尾）原样转发，不在解析层改数", async () => {
    const got = await snapshotsOf([
      {
        type: "thinking_snapshot",
        live: { eventId: "e_1", text: "尾巴", total: 25_000, since: 5 },
      },
    ]);
    expect(got).toEqual([{ id: "e_1", text: "尾巴", total: 25_000, since: 5 }]);
  });

  it("无效帧一律丢弃、不回调：缺 live / live 类型不对 / 任一字段缺失或类型不对", async () => {
    const ok = { eventId: "e_1", text: "x", total: 1, since: 1 };
    const bad: unknown[] = [
      {},
      { live: undefined },
      { live: "x" },
      { live: 5 },
      { live: true },
      { live: [] },
      { live: { ...ok, eventId: undefined } },
      { live: { ...ok, eventId: "" } },
      { live: { ...ok, eventId: 42 } },
      { live: { ...ok, eventId: null } },
      { live: { ...ok, text: undefined } },
      { live: { ...ok, text: 123 } },
      { live: { ...ok, text: null } },
      { live: { ...ok, total: undefined } },
      { live: { ...ok, total: "5" } },
      { live: { ...ok, total: -1 } },
      { live: { ...ok, total: null } },
      { live: { ...ok, since: undefined } },
      { live: { ...ok, since: "1" } },
      { live: { ...ok, since: null } },
    ];
    const got = await snapshotsOf(bad.map((b) => ({ type: "thinking_snapshot", ...(b as object) })));
    expect(got).toEqual([]);
  });

  it("无效帧夹在合法帧之间：只丢无效的，前后的合法帧照常到、顺序不变", async () => {
    const got = await snapshotsOf([
      { type: "thinking_snapshot", live: { eventId: "e_1", text: "a", total: 1, since: 1 } },
      { type: "thinking_snapshot", live: { eventId: "", text: "b", total: 1, since: 1 } },
      { type: "thinking_snapshot", live: null },
    ]);
    expect(got).toEqual([{ id: "e_1", text: "a", total: 1, since: 1 }, null]);
  });

  it("没注册 onThinkingSnapshot 的调用方（别的页面也用 watchTaskStream）收到快照帧不抛", async () => {
    stubFetch([
      { type: "thinking_snapshot", live: { eventId: "e_1", text: "a", total: 1, since: 1 } },
    ]);
    await expect(watchTaskStream("t1", {})).resolves.toEqual({ established: true });
  });
});

describe("SSE event 帧的 replay 标记 → onEvent(ev, meta?)", () => {
  const eventsOf = async (payloads: unknown[]) => {
    stubFetch(payloads);
    const calls: unknown[][] = [];
    await watchTaskStream("t1", {
      onEvent: (...args: [TaskEvent, TaskEventMeta?]) => void calls.push(args),
    });
    return calls;
  };

  it("replay 严格为 true：第二个参数 { replay: true }", async () => {
    const calls = await eventsOf([{ type: "event", event: ev("e_1"), replay: true }]);
    expect(calls).toEqual([[ev("e_1"), { replay: true }]]);
  });

  it("没有 replay（实时事件）：只传一个参数——调用形状与改动前完全一致", async () => {
    const calls = await eventsOf([{ type: "event", event: ev("e_1") }]);
    expect(calls).toEqual([[ev("e_1")]]);
    expect(calls[0]).toHaveLength(1);
  });

  it("replay 不是严格的布尔 true（字符串 \"true\" / 1 / false / null）：一律当实时事件（单参数）", async () => {
    const calls = await eventsOf(
      ["true", 1, false, null, {}].map((replay, i) => ({
        type: "event",
        event: ev(`e_${i}`),
        replay,
      })),
    );
    expect(calls).toHaveLength(5);
    for (const c of calls) expect(c).toHaveLength(1);
  });

  it("回放与实时混着来：各自带各自的标记，顺序不变", async () => {
    const calls = await eventsOf([
      { type: "event", event: ev("old_1"), replay: true },
      { type: "event", event: ev("old_2"), replay: true },
      { type: "event", event: ev("new_1") },
    ]);
    expect(
      calls.map((c) => `${(c[0] as TaskEvent).id}:${c[1] ? "replay" : "live"}`),
    ).toEqual(["old_1:replay", "old_2:replay", "new_1:live"]);
  });
});

describe("帧间相对顺序", () => {
  it("回放事件 → 快照 → 实时增量：回调按到达顺序触发", async () => {
    stubFetch([
      { type: "event", event: ev("old_1"), replay: true },
      { type: "thinking_snapshot", live: { eventId: "e_1", text: "ab", total: 2, since: 7 } },
      { type: "thinking_delta", text: "c", eventId: "e_1" },
    ]);
    const order: string[] = [];
    await watchTaskStream("t1", {
      onEvent: (e, meta) => order.push(`event:${e.id}:${meta?.replay ? "replay" : "live"}`),
      onThinkingSnapshot: (s) => order.push(`snapshot:${s?.text ?? "null"}`),
      onThinkingDelta: (text) => order.push(`delta:${text}`),
    });
    expect(order).toEqual(["event:old_1:replay", "snapshot:ab", "delta:c"]);
  });
});
