"use client";

/**
 * 收件箱全局 store（Provider 挂 providers.tsx）
 *
 * 三分组：pendingMr / myBugs / pendingRegression；未读 badge = 三组未见总和。
 * 轮询：启动即拉 + 前台每 10 分钟 + 回前台补拉（不可见不扫）。
 * 三期注意力：未读数 → app 图标角标；扫描 diff 新增未读 → 系统通知（首轮不发）。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  buildInboxNotifyCopy,
  diffInboxUnreadForNotify,
  isBugPendingFixStatus,
  listUnreadInboxItems,
  MR_INBOX_POLL_INTERVAL_MS,
} from "@/lib/mr-inbox";
import { sendTaskNotification, setInboxBadge } from "@/lib/shell-notify";

/** bug 可流转目标（GET /api/mr-inbox/bug-transitions） */
export interface BugTransitionOption {
  transitionId: string;
  targetStateKey?: string;
  targetStateLabel: string;
}

/** 待测 MR 条目 */
export interface MrInboxEntry {
  mrUrl: string;
  workItemId: string;
  workItemName: string;
  projectKey: string;
  workItemUrl?: string;
  commentSnippet: string;
  commentAtMs: number;
  mr: {
    title: string;
    sourceBranch: string;
    targetBranch: string;
    state: string;
    detailedMergeStatus: string;
    hasConflicts: boolean;
    mergeable: boolean;
  } | null;
  mrError?: string;
  seenAtMs: number | null;
}

/** bug 条目（我的 BUG / 待回归） */
export interface BugInboxEntry {
  bugUrl: string;
  workItemId: string;
  name: string;
  projectKey: string;
  statusLabel: string;
  priorityLabel?: string;
  relatedStoryId?: string;
  relatedStoryName?: string;
  seenAtMs: number | null;
}

export type MrInboxStatus = "ok" | "not_installed" | "not_authed" | "error";

interface MrInboxData {
  status: MrInboxStatus;
  pendingMr: MrInboxEntry[];
  myBugs: BugInboxEntry[];
  pendingRegression: BugInboxEntry[];
  message?: string;
  scannedAt?: number;
  gitTokenConfigured?: boolean;
}

interface MrInboxContextValue {
  data: MrInboxData | null;
  refreshing: boolean;
  unreadCount: number;
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  /** 标已读（url = mrUrl 或 bugUrl） */
  setSeen: (url: string, seen: boolean) => Promise<void>;
  mergeMr: (mrUrl: string) => Promise<void>;
  /** 懒加载某 bug 当前可流转目标 */
  listBugTransitions: (input: {
    projectKey: string;
    workItemId: string;
  }) => Promise<BugTransitionOption[]>;
  /**
   * bug 状态流转：
   * - pass / reject：待回归组；成功后从 myBugs + pendingRegression 移除
   * - transition：我的 BUG 就地切状态；仍属待修白名单则就地改 statusLabel，否则移除
   */
  transitionBug: (input: {
    bugUrl: string;
    projectKey: string;
    workItemId: string;
    action: "pass" | "reject" | "transition";
    reason?: string;
    transitionId?: string;
    targetStateKey?: string;
    targetStateLabel?: string;
  }) => Promise<{
    targetStateLabel?: string;
    stillPendingFix?: boolean;
  }>;
}

const MrInboxContext = createContext<MrInboxContextValue | null>(null);

/** 角标同步去抖（避免短时多次 setState 狂刷 IPC） */
const BADGE_DEBOUNCE_MS = 120;

const emptyGroups = (): Pick<
  MrInboxData,
  "pendingMr" | "myBugs" | "pendingRegression"
> => ({
  pendingMr: [],
  myBugs: [],
  pendingRegression: [],
});

