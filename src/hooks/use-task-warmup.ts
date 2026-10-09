"use client";

/**
 * 任务预热触发（v1.9.28）：进入任务页 / 窗口回到前台 / 聚焦输入框时，
 * 后台 POST /api/tasks/[id]/warmup——趁用户还在敲字，刷新 MCP 探活缓存、预读会话存储，
 * 让首条消息少等一轮冷启动。去抖 + 节流逻辑在 lib/warmup-scheduler.ts（可单测）。
 *
 * 为什么不并进 use-task-watch：那个 hook 带大量重连策略和测试，预热与它的职责无关，
 * 独立一个小 hook 影响面最小。只在页面级挂一处（chat / task 两种模式的页面都渲染它）。
 */
import { useEffect } from "react";

import { createWarmupScheduler } from "@/lib/warmup-scheduler";

/** 光标进了「要打字的地方」才算（textarea / contenteditable）；点按钮、选文字不算 */
const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === "TEXTAREA" || target.isContentEditable);

export const useTaskWarmup = (taskId: string | null | undefined): void => {
  useEffect(() => {
    if (!taskId) return;
    const scheduler = createWarmupScheduler({
      isVisible: () => document.visibilityState === "visible",
      send: (id) => {
        void fetch(`/api/tasks/${encodeURIComponent(id)}/warmup`, {
          method: "POST",
          keepalive: true,
        }).catch(() => undefined);
      },
    });
    const ask = (): void => scheduler.request(taskId);
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") ask();
    };
    const onFocusIn = (e: FocusEvent): void => {
      if (isTypingTarget(e.target)) ask();
    };

    ask(); // 进入任务页本身就是强信号：多半马上要发消息
    window.addEventListener("focus", ask);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("focus", ask);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusin", onFocusIn);
      scheduler.cancel();
    };
  }, [taskId]);
};
