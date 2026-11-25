/**
 * 锁屏后台档的截图封装：把驱动 capture() 合成出来的主屏大小 BGRA 位图压成 JPEG，
 * 并给出和 screenshot.mjs 完全同形状的 { jpeg, frame }——manager 的坐标换算（imageToInput）、
 * 截图世代校验、server 的展示逻辑，真实屏幕和后台合成两种来源共用一套。
 *
 * 为什么单独一个文件：驱动（win32-background.mjs）只管系统调用、不依赖 electron；压缩 / 缩放要用 Electron 的 nativeImage，
 * 放在这一层，驱动在 Mac 上就能用假对象整条单测。
 *
 * 窗口摘要（windows）：驱动报告的窗口位置是输入坐标（屏幕物理像素），AI 看的是缩放后的截图，
 * 所以这里统一换成「截图里的像素位置」并裁到截图范围内——AI 能直接拿它对照画面，也能直接当 desktop_click 的坐标参考。
 */
import { fitToWidth } from "./coords.mjs";
import { SCREENSHOT_DEFAULTS } from "./screenshot.mjs";
import { DesktopError } from "./types.mjs";

/**
 * 窗口位置（输入坐标）→ 截图像素坐标，裁到 [0, imageWidth] × [0, imageHeight]；裁完没有面积的丢掉。纯函数。
 * @param {Array<Record<string, any>>} windows
 * @param {{ x: number, y: number, width: number, height: number }} rect  截图对应的输入坐标矩形（主屏）
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @returns {Array<Record<string, any>>}
 */
export const mapWindowsToImage = (windows, rect, imageWidth, imageHeight) => {
  if (!Array.isArray(windows) || rect.width <= 0 || rect.height <= 0) return [];
  const sx = imageWidth / rect.width;
  const sy = imageHeight / rect.height;
  const out = [];
  for (const w of windows) {
    const left = Math.max(0, Math.round((w.x - rect.x) * sx));
    const top = Math.max(0, Math.round((w.y - rect.y) * sy));
    const right = Math.min(imageWidth, Math.round((w.x + w.width - rect.x) * sx));
    const bottom = Math.min(imageHeight, Math.round((w.y + w.height - rect.y) * sy));
    if (right <= left || bottom <= top) continue;
    out.push({ ...w, x: left, y: top, width: right - left, height: bottom - top });
  }
  return out;
};

/**
 * @param {{
 *   background: { capture: () => Promise<{ width: number, height: number, bgra: Buffer, windows?: Array<Record<string, any>> }> },
 *   driver: { getPrimaryDisplay: () => { x: number, y: number, width: number, height: number } },
 *   nativeImage: { createFromBitmap: (buf: Buffer, opts: { width: number, height: number }) => any },
 *   maxWidth?: number,
 *   quality?: number,
 *   maxBytes?: number,
 *   log?: (msg: string) => void,
 * }} deps
 */
export const createBackgroundShotter = (deps) => {
  const { background, driver, nativeImage, log = () => {} } = deps;
  const maxWidth = deps.maxWidth ?? SCREENSHOT_DEFAULTS.maxWidth;
  const quality = deps.quality ?? SCREENSHOT_DEFAULTS.quality;
  const maxBytes = deps.maxBytes ?? SCREENSHOT_DEFAULTS.maxBytes;

  /**
   * @returns {Promise<{ jpeg: Buffer, frame: { imageWidth: number, imageHeight: number, rect: { x: number, y: number, width: number, height: number } }, windows: Array<Record<string, any>> }>}
   */
  const capture = async () => {
    let raw;
    try {
      raw = await background.capture();
    } catch (err) {
      if (err instanceof DesktopError) throw err;
      log(`[desktop-background-shot] 合成截图失败：${err?.message || err}`);
      throw new DesktopError("INTERNAL", `锁屏后台截图失败：${String(err?.message || err).slice(0, 160)}。可以重试一次；仍失败请在设置的「电脑操作」里点「测试后台操作」或导出诊断信息`);
    }
    const rect = driver.getPrimaryDisplay();
    if (!raw || raw.width !== rect.width || raw.height !== rect.height || !Buffer.isBuffer(raw.bgra) || raw.bgra.length < raw.width * raw.height * 4) {
      throw new DesktopError("INTERNAL", "屏幕尺寸在截图过程中变了（或拿到的画面不完整），请重试一次");
    }
    const target = fitToWidth(raw.width, raw.height, maxWidth);
    let img;
    try {
      img = nativeImage.createFromBitmap(raw.bgra, { width: raw.width, height: raw.height });
      if (!img || img.isEmpty()) throw new Error("空画面");
      if (target.width !== raw.width) img = img.resize({ width: target.width, height: target.height, quality: "good" });
    } catch (err) {
      log(`[desktop-background-shot] 位图转图片失败：${err?.message || err}`);
      throw new DesktopError("INTERNAL", "锁屏后台截图失败（位图转图片出错）。可以重试一次");
    }

    let jpeg = img.toJPEG(quality);
    for (let q = quality - 15; jpeg.length > maxBytes && q >= 40; q -= 15) jpeg = img.toJPEG(q);
    if (jpeg.length > maxBytes) {
      const size = img.getSize();
      img = img.resize({ width: Math.max(320, Math.round(size.width * 0.75)) });
      jpeg = img.toJPEG(50);
    }
    const size = img.getSize();
    return {
      jpeg,
      frame: { imageWidth: size.width, imageHeight: size.height, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } },
      windows: mapWindowsToImage(raw.windows ?? [], rect, size.width, size.height),
    };
  };

  return { capture };
};
