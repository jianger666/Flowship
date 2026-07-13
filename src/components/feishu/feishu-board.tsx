"use client";

/**
 * 首页飞书排期甘特（V0.14.1 数据源重写、同事实测踩坑后定型）
 *
 * 数据源 /api/feishu/board（meegle workhour list-schedule、飞书「人员排期」视图
 * 同款接口）：按 空间 + 我 + 时间区间 查我参与的全部排期。
 * 为什么不用 mywork todo：只覆盖「当前节点等我操作」的工作项、子任务负责人
 *（非节点 owner）拉不到自己的需求、空间下拉也因此缺空间（同事踩过）。
 *
 * - 空间列表 = project search 全量（下拉切换、记忆上次选择）
 * - 时间范围变化 → 重新拉取（接口按区间查）
 * - 点击：已有任务 → 任务页；没有 → 工作项预览页（启动才建任务）
 * - 降级态：CLI 未装 / 未授权 → 引导卡；报错 → 重试
 * - sessionStorage 缓存秒开、请求序号防竞态
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plug, RefreshCw } from "lucide-react";

import { BoardTimeline } from "@/components/feishu/board-timeline";
import type { DayRange } from "@/components/ui/date-range-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { settingsUrl } from "@/lib/settings-link";
import { cn } from "@/lib/utils";
import { markShellContentReady } from "@/lib/shell-ready";
import { loadBoardRange, saveBoardRange } from "@/lib/view-memory";

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
  /** 展开细节（workhour 排期语义下天然只有自己的子任务） */
  nodes?: Array<{
    name: string;
    status?: string;
    start?: number;
    end?: number;
    subTasks?: Array<{
      name: string;
      start?: number;
      end?: number;
      finished?: boolean;
    }>;
  }>;
  task: BoardTaskBrief | null;
}

type BoardStatus = "ok" | "not_installed" | "not_authed" | "error";

interface BoardResp {
  status: BoardStatus;
  message?: string;
  items?: BoardItem[];
  /** 可访问空间（project search 全量） */
  projects?: Array<{ key: string; name: string }>;
}

const CACHE_KEY = "feaiflow.board.cache.v3";
const DAY_MS = 24 * 60 * 60 * 1000;
const SPACE_KEY = "feaiflow.board.space";

// ---------- AI 任务状态徽标 ----------

