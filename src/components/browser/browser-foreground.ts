/**
 * 「用户此刻正看着这个任务的浏览器」判定（纯函数，可在 node 里测）——给 AI 请求用户操作的系统通知决定要不要静音用。
 *
 * 背景（R1-35，疑似、待真机）：浏览器视图是主进程里盖在主窗口之上的另一个 webContents。
 * 用户点进页面之后键盘焦点落在原生视图里，主窗口自己的 `document.hasFocus()` 多半变成 false，
 * 于是「用户正盯着浏览器操作」被当成「窗口在后台」，照样弹系统通知。
 *
 * 不能只靠「该任务视图已 attached 且是当前任务」就算前台：`attached` 只表示视图挂在主窗口上，
 * 用户切去别的 app 时它依然是 true（session.mjs 里 attached 只随 attach / detach 变，不看窗口焦点）。
 * 那样会把「用户在别的 app、AI 在等他」这个通知存在的主要场景也静音掉。
 * 所以第二条路需要**主进程给出的窗口焦点真值** `windowFocused`（BrowserWindow.isFocused()——焦点在子视图里时它也是 true）：
 * 主进程在每次状态推送 / `browser:getState` / `browser:attach` 的返回里都带 `windowFocused`（index.mjs 的 `withWindowFocus`，
 * 真 Electron 下 r1-lifecycle.cjs 断言它是布尔）；老壳 / 夹具里缺省（undefined）时本函数退回只看 document.hasFocus() 的旧行为。
 */

export interface ForegroundInput {
  /** document.hasFocus()：焦点在主窗口自己的 HTML 里 */
  docHasFocus: boolean;
  /** document.visibilityState === "visible"（最小化 / 被完全遮住时为 false） */
  visible: boolean;
  /** 状态推送里的 attached：该任务的浏览器视图当前挂在主窗口上 */
  attached: boolean | undefined;
  /** 推送属于哪个任务 / 当前页面显示的是哪个任务 */
  taskId: string;
  activeTaskId: string | null;
  /** 主进程给的窗口焦点真值（焦点在原生视图里也为 true）；没有这个字段 = undefined */
  windowFocused?: boolean;
}

export const isBrowserTaskForeground = (i: ForegroundInput): boolean => {
  if (!i.visible) return false;
  if (i.docHasFocus) return true;
  // 焦点在原生视图里：窗口确实是前台的，且用户正显示着这个任务、它的视图也挂在窗口上
  return i.windowFocused === true && i.attached === true && i.activeTaskId !== null && i.taskId === i.activeTaskId;
};
