"use client";

/**
 * 会话管理页（/sessions、中性页）
 *
 * 会话和存储占用在同一张表里管：
 *  - 筛状态（全部 / 进行中 / 已归档，走能力页同款下划线 tab）+ 筛类型（搜索框右侧胶囊：全部 / 对话 / 任务）
 *  - 行首 tag 区分模式：对话描边徽标，任务灰底「任务」+ 状态徽标
 *  - 搜（标题 / 仓库）+ 排序（按最近 / 按占用）
 *  - 每行标题 + 元信息副行（状态 / 仓库 / 时间 / 占用），批量模式才出勾选
 *  - 残留工作区（任务已删、目录还在）附在表下同一页清
 *
 * 版式对齐管理类页面共性（能力页 / 设置页）：
 *  max-w-5xl + 返回 + 一句话描述 + Card 白底，操作收进卡头、不悬空。
 * 归档点开即恢复，彻底删除要二次确认。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ChoiceButton } from "@/components/ui/choice-button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { Tooltip } from "@/components/ui/tooltip";
import { useDialog } from "@/hooks/use-dialog";
import { useTaskList } from "@/hooks/use-task-list";
import { deriveListLoadView } from "@/lib/load-outcome";
import { formatRelative, REPO_STATUS_LABEL } from "@/lib/task-display";
import { hasBackgroundSubagents } from "@/lib/task-background";
import { setTaskArchivedWithReport } from "@/lib/task-store";
import { isWorktreeTaskLike } from "@/lib/lightweight-task";
import {
  buildArchiveToast,
  buildDeleteToast,
  buildRestoreToast,
  restoreToastNeeded,
  buildStaleDeletedToast,
  buildStaleForceDescription,
  withDeleteFailurePrefix,
  interpretStaleDeleteResponse,
  type DeleteWorktreeReportBody,
  type StaleDeleteOutcome,
} from "@/lib/worktree-report";
import {
  buildBatchDeleteSummary,
  countProtectedStaleChats,
  matchesSessionQuery,
  pickArchivedSessions,
  pickFinishedSessions,
  pickStaleChatSessions,
  prunePicked,
  SESSIONS_PAGE_SIZE,
} from "@/lib/sessions-filter";
import {
  loadSidebarPinnedOrder,
  saveSidebarPinnedOrder,
} from "@/lib/view-memory";
import { pathBasename } from "@/lib/path-utils";
import type { TaskSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

type FilterKey = "all" | "active" | "archived";
type SortKey = "recent" | "size";
type ModeFilter = "all" | "chat" | "task";

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "archived", label: "已归档" },
];

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "recent", label: "按最近" },
  { key: "size", label: "按占用" },
];

const MODE_FILTERS: Array<{ key: ModeFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "chat", label: "对话" },
  { key: "task", label: "任务" },
];

/** 残留工作区勾选前缀，避免和任务 id 在 Set 里撞车 */
const STALE_PICK_PREFIX = "stale:";

/** 删除确认框里的提醒：隔离工作区里可能有还没提交的代码（服务端会先尽量存快照，存不下就保留目录） */
const DELETE_UNCOMMITTED_NOTE =
  "隔离工作区里可能有未提交的代码：删除前会先尽量存成快照，存不下的目录会保留、不会被删掉。";

interface StorageEntry {
  id: string;
  bytes: number;
  worktreeBytes: number;
}

interface StorageInfo {
  totalBytes: number;
  entries: StorageEntry[];
  staleWorktrees: Array<{ id: string; bytes: number }>;
}

