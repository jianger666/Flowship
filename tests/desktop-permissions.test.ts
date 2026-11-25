/**
 * 系统权限适配（electron-app/desktop/permissions.mjs）。
 *
 * 钉死：macOS 的三态映射、Windows 恒 granted 且不碰任何 electron API、
 * 深链地址精确值（改错了设置页就打不开）、请求授权时的参数（isTrustedAccessibilityClient 必须传 true 才会弹提示）。
 */
import { describe, expect, it, vi } from "vitest";

import { createPermissionAdapter, MAC_SETTINGS_URLS } from "../electron-app/desktop/permissions.mjs";

const make = (
  opts: { platform?: string; inputPermitted?: boolean | null | undefined; media?: string | (() => string); getSourcesThrows?: boolean } = {},
) => {
  const systemPreferences = {
    getMediaAccessStatus: vi.fn((kind: string) => {
      expect(kind).toBe("screen");
      if (typeof opts.media === "function") return opts.media();
      return opts.media ?? "granted";
    }),
    isTrustedAccessibilityClient: vi.fn(() => true),
  };
  const shell = { openExternal: vi.fn<(url: string) => Promise<void>>(async () => {}) };
  const desktopCapturer = {
    getSources: vi.fn(async () => {
      if (opts.getSourcesThrows) throw new Error("没权限");
      return [];
    }),
  };
  const driver = {
    inputPermitted: opts.inputPermitted === undefined ? () => true : () => opts.inputPermitted,
  };
  const adapter = createPermissionAdapter({ platform: opts.platform ?? "darwin", systemPreferences, shell, desktopCapturer, driver: driver as never });
  return { adapter, systemPreferences, shell, desktopCapturer };
};

describe("macOS", () => {
  it("辅助功能：true → granted，false → denied，读不到 → unknown", () => {
    expect(make({ inputPermitted: true }).adapter.accessibility()).toBe("granted");
    expect(make({ inputPermitted: false }).adapter.accessibility()).toBe("denied");
    expect(make({ inputPermitted: null }).adapter.accessibility()).toBe("unknown");
  });

  it("屏幕录制：原样映射系统的五种状态，系统给了怪值 / 抛错 → unknown", () => {
    for (const s of ["granted", "denied", "not-determined", "restricted", "unknown"]) {
      expect(make({ media: s }).adapter.screen()).toBe(s);
    }
    expect(make({ media: "weird" }).adapter.screen()).toBe("unknown");
    expect(
      make({
        media: () => {
          throw new Error("boom");
        },
      }).adapter.screen(),
    ).toBe("unknown");
  });

  it("请求辅助功能：必须传 true（否则只查询不弹提示）", () => {
    const { adapter, systemPreferences } = make();
    adapter.requestAccessibility();
    expect(systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
  });

  it("请求屏幕录制：抓一次 1×1 缩略图触发系统提示；失败也不抛", async () => {
    const ok = make();
    await ok.adapter.requestScreen();
    expect(ok.desktopCapturer.getSources).toHaveBeenCalledWith(expect.objectContaining({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }));
    await expect(make({ getSourcesThrows: true }).adapter.requestScreen()).resolves.toBeUndefined();
  });

  it("直达设置页：两个深链的地址", async () => {
    const { adapter, shell } = make();
    await adapter.openSettings("accessibility");
    await adapter.openSettings("screen");
    expect(shell.openExternal.mock.calls.map((c) => c[0])).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]);
    expect(MAC_SETTINGS_URLS.accessibility).toContain("Privacy_Accessibility");
    await expect(adapter.openSettings("camera" as never)).rejects.toThrow(/不认识/);
  });
});

describe("Windows", () => {
  it("两项权限恒 granted，且不碰任何 electron API", async () => {
    const { adapter, systemPreferences, shell, desktopCapturer } = make({ platform: "win32", inputPermitted: false, media: "denied" });
    expect(adapter.accessibility()).toBe("granted");
    expect(adapter.screen()).toBe("granted");
    adapter.requestAccessibility();
    await adapter.requestScreen();
    await adapter.openSettings("accessibility");
    expect(systemPreferences.getMediaAccessStatus).not.toHaveBeenCalled();
    expect(systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    expect(desktopCapturer.getSources).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
