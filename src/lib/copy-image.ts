/**
 * 把一张图复制到系统剪贴板（图片灯箱的右键「复制图片」用）。
 *
 * - 剪贴板只稳定支持 `image/png`：不管原图是 jpeg / webp / gif / data URL，统一经 canvas 重编码成 PNG
 *   （动图只取第一帧）。
 * - 用 `<img>` 加载再画，不用 `fetch`：fetch 归 CSP 的 connect-src 管，`data:` / `blob:` 过不去；
 *   `<img>` 走 img-src，贴图预览的 data URL、站内 `/api/...` 图都放行。
 * - 外站图片（用户点了「加载远程图片」之后）没有 CORS 头时画布会被污染、导不出像素——这种拿不到数据，
 *   如实报「不允许复制」，不假装成功。
 *
 * 失败一律抛带中文文案的 Error，调用方直接 toast。
 */

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    // 同源 / data: 不受影响；外站图要有 CORS 头才能读像素，没有就在 onerror 里落到下面的文案
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片没能加载出来，复制失败（外站图片可能不允许复制）"));
    img.src = src;
  });

const toPngBlob = (img: HTMLImageElement): Promise<Blob> => {
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) return Promise.reject(new Error("读不到图片尺寸，复制失败"));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("当前环境不支持复制图片"));
  ctx.drawImage(img, 0, 0);
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
export const copyImageToClipboard = async (src: string): Promise<void> => {
  if (!canCopyImage()) throw new Error("当前环境不支持复制图片");
  const img = await loadImage(src);
  const blob = await toPngBlob(img);
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch {
    throw new Error("写入剪贴板失败（可能没有剪贴板权限）");
  }
};