const formatBytes = (n: number): string => {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

const repoTail = (t: TaskSummary): string => {
  const first = t.repoPaths?.[0]?.trim();
  if (!first) return "Home";
  return pathBasename(first) || first;
};

const SessionsPage = () => {
  const router = useRouter();
  const {
    tasks,
    loaded,
    loadError,
    upsertTask,
    refresh,
    deleteTaskById,
    markArchiving,
    unmarkArchiving,
  } = useTaskList();
  // 列表首拉失败后的重试中（按钮转圈 + 防连点）
  const [retryingList, setRetryingList] = useState(false);
  const { confirm } = useDialog();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // 批量模式：默认关，勾选 / 快捷选中 / 删除栏只在这里出现，平时列表保持干净
  const [managing, setManaging] = useState(false);
  // 勾选待删：任务 id 原样；残留工作区用 stale: 前缀
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<{
    done: number;
    total: number;
  } | null>(null);

  // ---- 存储扫描（只读占用、跟会话表拼同一行） ----
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [scanning, setScanning] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/system/storage", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as Partial<StorageInfo>;
      setStorage({
        totalBytes: raw.totalBytes ?? 0,
        entries: Array.isArray(raw.entries)
          ? raw.entries.map((e) => ({
              id: e.id,
              bytes: e.bytes ?? 0,
              worktreeBytes:
                typeof e.worktreeBytes === "number" ? e.worktreeBytes : 0,
            }))
          : [],
        staleWorktrees: Array.isArray(raw.staleWorktrees)
          ? raw.staleWorktrees
          : [],
      });
    } catch (err) {
      toast.error(`扫描存储失败：${(err as Error).message}`);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  // 进页补拉一次列表：「30 天未活跃」快捷选中要靠行上的 hasLiveSchedule 判「带定时」，
  // 而详情页回灌（upsertTask）的行不带它、会把它冲掉——刚在详情页看过的旧会话可能因此被误选。
  // 进页重拉把服务端的真值换回来（只缩短陈旧窗口，不改回灌逻辑本身）。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sizeById = useMemo(() => {
    const m = new Map<
      string,
      { total: number; bytes: number; worktreeBytes: number }
    >();
    for (const e of storage?.entries ?? []) {
      m.set(e.id, {
        total: e.bytes + e.worktreeBytes,
        bytes: e.bytes,
        worktreeBytes: e.worktreeBytes,
      });
    }
    return m;
  }, [storage]);

  const staleById = useMemo(() => {
    const m = new Map((storage?.staleWorktrees ?? []).map((s) => [s.id, s]));
    return m;
  }, [storage]);

  const sizeTip = (id: string): string => {
    const s = sizeById.get(id);
    if (!s) return "占用扫描中";
    if (s.worktreeBytes > 0) {
      return `共 ${formatBytes(s.total)}（任务数据 ${formatBytes(s.bytes)} + 工作区 ${formatBytes(s.worktreeBytes)}）`;
    }
    return `共 ${formatBytes(s.total)}（任务数据）`;
  };

  // 状态计数只受类型筛影响（另一维度），搜关键词不影响计数
  const statusBase = useMemo(
    () =>
      tasks.filter((t) => {
        if (modeFilter === "chat" && t.mode !== "chat") return false;
        if (modeFilter === "task" && t.mode === "chat") return false;
        return true;
      }),
    [tasks, modeFilter],
  );
  const counts = useMemo(
    () => ({
      all: statusBase.length,
      active: statusBase.filter((t) => !t.archived).length,
      archived: statusBase.filter((t) => t.archived).length,
    }),
    [statusBase],
  );

  // 类型计数只受状态筛影响（另一维度），搜关键词不影响计数
  const filterBase = useMemo(
    () =>
      tasks.filter((t) => {
        if (filter === "active" && t.archived) return false;
        if (filter === "archived" && !t.archived) return false;
        return true;
      }),
    [tasks, filter],
  );
  const modeCounts = useMemo(
    () => ({
      all: filterBase.length,
      chat: filterBase.filter((t) => t.mode === "chat").length,
      task: filterBase.filter((t) => t.mode !== "chat").length,
    }),
    [filterBase],
  );

  const visible = useMemo(() => {
    const rows = tasks.filter((t) => {
      if (filter === "active" && t.archived) return false;
      if (filter === "archived" && !t.archived) return false;
      if (modeFilter === "chat" && t.mode !== "chat") return false;
      if (modeFilter === "task" && t.mode === "chat") return false;
      // 搜索覆盖任务关联的所有仓（不只第一个）
      return matchesSessionQuery(t, query);
    });
    // 占用没扫完时 size 全 0、排出来是假顺序，回落按最近（按钮侧同时禁用）
    if (sort === "size" && storage) {
      return [...rows].sort(
        (a, b) =>
          (sizeById.get(b.id)?.total ?? 0) - (sizeById.get(a.id)?.total ?? 0),
      );
    }
    return [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [tasks, filter, modeFilter, query, sort, sizeById, storage]);

  // 顶上总量跟着当前筛选项走（状态/类型/搜索），别用全量 totalBytes
  const visibleBytes = useMemo(
    () => visible.reduce((s, t) => s + (sizeById.get(t.id)?.total ?? 0), 0),
    [visible, sizeById],
  );

  // 快捷选中：点击时现算，不 memo——memo  deps 里 Date.now() 是冻住的，页面开几小时
  // 阈值就不动（刚满 30 天的进不来）。finished 本与时间无关，同样只点击时用，顺手一起改。

  // 分批渲染：一次只渲染前 N 行、「显示更多」追加；筛选 / 搜索 / 排序变了回到第一批
  // （按 key 比对派生，不用 effect 重置）
  const listKey = `${filter}|${modeFilter}|${sort}|${query}`;
  const [shown, setShown] = useState<{ key: string; n: number }>({
    key: listKey,
    n: SESSIONS_PAGE_SIZE,
  });
  const shownCount =
    shown.key === listKey ? shown.n : SESSIONS_PAGE_SIZE;
  const renderedRows = useMemo(
    () => visible.slice(0, shownCount),
    [visible, shownCount],
  );
  const hiddenCount = visible.length - renderedRows.length;

  // R8-05：勾选集合只认「此刻已渲染的行 + 残留工作区」。筛选 / 搜索 / 排序变了、列表回到第一批后，
  // 旧勾选里看不见的行自动失效（不参与计数 / 体积 / 批量删除），不会删到用户没看到的行。
  // 只派生不回写：回到原筛选再次渲染出来的行会带着勾选显示，用户看得见。
  const pickableKeys = useMemo(
    () => [
      ...renderedRows.map((t) => t.id),
      ...(storage?.staleWorktrees ?? []).map(
        (s) => `${STALE_PICK_PREFIX}${s.id}`,
      ),
    ],
    [renderedRows, storage],
  );
  const effectivePicked = useMemo(
    () => prunePicked(picked, pickableKeys),
    [picked, pickableKeys],
  );

  // 三个快捷选中只作用于「当前筛选后且已渲染」的行（renderedRows），
  // 未点「显示更多」的行用户没看到、不能被一键选中后批量删掉
  const getFinishedTasks = () => pickFinishedSessions(renderedRows);
  const getStaleChats = () => pickStaleChatSessions(renderedRows, Date.now());
  // 30 天未活跃里因置顶 / 在跑 / 带定时被跳过的个数（按钮计数 = 将选中的数，这里告诉用户少选了几个）
  const getStaleProtectedCount = () =>
    countProtectedStaleChats(renderedRows, Date.now());
  const getArchivedTasks = () => pickArchivedSessions(renderedRows);

  const togglePick = (key: string) => {
    if (deleting) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleManaging = () => {
    setManaging((v) => {
      if (v) setPicked(new Set());
      return !v;
    });
  };

  const pickAll = (ids: string[]) => {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  };

  const pickedBytes = useMemo(() => {
    let s = 0;
    for (const key of effectivePicked) {
      if (key.startsWith(STALE_PICK_PREFIX)) {
        s += staleById.get(key.slice(STALE_PICK_PREFIX.length))?.bytes ?? 0;
      } else {
        s += sizeById.get(key)?.total ?? 0;
      }
    }
    return s;
  }, [effectivePicked, sizeById, staleById]);

  // 扫描完成前 sizeById 是空 Map，pickedBytes 算出来是 0——别展示假数
  const sizesReady = storage !== null;
  const pickedBytesText = sizesReady
    ? `约 ${formatBytes(pickedBytes)}`
    : "占用统计中";

  const markBusy = (id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  // 打开：归档的打开即恢复，恢复后侧栏可见
  const handleOpen = async (task: TaskSummary) => {
    if (busyIds.has(task.id)) return;
    if (task.archived) {
      markBusy(task.id, true);
      // 恢复方向同样标记： success upsert 之后、轮询仍可能拿回旧快照（archived:true）盖掉
      markArchiving(task.id, false);
      try {
        const { task: updated, report } = await setTaskArchivedWithReport(task.id, false);
        upsertTask(updated);
        if (task.pinned) restorePinnedOrder(task.id);
        toast.success(buildRestoreToast(task.title, report));
      } catch (err) {
        toast.error(`恢复失败：${(err as Error).message}`);
        markBusy(task.id, false);
        unmarkArchiving(task.id);
        return;
      }
      markBusy(task.id, false);
      unmarkArchiving(task.id);
    }
    router.push(`/tasks/${task.id}`);
  };

  const handleToggleArchive = async (task: TaskSummary) => {
    if (busyIds.has(task.id)) return;
    const next = !task.archived;
    // 仅用于「归档前」的确认文案预告（还没请求，只能预测）；归档后的 toast 一律以服务端回报 report 为准（review D2b-06）。
    // 口径与服务端 archiveTaskWithReport 一致：isWorktreeTaskLike（task-worktrees.ts isWorktreeTask 的前端同口径）
    const willCleanup = next && isWorktreeTaskLike(task);
    if (next && task.runStatus === "running") {
      const ok = await confirm({
        title: "当前任务还在执行",
        description: willCleanup
          ? "归档会停止 agent 并清理隔离工作区（分支保留，取消归档后下次推进会自动重建），是否继续归档？"
          : "归档后任务仍在后台跑，是否继续归档？",
        confirmLabel: "归档",
      });
      if (!ok) return;
    }
    markBusy(task.id, true);
    upsertTask({ ...task, archived: next ? true : undefined });
    // 归档/恢复双向都标记（恢复窗口拦 archived:true 的旧快照，反向闪现同账）
    markArchiving(task.id, next);
    try {
      const { task: updated, report } = await setTaskArchivedWithReport(task.id, next);
      upsertTask(updated);
      if (!next) {
        if (task.pinned) restorePinnedOrder(task.id);
        toast.success(buildRestoreToast(task.title, report));
      } else {
        // 会话页归档也把存储里置顶序的幽灵 id 摘掉；侧栏内存态不用通知——
        // 渲染层本来就忽略不存在的 id，侧栏下次自己 prune/save 时自愈
        if (task.pinned) {
          saveSidebarPinnedOrder(
            loadSidebarPinnedOrder().filter((x) => x !== task.id),
          );
        }
        const archiveToast = buildArchiveToast({
          title: task.title,
          wasRunning: task.runStatus === "running",
          report,
        });
        (archiveToast.kind === "warning" ? toast.warning : toast.success)(
          archiveToast.message,
          {
            action: {
              label: "撤销",
              onClick: () => {
                void (async () => {
                  markArchiving(task.id, false);
                  try {
                    const { task: restored, report: restoreReport } =
                      await setTaskArchivedWithReport(task.id, false);
                    upsertTask(restored);
                    if (task.pinned) restorePinnedOrder(task.id);
                    // 撤销也把定时找回来了：说一声（没定时就不打扰）
                    // （Q9-06：已过点记为「已错过」/ 已用满次数的也要说，不只恢复了才说）
                    if (restoreToastNeeded(restoreReport)) {
                      toast.success(buildRestoreToast(task.title, restoreReport));
                    }
                  } catch (err) {
                    toast.error(`撤销失败：${(err as Error).message}`);
                  } finally {
                    unmarkArchiving(task.id);
                  }
                })();
              },
            },
          },
        );
      }
    } catch (err) {
      unmarkArchiving(task.id);
      upsertTask(task);
      toast.error(`${next ? "归档" : "恢复"}失败：${(err as Error).message}`);
      void refresh();
    } finally {
      unmarkArchiving(task.id);
      markBusy(task.id, false);
    }
  };

  const handleDelete = async (task: TaskSummary) => {
    if (busyIds.has(task.id)) return;
    const size = sizeById.get(task.id)?.total;
    const ok = await confirm({
      title: "彻底删除？",
      description: `「${task.title}」将被永久删除、连同 data/tasks/${task.id}/ 整个目录${size ? `（约 ${formatBytes(size)}）` : ""}、不可恢复。${isWorktreeTaskLike(task) ? DELETE_UNCOMMITTED_NOTE : ""}`,
      destructive: true,
      confirmLabel: "彻底删除",
    });
    if (!ok) return;
    markBusy(task.id, true);
    try {
      let report: DeleteWorktreeReportBody | undefined;
      await deleteTaskById(task.id, { onReport: (r) => (report = r) });
      setPicked((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
      // 文案只认服务端回报：目录因快照失败被保留时不能说「已彻底删除」就完事
      const deleted = buildDeleteToast(task.title, report);
      (deleted.kind === "warning" ? toast.warning : toast.success)(deleted.message);
      void scan();
    } catch (err) {
      toast.error(withDeleteFailurePrefix((err as Error).message));
      void refresh();
    } finally {
      markBusy(task.id, false);
    }
  };

  const handleBatchDelete = async () => {
    // 执行点再与「当前可见（已渲染）」求交：只删用户此刻看得见、勾着的项
    const toDelete = prunePicked(picked, pickableKeys);
    if (toDelete.size === 0 || deleting) return;
    const taskKeys = Array.from(toDelete).filter(
      (k) => !k.startsWith(STALE_PICK_PREFIX),
    );
    const staleIds = Array.from(toDelete)
      .filter((k) => k.startsWith(STALE_PICK_PREFIX))
      .map((k) => k.slice(STALE_PICK_PREFIX.length));
    // 确认框里列出「到底删哪些」：先算好再弹——别插在 title 与 description 之间
    //（archive-delete-toast-wiring-contract 以 title 模板为锚，要求其后紧跟 DELETE_UNCOMMITTED_NOTE）。
    // taskKeys 已与 pickableKeys 求交，都在 renderedRows 里；查不到的行（理论上没有）直接略过。
    const rowById = new Map(renderedRows.map((t) => [t.id, t]));
    const summary = buildBatchDeleteSummary(
      taskKeys.flatMap((id) => {
        const row = rowById.get(id);
        return row ? [row] : [];
      }),
      staleIds.length,
    );
    const summaryBlock = summary ? `\n\n${summary}` : "";
    const ok = await confirm({
      title: `删除 ${toDelete.size} 项？`,
      description: `将删除当前列表中已勾选的 ${toDelete.size} 项：${taskKeys.length} 个会话与 ${staleIds.length} 个残留工作区（${pickedBytesText}）、不可恢复。正在跑的会先停掉。${DELETE_UNCOMMITTED_NOTE}${summaryBlock}`,
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    const jobs: Array<{ kind: "task" | "stale"; id: string }> = [
      ...taskKeys.map((id) => ({ kind: "task" as const, id })),
      ...staleIds.map((id) => ({ kind: "stale" as const, id })),
    ];
    setDeleting({ done: 0, total: jobs.length });
    let failed = 0;
    // 被守卫保留的（未提交改动没存下来）：不算失败也不算删掉——批量里不替用户做「强删」决定，
    // 留在列表里让用户逐个确认（单个删除会弹二次确认）
    let kept = 0;
    for (let i = 0; i < jobs.length; i++) {
      try {
        if (jobs[i].kind === "task") {
          let keptHere = false;
          await deleteTaskById(jobs[i].id, {
            onReport: (r) => {
              keptHere = (r.worktreeKept?.length ?? 0) > 0;
            },
          });
          if (keptHere) kept++;
        } else {
          const outcome = await deleteStaleWorktree(jobs[i].id);
          if (outcome.kind === "kept") kept++;
        }
      } catch {
        failed++;
      }
      setDeleting({ done: i + 1, total: jobs.length });
    }
    setDeleting(null);
    // 部分失败时列表对不上：deleteTaskById 乐观先移除、失败不回加，只靠 refresh 捞回来
    //（结尾的 scan 只扫存储不拉任务）。单删失败调 refresh，批量同样要调。
    if (failed > 0) {
      toast.error(`${failed} 个删除失败、其余已删`);
      void refresh();
    } else if (kept > 0) {
      toast.warning(
        `已处理 ${jobs.length} 项，其中 ${kept} 项的工作区里有未提交的改动没能自动保存，目录已保留；请到列表里逐个确认后再删`,
      );
    } else {
      toast.success(`已删除 ${jobs.length} 个、释放${pickedBytesText}`);
    }
    setPicked(new Set());
    void scan();
  };

  // 恢复归档的置顶时把手动序接回去（不然掉到末尾）：跟「新置顶追加末尾」同语义
  const restorePinnedOrder = (taskId: string) => {
    const order = loadSidebarPinnedOrder();
    if (!order.includes(taskId)) saveSidebarPinnedOrder([...order, taskId]);
  };

  // 服务端先逐个目录走快照守卫：存得下 → 落快照再删；存不下 → 目录保留并回 409（outcome.kind==="kept"）。
  // force=true 才越过守卫（用户在二次确认框里点了「仍要删除」）。
  const deleteStaleWorktree = async (id: string, force = false): Promise<StaleDeleteOutcome> => {
    const res = await fetch(
      `/api/system/storage?stale=${encodeURIComponent(id)}${force ? "&force=1" : ""}`,
      { method: "DELETE" },
    );
    const body: unknown = await res.json().catch(() => null);
    return interpretStaleDeleteResponse(res.status, body);
  };

  const handleDeleteStale = async (s: { id: string; bytes: number }) => {
    const ok = await confirm({
      title: "删除残留工作区？",
      description: `${s.id}（约 ${formatBytes(s.bytes)}）、不可恢复。其中可能有未提交的代码：会先尽量存成快照，存不下的会再问你一次。`,
      destructive: true,
      confirmLabel: "删除",
    });
    if (!ok) return;
    try {
      let outcome = await deleteStaleWorktree(s.id);
      if (outcome.kind === "kept") {
        // 守卫拦下：这些目录里的未提交改动存不下来，直接删就找不回了——再问一次，确认才强删
        const force = await confirm({
          title: "有未提交的代码没能保存",
          description: buildStaleForceDescription(outcome.kept),
          destructive: true,
          confirmLabel: "仍要删除",
        });
        if (!force) {
          void scan();
          return;
        }
        outcome = await deleteStaleWorktree(s.id, true);
        if (outcome.kind === "kept") throw new Error("目录仍未能清理，请稍后重试");
      }
      setPicked((prev) => {
        const next = new Set(prev);
        next.delete(`${STALE_PICK_PREFIX}${s.id}`);
        return next;
      });
      toast.success(buildStaleDeletedToast(outcome.kind === "ok" ? outcome.snapshots : undefined));
      void scan();
    } catch (err) {
      toast.error(withDeleteFailurePrefix((err as Error).message));
    }
  };

  // 返回 = 回来路、无历史兜底回首页（跟能力页 / 设置页同规）
  const handleBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/");
  };

  if (!loaded) return <LoadingState variant="hero" />;

  // 列表首拉失败（没任何旧数据 + 有失败原因）≠「还没有对话」：不下「没有」的结论，给重试
  //（口径与侧栏 / /chats 同源，见 lib/load-outcome 的 deriveListLoadView）
  const listView = deriveListLoadView({
    loaded,
    loadError,
    count: tasks.length,
  });

  const staleList = storage?.staleWorktrees ?? [];

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-2 px-2"
          onClick={handleBack}
        >
          <ArrowLeft />
          返回
        </Button>
        <h1 className="text-lg font-semibold">会话管理</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          侧栏只显示未归档、对话组默认 4 条，这里不折叠。归档点开即恢复。
        </p>
        <div className="mt-4 flex items-center gap-1 border-b pb-2">
          {FILTERS.map((f) => {
            const count =
              f.key === "all"
                ? counts.all
                : f.key === "active"
                  ? counts.active
                  : counts.archived;
            return (
              <ChoiceButton
                key={f.key}
                shape="tab"
                selected={filter === f.key}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="ml-1 text-xs opacity-70">{count}</span>
              </ChoiceButton>
            );
          })}
        </div>
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜标题 / 仓库"
              className="border-transparent bg-muted/60 pl-9"
              aria-label="搜索对话"
            />
          </div>
          <div className="flex items-center gap-1 self-start rounded-full bg-muted/60 p-0.5 sm:self-auto">
            {MODE_FILTERS.map((m) => {
              const active = modeFilter === m.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setModeFilter(m.key)}
                  aria-pressed={active}
                  className={cn(
                    "cursor-pointer rounded-full px-3 py-1 text-sm transition-colors",
                    active
                      ? "bg-selected text-selected-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m.label}
                  <span className="ml-1 text-xs opacity-70">{modeCounts[m.key]}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1 self-start rounded-full bg-muted/60 p-0.5 sm:self-auto">
          {SORTS.map((s) => {
            const active = sort === s.key;
            const unavailable = s.key === "size" && !storage;
            return (
              // 原生 disabled 的 button 收不到鼠标事件、Tooltip 直接挂它上面不会出——挂外层 span；
              // 可用时 content 为空、Tooltip 不挂气泡（只剩一个 inline-flex 外层 span）
              <Tooltip
                key={s.key}
                content={unavailable ? "占用扫描完成后可用" : undefined}
              >
                <span className="inline-flex">
                  <button
                    type="button"
                    onClick={() => setSort(s.key)}
                    aria-pressed={active}
                    disabled={unavailable}
                    className={cn(
                      "cursor-pointer rounded-full px-3 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                      active
                        ? "bg-selected text-selected-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {s.label}
                  </button>
                </span>
              </Tooltip>
            );
          })}
        </div>
          <Button
            variant={managing ? "secondary" : "outline"}
            size="sm"
            className="h-8 self-start text-xs sm:self-auto"
            onClick={toggleManaging}
          >
            {managing ? "完成" : "批量管理"}
          </Button>
        </div>
        <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
            <span>
              共 {visible.length} 个
              {storage
                ? ` · 占用 ${formatBytes(visibleBytes)}`
                : " · 占用扫描中…"}
              {staleList.length > 0 && ` · ${staleList.length} 个残留工作区`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-xs text-muted-foreground"
              disabled={scanning}
              onClick={() => void scan()}
            >
              {scanning ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              重新扫描
            </Button>
          </div>
          {managing && (
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 bg-card text-xs"
                disabled={getFinishedTasks().length === 0 || !!deleting}
                onClick={() => pickAll(getFinishedTasks().map((t) => t.id))}
              >
                选中已终结（{getFinishedTasks().length}）
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 bg-card text-xs"
                disabled={getStaleChats().length === 0 || !!deleting}
                onClick={() => pickAll(getStaleChats().map((t) => t.id))}
              >
                选中 30 天未活跃（{getStaleChats().length}）
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 bg-card text-xs"
                disabled={getArchivedTasks().length === 0 || !!deleting}
                onClick={() => pickAll(getArchivedTasks().map((t) => t.id))}
              >
                选中已归档（{getArchivedTasks().length}）
              </Button>
              {hiddenCount > 0 && (
                <span className="text-[11px] text-muted-foreground">
                  快捷选中只作用于已显示的 {renderedRows.length} 行（还有{" "}
                  {hiddenCount} 行未显示，点「显示更多」后可继续选）
                </span>
              )}
              {getStaleProtectedCount() > 0 && (
                <span className="text-[11px] text-muted-foreground">
                  另有 {getStaleProtectedCount()} 个 30 天未活跃的会话因置顶 /
                  在跑 / 带定时没被一键选中（要删请逐个勾选）
                </span>
              )}
              {effectivePicked.size > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="ml-auto h-7 text-xs"
                  disabled={!!deleting}
                  onClick={() => void handleBatchDelete()}
                >
                  {deleting ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      删除中 {deleting.done}/{deleting.total}
                    </>
                  ) : (
                    <>
                      <Trash2 className="size-3.5" />
                      删除所选（{effectivePicked.size} 个 · {pickedBytesText}）
                    </>
                  )}
                </Button>
              )}
            </div>
          )}
          {listView === "error" ? (
            <div className="px-4 py-8">
              <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-3 py-3 text-center">
                <p className="text-xs text-destructive">
                  会话列表加载失败：{loadError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={retryingList}
                  onClick={() => {
                    setRetryingList(true);
                    void refresh().finally(() => setRetryingList(false));
                  }}
                >
                  {retryingList ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  重试
                </Button>
              </div>
            </div>
          ) : visible.length === 0 ? (
            <div className="px-4 py-8">
              <EmptyHint variant="dashed" size="sm" align="center">
                {query.trim()
                  ? "没搜到匹配的对话、换个关键词"
                  : filter === "archived"
                    ? "还没有归档、去侧栏把不用的归档掉"
                    : "还没有对话"}
              </EmptyHint>
            </div>
          ) : (
            <div className="divide-y">
              {renderedRows.map((t) => {
              const busy = busyIds.has(t.id);
              const size = sizeById.get(t.id)?.total;
              return (
                <div
                  key={t.id}
                  className="group flex items-start gap-2 px-4 py-2.5 hover:bg-muted/40"
                >
                  {managing && (
                    <Checkbox
                      checked={effectivePicked.has(t.id)}
                      onCheckedChange={() => togglePick(t.id)}
                      disabled={!!deleting}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`选中 ${t.title}`}
                      className="mt-1"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleOpen(t)}
                        disabled={busy}
                        className={cn(
                          "min-w-0 flex-1 cursor-pointer truncate text-left text-sm",
                          t.archived && "text-muted-foreground",
                        )}
                      >
                        {t.title}
                      </button>
                      <span className="flex shrink-0 items-center gap-0.5">
                        <Tooltip content={t.archived ? "恢复" : "归档"}>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-7 text-muted-foreground hover:text-foreground"
                            disabled={busy}
                            aria-label={`${t.archived ? "恢复" : "归档"} ${t.title}`}
                            onClick={() => void handleToggleArchive(t)}
                          >
                            {t.archived ? (
                              <ArchiveRestore className="size-3.5" />
                            ) : (
                              <Archive className="size-3.5" />
                            )}
                          </Button>
                        </Tooltip>
                        <Tooltip content="彻底删除">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-7 text-muted-foreground hover:text-destructive"
                            disabled={busy}
                            aria-label={`彻底删除 ${t.title}`}
                            onClick={() => void handleDelete(t)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </Tooltip>
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      {t.mode === "chat" ? (
                        <Badge variant="outline" size="xs">
                          对话
                        </Badge>
                      ) : (
                        <>
                          <Badge variant="secondary" size="xs">
                            任务
                          </Badge>
                          <Badge variant="outline" size="xs">
                            {REPO_STATUS_LABEL[t.repoStatus]}
                          </Badge>
                        </>
                      )}
                      {t.archived && (
                        <Badge variant="outline" size="xs">
                          已归档
                        </Badge>
                      )}
                      {t.runStatus === "running" ? (
                        <Badge variant="outline" size="xs" className="gap-1">
                          <Loader2 className="size-3 animate-spin" />
                          跑着
                        </Badge>
                      ) : hasBackgroundSubagents(t) ? (
                        // 主 AI 已说完、后台子代理还在干：别让会话管理页显示成空闲
                        <Badge variant="outline" size="xs" className="gap-1">
                          <Loader2 className="size-3 animate-spin" />
                          后台运行中
                        </Badge>
                      ) : null}
                      <span className="max-w-32 truncate">{repoTail(t)}</span>
                      <span aria-hidden>·</span>
                      <span className="shrink-0 tabular-nums">
                        {formatRelative(t.updatedAt)}
                      </span>
                      {size != null && (
                        <>
                          <span aria-hidden>·</span>
                          <Tooltip content={sizeTip(t.id)}>
                            <span className="shrink-0 font-mono whitespace-nowrap">
                              {formatBytes(size)}
                            </span>
                          </Tooltip>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
              {hiddenCount > 0 && (
                <div className="flex justify-center px-4 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground"
                    onClick={() =>
                      setShown({
                        key: listKey,
                        n: shownCount + SESSIONS_PAGE_SIZE,
                      })
                    }
                  >
                    显示更多（还有 {hiddenCount} 个）
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>

      {staleList.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 px-1 text-sm font-medium">
            残留工作区
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              任务已删、目录还在
            </span>
          </div>
          <Card className="gap-0 overflow-hidden p-0">
            <div className="divide-y">
              {staleList.map((s) => {
                const key = `${STALE_PICK_PREFIX}${s.id}`;
                return (
                  <div
                    key={key}
                    className="flex items-center gap-2 px-4 py-2 hover:bg-muted/40"
                  >
                    {managing && (
                      <Checkbox
                        checked={effectivePicked.has(key)}
                        onCheckedChange={() => togglePick(key)}
                        disabled={!!deleting}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`选中残留工作区 ${s.id}`}
                      />
                    )}
                    <Tooltip content={s.id}>
                      <span className="min-w-0 flex-1 truncate font-mono text-sm">
                        {s.id}
                      </span>
                    </Tooltip>
                    <span className="shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground">
                      {formatBytes(s.bytes)}
                    </span>
                    <Tooltip content="删除残留工作区">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={`删除残留工作区 ${s.id}`}
                        onClick={() => void handleDeleteStale(s)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default SessionsPage;
