/**
 * 大体量输出的字节上限（R1-29）：fullPage 的 png / pdf 在超长页面上可以生成几十到几百 MB 的 base64，
 * 一路经 CDP → 主进程 Buffer → nativeImage 解码 → IPC → server → 落盘，每一层都会被拖垮。
 * 纯函数、无 Electron 依赖，由 tab.screenshot（fullPage png）与 ops/read.mjs 的 printPdf 在**拿到 base64 之后、解码之前**调用。
 */
import { BrowserError } from "./server-channel.mjs";

/** fullPage 截图（png / jpeg 均适用）解码后的字节上限 */
export const FULLPAGE_SHOT_MAX_BYTES = 30 * 1024 * 1024;
/** PDF 解码后的字节上限 */
export const PDF_MAX_BYTES = 30 * 1024 * 1024;

/** base64 串解码后的字节数（不真正解码，避免先分配几百 MB 再判断） */
export const base64DecodedBytes = (b64) => {
  if (typeof b64 !== "string" || b64.length === 0) return 0;
  let pad = 0;
  if (b64.endsWith("==")) pad = 2;
  else if (b64.endsWith("=")) pad = 1;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
};

/**
 * 超过上限就抛 BAD_ARGS，文案写明被拒原因与替代做法（模型能据此自修复）；未超返回解码后字节数。
 * @param {string} b64 CDP 返回的 base64 数据
 * @param {number} maxBytes
 * @param {string} what 「fullPage 截图」/「PDF」
 * @param {string} hint 替代做法
 */
export const assertBase64WithinCap = (b64, maxBytes, what, hint) => assertBytesWithinCap(base64DecodedBytes(b64), maxBytes, what, hint);

/**
 * 同上，但入参已经是字节数（拿到的本来就是 Buffer 的路径，如 `webContents.printToPDF` 的回退）。
 * @param {number} bytes
 */
export const assertBytesWithinCap = (bytes, maxBytes, what, hint) => {
  if (bytes > maxBytes) {
    throw new BrowserError(
      "BAD_ARGS",
      `${what}体积 ${(bytes / 1024 / 1024).toFixed(1)}MB，超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，已放弃（不会返回被截断的半截文件）。${hint}`,
    );
  }
  return bytes;
};

export const FULLPAGE_SHOT_HINT = "页面太长：请改用视口截图（fullPage:false），或给 ref 只截某个元素，或先 scroll 到目标区域再截";
export const PDF_HINT = "页面太长：请改存 html（kind:html）或 read 读正文；或先导航 / 滚动到只含目标内容的页面再存";
