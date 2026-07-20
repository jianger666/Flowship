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
 * 2026-07-20 grok 化（chat 侧）：
 *  - 分组轴：按工作目录/仓库（默认）或按状态；task 模式仍时间桶、不回归
 *  - 置顶区手动上/下移（序存 view-memory）
 *  - 行内重命名；搜索 ≥2 字兼扫正文，结果分「标题命中 / 内容命中」
 *
 * 内容（自上而下）：
 *  - 顶部一栏：对话模式 =「新建对话」+ 分组切换；工作台 = 活跃任务小标题
 *  - 搜索框：按标题本地过滤；≥2 字再打正文 API；搜索时打平分组
 *  - 列表：chat = 置顶 / 仓组 / 未绑定（可折叠）；task = 时间桶
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { TaskListItem } from "@/components/tasks/task-list-item";
import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { useAppMode } from "@/hooks/use-app-mode";
import { useDialog } from "@/hooks/use-dialog";
import { useNewChat } from "@/hooks/use-new-chat";
import { useTaskList } from "@/hooks/use-task-list";
import { getSettings } from "@/lib/local-store";
import {
  buildRepoGroups,
  buildStatusGroups,
  mergeSidebarSearchSections,
  movePinnedId,
  type ContentSearchHit,
  type SidebarGroup,
  type SidebarGroupMode,
  type SidebarSearchSection,
} from "@/lib/sidebar-groups";
import { searchTaskContents, setTaskPinned, updateTaskFields } from "@/lib/task-store";
import { cn } from "@/lib/utils";
import {
  loadSidebarCollapsedGroups,
  loadSidebarGroupMode,
  loadSidebarPinnedOrder,
  saveSidebarCollapsedGroups,
  saveSidebarGroupMode,
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
  // 侧栏搜索关键字（受控；trim 后非空即进入「搜索打平」视图）
  const [query, setQuery] = useState("");
  // chat：按仓 / 按状态（view-memory 持久化）
  const [groupMode, setGroupMode] = useState<SidebarGroupMode>("repo");
  // 折叠中的组 key
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => new Set());
  // 置顶手动序
  const [pinnedOrder, setPinnedOrder] = useState<string[]>([]);
  // 正文搜索命中（q≥2 时拉 API）
  const [contentHits, setContentHits] = useState<ContentSearchHit[]>([]);
  // 正文搜索进行中
  const [contentSearching, setContentSearching] = useState(false);

  // 挂载时读 view-memory（SSR 安全：仅客户端）
  useEffect(() => {
    setGroupMode(loadSidebarGroupMode());
    setCollapsedKeys(loadSidebarCollapsedGroups());
    setPinnedOrder(loadSidebarPinnedOrder());
  }, []);

  // 切模式时清搜索——避免对话关键字残留在工作台列表上
  useEffect(() => {
    setQuery("");
    setContentHits([]);
  }, [mode]);

  // settings 仓名表（组头 = repos[].name；getSettings 同步缓存、每渲现读即可）
  const repoLookup = (getSettings().repos ?? []).map((r) => ({
    path: r.path,
    name: r.name,
  }));

  // 按模式过滤 + 排序（置顶优先 → updatedAt 倒序）；搜索打平与分组视图共用此源
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

  // 工作台（work）：时间桶；对话（chat）：仓组 / 状态组
  const timeGroups = useMemo(
    () => (mode === "work" ? buildTimeGroups(sorted, Date.now()) : []),
    [sorted, mode],
  );

  const chatGroups: SidebarGroup[] = useMemo(() => {
    if (mode !== "chat") return [];
    return groupMode === "status"
      ? buildStatusGroups(sorted, pinnedOrder)
      : buildRepoGroups(sorted, repoLookup, pinnedOrder);
  }, [mode, groupMode, sorted, repoLookup, pinnedOrder]);

  // 搜索：标题本地命中
  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;
  const titleHits = useMemo(() => {
    if (!isSearching) return [];
    const q = trimmedQuery.toLowerCase();
    return sorted.filter((t) => t.title.toLowerCase().includes(q));
  }, [isSearching, trimmedQuery, sorted]);

  // ≥2 字拉正文搜索（chat）；task 模式只标题
  useEffect(() => {
    if (mode !== "chat" || trimmedQuery.length < 2) {
      setContentHits([]);
      setContentSearching(false);
      return;
    }
    let cancelled = false;
    setContentSearching(true);
    const t = window.setTimeout(() => {
      void searchTaskContents(trimmedQuery)
        .then((hits) => {
          if (!cancelled) setContentHits(hits);
        })
        .catch(() => {
          if (!cancelled) setContentHits([]);
        })
        .finally(() => {
          if (!cancelled) setContentSearching(false);
        });
    }, 200); // 轻防抖
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [mode, trimmedQuery]);

  const searchSections: SidebarSearchSection[] = useMemo(() => {
    if (!isSearching) return [];
    if (mode !== "chat" || trimmedQuery.length < 2) {
      // 仅标题 / 或不足 2 字：单节打平（无「标题命中」标签，避免单节啰嗦）
      return titleHits.length > 0
        ? [{ key: "title", label: "标题命中", items: titleHits }]
        : [];
    }
    const byId = new Map(sorted.map((t) => [t.id, t]));
    return mergeSidebarSearchSections(titleHits, contentHits, byId);
  }, [
    isSearching,
    mode,
    trimmedQuery,
    titleHits,
    contentHits,
    sorted,
  ]);

  // 新建后即时插入列表 + 跳详情
  const handleCreated = (task: Task) => {
    upsertTask(task);
    router.push(`/tasks/${task.id}`);
  };

  // 一键新建对话（零表单、对齐 codex / Cursor Agent Window）——逻辑抽进 useNewChat、跟首页复用
  const { createChat, creating: creatingChat } = useNewChat(handleCreated);

  const handleGroupModeChange = (next: SidebarGroupMode) => {
    setGroupMode(next);
    saveSidebarGroupMode(next);
  };

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

  // 侧栏重命名：复用 chat-view 同源 updateTaskFields + prompt
  const handleRename = async (task: TaskSummary) => {
    const next = await prompt({
      title: mode === "chat" ? "重命名对话" : "重命名任务",
      defaultValue: task.title,
      placeholder: mode === "chat" ? "对话名称" : "任务名称",
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
  // 搜索框 placeholder / aria / 空结果文案随模式对称
  const searchLabel = mode === "chat" ? "搜索对话" : "搜索任务";
  const searchEmptyHint =
    mode === "chat" ? "没有匹配的对话" : "没有匹配的任务";

  const renderItem = (
    t: TaskSummary,
    opts?: {
      highlightQuery?: string;
      contentSnippet?: string;
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
      onRename={handleRename}
      deleteDisabled={deletingIds.has(t.id)}
      highlightQuery={opts?.highlightQuery}
      contentSnippet={opts?.contentSnippet}
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
        return (
          <div key={group.key} className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => toggleCollapsed(group.key)}
              className="flex w-full items-center gap-1 rounded-md px-2 pt-1 pb-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              aria-expanded={!collapsed}
            >
              {collapsed ? (
                <ChevronRight className="size-3 shrink-0 opacity-70" />
              ) : (
                <ChevronDown className="size-3 shrink-0 opacity-70" />
              )}
              <span className="min-w-0 truncate">{group.label}</span>
              <span className="ml-auto tabular-nums text-muted-foreground/60">
                {group.items.length}
              </span>
            </button>
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

        {/* chat：按仓 / 按状态小切换 */}
        {mode === "chat" && (
          <div className="flex items-center gap-1 px-2 pb-1">
            <ChoiceButton
              shape="chip"
              selected={groupMode === "repo"}
              onClick={() => handleGroupModeChange("repo")}
              className="flex-1 justify-center"
            >
              按仓库
            </ChoiceButton>
            <ChoiceButton
              shape="chip"
              selected={groupMode === "status"}
              onClick={() => handleGroupModeChange("status")}
              className="flex-1 justify-center"
            >
              按状态
            </ChoiceButton>
          </div>
        )}

        {/* 搜索框：紧凑贴合侧栏；放大镜作视觉标签、aria-label 补无障碍（placeholder alone 不够） */}
        <div className="relative px-2 pb-1.5">
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
            className="h-7 pl-8 text-xs"
          />
        </div>

        {/* 列表滚动区 */}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {!loaded ? (
            <LoadingState variant="inline" className="block px-3 py-2" />
          ) : isSearching ? (
            // 搜索视图：打平命中；chat ≥2 字分「标题 / 内容」两节
            searchSections.length === 0 && !contentSearching ? (
              <div className="mt-2">
                <EmptyHint variant="dashed" size="sm" align="center">
                  {searchEmptyHint}
                </EmptyHint>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {contentSearching && trimmedQuery.length >= 2 && mode === "chat" && (
                  <div className="px-3 py-1 text-[11px] text-muted-foreground">
                    搜索正文中…
                  </div>
                )}
                {searchSections.map((section) => (
                  <div key={section.key} className="flex flex-col gap-0.5">
                    {/* ≥2 字且两节可能并存时才显示节头；仅标题一节也标一下便于区分后续内容节 */}
                    {(mode === "chat" && trimmedQuery.length >= 2) ||
                    searchSections.length > 1 ? (
                      <div className="px-3 pt-1 pb-0.5 text-[11px] text-muted-foreground">
                        {section.label}
                      </div>
                    ) : null}
                    {section.items.map((t) =>
                      renderItem(t, {
                        highlightQuery: trimmedQuery,
                        contentSnippet:
                          section.key === "content"
                            ? t.contentSnippet
                            : undefined,
                      }),
                    )}
                  </div>
                ))}
                {searchSections.length === 0 && contentSearching && (
                  <LoadingState variant="inline" className="block px-3 py-2" />
                )}
              </div>
            )
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
