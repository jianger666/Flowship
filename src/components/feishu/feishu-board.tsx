"use client";

/**
 * 首页飞书项目看板（V0.14、用户拍板「首页做成飞书项目看板」）
 *
 * 数据源 /api/feishu/board（meegle mywork、跨空间「我的工作项」+ 本地任务 join）。
 * - 筛选 tabs：待办 / 本周 / 逾期 / 已办（mywork 原生 action、不用自己算）
 * - 视图切换：列表 / 时间线（board-timeline.tsx）
 * - 双状态徽标：飞书节点状态 + AI 任务状态——一屏看全「需求到哪了、AI 干到哪了」
 * - 点击：已有任务 → 直进任务页；没有 → 工作项预览页（预览态、启动才建任务）
 * - 降级态：CLI 未装 / 未授权 → 引导卡；报错 → 重试
 * - sessionStorage 缓存：秒开上次数据、后台刷新（CLI 调用 1-3s、别白屏等）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarRange, ListTodo, Plug, RefreshCw, Rows3 } from "lucide-react";

import { BoardTimeline } from "@/components/feishu/board-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { settingsUrl } from "@/lib/settings-link";
import { cn } from "@/lib/utils";

// ---------- 类型（对齐 /api/feishu/board 返回） ----------

export interface BoardTaskBrief {
  id: string;
  repoStatus: string;
  runStatus: string;
  lastActionType?: string;
  lastActionStatus?: string;
}

export interface BoardItem {
  id: string;
  name: string;
  projectKey?: string;
  projectName?: string;
  typeLabel?: string;
  statusLabel?: string;
  scheduleStart?: number;
  scheduleEnd?: number;
  url?: string;
  task: BoardTaskBrief | null;
}

type BoardStatus = "ok" | "not_installed" | "not_authed" | "error";

interface BoardResp {
  status: BoardStatus;
  message?: string;
  items?: BoardItem[];
}

type MyworkAction = "todo" | "this_week" | "overdue" | "done";
type ViewMode = "list" | "timeline";

const ACTION_TABS: Array<{ key: MyworkAction; label: string }> = [
  { key: "todo", label: "待办" },
  { key: "this_week", label: "本周" },
  { key: "overdue", label: "逾期" },
  { key: "done", label: "已办" },
];

const CACHE_KEY = "feaiflow.board.cache.v1";

// ---------- AI 任务状态徽标 ----------

/** AI 任务状态 → 徽标（看板双状态里的「AI 侧」） */
export const AiStatusBadge = ({ task }: { task: BoardTaskBrief | null }) => {
  if (!task) {
    return (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        未开始
      </Badge>
    );
  }
  if (task.repoStatus === "merged")
    return <Badge className="bg-emerald-600 text-[10px] text-white">已合入</Badge>;
  if (task.repoStatus === "abandoned")
    return <Badge variant="secondary" className="text-[10px]">已放弃</Badge>;
  if (task.runStatus === "running")
    return (
      <Badge className="gap-1 bg-blue-600 text-[10px] text-white">
        <span className="size-1.5 animate-pulse rounded-full bg-white" />
        AI 进行中
      </Badge>
    );
  if (task.runStatus === "awaiting_user")
    return (
      <Badge className="gap-1 bg-amber-500 text-[10px] text-white">
        <span className="size-1.5 animate-pulse rounded-full bg-white" />
        等你回复
      </Badge>
    );
  if (task.runStatus === "error")
    return <Badge variant="destructive" className="text-[10px]">异常</Badge>;
  return <Badge variant="secondary" className="text-[10px]">进行中</Badge>;
};

