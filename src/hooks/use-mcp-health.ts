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

import { createGenerationGuard, runGuardedTask } from "@/lib/cancel-slot";
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
  // 代际守卫：每次「面板打开」领一个新代号、关闭 / 卸载整体作废，in-flight probe 只认自己启动时的代号。
  // 不能用布尔 alive 位：关面板→快速重开时它又变回 true，旧探测迟到的 finally 会把新探测的 spinner 提前清掉、
  // 旧结果也会并进新一代的 health
  const [guard] = useState(createGenerationGuard);

  // 探一组 server、结果 merge 进 health（不动其它 server 的旧状态）。
  // 并发语义（无存活代不探、过期代的结果 / 错误 / 清 loading 一律丢弃）收在 runGuardedTask 里（有行为测试）
  const probe = useCallback(
    async (servers: string[]) => {
      if (servers.length === 0) return;
      await runGuardedTask(guard, () => fetchMcpHealth(servers), {
        onStart: () => setLoadingServers((prev) => new Set([...prev, ...servers])),
        onResult: (h) => {
          setHealth((prev) => ({ ...prev, ...h }));
          setError(null);
        },
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
        onSettled: () =>
          setLoadingServers((prev) => {
            const next = new Set(prev);
            servers.forEach((s) => next.delete(s));
            return next;
          }),
      });
    },
    [guard],
  );

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
    guard.next();
    refresh();
    return () => {
      guard.invalidate();
      // 关面板 / 卸载时在途探测的结果会被丢弃（上面的代际守卫），它们 finally 里的清 loading 也会被跳过——
      // 不在这里清的话 loadingServers 里残留旋转图标（面板重开时对已关掉的 server 一直转）
      setLoadingServers((prev) => (prev.size === 0 ? prev : new Set()));
    };
  }, [active, refresh, guard]);

  return { health, loadingServers, error, refresh, probeOne };
};
