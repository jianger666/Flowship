/**
 * 「浮层布局变了」通知（任何 DOM 浮层 → 内置浏览器的遮盖判定）
 *
 * 为什么需要：内置浏览器是原生 WebContentsView，永远盖在 HTML 之上，所以 Flowship 自己的浮层
 * 与浏览器视口相交时，use-overlay-cover 要把视图换成截图占位（见 browser/overlay-cover-logic）。
 * 它靠 MutationObserver 感知浮层开合，但只看 <body> 直接子节点 + 少数属性（data-open / role…）：
 *   - 不在 body 直下挂载的浮层（如挂在应用根部的音视频播放器）开 / 关时观察不到；
 *   - 浮层靠 style 挪位置 / 改尺寸（拖动、缩放、收成一条、全屏）时也观察不到（style 每帧都变、不能放行）。
 * 这类浮层在「出现 / 消失 / 位置或尺寸变化」时调 {@link notifyOverlayLayoutChanged}，
 * use-overlay-cover 收到后走自己的 50ms 去抖重新评估（只读 DOM、不写任何东西，高频调用也安全）。
 *
 * 放在 lib 而不是 components/browser：发信方（media 播放器）不该反向依赖浏览器模块。
 */

/** 事件名：window 上的无载荷 Event */
export const OVERLAY_LAYOUT_EVENT = "flowship:overlay-layout";

/** 通知遮盖判定重新评估一次。SSR / 无 window 环境静默跳过。 */
export const notifyOverlayLayoutChanged = (): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OVERLAY_LAYOUT_EVENT));
};
