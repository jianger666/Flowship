"use client";

/**
 * 首页：任务卡片列表
 *
 * 设计取舍（参考 docs/HANDOFF.md「V1 流程设计」+「部署形态：本地脚本工具」）：
 * - 走 v0.dev / Cursor Cloud Agent 那种「卡片列表 + 详情页」的形态、
 *   而不是裸 chat、避免和 Cursor IDE 视觉重合
 * - 多任务并行场景靠卡片切换、Cursor 那边一次只能开一个会话
 * - 列表来源：服务端 fs（data/tasks/）走 /api/tasks 拉取、不再走 localStorage
 *
 * 列表堆积：
 * - V1 默认筛 archived=false 的任务、右上 toggle 切「已归档」视图
 * - completed/failed 且 7 天没动 → server 端 lazy auto-archive（详见 task-fs.ts）
 * - 用户也能在卡片上手动归档 / 取消归档
 *
 * 没任务时显示空态卡片、引导新建；有任务时按 updatedAt 倒序展示。
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { NewTaskDialog } from "@/components/tasks/new-task-dialog";
import { TaskCard } from "@/components/tasks/task-card";
import { Button } from "@/components/ui/button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { deleteTask, fetchTasks, setTaskArchived } from "@/lib/task-store";
import type { Task } from "@/lib/types";

const HomePage = () => {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // 拉一次列表、失败 toast 提示。SSR 不走、所以 useEffect 里来
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchTasks();
        if (!cancelled) setTasks(list);
      } catch (err) {
        if (!cancelled) {
          toast.error(`任务列表加载失败：${(err as Error).message}`);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 删除任务：乐观从列表移除、失败重新拉一遍兜底
  const handleDelete = async (task: Task) => {
    const prev = tasks;
    setTasks((p) => p.filter((t) => t.id !== task.id));
    try {
      const ok = await deleteTask(task.id);
      if (!ok) throw new Error("任务不存在");
      toast.success(`已删除「${task.title}」`);
    } catch (err) {
      // 删失败、回滚到之前的列表
      setTasks(prev);
      toast.error(`删除失败：${(err as Error).message}`);
    }
  };

  // 切归档状态：乐观更新、失败回滚
  const handleArchiveToggle = async (task: Task) => {
    const target = !task.archived;
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, archived: target } : t)),
    );
    try {
      const updated = await setTaskArchived(task.id, target);
      setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
      toast.success(target ? "已归档" : "已取消归档");
    } catch (err) {
      // 回滚
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id ? { ...t, archived: task.archived } : t,
        ),
      );
      toast.error(`操作失败：${(err as Error).message}`);
    }
  };

  // 筛选 + 排序：进行中视图 / 归档视图二选一、各自 updatedAt desc
  const visibleTasks = useMemo(() => {
    return tasks
      .filter((t) => (showArchived ? t.archived : !t.archived))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [tasks, showArchived]);

  const archivedCount = useMemo(
    () => tasks.filter((t) => t.archived).length,
    [tasks],
  );

  // 创建后直接跳详情页、不刷列表（详情页自己拉）
  const handleCreated = (task: Task) => {
    router.push(`/tasks/${task.id}`);
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {showArchived ? "已归档任务" : "任务"}
          </h1>
          {showArchived && (
            <p className="mt-1 text-sm text-muted-foreground">
              completed / failed 7 天未动会自动归档、也可在卡片上手动归档
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showArchived ? "default" : "outline"}
            size="sm"
            onClick={() => setShowArchived((v) => !v)}
            disabled={!showArchived && archivedCount === 0}
            title={
              archivedCount === 0
                ? "暂无已归档任务"
                : showArchived
                ? "返回进行中"
                : `查看已归档 (${archivedCount})`
            }
          >
            <Archive />
            {showArchived ? "进行中" : `已归档 ${archivedCount > 0 ? `(${archivedCount})` : ""}`}
          </Button>
          {!showArchived && <NewTaskDialog onCreated={handleCreated} />}
        </div>
      </div>

      {!loaded ? (
        <LoadingState variant="card" />
      ) : visibleTasks.length === 0 ? (
        <EmptyHint
          variant="dashed"
          size="lg"
          align="center"
          icon={<Sparkles className="size-8 text-muted-foreground" />}
        >
          {showArchived
            ? "归档区暂时是空的"
            : "还没有任务、点右上角「新建任务」开始"}
        </EmptyHint>
      ) : (
        <div className="flex flex-col gap-3">
          {visibleTasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              onArchiveToggle={() => handleArchiveToggle(t)}
              onDelete={() => handleDelete(t)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default HomePage;
