"use client";

/**
 * 浮层遮盖：Flowship 自己的浮层（dialog / sheet / 菜单 / popover / tooltip / toast / Cmd+K 面板）与浏览器视口相交时，
 * 让主进程对视图截图并隐藏它（`setCovered(true)` 拿到占位 dataURL），浮层全关后恢复。
 * 原因见 overlay-cover-logic.ts 文件头（原生视图永远盖在 HTML 之上）。
 *
 * 性能 / 稳定性：
 *  - 只在 `enabled`（视口已挂载并 attach）时才建 observer，卸载即断开；没打开浏览器面板的用户零影响；
 *  - 浮层都 Portal 到 <body> 的直接子节点：body 只看 childList（不开 subtree），否则事件流每吐一个字都会唤醒回调；
 *    浮层的开合体现在 data-open / role 等少数属性上，用 attributeFilter 限定；
 *    sonner 的 toast 不在 body 直下（渲染在布局里的 <section> 里），单独对它的容器开 subtree childList；
 *  - 所有触发都合并进一个 50ms 的去抖评估，评估本身只读 DOM、不写任何东西，observer 不会被自己引发风暴；
 *  - 切换走 overlay-cover-logic.decideCoverAction：常驻浮层立刻遮盖、瞬时浮层（tooltip / toast）站稳 300ms 才遮盖、
 *    浮层消失后再等 150ms 才恢复，hover 扫过 tooltip 不闪、菜单关了紧接着弹窗打开也不闪；
 *  - 与主进程的 setCovered 调用串行化（上一次没回来不发下一次），最终状态以最后一次评估为准。
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  CLOSING_SELECTOR,
  HARD_OVERLAY_SELECTOR,
  OVERLAY_ATTRIBUTE_FILTER,
  POPPER_SELECTOR,
  TOASTER_CONTAINER_SELECTOR,
  TOAST_SELECTOR,
  classifyCover,
  decideCoverAction,
  type CoverNeed,
  type OverlayItem,
} from "./overlay-cover-logic";
import { OVERLAY_LAYOUT_EVENT } from "@/lib/overlay-layout-event";
import { isElementRendered } from "./viewport-bounds";

/** 去抖评估间隔：既够合并一次开合引起的一串 DOM 事件，又不至于让遮盖明显滞后 */
const EVALUATE_DEBOUNCE_MS = 50;

const isClosing = (el: Element): boolean => el.closest(CLOSING_SELECTOR) !== null;

/** 扫描当前文档里所有「打开着」的浮层，转成矩形 + 是否瞬时 */
export const collectOverlays = (doc: Document): OverlayItem[] => {
  const out: OverlayItem[] = [];
  const hardEls = new Set<Element>();

  for (const el of doc.querySelectorAll(HARD_OVERLAY_SELECTOR)) {
    if (isClosing(el) || !isElementRendered(el)) continue;
    hardEls.add(el);
    out.push({ rect: el.getBoundingClientRect(), transient: false });
  }

  // data-open + data-side 但不是上面任何一种常驻浮层（自己、祖先、后代都不是）= tooltip
  for (const el of doc.querySelectorAll(POPPER_SELECTOR)) {
    if (isClosing(el) || !isElementRendered(el)) continue;
    let isHard = false;
    for (const h of hardEls) {
      if (h === el || h.contains(el) || el.contains(h)) {
        isHard = true;
        break;
      }
    }
    if (isHard) continue;
    out.push({ rect: el.getBoundingClientRect(), transient: true });
  }

  for (const el of doc.querySelectorAll(TOAST_SELECTOR)) {
    if (!isElementRendered(el)) continue;
    out.push({ rect: el.getBoundingClientRect(), transient: true });
  }
  return out;
};

export interface UseOverlayCoverOptions {
  taskId: string;
  /** 视口占位 div */
  viewportRef: RefObject<HTMLElement | null>;
  /** 视口已挂载并 attach 到了主窗口；false 时不建 observer、也不遮盖 */
  enabled: boolean;
}

export interface OverlayCoverState {
  covered: boolean;
  /** setCovered(true) 返回的占位截图；null = 没拿到（截图失败）或没遮盖 */
  coverImage: string | null;
  /** 视口位置 / 尺寸变了（可能刚好从浮层下挪出来或挪进去）：请求重新评估一次 */
  reevaluate: () => void;
}

