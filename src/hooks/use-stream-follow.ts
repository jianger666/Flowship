"use client";

/**
 * 事件流「贴底跟随」控制器（2026-07-28 流式滚动手感重构）
 *
 * 一句话：**用户主动上滚就立刻停跟随，滚回底部就恢复**——判定逻辑在
 * `@/lib/scroll-follow`（纯函数、可单测），这里只负责 DOM 事件接线 + 状态托管。
 *
 * 三个设计要点（都是踩过的坑）：
 * 1. **跟随态是 ref 不是 state**：滚动是热路径，setState 会把整个 EventStream
 *    重渲一遍（几百条 item 的 itemContent 全部重建）；需要跟着变的只有
 *    「AI 在等你回答」悬浮条那一颗子树 → 走 useSyncExternalStore 订阅。
 * 2. **贴底动作 rAF 合批**：SSE 每秒能推几十个 chunk，逐个同步调 scrollToIndex
 *    会把 Virtuoso 的滚动状态机反复重启；一帧最多滚一次、且已经贴底就不空跑。
 * 3. **notify 走微任务**：初始定位恢复要在渲染期写跟随态，同步 notify 会触发
 *    React「在渲染中更新另一个组件」告警。
 */

import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";

import {
  distanceFromBottom,
  isEditableTarget,
  isScrollbarPointer,
  isUpIntentKey,
  isUpIntentTouch,
  isUpIntentWheel,
  nextFollowing,
} from "@/lib/scroll-follow";

export interface StreamFollowController {
  /** 挂给 Virtuoso 的 scrollerRef：拿到滚动容器后接手势监听 */
  attachScroller: (el: HTMLElement | Window | null) => void;
  /** 当前是否跟随最新（= 用户没有主动上滚离开底部） */
  isFollowing: () => boolean;
  /** 直接改跟随态（初始定位恢复 / 切 task 重置用） */
  setFollowing: (next: boolean) => void;
  /** 请求贴底：rAF 合批、一帧最多一次、已贴底则不动 */
  requestScrollToBottom: () => void;
  /** 订阅跟随态翻转（useSyncExternalStore） */
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => boolean;
  /** 卸载清理：摘监听 + 取消未执行的 rAF */
  dispose: () => void;
}

/** 已经贴到这个距离内就不用再滚了——省掉一次 Virtuoso 滚动状态机空转 */
const ALREADY_AT_BOTTOM_EPS = 1;

/**
 * 控制器工厂（export 供单测直接构造；组件侧一律走下面的 useStreamFollow）。
 * 不接 scroller 时只有「跟随态 + rAF 合批」两件事可用，正好是能在 node 里测的部分。
 */
