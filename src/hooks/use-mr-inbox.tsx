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
  stripBugMrFields,
  type MrInboxMrDetail,
} from "@/lib/mr-inbox";
import { buildIgnoredMeta } from "@/lib/mr-inbox-ignored-meta";
import {
  applyInboxPatches,
  createInboxRefreshGate,
  nextDataOnScanFailure,
  removeInboxUrl,
  restoreInboxSnapshot,
  runCoalescedInboxRefresh,
  snapshotInboxUrl,
  type InboxIgnoredSnapshot,
  type InboxPatch,
} from "@/lib/mr-inbox-state";
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
  mr: MrInboxMrDetail | null;
  mrError?: string;
  seenAtMs: number | null;
}

/** bug 条目（我的 BUG / 待回归；MR 字段仅待回归组会填） */
export interface BugInboxEntry {
  bugUrl: string;
  workItemId: string;
  name: string;
  projectKey: string;
  statusLabel: string;
  priorityLabel?: string;
  relatedStoryId?: string;
  relatedStoryName?: string;
  /** 关联 MR URL（评论里抠到的） */
  mrUrl?: string;
  /** GitLab 详情；无 token 时为 null */
  mr?: MrInboxMrDetail | null;
  mrError?: string;
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
  /**
   * 最近一次扫描的失败文案（null = 无错）。S13-05：失败时 data 保留上一次成功的列表，
   * 面板据此在列表上方挂错误条，而不是清空整表。
   */
  scanError: string | null;
  unreadCount: number;
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  /** 标已读（url = mrUrl 或 bugUrl） */
  setSeen: (url: string, seen: boolean) => Promise<void>;
  /** 批量标已读（POST 成功后再改本地 seenAtMs；失败抛错给调用方 toast） */
  markAllSeen: (urls: string[]) => Promise<void>;
  mergeMr: (mrUrl: string) => Promise<void>;
  /** 忽略条目（url = mrUrl 或 bugUrl）：从三组移除；返回快照供「撤销」 */
  ignoreItem: (url: string) => Promise<IgnoredSnapshot>;
  /** 撤销忽略：服务端取消忽略 + 本地塞回条目 + 后台强制重扫（常驻「已忽略」列表的恢复也走它，快照只带 url） */
  restoreIgnored: (snapshot: IgnoredSnapshot) => Promise<void>;
  /** 忽略名单版本号：忽略 / 恢复成功后 +1，「已忽略」列表据此重新拉取 */
  ignoredRev: number;
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

/** 忽略前的条目快照（撤销用） */
export type IgnoredSnapshot = InboxIgnoredSnapshot<
  MrInboxEntry,
  BugInboxEntry
>;

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
  // 上次发起拉取的时间（回前台补拉判断是否过期）
  const lastFetchAtRef = useRef(0);
  // 刷新闸门：在飞标记 + 尾随 force 登记（调度见 mr-inbox-state 的 requestInboxRefresh）
  const refreshGateRef = useRef(createInboxRefreshGate());
  // 最近一次扫描的失败文案（成功即清）
  const [scanError, setScanError] = useState<string | null>(null);
  // 忽略名单版本号（忽略 / 恢复成功 +1，「已忽略」列表依赖它重拉）
  const [ignoredRev, setIgnoredRev] = useState(0);
  // 最新 data 镜像（忽略前取快照用；不在渲染期写 ref）
  const dataRef = useRef<MrInboxData | null>(null);
  // S13-04：扫描 in-flight 期间发生的本地乐观变换，响应回来后按序重放到新结果上，
  // 否则慢扫描的整表覆盖会让刚忽略 / 合并 / 流转 / 标已读的条目「复活」
  const pendingPatchesRef = useRef<InboxPatch<MrInboxData>[]>([]);
  // 上轮未读 key 集合；null = 尚未建基线（首轮 / 降级后重建）
  const prevUnreadKeysRef = useRef<Set<string> | null>(null);
  // 上次已发给壳的角标数（相同值不重发）
  const lastBadgeCountRef = useRef<number | null>(null);
  const badgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  /** 本地乐观变换：立刻改 data；扫描进行中则同时记入补丁队列，供响应回来后重放 */
  const applyPatch = useCallback((patch: InboxPatch<MrInboxData>) => {
    if (refreshGateRef.current.running) pendingPatchesRef.current.push(patch);
    setData((prev) => (prev ? patch(prev) : prev));
  }, []);

