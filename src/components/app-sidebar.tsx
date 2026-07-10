"use client";

/**
 * 全局任务侧栏（V0.8 侧栏导航、v1.0 改按模式过滤）
 *
 * 常驻左侧、点任务即切换（不再退首页再进）。可展开 / 收起（由 AppShell 控制 open）：
 * 收起时宽度归零、主区获得全宽——任务详情那种复杂布局不被遮挡。
 *
 * v1.0 胶囊双模式（用户拍板）：列表随顶栏模式自动过滤——工作台只显示 task 类、
 * 对话只显示 chat 类；原「类型筛选下拉」删除（模式即筛选、不再叠一层）。
 *
 * 内容（自上而下）：
 *  - 顶部一栏：对话模式 =「新建对话」按钮；工作台模式 = 活跃任务小标题（任务从看板进）
 *  - 列表：置顶优先 + updatedAt 倒序
 *  - 「更早」折叠分组：updatedAt 超 7 天没动的任务收在这、默认折叠（置顶的不沉底）
 *  - 行尾 hover：置顶（已置顶常显高亮）/ 删除（二次确认）
 */

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronRight, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { TaskListItem } from "@/components/tasks/task-list-item";
import { Button } from "@/components/ui/button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { useAppMode } from "@/hooks/use-app-mode";
import { useDialog } from "@/hooks/use-dialog";
import { useNewChat } from "@/hooks/use-new-chat";
import { useTaskList } from "@/hooks/use-task-list";
import { deleteTask, setTaskPinned } from "@/lib/task-store";
import { cn } from "@/lib/utils";
import type { Task, TaskSummary } from "@/lib/types";

// 「更早」分组阈值：updatedAt 距今超 7 天没动 → 折进「更早」（纯前端展示分组、不落盘）
const EARLIER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const AppSidebar = ({ open }: { open: boolean }) => {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const activeId = params?.id;
  const { tasks, loaded, upsertTask, removeTask, refresh } = useTaskList();
  const { confirm } = useDialog();
  // 当前模式（顶栏胶囊同源）——决定列表过滤 + 顶部按钮形态
  const mode = useAppMode();
  // 「更早」分组展开态（默认折叠、不占视觉）
  const [earlierOpen, setEarlierOpen] = useState(false);

  // 按模式过滤（v1.0：模式即筛选）、再排序（置顶优先 → updatedAt 倒序）、最后拆活跃 / 更早两组
  // 「更早」= updatedAt 距今超 7 天没动（纯前端按时间算、不落盘）；置顶任务永远算活跃、不沉底
  const { active, earlier } = useMemo(() => {
    const filtered = tasks.filter((t) =>
      mode === "chat" ? t.mode === "chat" : (t.mode ?? "task") === "task",
    );
    const sorted = [...filtered].sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap; // 置顶排最上
      return b.updatedAt - a.updatedAt;
    });
    const earlierBefore = Date.now() - EARLIER_AFTER_MS;
    return {
      active: sorted.filter((t) => t.pinned || t.updatedAt >= earlierBefore),
      earlier: sorted.filter((t) => !t.pinned && t.updatedAt < earlierBefore),
    };
  }, [tasks, mode]);

  // 新建后即时插入列表 + 跳详情
  const handleCreated = (task: Task) => {
    upsertTask(task);
    router.push(`/tasks/${task.id}`);
  };

  // 一键新建对话（零表单、对齐 codex / Cursor Agent Window）——逻辑抽进 useNewChat、跟首页复用
  const { createChat, creating: creatingChat } = useNewChat(handleCreated);

  // 置顶 / 取消置顶：乐观更新 → 失败回滚 + refresh 兜底
  const handlePin = async (task: TaskSummary) => {
    const next = !task.pinned;
    upsertTask({ ...task, pinned: next });
    try {
      const updated = await setTaskPinned(task.id, next);
      upsertTask(updated);
    } catch (err) {
      upsertTask({ ...task, pinned: task.pinned });
      toast.error(`操作失败：${(err as Error).message}`);
      void refresh();
    }
  };

  // 删除：二次确认 → 乐观移除 → 删的是当前任务则回本模式首页 → 失败 refresh 兜底找回
  const handleDelete = async (task: TaskSummary) => {
    const ok = await confirm({
      title: "确认删除任务",
      description: `「${task.title}」将被永久删除、连同 data/tasks/${task.id}/ 整个目录、不可恢复。`,
      destructive: true,
      confirmLabel: "确认删除",
    });
    if (!ok) return;
    removeTask(task.id);
    try {
      const okDel = await deleteTask(task.id);
      if (!okDel) throw new Error("任务不存在");
      // v1.0 双模式：按被删任务的模式回对应落点（对话删完回 /chats 跳下一条对话、
      // 不能踢回工作台看板——审计 P1）
      if (activeId === task.id) {
        router.push(task.mode === "chat" ? "/chats" : "/");
      }
    } catch (err) {
      toast.error(`删除失败：${(err as Error).message}`);
      void refresh();
    }
  };

  const empty = active.length === 0 && earlier.length === 0;

  return (
    // 底色比主区深半档（bg-muted/30）：侧栏与内容区分层、不再「格格不入」（用户点名）——
    // 对标 Cursor / Linear 的侧栏做法；border-r 保留细分隔
    <aside
      aria-hidden={!open}
      className={cn(
        "h-full shrink-0 overflow-hidden border-r border-border/60 bg-muted/30 transition-[width] duration-200 ease-out",
        open ? "w-64" : "w-0",
      )}
    >
      {/* 固定内容宽度、收起时被外层裁掉、不挤压换行 */}
      <div className="flex h-full w-64 flex-col">
        {/* 顶部（v1.0 按模式变）：对话模式 =「新建对话」主按钮；
            工作台模式 = 小标题（任务只从看板点工作项进、没有新建入口） */}
        <div className="flex items-center gap-1 p-2">
          {mode === "chat" ? (
            <Button
              className="flex-1"
              onClick={createChat}
              disabled={creatingChat}
            >
              {creatingChat ? <Loader2 className="animate-spin" /> : <Plus />}
              新建对话
            </Button>
          ) : (
            <div className="flex h-9 flex-1 items-center px-3 text-xs font-medium text-muted-foreground">
              进行中的任务
            </div>
          )}
        </div>

        {/* 列表滚动区 */}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {!loaded ? (
            <LoadingState variant="inline" className="block px-3 py-2" />
          ) : empty ? (
            <div className="mt-2">
              <EmptyHint variant="dashed" size="sm" align="center">
                {mode === "chat"
                  ? "还没有对话、点上方新建"
                  : "还没有任务、去看板挑一个需求启动"}
              </EmptyHint>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {active.map((t) => (
                <TaskListItem
                  key={t.id}
                  task={t}
                  active={t.id === activeId}
                  onPin={handlePin}
                  onDelete={handleDelete}
                />
              ))}

              {/* 更早（超 7 天没动）折叠分组 */}
              {earlier.length > 0 && (
                <div className="mt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEarlierOpen((v) => !v)}
                    className="h-7 w-full justify-start gap-1 px-3 text-xs text-muted-foreground"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 transition-transform",
                        earlierOpen && "rotate-90",
                      )}
                    />
                    更早（超 7 天）· {earlier.length}
                  </Button>
                  {earlierOpen && (
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {earlier.map((t) => (
                        <TaskListItem
                          key={t.id}
                          task={t}
                          active={t.id === activeId}
                          onPin={handlePin}
                          onDelete={handleDelete}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </nav>
      </div>
    </aside>
  );
};
