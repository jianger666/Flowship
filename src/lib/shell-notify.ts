/**
 * 系统通知的客户端封装（桌面端 Electron IPC 通道、v0.9.5；v0.9.10 去掉 Dock 角标）
 *
 * Electron 壳通过 preload 暴露 window.__notify：
 *  - send：发系统通知（点通知壳会聚焦窗口 + 回传 taskId）
 *  - onNotifyClick：订阅「用户点了通知」、拿 taskId 做路由跳转
 *
 * 通知是被动增强、非桌面端（dev 浏览器）没有该通道时全部静默降级——
 * 不像 native-picker 那样 toast 报错（选择器是用户主动点的、通知不是）。
 */

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