// 排期展示：MM/DD（跨年补年）；逾期（end < 今天 0 点）红字
const fmtDate = (ms: number): string => {
  const d = new Date(ms);
  const now = new Date();
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`;
};

const isOverdue = (end?: number): boolean => {
  if (!end) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return end < today.getTime();
};

// ---------- 主组件 ----------

export const FeishuBoard = () => {
  const router = useRouter();
  // 当前筛选 tab
  const [action, setAction] = useState<MyworkAction>("todo");
  // 视图：列表 / 时间线
  const [view, setView] = useState<ViewMode>("list");
  // 数据（null = 首次还没回来）
  const [resp, setResp] = useState<BoardResp | null>(null);
  // 刷新飞行中（顶部转圈、不清空已有数据）
  const [refreshing, setRefreshing] = useState(false);
  // 请求序号：快切 tab 时旧请求晚到不覆盖新 tab 数据（审计 P1 竞态）
  const seqRef = useRef(0);

  // mount：先吃缓存秒开、再后台刷新
  useEffect(() => {
    try {
      const cached = sessionStorage.getItem(`${CACHE_KEY}.${action}`);
      if (cached) setResp(JSON.parse(cached) as BoardResp);
    } catch {
      /* 缓存坏了忽略 */
    }
  }, [action]);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    setRefreshing(true);
    try {
      const r = await fetch(`/api/feishu/board?action=${action}`);
      const data = (await r.json()) as BoardResp;
      // 期间用户切了 tab / 又点了刷新 → 本响应过期、只写缓存不动 UI
      try {
        sessionStorage.setItem(`${CACHE_KEY}.${action}`, JSON.stringify(data));
      } catch {
        /* 超配额忽略 */
      }
      if (seq === seqRef.current) setResp(data);
    } catch (err) {
      if (seq === seqRef.current) {
        setResp({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (seq === seqRef.current) setRefreshing(false);
    }
  }, [action]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 点击工作项：有任务直进、没任务进预览
  const handleOpen = useCallback(
    (it: BoardItem) => {
      if (it.task) {
        router.push(`/tasks/${it.task.id}`);
        return;
      }
      const qs = new URLSearchParams();
      if (it.projectKey) qs.set("project", it.projectKey);
      if (it.name) qs.set("name", it.name);
      if (it.url) qs.set("url", it.url);
      router.push(`/workitems/${encodeURIComponent(it.id)}?${qs.toString()}`);
    },
    [router],
  );

  const items = useMemo(() => resp?.items ?? [], [resp]);

  // ---------- 降级态 ----------
  if (resp && resp.status !== "ok") {
    const isSetup = resp.status === "not_installed" || resp.status === "not_authed";
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
          <Plug className="size-8 text-muted-foreground" />
          <div className="text-base font-medium">
            {resp.status === "not_installed"
              ? "接入飞书项目、需求直接变任务"
              : resp.status === "not_authed"
                ? "授权飞书项目、需求直接变任务"
                : "看板加载失败"}
          </div>
          <p className="text-sm text-muted-foreground">
            {isSetup
              ? "看板会展示你的飞书项目待办、点一下就能让 AI 开工"
              : resp.message}
          </p>
          {isSetup ? (
            <Button size="sm" onClick={() => router.push(settingsUrl("feishu"))}>
              去设置页{resp.status === "not_installed" ? "安装" : "授权"}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              重试
            </Button>
          )}
        </div>
      </div>
    );
  }

  // ---------- 看板主体 ----------
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 px-6 py-5">
      {/* 顶部：标题 + 筛选 + 视图切换 + 刷新 */}
      <div className="flex shrink-0 items-center gap-2">
        <h1 className="text-lg font-semibold tracking-tight">我的工作项</h1>
        <span className="text-xs text-muted-foreground">
          {items.length > 0 ? `${items.length} 项` : ""}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {ACTION_TABS.map((t) => (
            <ChoiceButton
              key={t.key}
              shape="chip"
              selected={action === t.key}
              onClick={() => setAction(t.key)}
              className="px-2.5 py-1 text-xs"
            >
              {t.label}
            </ChoiceButton>
          ))}
          <div className="mx-1 h-4 w-px bg-border" />
          <Button
            size="icon-xs"
            variant={view === "list" ? "secondary" : "ghost"}
            onClick={() => setView("list")}
            aria-label="列表视图"
            title="列表"
          >
            <Rows3 />
          </Button>
          <Button
            size="icon-xs"
            variant={view === "timeline" ? "secondary" : "ghost"}
            onClick={() => setView("timeline")}
            aria-label="时间线视图"
            title="时间线"
          >
            <CalendarRange />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="刷新"
            title="刷新"
          >
            <RefreshCw className={cn(refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {resp === null ? (
          <LoadingState variant="block" label="正在拉取飞书工作项…" />
        ) : items.length === 0 ? (
          <EmptyHint size="lg" align="center">
            <ListTodo className="mx-auto mb-2 size-6 text-muted-foreground" />
            {action === "todo" ? "没有待办工作项、清净" : "这个筛选下没有工作项"}
          </EmptyHint>
        ) : view === "timeline" ? (
          <BoardTimeline items={items} onOpen={handleOpen} />
        ) : (
          <div className="divide-y divide-border/60 rounded-lg border border-border/60">
            {items.map((it) => {
              const overdue = isOverdue(it.scheduleEnd) && it.task?.repoStatus !== "merged";
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => handleOpen(it)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{it.name}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {it.projectName && <span>{it.projectName}</span>}
                      {it.typeLabel && <span>{it.typeLabel}</span>}
                      {(it.scheduleStart || it.scheduleEnd) && (
                        <span className={cn(overdue && "font-medium text-red-500")}>
                          {it.scheduleStart ? fmtDate(it.scheduleStart) : ""}
                          {" ~ "}
                          {it.scheduleEnd ? fmtDate(it.scheduleEnd) : ""}
                          {overdue && "（逾期）"}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* 双状态徽标：飞书侧 + AI 侧 */}
                  {it.statusLabel && (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {it.statusLabel}
                    </Badge>
                  )}
                  <AiStatusBadge task={it.task} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
