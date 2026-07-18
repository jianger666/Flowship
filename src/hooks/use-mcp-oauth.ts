"use client";

/**
 * MCP OAuth 授权状态 + 动作 hook（设置页 MCP 卡片用）
 *
 * 背景（V0.6.4）：走 OAuth 的远程 MCP（如飞书项目）token 不在 mcp.json、由 fe 自己跑 OAuth
 * 落盘。本 hook 封装「拉授权状态 + 发起授权（开浏览器）+ 撤销」、并在授权窗口回调成功
 * （postMessage）/ 用户切回窗口（focus）时自动刷新状态。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  fetchMcpOAuthStatuses,
  revokeMcpOAuth,
  startMcpOAuth,
  type McpOAuthStatus,
} from "@/lib/task-store";

/** focus 自动刷新最小间隔——频繁切窗别狂刷 */
const FOCUS_REFRESH_MIN_MS = 5_000;

export const useMcpOAuth = () => {
  // 各 server 的授权状态（key=serverName）
  const [statuses, setStatuses] = useState<Record<string, McpOAuthStatus>>({});
  // 正在授权 / 撤销中的 server 名（禁用按钮、避免重复点）
  const [busy, setBusy] = useState<string | null>(null);
  const lastFocusRefreshAtRef = useRef(0);

  const refresh = useCallback(() => {
    fetchMcpOAuthStatuses()
      .then(setStatuses)
      .catch(() => {
        // 状态拉取失败不打扰用户（多半是还没授权过任何 server）
      });
  }, []);

  useEffect(() => {
    refresh();
    // 回调页授权成功会 postMessage、或用户切回本窗口 → 刷新状态
    const onMessage = (e: MessageEvent) => {
      if (
        e.data &&
        typeof e.data === "object" &&
        (e.data as { type?: string }).type === "mcp-oauth"
      ) {
        refresh();
      }
    };
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusRefreshAtRef.current < FOCUS_REFRESH_MIN_MS) return;
      lastFocusRefreshAtRef.current = now;
      refresh();
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  /**
   * 发起授权：拿到授权 URL 后 window.open → 壳 setWindowOpenHandler 拦截、deny 后
   * shell.openExternal 转系统默认浏览器（v0.7.4 用户拍板）；授权完用户切回应用窗口靠
   * focus 监听刷新状态。
   */
  const authorize = useCallback(
    async (serverName: string) => {
      setBusy(serverName);
      try {
        const res = await startMcpOAuth(serverName);
        if (res.alreadyAuthorized) {
          toast.success(`${serverName} 已授权`);
          refresh();
          return;
        }
        if (res.authorizationUrl) {
          // 壳拦截 window.open → shell.openExternal 打开系统浏览器
          window.open(res.authorizationUrl, "_blank");
        } else {
          toast.error("未拿到授权地址");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "发起授权失败");
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const revoke = useCallback(
    async (serverName: string) => {
      setBusy(serverName);
      try {
        await revokeMcpOAuth(serverName);
        toast.success(`已撤销 ${serverName} 授权`);
        refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "撤销失败");
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return { statuses, busy, authorize, revoke, refresh };
};
