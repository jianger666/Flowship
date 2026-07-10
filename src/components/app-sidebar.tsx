"use client";

/**
 * 全局任务侧栏（V0.8 侧栏导航）
 *
 * 常驻左侧、点任务即切换（不再退首页再进）。可展开 / 收起（由 AppShell 控制 open）：
 * 收起时宽度归零、主区获得全宽——任务详情那种复杂布局不被遮挡。
 *
 * 内容（自上而下）：
 *  - 顶部一栏：新建任务 + 类型筛选图标（下拉单选 全部 / 任务 / 对话、localStorage 记忆）
 *  - toggle 不在侧栏内、常驻顶栏红绿灯右侧（位置固定不随开合跳）
 *  - 列表：置顶优先 + updatedAt 倒序
 *  - 「更早」折叠分组：updatedAt 超 7 天没动的任务收在这、默认折叠（置顶的不沉底）
 *  - 行尾 hover：置顶（已置顶常显高亮）/ 删除（二次确认）
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Check, ChevronRight, ListFilter, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { TaskListItem } from "@/components/tasks/task-list-item";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { useDialog } from "@/hooks/use-dialog";
import { useNewChat } from "@/hooks/use-new-chat";
import { useTaskList } from "@/hooks/use-task-list";
import { deleteTask, setTaskPinned } from "@/lib/task-store";
import { cn } from "@/lib/utils";
import type { Task, TaskSummary } from "@/lib/types";

// 任务类型筛选（mode 维度）
type FilterMode = "all" | "task" | "chat";
const FILTER_LABEL: Record<FilterMode, string> = {
  all: "全部",
  task: "任务",
  chat: "对话",
};
const FILTER_STORAGE_KEY = "fe-ai-flow:sidebar-filter";

// 「更早」分组阈值：updatedAt 距今超 7 天没动 → 折进「更早」（纯前端展示分组、不落盘）
const EARLIER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const AppSidebar = ({ open }: { open: boolean }) => {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const activeId = params?.id;
  const { tasks, loaded, upsertTask, removeTask, refresh } = useTaskList();
  const { confirm } = useDialog();
  // 「更早」分组展开态（默认折叠、不占视觉）
  const [earlierOpen, setEarlierOpen] = useState(false);
  // 任务类型筛选（默认全部、mount 后读 localStorage 覆盖）
  const [filter, setFilter] = useState<FilterMode>("all");
  // 筛选下拉开关（选完即关）
  const [filterOpen, setFilterOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(FILTER_STORAGE_KEY);
      if (saved === "task" || saved === "chat" || saved === "all") {
        setFilter(saved);
      }
    } catch {
      /* localStorage 不可用、用默认全部 */
    }
  }, []);

  const changeFilter = (f: FilterMode) => {
    setFilter(f);
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, f);
    } catch {
      /* 忽略写入失败 */
    }
  };

  // 先按 mode 过滤、再排序（置顶优先 → updatedAt 倒序）、最后拆活跃 / 更早两组
  // 「更早」= updatedAt 距今超 7 天没动（纯前端按时间算、不落盘）；置顶任务永远算活跃、不沉底
  const { active, earlier } = useMemo(() => {
    const filtered = tasks.filter((t) => {
      if (filter === "task") return (t.mode ?? "task") === "task";
      if (filter === "chat") return t.mode === "chat";
      return true;
    });
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
  }, [tasks, filter]);

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

  // 删除：二次确认 → 乐观移除 → 删的是当前任务则回首页 → 失败 refresh 兜底找回
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
      if (activeId === task.id) router.push("/");
    } catch (err) {
      toast.error(`删除失败：${(err as Error).message}`);
      void refresh();
    }
  };

  const empty = active.length === 0 && earlier.length === 0;

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "h-full shrink-0 overflow-hidden border-r bg-background transition-[width] duration-200 ease-out",
        open ? "w-64" : "w-0",
      )}
    >
      {/* 固定内容宽度、收起时被外层裁掉、不挤压换行 */}
      <div className="flex h-full w-64 flex-col">
        {/* 顶部：新建对话（主入口、占满）+ 类型筛选（图标触发下拉）。
            V0.14 砍「新建任务」入口（用户拍板）：任务只从首页飞书看板点工作项进；
            临时需求 / 自由探索走新建对话。 */}
        <div className="flex items-center gap-1 p-2">
          <Button
            className="flex-1"
            onClick={createChat}
            disabled={creatingChat}
          >
            {creatingChat ? <Loader2 className="animate-spin" /> : <Plus />}
            新建对话
          </Button>
          {/* 类型筛选：图标触发、下拉单选；非「全部」时图标高亮提示当前有筛选 */}
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger
              aria-label="筛选任务类型"
              title="筛选任务类型"
              className={cn(
                buttonVariants({ variant: "ghost", size: "icon-sm" }),
                "shrink-0",
                filter !== "all" && "text-primary",
              )}
            >
              <ListFilter className="size-4" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-32 space-y-0.5 p-1.5">
              {(Object.keys(FILTER_LABEL) as FilterMode[]).map((f) => (
                <Button
                  key={f}
                  variant={filter === f ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => {
                    changeFilter(f);
                    setFilterOpen(false);
                  }}
                  className="w-full justify-between gap-2 font-normal"
                >
                  {FILTER_LABEL[f]}
                  {filter === f && <Check className="size-4" />}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        </div>

        {/* 列表滚动区 */}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {/* 筛选生效时给个标题 + 清除入口——避免用户以为任务丢了（没注意按类型筛了） */}
          {loaded && filter !== "all" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => changeFilter("all")}
              title="点击清除筛选、显示全部"
              className="mb-0.5 h-7 w-full justify-between px-3 text-xs font-medium text-muted-foreground"
            >
              <span>{FILTER_LABEL[filter]}</span>
              <span className="font-normal opacity-60">清除筛选</span>
            </Button>
          )}
          {!loaded ? (
            <LoadingState variant="inline" className="block px-3 py-2" />
          ) : empty ? (
            <div className="mt-2">
              <EmptyHint variant="dashed" size="sm" align="center">
                {filter === "all"
                  ? "还没有任务、点上方新建"
                  : `没有「${FILTER_LABEL[filter]}」类任务`}
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
