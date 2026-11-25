/**
 * 截图的像素统计（纯函数，不依赖 electron / koffi）。
 *
 * capture-guard.mjs 靠它回答一个问题：「遮罩盖着的时候，截到的这张图是真实屏幕，还是被遮罩 / 一片黑盖住了」。
 * 三个量，一次遍历位图量出来：
 *   - overlayRatio：像遮罩底色（深蓝）的像素占比——遮罩被原样截进画面时整张图几乎都是它；
 *   - blackRatio：  近乎纯黑的像素占比——macOS 27 上实测：带 setContentProtection 的遮罩盖着时，ScreenCaptureKit 把整个屏幕
 *                  截成一片黑（只剩 Dock 的图标），遮罩色占比是 0%，只认遮罩色的判断会把它当成「正常画面」放行；
 *   - sig：         一份很小的颜色指纹（48×27 个采样点），用来比「带遮罩截的」和「撤了遮罩截的」是不是同一个屏幕——
 *                  这是对照真实屏幕的判断，不依赖「遮罩应该是什么颜色」的猜测。
 */
import { OVERLAY_RGB } from "./overlay.mjs";

/**
 * 「像遮罩底色」每个通道允许的偏差：色彩管理 / 缩放会带来几个单位的偏差；
 * 取 12 是为了不把常见的深色界面（#1e1e1e 之类的深灰，和遮罩底色差 19 以上）误认成遮罩。
 */
export const OVERLAY_COLOR_TOLERANCE = 12;
/** 「近乎纯黑」：三个通道都不超过它（实测被遮罩截黑的画面里黑点是 0~6） */
export const BLACK_MAX_CHANNEL = 8;
/** 比例抽样点数的目标值：够判断「整张图是不是一片遮罩色 / 黑」，又不拖慢截图 */
const RATIO_SAMPLE_TARGET = 20_000;

/** 指纹的采样网格 */
export const SIG_COLS = 48;
export const SIG_ROWS = 27;
/** 两张图对应采样点「差得明显」的门槛（任一通道差超过它） */
export const SIG_BIG_DIFF = 40;
/** 判定「是同一个屏幕」：平均差不超过它，且差得明显的点不超过它 */
export const SIG_SAME_MEAN_ABS = 5;
export const SIG_SAME_FRAC_BIG = 0.04;

/**
 * @param {{ getSize?: () => { width: number, height: number }, toBitmap?: () => Buffer | Uint8Array } | null | undefined} img
 * @returns {{ overlayRatio: number, blackRatio: number, sig: Uint8Array } | null} 读不到像素时 null（调用方按「无法判断」处理）
 */
export const measureImage = (img) => {
  let size;
  let bmp;
  try {
    if (typeof img?.toBitmap !== "function" || typeof img?.getSize !== "function") return null;
    size = img.getSize();
    bmp = img.toBitmap();
  } catch {
    return null;
  }
  const w = Math.floor(Number(size?.width));
  const h = Math.floor(Number(size?.height));
  if (!bmp || !(w > 0) || !(h > 0) || bmp.length < w * h * 4) return null;

  // 比例：位图字节序是平台相关的（macOS 是 BGRA）。遮罩色两种顺序都量、取大的——只会让「像遮罩」更容易成立，
  // 代价只是偶尔多截一张对照图，不会漏掉真被截进来的遮罩；黑色与顺序无关。
  const [r0, g0, b0] = OVERLAY_RGB;
  const tol = OVERLAY_COLOR_TOLERANCE;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / RATIO_SAMPLE_TARGET)));
  let total = 0;
  let nearBgra = 0;
  let nearRgba = 0;
  let black = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const p0 = bmp[i];
      const p1 = bmp[i + 1];
      const p2 = bmp[i + 2];
      total += 1;
      if (Math.abs(p2 - r0) <= tol && Math.abs(p1 - g0) <= tol && Math.abs(p0 - b0) <= tol) nearBgra += 1;
      if (Math.abs(p0 - r0) <= tol && Math.abs(p1 - g0) <= tol && Math.abs(p2 - b0) <= tol) nearRgba += 1;
      if (p0 <= BLACK_MAX_CHANNEL && p1 <= BLACK_MAX_CHANNEL && p2 <= BLACK_MAX_CHANNEL) black += 1;
    }
  }
  if (total === 0) return null;

  // 指纹：网格每格中心取一个点（统一成 R、G、B 顺序；两张图用同一种顺序，比的时候顺序无所谓）
  const sig = new Uint8Array(SIG_COLS * SIG_ROWS * 3);
  let k = 0;
  for (let gy = 0; gy < SIG_ROWS; gy += 1) {
    const y = Math.min(h - 1, Math.floor(((gy + 0.5) * h) / SIG_ROWS));
    for (let gx = 0; gx < SIG_COLS; gx += 1) {
      const x = Math.min(w - 1, Math.floor(((gx + 0.5) * w) / SIG_COLS));
      const i = (y * w + x) * 4;
      sig[k++] = bmp[i + 2];
      sig[k++] = bmp[i + 1];
      sig[k++] = bmp[i];
    }
  }
  return { overlayRatio: Math.max(nearBgra, nearRgba) / total, blackRatio: black / total, sig };
};

/**
 * 两份指纹的差异。长度不一致 / 不是数组 / 空 → null（比不了，调用方退回只看颜色比例的判断）。
 * @param {ArrayLike<number> | null | undefined} a
 * @param {ArrayLike<number> | null | undefined} b
 * @returns {{ meanAbs: number, fracBig: number } | null}
 */
export const signatureDistance = (a, b) => {
  if (!a || !b || typeof a.length !== "number" || typeof b.length !== "number") return null;
  const n = a.length;
  if (n === 0 || n !== b.length || n % 3 !== 0) return null;
  let sum = 0;
  let big = 0;
  for (let i = 0; i < n; i += 3) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    sum += dr + dg + db;
    if (Math.max(dr, dg, db) > SIG_BIG_DIFF) big += 1;
  }
  return { meanAbs: sum / n, fracBig: big / (n / 3) };
};

/** 差异小到可以认为是同一个屏幕（静态桌面上两次截图只差光标闪烁 / 时钟这类零星变化） */
export const isSameScreen = (dist) =>
  dist !== null && dist !== undefined && dist.meanAbs <= SIG_SAME_MEAN_ABS && dist.fracBig <= SIG_SAME_FRAC_BIG;
