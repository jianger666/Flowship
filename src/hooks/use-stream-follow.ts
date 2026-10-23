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
 * 2. **贴底动作 rAF 合批 + 自己复查**：SSE 每秒能推几十个 chunk，逐个同步写 scrollTop
 *    会白白重排；一帧最多贴一次、已经贴底就不动。贴完还会再盯几帧（Virtuoso 渲染新露出的项、
 *    测完高度后总高会变），连续几帧都贴着才收工；用户一上滚（跟随态翻 false）这条链当场停。
 *    **不走 Virtuoso 的 scrollToIndex、也不给它传 followOutput**：它们启动的重试链在内容一直
 *    增长时永不结束、又没有取消接口，用户上滚后仍会每 ~100ms 把人拉回底部
 *    （2026-10-12 实测，见 scroll-follow 文件头第 4 条）。
 * 3. **notify 走微任务**：初始定位恢复要在渲染期写跟随态，同步 notify 会触发
 *    React「在渲染中更新另一个组件」告警。
 * 4. **恢复跟随只认「用户往下翻」**（2026-10-12）：手势监听记下最近一次往下翻输入的时间
 *    （滚轮 / 触摸 / ↓ PageDown End / 点滚动条轨道），scroll 回调里再看本次 scrollTop 是不是
 *    在变大——输入没过期 + 朝底部走 + 进贴底带，三样齐了才恢复。浏览器平滑滚动动画的后续帧、
 *    Virtuoso 的补偿 scrollBy 都是「朝底部、进了带」的程序化滚动，没有往下翻输入就骗不了它
 *    （用户实测的「往回滚一点又弹回底部」）。
 * 6. **「回到最新」是一小段缓动、不是瞬移**（2026-10-17）：`scrollToBottomSmooth` 控制器自己逐帧写
 *    scrollTop（每帧重读终点、内容在长也追得上），滑行期间跟随态保持 false（流式的贴底请求不跟它抢），
 *    落地才开闸；用户上滚 / 拖滚动条 / 点别处跳转（public setFollowing）当场取消。
 *    太远（> 3 个视口）或「减少动态效果」直接跳。
 * 5. **视口高度变化要补一条贴底**：composer 变高 / 窗口缩放时视口变矮，原先靠 Virtuoso 自己的
 *    「视口变矮就贴底」路径；那条路径跟「内容增高就贴底」共用一个闸门、被我们一起关掉了
 *    （见 scroll-follow 的 VIRTUOSO_NEVER_AT_BOTTOM），这里用 ResizeObserver 补回来、受跟随态约束。
 */

import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";

import {
  DOWN_INTENT_TTL_MS,
  PIN_SETTLE_MAX_FRAMES,
  PIN_SETTLE_STABLE_FRAMES,
  distanceFromBottom,
  isDownIntentKey,
  isDownIntentTouch,
  isDownIntentWheel,
  isEditableTarget,
  isScrollbarPointer,
  isUpIntentKey,
  isUpIntentTouch,
  isUpIntentWheel,
  isUpScrollHandledElsewhere,
  nextFollowing,
  shouldAnimateScrollToBottom,
  smoothBottomDuration,
  smoothBottomTop,
  type ScrollAncestorLike,
} from "@/lib/scroll-follow";

export interface StreamFollowController {
  /** 挂给 Virtuoso 的 scrollerRef：拿到滚动容器后接手势监听 */
  attachScroller: (el: HTMLElement | Window | null) => void;
  /** 当前是否跟随最新（= 用户没有主动上滚离开底部） */
  isFollowing: () => boolean;
  /** 直接改跟随态（初始定位恢复 / 切 task 重置用） */
  setFollowing: (next: boolean) => void;
  /** 请求贴底：rAF 合批、一帧最多一次、已贴底则不动；贴完再复查几帧、用户上滚即停 */
  requestScrollToBottom: () => void;
  /**
   * 「回到最新」：短缓动滑到底、落地后恢复跟随（太远 / 减少动态效果 / 没容器时退化为立即开闸 + 贴底）。
   * 滑行期间跟随态保持 false；用户上滚、拖滚动条、任何 public setFollowing 调用都会取消滑行。
   */
  scrollToBottomSmooth: () => void;
  /** 订阅跟随态翻转（useSyncExternalStore） */
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => boolean;
  /** 卸载清理：摘监听 + 取消未执行的 rAF */
  dispose: () => void;
}

