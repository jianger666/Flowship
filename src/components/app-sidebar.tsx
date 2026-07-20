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
 * 2026-07-20 grok 化再简化（chat 侧）：
 *  - 固定按工作目录/仓库分组（无按状态切换）
 *  - 置顶区手动上/下移（序存 view-memory）；行内重命名
 *  - 组头「+」预绑该仓新建对话（Home = 不绑）
 *
 * 内容（自上而下）：
 *  - 顶部一栏：对话模式 =「新建对话」；工作台 = 活跃任务小标题
 *  - 列表：chat = 置顶 / 仓组 / Home（可折叠）；task = 时间桶
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { TaskListItem } from "@/components/tasks/task-list-item";
import { Button } from "@/components/ui/button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { Tooltip } from "@/components/ui/tooltip";
import { useAppMode } from "@/hooks/use-app-mode";
import { useDialog } from "@/hooks/use-dialog";
import { useNewChat } from "@/hooks/use-new-chat";
import { useTaskList } from "@/hooks/use-task-list";
import { getSettings } from "@/lib/local-store";
import {
  buildRepoGroups,
  movePinnedId,
  repoPathsForGroupCreate,
  type SidebarGroup,
} from "@/lib/sidebar-groups";
import { setTaskPinned, updateTaskFields } from "@/lib/task-store";
import { cn } from "@/lib/utils";
import {
  loadSidebarCollapsedGroups,
  loadSidebarPinnedOrder,
  saveSidebarCollapsedGroups,
  saveSidebarPinnedOrder,
} from "@/lib/view-memory";
import type { Task, TaskSummary } from "@/lib/types";

/** 时间分组 key（task 模式保留；置顶单独成组） */
type TimeGroupKey = "pinned" | "today" | "yesterday" | "week" | "earlier";

const TIME_GROUP_ORDER: TimeGroupKey[] = [
  "pinned",
  "today",
  "yesterday",
  "week",
  "earlier",
];

