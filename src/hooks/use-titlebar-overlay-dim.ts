"use client";

/**
 * Windows：弹层蒙层打开时压暗 titleBarOverlay（系统窗口按钮条），关闭还原。
 * mac 无 overlay，helper 内部 no-op。
 */

import { useEffect } from "react";

import {
  acquireTitleBarOverlayDim,
  releaseTitleBarOverlayDim,
} from "@/lib/titlebar-overlay";

/** 挂在 Dialog / AlertDialog / Sheet 的 overlay 上：mount=压暗、unmount=还原 */
export const useTitleBarOverlayDim = (active = true) => {
  useEffect(() => {
    if (!active) return;
    acquireTitleBarOverlayDim();
    return () => releaseTitleBarOverlayDim();
  }, [active]);
};
