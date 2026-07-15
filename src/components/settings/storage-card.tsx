"use client";

/**
 * 存储清理卡片（v1.0.x、用户拍板）
 *
 * 背景：data/tasks/ + worktrees/ 只增不减（events / 上传图 / artifact / 前端仓
 * node_modules 工作区都无限积累）、app 越用越大。
 * 这里给「看占用 + 手动挑着删」的入口——不做自动删除、全部用户手选 + 二次确认。
 *
 * 快捷筛选：
 *   - 已终结任务（已合入 / 已放弃）——task 模式的自然清理点
 *   - 30 天未活跃对话——chat 没有终态、按不活跃时间挑
 * 删除：任务走 DELETE /api/tasks/[id]；残留工作区走 DELETE /api/system/storage?stale=
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { HardDrive, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { useDialog } from "@/hooks/use-dialog";
import { deleteTask } from "@/lib/task-store";
import { REPO_STATUS_LABEL, formatRelative } from "@/lib/task-display";
import type { RepoStatus, TaskMode } from "@/lib/types";

interface StorageEntry {
  id: string;
  title: string;
  mode: TaskMode;
  repoStatus: RepoStatus;
  updatedAt: number;
  bytes: number;
  worktreeBytes: number;
}

interface StaleWorktree {
  id: string;
  bytes: number;
}

interface StorageInfo {
  dataDir: string;
  worktreesDir: string;
  totalBytes: number;
  entries: StorageEntry[];
  staleWorktrees: StaleWorktree[];
}

const formatBytes = (n: number): string => {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

/** 行主文案：合计；有工作区时附分项副文本，没有就只显任务数据 */
const entrySizeMain = (bytes: number, worktreeBytes: number): string =>
  formatBytes(bytes + worktreeBytes);

const entrySizeSub = (bytes: number, worktreeBytes: number): string | null =>
  worktreeBytes > 0
    ? `任务数据 ${formatBytes(bytes)} + 工作区 ${formatBytes(worktreeBytes)}`
    : null;

// 「不活跃对话」阈值
const CHAT_STALE_MS = 30 * 24 * 60 * 60 * 1000;
// 默认只显示前 N 条（按大小降序）、其余折叠
const COLLAPSED_COUNT = 8;

/** 残留工作区勾选前缀，避免和任务 id 在 Set 里撞车（理论上不会、保险） */
const STALE_PICK_PREFIX = "stale:";

