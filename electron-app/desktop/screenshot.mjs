/**
 * 主显示器截图（Electron desktopCapturer）→ JPEG + 坐标映射信息。
 *
 * 为什么用 desktopCapturer 而不是 `screencapture` 命令行：不用起子进程 / 落临时文件，Windows 与 macOS 同一套；
 * 权限就是 Flowship 自己的「屏幕录制」。遮罩窗口开了 setContentProtection，期望截图里没有遮罩——
 * ⚠️ 但 macOS 27 上实测它不是「被忽略」就是「把整个屏幕截成一片黑」（只剩 Dock 图标）。所以每张截图都顺手量一下
 * 「画面里有多少像素像遮罩底色 / 近乎纯黑」（overlayRatio / blackRatio）和一份颜色指纹（sig），
 * 由 capture-guard.mjs 据此判断遮罩有没有影响截图、要不要撤遮罩重截。像素统计的实现在 image-stats.mjs。
 *
 * 截图只截**主显示器**：输入坐标也只在主显示器范围内（coords.mjs 的线性映射），AI 看到什么就能点什么。
 *
 * 体积：默认最宽 1280、JPEG 质量 70，通常 100–250KB；超过 maxBytes 先降质量、再缩小，免得撑爆模型上下文。
 */
import { fitToWidth } from "./coords.mjs";
import { measureImage, OVERLAY_COLOR_TOLERANCE } from "./image-stats.mjs";
import { DesktopError } from "./types.mjs";

export const SCREENSHOT_DEFAULTS = Object.freeze({
  maxWidth: 1280,
  quality: 70,
  maxBytes: 1_200_000,
});

export { OVERLAY_COLOR_TOLERANCE };

/**
 * desktopCapturer.getSources 的等待上限。它偶尔会挂住不返回（系统截屏服务卡死、显示器正在切换……），而 manager 的桌面请求是一条串行队列：
 * 一个挂住的截图会让之后所有桌面请求都排在它后面等下去——server 那边每个请求各自的 90 秒超时只是让那一次工具调用失败，队列本身不会松开，
 * 直到重启 Flowship。正常的 getSources 在几十到几百毫秒内返回，所以上限取得很宽松、但必须有。
 */
export const GET_SOURCES_TIMEOUT_MS = 12_000;

const TIMED_OUT = Symbol("getSources-timed-out");

/**
 * promise 在 ms 内没有结果就换成 TIMED_OUT。超时之后那个挂住的 promise 将来无论成功还是失败都没人再理会
 * （Promise.race 自己订阅着它，事后失败有人接着，不会变成 unhandledRejection）；计时器无论如何都会清掉。
 */
const withDeadline = (promise, ms) => {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

/**
 * @param {{
 *   desktopCapturer: any,
 *   screen: any,
 *   systemPreferences?: any,
 *   driver: import("./types.mjs").DesktopDriver,
 *   platform?: string,
 *   maxWidth?: number,
 *   quality?: number,
 *   maxBytes?: number,
 *   getSourcesTimeoutMs?: number,
 *   log?: (msg: string) => void,
 * }} deps
 */
export const createScreenshotter = (deps) => {
  const { desktopCapturer, screen, systemPreferences, driver, platform = process.platform, log = () => {} } = deps;
  const maxWidth = deps.maxWidth ?? SCREENSHOT_DEFAULTS.maxWidth;
  const quality = deps.quality ?? SCREENSHOT_DEFAULTS.quality;
  const maxBytes = deps.maxBytes ?? SCREENSHOT_DEFAULTS.maxBytes;
  const getSourcesTimeoutMs =
    Number.isFinite(deps.getSourcesTimeoutMs) && deps.getSourcesTimeoutMs > 0 ? deps.getSourcesTimeoutMs : GET_SOURCES_TIMEOUT_MS;

  /** 屏幕录制权限：macOS 以系统为准；Windows 没有这个权限，恒 granted */
  const screenPermission = () => {
    if (platform !== "darwin") return "granted";
    try {
      return systemPreferences?.getMediaAccessStatus?.("screen") ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  /** 在 getSources 的结果里挑出主显示器那一块 */
  const pickPrimary = (sources) => {
    const primary = screen.getPrimaryDisplay();
    const byId = sources.find((s) => String(s.display_id ?? "") === String(primary.id));
    if (byId) return byId;
    // Windows 上 display_id 可能是空串：sources 的顺序与 getAllDisplays 一致，按主屏的下标取
    const index = screen.getAllDisplays().findIndex((d) => d.id === primary.id);
    return sources[index >= 0 && index < sources.length ? index : 0];
  };

  /**
   * overlayRatio / blackRatio：画面里像遮罩底色 / 近乎纯黑的像素占比（0~1）；sig：颜色指纹（比两张图是不是同一个屏幕用）。
   * 读不到像素时都是 null——只给 capture-guard 判断用，不进工具返回值。
   * @returns {Promise<{ jpeg: Buffer, frame: { imageWidth: number, imageHeight: number, rect: { x: number, y: number, width: number, height: number } }, overlayRatio: number | null, blackRatio: number | null, sig: Uint8Array | null }>}
   */
  const capture = async () => {
    const perm = screenPermission();
    if (perm !== "granted") {
      throw new DesktopError(
        "NEED_PERMISSION",
        "Flowship 还没有「屏幕录制」权限，截不了图。请告诉用户到 Flowship 设置的「电脑操作」里点「授权屏幕录制」（授权后可能需要重启 Flowship）",
      );
    }
    const rect = driver.getPrimaryDisplay();
    const target = fitToWidth(rect.width, rect.height, maxWidth);
    let sources;
    try {
      sources = await withDeadline(
        desktopCapturer.getSources({ types: ["screen"], thumbnailSize: target, fetchWindowIcons: false }),
        getSourcesTimeoutMs,
      );
    } catch (err) {
      log(`[desktop-screenshot] getSources 失败：${err?.message || err}`);
      throw new DesktopError("INTERNAL", "截图失败（系统没有返回屏幕画面）。可以重试一次；仍失败请告诉用户检查「屏幕录制」权限");
    }
    if (sources === TIMED_OUT) {
      // 放弃这次截图、让出串行队列；那个挂住的调用将来自己结束也不会再有人用它的结果
      log(`[desktop-screenshot] getSources 超过 ${getSourcesTimeoutMs}ms 没有返回，放弃这次截图（系统截屏服务可能卡住了）`);
      throw new DesktopError(
        "TIMEOUT",
        `截图超时（系统 ${Math.round(getSourcesTimeoutMs / 1000)} 秒没有返回屏幕画面，截屏服务可能卡住了）。可以重试一次；仍失败请如实告诉用户，让他重启 Flowship`,
      );
    }
    const source = pickPrimary(sources ?? []);
    let img = source?.thumbnail;
    if (!img || img.isEmpty()) {
      throw new DesktopError("INTERNAL", "截图失败（拿到的是空画面，显示器可能在休眠）。可以重试一次");
    }

    // 在压缩 / 缩小之前量（原始位图最准）；量不出来 = null，守卫按「无法判断」处理
    const stats = measureImage(img);

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
      frame: { imageWidth: size.width, imageHeight: size.height, rect },
      overlayRatio: stats?.overlayRatio ?? null,
      blackRatio: stats?.blackRatio ?? null,
      sig: stats?.sig ?? null,
    };
  };

  return { capture, screenPermission };
};
