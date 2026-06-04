"use client";

/**
 * 探测 Cursor MCP 各 server 连通性的共享 hook（V0.6.11）
 *
 * 给设置页 mcp-card + 任务 MCP 面板复用：拉 `/api/cursor-mcp/health`、封装
 * loading / error / 手动重测。探测要发网络请求（每个远程 MCP 一个 initialize、~6s 超时）、
 * 所以用 enabled 控制——dialog 没打开时不拉、避免无谓请求。
 */

import { useCallback, useEffect, useState } from "react";

import type { McpHealth } from "@/lib/types";
import { fetchMcpHealth } from "@/lib/task-store";

export interface UseMcpHealthResult {
  // 各 server 连通性（key=server 名）
  health: Record<string, McpHealth>;
  // 探测进行中（首拉 + 重测都翻 true、UI 据此显示 spinner）
  loading: boolean;
  // 探测出错信息
  error: string | null;
  // 手动重新检测
  refresh: () => void;
}

/**
 * @param enabled false 时不拉（如 dialog 没打开）、默认 true
 */
export const useMcpHealth = (enabled = true): UseMcpHealthResult => {
  // 各 server 连通性探测结果
  const [health, setHealth] = useState<Record<string, McpHealth>>({});
  // 探测进行中
  const [loading, setLoading] = useState(enabled);
  // 探测错误
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchMcpHealth()
      .then((h) => {
        setHealth(h);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  return { health, loading, error, refresh };
};