export const createStreamFollowController = (
  scrollToBottomRef: { current: () => void },
): StreamFollowController => {
  /** 唯一事实源：当前是否跟随最新。初始 true（进来就在底部看最新） */
  let following = true;
  /** useSyncExternalStore 订阅者（只有悬浮条那种小子树会订） */
  const listeners = new Set<() => void>();
  /** 当前挂着监听的滚动容器 */
  let scroller: HTMLElement | null = null;
  /** 本帧已排队的贴底 rAF id；非 null = 别重复排 */
  let scrollRaf: number | null = null;
  /** 用户主动上滚意图：手势监听置位、紧随其后的 scroll 回调消费掉 */
  let intentUp = false;
  /** 正在拖原生滚动条：拖动期间每次 scroll 都按用户意图算 */
  let draggingScrollbar = false;
  /** 触摸起点 Y（判断手指往下拖 = 往上翻历史） */
  let touchStartY = 0;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const setFollowing = (next: boolean) => {
    if (next === following) return;
    following = next;
    // 微任务通知：允许渲染期写入（初始定位恢复）而不触发 React 跨组件更新告警
    queueMicrotask(notify);
  };

  /** 用「当前几何 + 是否有上滚意图」跑一次状态机 */
  const evaluate = (userIntentUp: boolean) => {
    if (!scroller) return;
    setFollowing(
      nextFollowing(following, {
        distanceFromBottom: distanceFromBottom(scroller),
        userIntentUp,
      }),
    );
  };

  // ---------- DOM 监听 ----------
  // 手势只负责「置意图位」，真正的判定统一在 scroll 回调里做：
  // 手势触发时浏览器还没滚，几何是旧的，此刻判会误判。

  const onScroll = () => {
    const intent = intentUp || draggingScrollbar;
    intentUp = false;
    evaluate(intent);
  };

  const onWheel = (e: WheelEvent) => {
    if (isUpIntentWheel(e.deltaY)) intentUp = true;
  };

  const onTouchStart = (e: TouchEvent) => {
    touchStartY = e.touches[0]?.clientY ?? 0;
  };

  const onTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY ?? 0;
    if (isUpIntentTouch(y - touchStartY)) intentUp = true;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && isEditableTarget(target.tagName, target.isContentEditable)) {
      return;
    }
    if (isUpIntentKey(e.key)) intentUp = true;
  };

  const onPointerDown = (e: PointerEvent) => {
    // 滚动条槽不是子元素、命中时 target 就是容器本身；offsetX 才有可比性
    if (!scroller || e.target !== scroller) return;
    if (isScrollbarPointer(e.offsetX, scroller.clientWidth)) {
      draggingScrollbar = true;
    }
  };

  const onPointerUp = () => {
    draggingScrollbar = false;
  };

  const detach = () => {
    if (!scroller) return;
    scroller.removeEventListener("scroll", onScroll);
    scroller.removeEventListener("wheel", onWheel);
    scroller.removeEventListener("touchstart", onTouchStart);
    scroller.removeEventListener("touchmove", onTouchMove);
    scroller.removeEventListener("keydown", onKeyDown);
    scroller.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointerup", onPointerUp);
    scroller = null;
  };

  const attachScroller = (el: HTMLElement | Window | null) => {
    // useWindowScroll 场景本项目不用；拿到 Window 一律当没挂
    const next = el && el !== window ? (el as HTMLElement) : null;
    if (next === scroller) return;
    detach();
    if (!next) return;
    scroller = next;
    // 全部 passive：我们只观察、不 preventDefault，别拖慢原生滚动
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("keydown", onKeyDown, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
    // pointerup 挂 window：拖着滚动条把鼠标移出容器再松手也能收尾
    window.addEventListener("pointerup", onPointerUp, { passive: true });
  };

  const requestScrollToBottom = () => {
    if (scrollRaf !== null) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      if (!following) return;
      // 已经贴着了就别调——每次 scrollToIndex 都会重启 Virtuoso 的滚动状态机
      if (scroller && distanceFromBottom(scroller) <= ALREADY_AT_BOTTOM_EPS) {
        return;
      }
      scrollToBottomRef.current();
    });
  };

  return {
    attachScroller,
    isFollowing: () => following,
    setFollowing,
    requestScrollToBottom,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getSnapshot: () => following,
    dispose: () => {
      detach();
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
      scrollRaf = null;
      listeners.clear();
    },
  };
};

/**
 * 建一个跟随控制器（每个事件流实例一个、引用恒定）。
 * @param scrollToBottom 真正执行贴底的动作（Virtuoso scrollToIndex），
 *   由调用方提供、内部 ref 化取最新，避免控制器绑死某一版闭包。
 */
export const useStreamFollow = (
  scrollToBottom: () => void,
): StreamFollowController => {
  const scrollToBottomRef = useRef(scrollToBottom);
  scrollToBottomRef.current = scrollToBottom;

  const ctrlRef = useRef<StreamFollowController | null>(null);
  ctrlRef.current ??= createStreamFollowController(scrollToBottomRef);
  const ctrl = ctrlRef.current;

  useEffect(() => () => ctrl.dispose(), [ctrl]);

  return ctrl;
};

/** 订阅跟随态（只在真正需要随之显隐的小子树里调、别在事件流主组件里调） */
export const useIsFollowing = (ctrl: StreamFollowController): boolean =>
  useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot, ctrl.getSnapshot);

/**
 * 把控制器透给深层子组件（工作过程组的自动折叠要看「用户是不是在翻历史」）。
 * 传的是控制器本身（引用恒定）、不是布尔值——子组件按需 `isFollowing()` 现读，
 * 不订阅就不会因为滚动而重渲。
 */
export const StreamFollowContext =
  createContext<StreamFollowController | null>(null);

export const useStreamFollowContext = (): StreamFollowController | null =>
  useContext(StreamFollowContext);
