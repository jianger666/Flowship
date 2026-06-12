"use client";

/**
 * 原生文件 / 文件夹选择器的客户端封装（V0.7.13、v0.7.14 加 Electron IPC 直连）
 *
 * 通道优先级（大方针：桌面端全走原生、2026-06-12 用户拍板）：
 * 1. Electron 壳 IPC（window.__nativePicker、preload 暴露）——主进程
 *    dialog.showOpenDialog、秒弹 + 自动前台聚焦
 * 2. HTTP /api/fs/pick-native 兜底（浏览器 dev 场景）——server 同机 osascript /
 *    powershell 弹系统 picker、mac 有 ~1s 冷启动延迟
 *
 * 返回：选中的绝对路径数组；用户取消返 null（调用方静默即可）；
 * 出错 toast 后也返 null、调用方不用再处理错误分支。
 */

import { toast } from "sonner";

interface PickOpts {
  mode: "file" | "folder";
  multiple?: boolean;
  prompt?: string;
}

declare global {
  interface Window {
    /** Electron preload 暴露的原生选择器通道（web 版无） */
    __nativePicker?: {
      pick: (opts: PickOpts) => Promise<{ paths?: string[]; canceled?: boolean }>;
    };
  }
}

export const pickNativePaths = async (opts: PickOpts): Promise<string[] | null> => {
  // 通道 1：Electron 壳 IPC（桌面端主路径）
  if (typeof window !== "undefined" && window.__nativePicker) {
    try {
      const r = await window.__nativePicker.pick(opts);
      if (r.canceled || !r.paths?.length) return null;
      return r.paths;
    } catch (err) {
      toast.error(`打开选择器失败：${(err as Error).message}`);
      return null;
    }
  }

  // 通道 2：HTTP API 兜底（浏览器 dev 场景）
  try {
    const res = await fetch("/api/fs/pick-native", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    const json = (await res.json()) as {
      paths?: string[];
      canceled?: boolean;
      error?: string;
    };
    if (!res.ok) {
      toast.error(json.error || "打开选择器失败");
      return null;
    }
    if (json.canceled || !json.paths?.length) return null;
    return json.paths;
  } catch (err) {
    toast.error(`打开选择器失败：${(err as Error).message}`);
    return null;
  }
};
