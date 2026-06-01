"use client";

/**
 * 读 Cursor 全局 MCP 配置（`~/.cursor/mcp.json`）的共享 hook
 *
 * 背景（V0.6.2「跟 Cursor 共用工具」）：fe 不再让用户在设置页编辑 MCP、改为直接展示
 * Cursor 的配置（单一源、用户在 Cursor 改）。本 hook 封装「fetch + loading + error +
 * focus 自动刷新」、给三类调用方复用：
 *   - 设置页 mcp-card：只读展示完整 servers
 *   - new-task-dialog / task-mcp-panel：拿 server 名列表当「黑名单候选源」
 *
 * focus 刷新：用户可能切到 Cursor 改了 mcp.json 再切回来、focus 时重拉一次保持同步。
 */

import { useCallback, useEffect, useState } from "react";
import type { McpServerConfig } from "@cursor/sdk";

import { fetchCursorMcp } from "@/lib/task-store";

export interface UseCursorMcpResult {
  // mcp.json 里的 mcpServers 原样
  servers: Record<string, McpServerConfig>;
  // server 名列表（黑名单候选源用）、servers 的 key
  names: string[];
  // 读取候选目录（展示来源路径）
  dirs: string[];
  // 首次加载中（仅首次 true、focus 刷新不翻 true、避免列表闪烁）
  loading: boolean;
  // 读取出错信息（一般是 server 端异常、mcp.json 不存在不算错、返空对象）
  error: string | null;
  // 手动重拉
  refresh: () => void;
}

/**
 * @param enabled false 时不发请求（如 dialog 没打开）、默认 true
 */
export const useCursorMcp = (enabled = true): UseCursorMcpResult => {
  // cursor mcp.json 解析出的 servers（key=名、value=配置）
  const [servers, setServers] = useState<Record<string, McpServerConfig>>({});
  // 配置来源候选目录
  const [dirs, setDirs] = useState<string[]>([]);
  // 首次加载标志、focus 重拉不翻它（enabled 时初始即 true、避免首帧闪空态）
  const [loading, setLoading] = useState(enabled);
  // 读取错误
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchCursorMcp()
      .then((data) => {
        setServers(data.servers);
        setDirs(data.dirs);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    refresh();
    // 切回窗口时重拉（用户可能在 Cursor 改了 mcp.json）
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, refresh]);

  return {
    servers,
    names: Object.keys(servers),
    dirs,
    loading,
    error,
    refresh,
  };
};
