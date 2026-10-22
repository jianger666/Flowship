/**
 * 事件流搜索「只覆盖已加载那段」的范围提示 + 加载更早后的命中稳定。
 *
 * 问题：首屏只加载最近一段事件（tail），更早的在上拉分页里；搜没加载的内容得到 0/0、
 * 没有任何线索说明「不是真没有」。MVP：提示范围 + 复用上拉分页的「加载更早的再搜」入口，
 * 不做服务端全文检索。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  deriveSearchScopeNotice,
  searchEventStreamOccurrences,
  stabilizeOccurrenceSelection,
} from "../src/lib/event-stream-search";
import type { TaskEvent } from "../src/lib/types";

const msg = (id: string, text: string): TaskEvent =>
  ({
    id,
    ts: 1,
    kind: "assistant_message",
    actionId: "a1",
    meta: {},
    text,
  }) as TaskEvent;

describe("deriveSearchScopeNotice：什么时候提示", () => {
  const base = {
    filtering: true,
    hasMoreEarlier: true,
    loadedCount: 300,
    canLoadEarlier: true,
  };

  it("搜索中且还有更早未加载 → 提示『仅搜索已加载的最近 N 条』，带加载入口", () => {
    expect(deriveSearchScopeNotice(base)).toEqual({
      text: "仅搜索已加载的最近 300 条",
      canLoadEarlier: true,
    });
  });

  it("N 跟随已加载条数（加载更早后变大）", () => {
    expect(
      deriveSearchScopeNotice({ ...base, loadedCount: 450 })?.text,
    ).toBe("仅搜索已加载的最近 450 条");
  });

  it("没在搜索 / 没有更早未加载 → 不提示（历史已全部加载时 0/0 就是真的没有）", () => {
    expect(deriveSearchScopeNotice({ ...base, filtering: false })).toBeNull();
    expect(deriveSearchScopeNotice({ ...base, hasMoreEarlier: false })).toBeNull();
  });

  it("宿主没接 prepend 能力：只提示、不给加载入口", () => {
    expect(deriveSearchScopeNotice({ ...base, canLoadEarlier: false })).toEqual({
      text: "仅搜索已加载的最近 300 条",
      canLoadEarlier: false,
    });
  });
});

describe("搜更早内容：0/0 时提示 → 加载更早 → 搜到", () => {
  const recent = [msg("e3", "今天聊的是部署"), msg("e4", "部署完成")];
  const earlier = [msg("e1", "很早之前讨论过 alpha 方案"), msg("e2", "alpha 的细节")];

  it("已加载段里搜不到：命中 0、但提示在；加载更早后命中出现、提示随历史读完消失", () => {
    // 加载前：0 命中，但还有更早的 → 必须有提示（否则用户以为真没有）
    expect(searchEventStreamOccurrences(recent, "alpha")).toHaveLength(0);
    expect(
      deriveSearchScopeNotice({
        filtering: true,
        hasMoreEarlier: true,
        loadedCount: recent.length,
        canLoadEarlier: true,
      }),
    ).not.toBeNull();

    // 「加载更早的再搜」= 复用上拉分页 prepend 更早事件，搜索结果随事件重算
    const after = [...earlier, ...recent];
    const occ = searchEventStreamOccurrences(after, "alpha");
    expect(occ.map((o) => o.ownerId)).toEqual(["e1", "e2"]);
    // 此前 0 命中（下标 -1）→ 落到第 0 个、直接定位到刚搜到的
    expect(stabilizeOccurrenceSelection([], -1, occ)).toBe(0);
    // 历史读完（hasMoreEarlier=false）后不再提示
    expect(
      deriveSearchScopeNotice({
        filtering: true,
        hasMoreEarlier: false,
        loadedCount: after.length,
        canLoadEarlier: true,
      }),
    ).toBeNull();
  });
});

describe("stabilizeOccurrenceSelection：prepend 更早事件后不换命中", () => {
  it("有命中时加载更早：按 occurrence 身份找回原选中项（旧的按下标会指到另一处）", () => {
    const loaded = [msg("e3", "foo 在这"), msg("e4", "又一个 foo")];
    const prevOcc = searchEventStreamOccurrences(loaded, "foo");
    // 当前选中 e4 的 foo（下标 1）
    const prevIndex = 1;
    expect(prevOcc[prevIndex]?.ownerId).toBe("e4");

    const nextOcc = searchEventStreamOccurrences(
      [msg("e1", "更早的 foo"), msg("e2", "还有 foo"), ...loaded],
      "foo",
    );
    // 老逻辑只留下标 1 → 现在指向 e2（换命中、视口被拽走）
    expect(nextOcc[prevIndex]?.ownerId).toBe("e2");
    // 新逻辑：仍是 e4
    const idx = stabilizeOccurrenceSelection(prevOcc, prevIndex, nextOcc);
    expect(nextOcc[idx]?.ownerId).toBe("e4");
    expect(idx).toBe(3);
  });

  it("同一条里的多处命中也按位置区分", () => {
    const loaded = [msg("e2", "foo foo foo")];
    const prevOcc = searchEventStreamOccurrences(loaded, "foo");
    const nextOcc = searchEventStreamOccurrences(
      [msg("e1", "foo"), ...loaded],
      "foo",
    );
    const idx = stabilizeOccurrenceSelection(prevOcc, 2, nextOcc);
    expect(nextOcc[idx]).toMatchObject({ ownerId: "e2", start: prevOcc[2]!.start });
  });

  it("原选中项不在了（查询变了 / 被移走）→ 退回按下标钳制；无命中 → -1", () => {
    const prevOcc = searchEventStreamOccurrences([msg("e1", "foo foo foo")], "foo");
    const nextOcc = searchEventStreamOccurrences([msg("e1", "foo")], "foo");
    // 原下标 2 越界 → 钳到 0
    expect(stabilizeOccurrenceSelection(prevOcc, 2, nextOcc)).toBe(0);
    expect(stabilizeOccurrenceSelection(prevOcc, 2, [])).toBe(-1);
  });

  it("流式追加在尾部：已有命中的下标不变", () => {
    const base = [msg("e1", "foo"), msg("e2", "foo")];
    const prevOcc = searchEventStreamOccurrences(base, "foo");
    const nextOcc = searchEventStreamOccurrences([...base, msg("e3", "foo")], "foo");
    expect(stabilizeOccurrenceSelection(prevOcc, 0, nextOcc)).toBe(0);
    expect(stabilizeOccurrenceSelection(prevOcc, 1, nextOcc)).toBe(1);
  });
});

// ---- 接线契约（组件在 node 环境跑不起来，靠源码钉住关键接线） ----

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...p: string[]) => readFileSync(path.join(srcDir, ...p), "utf-8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("搜索范围提示接线契约", () => {
  const stream = stripComments(read("components", "tasks", "event-stream.tsx"));

  it("提示条的『加载更早的再搜』复用现有 loadEarlier，没有另起一套分页", () => {
    expect(stream).toMatch(/onLoadEarlier=\{\(\) => void loadEarlier\(\)\}/);
    expect(stream).toContain("canLoadEarlier: !!onPrependEvents");
    expect(stream).toContain("hasMoreEarlier,");
  });

  it("log / chat 两种形态都渲染提示条", () => {
    expect(stream).toMatch(/\{!isChat && renderSearchScopeNotice\(/);
    expect(stream).toMatch(/\{isChat &&\s*renderSearchScopeNotice\(/);
  });

  it("加载状态透传给入口（加载中置灰）", () => {
    expect(stream).toContain("loading={loadingEarlier}");
  });

  it("命中下标按 occurrence 身份稳定，不再只按下标", () => {
    expect(stream).toContain("stabilizeOccurrenceSelection(prevOccurrences, prev, searchOccurrences)");
    expect(stream).not.toContain("stabilizeOccurrenceIndex(prev, searchOccurrences.length)");
  });

  it("与产物面板共用的 EventStreamSearchBar 不受影响（提示条是独立组件）", () => {
    const bar = read("components", "tasks", "event-stream-search-bar.tsx");
    expect(bar).not.toContain("仅搜索已加载");
    expect(bar).not.toContain("EventStreamSearchScopeNotice");
  });
});