/** 已经贴到这个距离内就不用再写 scrollTop 了（同时是复查时「这一帧贴着了」的判定） */
const ALREADY_AT_BOTTOM_EPS = 1;

/**
 * 「上滚意图」的有效期（毫秒，与 `DOWN_INTENT_TTL_MS` 对称）：手势只置意图位、由紧随其后的 scroll
 * 回调消费，浏览器里手势到 scroll 通常不超过一两帧，1s 足够宽松；超过就说明这次手势根本没引出
 * scroll（已在最顶上再上滚、内容还装得下一屏），意图该作废——否则它会一直躲着，等到控制器自己贴底
 * 写 scrollTop 触发的 scroll 把它消费掉，被当成「用户上滚」而永久关掉跟随（V2-02）。
 * 拖原生滚动条走 `draggingScrollbar`、不受它约束。
 */
export const UP_INTENT_TTL_MS = 1000;

/** 读系统「减少动态效果」偏好；SSR / 单测（无 matchMedia）当没开 */
const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * 控制器工厂（export 供单测直接构造；组件侧一律走下面的 useStreamFollow）。
 * @param scrollToBottomRef 只在**没有滚动容器可写**时（单测 / Window 滚动）才用的兜底贴底动作；
 *   挂上 scroller 之后控制器自己写 scrollTop、不再调它。
 */
