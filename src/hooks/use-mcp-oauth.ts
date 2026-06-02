"use client";

/**
 * MCP OAuth 授权状态 + 动作 hook（设置页 MCP 卡片用）
 *
 * 背景（V0.6.4）：走 OAuth 的远程 MCP（如飞书项目）token 不在 mcp.json、由 fe 自己跑 OAuth
 * 落盘。本 hook 封装「拉授权状态 + 发起授权（开浏览器）+ 撤销」、并在授权窗口回调成功
 * （postMessage）/ 用户切回窗口（focus）时自动刷新状态。
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  fetchMcpOAuthStatuses,
  revokeMcpOAuth,
  startMcpOAuth,
  type McpOAuthStatus,
} from "@/lib/task-store";

export const useMcpOAuth = () => {
  // 各 server 的授权状态（key=serverName）
  const [statuses, setStatuses] = useState<Record<string, McpOAuthStatus>>({});
  // 正在授权 / 撤销中的 server 名（禁用按钮、避免重复点）
  const [busy, setBusy] = useState<string | null>(null);

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
    const onFocus = () => refresh();
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  /**
   * 发起授权：先同步开一个空白窗口（保住用户手势、避免 await 后 open 被浏览器拦截）、
   * 再请求授权 URL 并把窗口跳过去。DCR 首次注册可能要几秒、空白窗口先显示「准备中」。
   */
  const authorize = useCallback(
    async (serverName: string) => {
      const win = window.open(
        "about:blank",
        "_blank",
        "width=540,height=720",
      );
      if (win) {
        win.document.write(
          "<p style='font:14px sans-serif;color:#888;padding:24px'>正在准备授权…</p>",
        );
      }
      setBusy(serverName);
      try {
        const res = await startMcpOAuth(serverName);
        if (res.alreadyAuthorized) {
          win?.close();
          toast.success(`${serverName} 已授权`);
          refresh();
          return;
        }
        if (res.authorizationUrl) {
          if (win) win.location.href = res.authorizationUrl;
          else window.open(res.authorizationUrl, "_blank");
        } else {
          win?.close();
          toast.error("未拿到授权地址");
        }
      } catch (err) {
        win?.close();
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