export const StorageCard = () => {
  // 扫描结果（null = 还没扫 / 扫描中首轮）
  const [info, setInfo] = useState<StorageInfo | null>(null);
  // 扫描请求飞行中
  const [scanning, setScanning] = useState(false);
  // 勾选待删：任务 id 原样；残留工作区用 stale: 前缀
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // 删除进行中（串行删、进度 x/y 显示在按钮上）
  const [deleting, setDeleting] = useState<{ done: number; total: number } | null>(null);
  // 列表是否展开全部
  const [expanded, setExpanded] = useState(false);
  const { confirm } = useDialog();

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/system/storage", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as Partial<StorageInfo>;
      setInfo({
        dataDir: raw.dataDir ?? "",
        worktreesDir: raw.worktreesDir ?? "",
        totalBytes: raw.totalBytes ?? 0,
        entries: Array.isArray(raw.entries)
          ? raw.entries.map((e) => ({
              ...e,
              worktreeBytes: typeof e.worktreeBytes === "number" ? e.worktreeBytes : 0,
            }))
          : [],
        staleWorktrees: Array.isArray(raw.staleWorktrees) ? raw.staleWorktrees : [],
      });
      setPicked(new Set());
    } catch (err) {
      toast.error(`扫描存储失败：${(err as Error).message}`);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  // useMemo 包一层：给下面两个筛选 memo 一个稳定引用（lint exhaustive-deps 要求）
  const entries = useMemo(() => info?.entries ?? [], [info]);
  const staleWorktrees = useMemo(() => info?.staleWorktrees ?? [], [info]);
  const visible = expanded ? entries : entries.slice(0, COLLAPSED_COUNT);

  // 快捷筛选命中集
  const finishedTasks = useMemo(
    () =>
      entries.filter(
        (e) =>
          e.mode === "task" &&
          (e.repoStatus === "merged" || e.repoStatus === "abandoned"),
      ),
    [entries],
  );
  const staleChats = useMemo(
    () =>
      entries.filter(
        (e) => e.mode === "chat" && Date.now() - e.updatedAt > CHAT_STALE_MS,
      ),
    [entries],
  );

  const togglePick = (key: string) => {
    if (deleting) return; // 删除进行中冻结勾选（防进度和选中集打架）
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const pickAll = (ids: string[]) => {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  };

  const entryById = useMemo(() => {
    const m = new Map(entries.map((e) => [e.id, e]));
    return m;
  }, [entries]);
  const staleById = useMemo(() => {
    const m = new Map(staleWorktrees.map((e) => [e.id, e]));
    return m;
  }, [staleWorktrees]);

  const pickedBytes = useMemo(() => {
    let s = 0;
    for (const key of picked) {
      if (key.startsWith(STALE_PICK_PREFIX)) {
        const id = key.slice(STALE_PICK_PREFIX.length);
        s += staleById.get(id)?.bytes ?? 0;
      } else {
        const e = entryById.get(key);
        if (e) s += e.bytes + e.worktreeBytes;
      }
    }
    return s;
  }, [picked, entryById, staleById]);

  const deleteStaleWorktree = async (id: string): Promise<void> => {
    const res = await fetch(
      `/api/system/storage?stale=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
  };

  const handleDelete = async () => {
    if (picked.size === 0) return;
    const taskKeys = Array.from(picked).filter((k) => !k.startsWith(STALE_PICK_PREFIX));
    const staleKeys = Array.from(picked).filter((k) => k.startsWith(STALE_PICK_PREFIX));
    const staleIds = staleKeys.map((k) => k.slice(STALE_PICK_PREFIX.length));

    let title: string;
    let description: string;
    if (taskKeys.length > 0 && staleIds.length > 0) {
      title = `删除 ${picked.size} 项？`;
      description = `含 ${taskKeys.length} 个任务 / 对话与 ${staleIds.length} 个残留工作区（共约 ${formatBytes(pickedBytes)}）、不可恢复。`;
    } else if (staleIds.length > 0) {
      title = `删除 ${staleIds.length} 个残留工作区？`;
      description = `共约 ${formatBytes(pickedBytes)}、不可恢复。`;
    } else {
      title = `删除 ${taskKeys.length} 个任务 / 对话？`;
      description = `连带事件记录、上传图片、产出文档与工作区一起删（共约 ${formatBytes(pickedBytes)}）、不可恢复。正在跑的会先停掉。`;
    }

    const ok = await confirm({
      title,
      description,
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;

    // 先任务后残留、串行（任务删除本身会清对应 worktree）
    const jobs: Array<{ kind: "task" | "stale"; id: string }> = [
      ...taskKeys.map((id) => ({ kind: "task" as const, id })),
      ...staleIds.map((id) => ({ kind: "stale" as const, id })),
    ];
    setDeleting({ done: 0, total: jobs.length });
    let failed = 0;
    for (let i = 0; i < jobs.length; i++) {
      try {
        if (jobs[i].kind === "task") await deleteTask(jobs[i].id);
        else await deleteStaleWorktree(jobs[i].id);
      } catch {
        failed++;
      }
      setDeleting({ done: i + 1, total: jobs.length });
    }
    setDeleting(null);
    if (failed > 0) toast.error(`${failed} 个删除失败、其余已删`);
    else toast.success(`已删除 ${jobs.length} 个、释放约 ${formatBytes(pickedBytes)}`);
    void scan();
  };

  const isEmpty = entries.length === 0 && staleWorktrees.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-4" />
          存储
          {info && (
            <span className="font-normal text-muted-foreground">
              {formatBytes(info.totalBytes)}
              {entries.length > 0 && ` · ${entries.length} 个任务 / 对话`}
              {staleWorktrees.length > 0 && ` · ${staleWorktrees.length} 个残留工作区`}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-xs"
            onClick={() => void scan()}
            disabled={scanning || !!deleting}
          >
            {scanning ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            重新扫描
          </Button>
        </CardTitle>
        {info && (
          <div className="space-y-0.5 font-mono text-xs text-muted-foreground">
            <div>任务数据 {info.dataDir}</div>
            {info.worktreesDir && <div>工作区 {info.worktreesDir}</div>}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!info ? (
          <LoadingState variant="inline" />
        ) : isEmpty ? (
          <EmptyHint variant="dashed" size="sm">
            还没有任务数据
          </EmptyHint>
        ) : (
          <>
            {/* 快捷筛选 + 删除操作行 */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={finishedTasks.length === 0 || !!deleting}
                onClick={() => pickAll(finishedTasks.map((e) => e.id))}
              >
                选中已终结任务（{finishedTasks.length}）
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={staleChats.length === 0 || !!deleting}
                onClick={() => pickAll(staleChats.map((e) => e.id))}
              >
                选中 30 天未活跃对话（{staleChats.length}）
              </Button>
              {picked.size > 0 && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={!!deleting}
                    onClick={() => setPicked(new Set())}
                  >
                    清除选择
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="ml-auto h-7 text-xs"
                    disabled={!!deleting}
                    onClick={() => void handleDelete()}
                  >
                    {deleting ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        删除中 {deleting.done}/{deleting.total}
                      </>
                    ) : (
                      <>
                        <Trash2 className="size-3.5" />
                        删除所选（{picked.size} 个 · {formatBytes(pickedBytes)}）
                      </>
                    )}
                  </Button>
                </>
              )}
            </div>

            {/* 占用列表（按大小降序） */}
            {entries.length > 0 && (
              <>
                <div className="divide-y rounded-md border">
                  {visible.map((e) => {
                    const sizeSub = entrySizeSub(e.bytes, e.worktreeBytes);
                    return (
                      <label
                        key={e.id}
                        className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-muted/40"
                      >
                        <Checkbox
                          checked={picked.has(e.id)}
                          onCheckedChange={() => togglePick(e.id)}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm" title={e.title}>
                          {e.title}
                        </span>
                        {/* 定宽容器：Badge 本身随 2–3 字变宽，包一层让行间列对齐 */}
                        <span className="flex w-14 shrink-0 justify-center">
                          <Badge variant="outline" className="text-[10px]">
                            {e.mode === "chat" ? "对话" : REPO_STATUS_LABEL[e.repoStatus]}
                          </Badge>
                        </span>
                        <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                          {e.updatedAt > 0 ? formatRelative(e.updatedAt) : "—"}
                        </span>
                        {/* w-52 定宽 + nowrap：列对齐，且最宽明细「任务数据 … + 工作区 …」不换行 */}
                        <span className="w-52 shrink-0 text-right font-mono text-xs leading-snug whitespace-nowrap">
                          <span className="block whitespace-nowrap">
                            {entrySizeMain(e.bytes, e.worktreeBytes)}
                          </span>
                          {sizeSub && (
                            <span className="block whitespace-nowrap text-[10px] text-muted-foreground">
                              {sizeSub}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {entries.length > COLLAPSED_COUNT && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full text-xs text-muted-foreground"
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? "收起" : `展开全部（${entries.length}）`}
                  </Button>
                )}
              </>
            )}

            {/* 残留工作区：任务已删但 worktree 目录还在 */}
            {staleWorktrees.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">残留工作区</div>
                <div className="divide-y rounded-md border">
                  {staleWorktrees.map((s) => {
                    const key = `${STALE_PICK_PREFIX}${s.id}`;
                    return (
                      <label
                        key={key}
                        className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-muted/40"
                      >
                        <Checkbox
                          checked={picked.has(key)}
                          onCheckedChange={() => togglePick(key)}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-sm" title={s.id}>
                          {s.id}
                        </span>
                        {/* 单行体积、无明细，窄定宽即可对齐 */}
                        <span className="w-24 shrink-0 whitespace-nowrap text-right font-mono text-xs">
                          {formatBytes(s.bytes)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
