/**
 * 系统通知 / 收件箱角标的客户端封装（桌面端 Electron IPC）
 *
 * Electron 壳通过 preload 暴露：
 *  - window.__notify.send：发系统通知（点通知壳聚焦窗口 + 可选回传 taskId）
 *  - window.__notify.onNotifyClick：订阅点通知 → 路由
 *  - window.__shell.setInboxBadge：mac Dock 角标 / win 任务栏 overlay
 *
 * 通知与角标都是被动增强、非桌面端（dev 浏览器）没有通道时静默降级。
 */

import { toast } from "sonner";

interface TaskNotifyPayload {
  title: string;
  body?: string;
  taskId?: string;
}

declare global {
  interface Window {
    /** Electron preload 暴露的通知通道（仅桌面端有） */
    __notify?: {
      send: (payload: TaskNotifyPayload) => void;
      onNotifyClick: (callback: (taskId: string) => void) => () => void;
    };
    /** Electron preload 暴露的壳能力（与 app-header 声明合并） */
    __shell?: {
      platform: string;
      setTitleBarOverlay: (opts: { color: string; symbolColor: string }) => void;
      markContentReady?: () => void;
      openExternal?: (url: string) => void;
      /** 收件箱未读角标（mac Dock / win overlay）；非壳环境无此方法 */
      setInboxBadge?: (payload: { count: number; dataUrl?: string }) => void;
    };
    /**
     * 开机自启（决策 #19）：设置页开关用；非桌面端无通道。
     * API 名与 preload 一字不差：get / set。
     */
    __autoLaunch?: {
      get: () => Promise<boolean>;
      set: (enabled: boolean) => Promise<void>;
    };
  }
}

/** 发一条系统通知（窗口后台时「叫人回来」用；收件箱增量通知也走这条） */
export const sendTaskNotification = (payload: TaskNotifyPayload): void => {
  window.__notify?.send(payload);
};

/** 订阅「用户点了通知」、返回取消订阅函数（非桌面端返 no-op） */
export const onTaskNotifyClick = (
  callback: (taskId: string) => void,
): (() => void) => window.__notify?.onNotifyClick(callback) ?? (() => {});

/**
 * Windows 任务栏 overlay：canvas 画红圆底白数字（≤9 数字、>9 为「9+」）。
 * 仅浏览器 / Electron renderer 有 document；返回 PNG dataURL。
 */
const buildWinOverlayDataUrl = (count: number): string | undefined => {
  if (typeof document === "undefined" || count <= 0) return undefined;
  const label = count > 9 ? "9+" : String(count);
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = "#e11d48";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${label.length > 1 ? 13 : 17}px system-ui,sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, size / 2, size / 2 + 0.5);
  return canvas.toDataURL("image/png");
};

/**
 * 同步收件箱未读数到 app 图标角标（mac Dock / win overlay）。
 * 非 Electron / 无通道 → no-op；count≤0 清角标。
 */
export const setInboxBadge = (count: number): void => {
  const set = window.__shell?.setInboxBadge;
  if (!set) return;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const platform = window.__shell?.platform;
  // win 需要 PNG overlay；mac 只靠 setBadgeCount、不必传图
  const dataUrl =
    platform === "win32" && n > 0 ? buildWinOverlayDataUrl(n) : undefined;
  set({ count: n, ...(dataUrl ? { dataUrl } : {}) });
};

/**
 * 打开系统「通知」设置页（用户最初在系统层误拒权限后的找回入口）。
 * mac → 通知设置面板；win → 系统通知设置；其它 / 非桌面 → toast 提示自助。
 */
export const openSystemNotificationSettings = (): void => {
  const platform = window.__shell?.platform;
  const open = window.__shell?.openExternal;
  if (!open || !platform) {
    toast.error("请在系统设置中手动开启通知权限");
    return;
  }
  if (platform === "darwin") {
    // macOS Ventura+ 通知设置深链（旧版 PreferencePane URL 已失效）
    open("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
    return;
  }
  if (platform === "win32") {
    open("ms-settings:notifications");
    return;
  }
  toast.error("请在系统设置中手动开启通知权限");
};
