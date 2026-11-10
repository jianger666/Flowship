"use client";

/**
 * 内置浏览器「请用户操作」的全局提醒（挂在 providers 里，和 TaskAttentionWatcher 并列）。
 *
 * 为什么是全局的：AI 在后台任务里调 browser_ask_user_to_act 时，用户可能在别的任务页、别的应用里，
 * 任务页内的条幅看不到；决策逻辑在 lib/browser-ask-notify（纯函数、有单测），这里只做订阅与发送。
 *
 * 点通知跳任务页由 TaskAttentionWatcher 的 onTaskNotifyClick 统一处理，这里不重复订阅。
 * 非桌面端没有 window.__browser，整个组件空转。
 */

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { useTaskList } from "@/hooks/use-task-list";
import { planBrowserAskNotification } from "@/lib/browser-ask-notify";
import { sendTaskNotification } from "@/lib/shell-notify";
import {
  activeTaskIdFromPathname,
  applyNotifyThrottle,
  createNotifyThrottle,
} from "@/lib/task-notify-plan";
import { isBrowserTaskForeground } from "./browser-foreground";

export const BrowserAskWatcher = () => {
  const pathname = usePathname();
  const { tasks } = useTaskList();
  // 放 ref 给订阅回调读：切页 / 任务列表刷新不该重订阅（重订阅会丢掉「已通知」的记录）
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const activeTaskIdRef = useRef<string | null>(null);
  activeTaskIdRef.current = activeTaskIdFromPathname(pathname);

  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.__browser;
    if (!bridge) return;
    const notified = new Map<string, number>();
    const throttle = createNotifyThrottle();
    return bridge.onState((taskId, state) => {
      const item = planBrowserAskNotification({
        state: { taskId, askRequest: state.askRequest },
        notified,
        title: tasksRef.current.find((t) => t.id === taskId)?.title,
        // 焦点落到原生视图时 document.hasFocus() 为 false 但用户其实在前台操作：见 browser-foreground.ts（R1-35，待真机）
        hasFocus: isBrowserTaskForeground({
          docHasFocus: document.hasFocus(),
          visible: document.visibilityState === "visible",
          attached: state.attached,
          taskId,
          activeTaskId: activeTaskIdRef.current,
          // 主进程在状态推送里附带的窗口焦点真值（BrowserWindow.isFocused()；老壳缺省 = 不确定 = 不静音）
          windowFocused: state.windowFocused,
        }),
        activeTaskId: activeTaskIdRef.current,
      });
      if (!item) return;
      for (const out of applyNotifyThrottle([item], throttle, Date.now())) sendTaskNotification(out);
    });
  }, []);

  return null;
};
