/**
 * 回退过的长会话上，任何带全量 events 的 mutation 响应（切 effort / 模型 / MCP / 改标题……）
 * 不得把本地懒加载窗口整体换成全量（用户 2026-10-23 反馈：切 effort 点确定后右边冒出「99+ 条新内容」、内容区滚到很早的位置）。
 *
 * 根因链：服务端 mutation 响应带全量 events（task-fs 里 24 处）→ 页面 ~20 个入口走 absorbTask → mergeTaskEvents →
 * truncateForRewind 遇到「本地窗口里没有」的老回退标记，本地窗口又不完整 → 判 resync →
 * replaceTaskEventsWithSnapshot 把 300 条换成上千条 → 列表头部凭空多出一大截，Virtuoso 保持 scrollTop 像素
 * → 视口落到很早的内容上，「新内容」按总数差算出 99+。
 *
 * 修法（RC1）：标记事件比本地窗口里最早的事件还早 = 回退发生在窗口建立之前，窗口天然已对齐，跳过它。
 * 数据构造来自审查探针（真实会话 t_…ie3fc5：2017 条事件、回退过 3 次、最近一次标记之后还有 898 条）。
 */
import { describe, expect, it } from "vitest";

import { buildRewindMeta } from "@/lib/rewind-marker";
import {
  appendTaskEvent,
  lastRewindNeedsResync,
  mergeTaskEvents,
  rewindNeedsResync,
} from "@/lib/task-store";
import type { Task, TaskEvent } from "@/lib/types";

const T0 = 1_792_000_000_000;
const TOTAL = 2000;
const WINDOW = 300;

const mk = (i: number): TaskEvent => ({
  id: `e_${T0 + i}_a${i}`,
  ts: T0 + i,
  kind: "assistant_message",
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
    id: "t_probe",
    title: "probe",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    actions: [],
    mrs: [],
    repoPaths: [],
    events,
    createdAt: T0,
    updatedAt: T0 + 5000,
    ...extra,
  }) as unknown as Task;

/** 2000 条事件，在给定下标处换成回退标记（每个标记 ts = 它所在位置的时刻，与真实「回退时刻 = 之后事件之前」一致） */
const buildAll = (markerAts: number[]): TaskEvent[] => {
  const all = Array.from({ length: TOTAL }, (_, i) => mk(i));
  markerAts.forEach((at, n) => {
    all[at] = marker(`e_marker_${n}`, T0 + at, `e_deleted_by_rewind_${n}`, at);
  });
  return all;
};

const lastRewindOf = (at: number, n: number) => ({
  fromEventId: `e_deleted_by_rewind_${n}`,
  keptCount: at,
  markerEventId: `e_marker_${n}`,
  ts: T0 + at,
});

