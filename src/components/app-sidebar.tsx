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
 *  - 搜索框：按标题本地过滤；搜索时打平忽略置顶/分组，清空恢复原视图
 *  - 列表：Cursor 风格时间分组——置顶 / 今天 / 昨天 / 近 7 天 / 更早（chat + task 对称）
 *  - 行尾 hover：置顶（已置顶常显高亮）/ 删除（二次确认）
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { TaskListItem } from "@/components/tasks/task-list-item";
import { Button } from "@/components/ui/button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { useAppMode } from "@/hooks/use-app-mode";
import { useDialog } from "@/hooks/use-dialog";
import { useNewChat } from "@/hooks/use-new-chat";
import { useTaskList } from "@/hooks/use-task-list";
import { setTaskPinned } from "@/lib/task-store";
import { cn } from "@/lib/utils";
import type { Task, TaskSummary } from "@/lib/types";

/** 时间分组 key（置顶单独成组、不按时间沉底） */
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
const timeBucketFor = (updatedAt: number, now: number): Exclude<TimeGroupKey, "pinned"> => {
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = todayStart - DAY_MS;
  const weekStart = todayStart - 7 * DAY_MS;
  if (updatedAt >= todayStart) return "today";
  if (updatedAt >= yesterdayStart) return "yesterday";
  if (updatedAt >= weekStart) return "week";
  return "earlier";
};

type TimeGroup = { key: TimeGroupKey; label: string; items: TaskSummary[] };

/** 置顶优先拆组，组内仍按 updatedAt 倒序（sorted 已排好） */
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
  const { confirm } = useDialog();
  // 当前模式（顶栏胶囊同源）——决定列表过滤 + 顶部按钮形态
  const mode = useAppMode();
  // 侧栏搜索关键字（受控；trim 后非空即进入「搜索打平」视图）
  const [query, setQuery] = useState("");

  // 切模式时清搜索——避免对话关键字残留在工作台列表上
  useEffect(() => {
    setQuery("");
  }, [mode]);

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

  // Cursor 风格时间分组（chat / task 对称）
  const timeGroups = useMemo(
    () => buildTimeGroups(sorted, Date.now()),
    [sorted],
  );

  // 搜索：标题包含（大小写不敏感）、打平忽略置顶/时间分组
  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;
  const searchResults = useMemo(() => {
    if (!isSearching) return [];
    const q = trimmedQuery.toLowerCase();
    return sorted.filter((t) => t.title.toLowerCase().includes(q));
  }, [isSearching, trimmedQuery, sorted]);

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

        {/* 搜索框：紧凑贴合侧栏；放大镜作视觉标签、aria-label 补无障碍（placeholder  alone 不够） */}
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
            // 搜索视图：打平命中列表；空结果 EmptyHint（不清空搜索时不回分组）
            searchResults.length === 0 ? (
              <div className="mt-2">
                <EmptyHint variant="dashed" size="sm" align="center">
                  {searchEmptyHint}
                </EmptyHint>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {searchResults.map((t) => (
                  <TaskListItem
                    key={t.id}
                    task={t}
                    active={t.id === activeId}
                    onPin={handlePin}
                    onDelete={handleDelete}
                    deleteDisabled={deletingIds.has(t.id)}
                    highlightQuery={trimmedQuery}
                  />
                ))}
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
          ) : (
            <div className="flex flex-col gap-2">
              {timeGroups.map((group) => (
                <div key={group.key} className="flex flex-col gap-0.5">
                  <div className="px-3 pt-1 pb-0.5 text-[11px] text-muted-foreground">
                    {group.label}
                  </div>
                  {group.items.map((t) => (
                    <TaskListItem
                      key={t.id}
                      task={t}
                      active={t.id === activeId}
                      onPin={handlePin}
                      onDelete={handleDelete}
                      deleteDisabled={deletingIds.has(t.id)}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </nav>
      </div>
    </aside>
  );
};
