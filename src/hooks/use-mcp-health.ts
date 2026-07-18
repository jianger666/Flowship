"use client";

/**
 * 探测 Cursor MCP 各 server 连通性的共享 hook（V0.6.11、V0.6.13 改增量探测）
 *
 * 给设置页 mcp-card + 任务 MCP 面板复用。探测要发网络请求（每个远程 MCP 一个 initialize、
 * ~6s 超时），所以：
 * - 只探「已开启」的 server（enabledServers）——关闭的不连、不浪费那 6s（对齐 Cursor）。
 * - 用 active 控制——dialog 没打开时不拉。
 * - probeOne：用户把某个 server 关→开时单独探这一个、只这行转圈（per-server loading）。
 *
 * 注意：active / refresh 只在「打开面板」时触发一次全量探（探当时开启的那批）；后续 toggle
 * 开一个走 probeOne、不会因 enabledServers 变化而全量重探——用 ref 存最新列表、effect 不依赖
 * 它（同 use-task-watch 的 ref 模式、避免 stale closure 又不触发无谓重连）。
 *
 * V0.6.13 修首探竞态：调用方必须保证 active 在「enabledServers ready 之后」才置 true
 * （设置页传 `!loading`、详情页传 `open && !loading`）。否则首帧 useCursorMcp 异步还没回来、
 * enabledServers=[]、首探探到空集合、之后 ref 模式 + effect 不依赖列表就再也不重探了。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { McpHealth } from "@/lib/types";
import { fetchMcpHealth } from "@/lib/task-store";

export interface UseMcpHealthResult {
  // 各 server 连通性（key=server 名、只含探过的）
  health: Record<string, McpHealth>;
  // 正在探测的 server 集合（per-server spinner、哪行探哪行转圈）
  loadingServers: Set<string>;
  // 探测出错信息
  error: string | null;
  // 重新检测所有「已开启」的
  refresh: () => void;
  // 单独探一个（把某 server 关→开时调）
  probeOne: (server: string) => void;
}

/**
 * @param enabledServers 要探的「已开启」server 列表（关闭的不探）
 * @param active false 时不拉（如 dialog 没打开）、默认 true
 */
export const useMcpHealth = (
  enabledServers: string[],
  active = true,
): UseMcpHealthResult => {
  // 各 server 连通性探测结果
  const [health, setHealth] = useState<Record<string, McpHealth>>({});
  // 正在探测的 server（per-server spinner）
  const [loadingServers, setLoadingServers] = useState<Set<string>>(new Set());
  // 探测错误
  const [error, setError] = useState<string | null>(null);
  // 卸载 / effect cleanup 后 in-flight probe 不再 setState
  const aliveRef = useRef(false);

  // 探一组 server、结果 merge 进 health（不动其它 server 的旧状态）
  const probe = useCallback(async (servers: string[]) => {
    if (servers.length === 0) return;
    if (!aliveRef.current) return;
    setLoadingServers((prev) => new Set([...prev, ...servers]));
    try {
      const h = await fetchMcpHealth(servers);
      if (!aliveRef.current) return;
      setHealth((prev) => ({ ...prev, ...h }));
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!aliveRef.current) return;
      setLoadingServers((prev) => {
        const next = new Set(prev);
        servers.forEach((s) => next.delete(s));
        return next;
      });
    }
  }, []);

  // 用 ref 存最新「开启列表」、让 refresh / effect 不直接依赖它
  // （否则 toggle 开一个 → enabledServers 变 → effect 重跑 → 全量重探、违背「只探单个」）
  const enabledRef = useRef(enabledServers);
  enabledRef.current = enabledServers;

  const refresh = useCallback(() => {
    void probe(enabledRef.current);
  }, [probe]);

  const probeOne = useCallback(
    (server: string) => {
      void probe([server]);
    },
    [probe],
  );

  // 只在「面板打开 + 列表 ready」(active false→true) 时全量探一次（探当时开启的那批）
  // active 由调用方保证「enabledServers ready 后才 true」（见顶部 V0.6.13 注释、否则探到空集合）
  useEffect(() => {
    if (!active) return;
    aliveRef.current = true;
    refresh();
    return () => {
      aliveRef.current = false;
    };
  }, [active, refresh]);

  return { health, loadingServers, error, refresh, probeOne };
};
