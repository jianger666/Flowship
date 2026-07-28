/**
 * 耗时文案格式化（事件流单一来源）
 *
 * 事件流里有两种耗时口径、以前各写各的（工具块一份、工作过程组头一份）：
 *   - 单步耗时（工具执行 / 一段思考）：要毫秒精度，快的一步也得看得出快
 *   - 聚合耗时（工作过程组头）：秒级密度就够，别用小数点抢组头的注意力
 * 两种都收在这里，改口径只动这一个文件。
 */

/** 有限非负数才算有效耗时；脏 meta（字符串 / NaN / 负数）一律当没有 */
const isValidMs = (ms: unknown): ms is number =>
  typeof ms === "number" && Number.isFinite(ms) && ms >= 0;

/**
 * 单步耗时：`820ms` / `12.3s` / `2m14s`。
 * 无效值返 null（调用方 `dur && <span>` 直接不渲染）。
 */
export const formatDurationPrecise = (ms: unknown): string | null => {
  if (!isValidMs(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
};

/**
 * 聚合耗时：`12s` / `2m14s`。
 * 同秒完成（< 1s）返 null——组头不显示「0s」这种没信息量的噪声。
 */
export const formatDurationCoarse = (ms: unknown): string | null => {
  if (!isValidMs(ms)) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 1) return null;
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
};
