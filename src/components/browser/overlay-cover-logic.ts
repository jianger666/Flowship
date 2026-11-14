/**
 * 浮层遮盖判定（纯函数）
 *
 * 为什么需要：浏览器视图是原生 WebContentsView，永远盖在 HTML 之上——Flowship 自己的弹窗 / 下拉 /
 * 命令面板 / toast 只要和视口矩形相交，就会被原生视图挡在下面（契约 §2.2）。
 * 解法是浮层出现时让主进程截图并隐藏视图、UI 在占位 div 里画那张截图。
 * 这里只放「给定矩形该不该遮盖、什么时候切换」的判定，DOM 扫描与定时器在 use-overlay-cover.ts。
 */

export interface OverlayRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface OverlayItem {
  rect: OverlayRect;
  /**
   * 瞬时浮层（tooltip / toast）：很可能几百毫秒内就消失，遮盖前要先「站稳」一会儿，
   * 否则鼠标扫过去每个 tooltip 都会让浏览器画面闪一下（截图 + 隐藏 + 再显示）。
   */
  transient: boolean;
}

/** 两个矩形是否有正面积的重叠（只是边挨着不算；< 0.5px 的亚像素重叠当没有，免得布局舍入引发误判） */
export const rectsIntersect = (a: OverlayRect, b: OverlayRect): boolean => {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0.5 && h > 0.5;
};

const isEmptyRect = (r: OverlayRect): boolean =>
  !(Number.isFinite(r.left) && Number.isFinite(r.top) && Number.isFinite(r.right) && Number.isFinite(r.bottom)) ||
  r.right - r.left <= 0 ||
  r.bottom - r.top <= 0;

/**
 * - none：没有任何浮层与视口相交，不用遮盖
 * - transient：只有瞬时浮层相交
 * - hard：至少一个常驻浮层（dialog / sheet / 菜单 / popover / 命令面板…）相交，必须立刻遮盖
 */
export type CoverNeed = "none" | "transient" | "hard";

export const classifyCover = (overlays: readonly OverlayItem[], viewport: OverlayRect): CoverNeed => {
  if (isEmptyRect(viewport)) return "none";
  let need: CoverNeed = "none";
  for (const o of overlays) {
    if (isEmptyRect(o.rect)) continue;
    if (!rectsIntersect(o.rect, viewport)) continue;
    if (!o.transient) return "hard";
    need = "transient";
  }
  return need;
};

/** 「是否需要遮盖」的布尔版：任一浮层与视口相交即 true（不区分瞬时 / 常驻） */
export const shouldCover = (overlays: readonly OverlayItem[], viewport: OverlayRect): boolean =>
  classifyCover(overlays, viewport) !== "none";

/** 瞬时浮层要连续存在这么久才遮盖（ms）：tooltip 默认 300ms 才出现、hover 扫过的不该触发截图 */
export const TRANSIENT_COVER_DELAY_MS = 300;
/** 浮层全部消失后要「空」这么久才恢复显示（ms）：菜单关闭紧接着弹窗打开这类切换不闪 */
export const UNCOVER_DELAY_MS = 150;

export type CoverAction = "cover" | "uncover" | "none";

/**
 * 状态机的一步：当前是否已遮盖 + 当前需求已持续多久 → 要不要切换。
 * 调用方在需求变化时重置计时，并在 `nextCheckInMs` 之后再评估一次（需求没变就不会有新的 DOM 事件，得自己定时回来）。
 */
export const decideCoverAction = (input: {
  covered: boolean;
  need: CoverNeed;
  /** 当前 need 已经连续持续的毫秒数 */
  heldMs: number;
}): { action: CoverAction; nextCheckInMs: number | null } => {
  const { covered, need, heldMs } = input;
  if (need === "hard") {
    return covered ? { action: "none", nextCheckInMs: null } : { action: "cover", nextCheckInMs: null };
  }
  if (need === "transient") {
    // 已经遮着（常驻浮层刚关、紧接着有 tooltip）就保持，不必再等
    if (covered) return { action: "none", nextCheckInMs: null };
    if (heldMs >= TRANSIENT_COVER_DELAY_MS) return { action: "cover", nextCheckInMs: null };
    return { action: "none", nextCheckInMs: TRANSIENT_COVER_DELAY_MS - heldMs };
  }
  // need === "none"
  if (!covered) return { action: "none", nextCheckInMs: null };
  if (heldMs >= UNCOVER_DELAY_MS) return { action: "uncover", nextCheckInMs: null };
  return { action: "none", nextCheckInMs: UNCOVER_DELAY_MS - heldMs };
};

/**
 * 常驻浮层的选择器：按 src/components/ui/* 与 @base-ui/react 的 portal 约定整理，
 * 浮层都 Portal 到 <body>，带 role 或 data-slot：
 *  - dialog / alert-dialog / sheet：popup 带 role="dialog" / "alertdialog"，另有满屏的 `*-overlay` 背景层；
 *  - dropdown-menu / context-menu：role="menu"；select：role="listbox"；popover：data-slot="popover-content"；
 *  - 自写的图片灯箱 role="dialog"；「再聊聊」角落停靠窗 data-slot="dialog-docked-content"；
 *  - 音视频播放器悬浮窗 data-media-dock：fixed 定位的 role="region"（不是 dialog），不加这条它会被原生视图压住一块。
 *    它不在 <body> 直下、位置靠 style 变，所以开关 / 拖动 / 缩放要靠 lib/overlay-layout-event 主动通知评估。
 * 命令面板（Cmd+K）是 Dialog，同样被 role="dialog" 覆盖。
 */
export const HARD_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-slot="dialog-content"]',
  '[data-slot="dialog-docked-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="sheet-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="select-content"]',
  '[data-slot="popover-content"]',
  '[data-slot$="-overlay"]',
  "[data-media-dock]",
].join(",");

/**
 * 「正在关闭」的浮层不算：base-ui 关闭时先打 data-closed / data-ending-style、动画完才摘 DOM，
 * 这段时间它视觉上正在淡出，没必要为它继续遮着视图。
 */
export const CLOSING_SELECTOR = "[data-closed],[data-ending-style]";

/**
 * base-ui 的弹层（Positioner / Popup）打开时都有 data-open + data-side。
 * 命中了但不属于上面常驻浮层的 = tooltip，归入瞬时浮层。
 */
export const POPPER_SELECTOR = "[data-open][data-side]";

/** sonner 的 toast 条目；移除动画中带 data-removed="true"，叠在后面被折叠的带 data-visible="false" */
export const TOAST_SELECTOR =
  '[data-sonner-toast]:not([data-removed="true"]):not([data-visible="false"])';

/**
 * sonner 的容器 <section>（常驻；里面的 <ol> 只在有 toast 时才存在，所以观察 section 而不是 ol）。
 * aria-label 形如 "Notifications alt+T"。
 */
export const TOASTER_CONTAINER_SELECTOR = 'section[aria-label^="Notifications"]';

/** MutationObserver 只关心这些属性的变化（浮层开合都体现在它们上），别放行 style / class 这类每帧都变的 */
export const OVERLAY_ATTRIBUTE_FILTER = [
  "data-open",
  "data-closed",
  "data-side",
  "data-ending-style",
  "data-removed",
  "role",
  "hidden",
  "data-visible",
];
