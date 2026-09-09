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
import { formatRelative, REPO_STATUS_LABEL } from "@/lib/task-display";
import { setTaskArchived } from "@/lib/task-store";
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

/** 「不活跃对话」阈值（30 天未活跃快捷选中用） */
const CHAT_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** 残留工作区勾选前缀，避免和任务 id 在 Set 里撞车 */
const STALE_PICK_PREFIX = "stale:";

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
  const { tasks, loaded, upsertTask, refresh, deleteTaskById, markArchiving, unmarkArchiving } =
    useTaskList();
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
    const kw = query.trim().toLowerCase();
    const rows = tasks.filter((t) => {
      if (filter === "active" && t.archived) return false;
      if (filter === "archived" && !t.archived) return false;
      if (modeFilter === "chat" && t.mode !== "chat") return false;
      if (modeFilter === "task" && t.mode === "chat") return false;
      if (!kw) return true;
      const tail = (t.repoPaths?.[0] ?? "").toLowerCase();
      return (
        t.title.toLowerCase().includes(kw) ||
        tail.includes(kw) ||
        repoTail(t).toLowerCase().includes(kw)
      );
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

  // 快捷选中：点击时现算，不 memo——memo  deps 里 Date.now() 是冻住的，页面开几小时
  // 阈值就不动（刚满 30 天的进不来）。finished 本与时间无关，同样只点击时用，顺手一起改。
  const getFinishedTasks = () =>
    tasks.filter(
      (t) =>
        (t.mode ?? "task") !== "chat" &&
        (t.repoStatus === "merged" || t.repoStatus === "abandoned"),
    );
  const getStaleChats = () =>
    tasks.filter(
      (t) => t.mode === "chat" && Date.now() - t.updatedAt > CHAT_STALE_MS,
    );

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
    for (const key of picked) {
      if (key.startsWith(STALE_PICK_PREFIX)) {
        s += staleById.get(key.slice(STALE_PICK_PREFIX.length))?.bytes ?? 0;
      } else {
        s += sizeById.get(key)?.total ?? 0;
      }
    }
    return s;
  }, [picked, sizeById, staleById]);

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
        const updated = await setTaskArchived(task.id, false);
        upsertTask(updated);
        if (task.pinned) restorePinnedOrder(task.id);
        toast.success(`已恢复「${task.title}」`);
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
    markBusy(task.id, true);
    upsertTask({ ...task, archived: next ? true : undefined });
    // 归档/恢复双向都标记（恢复窗口拦 archived:true 的旧快照，反向闪现同账）
    markArchiving(task.id, next);
    try {
      const updated = await setTaskArchived(task.id, next);
      upsertTask(updated);
      if (!next) {
        if (task.pinned) restorePinnedOrder(task.id);
        toast.success(`已恢复「${task.title}」`);
      } else {
        // 会话页归档也把存储里置顶序的幽灵 id 摘掉；侧栏内存态不用通知——
        // 渲染层本来就忽略不存在的 id，侧栏下次自己 prune/save 时自愈
        if (task.pinned) {
          saveSidebarPinnedOrder(
            loadSidebarPinnedOrder().filter((x) => x !== task.id),
          );
        }
        const running = task.runStatus === "running";
        toast.success(
          running
            ? `已归档「${task.title}」、任务仍在后台跑`
            : `已归档「${task.title}」`,
          {
            action: {
              label: "撤销",
              onClick: () => {
                void (async () => {
                  markArchiving(task.id, false);
                  try {
                    const restored = await setTaskArchived(task.id, false);
                    upsertTask(restored);
                    if (task.pinned) restorePinnedOrder(task.id);
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
      description: `「${task.title}」将被永久删除、连同 data/tasks/${task.id}/ 整个目录${size ? `（约 ${formatBytes(size)}）` : ""}、不可恢复。`,
      destructive: true,
      confirmLabel: "彻底删除",
    });
    if (!ok) return;
    markBusy(task.id, true);
    try {
      await deleteTaskById(task.id);
      setPicked((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
      toast.success(`已彻底删除「${task.title}」`);
      void scan();
    } catch (err) {
      toast.error(`删除失败：${(err as Error).message}`);
      void refresh();
    } finally {
      markBusy(task.id, false);
    }
  };

  const handleBatchDelete = async () => {
    if (picked.size === 0 || deleting) return;
    const taskKeys = Array.from(picked).filter(
      (k) => !k.startsWith(STALE_PICK_PREFIX),
    );
    const staleIds = Array.from(picked)
      .filter((k) => k.startsWith(STALE_PICK_PREFIX))
      .map((k) => k.slice(STALE_PICK_PREFIX.length));
    const ok = await confirm({
      title: `删除 ${picked.size} 项？`,
      description: `含 ${taskKeys.length} 个会话与 ${staleIds.length} 个残留工作区（${pickedBytesText}）、不可恢复。正在跑的会先停掉。`,
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
    for (let i = 0; i < jobs.length; i++) {
      try {
        if (jobs[i].kind === "task") {
          await deleteTaskById(jobs[i].id);
        } else {
          const res = await fetch(
            `/api/system/storage?stale=${encodeURIComponent(jobs[i].id)}`,
            { method: "DELETE" },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    } else
      toast.success(`已删除 ${jobs.length} 个、释放${pickedBytesText}`);
    setPicked(new Set());
    void scan();
  };

  // 恢复归档的置顶时把手动序接回去（不然掉到末尾）：跟「新置顶追加末尾」同语义
  const restorePinnedOrder = (taskId: string) => {
    const order = loadSidebarPinnedOrder();
    if (!order.includes(taskId)) saveSidebarPinnedOrder([...order, taskId]);
  };

  const deleteStaleWorktree = async (id: string): Promise<void> => {
    const res = await fetch(
      `/api/system/storage?stale=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };

  const handleDeleteStale = async (s: { id: string; bytes: number }) => {
    const ok = await confirm({
      title: "删除残留工作区？",
      description: `${s.id}（约 ${formatBytes(s.bytes)}）、不可恢复。`,
      destructive: true,
      confirmLabel: "删除",
    });
    if (!ok) return;
    try {
      await deleteStaleWorktree(s.id);
      setPicked((prev) => {
        const next = new Set(prev);
        next.delete(`${STALE_PICK_PREFIX}${s.id}`);
        return next;
      });
      toast.success("已删除残留工作区");
      void scan();
    } catch (err) {
      toast.error(`删除失败：${(err as Error).message}`);
    }
  };

  // 返回 = 回来路、无历史兜底回首页（跟能力页 / 设置页同规）
  const handleBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/");
  };

  if (!loaded) return <LoadingState variant="hero" />;

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
              <button
                key={s.key}
                type="button"
                onClick={() => setSort(s.key)}
                aria-pressed={active}
                disabled={unavailable}
                title={unavailable ? "占用扫描完成后可用" : undefined}
                className={cn(
                  "cursor-pointer rounded-full px-3 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  active
                    ? "bg-selected text-selected-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s.label}
              </button>
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
                ? ` · 占用 ${formatBytes(storage.totalBytes)}`
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
              {picked.size > 0 && (
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
                      删除所选（{picked.size} 个 · {pickedBytesText}）
                    </>
                  )}
                </Button>
              )}
            </div>
          )}
          {visible.length === 0 ? (
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
              {visible.map((t) => {
              const busy = busyIds.has(t.id);
              const size = sizeById.get(t.id)?.total;
              return (
                <div
                  key={t.id}
                  className="group flex items-start gap-2 px-4 py-2.5 hover:bg-muted/40"
                >
                  {managing && (
                    <Checkbox
                      checked={picked.has(t.id)}
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
                      {t.runStatus === "running" && (
                        <Badge variant="outline" size="xs" className="gap-1">
                          <Loader2 className="size-3 animate-spin" />
                          跑着
                        </Badge>
                      )}
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
                        checked={picked.has(key)}
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
