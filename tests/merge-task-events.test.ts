import { describe, expect, it } from "vitest";

import { buildRewindMeta } from "../src/lib/rewind-marker";
import {
  appendTaskEvent,
  applyRewoundResult,
  mergeTaskEvents,
  replaceTaskEventsWithSnapshot,
  rewindNeedsResync,
} from "../src/lib/task-store";
import type { Task, TaskEvent } from "../src/lib/types";

// 造最小 Task（只有 merge 关心的字段有意义、其余糊住）
const makeTask = (
  events: TaskEvent[],
  extra?: Partial<Task>,
): Task =>
  ({
    id: "t_1",
    title: "t",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    repoPaths: [],
    actions: [],
    mrs: [],
    createdAt: 0,
    updatedAt: 0,
    events,
    ...extra,
  }) as unknown as Task;

const ev = (id: string, ts: number): TaskEvent => ({
  id,
  ts,
  kind: "info",
  text: id,
});

describe("mergeTaskEvents（事件懒加载：本地事件只增不换）", () => {
  it("prev 为空 / 换任务 → 直接用 next", () => {
    const next = makeTask([ev("a", 1)]);
    expect(mergeTaskEvents(null, next)).toBe(next);
    const other = makeTask([ev("b", 2)], { id: "t_2" } as Partial<Task>);
    expect(mergeTaskEvents(makeTask([ev("a", 1)]), other)).toBe(other);
  });

  it("SSE 中途帧（events 空）→ 保留本地全部 + 截断标记", () => {
    const prev = makeTask([ev("a", 1), ev("b", 2)], { eventsTruncated: true });
    const next = makeTask([], { runStatus: "running" } as Partial<Task>);
    const merged = mergeTaskEvents(prev, next);
    expect(merged.events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(merged.eventsTruncated).toBe(true);
    expect(merged.runStatus).toBe("running");
  });

  it("mutation 响应回全量（蓝军 P0）→ 不回灌更早历史、只吸收末尾新增", () => {
    // 本地 = tail 切片 e5..e7；服务端 mutation 返回全量 e1..e8
    const prev = makeTask([ev("e5", 5), ev("e6", 6), ev("e7", 7)], {
      eventsTruncated: true,
    });
    const next = makeTask([
      ev("e1", 1),
      ev("e2", 2),
      ev("e5", 5),
      ev("e6", 6),
      ev("e7", 7),
      ev("e8", 8),
    ]);
    const merged = mergeTaskEvents(prev, next);
    // e1/e2 丢弃（更早历史归上拉分页管）、e8 吸收
    expect(merged.events.map((e) => e.id)).toEqual(["e5", "e6", "e7", "e8"]);
    // 截断标记不被全量响应冲掉
    expect(merged.eventsTruncated).toBe(true);
  });

  it("同毫秒新事件不漏（>= 边界 + id 去重）", () => {
    const prev = makeTask([ev("a", 5)]);
    const next = makeTask([ev("a", 5), ev("b", 5)]);
    const merged = mergeTaskEvents(prev, next);
    expect(merged.events.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("无新增时保引用（本地事件数组不换、少无谓重渲）", () => {
    const prev = makeTask([ev("a", 1), ev("b", 2)]);
    const next = makeTask([ev("a", 1), ev("b", 2)]);
    const merged = mergeTaskEvents(prev, next);
    expect(merged.events).toBe(prev.events);
  });

  it("过期快照不盖运行态（失败 done 晚于唤醒 running）", () => {
    const prev = makeTask([ev("a", 1)], {
      runStatus: "running",
      updatedAt: 20,
    });
    const next = makeTask([], {
      runStatus: "error",
      updatedAt: 10,
    });
    const merged = mergeTaskEvents(prev, next);
    expect(merged.runStatus).toBe("running");
    expect(merged.updatedAt).toBe(20);
    expect(merged.events.map((e) => e.id)).toEqual(["a"]);
  });

  it("过滤非 ephemeral 的 tool_output_delta（不进本地持久 events）", () => {
    const prev = makeTask([ev("a", 1)]);
    const next = makeTask([
      ev("a", 1),
      {
        id: "tod_x_1",
        ts: 2,
        kind: "tool_output_delta",
        text: "",
        meta: { callId: "x", chunk: "hi" },
      },
      ev("b", 3),
    ]);
    const merged = mergeTaskEvents(prev, next);
    expect(merged.events.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("过滤 ephemeral_boot_* 的 info（不进本地持久 events）", () => {
    const prev = makeTask([ev("a", 1)]);
    const next = makeTask([
      ev("a", 1),
      {
        id: "ephemeral_boot_1",
        ts: 2,
        kind: "info",
        text: "boot hint",
      },
      ev("b", 3),
    ]);
    const merged = mergeTaskEvents(prev, next);
    expect(merged.events.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

// 回退标记事件：服务端回退后追加的 info，meta 带「被回退到的事件 id」
const rewindEv = (
  id: string,
  ts: number,
  fromEventId: string,
  keptCount: number | null = null,
): TaskEvent => ({
  id,
  ts,
  kind: "info",
  text: "已回退",
  meta: buildRewindMeta({ fromEventId, keptCount }),
});

describe("mergeTaskEvents / appendTaskEvent（S12-03 回退截断本地事件）", () => {
  it("快照带本地没有的回退标记 → 截掉被回退事件起的本地后半段", () => {
    const prev = makeTask([ev("e1", 1), ev("e2", 2), ev("e3", 3), ev("e4", 4)]);
    // 回退到 e3：服务端只剩 e1/e2 + 回退 info
    const next = makeTask([ev("e1", 1), ev("e2", 2), rewindEv("r1", 10, "e3")]);
    const merged = mergeTaskEvents(prev, next);
    expect(merged.events.map((e) => e.id)).toEqual(["e1", "e2", "r1"]);
  });

  it("回退后到达的无标记旧快照（含已删事件）仍被丢弃", () => {
    const prev = makeTask([ev("e1", 1), ev("e2", 2), ev("e3", 3)]);
    const rewound = mergeTaskEvents(
      prev,
      makeTask([ev("e1", 1), rewindEv("r1", 10, "e2")]),
    );
    expect(rewound.events.map((e) => e.id)).toEqual(["e1", "r1"]);
    // 乱序到达的回退前旧快照：e2/e3 的 ts 都早于本地末尾 → 不得复活
    const stale = mergeTaskEvents(
      rewound,
      makeTask([ev("e1", 1), ev("e2", 2), ev("e3", 3)]),
    );
    expect(stale.events.map((e) => e.id)).toEqual(["e1", "r1"]);
  });

  it("先经 SSE 追加了回退事件、后到的快照不重复截断也不丢新事件", () => {
    const prev = makeTask([ev("e1", 1), ev("e2", 2), ev("e3", 3)]);
    const afterSse = appendTaskEvent(prev, rewindEv("r1", 10, "e2"));
    expect(afterSse.events.map((e) => e.id)).toEqual(["e1", "r1"]);
    // 用户随后又发了新消息 e5（ts 11）
    const withNew = appendTaskEvent(afterSse, ev("e5", 11));
    const merged = mergeTaskEvents(
      withNew,
      makeTask([ev("e1", 1), rewindEv("r1", 10, "e2"), ev("e5", 11)]),
    );
    expect(merged.events.map((e) => e.id)).toEqual(["e1", "r1", "e5"]);
  });

  it("回退到最早一条（本地被截空）→ 以服务端 next 为准", () => {
    const prev = makeTask([ev("e1", 1), ev("e2", 2)]);
    const next = makeTask([rewindEv("r1", 10, "e1")]);
    const merged = mergeTaskEvents(prev, next);
    expect(merged.events.map((e) => e.id)).toEqual(["r1"]);
  });

  it("找不到 eventId + 本地是完整窗口 + 带 keptCount → 按 keptCount 截前缀（S12-03 兜底）", () => {
    // 本地完整（无 eventsTruncated）：e1..e4；服务端回退到 e2，只保留 1 条 + 标记。
    // 本地恰好没有 e2 的 id（例如已被先前的快照 / 回退清掉过再回灌）→ 不能「保守不截」
    const prev = makeTask([ev("e1", 1), ev("x2", 2), ev("e3", 3), ev("e4", 4)]);
    const next = makeTask([ev("e1", 1), rewindEv("r1", 10, "e2", 1)]);
    const merged = mergeTaskEvents(prev, next);
    expect(merged.events.map((e) => e.id)).toEqual(["e1", "r1"]);
    // SSE 单条路径同理
    const afterSse = appendTaskEvent(prev, rewindEv("r1", 10, "e2", 1));
    expect(afterSse.events.map((e) => e.id)).toEqual(["e1", "r1"]);
  });

  it("找不到 eventId + 本地是尾部窗口（eventsTruncated）→ 不猜：append 不追加并要求 resync", () => {
    // 本地只加载了尾部 e8..e9；回退点 e5 早于本地窗口起点 → 本地无从判断，更不能按 keptCount 当绝对下标
    const prev = makeTask([ev("e8", 8), ev("e9", 9)], { eventsTruncated: true });
    const marker = rewindEv("r1", 20, "e5", 4);
    expect(rewindNeedsResync(prev, marker)).toBe(true);
    // 不追加（保持引用不变），否则标记「已知」后就再也纠正不了
    expect(appendTaskEvent(prev, marker)).toBe(prev);
  });

  it("尾部窗口 + 快照带回退标记但本地找不到 → 以快照整体替换（过期的 e8/e9 被清掉）", () => {
    const prev = makeTask([ev("e8", 8), ev("e9", 9)], {
      eventsTruncated: true,
      updatedAt: 9,
    });
    // 服务端回退到 e5 后：保留 e1..e4 + 标记；快照带 tail（最近 N 条）
    const next = makeTask([ev("e3", 3), ev("e4", 4), rewindEv("r1", 20, "e5", 4)], {
      eventsTruncated: true,
      updatedAt: 20,
    });
    const merged = mergeTaskEvents(prev, next);
    expect(merged.events.map((e) => e.id)).toEqual(["e3", "e4", "r1"]);
    expect(merged.eventsTruncated).toBe(true);
  });

  it("整体替换时保留「快照之后才到」的本地事件，不捡回被删的旧事件", () => {
    const prev = makeTask(
      [ev("e8", 8), ev("e9", 9), ev("new1", 30)], // new1 是回退之后经 SSE 先到的新事件
      { eventsTruncated: true, updatedAt: 30 },
    );
    const next = makeTask([ev("e4", 4), rewindEv("r1", 20, "e5", 4)], {
      eventsTruncated: true,
      updatedAt: 20,
    });
    const merged = mergeTaskEvents(prev, next);
    expect(merged.events.map((e) => e.id)).toEqual(["e4", "r1", "new1"]);
  });

  it("没带 keptCount 的旧标记 + 完整窗口 + 找不到 eventId → 同样 resync（不猜）", () => {
    const prev = makeTask([ev("e1", 1), ev("e2", 2)]);
    expect(rewindNeedsResync(prev, rewindEv("r1", 10, "zzz"))).toBe(true);
  });

  it("本地已包含被回退事件时仍按 eventId 精确截（与窗口是否完整无关）", () => {
    const prev = makeTask([ev("e8", 8), ev("e9", 9)], { eventsTruncated: true });
    const afterSse = appendTaskEvent(prev, rewindEv("r1", 20, "e9", 8));
    expect(afterSse.events.map((e) => e.id)).toEqual(["e8", "r1"]);
    expect(rewindNeedsResync(prev, rewindEv("r1", 20, "e9", 8))).toBe(false);
  });

  it("appendTaskEvent：普通事件按 id 去重追加、重复保引用", () => {
    const prev = makeTask([ev("a", 1)]);
    expect(appendTaskEvent(prev, ev("a", 1))).toBe(prev);
    expect(appendTaskEvent(prev, ev("b", 2)).events.map((e) => e.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("applyRewoundResult（R6-03：据回退响应体直接对齐本地，不依赖标记事件）", () => {
  it("标记事件没写成功（markerEventId=null）：完整窗口按 eventId 截", () => {
    const prev = makeTask([ev("e1", 1), ev("e2", 2), ev("e3", 3)]);
    const { task, resync } = applyRewoundResult(prev, {
      fromEventId: "e2",
      keptCount: 1,
      markerEventId: null,
    });
    expect(resync).toBe(false);
    expect(task.events.map((e) => e.id)).toEqual(["e1"]);
  });

  it("本地找不到 eventId：完整窗口按 keptCount 截；尾部窗口要求 resync 且不动本地", () => {
    const full = makeTask([ev("e1", 1), ev("a", 2), ev("b", 3)]);
    expect(
      applyRewoundResult(full, { fromEventId: "gone", keptCount: 2, markerEventId: null })
        .task.events.map((e) => e.id),
    ).toEqual(["e1", "a"]);

    const tail = makeTask([ev("b", 3)], { eventsTruncated: true });
    const res = applyRewoundResult(tail, {
      fromEventId: "gone",
      keptCount: 2,
      markerEventId: null,
    });
    expect(res.resync).toBe(true);
    expect(res.task).toBe(tail);
  });

  it("标记事件已经经 SSE 到达本地 → 不重复处理", () => {
    const prev = makeTask([ev("e1", 1), rewindEv("r1", 10, "e2", 1), ev("n", 11)]);
    const res = applyRewoundResult(prev, {
      fromEventId: "e2",
      keptCount: 1,
      markerEventId: "r1",
    });
    expect(res.task).toBe(prev);
    expect(res.resync).toBe(false);
  });
});

describe("replaceTaskEventsWithSnapshot", () => {
  it("回退标记没写成功时，被删的旧事件（ts 晚于快照末条、早于 updatedAt）不会被捡回来", () => {
    const prev = makeTask([ev("e1", 1), ev("e2", 5), ev("e3", 6)], {
      eventsTruncated: true,
      updatedAt: 6,
    });
    // 服务端回退到 e2：只剩 e1；meta.updatedAt 推到回退时刻 10
    const snap = makeTask([ev("e1", 1)], { updatedAt: 10 });
    const out = replaceTaskEventsWithSnapshot(prev, snap);
    expect(out.events.map((e) => e.id)).toEqual(["e1"]);
  });
});