export const createStreamFollowController = (
  scrollToBottomRef: { current: () => void },
  /** 时间源（单测注入、判「往下翻」输入是否还在有效期内 / 驱动滑行进度） */
  now: () => number = () => performance.now(),
  /** 「减少动态效果」偏好（单测注入；默认读系统媒体查询，无 matchMedia 的环境当没开） */
  reducedMotion: () => boolean = prefersReducedMotion,
): StreamFollowController => {
  /** 唯一事实源：当前是否跟随最新。初始 true（进来就在底部看最新） */
  let following = true;
  /** useSyncExternalStore 订阅者（只有悬浮条那种小子树会订） */
  const listeners = new Set<() => void>();
  /** 当前挂着监听的滚动容器 */
  let scroller: HTMLElement | null = null;
  /** 本帧已排队的贴底 rAF id；非 null = 别重复排 */
  let scrollRaf: number | null = null;
  /** 「回到最新」滑行的 rAF id；非 null = 正在滑 */
  let smoothRaf: number | null = null;
  /**
   * 最近一次用户主动上滚意图的时间：手势监听记下、紧随其后的 scroll 回调消费掉，
   * 且只在 `UP_INTENT_TTL_MS` 内有效（手势没引出 scroll 时不能一直躲着，见常量注释）
   */
  let intentUpAt = Number.NEGATIVE_INFINITY;
  /** 正在拖原生滚动条：拖动期间每次 scroll 都按用户意图算 */
  let draggingScrollbar = false;
  /** 触摸起点 Y（判断手指往下拖 = 往上翻历史） */
  let touchStartY = 0;
  let touchStartX = 0;
  /** 上一次 scroll 事件时的 scrollTop（挂上时取当前值）：本次相减得滚动方向 */
  let lastScrollTop = 0;
  /** 最近一次用户「往下翻」输入的时间：恢复跟随要求它还在有效期内（程序化滚动没有输入） */
  let downIntentAt = Number.NEGATIVE_INFINITY;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  /** 取消还没执行的贴底 / 复查帧 */
  const cancelPin = () => {
    if (scrollRaf === null) return;
    cancelAnimationFrame(scrollRaf);
    scrollRaf = null;
  };

  /** 取消「回到最新」的滑行（用户上滚 / 去别处 / 卸载） */
  const cancelSmooth = () => {
    if (smoothRaf === null) return;
    cancelAnimationFrame(smoothRaf);
    smoothRaf = null;
  };

  /**
   * 内部写跟随态（状态机 / 滑行落地用）。**不取消滑行**：滑行自己写 scrollTop 会触发 scroll 回调 →
   * evaluate → 这里（还没跟随、没有上滚意图 → 结果仍是 false），若在此取消就把滑行自己杀了。
   */
  const applyFollowing = (next: boolean) => {
    if (next === following) return;
    following = next;
    // 用户离开底部：还没执行的贴底 / 复查作废（帧回调里还会再看一眼跟随态，双保险）
    if (!next) cancelPin();
    // 微任务通知：允许渲染期写入（初始定位恢复）而不触发 React 跨组件更新告警
    queueMicrotask(notify);
  };

  /**
   * 对外的 setFollowing（初始定位恢复 / 切 task / 「跳到某一项」前停跟随）：先取消滑行再写。
   * 点横幅回到上一条时必须走它——否则正在滑向底部的动画会把人又带回去。
   */
  const setFollowing = (next: boolean) => {
    cancelSmooth();
    applyFollowing(next);
  };

  /** 用「当前几何 + 上滚意图 + 往下翻输入 + 本次滚动方向」跑一次状态机 */
  const evaluate = (
    userIntentUp: boolean,
    userIntentDown: boolean,
    scrollDelta: number,
  ) => {
    if (!scroller) return;
    applyFollowing(
      nextFollowing(following, {
        distanceFromBottom: distanceFromBottom(scroller),
        userIntentUp,
        userIntentDown,
        scrollDelta,
      }),
    );
  };

  const markDownIntent = () => {
    downIntentAt = now();
  };

  // ---------- DOM 监听 ----------
  // 手势只负责「置意图位」，真正的判定统一在 scroll 回调里做：
  // 手势触发时浏览器还没滚，几何是旧的，此刻判会误判。

  const onScroll = () => {
    if (!scroller) return;
    // 过期的意图当没有：它对应的手势没引出过 scroll，眼前这个 scroll 是程序化的（V2-02）
    const intent =
      now() - intentUpAt <= UP_INTENT_TTL_MS || draggingScrollbar;
    intentUpAt = Number.NEGATIVE_INFINITY;
    // 每个 scroll 事件都要更新基准（不能只在挂上时记一次）：用户先上滚很远、再往下滚回来时，
    // 「往下」是相对上一帧而言的
    const top = scroller.scrollTop;
    const scrollDelta = top - lastScrollTop;
    lastScrollTop = top;
    evaluate(intent, now() - downIntentAt <= DOWN_INTENT_TTL_MS, scrollDelta);
  };

  /**
   * 用户主动往上翻：置意图位 + 取消「回到最新」的滑行（别跟用户抢方向盘）。
   * **同时作废还没过期的往下翻输入**（V2-03）：1s TTL 内「先下后上」，之后 Virtuoso 向上补偿的
   * scrollBy(+28)「朝底部、进了贴底带」，会借着残留的往下翻输入把跟随误恢复；最后一次手势是上滚，
   * 之前的往下翻输入就不该再算数。
   *
   * **容器不可滚（内容装得下一屏）时不登记上滚意图**（V2-02）：此时滚轮 / ↑ / 触摸下拖都不会引出
   * scroll 事件，意图没人消费、会一直躲着；等 AI 的回答长出一屏、控制器第一次贴底写 scrollTop
   * 引发 scroll，就被当成「用户上滚」把跟随永久关掉。没有可滚的内容，用户也就没有「离开底部」可言。
   */
  const markUpIntent = () => {
    downIntentAt = Number.NEGATIVE_INFINITY;
    cancelSmooth();
    if (scroller && scroller.scrollHeight <= scroller.clientHeight) return;
    intentUpAt = now();
  };

  const onWheel = (e: WheelEvent) => {
    if (isUpIntentWheel(e.deltaY)) {
      // 横向滑动 / 被内层可滚区吃掉的上滚：外层不会滚、没有 scroll 事件来消费意图，
      // 残留的意图会被之后流式贴底写的 scroll 事件误当成「用户上滚」（评审 N1）。不登记、也不取消滑行
      if (
        isUpScrollHandledElsewhere(
          e,
          e.target as unknown as ScrollAncestorLike | null,
          scroller,
        )
      ) {
        return;
      }
      markUpIntent();
    } else if (isDownIntentWheel(e.deltaY)) markDownIntent();
  };

  const onTouchStart = (e: TouchEvent) => {
    touchStartY = e.touches[0]?.clientY ?? 0;
    touchStartX = e.touches[0]?.clientX ?? 0;
  };

  const onTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY ?? 0;
    const x = e.touches[0]?.clientX ?? 0;
    if (isUpIntentTouch(y - touchStartY)) {
      // 与滚轮同口径（评审 N1 / R3）：横向为主的滑动、或手指落在内层可滚区且它还没滚到顶（下拖由内层消化），
      // 外层不会滚、没有 scroll 事件消费意图 → 不登记。touchmove 的 target 恒为触点起始元素
      if (
        isUpScrollHandledElsewhere(
          { deltaX: x - touchStartX, deltaY: -(y - touchStartY) },
          e.target as unknown as ScrollAncestorLike | null,
          scroller,
        )
      ) {
        return;
      }
      markUpIntent();
    } else if (isDownIntentTouch(y - touchStartY)) markDownIntent();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && isEditableTarget(target.tagName, target.isContentEditable)) {
      return;
    }
    if (isUpIntentKey(e.key)) {
      // 焦点在内层可滚区里且它还没滚到顶：↑ / PageUp / Home 由内层消化，外层不滚（评审 R3，与滚轮 / 触摸同口径）
      if (
        isUpScrollHandledElsewhere(
          { deltaY: -1 },
          e.target as unknown as ScrollAncestorLike | null,
          scroller,
        )
      ) {
        return;
      }
      markUpIntent();
    } else if (isDownIntentKey(e.key)) markDownIntent();
  };

  const onPointerDown = (e: PointerEvent) => {
    // 滚动条槽不是子元素、命中时 target 就是容器本身；offsetX 才有可比性
    if (!scroller || e.target !== scroller) return;
    if (isScrollbarPointer(e.offsetX, scroller.clientWidth)) {
      draggingScrollbar = true;
      cancelSmooth();
      // 点轨道翻页可能是往下翻：松手后的动画帧要能把人带回贴底（拖动期间仍按上滚意图算）
      markDownIntent();
    }
  };

  const onPointerUp = () => {
    draggingScrollbar = false;
  };

  /**
   * 排一帧「贴底 + 复查」。progress 跨帧共用：
   * - stable：已经连续几帧看到贴着了（够 PIN_SETTLE_STABLE_FRAMES 才收工）
   * - budget：还剩几帧可盯（内容一直在长时不无限续命）
   */
  const schedulePin = (progress: { stable: number; budget: number }) => {
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      // 用户已经离开底部：这条链到此为止——上滚之后绝不再动他
      if (!following) return;
      // 没有滚动容器可写（单测 / Window 滚动）：退回外部给的贴底动作，做一次就算
      if (!scroller) {
        scrollToBottomRef.current();
        return;
      }
      if (distanceFromBottom(scroller) <= ALREADY_AT_BOTTOM_EPS) {
        // 贴着了：再盯几帧——Virtuoso 刚渲染的新项测完高度后总高可能又变、把距底拉开
        progress.stable += 1;
        if (progress.stable >= PIN_SETTLE_STABLE_FRAMES) return;
      } else {
        progress.stable = 0;
        // 浏览器会把过大的值夹到最大可滚位置
        scroller.scrollTop = scroller.scrollHeight;
      }
      progress.budget -= 1;
      if (progress.budget > 0) schedulePin(progress);
    });
  };

  const requestScrollToBottom = () => {
    // 已经有一条链在跑（排着队 / 复查中）：合并进去，它每帧都会重新看几何
    if (scrollRaf !== null) return;
    schedulePin({ stable: 0, budget: PIN_SETTLE_MAX_FRAMES });
  };

  const scrollToBottomSmooth = () => {
    cancelSmooth();
    const finish = () => {
      applyFollowing(true);
      requestScrollToBottom();
    };
    const el = scroller;
    // 没容器（单测 / Window 滚动）/ 已在跟随（贴底链在跑、不需要再滑）：直接开闸 + 贴底
    if (!el || following) {
      finish();
      return;
    }
    const distance = distanceFromBottom(el);
    if (!shouldAnimateScrollToBottom(distance, el.clientHeight, reducedMotion())) {
      finish();
      return;
    }
    const from = el.scrollTop;
    const startedAt = now();
    const duration = smoothBottomDuration(distance, el.clientHeight);
    const tick = () => {
      smoothRaf = null;
      const cur = scroller;
      if (!cur) return;
      const elapsed = now() - startedAt;
      if (elapsed >= duration) {
        // 落地：一步贴到真底、开闸，再交给贴底链盯几帧（Virtuoso 测量完总高可能又变）
        cur.scrollTop = cur.scrollHeight;
        finish();
        return;
      }
      // 终点每帧重读：滑行期间流式内容还在长、总高在变
      const target = Math.max(0, cur.scrollHeight - cur.clientHeight);
      cur.scrollTop = smoothBottomTop(from, target, elapsed, duration);
      smoothRaf = requestAnimationFrame(tick);
    };
    smoothRaf = requestAnimationFrame(tick);
  };

  /** 视口高度观察者（原因见 attachScroller 里的说明） */
  let viewportObserver: ResizeObserver | null = null;

  const detach = () => {
    cancelSmooth();
    if (!scroller) return;
    scroller.removeEventListener("scroll", onScroll);
    scroller.removeEventListener("wheel", onWheel);
    scroller.removeEventListener("touchstart", onTouchStart);
    scroller.removeEventListener("touchmove", onTouchMove);
    scroller.removeEventListener("keydown", onKeyDown);
    scroller.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointerup", onPointerUp);
    viewportObserver?.disconnect();
    viewportObserver = null;
    scroller = null;
    // 手势态是跟着旧 scroller 的：不清的话，拖着滚动条时容器被换掉（Virtuoso 重挂 / 卸载）收不到 pointerup，
    // `draggingScrollbar` 会粘到新容器上、把它之后每一次程序化滚动都当成用户上滚；
    // 没过期的「往下翻」输入同理，会被新容器上的程序化滚动借去恢复跟随。
    //
    // **刻意不动 `following`**：它是事件流级别的状态，不属于某个 scroller——切 task 时的初始定位恢复
    // 在渲染期就写了它（`setFollowing(startFollowing)`），早于 Virtuoso 挂上新 scroller；
    // 这里若复位成 true，会把「恢复到上次翻到的位置（不贴底）」的结果在挂载那一刻覆盖掉。
    intentUpAt = Number.NEGATIVE_INFINITY;
    draggingScrollbar = false;
    touchStartY = 0;
    touchStartX = 0;
    downIntentAt = Number.NEGATIVE_INFINITY;
  };

  const attachScroller = (el: HTMLElement | Window | null) => {
    // useWindowScroll 场景本项目不用；拿到 Window 一律当没挂
    const next = el && el !== window ? (el as HTMLElement) : null;
    if (next === scroller) return;
    detach();
    if (!next) return;
    scroller = next;
    lastScrollTop = next.scrollTop;
    // 全部 passive：我们只观察、不 preventDefault，别拖慢原生滚动
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("keydown", onKeyDown, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
    // pointerup 挂 window：拖着滚动条把鼠标移出容器再松手也能收尾
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    // 视口高度变化（composer 变高 / 窗口缩放）：跟随中就重新贴底。
    // Virtuoso 自己有一条「视口变矮 → 贴底」的路径，但它跟「内容增高自动贴底」共用同一个
    // atBottomThreshold 判定、被我们一起关掉了（原因见 scroll-follow 的 VIRTUOSO_NEVER_AT_BOTTOM），
    // 这里补回来——并且受跟随态闸门约束，用户在翻历史时不动他。
    // 只认高度变化：宽度变化是重排、不是「视口变矮」；observe 的首次回调高度没变、天然被滤掉
    if (typeof ResizeObserver !== "undefined") {
      let lastClientHeight = next.clientHeight;
      viewportObserver = new ResizeObserver(() => {
        const height = next.clientHeight;
        if (height === lastClientHeight) return;
        lastClientHeight = height;
        if (following) requestScrollToBottom();
      });
      viewportObserver.observe(next);
    }
  };

  return {
    attachScroller,
    isFollowing: () => following,
    setFollowing,
    requestScrollToBottom,
    scrollToBottomSmooth,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getSnapshot: () => following,
    dispose: () => {
      detach();
      cancelPin();
      listeners.clear();
    },
  };
};

/**
 * 建一个跟随控制器（每个事件流实例一个、引用恒定）。
 * @param scrollToBottom 没有滚动容器可写时的兜底贴底动作（Virtuoso scrollToIndex）；
 *   挂上 scroller 后控制器自己写 scrollTop、不会调它。
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
