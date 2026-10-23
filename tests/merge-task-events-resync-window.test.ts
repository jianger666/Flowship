/**
 * 回退对齐的三条「别把窗口弄乱」（评审 R2：N3 / N5 + 回退者自己的 HTTP 响应先到）。
 *
 * 背景见 merge-task-events-old-rewind.test.ts（切 effort 后 99+ / 内容区滚到很早）：根因 RC1 已修，
 * 这里补三个同类入口——
 *
 *   A. **回退者自己的 HTTP 响应先于 SSE 标记到达**：applyRewoundResult 已精确截好并记下 lastRewind，
 *      随后响应里的 task（含这条标记）经 mergeTaskEvents 进来：标记不在本地、被回退事件又已被截掉、窗口不完整
 *      → 旧实现判 resync 整体替换成上千条。现在认 prev.lastRewind（同 lastRewindNeedsResync 的幂等约定）。
 *      **别的窗口**的回退（本地 lastRewind 更老 / 没有）照常 resync——防修过头。
 *   N3. 真要整体替换时，全量快照先裁成尾窗口（最近 300 条 + 补到含最近一条 user_reply / action_start，上限 1000），
 *      不再一口气换成上千条。常量与页面首屏 EVENT_TAIL / 服务端 MAX_EVENTS_TAIL 钉死不漂。
 *   N5. SSE 重连回放（meta.replay）里「比本地窗口首条还早」的事件不再被 appendTaskEvent 接到末尾（时间序错乱）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildRewindMeta } from "@/lib/rewind-marker";
import {
  RESYNC_TAIL_EVENTS,
  RESYNC_TAIL_MAX,
  appendTaskEvent,
  applyRewoundResult,
  lastRewindNeedsResync,
  mergeTaskEvents,
  replaceTaskEventsWithSnapshot,
  rewindNeedsResync,
} from "@/lib/task-store";
import type { Task, TaskEvent } from "@/lib/types";

const T0 = 1_792_000_000_000;
const WINDOW = 300;

const mk = (i: number, kind: TaskEvent["kind"] = "assistant_message"): TaskEvent => ({
  id: `e_${T0 + i}_a${i}`,
  ts: T0 + i,
  kind,
  text: `msg ${i}`,
});

const marker = (id: string, ts: number, fromEventId: string, keptCount: number): TaskEvent => ({
  id,
  ts,
  kind: "info",
  text: "已回退到某检查点",
  meta: buildRewindMeta({ fromEventId, keptCount }),
});

const task = (events: TaskEvent[], extra: Partial<Task> = {}): Task =>
  ({
    id: "t_resync_window",
    title: "resync window",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    actions: [],
    mrs: [],
    repoPaths: [],
    events,
    createdAt: T0,
    updatedAt: T0 + 100_000,
    ...extra,
  }) as unknown as Task;

const range = (from: number, to: number): TaskEvent[] =>
  Array.from({ length: to - from }, (_, i) => mk(from + i));

// ---------------------------------------------------------------------------

describe("A 回退者自己的 HTTP 响应先于 SSE 标记到达：不触发整体替换", () => {
  // 回退前：服务端日志 e0..e1999；本地窗口 = e1700..e1999（不完整）。回退到 e1800（保留 1800 条）。
  const pre = range(0, 2000);
  const local = task(pre.slice(-WINDOW), { eventsTruncated: true });
  const REWIND_TS = T0 + 5000;
  const m = marker("e_marker_self", REWIND_TS, pre[1800]!.id, 1800);
  const serverLog = [...pre.slice(0, 1800), m];
  const lastRewind = {
    fromEventId: pre[1800]!.id,
    keptCount: 1800,
    markerEventId: m.id,
    ts: REWIND_TS,
  };
  const resp = task(serverLog, { updatedAt: REWIND_TS, lastRewind });
  const rewound = {
    fromEventId: pre[1800]!.id,
    keptCount: 1800,
    markerEventId: m.id,
    ts: REWIND_TS,
  };

  it("先 applyRewoundResult、再合并响应 task：窗口只被精确截断一次、不被换成全量", () => {
    const { task: aligned, resync } = applyRewoundResult(local, rewound);
    expect(resync).toBe(false);
    // 本地窗口 e1700..e1999 被截到 e1800 之前 → e1700..e1799（100 条）
    expect(aligned.events).toHaveLength(100);
    expect(aligned.lastRewind?.ts).toBe(REWIND_TS);

    const merged = mergeTaskEvents(aligned, resp);
    // 不应整体替换成 1801 条
    expect(merged.events.length).toBeLessThan(WINDOW + 5);
    expect(merged.events[0]!.id).toBe(pre[1700]!.id);
    expect(merged.events.some((e) => e.id === pre[1999]!.id)).toBe(false);
  });

  it("【红绿对照】把 lastRewind 去掉（旧行为）就会整体替换", () => {
    const { task: aligned } = applyRewoundResult(local, rewound);
    const noKnown = { ...aligned, lastRewind: undefined } as Task;
    const merged = mergeTaskEvents(noKnown, { ...resp, lastRewind: undefined } as Task);
    // 没有「已知回退」可认 → 老逻辑：窗口不完整 + 找不到被回退事件 → resync 整体替换（现在裁成尾窗口）
    expect(merged.events[0]!.id).not.toBe(pre[1700]!.id);
  });

  it("SSE 标记随后才到：appendTaskEvent 不再判 resync，只当普通事件追加", () => {
    const { task: aligned } = applyRewoundResult(local, rewound);
    expect(rewindNeedsResync(aligned, m)).toBe(false);
    const next = appendTaskEvent(aligned, m);
    expect(next.events.at(-1)!.id).toBe(m.id);
    expect(next.events).toHaveLength(aligned.events.length + 1);
  });

  it("防修过头：**别的窗口**的回退（本地 lastRewind 更老 / 没有）、且被回退事件不在本地窗口里 → 仍然 resync 整体替换", () => {
    // 回退到 e1500（保留 1500 条）：被回退事件 e1500 在本地窗口（e1700..e1999）之外，本地算不出截断
    const m2 = marker("e_marker_other", REWIND_TS, pre[1500]!.id, 1500);
    const log2 = [...pre.slice(0, 1500), m2];
    const lr2 = { fromEventId: pre[1500]!.id, keptCount: 1500, markerEventId: m2.id, ts: REWIND_TS };
    const resp2 = task(log2, { updatedAt: REWIND_TS, lastRewind: lr2 });

    expect(rewindNeedsResync(local, m2)).toBe(true);
    const merged = mergeTaskEvents(local, resp2);
    expect(merged.events.some((e) => e.id === pre[1999]!.id)).toBe(false);
    expect(merged.events.at(-1)!.id).toBe(m2.id);

    // 本地有一条更老的 lastRewind：标记 ts 更大，同样不被跳过
    const olderKnown = task(pre.slice(-WINDOW), {
      eventsTruncated: true,
      lastRewind: { fromEventId: "x", keptCount: 10, markerEventId: "e_old_marker", ts: T0 + 10 },
    });
    expect(rewindNeedsResync(olderKnown, m2)).toBe(true);
    expect(lastRewindNeedsResync(olderKnown, resp2)).toBe(true);
    // 回退者自己已对齐过这次（lastRewind 同 ts）→ 不触发
    const self = applyRewoundResult(local, {
      fromEventId: pre[1500]!.id,
      keptCount: 1500,
      markerEventId: m2.id,
      ts: REWIND_TS,
    });
    // 本地窗口里找不到 e1500、窗口又不完整 → applyRewoundResult 本身也判 resync、task 原样不动
    expect(self.resync).toBe(true);
  });

  function aligned(): Task {
    return applyRewoundResult(local, rewound).task;
  }

  it("同毫秒边界：标记 ts 恰好等于 lastRewind.ts 也认（回退路由里两者同值）", () => {
    const a = aligned();
    expect(a.lastRewind!.ts).toBe(m.ts);
    expect(rewindNeedsResync(a, m)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("N3 整体替换时先把全量快照裁成尾窗口", () => {
  const full = range(0, 2500);

  it("全量快照 → 尾 300 条 + eventsTruncated=true", () => {
    const local = task(range(2200, 2500), { eventsTruncated: true });
    const next = task(full, { eventsTruncated: false });
    const out = replaceTaskEventsWithSnapshot(local, next);
    expect(out.events).toHaveLength(RESYNC_TAIL_EVENTS);
    expect(out.events[0]!.id).toBe(full[2200]!.id);
    expect(out.events.at(-1)!.id).toBe(full[2499]!.id);
    expect(out.eventsTruncated).toBe(true);
  });

  it("最近一条 user_reply 在尾 300 之外、上限之内 → 窗口补到含它（与服务端 ?anchor=1 同口径）", () => {
    const events = range(0, 2500);
    events[2000] = mk(2000, "user_reply");
    const out = replaceTaskEventsWithSnapshot(
      task(range(2200, 2500), { eventsTruncated: true }),
      task(events),
    );
    expect(out.events).toHaveLength(500);
    expect(out.events[0]!.kind).toBe("user_reply");
  });

  it("锚点远在上限之外 → 不放大窗口，保持 300 条", () => {
    const events = range(0, 2500);
    events[2500 - RESYNC_TAIL_MAX - 5] = mk(1, "user_reply");
    const out = replaceTaskEventsWithSnapshot(
      task(range(2200, 2500), { eventsTruncated: true }),
      task(events),
    );
    expect(out.events).toHaveLength(RESYNC_TAIL_EVENTS);
  });

  it("本来就是尾窗口大小的快照（首屏 / 重拉）原样通过，不改 eventsTruncated", () => {
    const tail = range(2200, 2500);
    const out = replaceTaskEventsWithSnapshot(
      task(range(2100, 2400), { eventsTruncated: true }),
      task(tail, { eventsTruncated: true }),
    );
    expect(out.events).toHaveLength(300);
    expect(out.events[0]!.id).toBe(tail[0]!.id);
    expect(out.eventsTruncated).toBe(true);

    const small = range(0, 40);
    const out2 = replaceTaskEventsWithSnapshot(task(small), task(small, { eventsTruncated: false }));
    expect(out2.events).toHaveLength(40);
    expect(out2.eventsTruncated).toBe(false);
  });

  it("裁窗口后，快照之后才到的本地事件照样保留在末尾", () => {
    const later = { ...mk(3000), ts: T0 + 900_000 };
    const out = replaceTaskEventsWithSnapshot(
      task([...range(2200, 2500), later], { eventsTruncated: true }),
      task(full, { updatedAt: T0 + 3000 }),
    );
    expect(out.events.at(-1)!.id).toBe(later.id);
    expect(out.events).toHaveLength(RESYNC_TAIL_EVENTS + 1);
  });

  it("常量与页面首屏 EVENT_TAIL、服务端 MAX_EVENTS_TAIL 同值（改一处必须改另两处）", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const page = readFileSync(path.join(root, "src/app/tasks/[id]/page.tsx"), "utf-8");
    const core = readFileSync(path.join(root, "src/lib/server/task-fs-core.ts"), "utf-8");
    expect(page).toMatch(new RegExp(`const EVENT_TAIL = ${RESYNC_TAIL_EVENTS};`));
    expect(core).toMatch(new RegExp(`export const MAX_EVENTS_TAIL = ${RESYNC_TAIL_MAX};`));
  });
});

// ---------------------------------------------------------------------------

describe("N5 回放里比本地窗口首条还早的事件不再被接到末尾", () => {
  const local = task(range(100, 400), { eventsTruncated: true });

  it("replay + 早于本地首条 → 丢弃（prev 原样返回）", () => {
    const next = appendTaskEvent(local, mk(50), { replay: true });
    expect(next).toBe(local);
  });

  it("replay 但不早于本地首条（同毫秒 / 更晚）→ 照常追加", () => {
    const same = { ...mk(999), ts: local.events[0]!.ts };
    expect(appendTaskEvent(local, same, { replay: true }).events.at(-1)!.id).toBe(same.id);
    const newer = mk(500);
    expect(appendTaskEvent(local, newer, { replay: true }).events.at(-1)!.id).toBe(newer.id);
  });

  it("实时事件（不带 replay）不受影响：哪怕 ts 偏早也照旧追加（时钟抖动不能吞实时事件）", () => {
    const early = mk(50);
    expect(appendTaskEvent(local, early).events.at(-1)!.id).toBe(early.id);
    expect(appendTaskEvent(local, early, { replay: false }).events.at(-1)!.id).toBe(early.id);
  });

  it("本地没有持久事件（空窗口）→ 不设防，回放事件照常追加", () => {
    const empty = task([]);
    expect(appendTaskEvent(empty, mk(5), { replay: true }).events).toHaveLength(1);
  });

  it("本地已有这条 → 去重返回 prev（行为不变）", () => {
    expect(appendTaskEvent(local, local.events[3]!, { replay: true })).toBe(local);
  });

  it("别的窗口回退使日志变短后重连：回放的更早尾部被丢、标记到达后与服务端一致", () => {
    // 本地 e100..e399；别处回退到 e250（保留 250 条）；重连 bootstrap 回放 e0..e249 + 标记
    const m = marker("e_marker_other", T0 + 9000, local.events[150]!.id, 250);
    const replay = [...range(0, 250), m];
    let cur = local;
    for (const ev of replay) {
      if (rewindNeedsResync(cur, ev)) continue;
      cur = appendTaskEvent(cur, ev, { replay: true });
      // 中间态不乱序：窗口内的 ts 始终单调不减
      for (let i = 1; i < cur.events.length; i++) {
        expect(cur.events[i]!.ts).toBeGreaterThanOrEqual(cur.events[i - 1]!.ts);
      }
    }
    expect(cur.events[0]!.id).toBe(local.events[0]!.id);
    expect(cur.events.at(-1)!.id).toBe(m.id);
    expect(cur.events.some((e) => e.id === local.events[299]!.id)).toBe(false);
  });

  it("契约：page.tsx 把 meta.replay 透传给 appendTaskEvent、ChatView 把 meta 透传给 onEventAppend", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const page = readFileSync(path.join(root, "src/app/tasks/[id]/page.tsx"), "utf-8");
    const chat = readFileSync(path.join(root, "src/components/tasks/chat-view.tsx"), "utf-8");
    expect(page).toMatch(/appendTaskEvent\(prev, ev, \{ replay: meta\?\.replay === true \}\)/);
    expect(chat).toContain("onEventAppendRef.current(ev, meta);");
  });
});
