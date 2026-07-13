/**
 * 系统通知的客户端封装（桌面端 Electron IPC 通道、v0.9.5；v0.9.10 去掉 Dock 角标）
 *
 * Electron 壳通过 preload 暴露 window.__notify：
 *  - send：发系统通知（点通知壳会聚焦窗口 + 回传 taskId）
 *  - onNotifyClick：订阅「用户点了通知」、拿 taskId 做路由跳转
 *
 * 另：window.__shell.openExternal 打开系统设置深链（误关通知权限时引导）。
 *
 * 通知是被动增强、非桌面端（dev 浏览器）没有该通道时全部静默降级——
 * 不像 native-picker 那样 toast 报错（选择器是用户主动点的、通知不是）。
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
    };
  }
}

/** 发一条系统通知（窗口后台时「叫人回来」用） */
export const sendTaskNotification = (payload: TaskNotifyPayload): void => {
  window.__notify?.send(payload);
};

/** 订阅「用户点了通知」、返回取消订阅函数（非桌面端返 no-op） */
export const onTaskNotifyClick = (
  callback: (taskId: string) => void,
): (() => void) => window.__notify?.onNotifyClick(callback) ?? (() => {});

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
