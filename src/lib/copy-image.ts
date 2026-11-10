/**
 * 把一张图复制到系统剪贴板（图片灯箱的右键「复制图片」、文件预览窗里图片查看器的按钮 / 右键 / ⌘C 用）。
 *
 * - 剪贴板只稳定支持 `image/png`：不管原图是 jpeg / webp / gif / data URL，统一经 canvas 重编码成 PNG。
 *   复制的是**原图**（按图片自己的像素尺寸画，透明通道保留），不含查看器里的缩放 / 平移 / 旋转 / 翻转；
 *   **动图（GIF / 动画 WebP）只取第一帧**——`drawImage` 画的就是当前帧、剪贴板里也放不下动画。
 * - 用 `<img>` 加载再画，不用 `fetch`：fetch 归 CSP 的 connect-src 管，`data:` / `blob:` 过不去；
 *   `<img>` 走 img-src，贴图预览的 data URL、站内 `/api/...` 图都放行。
 * - 外站图片（用户点了「加载远程图片」之后）没有 CORS 头时画布会被污染、导不出像素——这种拿不到数据，
 *   如实报「不允许复制」，不假装成功。
 *
 * - SVG 这类矢量图没有「像素尺寸」：`<img>` 可能报 0×0（缺 width / height），或只有 24×24 这种图标尺寸——
 *   直接按它画出来要么复制失败、要么糊成一个点。调用方可以传 `fallbackSize`（查看器显示用的那个兜底尺寸）
 *   与 `vector: true`，见 `resolveRasterSize`。位图（`vector` 不传）的行为不受影响。
 *
 * 失败一律抛带中文文案的 Error，调用方直接 toast。
 */

export interface CopyImageOptions {
  /** 图片没有固有尺寸（`naturalWidth/Height` 为 0，如缺 width / height / viewBox 的 SVG）时，按这个尺寸栅格化 */
  fallbackSize?: { w: number; h: number };
  /**
   * 矢量图（SVG）：栅格化尺寸的长边落进 [1024, 4096]（等比缩放）——小图标放大后再画才清晰，
   * 超大 SVG 也不会撑爆 canvas 的安全范围。位图不要传（位图放大只会糊、缩小丢信息）。
   */
  vector?: boolean;
}

/** 矢量图栅格化的长边下限 / 上限（px） */
export const VECTOR_MIN_LONG_EDGE = 1024;
export const VECTOR_MAX_LONG_EDGE = 4096;

const isUsableSize = (s: { w: number; h: number } | undefined): s is { w: number; h: number } =>
  !!s && Number.isFinite(s.w) && Number.isFinite(s.h) && s.w > 0 && s.h > 0;

/**
 * 决定 canvas 的像素尺寸（纯函数，单测直接测）：
 * 1. 图片自己有固有尺寸就用它；没有（0×0）就用 `fallbackSize`；两者都没有 → null（调用方报「读不到图片尺寸」）；
 * 2. `vector` 时把长边夹进 [VECTOR_MIN_LONG_EDGE, VECTOR_MAX_LONG_EDGE]，短边按比例跟随；位图原样；
 * 3. 取整且每边至少 1px（极端长宽比下不会出现 0）。
 */
export const resolveRasterSize = (
  natural: { w: number; h: number },
  opts: CopyImageOptions = {},
): { w: number; h: number } | null => {
  const base = isUsableSize(natural) ? natural : isUsableSize(opts.fallbackSize) ? opts.fallbackSize : null;
  if (!base) return null;
  let { w, h } = base;
  if (opts.vector) {
    const long = Math.max(w, h);
    const scale =
      long < VECTOR_MIN_LONG_EDGE ? VECTOR_MIN_LONG_EDGE / long : long > VECTOR_MAX_LONG_EDGE ? VECTOR_MAX_LONG_EDGE / long : 1;
    w *= scale;
    h *= scale;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
};

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    // 同源 / data: 不受影响；外站图要有 CORS 头才能读像素，没有就在 onerror 里落到下面的文案
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片没能加载出来，复制失败（外站图片可能不允许复制）"));
    img.src = src;
  });

const toPngBlob = (img: HTMLImageElement, opts: CopyImageOptions): Promise<Blob> => {
  const size = resolveRasterSize({ w: img.naturalWidth, h: img.naturalHeight }, opts);
  if (!size) return Promise.reject(new Error("读不到图片尺寸，复制失败"));
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("当前环境不支持复制图片"));
  // 显式给目标尺寸：位图时等于原尺寸（与以前的 drawImage(img, 0, 0) 同效）；矢量图时 Chromium 按目标尺寸重新栅格化，放大后依然清晰
  ctx.drawImage(img, 0, 0, size.w, size.h);
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("图片转换失败，复制失败"));
      }, "image/png");
    } catch {
      // 画布被污染（外站图无 CORS）时 toBlob 同步抛 SecurityError
      reject(new Error("这张图来自外部站点，浏览器不允许复制"));
    }
  });
};

/** 当前环境能不能往剪贴板写图片 */
export const canCopyImage = (): boolean =>
  typeof ClipboardItem !== "undefined" &&
  typeof navigator !== "undefined" &&
  typeof navigator.clipboard?.write === "function";

/** 把 `src` 指向的图复制到剪贴板（PNG）。失败抛带中文文案的 Error */
export const copyImageToClipboard = async (src: string, opts: CopyImageOptions = {}): Promise<void> => {
  if (!canCopyImage()) throw new Error("当前环境不支持复制图片");
  const img = await loadImage(src);
  const blob = await toPngBlob(img, opts);
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch {
    throw new Error("写入剪贴板失败（可能没有剪贴板权限）");
  }
};
