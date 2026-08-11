"use client";

/**
 * 组共享库状态 + 可安装 action 列表
 *
 * Skills 卡（同步 / 镜像）与 Action tab「共享市场」共用，
 * 避免两处各自写 fetch + 错误处理。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/** GET /api/team-library 的 status 字段 */
export type TeamLibraryStatus = {
  configured: boolean;
  cloned: boolean;
  syncedAt: number | null;
  needsToken: boolean;
  /** 仅特定账号可见「更新知识库镜像」；server 未回时按 false */
  canMirror: boolean;
};

/** 共享库里带 .flowship-action.json 的可安装 action */
export type TeamActionEntry = {
  dirPath: string;
  skillName: string;
  label: string;
  description?: string;
  output?: string;
  placeholder?: string;
  installed: boolean;
  /** 创建人（共享库 git 首次引入者） */
  author?: string;
};

export type UseTeamLibraryResult = {
  status: TeamLibraryStatus | null;
  actions: TeamActionEntry[];
  /** 首次 / 刷新中 */
  loading: boolean;
  refresh: () => Promise<void>;
};

const EMPTY_STATUS: TeamLibraryStatus = {
  configured: false,
  cloned: false,
  syncedAt: null,
  needsToken: true,
  canMirror: false,
};

/** 归一 status：兼容 server 暂未回 canMirror 的过渡期 */
const normalizeStatus = (raw: Partial<TeamLibraryStatus> | null | undefined): TeamLibraryStatus => ({
  configured: !!raw?.configured,
  cloned: !!raw?.cloned,
  syncedAt: typeof raw?.syncedAt === "number" ? raw.syncedAt : null,
  needsToken: !!raw?.needsToken,
  canMirror: !!raw?.canMirror,
});

/**
 * @param active false 时不拉（如所在 tab 未展示）——默认 true
 * @param opts.autoSyncOnActive true = 激活（挂载）时先静默 sync 一次再读——
 *   用于「共享市场」这类希望打开就看到最新的页面（git 拉取失败静默、读本地缓存兜底）
 */
export const useTeamLibrary = (
  active = true,
  opts?: { autoSyncOnActive?: boolean },
): UseTeamLibraryResult => {
  // 共享库 clone / token / 镜像权限等
  const [status, setStatus] = useState<TeamLibraryStatus | null>(null);
  // 可安装的 team action 列表
  const [actions, setActions] = useState<TeamActionEntry[]>([]);
  // 拉取中（首屏 inline loading / 刷新不强制清空旧数据）
  const [loading, setLoading] = useState(false);
  // 进行中的 refresh 请求；新 refresh / 卸载时 abort，避免卸载后 setState
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    try {
      const res = await fetch("/api/team-library", {
        cache: "no-store",
        signal: ac.signal,
      });
      const data = (await res.json()) as {
        ok?: boolean;
        status?: Partial<TeamLibraryStatus>;
        actions?: TeamActionEntry[];
        error?: string;
      };
      if (ac.signal.aborted) return;
      if (!res.ok) {
        toast.error(data.error ?? "读取共享库失败");
        // 失败时留空状态骨架、避免 UI 空白无提示
        setStatus((prev) => prev ?? EMPTY_STATUS);
        return;
      }
      setStatus(normalizeStatus(data.status));
      setActions(Array.isArray(data.actions) ? data.actions : []);
    } catch (err) {
      if (ac.signal.aborted) return;
      // AbortError 静默（卸载 / 新 refresh 顶掉旧请求）
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast.error(
        `读取共享库失败：${err instanceof Error ? err.message : String(err)}`,
      );
      setStatus((prev) => prev ?? EMPTY_STATUS);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    // 首次挂载 abortRef 还是 null：effect 自持一个 controller，sync 也可被
    // 卸载 / 新 refresh 取消；refresh 内部会接管 abortRef，cleanup 取消最新请求
    const ac = new AbortController();
    abortRef.current = ac;
    const run = async () => {
      if (opts?.autoSyncOnActive) {
        // 静默 sync：失败不 toast（走本地缓存兜底）、手动「同步」按钮仍有自己的反馈
        try {
          const res = await fetch("/api/team-library/sync", {
            method: "POST",
            signal: ac.signal,
          });
          if (!res.ok) {
            // 没配 token 等场景：读缓存展示、由页面状态引导
          }
        } catch {
          // AbortError（卸载）/ 网络错：静默
        }
      }
      if (ac.signal.aborted) return;
      await refresh();
    };
    void run();
    return () => {
      // 卸载 / active 关掉：取消进行中的请求，防 setState on unmounted
      abortRef.current?.abort();
    };
  }, [active, refresh, opts?.autoSyncOnActive]);

  return { status, actions, loading, refresh };
};
