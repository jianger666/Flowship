/**
 * 评审 R8-3：Virtuoso 被卸掉再重挂（列表清空后又有条目）必须重新落到最后一条
 *
 * 背景：去掉 `initialTopMostItemIndex` 之后，「进入对话落到最后一条」= 渲染期 latch（setFollowing(true) + beginSettle）
 * + `attachScroller` 在稳定期内挂上容器时起贴底链。latch 只有「定位闸」为 false 时才跑一次；
 * 列表清空的 effect 把闸开成 false，之后重新有条目那次渲染 latch 才会落底。
 * （2026-11-05 去掉「群问答」页签之前，页签往返是另一条「Virtuoso 重挂」路径，连同它的 effect / 守卫已删除。）
 *
 * UI 在 node 环境跑不起来，这里用「**执行源码里的真实片段**」代替手抄一份模型：
 * 从 event-stream.tsx 里把渲染期 latch 和「开闸」effect 的函数体原样截出来、`new Function` 跑，
 * 配真实的跟随控制器——谁改了守卫 / 改了 effect，这里是行为级红，而不只是字符串匹配。
 * （另有源码契约钉住形状：tests/event-stream-scroll-contract / event-stream-flow-b-contract。）
 *
 * 末尾还有「窗口级后台→前台」（Virtuoso 不重挂）的控制器行为：稳定期可能在后台耗尽，落底不能因此丢。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createStreamFollowController,
  type StreamFollowController,
} from "@/hooks/use-stream-follow";
import { MOUNT_SETTLE_MS } from "@/lib/scroll-follow";

const eventStream = readFileSync(
  path.resolve(import.meta.dirname, "..", "src", "components", "tasks", "event-stream.tsx"),
  "utf-8",
);

// ---------- 从源码里截真实片段 ----------

const between = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  expect(start, `源码里找不到 \`${from}\``).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, `\`${from}\` 之后找不到 \`${to}\``).toBeGreaterThan(start);
  return source.slice(start, end);
};

/** 渲染期 latch：`if (!initialPositionedRef.current ...) { ... }`（到下一个「开闸 effect」的注释前） */
const LATCH_SRC = between(
  eventStream,
  "if (!initialPositionedRef.current",
  "  // 列表清空（回退到最开头",
);
/** [listEmpty] effect 的函数体 */
const EMPTY_EFFECT_BODY = between(
  eventStream,
  "useEffect(() => {\n    if (!listEmpty) return;",
  "}, [listEmpty]);",
).replace("useEffect(() => {", "");

// ---------- 环境桩（与 tests/stream-follow-controller.test.ts 同款的最小子集） ----------

let queued = new Map<number, () => void>();
let nextFrameId = 1;
let clock = 0;
let docListeners = new Map<string, Set<() => void>>();
let visibility: "visible" | "hidden" = "visible";

