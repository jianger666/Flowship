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
