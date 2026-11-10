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

// 自动更新桥（设置页「检查更新」+ 右上角 UpdateBadge 共用）：
// - check：按需查一次、返回 { status, current, latest? }
// - install：点徽标装更新（主进程按状态分流：下载 / 弹重启确认 / 忽略重入）
// - getState / onState：更新状态机全量拉取 + 实时订阅（phase/version/percent/error、
//   徽标据此渲染「新版本 / 下载中 x% / 重启更新 / 更新中」，见 main.js updateState）
contextBridge.exposeInMainWorld("__appUpdater", {
  /** @returns {Promise<{ status: "latest"|"available"|"error", current: string, latest?: string, message?: string }>} */
  check: () => ipcRenderer.invoke("check-for-update"),
  /** 安装更新（等价旧 app-update://install 伪协议、走正规 IPC） */
  install: () => ipcRenderer.send("install-update"),
  /** @returns {Promise<{ phase: string, version: string|null, percent: number, error: string|null }>} */
  getState: () => ipcRenderer.invoke("get-update-state"),
  /**
   * 订阅更新状态变化。返回取消订阅函数。
   * @param {(state: { phase: string, version: string|null, percent: number, error: string|null }) => void} callback
   */
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("update-state", listener);
    return () => ipcRenderer.removeListener("update-state", listener);
  },
});