export const MrInboxProvider = ({ children }: { children: ReactNode }) => {
  // 最近一次拉取结果（含降级态）
  const [data, setData] = useState<MrInboxData | null>(null);
  // 拉取中（首拉 + 手动刷新）
  const [refreshing, setRefreshing] = useState(false);
  const lastFetchAtRef = useRef(0);
  const refreshingRef = useRef(false);
  // 上轮未读 key 集合；null = 尚未建基线（首轮 / 降级后重建）
  const prevUnreadKeysRef = useRef<Set<string> | null>(null);
  // 上次已发给壳的角标数（相同值不重发）
  const lastBadgeCountRef = useRef<number | null>(null);
  const badgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (opts?: { force?: boolean }) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    lastFetchAtRef.current = Date.now();
    try {
      const res = await fetch(
        opts?.force ? "/api/mr-inbox?refresh=1" : "/api/mr-inbox",
      );
      const body = (await res.json()) as MrInboxData & {
        items?: MrInboxEntry[];
      };
      setData({
        status: body.status,
        pendingMr: Array.isArray(body.pendingMr) ? body.pendingMr : [],
        myBugs: Array.isArray(body.myBugs) ? body.myBugs : [],
        pendingRegression: Array.isArray(body.pendingRegression)
          ? body.pendingRegression
          : [],
        message: body.message,
        scannedAt: body.scannedAt,
        gitTokenConfigured: body.gitTokenConfigured,
      });
    } catch (err) {
      console.warn("[mr-inbox] 拉取失败:", err);
      setData((prev) =>
        prev ?? {
          status: "error",
          ...emptyGroups(),
          message: err instanceof Error ? err.message : String(err),
        },
      );
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
    };
    const interval = setInterval(tick, MR_INBOX_POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetchAtRef.current >= MR_INBOX_POLL_INTERVAL_MS) {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const setSeen = useCallback(async (url: string, seen: boolean) => {
    const patchSeen = <T extends { mrUrl?: string; bugUrl?: string; seenAtMs: number | null }>(
      list: T[],
    ): T[] =>
      list.map((it) => {
        const key = it.mrUrl ?? it.bugUrl;
        return key === url
          ? { ...it, seenAtMs: seen ? Date.now() : null }
          : it;
      });

    setData((prev) =>
      prev
        ? {
            ...prev,
            pendingMr: patchSeen(prev.pendingMr),
            myBugs: patchSeen(prev.myBugs),
            pendingRegression: patchSeen(prev.pendingRegression),
          }
        : prev,
    );
    try {
      await fetch("/api/mr-inbox/seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, seen }),
      });
    } catch (err) {
      console.warn("[mr-inbox] 标已读失败:", err);
    }
  }, []);

  const mergeMr = useCallback(async (mrUrl: string) => {
    const res = await fetch("/api/mr-inbox/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mrUrl }),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // ignore
      }
      throw new Error(message);
    }
    setData((prev) =>
      prev
        ? {
            ...prev,
            pendingMr: prev.pendingMr.filter((it) => it.mrUrl !== mrUrl),
          }
        : prev,
    );
  }, []);

  const listBugTransitions = useCallback(
    async (input: { projectKey: string; workItemId: string }) => {
      const qs = new URLSearchParams({
        projectKey: input.projectKey,
        workItemId: input.workItemId,
      });
      const res = await fetch(`/api/mr-inbox/bug-transitions?${qs}`);
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // ignore
        }
        throw new Error(message);
      }
      const body = (await res.json()) as {
        transitions?: BugTransitionOption[];
      };
      return Array.isArray(body.transitions) ? body.transitions : [];
    },
    [],
  );

  const transitionBug = useCallback(
    async (input: {
      bugUrl: string;
      projectKey: string;
      workItemId: string;
      action: "pass" | "reject" | "transition";
      reason?: string;
      transitionId?: string;
      targetStateKey?: string;
      targetStateLabel?: string;
    }) => {
      const res = await fetch("/api/mr-inbox/bug-transition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        let bugUrl = input.bugUrl;
        try {
          const body = (await res.json()) as {
            error?: string;
            bugUrl?: string;
          };
          if (body.error) message = body.error;
          if (body.bugUrl) bugUrl = body.bugUrl;
        } catch {
          // ignore
        }
        const err = new Error(message) as Error & { bugUrl?: string };
        err.bugUrl = bugUrl;
        throw err;
      }
      const body = (await res.json().catch(() => ({}))) as {
        targetStateLabel?: string;
        stillPendingFix?: boolean;
      };
      const label =
        (typeof body.targetStateLabel === "string" && body.targetStateLabel) ||
        input.targetStateLabel ||
        "";
      const stillPending =
        typeof body.stillPendingFix === "boolean"
          ? body.stillPendingFix
          : isBugPendingFixStatus(label);

      setData((prev) => {
        if (!prev) return prev;
        if (input.action === "transition" && stillPending && label) {
          // 仍属待修：就地改 statusLabel，不移出列表
          return {
            ...prev,
            myBugs: prev.myBugs.map((it) =>
              it.bugUrl === input.bugUrl
                ? { ...it, statusLabel: label }
                : it,
            ),
          };
        }
        // pass / reject / 流转出待修白名单 → 从两组移除
        return {
          ...prev,
          myBugs: prev.myBugs.filter((it) => it.bugUrl !== input.bugUrl),
          pendingRegression: prev.pendingRegression.filter(
            (it) => it.bugUrl !== input.bugUrl,
          ),
        };
      });
      return {
        targetStateLabel: label || undefined,
        stillPendingFix: stillPending,
      };
    },
    [],
  );

  // 未读总数：仅 status===ok 计数；降级 / 未登录 → 0（角标同源清零）
  const unreadCount = useMemo(() => {
    if (!data || data.status !== "ok") return 0;
    const count = (list: { seenAtMs: number | null }[]) =>
      list.filter((it) => it.seenAtMs === null).length;
    return (
      count(data.pendingMr) +
      count(data.myBugs) +
      count(data.pendingRegression)
    );
  }, [data]);

  // 未读数 → Dock / 任务栏角标（去抖 + 同值不重发；非壳 no-op）
  useEffect(() => {
    if (lastBadgeCountRef.current === unreadCount) return;
    if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current);
    badgeTimerRef.current = setTimeout(() => {
      badgeTimerRef.current = null;
      if (lastBadgeCountRef.current === unreadCount) return;
      lastBadgeCountRef.current = unreadCount;
      setInboxBadge(unreadCount);
    }, BADGE_DEBOUNCE_MS);
    return () => {
      if (badgeTimerRef.current) {
        clearTimeout(badgeTimerRef.current);
        badgeTimerRef.current = null;
      }
    };
  }, [unreadCount]);

  // Provider 卸载时清角标（避免离开页后 Dock 仍挂旧数）
  useEffect(
    () => () => {
      lastBadgeCountRef.current = 0;
      setInboxBadge(0);
    },
    [],
  );

  // 扫描结果 diff → 系统通知（首轮不发、每轮最多一条、前台不发）
  useEffect(() => {
    if (!data) return;

    // 降级态：清基线，下次 ok 当首轮（存量不推）
    if (data.status !== "ok") {
      prevUnreadKeysRef.current = null;
      return;
    }

    const items = listUnreadInboxItems(data);
    const prev = prevUnreadKeysRef.current;
    const { notify, newItems } = diffInboxUnreadForNotify(prev, items);
    prevUnreadKeysRef.current = new Set(items.map((it) => it.key));

    if (!notify || newItems.length === 0) return;
    // 与 task-attention-watcher 对齐：窗口在前台不发横幅（角标已够）
    if (typeof document !== "undefined" && document.hasFocus()) return;

    const copy = buildInboxNotifyCopy(newItems);
    if (copy) sendTaskNotification(copy);
  }, [data]);

  const value = useMemo<MrInboxContextValue>(
    () => ({
      data,
      refreshing,
      unreadCount,
      refresh,
      setSeen,
      mergeMr,
      listBugTransitions,
      transitionBug,
    }),
    [
      data,
      refreshing,
      unreadCount,
      refresh,
      setSeen,
      mergeMr,
      listBugTransitions,
      transitionBug,
    ],
  );

  return (
    <MrInboxContext.Provider value={value}>{children}</MrInboxContext.Provider>
  );
};

export const useMrInbox = (): MrInboxContextValue => {
  const ctx = useContext(MrInboxContext);
  if (!ctx) throw new Error("useMrInbox 必须在 MrInboxProvider 内使用");
  return ctx;
};
