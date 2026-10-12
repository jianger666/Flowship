/**
 * 「首次启动」判定（纯函数、无 electron 依赖，可被 vitest 直接单测）。
 *
 * 背景：Windows 上 server 冷启动慢，慢的是「第一次碰到这批文件」——杀软 / SmartScreen /
 * Defender 云查对未见过的 exe + 几百个 JS 文件逐个放行（实测冷启动到就绪要读 ~430 个文件，
 * 到首页可用累计 ~850 个）。第二次起这些判定被缓存、秒开。所以首次启动要多给时间。
 *
 * 旧实现的缺口：标记是**全局一次性**的（装过一次、跑通一次就永远「非首次」）。
 * 但每次更新装进来的都是全新的 Flowship.exe（未签名、哈希没信誉）+ 9.6k 个刚写盘的新文件，
 * 对杀软来说和全新安装没区别——更新后的第一次启动同样是冷的，却只拿到常规 60s。
 * 所以标记里记录「在哪个版本跑通过」，版本变了就重新按首次对待。
 */

/** 首次启动（全新安装 / 刚更新 / 刚重装）等 server 就绪的首轮上限。 */
export const FIRST_BOOT_TIMEOUT_MS = 150_000;

/** 常规启动的首轮上限（超时后 server 还活着会问用户是否继续等，不会直接判死刑）。 */
export const REGULAR_BOOT_TIMEOUT_MS = 60_000;

/** 标记文件内容：server 就绪后写，带上跑通时的版本号。 */
export const buildFirstBootMarker = (version, now = Date.now()) => ({
  ts: now,
  version,
});

/**
 * 当前这次启动是否按「首次」对待。
 * @param {string|null|undefined} markerRaw 标记文件原文（文件不存在传 null）
 * @param {string} currentVersion app.getVersion()
 *
 * 判定（宁可多给时间——长超时对健康机器没有任何代价，只在 server 真起不来时才有差别）：
 * - 没有标记（全新安装）→ 是；
 * - 标记损坏 / 没记版本（旧版本写的）→ 是；
 * - 标记里的版本 ≠ 当前版本（更新 / 重装 / 回退）→ 是；
 * - 当前版本拿不到 → 是；
 * - 版本一致 → 否。
 */
export const shouldTreatAsFirstBoot = (markerRaw, currentVersion) => {
  if (typeof markerRaw !== "string" || markerRaw === "") return true;
  if (typeof currentVersion !== "string" || currentVersion === "") return true;
  let marker;
  try {
    marker = JSON.parse(markerRaw);
  } catch {
    return true;
  }
  const seen = marker?.version;
  if (typeof seen !== "string" || seen === "") return true;
  return seen !== currentVersion;
};

/** 首轮等待上限：首次启动 150s、常规 60s。 */
export const pickBootTimeoutMs = (firstBoot) =>
  firstBoot ? FIRST_BOOT_TIMEOUT_MS : REGULAR_BOOT_TIMEOUT_MS;