const TIME_GROUP_LABEL: Record<TimeGroupKey, string> = {
  pinned: "置顶",
  today: "今天",
  yesterday: "昨天",
  week: "近 7 天",
  earlier: "更早",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 当天 0 点（本地时区） */
const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * 非置顶项落入时间桶：今天 / 昨天 / 近 7 天（不含今昨）/ 更早。
 * 「近 7 天」= 今天 0 点往前推 7 天内、且不是今天/昨天。
 */
const timeBucketFor = (
  updatedAt: number,
  now: number,
): Exclude<TimeGroupKey, "pinned"> => {
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = todayStart - DAY_MS;
  const weekStart = todayStart - 7 * DAY_MS;
  if (updatedAt >= todayStart) return "today";
  if (updatedAt >= yesterdayStart) return "yesterday";
  if (updatedAt >= weekStart) return "week";
  return "earlier";
};

type TimeGroup = { key: TimeGroupKey; label: string; items: TaskSummary[] };

/** 置顶优先拆组，组内仍按 updatedAt 倒序（sorted 已排好）——仅 task 模式 */
const buildTimeGroups = (sorted: TaskSummary[], now: number): TimeGroup[] => {
  const buckets: Record<TimeGroupKey, TaskSummary[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    week: [],
    earlier: [],
  };
  for (const t of sorted) {
    if (t.pinned) {
      buckets.pinned.push(t);
    } else {
      buckets[timeBucketFor(t.updatedAt, now)].push(t);
    }
  }
  return TIME_GROUP_ORDER.filter((k) => buckets[k].length > 0).map((key) => ({
    key,
    label: TIME_GROUP_LABEL[key],
    items: buckets[key],
  }));
};

export const AppSidebar = ({ open }: { open: boolean }) => {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const activeId = params?.id;
  const {
    tasks,
    loaded,
    upsertTask,
    refresh,
    deletingIds,
    deleteTaskById,
  } = useTaskList();
  const { confirm, prompt } = useDialog();
  // 当前模式（顶栏胶囊同源）——决定列表过滤 + 顶部按钮形态
  const mode = useAppMode();
  // 折叠中的组 key
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => new Set());
  // 置顶手动序
  const [pinnedOrder, setPinnedOrder] = useState<string[]>([]);

  // 挂载时读 view-memory（SSR 安全：仅客户端）
  useEffect(() => {
    setCollapsedKeys(loadSidebarCollapsedGroups());
    setPinnedOrder(loadSidebarPinnedOrder());
  }, []);

  // 按模式过滤 + 排序（置顶优先 → updatedAt 倒序）
  const sorted = useMemo(() => {
    const filtered = tasks.filter((t) =>
      mode === "chat" ? t.mode === "chat" : (t.mode ?? "task") === "task",
    );
    return [...filtered].sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap; // 置顶排最上
      return b.updatedAt - a.updatedAt;
    });
  }, [tasks, mode]);

  // 工作台（work）：时间桶；对话（chat）：仓组
  const timeGroups = useMemo(
    () => (mode === "work" ? buildTimeGroups(sorted, Date.now()) : []),
    [sorted, mode],
  );

  const chatGroups: SidebarGroup[] = useMemo(() => {
    if (mode !== "chat") return [];
    // settings 仓名表（组头 = repos[].name）；进 memo 内读，避免每渲新数组搅依赖
    const repoLookup = (getSettings().repos ?? []).map((r) => ({
      path: r.path,
      name: r.name,
    }));
    return buildRepoGroups(sorted, repoLookup, pinnedOrder);
  }, [mode, sorted, pinnedOrder]);

  // 新建后即时插入列表 + 跳详情
  const handleCreated = (task: Task) => {
    upsertTask(task);
    router.push(`/tasks/${task.id}`);
  };

  // 一键新建对话（零表单）——逻辑抽进 useNewChat；组头「+」可传 repoPaths 预绑
  const { createChat, creating: creatingChat } = useNewChat(handleCreated);

  const toggleCollapsed = (key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveSidebarCollapsedGroups(next);
      return next;
    });
  };

  // 置顶 / 取消置顶：乐观更新 → 失败回滚 + refresh 兜底
  const handlePin = async (task: TaskSummary) => {
    const next = !task.pinned;
    upsertTask({ ...task, pinned: next });
    // 新置顶：追加到手动序末尾；取消：从序里摘掉
    setPinnedOrder((prev) => {
      const cleaned = prev.filter((id) => id !== task.id);
      const order = next ? [...cleaned, task.id] : cleaned;
      saveSidebarPinnedOrder(order);
      return order;
    });
    try {
      const updated = await setTaskPinned(task.id, next);
      upsertTask(updated);
    } catch (err) {
      upsertTask({ ...task, pinned: task.pinned });
      toast.error(`操作失败：${(err as Error).message}`);
      void refresh();
    }
  };

  const handleMovePinned = useCallback(
    (taskId: string, direction: "up" | "down") => {
      const pinnedIds = sorted.filter((t) => t.pinned).map((t) => t.id);
      const next = movePinnedId(pinnedIds, pinnedOrder, taskId, direction);
      setPinnedOrder(next);
      saveSidebarPinnedOrder(next);
    },
    [sorted, pinnedOrder],
  );

  // 侧栏重命名（仅 chat 行有入口）：复用 chat-view 同源 updateTaskFields + prompt
  const handleRename = async (task: TaskSummary) => {
    const next = await prompt({
      title: "重命名对话",
      defaultValue: task.title,
      placeholder: "对话名称",
      validate: (v) => (v.trim() ? "" : "名称不能为空"),
    });
    if (next === null || next.trim() === task.title) return;
    try {
      const updated = await updateTaskFields(task.id, { title: next.trim() });
      upsertTask(updated);
    } catch (err) {
      toast.error(`重命名失败：${(err as Error).message}`);
    }
  };

  // 删除：确认 → deleteTaskById（锁 id 后立刻离开详情 / 404 幂等）
  const handleDelete = async (task: TaskSummary) => {
    // 删除中禁二次点（按钮也会 disabled；这里再挡 confirm 竞态）
    if (deletingIds.has(task.id)) return;
    const ok = await confirm({
      title: "确认删除任务",
      description: `「${task.title}」将被永久删除、连同 data/tasks/${task.id}/ 整个目录、不可恢复。`,
      destructive: true,
      confirmLabel: "确认删除",
    });
    if (!ok) return;
    try {
      // ok / not_found 都当成功——幽灵回魂后再删会 404，勿 toast「任务不存在」
      await deleteTaskById(task.id, {
        onLocked: () => {
          // 锁定后立刻离开详情页，避免 DELETE 等待期间 upsertTask 回灌
          if (activeId === task.id) {
            router.push(task.mode === "chat" ? "/chats" : "/");
          }
        },
      });
      setPinnedOrder((prev) => {
        const order = prev.filter((id) => id !== task.id);
        saveSidebarPinnedOrder(order);
        return order;
      });
    } catch (err) {
      toast.error(`删除失败：${(err as Error).message}`);
      void refresh();
    }
  };

  const empty = sorted.length === 0;

  const renderItem = (
    t: TaskSummary,
    opts?: {
      pinReorder?: boolean;
      pinIndex?: number;
      pinTotal?: number;
    },
  ) => (
    <TaskListItem
      key={t.id}
      task={t}
      active={t.id === activeId}
      onPin={handlePin}
      onDelete={handleDelete}
      // 重命名是 grok 化的 chat 专属入口；task（工作台）行保持改造前无菜单
      onRename={mode === "chat" ? handleRename : undefined}
      deleteDisabled={deletingIds.has(t.id)}
      pinReorder={
        opts?.pinReorder &&
        opts.pinIndex !== undefined &&
        opts.pinTotal !== undefined
          ? {
              onMoveUp: () => handleMovePinned(t.id, "up"),
              onMoveDown: () => handleMovePinned(t.id, "down"),
              canMoveUp: opts.pinIndex > 0,
              canMoveDown: opts.pinIndex < opts.pinTotal - 1,
            }
          : undefined
      }
    />
  );

  const renderChatGroups = (groups: SidebarGroup[]) => (
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        const collapsed = collapsedKeys.has(group.key);
        const isPinned = group.key === "pinned";
        // 置顶无单一 cwd，不展示「+」；仓组 / Home 可预绑新建
        const createPaths = repoPathsForGroupCreate(group);
        return (
          <div key={group.key} className="flex flex-col gap-0.5">
            <div className="flex w-full items-center gap-0.5 rounded-md pr-0.5 hover:bg-muted/40">
              <button
                type="button"
                onClick={() => toggleCollapsed(group.key)}
                className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 pt-1 pb-0.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                aria-expanded={!collapsed}
              >
                {collapsed ? (
                  <ChevronRight className="size-3 shrink-0 opacity-70" />
                ) : (
                  <ChevronDown className="size-3 shrink-0 opacity-70" />
                )}
                <span className="min-w-0 truncate">{group.label}</span>
              </button>
              {createPaths !== null && (
                <Tooltip content="在此目录新建对话" side="right" delay={200}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
                    disabled={creatingChat}
                    aria-label="在此目录新建对话"
                    onClick={(e) => {
                      e.stopPropagation();
                      void createChat({ repoPaths: createPaths });
                    }}
                  >
                    <Plus className="size-3" />
                  </Button>
                </Tooltip>
              )}
            </div>
            {!collapsed &&
              group.items.map((t, i) =>
                renderItem(t, {
                  pinReorder: isPinned,
                  pinIndex: i,
                  pinTotal: group.items.length,
                }),
              )}
          </div>
        );
      })}
    </div>
  );

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
        <div className="flex items-center gap-1 p-2 pb-1">
          {mode === "chat" ? (
            <Button
              className="flex-1"
              onClick={() => void createChat()}
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
          ) : mode === "chat" ? (
            renderChatGroups(chatGroups)
          ) : (
            <div className="flex flex-col gap-2">
              {timeGroups.map((group) => (
                <div key={group.key} className="flex flex-col gap-0.5">
                  <div className="px-3 pt-1 pb-0.5 text-[11px] text-muted-foreground">
                    {group.label}
                  </div>
                  {group.items.map((t) => renderItem(t))}
                </div>
              ))}
            </div>
          )}
        </nav>
      </div>
    </aside>
  );
};
