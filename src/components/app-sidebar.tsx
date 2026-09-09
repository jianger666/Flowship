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
 *  - 置顶钉住（新置顶追加末尾、无手动排序）；行内重命名
 *  - 组头「+」预绑该仓新建对话（Home = 不绑）
 *  - 每仓组默认只展 4 条、其余走「展开其余 N 条」；置顶组不限
 *  - 行尾删除换归档：点即归档、无确认，找回去会话管理页
 *  - 归档不断序：粘性序按全量对话（含归档）对、组按全量排——归档只藏行，不搬仓库的位置
 *
 * 内容（自上而下）：
 *  - 顶部一栏：对话模式 =「新建对话」；工作台 = 活跃任务小标题
 *  - 全局全文搜索用 Cmd/Ctrl+K
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, ChevronUp, Loader2, Plus } from "lucide-react";
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
  reconcileChatListOrder,
  repoPathsForGroupCreate,
  type SidebarGroup,
} from "@/lib/sidebar-groups";
import { setTaskArchived, setTaskPinned, updateTaskFields } from "@/lib/task-store";
import { cn } from "@/lib/utils";
import {
  loadSidebarChatOrder,
  loadSidebarCollapsedGroups,
  loadSidebarPinnedOrder,
  saveSidebarChatOrder,
  saveSidebarCollapsedGroups,
  saveSidebarPinnedOrder,
  SIDEBAR_CHAT_ORDER_EVENT,
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

/** 每仓组默认展示条数，超出走「展开其余 N 条」；置顶组不限 */
const GROUP_VISIBLE_LIMIT = 4;

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
  const { tasks, loaded, upsertTask, refresh, markArchiving, unmarkArchiving } =
    useTaskList();
  const { prompt } = useDialog();
  // 当前模式（顶栏胶囊同源）——决定列表过滤 + 顶部按钮形态
  const mode = useAppMode();
  // 折叠中的组 key
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => new Set());
  // 置顶手动序（view-memory 持久化；新置顶追加末尾，恢复归档的置顶也回末尾）
  const [pinnedOrder, setPinnedOrder] = useState<string[]>([]);
  // 对话粘性序（组间 + 组内）；空 = 还没 hydrate，buildRepoGroups 回落 updatedAt
  const [chatOrder, setChatOrder] = useState<string[]>([]);
  const [orderHydrated, setOrderHydrated] = useState(false);
  // 归档中 id（防双击连发）
  const [archivingIds, setArchivingIds] = useState<Set<string>>(new Set());
  // 已点「展开其余」的组（默认每组只展 4 条）；置顶组不限、不进这里
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // 挂载时读 view-memory（SSR 安全：仅客户端）
  useEffect(() => {
    setCollapsedKeys(loadSidebarCollapsedGroups());
    setPinnedOrder(loadSidebarPinnedOrder());
    setChatOrder(loadSidebarChatOrder());
    setOrderHydrated(true);
  }, []);

  useEffect(() => {
    const onOrder = () => setChatOrder(loadSidebarChatOrder());
    window.addEventListener(SIDEBAR_CHAT_ORDER_EVENT, onOrder);
    return () => window.removeEventListener(SIDEBAR_CHAT_ORDER_EVENT, onOrder);
  }, []);

  // 过滤后的列表。工作台渲染直接用这份（置顶优先 + updatedAt）。
  // 归档默认在侧栏隐藏、去会话管理页找回。
  const sorted = useMemo(() => {
    const filtered = tasks.filter(
      (t) =>
        !t.archived &&
        (mode === "chat" ? t.mode === "chat" : (t.mode ?? "task") === "task"),
    );
    return [...filtered].sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap; // 置顶排最上
      return b.updatedAt - a.updatedAt;
    });
  }, [tasks, mode]);

  // 全量对话（含已归档、仅去已删）：粘性序按它对、组顺序也按它排。
  // 归档只藏行：占位留在序里，仓库组就地不动（2026-09-09 用户实测归档后仓库乱跳）
  const allChats = useMemo(() => {
    if (mode !== "chat") return [] as TaskSummary[];
    return tasks.filter((t) => t.mode === "chat");
  }, [tasks, mode]);

  const allChatIds = useMemo(
    () =>
      [...allChats]
        .sort((a, b) => {
          const ap = a.pinned ? 1 : 0;
          const bp = b.pinned ? 1 : 0;
          if (ap !== bp) return bp - ap;
          return b.updatedAt - a.updatedAt;
        })
        .map((t) => t.id),
    [allChats],
  );

  const archivedChatIds = useMemo(
    () => new Set(allChats.filter((t) => t.archived).map((t) => t.id)),
    [allChats],
  );

  // 粘性序对齐全量对话：已有相对位置不动，新窗口插顶，已删丢掉、归档留占位
  useEffect(() => {
    if (!orderHydrated || mode !== "chat") return;
    setChatOrder((prev) => {
      const prevSet = new Set(prev);
      let next = reconcileChatListOrder(prev, allChatIds);
      // 老数据升级：以前掉队的归档 id 回归时沉底，别把组顶上去（只触发一次）
      const returned = next.filter(
        (id) => !prevSet.has(id) && archivedChatIds.has(id),
      );
      if (returned.length > 0) {
        const returnedSet = new Set(returned);
        next = [
          ...next.filter((id) => !returnedSet.has(id)),
          ...returned,
        ];
      }
      if (
        next.length === prev.length &&
        next.every((id, i) => id === prev[i])
      ) {
        return prev;
      }
      saveSidebarChatOrder(next);
      return next;
    });
  }, [orderHydrated, mode, allChatIds, archivedChatIds]);

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
    // 组顺序按全量（含归档）定、渲染只取未归档：归档藏行不搬组
    const orderPos = new Map(
      buildRepoGroups(allChats, repoLookup, pinnedOrder, chatOrder).map(
        (g, i) => [g.key, i] as const,
      ),
    );
    return buildRepoGroups(sorted, repoLookup, pinnedOrder, chatOrder).sort(
      (a, b) =>
        (orderPos.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
        (orderPos.get(b.key) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [mode, sorted, allChats, pinnedOrder, chatOrder]);

  // 新建后即时插入列表 + 跳详情
  const handleCreated = (task: Task | TaskSummary) => {
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

  const toggleGroupExpanded = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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

  const renderItem = (t: TaskSummary) => (
    <TaskListItem
      key={t.id}
      task={t}
      active={t.id === activeId}
      onPin={handlePin}
      onArchive={handleArchive}
      // 重命名是 grok 化的 chat 专属入口；task（工作台）行保持改造前无菜单
      onRename={mode === "chat" ? handleRename : undefined}
      archiveDisabled={archivingIds.has(t.id)}
    />
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

  // 归档：点即归档、无确认；归档后侧栏隐藏，去会话管理页找回/恢复/彻底删除
  const handleArchive = async (task: TaskSummary) => {
    if (archivingIds.has(task.id)) return;
    setArchivingIds((prev) => new Set(prev).add(task.id));
    // 先乐观、再标记：标记窗口内轮询/SSE 回来的旧快照不得盖掉这一笔
    upsertTask({ ...task, archived: true });
    markArchiving(task.id, true);
    try {
      const updated = await setTaskArchived(task.id, true);
      upsertTask(updated);
      setPinnedOrder((prev) => {
        const order = prev.filter((id) => id !== task.id);
        saveSidebarPinnedOrder(order);
        return order;
      });
      if (activeId === task.id) {
        router.push(task.mode === "chat" ? "/chats" : "/");
      }
      const running = task.runStatus === "running";
      toast.success(
        running
          ? `已归档「${task.title}」、任务仍在后台跑`
          : `已归档「${task.title}」、可在会话管理找回`,
        {
          action: {
            label: "撤销",
            onClick: () => {
              void (async () => {
                // 恢复方向同样标记：窗口内服务端旧快照（archived:true）不得闪掉刚恢复的行
                markArchiving(task.id, false);
                try {
                  const restored = await setTaskArchived(task.id, false);
                  upsertTask(restored);
                  // 恢复归档的置顶时把手动序接回去（跟会话页 restorePinnedOrder 同语义），
                  // 否则钉还在、序掉到末尾
                  if (restored.pinned) {
                    setPinnedOrder((prev) => {
                      if (prev.includes(task.id)) return prev;
                      const order = [...prev, task.id];
                      saveSidebarPinnedOrder(order);
                      return order;
                    });
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
    } catch (err) {
      // 先放行再恢复：标记窗口内恢复性 upsert 会被当旧快照拒掉
      unmarkArchiving(task.id);
      upsertTask({ ...task, archived: task.archived });
      toast.error(`归档失败：${(err as Error).message}`);
      void refresh();
    } finally {
      unmarkArchiving(task.id);
      setArchivingIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  };

  const empty = sorted.length === 0;

  const renderChatGroups = (groups: SidebarGroup[]) => (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const collapsed = collapsedKeys.has(group.key);
        const isPinned = group.key === "pinned";
        // 置顶无单一 cwd，不展示「+」；仓组 / Home 可预绑新建
        const createPaths = repoPathsForGroupCreate(group);
        // 非置顶组默认只展 4 条
        const expanded = expandedGroups.has(group.key);
        const limited =
          !isPinned && !expanded && group.items.length > GROUP_VISIBLE_LIMIT;
        const visibleItems = limited
          ? group.items.slice(0, GROUP_VISIBLE_LIMIT)
          : group.items;
        const hiddenCount = group.items.length - visibleItems.length;
        return (
          <div key={group.key} className="flex flex-col gap-0.5">
            <div className="group/header flex w-full items-center gap-0.5 px-1 pt-1.5 pb-0.5">
              <button
                type="button"
                onClick={() => toggleCollapsed(group.key)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-left"
                aria-expanded={!collapsed}
              >
                {collapsed ? (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                ) : (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/60" />
                )}
                <span className="min-w-0 truncate text-[13px] font-semibold tracking-wide text-foreground/80 hover:text-foreground">
                  {group.label}
                </span>
              </button>
              {createPaths !== null && (
                <Tooltip content="在此目录新建对话" side="right" delay={200}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-5 shrink-0 text-muted-foreground opacity-0 hover:text-foreground group-hover/header:opacity-100 focus-visible:opacity-100"
                    disabled={creatingChat}
                    aria-label="在此目录新建对话"
                    onClick={(e) => {
                      e.stopPropagation();
                      void createChat({ repoPaths: createPaths });
                    }}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </Tooltip>
              )}
            </div>
            {!collapsed && (
              <>
                {visibleItems.map((t) => renderItem(t))}
                {!isPinned && group.items.length > GROUP_VISIBLE_LIMIT && (
                  <button
                    type="button"
                    onClick={() => toggleGroupExpanded(group.key)}
                    aria-expanded={expanded}
                    className="ml-6 flex w-fit items-center gap-1 px-1 py-1 text-left text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
                  >
                    {expanded ? (
                      <ChevronUp className="size-3 shrink-0" />
                    ) : (
                      <ChevronDown className="size-3 shrink-0" />
                    )}
                    {expanded ? "收起" : `展开其余 ${hiddenCount} 条`}
                  </button>
                )}
              </>
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
              {creatingChat ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Plus />
              )}
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