// 任务注意力通知（v0.9.5）：页面发现任务转入「等你回复 / 提问 / 失败」且窗口不在前台
// 时发系统通知；点通知壳聚焦窗口并回传 taskId、页面自己跳详情页
contextBridge.exposeInMainWorld("__notify", {
  /** @param {{ title: string, body?: string, taskId?: string, target?: "inbox" }} payload */
  send: (payload) => ipcRenderer.send("task-notify", payload),
  /**
   * 订阅「点了带 target 的通知」（N1-12：target:"inbox" → 页面打开收件箱）。返回取消订阅函数。
   * @param {(target: string) => void} callback
   */
  onTargetClick: (callback) => {
    const listener = (_event, target) => callback(target);
    ipcRenderer.on("notify-target-click", listener);
    return () => ipcRenderer.removeListener("notify-target-click", listener);
  },
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

// mac 菜单栏图标（仅 darwin 设置页用；Windows 不展示）
contextBridge.exposeInMainWorld("__menuBarIcon", {
  /** @returns {Promise<boolean | null>} */
  get: () => ipcRenderer.invoke("menu-bar-icon-get"),
  /** @param {boolean} visible */
  set: (visible) => ipcRenderer.invoke("menu-bar-icon-set", visible === true),
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

// 内置浏览器桥（docs/BROWSER-AUTOMATION.md §5 / §8.2）：面板（React）经这里驱动主进程的 BrowserManager。
// - 只有主窗口带本 preload；浏览器 view 自己**没有** preload（页面碰不到这些 IPC），主进程每个 browser:* 入口
//   还会再过 isTrustedIpcSender（只认本应用 origin）
// - 高频的 setBounds（拖分栏 / 缩放）走 send（单向、无返回值），其余有返回值的走 invoke，无返回值的动作走 send
// - onState / onPicked：ipcRenderer.on 订阅主进程推送，返回取消订阅函数
contextBridge.exposeInMainWorld("__browser", {
  // —— 视图生命周期 ——
  /** 懒创建会话、把视图搬到主窗口并设 bounds @returns {Promise<object>} BrowserState */
  attach: (taskId, bounds) => ipcRenderer.invoke("browser:attach", taskId, bounds),
  /** 高频：renderer 侧 rAF 节流后调用，不等返回 */
  setBounds: (taskId, bounds) => ipcRenderer.send("browser:setBounds", taskId, bounds),
  /** 搬回停车场（面板卸载 / 离开任务页） */
  detach: (taskId) => ipcRenderer.send("browser:detach", taskId),
  /** covered=true：截图 + 隐藏视图并返回 jpeg dataURL；covered=false：恢复。失败 null @returns {Promise<string|null>} */
  setCovered: (taskId, covered) => ipcRenderer.invoke("browser:setCovered", taskId, covered === true),
  // —— 用户导航 ——
  /** @returns {Promise<{ ok: boolean, error?: string }>} */
  navigate: (taskId, input) => ipcRenderer.invoke("browser:navigate", taskId, input),
  back: (taskId) => ipcRenderer.send("browser:back", taskId),
  forward: (taskId) => ipcRenderer.send("browser:forward", taskId),
  reload: (taskId) => ipcRenderer.send("browser:reload", taskId),
  stop: (taskId) => ipcRenderer.send("browser:stop", taskId),
  /** @returns {Promise<string|null>} 新 tab 的 id */
  newTab: (taskId, url) => ipcRenderer.invoke("browser:newTab", taskId, url),
  selectTab: (taskId, tabId) => ipcRenderer.send("browser:selectTab", taskId, tabId),
  closeTab: (taskId, tabId) => ipcRenderer.send("browser:closeTab", taskId, tabId),
  // —— 谁在操作 ——
  /** 用户接管：解锁输入、中断 AI 当前动作 */
  takeover: (taskId) => ipcRenderer.send("browser:takeover", taskId),
  /** 交还给 AI（可带一句话） */
  handback: (taskId, note) => ipcRenderer.send("browser:handback", taskId, note),
  /** 响应 ask_user_to_act："done" | "skipped" */
  answerAsk: (taskId, outcome, note) => ipcRenderer.send("browser:answerAsk", taskId, outcome, note),
  // —— 元素拾取 ——
  startPick: (taskId) => ipcRenderer.send("browser:startPick", taskId),
  cancelPick: (taskId) => ipcRenderer.send("browser:cancelPick", taskId),
  // —— 状态 ——
  /** @returns {Promise<object|null>} BrowserState */
  getState: (taskId) => ipcRenderer.invoke("browser:getState", taskId),
  /**
   * 订阅全部任务的状态推送（主进程 50ms 去抖）。返回取消订阅函数。
   * @param {(taskId: string, state: object) => void} callback
   */
  onState: (callback) => {
    const listener = (_event, taskId, state) => callback(taskId, state);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.removeListener("browser:state", listener);
  },
  /**
   * 订阅元素拾取结果。返回取消订阅函数。
   * @param {(taskId: string, picked: object) => void} callback
   */
  onPicked: (callback) => {
    const listener = (_event, taskId, picked) => callback(taskId, picked);
    ipcRenderer.on("browser:picked", listener);
    return () => ipcRenderer.removeListener("browser:picked", listener);
  },
  /** 清登录态（cookies / storage） @returns {Promise<void>} */
  clearBrowsingData: () => ipcRenderer.invoke("browser:clearBrowsingData"),
  // —— V4 用户侧（契约 §14.3）：缩放 / 页内查找 / DevTools / 下载 / 对话框 / 模拟；主进程实现在 browser/user-features.mjs ——
  /** 缩放当前 tab："in" | "out" | "reset" */
  zoom: (taskId, action) => ipcRenderer.send("browser:zoom", taskId, action),
  /** 页内查找：opts = { forward?, findNext?, matchCase? }；text 为空等价于 stopFind */
  find: (taskId, text, opts) => ipcRenderer.send("browser:find", taskId, text, opts),
  stopFind: (taskId) => ipcRenderer.send("browser:stopFind", taskId),
  /** 订阅查找进度 { taskId, activeMatchOrdinal, matches }。返回取消订阅函数 */
  onFound: (callback) => {
    const listener = (_event, found) => callback(found);
    ipcRenderer.on("browser:found", listener);
    return () => ipcRenderer.removeListener("browser:found", listener);
  },
  /** 订阅「页面持有焦点时按了 Cmd/Ctrl+F」→ 面板该打开查找条了。返回取消订阅函数 */
  onFindRequested: (callback) => {
    const listener = (_event, taskId) => callback(taskId);
    ipcRenderer.on("browser:findRequested", listener);
    return () => ipcRenderer.removeListener("browser:findRequested", listener);
  },
  openDevTools: (taskId) => ipcRenderer.send("browser:openDevTools", taskId),
  /** 在文件夹中显示 / 打开下载：只传会话内的下载 id，路径永远由主进程从登记表取 @returns {Promise<{ ok: boolean, error?: string }>} */
  revealDownload: (taskId, id) => ipcRenderer.invoke("browser:revealDownload", taskId, id),
  openDownload: (taskId, id) => ipcRenderer.invoke("browser:openDownload", taskId, id),
  /** 处理挂起的 JS 对话框 */
  answerDialog: (taskId, accept, promptText) => ipcRenderer.send("browser:answerDialog", taskId, accept, promptText),
  /** 清掉当前 tab 的设备 / 环境模拟 */
  resetEmulation: (taskId) => ipcRenderer.send("browser:resetEmulation", taskId),
  // —— 增强包 E2（契约 §15.1）——
  /**
   * 通用扩展通道：`ext(name, taskId, ...args)`，name 必须是主进程模块登记过的白名单名字（`prompt.answer` / `netrules.clear` / `debug.resume` / `record.stop` …）。
   * 会话不存在返回 null；名字未登记会 reject。
   * @returns {Promise<unknown>}
   */
  ext: (name, taskId, ...args) => ipcRenderer.invoke("browser:ext", name, taskId, ...args),
  // —— R7：本地 HTML 默认走内置浏览器 ——
  /**
   * 把本地 .html / .htm 登记成一次性 token 的只读 loopback URL（`http://<token>.localhost:<端口>/<文件名>`，每个 token 一个 origin），不用 file:。
   * 只传绝对路径；范围 / 敏感文件 / 大小校验都在主进程。永不 reject：失败返回 { ok:false, error }，调用方回退系统打开。
   * @returns {Promise<{ ok: true, url: string, scope: "dir" | "file" } | { ok: false, error: string }>}
   */
  serveLocalHtml: (absPath) => ipcRenderer.invoke("browser:serveLocalHtml", absPath),
});
