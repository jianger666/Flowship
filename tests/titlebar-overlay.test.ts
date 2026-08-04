import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireTitleBarOverlayDim,
  releaseTitleBarOverlayDim,
  resetTitleBarOverlayDimForTests,
  syncTitleBarOverlayTheme,
  TITLEBAR_OVERLAY_COLOR,
  TITLEBAR_OVERLAY_DIMMED,
} from "@/lib/titlebar-overlay";

describe("titlebar-overlay dim", () => {
  afterEach(() => {
    resetTitleBarOverlayDimForTests();
    // @ts-expect-error 测试清理
    delete globalThis.window;
  });

  it("acquire 压暗、release 还原；嵌套计数不会过早还原", () => {
    const setTitleBarOverlay = vi.fn();
    // @ts-expect-error 测试注入
    globalThis.window = {
      __shell: { platform: "win32", setTitleBarOverlay },
    };

    syncTitleBarOverlayTheme("light");
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith(
      TITLEBAR_OVERLAY_COLOR.light,
    );

    acquireTitleBarOverlayDim();
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith(
      TITLEBAR_OVERLAY_DIMMED.light,
    );

    acquireTitleBarOverlayDim();
    releaseTitleBarOverlayDim();
    // 仍有一层蒙层，保持压暗
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith(
      TITLEBAR_OVERLAY_DIMMED.light,
    );

    releaseTitleBarOverlayDim();
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith(
      TITLEBAR_OVERLAY_COLOR.light,
    );
  });

  it("darwin 不调用 setTitleBarOverlay", () => {
    const setTitleBarOverlay = vi.fn();
    // @ts-expect-error 测试注入
    globalThis.window = {
      __shell: { platform: "darwin", setTitleBarOverlay },
    };

    syncTitleBarOverlayTheme("dark");
    acquireTitleBarOverlayDim();
    expect(setTitleBarOverlay).not.toHaveBeenCalled();
  });
});