  /**
   * 扫描失败：上一次成功的列表 / 角标 / 通知基线都保留（data 不动），只记 scanError；
   * 没有成功基线（首拉失败 / 降级态）才落成 error 态。
   */
  const failScan = useCallback((message: string) => {
    setScanError(message);
    setData((prev) =>
      nextDataOnScanFailure<MrInboxData>(prev, message, (msg) => ({
        status: "error",
        ...emptyGroups(),
        message: msg,
      })),
    );
  }, []);

  /**
   * 单轮扫描：拉一次、重放补丁、落 data。只管这一轮，不管闸门 / refreshing 状态
   * （调度由 refresh → runCoalescedInboxRefresh 负责，才能在在飞时登记尾随 force）。
   */
  const scanOnce = useCallback(async (force: boolean) => {
    pendingPatchesRef.current = [];
    lastFetchAtRef.current = Date.now();
    try {
      const res = await fetch(
        force ? "/api/mr-inbox?refresh=1" : "/api/mr-inbox",
      );
      // 审查：HTTP 非 2xx 时 body 可能是 { error }、不能当成功列表写（会把三组清成 []）
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const errBody = (await res.json()) as { error?: string };
          if (errBody.error) message = errBody.error;
        } catch {
          // ignore
        }
        failScan(message);
        return;
      }
      const body = (await res.json()) as MrInboxData & {
        items?: MrInboxEntry[];
      };
      // 服务端 200 但 status:"error"（扫描中途 meegle / 网络瞬断）同样算失败：不覆盖上次成功的列表
      if (body.status === "error") {
        failScan(body.message || "未知错误");
        return;
      }
      const fresh: MrInboxData = {
        status: body.status,
        pendingMr: Array.isArray(body.pendingMr) ? body.pendingMr : [],
        myBugs: Array.isArray(body.myBugs) ? body.myBugs : [],
        pendingRegression: Array.isArray(body.pendingRegression)
          ? body.pendingRegression
          : [],
        message: body.message,
        scannedAt: body.scannedAt,
        gitTokenConfigured: body.gitTokenConfigured,
      };
      // 把扫描期间发生的乐观操作重放到新结果上（同步段内取走队列、不留窗口）
      const patches = pendingPatchesRef.current;
      pendingPatchesRef.current = [];
      setScanError(null);
      setData(applyInboxPatches(fresh, patches));
    } catch (err) {
      console.warn("[mr-inbox] 拉取失败:", err);
      failScan(err instanceof Error ? err.message : String(err));
    } finally {
      pendingPatchesRef.current = [];
    }
  }, [failScan]);

  /**
   * 刷新入口。force 遇到在飞的刷新**不丢弃**：登记一次尾随 force（多次合并成一次），
   * 在飞的这次结束后立刻再 force 扫一遍（N9-01）——撤销忽略 / 合并后的 force 是要「操作之后重扫」，
   * 在飞的那次是操作之前发起的，拿到的是旧结果，丢掉 force 会让条目顺序 / 详情停在乐观快照上。
   * 普通（轮询 / 回前台）刷新有在飞的就并入，行为不变。
   */
  const refresh = useCallback(
    (opts?: { force?: boolean }) =>
      runCoalescedInboxRefresh({
        gateRef: refreshGateRef,
        force: opts?.force === true,
        scanOnce,
        onStart: () => setRefreshing(true),
        onSettled: () => setRefreshing(false),
      }),
    [scanOnce],
  );

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
    // 分组各用各的 key：MR→mrUrl、bug→bugUrl（待回归 bug 行也带 mrUrl，不能用 ?? 串）
    const seenPatch =
      (nextSeenAt: number | null): InboxPatch<MrInboxData> =>
      (d) => ({
        ...d,
        pendingMr: d.pendingMr.map((it) =>
          it.mrUrl === url ? { ...it, seenAtMs: nextSeenAt } : it,
        ),
        myBugs: d.myBugs.map((it) =>
          it.bugUrl === url ? { ...it, seenAtMs: nextSeenAt } : it,
        ),
        pendingRegression: d.pendingRegression.map((it) =>
          it.bugUrl === url ? { ...it, seenAtMs: nextSeenAt } : it,
        ),
      });

    // 乐观更新；失败回滚（审查：原实现不查 res.ok、假标已读）
    // 走 applyPatch：扫描 in-flight 时记入补丁队列，响应回来后重放（S13-04）
    const hitMr = dataRef.current?.pendingMr.find((it) => it.mrUrl === url);
    const hitBug = [
      ...(dataRef.current?.myBugs ?? []),
      ...(dataRef.current?.pendingRegression ?? []),
    ].find((it) => it.bugUrl === url);
    const hit = hitMr ?? hitBug;
    // 注意：不能用 ?? 取值——seenAtMs 本身可能是 null（未读），会被误当「没命中」而丢回滚
    const previousSeenAt: number | null | undefined = hit
      ? hit.seenAtMs
      : undefined;
    applyPatch(seenPatch(seen ? Date.now() : null));
    const rollback = () => {
      if (previousSeenAt === undefined) return;
      applyPatch(seenPatch(previousSeenAt));
    };
    try {
      const res = await fetch("/api/mr-inbox/seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, seen }),
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // ignore
        }
        rollback();
        console.warn("[mr-inbox] 标已读失败:", message);
        return;
      }
    } catch (err) {
      rollback();
      console.warn("[mr-inbox] 标已读失败:", err);
    }
  }, [applyPatch]);

  /** 批量标已读：等接口成功再改本地（失败可重试、不乐观误标） */
  const markAllSeen = useCallback(async (urls: string[]) => {
    const unique = [...new Set(urls.filter((u) => u.trim().length > 0))];
    if (unique.length === 0) return;
    const res = await fetch("/api/mr-inbox/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: unique, seen: true }),
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
    const now = Date.now();
    const keySet = new Set(unique);
    // 分组各用各的 key：MR→mrUrl、bug→bugUrl（bug 行也可能带 mrUrl，不能用 ?? 串）
    applyPatch((d) => ({
      ...d,
      pendingMr: d.pendingMr.map((it) =>
        keySet.has(it.mrUrl) ? { ...it, seenAtMs: now } : it,
      ),
      myBugs: d.myBugs.map((it) =>
        keySet.has(it.bugUrl) ? { ...it, seenAtMs: now } : it,
      ),
      pendingRegression: d.pendingRegression.map((it) =>
        keySet.has(it.bugUrl) ? { ...it, seenAtMs: now } : it,
      ),
    }));
  }, [applyPatch]);

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
    // 待测 MR：整条剔除；待回归 / 我的 BUG：只清 MR 关联（与 markBugMrMergedInCache 对齐）
    const clearBugMr = (it: BugInboxEntry): BugInboxEntry =>
      it.mrUrl === mrUrl ? stripBugMrFields(it) : it;
    applyPatch((d) => ({
      ...d,
      pendingMr: d.pendingMr.filter((it) => it.mrUrl !== mrUrl),
      myBugs: d.myBugs.map(clearBugMr),
      pendingRegression: d.pendingRegression.map(clearBugMr),
    }));
  }, [applyPatch]);

  /**
   * 忽略：POST 成功后从三组都 filter 掉该 url（先请求再本地移除，对齐 transitionBug）。
   * 返回被移除条目的快照，调用方可据此给「撤销」（S13-19）。
   */
  const ignoreItem = useCallback(async (url: string) => {
    const snapshot: IgnoredSnapshot = dataRef.current
      ? snapshotInboxUrl(dataRef.current, url)
      : { url };
    const res = await fetch("/api/mr-inbox/ignore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // meta：条目简要信息（标题 / 分组 / 引用），供常驻「已忽略」列表展示
      body: JSON.stringify({ url, meta: buildIgnoredMeta(snapshot) }),
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
    applyPatch((d) => removeInboxUrl(d, url));
    setIgnoredRev((n) => n + 1);
    return snapshot;
  }, [applyPatch]);

  /** 撤销忽略：服务端取消忽略 → 本地幂等塞回 → 后台强制重扫校正顺序 / 详情 */
  const restoreIgnored = useCallback(
    async (snapshot: IgnoredSnapshot) => {
      const res = await fetch("/api/mr-inbox/ignore", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: snapshot.url }),
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
      applyPatch((d) => restoreInboxSnapshot(d, snapshot));
      setIgnoredRev((n) => n + 1);
      void refresh({ force: true });
    },
    [applyPatch, refresh],
  );

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

      applyPatch((prev) => {
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
    [applyPatch],
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
      scanError,
      unreadCount,
      refresh,
      setSeen,
      markAllSeen,
      mergeMr,
      ignoreItem,
      restoreIgnored,
      ignoredRev,
      listBugTransitions,
      transitionBug,
    }),
    [
      data,
      refreshing,
      scanError,
      unreadCount,
      refresh,
      setSeen,
      markAllSeen,
      mergeMr,
      ignoreItem,
      restoreIgnored,
      ignoredRev,
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
