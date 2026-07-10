"use client";

/**
 * 首页飞书项目看板（V0.14.1 简化版、用户拍板「只要一个像飞书排期那样的甘特图」）
 *
 * 数据源 /api/feishu/board（meegle mywork todo）：**跨空间**拉「我负责的待办工作项」
 *（12 个空间里指派给我的都在、不是单空间全量）+ 本地任务 join（AI 状态徽标）。
 *
 * 形态：单一甘特视图（BoardTimeline、日期段筛选在甘特工具条里）。
 * 点击：已有任务 → 直进任务页；没有 → 工作项预览页（启动才建任务）。
 * 降级态：CLI 未装 / 未授权 → 引导卡；报错 → 重试。
 * sessionStorage 缓存秒开、后台刷新；请求序号防快速刷新竞态。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plug, RefreshCw } from "lucide-react";

import { BoardTimeline } from "@/components/feishu/board-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

const CACHE_KEY = "feaiflow.board.cache.v2";

// ---------- AI 任务状态徽标 ----------

/** AI 任务状态 → 徽标（甘特行 + 未排期 chip 共用） */
export const AiStatusBadge = ({ task }: { task: BoardTaskBrief | null }) => {
  if (!task) {
    return (
      <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
        未开始
      </Badge>
    );
  }
  if (task.repoStatus === "merged")
    return <Badge className="shrink-0 bg-emerald-600 text-[10px] text-white">已合入</Badge>;
  if (task.repoStatus === "abandoned")
    return <Badge variant="secondary" className="shrink-0 text-[10px]">已放弃</Badge>;
  if (task.runStatus === "running")
    return (
      <Badge className="shrink-0 gap-1 bg-blue-600 text-[10px] text-white">
        <span className="size-1.5 animate-pulse rounded-full bg-white" />
        AI 进行中
      </Badge>
    );
  if (task.runStatus === "awaiting_user")
    return (
      <Badge className="shrink-0 gap-1 bg-amber-500 text-[10px] text-white">
        <span className="size-1.5 animate-pulse rounded-full bg-white" />
        等你回复
      </Badge>
    );
  if (task.runStatus === "error")
    return <Badge variant="destructive" className="shrink-0 text-[10px]">异常</Badge>;
  return <Badge variant="secondary" className="shrink-0 text-[10px]">进行中</Badge>;
};

// ---------- 主组件 ----------

export const FeishuBoard = () => {
  const router = useRouter();
  // 数据（null = 首次还没回来）
  const [resp, setResp] = useState<BoardResp | null>(null);
  // 刷新飞行中（顶部转圈、不清空已有数据）
  const [refreshing, setRefreshing] = useState(false);
  // 请求序号：旧请求晚到不覆盖新数据
  const seqRef = useRef(0);

  // mount：先吃缓存秒开、再后台刷新
  useEffect(() => {
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) setResp(JSON.parse(cached) as BoardResp);
    } catch {
      /* 缓存坏了忽略 */
    }
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    setRefreshing(true);
    try {
      const r = await fetch("/api/feishu/board?action=todo");
      const data = (await r.json()) as BoardResp;
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
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
  }, []);

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
              ? "首页会变成你的排期甘特、点一下工作项就能让 AI 开工"
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

  // ---------- 甘特主体 ----------
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 px-6 py-4">
      <div className="flex shrink-0 items-center gap-2">
        <h1 className="text-lg font-semibold tracking-tight">我的排期</h1>
        <span className="text-xs text-muted-foreground">
          全部空间 · 我负责的待办{items.length > 0 ? ` · ${items.length} 项` : ""}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label="刷新"
          title="刷新"
        >
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        {resp === null ? (
          <LoadingState variant="block" label="正在拉取飞书工作项…" />
        ) : (
          <BoardTimeline items={items} onOpen={handleOpen} />
        )}
      </div>
    </div>
  );
};
