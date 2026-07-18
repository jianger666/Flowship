import { describe, expect, it } from "vitest";

import { mergeTaskEvents } from "../src/lib/task-store";
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
