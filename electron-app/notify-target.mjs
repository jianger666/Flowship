/**
 * 系统通知 payload 解析（N1-12）：page → preload → main 的 `task-notify` IPC。
 *
 * 通知分两类点击去向：
 *  - taskId：点通知聚焦窗口 + 回传 taskId，页面 router.push 到任务详情；
 *  - target:"inbox"：收件箱增量通知，点击后页面打开收件箱面板（原先只聚焦窗口、用户要自己找顶栏小铃铛）。
 * 抽成纯函数供单测直接 import（main.js 里的 ipcMain 本体没法脱离 Electron 跑）。
 */

/** 白名单：只放行已知的点击目标，未知值一律当「无目标」 */
export const NOTIFY_TARGETS = ["inbox"];

/**
 * 把页面传来的 payload 收敛成主进程要用的形状（防御性：IPC 入参不可信）。
 * @param {unknown} payload
 * @returns {{ title: string, body: string, taskId: string, target: string }}
 */
export const parseNotifyPayload = (payload) => {
  const p = payload && typeof payload === "object" ? payload : {};
  const title =
    typeof p.title === "string" && p.title ? p.title.slice(0, 80) : "Flowship";
  const body = typeof p.body === "string" ? p.body.slice(0, 200) : "";
  const taskId = typeof p.taskId === "string" ? p.taskId : "";
  // taskId 优先：同时带了两者按任务跳（任务通知语义更具体）
  const target =
    !taskId && typeof p.target === "string" && NOTIFY_TARGETS.includes(p.target)
      ? p.target
      : "";
  return { title, body, taskId, target };
};
