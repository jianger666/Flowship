/**
 * 图片查看器的缩放 / 平移数学（纯函数）
 *
 * 变换模型：元素以容器中心为原点，先 translate(x,y) 再 scale(s) 再 rotate；
 * 滚轮 / 双击缩放以**指针位置**为锚点——缩放前后指针下的图像点保持不动。
 */

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 32;

export interface View {
  scale: number;
  x: number;
  y: number;
}

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** 刚好放进容器的缩放比（不放大超过原尺寸 1 倍：小图不糊成一片） */
export const fitScale = (
  natural: { w: number; h: number },
  box: { w: number; h: number },
  rotation: number,
  maxFit = 1,
): number => {
  if (natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return 1;
  const swapped = Math.abs(rotation % 180) === 90;
  const w = swapped ? natural.h : natural.w;
  const h = swapped ? natural.w : natural.h;
  return Math.min(maxFit, Math.min(box.w / w, box.h / h));
};

/**
 * 以 (px,py)（相对容器中心的指针坐标）为锚点缩放到 nextScale。
 * 图像点 p 在屏幕上的位置 = x + p*scale；要求缩放前后同一个 p 的屏幕位置不变：
 * x' = px - (px - x) * (nextScale / scale)
 */
export const zoomAt = (view: View, nextScaleRaw: number, px: number, py: number): View => {
  const nextScale = clampScale(nextScaleRaw);
  const k = nextScale / view.scale;
  return { scale: nextScale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
};

/** 滚轮增量 → 缩放倍率（指数映射，触控板的小增量与鼠标滚轮的大增量都平滑） */
export const wheelFactor = (deltaY: number): number => Math.exp(-deltaY * 0.0015);

export const rotateBy = (rotation: number, delta: 90 | -90): number =>
  (((rotation + delta) % 360) + 360) % 360;