beforeEach(() => {
  queued = new Map();
  nextFrameId = 1;
  clock = 0;
  docListeners = new Map();
  visibility = "visible";
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    const id = nextFrameId++;
    queued.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queued.delete(id);
  });
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type: string, fn: () => void) => {
      const set = docListeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      docListeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      docListeners.get(type)?.delete(fn);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flushFrame = () => {
  const pending = [...queued.values()];
  queued = new Map();
  for (const cb of pending) cb();
};
const pendingFrames = () => queued.size;
const fireVisibility = () => {
  for (const fn of [...(docListeners.get("visibilitychange") ?? [])]) fn();
};

/** 会夹 scrollTop 的假滚动容器；`writes` = 控制器对 scrollTop 的写入 */
const makeScroller = (init: { top: number; height: number; client: number }) => {
  const writes: number[] = [];
  const geom = { height: init.height, client: init.client };
  let top = init.top;
  const el = {
    get scrollHeight() {
      return geom.height;
    },
    get clientHeight() {
      return geom.client;
    },
    clientWidth: 900,
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      writes.push(v);
      top = Math.max(0, Math.min(v, geom.height - geom.client));
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return {
    el: el as unknown as HTMLElement,
    writes,
    top: () => top,
    setHeight: (h: number) => {
      geom.height = h;
    },
  };
};

/** 一个刚挂上、还没落底的新容器（Virtuoso 重挂：scrollTop=0、总高已撑起） */
const FRESH = { top: 0, height: 2000, client: 800 };
const BOTTOM = 1200;

// ---------- 迷你「渲染 / 提交」模拟器：跑源码里的真实 latch 与 effect ----------

const runLatch = new Function(
  "initialPositionedRef",
  "items",
  "follow",
  LATCH_SRC,
) as (
  ref: { current: boolean },
  items: unknown[],
  follow: StreamFollowController,
) => void;

const runEmptyEffect = new Function(
  "listEmpty",
  "initialPositionedRef",
  "lastRangeStartRef",
  EMPTY_EFFECT_BODY,
) as (
  listEmpty: boolean,
  ref: { current: boolean },
  range: { current: number | null },
) => void;

/** 与 React 一致：render 先跑 latch，commit 后依赖变了才跑 effect */
const makeStream = () => {
  const ctrl = createStreamFollowController({ current: vi.fn() }, () => clock);
  const initialPositionedRef = { current: false };
  const lastRangeStartRef: { current: number | null } = { current: null };
  let prevEmpty: boolean | undefined;
  let mountedScroller: ReturnType<typeof makeScroller> | null = null;

  const render = (itemCount: number) => {
    runLatch(initialPositionedRef, new Array(itemCount).fill(0), ctrl);
    // JSX：items.length === 0 ? 空态 : <Virtuoso/>
    const virtuosoInTree = itemCount > 0;
    if (!virtuosoInTree && mountedScroller) {
      ctrl.attachScroller(null); // Virtuoso 卸载：scrollerRef(null)
      mountedScroller = null;
    }
    // commit：先挂 ref（attachScroller）、再跑 effect
    let freshScroller: ReturnType<typeof makeScroller> | null = null;
    if (virtuosoInTree && !mountedScroller) {
      freshScroller = makeScroller(FRESH);
      mountedScroller = freshScroller;
      ctrl.attachScroller(freshScroller.el);
    }
    const listEmpty = itemCount === 0;
    if (prevEmpty !== listEmpty) {
      runEmptyEffect(listEmpty, initialPositionedRef, lastRangeStartRef);
      prevEmpty = listEmpty;
    }
    return freshScroller;
  };
  return { ctrl, render, initialPositionedRef, lastRangeStartRef };
};

describe("渲染期 latch：只落一次", () => {
  it("首次有条目落到底；之后的重渲不会再把用户刚上滚的跟随态拉回去", () => {
    const s = makeStream();
    const first = s.render(10);
    flushFrame();
    expect(first!.top()).toBe(BOTTOM);
    expect(s.initialPositionedRef.current).toBe(true);
    s.ctrl.setFollowing(false); // 用户上滚
    clock = 5000;
    for (let i = 0; i < 5; i++) s.render(10 + i);
    expect(s.ctrl.isFollowing()).toBe(false);
    expect(pendingFrames()).toBe(0);
    expect(first!.writes).toEqual([2000]); // 没有任何多余写入
  });
});

describe("R8-3 同类：列表清空后再有条目也是重挂 Virtuoso", () => {
  it("有条目 → 清空（回退到最开头）→ 停留超过稳定期 → 又有条目：重新落底", () => {
    const s = makeStream();
    const first = s.render(30);
    flushFrame();
    expect(first!.top()).toBe(BOTTOM);
    s.ctrl.setFollowing(false); // 用户上滚过

    clock = 1000;
    s.render(0); // 空态占位把 Virtuoso 卸掉
    expect(s.initialPositionedRef.current).toBe(false);
    expect(s.lastRangeStartRef.current).toBeNull();
    clock = 1000 + MOUNT_SETTLE_MS * 3;
    s.render(0); // 空态里的重渲不触发 latch（items.length === 0）
    expect(s.ctrl.isFollowing()).toBe(false);

    const again = s.render(2);
    expect(again).not.toBeNull();
    expect(s.ctrl.isFollowing()).toBe(true);
    flushFrame();
    expect(again!.top()).toBe(BOTTOM);
  });

  it("首次进入时列表本来就是空的：不影响之后第一次有条目时的 latch", () => {
    const s = makeStream();
    expect(s.render(0)).toBeNull();
    clock = 4000;
    const first = s.render(3);
    flushFrame();
    expect(first!.top()).toBe(BOTTOM);
  });

  it("有条目时 [listEmpty] 的 effect 不碰闸（只在变空时开）", () => {
    const ref = { current: true };
    const range: { current: number | null } = { current: 7 };
    runEmptyEffect(false, ref, range);
    expect(ref.current).toBe(true);
    expect(range.current).toBe(7);
  });
});

describe("窗口级后台→前台（Virtuoso 不重挂）：稳定期可能在后台耗尽，落底不能因此丢", () => {
  it("稳定期内挂着的首次落底帧在后台被暂停、稳定期在后台耗尽：切回前台那一帧仍写到底，不重复排链", () => {
    const { ctrl } = makeStream();
    ctrl.beginSettle();
    const sc = makeScroller(FRESH);
    ctrl.attachScroller(sc.el); // 起贴底链（rAF 在后台被暂停：不 flush）
    expect(pendingFrames()).toBe(1);
    visibility = "hidden";
    fireVisibility();
    clock = MOUNT_SETTLE_MS * 40; // 用户一分钟后才切回：performance.now 在后台照走
    visibility = "visible";
    fireVisibility(); // 前台可见 + 跟随中 → requestScrollToBottom：已有链在跑，合并进去
    expect(pendingFrames()).toBe(1);
    flushFrame();
    expect(sc.top()).toBe(BOTTOM);
  });

  it("后台耗尽稳定期、切回时列表还没测量（假性贴着、链提前收工）：之后 Virtuoso 测完总高 → totalListHeightChanged 的贴底请求仍能落底", () => {
    const { ctrl } = makeStream();
    ctrl.beginSettle();
    const sc = makeScroller({ top: 0, height: 800, client: 800 }); // 未测量：总高 = 视口
    ctrl.attachScroller(sc.el);
    visibility = "hidden";
    clock = MOUNT_SETTLE_MS * 40;
    visibility = "visible";
    fireVisibility();
    for (let i = 0; i < 6; i++) flushFrame(); // 假性贴着、3 帧后收工
    expect(pendingFrames()).toBe(0);
    // Virtuoso 测量完：总高撑起 → event-stream 的 onTotalHeightChanged 在跟随中请求贴底
    sc.setHeight(3000);
    ctrl.requestScrollToBottom();
    flushFrame();
    expect(sc.top()).toBe(3000 - 800);
  });

  it("切回前台时用户在翻历史（跟随关）：不动他", () => {
    const { ctrl } = makeStream();
    ctrl.beginSettle();
    const sc = makeScroller({ top: 600, height: 2000, client: 800 });
    ctrl.attachScroller(sc.el);
    ctrl.setFollowing(false);
    flushFrame();
    visibility = "hidden";
    clock = MOUNT_SETTLE_MS * 40;
    visibility = "visible";
    fireVisibility();
    expect(pendingFrames()).toBe(0);
    expect(sc.writes).toEqual([]);
  });
});
