/**
 * 系统权限适配（macOS 辅助功能 / 屏幕录制；Windows 没有这两项，恒 granted）。
 *
 * 把 electron 的 systemPreferences / shell / desktopCapturer 收在一处，manager 只认这里的接口，单测也好替换。
 */

/** @typedef {'granted'|'denied'|'not-determined'|'restricted'|'unknown'} PermissionState */

const MEDIA_STATES = new Set(["granted", "denied", "not-determined", "restricted", "unknown"]);

/** macOS 系统设置「隐私与安全性」下两个页面的深链 */
export const MAC_SETTINGS_URLS = Object.freeze({
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
});

/**
 * @param {{
 *   platform?: string,
 *   systemPreferences?: any,
 *   shell?: any,
 *   desktopCapturer?: any,
 *   driver: import("./types.mjs").DesktopDriver,
 *   log?: (msg: string) => void,
 * }} deps
 */
export const createPermissionAdapter = ({ platform = process.platform, systemPreferences, shell, desktopCapturer, driver, log = () => {} }) => {
  const isMac = platform === "darwin";

  /** @returns {PermissionState} */
  const accessibility = () => {
    if (!isMac) return "granted";
    const ok = driver.inputPermitted?.();
    return ok === true ? "granted" : ok === false ? "denied" : "unknown";
  };

  /** @returns {PermissionState} */
  const screen = () => {
    if (!isMac) return "granted";
    try {
      const s = systemPreferences?.getMediaAccessStatus?.("screen");
      return MEDIA_STATES.has(s) ? s : "unknown";
    } catch {
      return "unknown";
    }
  };

  /** 弹出系统的「辅助功能」授权提示（带「打开系统设置」按钮） */
  const requestAccessibility = () => {
    if (!isMac) return;
    try {
      systemPreferences?.isTrustedAccessibilityClient?.(true);
    } catch (err) {
      log(`[desktop-permissions] 请求辅助功能失败：${err?.message || err}`);
    }
  };

  /** macOS 没有直接弹「屏幕录制」授权的 API：抓一次 1×1 的缩略图就会触发系统提示（首次） */
  const requestScreen = async () => {
    if (!isMac) return;
    try {
      await desktopCapturer?.getSources?.({ types: ["screen"], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false });
    } catch (err) {
      log(`[desktop-permissions] 触发屏幕录制提示失败（可忽略）：${err?.message || err}`);
    }
  };

  /** 直达系统设置里对应的页面 */
  const openSettings = async (kind) => {
    if (!isMac) return;
    const url = MAC_SETTINGS_URLS[kind];
    if (!url) throw new Error(`不认识的权限类型：${String(kind)}`);
    await shell.openExternal(url);
  };

  return { accessibility, screen, requestAccessibility, requestScreen, openSettings };
};
