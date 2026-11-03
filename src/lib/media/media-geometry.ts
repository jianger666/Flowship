/**
 * 悬浮播放窗的几何计算（纯函数）：默认大小 / 夹进视口 / 拖拽 / 缩放。
 *
 * 窗口 = 顶栏 + 画面区 + 控制区。画面区是弹性的（视频 object-contain），所以这里只管外框，
 * 不要求外框和视频比例严格一致——比例对不上就留黑边，不会变形。
 */

import type { DockGeometry } from "@/lib/media/media-memory";
import type { MediaKind } from "@/lib/media/media-kind";
import { clampNumber } from "@/lib/media/media-time";

export interface Viewport {
  width: number;
  height: number;
}

export const DOCK_MARGIN = 16;
export const DOCK_MIN_W = 300;
export const DOCK_MIN_H = 200;
/** 顶栏 + 控制区大致高度：算默认外框时给画面区让出来 */
export const DOCK_CHROME_H = 200;
/** 迷你条（收起态）固定尺寸 */
export const MINI_W = 340;
export const MINI_H = 52;

/** 把外框夹进视口（四边各留 margin）；视口小于最小尺寸时以视口为准 */
export const clampGeometry = (g: DockGeometry, vp: Viewport): DockGeometry => {
  const maxW = Math.max(120, vp.width - DOCK_MARGIN * 2);
  const maxH = Math.max(80, vp.height - DOCK_MARGIN * 2);
  const w = clampNumber(g.w, Math.min(DOCK_MIN_W, maxW), maxW);
  const h = clampNumber(g.h, Math.min(DOCK_MIN_H, maxH), maxH);
  const x = clampNumber(g.x, DOCK_MARGIN, Math.max(DOCK_MARGIN, vp.width - w - DOCK_MARGIN));
  const y = clampNumber(g.y, DOCK_MARGIN, Math.max(DOCK_MARGIN, vp.height - h - DOCK_MARGIN));
  return { x, y, w, h };
};

/**
 * 默认外框：贴右下角。
 * - 音频：横条（波形 + 控制），不吃高度
 * - 竖屏视频：窄而高（9:16 的成片在窄窗里也够看）
 * - 横屏视频：宽一些
 * `aspect` = 宽 / 高；未知（还没读到元数据）按 16:9。
 */
export const defaultGeometry = (
  kind: MediaKind,
  aspect: number | null,
  vp: Viewport,
): DockGeometry => {
  const ratio = aspect && Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  let w: number;
  let h: number;
  if (kind === "audio") {
    w = 440;
    h = 330;
  } else if (ratio < 1) {
    h = Math.min(vp.height - DOCK_MARGIN * 2, 720);
    w = Math.max(DOCK_MIN_W, Math.round((h - DOCK_CHROME_H) * ratio));
  } else {
    w = Math.min(560, Math.max(DOCK_MIN_W, vp.width - DOCK_MARGIN * 2));
    h = Math.round(w / ratio) + DOCK_CHROME_H;
  }
  return clampGeometry(
    { x: vp.width - w - DOCK_MARGIN, y: vp.height - h - DOCK_MARGIN, w, h },
    vp,
  );
};

/** 拖动：整体平移，夹进视口 */
export const moveGeometry = (
  g: DockGeometry,
  dx: number,
  dy: number,
  vp: Viewport,
): DockGeometry => clampGeometry({ ...g, x: g.x + dx, y: g.y + dy }, vp);

export type ResizeEdge = "right" | "bottom" | "corner" | "left" | "top" | "tl" | "tr" | "bl";

/**
 * 缩放：拖右 / 下 / 右下角改宽高（左上角不动）；拖左 / 上 / 左上等同时挪位置保持对边不动。
 * 结果夹进视口并保证不小于最小尺寸。
 *
 * 越界要在这里先把被拖的那一边停在视口边距上：只交给 {@link clampGeometry} 收尾的话，
 * 它是靠挪 x / y 来塞进视口的——向右拖出视口会把左边缘推向左，向左拖出视口会让右边缘向右跑，
 * 「对边不动」就破了（悬浮窗默认贴右下角，向右 / 向下拖是最常见的操作）。
 */
export const resizeGeometry = (
  g: DockGeometry,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  vp: Viewport,
): DockGeometry => {
  let { x, y, w, h } = g;
  const right = x + w;
  const bottom = y + h;
  const dragRight = edge === "right" || edge === "corner" || edge === "tr";
  const dragBottom = edge === "bottom" || edge === "corner" || edge === "bl";
  const dragLeft = edge === "left" || edge === "tl" || edge === "bl";
  const dragTop = edge === "top" || edge === "tl" || edge === "tr";
  if (dragRight) w = g.w + dx;
  if (dragBottom) h = g.h + dy;
  if (dragLeft) w = g.w - dx;
  if (dragTop) h = g.h - dy;
  // 被拖的边最远只能到视口边距；没被拖的方向不设上限（交给 clampGeometry 兜底）
  const maxW = dragRight ? vp.width - DOCK_MARGIN - x : dragLeft ? right - DOCK_MARGIN : Infinity;
  const maxH = dragBottom ? vp.height - DOCK_MARGIN - y : dragTop ? bottom - DOCK_MARGIN : Infinity;
  w = Math.max(Math.min(DOCK_MIN_W, vp.width - DOCK_MARGIN * 2), Math.min(w, maxW));
  h = Math.max(Math.min(DOCK_MIN_H, vp.height - DOCK_MARGIN * 2), Math.min(h, maxH));
  if (dragLeft) x = right - w;
  if (dragTop) y = bottom - h;
  return clampGeometry({ x, y, w, h }, vp);
};
