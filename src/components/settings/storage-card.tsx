"use client";

/**
 * 存储清理卡片（v1.0.x、用户拍板）
 *
 * 背景：data/tasks/ 只增不减（events.jsonl / 上传图 / artifact 都无限积累）、app 越用越大。
 * 这里给「看占用 + 手动挑着删」的入口——不做自动删除、全部用户手选 + 二次确认。
 *
 * 快捷筛选：
 *   - 已终结任务（已合入 / 已放弃）——task 模式的自然清理点
 *   - 30 天未活跃对话——chat 没有终态、按不活跃时间挑
 * 删除走既有 DELETE /api/tasks/[id]（带停 agent / 清 worktree / 停预览的完整链路）、逐个串行。
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
}

interface StorageInfo {
  dataDir: string;
  totalBytes: number;
  entries: StorageEntry[];
}

const formatBytes = (n: number): string => {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

// 「不活跃对话」阈值
const CHAT_STALE_MS = 30 * 24 * 60 * 60 * 1000;
// 默认只显示前 N 条（按大小降序）、其余折叠
const COLLAPSED_COUNT = 8;

export const StorageCard = () => {
  // 扫描结果（null = 还没扫 / 扫描中首轮）
  const [info, setInfo] = useState<StorageInfo | null>(null);
  // 扫描请求飞行中
  const [scanning, setScanning] = useState(false);
  // 勾选待删的任务 id 集
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
      setInfo((await res.json()) as StorageInfo);
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

  const togglePick = (id: string) => {
    if (deleting) return; // 删除进行中冻结勾选（防进度和选中集打架）
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  const pickedBytes = entries
    .filter((e) => picked.has(e.id))
    .reduce((s, e) => s + e.bytes, 0);

  const handleDelete = async () => {
    if (picked.size === 0) return;
    const ok = await confirm({
      title: `删除 ${picked.size} 个任务 / 对话？`,
      description: `连带事件记录、上传图片、产出文档一起删（共约 ${formatBytes(pickedBytes)}）、不可恢复。正在跑的会先停掉。`,
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    const ids = Array.from(picked);
    setDeleting({ done: 0, total: ids.length });
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        await deleteTask(ids[i]);
      } catch {
        failed++;
      }
      setDeleting({ done: i + 1, total: ids.length });
    }
    setDeleting(null);
    if (failed > 0) toast.error(`${failed} 个删除失败、其余已删`);
    else toast.success(`已删除 ${ids.length} 个、释放约 ${formatBytes(pickedBytes)}`);
    void scan();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-4" />
          存储
          {info && (
            <span className="font-normal text-muted-foreground">
              {formatBytes(info.totalBytes)} · {entries.length} 个任务 / 对话
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
          <div className="font-mono text-xs text-muted-foreground">{info.dataDir}</div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!info ? (
          <LoadingState variant="inline" />
        ) : entries.length === 0 ? (
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
            <div className="divide-y rounded-md border">
              {visible.map((e) => (
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
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {e.mode === "chat" ? "对话" : REPO_STATUS_LABEL[e.repoStatus]}
                  </Badge>
                  <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                    {e.updatedAt > 0 ? formatRelative(e.updatedAt) : "—"}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-xs">
                    {formatBytes(e.bytes)}
                  </span>
                </label>
              ))}
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
      </CardContent>
    </Card>
  );
};
