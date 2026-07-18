"use client";

/**
 * 读 MCP 配置的共享 hook（V0.13 独立化后语义）
 *
 * - `servers` = **运行时有效集（fe 自管配置）**——new-task-dialog / task-mcp-panel /
 *   chat-mcp-picker 拿它当「黑名单候选源」
 * - `cursorServers` = Cursor `~/.cursor/mcp.json` 原样——仅设置页「从 Cursor 导入」dialog 用
 *
 * 封装「fetch + loading + error + focus 自动刷新」；focus 刷新兜「设置页改完切回任务页」的同步。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpServerConfig } from "@cursor/sdk";

import { fetchCursorMcp } from "@/lib/task-store";

export interface UseCursorMcpResult {
  /** 运行时有效 MCP（= fe 自管、黑名单候选 / 飞书校验用） */
  servers: Record<string, McpServerConfig>;
  /** Cursor 侧配置（仅「从 Cursor 导入」dialog 用） */
  cursorServers: Record<string, McpServerConfig>;
  names: string[];
  dirs: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * @param enabled false 时不发请求（如 dialog 没打开）、默认 true
 */
export const useCursorMcp = (enabled = true): UseCursorMcpResult => {
  // cursor mcp.json 解析出的 servers（key=名、value=配置）
  const [servers, setServers] = useState<Record<string, McpServerConfig>>({});
  const [cursorServers, setCursorServers] = useState<
    Record<string, McpServerConfig>
  >({});
  // 配置来源候选目录
  const [dirs, setDirs] = useState<string[]>([]);
  // 首次加载标志、focus 重拉不翻它（enabled 时初始即 true、避免首帧闪空态）
  const [loading, setLoading] = useState(enabled);
  // 读取错误
  const [error, setError] = useState<string | null>(null);
  // 卸载 / effect cleanup 后 in-flight 不再 setState
  const aliveRef = useRef(false);

  const refresh = useCallback(() => {
    fetchCursorMcp()
      .then((data) => {
        if (!aliveRef.current) return;
        setServers(data.servers);
        setCursorServers(data.cursor);
        setDirs(data.dirs);
        setError(null);
      })
      .catch((err) => {
        if (!aliveRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!aliveRef.current) return;
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    aliveRef.current = true;
    setLoading(true);
    refresh();
    // 切回窗口时重拉（用户可能在 Cursor 改了 mcp.json）
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      aliveRef.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, refresh]);

  return {
    servers,
    cursorServers,
    names: Object.keys(servers),
    dirs,
    loading,
    error,
    refresh,
  };
};
