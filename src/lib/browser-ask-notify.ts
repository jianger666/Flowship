/**
 * 内置浏览器：AI 调 browser_ask_user_to_act（请用户在浏览器里操作一下）时的系统通知决策。
 *
 * 为什么单独做：这类提问挂在浏览器会话上，不走 ask_user 的 hasPendingAsk，runStatus 也仍是 running，
 * task-notify-plan 里的转变沿检测看不到它；用户不在这个任务页（或窗口在后台）时，AI 会一直干等。
 *
 * 纯函数，可在 node 里测；挂载与发送见 components/browser/browser-ask-watcher.tsx。
 */
import { clipOneLine } from "@/lib/one-line";
import { shouldMuteTaskNotification, type TaskNotifyItem } from "@/lib/task-notify-plan";

export const BROWSER_ASK_BODY_MAX = 60;

export interface BrowserAskSnapshot {
  taskId: string;
  askRequest: { message: string; since: number } | null;
}

/**
 * 一次主进程状态推送 → 要不要发通知。
 *
 * - 转变沿以 `since`（提问时间戳）认：同一次提问期间的重复推送不重复通知；提问结束（askRequest 变回 null）清记录，
 *   下一次提问（since 不同）才会再通知；
 * - 窗口聚焦且正看着这个任务时静音（用户已经能看到条幅），但仍记下 since——之后他切走不会补发一条陈旧通知；
 * - `notified` 由调用方持有、就地更新。
 */
export const planBrowserAskNotification = (input: {
  state: BrowserAskSnapshot;
  notified: Map<string, number>;
  title: string | undefined;
  hasFocus: boolean;
  activeTaskId: string | null;
}): TaskNotifyItem | null => {
  const { state, notified } = input;
  const ask = state.askRequest;
  if (!ask) {
    notified.delete(state.taskId);
    return null;
  }
  if (notified.get(state.taskId) === ask.since) return null;
  notified.set(state.taskId, ask.since);
  if (
    shouldMuteTaskNotification({
      hasFocus: input.hasFocus,
      activeTaskId: input.activeTaskId,
      taskId: state.taskId,
    })
  ) {
    return null;
  }
  // ask.message 由（可能被注入的）页面左右：与状态条同一口径，先剥格式 / 控制字符（U+202E 方向控制、零宽、tag）再截断（R3-09）
  const detail = clipOneLine(ask.message, BROWSER_ASK_BODY_MAX);
  return {
    title: input.title?.trim() || "Flowship",
    body: detail ? `AI 请你在浏览器里操作一下：${detail}` : "AI 请你在浏览器里操作一下",
    taskId: state.taskId,
    kind: "ask",
  };
};