export const useOverlayCover = ({
  taskId,
  viewportRef,
  enabled,
}: UseOverlayCoverOptions): OverlayCoverState => {
  const [covered, setCovered] = useState(false);
  const [coverImage, setCoverImage] = useState<string | null>(null);

  // 评估入口放 ref：observer / 定时器是 effect 里建的，viewport 重渲不该让它们重建
  const evaluateRef = useRef<() => void>(() => {});
  const reevaluate = useCallback(() => evaluateRef.current(), []);

  useEffect(() => {
    const bridge = window.__browser;
    if (!enabled || !bridge) return;

    let disposed = false;
    // 与主进程对齐的「已遮盖」状态（setCovered 回来才翻）；want = 最新评估想要的状态
    let coveredNow = false;
    let want = false;
    let busy = false;

    let need: CoverNeed = "none";
    let needSince = performance.now();
    let evalTimer: ReturnType<typeof setTimeout> | null = null;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;

    // 把 coveredNow 推到 want：串行执行，期间 want 变了就接着追，保证最终一致
    const pump = async () => {
      if (busy) return;
      busy = true;
      try {
        while (!disposed && coveredNow !== want) {
          const target = want;
          try {
            if (target) {
              const img = await bridge.setCovered(taskId, true);
              if (disposed) return;
              coveredNow = true;
              setCoverImage(img ?? null);
              setCovered(true);
            } else {
              // 先让主进程恢复视图，再撤占位图：中间不会出现「视图还没回来、占位图已经没了」的空档
              await bridge.setCovered(taskId, false);
              if (disposed) return;
              coveredNow = false;
              setCovered(false);
              setCoverImage(null);
            }
          } catch {
            // IPC 失败：别卡死在循环里；放弃本次，下一次评估会再试
            return;
          }
        }
      } finally {
        busy = false;
      }
    };

    const evaluate = () => {
      evalTimer = null;
      if (disposed) return;
      const el = viewportRef.current;
      let next: CoverNeed = "none";
      if (el && isElementRendered(el)) {
        next = classifyCover(collectOverlays(document), el.getBoundingClientRect());
      }
      const now = performance.now();
      if (next !== need) {
        need = next;
        needSince = now;
      }
      const { action, nextCheckInMs } = decideCoverAction({
        covered: want,
        need,
        heldMs: now - needSince,
      });
      if (checkTimer) {
        clearTimeout(checkTimer);
        checkTimer = null;
      }
      if (action === "cover") want = true;
      else if (action === "uncover") want = false;
      if (action !== "none") void pump();
      // need 没变就不会再有 DOM 事件，得自己定时回来判「站稳了没有」
      if (nextCheckInMs !== null) {
        checkTimer = setTimeout(evaluate, nextCheckInMs + 5);
      }
    };

    const schedule = () => {
      if (evalTimer || disposed) return;
      evalTimer = setTimeout(evaluate, EVALUATE_DEBOUNCE_MS);
    };
    evaluateRef.current = schedule;

    // ① body 直接子节点：Portal 出来的 dialog / 菜单 / popover / tooltip 的挂载与摘除
    const bodyObserver = new MutationObserver(schedule);
    bodyObserver.observe(document.body, { childList: true });
    // ② body 全树只看浮层开合相关的属性（data-open / role…），不开 childList，事件流刷新不会唤醒它
    const attrObserver = new MutationObserver(schedule);
    attrObserver.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: OVERLAY_ATTRIBUTE_FILTER,
    });
    // ③ sonner 的 toast 容器（不在 body 直下）：条目增删
    const toaster = document.querySelector(TOASTER_CONTAINER_SELECTOR);
    const toastObserver = new MutationObserver(schedule);
    if (toaster) toastObserver.observe(toaster, { childList: true, subtree: true });

    window.addEventListener("resize", schedule);
    // ④ 观察不到的浮层（挂在应用根部的播放器等）开合 / 挪位 / 改尺寸时主动通知（见 lib/overlay-layout-event）
    window.addEventListener(OVERLAY_LAYOUT_EVENT, schedule);
    // 首次评估：面板打开时可能已经有浮层开着（比如从命令面板里点进来的）
    schedule();

    return () => {
      disposed = true;
      evaluateRef.current = () => {};
      if (evalTimer) clearTimeout(evalTimer);
      if (checkTimer) clearTimeout(checkTimer);
      bodyObserver.disconnect();
      attrObserver.disconnect();
      toastObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener(OVERLAY_LAYOUT_EVENT, schedule);
      // 卸载时无条件让主进程恢复视图（R1-13）：不能只在 coveredNow 为真时才发——
      // 一次 setCovered(true) 可能正在途中（截图还没回来，coveredNow 仍是 false），漏发 false 就会让它事后落地、
      // 把视图永久藏起来。主进程对未 attach 的会话是空操作，对在途的 true 用序号令牌作废，重复发 false 无副作用
      void Promise.resolve(bridge.setCovered(taskId, false)).catch(() => {});
      setCovered(false);
      setCoverImage(null);
    };
  }, [enabled, taskId, viewportRef]);

  return { covered, coverImage, reevaluate };
};
