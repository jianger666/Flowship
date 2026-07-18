"use client";

/**
 * 自定义协议深链（flowship://tasks/<id>）路由处理器
 *
 * Electron preload 暴露 window.__deepLink.onDeepLink：壳解析 URL 后推送 taskId，
 * 这里负责 router.push 到对应任务页。非桌面端无通道时静默 no-op。
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

declare global {
  interface Window {
    /** Electron preload 暴露的深链通道（仅桌面端有） */
    __deepLink?: {
      onDeepLink: (callback: (payload: { taskId: string }) => void) => () => void;
    };
  }
}

/** 挂载时订阅深链 → 跳转 /tasks/<taskId>；卸载取消订阅 */
export const DeepLinkHandler = () => {
  const router = useRouter();

  useEffect(() => {
    const unsub = window.__deepLink?.onDeepLink((payload) => {
      const taskId = typeof payload?.taskId === "string" ? payload.taskId.trim() : "";
      if (!taskId) return;
      router.push(`/tasks/${taskId}`);
    });
    return () => unsub?.();
  }, [router]);

  return null;
};
