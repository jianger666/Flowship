"use client";

/**
 * 点 X 关闭的二次确认（2026-07-20 用户拍板、mac/win 同款）
 *
 * 主进程拦下 close 事件 → preload `__closeConfirm` 转进来 → 弹 app 内
 * destructive confirm（红色「关闭」键）→ 结果回传主进程决定是否真退出。
 * 非桌面端无通道时静默 no-op。
 */

import { useEffect } from "react";

import { useDialog } from "@/hooks/use-dialog";

declare global {
  interface Window {
    /** Electron preload 暴露的关闭确认通道（仅桌面端有） */
    __closeConfirm?: {
      onRequest: (callback: (payload: { appName: string }) => void) => () => void;
      respond: (confirmed: boolean) => void;
    };
  }
}

export const CloseConfirmHandler = () => {
  const { confirm } = useDialog();

  useEffect(() => {
    const unsub = window.__closeConfirm?.onRequest((payload) => {
      void (async () => {
        const ok = await confirm({
          title: `确定关闭 ${payload?.appName ?? "Flowship"} 吗？`,
          description: "后台任务与飞书桥接会一并退出",
          confirmLabel: "关闭",
          destructive: true,
        });
        window.__closeConfirm?.respond(ok);
      })();
    });
    return () => unsub?.();
  }, [confirm]);

  return null;
};
