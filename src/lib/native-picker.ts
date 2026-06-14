"use client";

/**
 * 原生文件 / 文件夹选择器的客户端封装（桌面端 Electron IPC 通道）
 *
 * 项目只交付桌面端：Electron 壳通过 preload 暴露 window.__nativePicker、走主进程
 * dialog.showOpenDialog（秒弹 + 自动前台聚焦）。这是唯一通道——非桌面环境
 * （浏览器 dev）没有该通道、直接 toast 提示、不再做 HTTP + osascript 兜底。
 *
 * 返回：选中的绝对路径数组；用户取消返 null（调用方静默即可）；
 * 出错 / 非桌面端 toast 后也返 null、调用方不用再处理错误分支。
 */

import { toast } from "sonner";

interface PickOpts {
  mode: "file" | "folder";
  multiple?: boolean;
  prompt?: string;
}

declare global {
  interface Window {
    /** Electron preload 暴露的原生选择器通道（仅桌面端有） */
    __nativePicker?: {
      pick: (opts: PickOpts) => Promise<{ paths?: string[]; canceled?: boolean }>;
    };
  }
}

export const pickNativePaths = async (opts: PickOpts): Promise<string[] | null> => {
  // 仅桌面端 Electron 壳有原生选择器通道（preload 暴露 __nativePicker）
  if (typeof window === "undefined" || !window.__nativePicker) {
    toast.error("文件选择仅在桌面端可用");
    return null;
  }
  try {
    const r = await window.__nativePicker.pick(opts);
    if (r.canceled || !r.paths?.length) return null;
    return r.paths;
  } catch (err) {
    toast.error(`打开选择器失败：${(err as Error).message}`);
    return null;
  }
};
