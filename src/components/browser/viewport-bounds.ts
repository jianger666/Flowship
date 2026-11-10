/**
 * 浏览器视口占位 div 的 bounds 计算（纯函数，client / 测试都能 import）
 *
 * 原生 WebContentsView 盖在 HTML 之上，位置完全由这里算出来的矩形决定，所以口径要钉死：
 *  - 用 getBoundingClientRect 的结果，取整后汇报；
 *  - 容器不可见或宽高为 0 → 返回 null，调用方据此 detach（别把一个 0 尺寸的视图留在窗口上）。
 */

import type { Bounds } from "@/lib/browser-bridge-types";

/** getBoundingClientRect 返回值里我们用到的字段（测试里不用造 DOMRect） */
export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 占位 div 的矩形 → 汇报给主进程的 bounds；null = 应当 detach。
 *
 * 取整方式：x / y 四舍五入，宽高用「取整后的右 / 下边」减「取整后的左 / 上边」——
 * 各自 round(width) 会让右边缘与布局差 1px、拖分栏时视图边缘一抖一抖；这样视图边缘永远贴在相邻元素的像素边界上。
 * visible 由调用方判（元素是否连着文档、祖先是否 display:none），这里只认结论。
 */
export const computeViewportBounds = (rect: RectLike, visible: boolean): Bounds | null => {
  if (!visible) return null;
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.right) ||
    !Number.isFinite(rect.bottom)
  ) {
    return null;
  }
  const x = Math.round(rect.left);
  const y = Math.round(rect.top);
  const width = Math.round(rect.right) - x;
  const height = Math.round(rect.bottom) - y;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
};

export const boundsEqual = (a: Bounds | null, b: Bounds | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
};

/**
 * 元素当前是否「渲染可见」：连着文档且有布局盒（祖先 display:none / hidden 属性时 getClientRects 为空）。
 * 浏览器里才有 DOM；node 测试不会调到它。
 */
export const isElementRendered = (el: Element | null | undefined): boolean => {
  if (!el || !el.isConnected) return false;
  if (el.getClientRects().length === 0) return false;
  const win = el.ownerDocument.defaultView;
  if (win && win.getComputedStyle(el).visibility === "hidden") return false;
  return true;
};

export interface FrameThrottle {
  /** 本帧还没排过就排一次；同一帧内多次调用只执行一次 */
  schedule: () => void;
  /** 取消已排的，立刻执行一次（ResizeObserver 回调里用：它本身就是每帧最多一次，再等下一帧只会更慢） */
  flush: () => void;
  cancel: () => void;
}

/**
 * rAF 节流：拖分栏 / 缩放时事件远多于帧数，一帧只汇报一次。
 * raf / caf 可注入，便于在 node 里用假时钟测。
 */
export const createFrameThrottle = (
  fn: () => void,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id),
): FrameThrottle => {
  let pending: number | null = null;
  const run = () => {
    pending = null;
    fn();
  };
  return {
    schedule: () => {
      if (pending !== null) return;
      pending = raf(run);
    },
    flush: () => {
      if (pending !== null) {
        caf(pending);
        pending = null;
      }
      fn();
    },
    cancel: () => {
      if (pending !== null) {
        caf(pending);
        pending = null;
      }
    },
  };
};
