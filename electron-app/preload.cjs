/**
 * Electron preload（v0.7.14、原生文件选择器 IPC 通道）
 *
 * 暴露 window.__nativePicker 给页面：附文件 / 附目录 / 选仓库直接走主进程
 * dialog.showOpenDialog（秒弹 + 自动前台聚焦）。原 HTTP API + osascript 兜底
 * 链路（osascript 冷启动 ~1s、用户实测有延迟）已随网页版遗留删除。
 *
 * CJS 后缀：electron-app/package.json 是 "type": "module"、preload 在 sandbox
 * 下只支持 CommonJS、用 .cjs 显式声明。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__nativePicker", {
  /**
   * @param {{ mode: "file" | "folder", multiple?: boolean, prompt?: string }} opts
   * @returns {Promise<{ paths?: string[], canceled?: boolean }>}
   */
  pick: (opts) => ipcRenderer.invoke("native-pick", opts),
});

// 检查更新（设置页「检查更新」按钮）——按需查一次、返回 { status, current, latest? }；
// 发现新版时壳会同步点亮右上角「新版本」标识（走既有 UpdateBadge / 自更新流程）
contextBridge.exposeInMainWorld("__appUpdater", {
  /** @returns {Promise<{ status: "latest"|"available"|"error", current: string, latest?: string, message?: string }>} */
  check: () => ipcRenderer.invoke("check-for-update"),
});

// 任务注意力通知（v0.9.5）：页面发现任务转入「等你回复 / 提问 / 失败」且窗口不在前台
// 时发系统通知；点通知壳聚焦窗口并回传 taskId、页面自己跳详情页
contextBridge.exposeInMainWorld("__notify", {
  /** @param {{ title: string, body?: string, taskId?: string }} payload */
  send: (payload) => ipcRenderer.send("task-notify", payload),
  /**
   * 订阅「用户点了通知」——回传 taskId、页面 router.push 跳过去。返回取消订阅函数。
   * @param {(taskId: string) => void} callback
   */
  onNotifyClick: (callback) => {
    const listener = (_event, taskId) => callback(taskId);
    ipcRenderer.on("task-notify-click", listener);
    return () => ipcRenderer.removeListener("task-notify-click", listener);
  },
});

// 自定义协议深链（flowship://tasks/<id>）：主进程 send「deep-link」→ 这里订阅。
// 冷启动时主进程可能在 React mount 前就 send——无订阅者时缓冲 latest，
// 首个 onDeepLink 注册时补投一次，避免丢路由（坑 #15）。
let __deepLinkBuffered = null;
/** @type {Set<(payload: { taskId: string }) => void>} */
const __deepLinkSubs = new Set();
ipcRenderer.on("deep-link", (_event, payload) => {
  if (__deepLinkSubs.size > 0) {
    __deepLinkBuffered = null;
    for (const cb of __deepLinkSubs) cb(payload);
  } else {
    __deepLinkBuffered = payload;
  }
});
contextBridge.exposeInMainWorld("__deepLink", {
  /**
   * 订阅深链跳转。返回取消订阅函数。
   * @param {(payload: { taskId: string }) => void} callback
   */
  onDeepLink: (callback) => {
    __deepLinkSubs.add(callback);
    if (__deepLinkBuffered?.taskId) {
      const p = __deepLinkBuffered;
      __deepLinkBuffered = null;
      queueMicrotask(() => callback(p));
    }
    return () => __deepLinkSubs.delete(callback);
  },
});

// 点 X 关闭的二次确认（2026-07-20 用户拍板）：主进程拦 close → 这里转 renderer
// 弹 app 内 confirm（红色确认键）→ 结果回传主进程决定是否真退出
contextBridge.exposeInMainWorld("__closeConfirm", {
  /**
   * 订阅关闭确认请求。返回取消订阅函数。
   * @param {(payload: { appName: string }) => void} callback
   */
  onRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("app-close-confirm", listener);
    return () => ipcRenderer.removeListener("app-close-confirm", listener);
  },
  /** @param {boolean} confirmed */
  respond: (confirmed) => ipcRenderer.send("app-close-confirm-result", confirmed === true),
});

// 开机自启（决策 #19）：设置页开关调这里；壳只暴露 API、UI 在设置页
contextBridge.exposeInMainWorld("__autoLaunch", {
  /** @returns {Promise<boolean>} */
  get: () => ipcRenderer.invoke("auto-launch-get"),
  /** @param {boolean} enabled */
  set: (enabled) => ipcRenderer.invoke("auto-launch-set", enabled === true),
});

// 壳能力 / 平台信息（自定义标题栏用）
contextBridge.exposeInMainWorld("__shell", {
  // "darwin" | "win32" | "linux"——页面据此给右侧控件让出 Windows 控制按钮位
  platform: process.platform,
  // Windows：主题切换时同步右上角窗口控制按钮条的底色 / 图标色（mac 忽略）
  /** @param {{ color: string, symbolColor: string }} opts */
  setTitleBarOverlay: (opts) => ipcRenderer.send("set-titlebar-overlay", opts),
  // v1.1.x「开屏一屏到底」：首页真实内容（看板 / 就绪清单）渲出来后调——
  // 壳此刻才亮主窗 + 收 splash、启动全程只有一屏 loading、没有衔接切换
  markContentReady: () => ipcRenderer.send("app-content-ready"),
  // 打开系统外链（设置页「系统设置里开启」通知权限等）——主进程白名单校验
  /** @param {string} url */
  openExternal: (url) => ipcRenderer.send("open-external", url),
  // 收件箱三期：未读数 → mac Dock 角标 / win 任务栏 overlay（renderer 传 PNG dataUrl）
  /** @param {{ count: number, dataUrl?: string }} payload */
  setInboxBadge: (payload) => ipcRenderer.send("inbox:set-badge", payload),
});
