/**
 * 截图像素坐标 ⇄ 输入坐标的换算（纯函数）。
 *
 * 为什么只用「线性映射」而不去算 Retina / DPI 缩放系数：
 * 每张截图都记下「它对应输入坐标系里的哪个矩形（rect）」和「它自己的像素宽高」，
 * 模型在截图上给出的像素坐标按比例映射回 rect 即可——缩放系数、截图被缩小多少都不用知道，
 * 也就不会因为某个平台 / 某块显示器的缩放规则不一样而点偏。
 */
import { DesktopError } from "./types.mjs";

/**
 * @typedef {{ imageWidth: number, imageHeight: number, rect: { x: number, y: number, width: number, height: number } }} ScreenshotFrame
 */

const bad = (message) => new DesktopError("BAD_ARGS", message);

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * 按最大宽度等比缩小（不放大）。返回目标像素尺寸。
 * @param {number} width 原始像素宽
 * @param {number} height 原始像素高
 * @param {number} maxWidth 目标最大宽度
 */
export const fitToWidth = (width, height, maxWidth) => {
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    throw bad("截图尺寸无效");
  }
  if (!isFiniteNumber(maxWidth) || maxWidth <= 0 || width <= maxWidth) return { width: Math.round(width), height: Math.round(height) };
  const ratio = maxWidth / width;
  return { width: Math.round(maxWidth), height: Math.max(1, Math.round(height * ratio)) };
};

/**
 * 截图里的像素坐标 → 输入坐标。越界直接报错（不静默夹到边缘：点到意外位置比报错更糟）。
 * @param {{ x: number, y: number }} point 截图里的像素坐标，左上原点
 * @param {ScreenshotFrame} frame
 * @returns {{ x: number, y: number }} 整数输入坐标
 */
export const imageToInput = (point, frame) => {
  const { imageWidth, imageHeight, rect } = frame;
  if (!isFiniteNumber(point?.x) || !isFiniteNumber(point?.y)) throw bad("坐标必须是数字（x、y 是截图里的像素位置）");
  if (point.x < 0 || point.y < 0 || point.x > imageWidth || point.y > imageHeight) {
    throw bad(`坐标 (${Math.round(point.x)}, ${Math.round(point.y)}) 超出了截图范围 ${imageWidth}×${imageHeight}。x 在 0–${imageWidth}、y 在 0–${imageHeight}，以最近一张截图为准`);
  }
  // 截图右 / 下边缘（x == imageWidth、或四舍五入后）按公式会落在主屏外 1 个单位——多显示器时那是相邻屏幕的第一个像素。
  // 越界依然报错（上面），但边缘本身是合法位置：夹在主屏最后一个单位内
  return {
    x: Math.min(rect.x + rect.width - 1, Math.round(rect.x + (point.x * rect.width) / imageWidth)),
    y: Math.min(rect.y + rect.height - 1, Math.round(rect.y + (point.y * rect.height) / imageHeight)),
  };
};