describe("mergeTaskEvents：mutation 响应带全量 events", () => {
  it("A 没回退过：本地 300 条窗口保持不变", () => {
    const all = buildAll([]);
    const local = task(all.slice(-WINDOW), { eventsTruncated: true });
    const merged = mergeTaskEvents(local, task(all, { updatedAt: T0 + 6000 }));
    expect(merged.events).toHaveLength(WINDOW);
  });

  it("B 回退在本地窗口之内（标记在窗口里）：窗口保持不变", () => {
    const all = buildAll([1850]);
    const lr = lastRewindOf(1850, 0);
    const local = task(all.slice(-WINDOW), { eventsTruncated: true, lastRewind: lr });
    const merged = mergeTaskEvents(local, task(all, { updatedAt: T0 + 6000, lastRewind: lr }));
    expect(merged.events).toHaveLength(WINDOW);
  });

  it("C 回退发生在窗口之前（标记早已被后来的事件挤出窗口）：窗口保持 300 条，不整体替换、不 resync（修前：300 → 2000）", () => {
    const all = buildAll([1118]);
    const lr = lastRewindOf(1118, 0);
    const local = task(all.slice(-WINDOW), { eventsTruncated: true, lastRewind: lr });
    const resp = task(all, { updatedAt: T0 + 6000, lastRewind: lr });
    expect(lastRewindNeedsResync(local, resp)).toBe(false);
    const merged = mergeTaskEvents(local, resp);
    expect(merged.events).toHaveLength(WINDOW);
    // 窗口头尾都没变（Virtuoso 的 firstItemIndex / 列表头部不会凭空多出一截）
    expect(merged.events[0]!.id).toBe(local.events[0]!.id);
    expect(merged.events.at(-1)!.id).toBe(local.events.at(-1)!.id);
  });

  it("D 同一场景连续多次 mutation：每次都是 300（修前：300 → 2000 → 2000）", () => {
    const all = buildAll([1118]);
    const lr = lastRewindOf(1118, 0);
    let cur = task(all.slice(-WINDOW), { eventsTruncated: true, lastRewind: lr });
    for (let n = 0; n < 3; n++) {
      cur = mergeTaskEvents(cur, task(all, { updatedAt: T0 + 6000 + n, lastRewind: lr }));
      expect(cur.events).toHaveLength(WINDOW);
    }
  });

  it("真实会话形态：回退过 3 次、三个标记都早已被挤出窗口 → 窗口保持 300", () => {
    const at = [182, 1044, 1119];
    const all = buildAll(at);
    const lr = lastRewindOf(1119, 2);
    const local = task(all.slice(-WINDOW), { eventsTruncated: true, lastRewind: lr });
    const merged = mergeTaskEvents(local, task(all, { updatedAt: T0 + 6000, lastRewind: lr }));
    expect(merged.events).toHaveLength(WINDOW);
  });

  it("同时新增了事件：只吸收窗口末尾之后的新事件，窗口头部仍不动", () => {
    const all = buildAll([1118]);
    const lr = lastRewindOf(1118, 0);
    const local = task(all.slice(-WINDOW), { eventsTruncated: true, lastRewind: lr });
    const fresh = mk(TOTAL + 1);
    const merged = mergeTaskEvents(local, task([...all, fresh], { updatedAt: T0 + 6000, lastRewind: lr }));
    expect(merged.events).toHaveLength(WINDOW + 1);
    expect(merged.events[0]!.id).toBe(local.events[0]!.id);
    expect(merged.events.at(-1)!.id).toBe(fresh.id);
  });

  it("E 防修过头：回退发生在窗口加载**之后**（标记比窗口首条晚、被回退事件不在窗口里）→ 仍然 resync 整体替换，旧事件被清掉", () => {
    // 回退前：本地窗口 = 最后 300 条（1700..1999）；之后在别处回退到 e_1500（保留 1500 条）
    const pre = buildAll([]);
    const local = task(pre.slice(-WINDOW), { eventsTruncated: true });
    const m = marker("e_marker_after", T0 + 2100, pre[1500]!.id, 1500);
    const serverLog = [...pre.slice(0, 1500), m];
    const resp = task(serverLog, {
      updatedAt: T0 + 2100,
      lastRewind: { fromEventId: pre[1500]!.id, keptCount: 1500, markerEventId: m.id, ts: T0 + 2100 },
    });
    const merged = mergeTaskEvents(local, resp);
    // 整体替换成服务端快照——但快照是全量（1501 条）时先裁成尾窗口（评审 N3），不再一口气换成上千条
    expect(merged.events).toHaveLength(WINDOW);
    expect(merged.events[0]!.id).toBe(serverLog[serverLog.length - WINDOW]!.id);
    expect(merged.eventsTruncated).toBe(true);
    expect(merged.events.some((e) => e.id === pre[1999]!.id)).toBe(false); // 被回退删掉的旧事件不复活
    expect(merged.events.at(-1)!.id).toBe(m.id);
  });

  it("F 窗口内已含被回退事件的新回退：仍按 eventId 精确截（原行为不变）", () => {
    const pre = buildAll([]);
    const local = task(pre.slice(-WINDOW), { eventsTruncated: true });
    const target = pre[1900]!;
    const m = marker("e_marker_inwin", T0 + 2100, target.id, 1900);
    const resp = task([...pre.slice(0, 1900), m], { updatedAt: T0 + 2100 });
    const merged = mergeTaskEvents(local, resp);
    expect(merged.events.some((e) => e.id === target.id)).toBe(false);
    expect(merged.events.some((e) => e.id === pre[1899]!.id)).toBe(true);
    expect(merged.events.at(-1)!.id).toBe(m.id);
  });

  it("边界：标记与窗口首条同毫秒 → 走保守的原逻辑（严格小于才跳过）", () => {
    const first = mk(1700);
    const sameTsMarker = marker("e_marker_same", first.ts, "e_gone", 10);
    const local = task([first, mk(1701)], { eventsTruncated: true });
    const merged = mergeTaskEvents(local, task([sameTsMarker, first, mk(1701)], { updatedAt: T0 + 6000 }));
    // 没被跳过 → 本地找不到 e_gone、窗口又不完整 → resync → 以快照为准
    expect(merged.events.map((e) => e.id)).toEqual([sameTsMarker.id, first.id, mk(1701).id]);
  });

  it("本地没有任何持久事件（只有 ephemeral）→ 不设防，走原逻辑", () => {
    const eph: TaskEvent = { id: "ephemeral_boot_1", ts: T0 + 5000, kind: "info", text: "boot" };
    const local = task([eph], { eventsTruncated: true });
    const m = marker("e_marker_x", T0 + 10, "e_gone", 3);
    // prev.events 非空 → 走 truncateForRewind；无持久首条 → firstLocalTs 未定义 → 不跳过 → resync 以快照为准
    const merged = mergeTaskEvents(local, task([mk(1), m], { updatedAt: T0 + 6000 }));
    expect(merged.events.some((e) => e.id === m.id)).toBe(true);
  });
});

describe("SSE 单条事件：老标记（bootstrap 回放尾部带进来的）不再触发整体重拉", () => {
  it("rewindNeedsResync：比本地窗口首条还早的老标记 → false；之后的新标记照旧 true", () => {
    const all = buildAll([]);
    const local = task(all.slice(-WINDOW), { eventsTruncated: true });
    const old = marker("e_marker_old", T0 + 1000, "e_gone", 900);
    const fresh = marker("e_marker_new", T0 + 2100, "e_gone2", 1500);
    expect(rewindNeedsResync(local, old)).toBe(false);
    expect(rewindNeedsResync(local, fresh)).toBe(true);
  });

  it("appendTaskEvent：老标记被正常追加（而不是被当成 resync 吞掉）", () => {
    const all = buildAll([]);
    const local = task(all.slice(-WINDOW), { eventsTruncated: true });
    const old = marker("e_marker_old", T0 + 1000, "e_gone", 900);
    const next = appendTaskEvent(local, old);
    expect(next.events).toHaveLength(WINDOW + 1);
    expect(next.events.at(-1)!.id).toBe(old.id);
  });
});