/** AI 任务状态 → 徽标（甘特行 + 未排期 chip 共用） */
export const AiStatusBadge = ({ task }: { task: BoardTaskBrief | null }) => {
  // 没有 AI 任务不显示徽标（用户拍板：满屏「未开始」纯噪音、AI 在干的才亮）
  if (!task) return null;
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
  // resp 的同步镜像（refresh 回调里做「手上是否有好数据」判断、不依赖闭包陈旧值）
  const respRef = useRef<BoardResp | null>(null);
  // 刷新飞行中（顶部转圈、不清空已有数据）
  const [refreshing, setRefreshing] = useState(false);
  // 请求序号：旧请求晚到不覆盖新数据
  const seqRef = useRef(0);
  // 瞬态失败静默重试余额（成功回满；见 refresh 里的护栏注释）
  const retryLeftRef = useRef(2);
  // refresh 的 ref 化（重试 timer 里调最新版、不把自己塞进依赖）
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  // 选中空间（localStorage 记忆、首次 = 列表第一个）
  const [spaceKey, setSpaceKey] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SPACE_KEY);
    } catch {
      return null;
    }
  });
  // 时间范围（接口按区间查、变化触发重拉）：默认今天前 3 天 ~ 后 10 天；
  // 改过的区间记 session（v1.1.x、切页回来不重置；重启回默认、防陈旧日期）
  const [range, setRange] = useState<DayRange>(() => {
    const saved = loadBoardRange();
    if (saved) return saved;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { from: d.getTime() - 3 * DAY_MS, to: d.getTime() + 10 * DAY_MS };
  });

  // mount：先吃缓存秒开（按空间分 key）、再后台刷新。
  // v1.1.x 换 localStorage：跨重启也秒开（同事实测「启动很慢」、重启后 session 缓存
  // 全空、首屏干等飞书接口）——旧数据先亮、refreshing 转圈提示在刷
  useEffect(() => {
    try {
      const cached = localStorage.getItem(`${CACHE_KEY}.${spaceKey ?? ""}`);
      if (cached) {
        const parsed = JSON.parse(cached) as BoardResp;
        // 只吃 ok 缓存：老版本写过 not_authed / error 进缓存、首屏会闪降级引导
        if (parsed.status === "ok") {
          respRef.current = parsed;
          setResp(parsed);
        }
      }
    } catch {
      /* 缓存坏了忽略 */
    }
  }, [spaceKey]);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    setRefreshing(true);
    try {
      const qs = new URLSearchParams();
      if (spaceKey) qs.set("project", spaceKey);
      qs.set("from", String(range.from));
      qs.set("to", String(range.to));
      const r = await fetch(`/api/feishu/board?${qs.toString()}`);
      const data = (await r.json()) as BoardResp;
      // 只缓存 ok 响应——升级重启后 CLI 冷启动的瞬态失败若写进跨重启缓存、
      // 下次启动首屏直接渲降级态（用户实测「升级完授权像没检测到」的元凶之一）
      if (data.status === "ok") {
        try {
          localStorage.setItem(`${CACHE_KEY}.${spaceKey ?? ""}`, JSON.stringify(data));
        } catch {
          /* 超配额忽略 */
        }
      }
      if (seq === seqRef.current) {
        // 瞬态失败护栏：手上有好数据（缓存秒开的旧看板）时、这轮刷新失败不清屏成
        // 降级引导（升级重启后 CLI 冷启动首拉常瞬态挂、看板被闪成「去授权」踩过）——
        // 保留旧看板、5s 后静默重试（最多 2 次、之后才认输渲降级态）
        const prev = respRef.current;
        if (data.status !== "ok" && prev?.status === "ok" && retryLeftRef.current > 0) {
          retryLeftRef.current -= 1;
          setTimeout(() => {
            if (seq === seqRef.current) void refreshRef.current?.();
          }, 5_000);
          return;
        }
        if (data.status === "ok") retryLeftRef.current = 2;
        respRef.current = data;
        setResp(data);
        // 没选过空间：默认列表第一个（触发下一轮带 project 的拉取）
        if (!spaceKey && data.status === "ok" && (data.projects?.length ?? 0) > 0) {
          setSpaceKey(data.projects![0].key);
        }
      }
    } catch (err) {
      if (seq === seqRef.current) {
        // fetch 本身挂（网络 / server 短暂不可达）走同一护栏：有好数据不清屏、静默重试
        const prev = respRef.current;
        if (prev?.status === "ok" && retryLeftRef.current > 0) {
          retryLeftRef.current -= 1;
          setTimeout(() => {
            if (seq === seqRef.current) void refreshRef.current?.();
          }, 5_000);
        } else {
          const failed: BoardResp = {
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          };
          respRef.current = failed;
          setResp(failed);
        }
      }
    } finally {
      if (seq === seqRef.current) setRefreshing(false);
    }
  }, [spaceKey, range]);

  useEffect(() => {
    refreshRef.current = refresh;
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
  // 空间列表：project search 全量（V0.14.1、不再从数据聚合——mywork 覆盖不全踩过）
  const spaces = resp?.projects ?? [];

  // 首启没记忆空间时、第一轮响应只是占位（仅 projects、items 空）——随即自动选
  // 第一个空间触发真拉取；这个中间态不算内容就绪、也不渲空甘特
  const pickingSpace =
    resp?.status === "ok" && !spaceKey && (resp.projects?.length ?? 0) > 0;

  // 开屏一屏到底（v1.1.x）：真实内容（看板 / 降级引导）渲出来才通知壳收 splash——
  // resp 到了（含缓存秒开）且不再是「纯 loading / 占位」态即算
  const contentReady = resp !== null && !pickingSpace && !(refreshing && items.length === 0);
  useEffect(() => {
    if (contentReady) markShellContentReady();
  }, [contentReady]);

  const handlePickSpace = useCallback((key: string) => {
    setSpaceKey(key);
    try {
      localStorage.setItem(SPACE_KEY, key);
    } catch {
      /* noop */
    }
  }, []);

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

  // ---------- 首拉 loading：整区居中（不带看板头部行）----------
  // 位置跟首页 gate 的 hero 完全重合——原来 loading 在头部行下方的 flex-1 里、
  // 中心比 gate loading 低一截、启动链三段 loading 逐级往下跳（用户实测「不断往下抖」）
  if (resp === null || pickingSpace || (refreshing && items.length === 0)) {
    return <LoadingState variant="hero" immediate />;
  }

  // ---------- 甘特主体 ----------
  return (
    // 甘特是时间线视图、直接铺满全宽（用户拍板「大屏直接铺满」）、只留 padding
    <div className="flex h-full w-full flex-col gap-3 px-6 py-5 xl:px-10">
      <div className="flex shrink-0 items-center gap-2.5">
        <h1 className="text-lg font-semibold tracking-tight">我的排期</h1>
        {/* 空间切换：单选、project search 全量（用户拍板「不要展示全部」混排） */}
        {spaces.length > 0 && (
          <Select value={spaceKey ?? undefined} onValueChange={(v) => v && handlePickSpace(v)}>
            <SelectTrigger size="sm" className="h-7 w-auto gap-1.5 text-xs">
              {/* SelectValue 默认渲染 value（projectKey 哈希）——显式渲染空间名（用户截图点名「这里是个 id」） */}
              <SelectValue placeholder="选择空间">
                {spaces.find((s) => s.key === spaceKey)?.name ?? "选择空间"}
              </SelectValue>
            </SelectTrigger>
            {/* w-auto：弹层宽自适应（长空间名被裁踩过）；
                alignItemWithTrigger=false：默认会把选中项对准触发器、列表长时向上溢出
                盖到 Electron 标题栏（drag 区域点不了、用户截图踩过）——强制往下弹 */}
            <SelectContent
              className="w-auto min-w-(--anchor-width) max-w-80"
              alignItemWithTrigger={false}
              side="bottom"
            >
              {spaces.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          render={<Link href="/workitems/new" />}
        >
          手动建任务
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

      <div className="min-h-0 flex-1">
        <BoardTimeline
          items={items}
          onOpen={handleOpen}
          range={range}
          onRangeChange={(r) => {
            setRange(r);
            saveBoardRange(r);
          }}
        />
      </div>
    </div>
  );
};
