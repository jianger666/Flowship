"use client";

/**
 * 首页飞书排期甘特（V0.14.1 数据源重写、同事实测踩坑后定型）
 *
 * 数据源 /api/feishu/board（meegle workhour list-schedule、飞书「人员排期」视图
 * 同款接口）：按 默认空间 + 我 + 时间区间 查我参与的全部排期。
 * 为什么不用 mywork todo：只覆盖「当前节点等我操作」的工作项、子任务负责人
 *（非节点 owner）拉不到自己的需求。
 *
 * - 空间 = settings.meegleProject（全局唯一默认空间、设置页可改；看板不再切换）
 * - 时间范围变化 → 重新拉取（接口按区间查）
 * - 点击：已有任务 → 任务页；没有 → 工作项预览页（启动才建任务）
 * - 降级态：CLI 未装 / 未授权 → 引导卡；报错 → 重试
 * - localStorage 按空间分 key 缓存秒开、请求序号防竞态
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plug, RefreshCw } from "lucide-react";

import { BoardTimeline } from "@/components/feishu/board-timeline";
import type { DayRange } from "@/components/ui/date-range-picker";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { LoadingState } from "@/components/ui/loading-state";
import { getSettings, initSettings } from "@/lib/local-store";
import { settingsUrl } from "@/lib/settings-link";
import { DEFAULT_MEEGLE_PROJECT, type FeAiFlowSettings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { markShellContentReady } from "@/lib/shell-ready";
import { loadBoardRange, saveBoardRange } from "@/lib/view-memory";
import { useTaskList } from "@/hooks/use-task-list";
import { shouldTrustCachedTaskLink } from "@/lib/workitem-link";

type MeegleProjectSetting = NonNullable<FeAiFlowSettings["meegleProject"]>;

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
  /** 可访问空间（设置页下拉仍用；看板本身不再切空间） */
  projects?: Array<{ key: string; name: string; simpleName?: string }>;
  /** 区间过长、服务端只查了前面一部分时：实际覆盖到的结束时间（ms） */
  coveredTo?: number;
}

/** 区间变化后等多久再发请求（连点「平移」只发最后一次；首拉不等待） */
const RANGE_DEBOUNCE_MS = 300;

const CACHE_KEY = "flowship.board.cache.v3";
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- 主组件 ----------

export const FeishuBoard = () => {
  const router = useRouter();
  // 侧栏任务列表：点看板时实时校验 it.task（缓存旧映射不失效，盲跳会 404）
  const { tasks, loaded: tasksLoaded, loadError: tasksLoadError } = useTaskList();
  const liveTaskIds = useMemo(
    () => new Set(tasks.map((t) => t.id)),
    [tasks],
  );
  // 数据（null = 首次还没回来）
  const [resp, setResp] = useState<BoardResp | null>(null);
  // resp 的同步镜像（refresh 回调里做「手上是否有好数据」判断、不依赖闭包陈旧值）
  const respRef = useRef<BoardResp | null>(null);
  // 刷新飞行中（顶部转圈、不清空已有数据）
  const [refreshing, setRefreshing] = useState(false);
  // 请求序号：旧请求晚到不覆盖新数据
  const seqRef = useRef(0);
  // 在途请求的取消句柄：换区间 / 新一轮刷新 / 卸载时 abort 旧请求——
  // 服务端 meegle 是进程级串行队列，不取消就会把没人要的旧请求全跑完，还堵住预览页等别的 meegle 调用（D2a-04）
  const abortRef = useRef<AbortController | null>(null);
  const firstFetchRef = useRef(true);
  // 瞬态失败静默重试余额（成功回满；见 refresh 里的护栏注释）
  const retryLeftRef = useRef(2);
  // 静默重试 timer：卸载 / 新一轮 refresh 必须清掉，防幽灵 refresh
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 组件挂载态：timer 回调再判一次，避免卸载后仍触发
  const aliveRef = useRef(true);
  // refresh 的 ref 化（重试 timer 里调最新版、不把自己塞进依赖）
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const scheduleSilentRetry = useCallback(
    (seq: number) => {
      clearRetryTimer();
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (!aliveRef.current) return;
        if (seq === seqRef.current) void refreshRef.current?.();
      }, 5_000);
    },
    [clearRetryTimer],
  );
  // 默认飞书空间（settings.meegleProject；初值硬编码默认、init 后若用户改过会覆盖）
  const [meegleProject, setMeegleProject] = useState<MeegleProjectSetting>(() => ({
    ...DEFAULT_MEEGLE_PROJECT,
  }));
  // 时间范围（接口按区间查、变化触发重拉）：默认今天前 3 天 ~ 后 10 天；
  // 改过的区间记 session（v1.1.x、切页回来不重置；重启回默认、防陈旧日期）
  const [range, setRange] = useState<DayRange>(() => {
    const saved = loadBoardRange();
    if (saved) return saved;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { from: d.getTime() - 3 * DAY_MS, to: d.getTime() + 10 * DAY_MS };
  });

  // 挂载后读 settings 里的默认空间（可能与硬编码默认不同）
  useEffect(() => {
    void initSettings().then(() => {
      const p = getSettings().meegleProject ?? DEFAULT_MEEGLE_PROJECT;
      setMeegleProject({
        key: p.key,
        name: p.name,
        ...(p.simpleName ? { simpleName: p.simpleName } : {}),
      });
    });
  }, []);

  // mount：先吃缓存秒开（按空间分 key）、再后台刷新。
  // v1.1.x 换 localStorage：跨重启也秒开（同事实测「启动很慢」、重启后 session 缓存
  // 全空、首屏干等飞书接口）——旧数据先亮、refreshing 转圈提示在刷
  useEffect(() => {
    try {
      const cached = localStorage.getItem(`${CACHE_KEY}.${meegleProject.key}`);
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
  }, [meegleProject.key]);

  const refresh = useCallback(async () => {
    // 新一轮开始先清掉上一轮静默重试，避免叠多个幽灵 timer
    clearRetryTimer();
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRefreshing(true);
    try {
      const qs = new URLSearchParams();
      qs.set("project", meegleProject.key);
      qs.set("from", String(range.from));
      qs.set("to", String(range.to));
      const r = await fetch(`/api/feishu/board?${qs.toString()}`, {
        signal: ctrl.signal,
      });
      const data = (await r.json()) as BoardResp;
      // 只缓存 ok 响应——升级重启后 CLI 冷启动的瞬态失败若写进跨重启缓存、
      // 下次启动首屏直接渲降级态（用户实测「升级完授权像没检测到」的元凶之一）
      if (data.status === "ok") {
        try {
          localStorage.setItem(
            `${CACHE_KEY}.${meegleProject.key}`,
            JSON.stringify(data),
          );
        } catch {
          /* 超配额忽略 */
        }
      }
      if (seq === seqRef.current) {
        // 瞬态失败护栏：手上有好数据（缓存秒开的旧看板）时、这轮刷新失败不清屏成
        // 降级引导（升级重启后 CLI 冷启动首拉常瞬态挂、看板被闪成「去授权」踩过）——
        // 保留旧看板、5s 后静默重试（最多 2 次、之后才认输渲降级态）。
        // not_authed / error / not_installed 一律进护栏（不绕过）——服务端已保证
        // 只有确定性未登录才返 not_authed，VPN 超时走 error，重试耗尽后分别渲授权 / 重试空态
        const prev = respRef.current;
        if (data.status !== "ok" && prev?.status === "ok" && retryLeftRef.current > 0) {
          retryLeftRef.current -= 1;
          scheduleSilentRetry(seq);
          return;
        }
        if (data.status === "ok") retryLeftRef.current = 2;
        respRef.current = data;
        setResp(data);
      }
    } catch (err) {
      // 被我们自己 abort（换区间 / 新一轮刷新 / 卸载）不是失败：别画错误态、别排重试
      if (ctrl.signal.aborted) return;
      if (seq === seqRef.current) {
        // fetch 本身挂（网络 / server 短暂不可达）走同一护栏：有好数据不清屏、静默重试
        const prev = respRef.current;
        if (prev?.status === "ok" && retryLeftRef.current > 0) {
          retryLeftRef.current -= 1;
          scheduleSilentRetry(seq);
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
      if (seq === seqRef.current && !ctrl.signal.aborted) setRefreshing(false);
    }
  }, [meegleProject.key, range, clearRetryTimer, scheduleSilentRetry]);

  useEffect(() => {
    aliveRef.current = true;
    refreshRef.current = refresh;
    // 首拉立即发；之后区间 / 空间变化防抖 300ms，连点「往后平移」只发最后一次（D2a-04）
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (firstFetchRef.current) {
      firstFetchRef.current = false;
      void refresh();
    } else {
      timer = setTimeout(() => void refresh(), RANGE_DEBOUNCE_MS);
    }
    return () => {
      aliveRef.current = false;
      if (timer !== null) clearTimeout(timer);
      clearRetryTimer();
      abortRef.current?.abort();
    };
  }, [refresh, clearRetryTimer]);

  // 点击工作项：有「仍存活」的任务直进、否则进预览（不盲信看板缓存里的 it.task）
  const handleOpen = useCallback(
    (it: BoardItem) => {
      // localStorage / 内存缓存里的 task id 删任务后不失效——用侧栏实时列表校验；
      // 列表还没加载完（loaded=false、tasks 空）时回退信任缓存映射——否则秒开缓存
      // 期间点已有任务会被误导去预览页、可能重复建任务
      // 列表首拉失败（loaded=true 但没数据 + 有失败）同样拿不到实时校验，也回退信任缓存（shouldTrustCachedTaskLink）
      if (
        it.task &&
        (shouldTrustCachedTaskLink({
          loaded: tasksLoaded,
          loadError: tasksLoadError,
          taskCount: tasks.length,
        }) ||
          liveTaskIds.has(it.task.id))
      ) {
        router.push(`/tasks/${it.task.id}`);
        return;
      }
      const qs = new URLSearchParams();
      if (it.projectKey) qs.set("project", it.projectKey);
      if (it.name) qs.set("name", it.name);
      if (it.url) qs.set("url", it.url);
      router.push(`/workitems/${encodeURIComponent(it.id)}?${qs.toString()}`);
    },
    [router, liveTaskIds, tasksLoaded, tasksLoadError, tasks.length],
  );

  const items = useMemo(() => resp?.items ?? [], [resp]);

  // 开屏一屏到底（v1.1.x）：真实内容（看板 / 降级引导）渲出来才通知壳收 splash——
  // resp 到了（含缓存秒开）且不再是「纯 loading」态即算
  const contentReady = resp !== null && !(refreshing && items.length === 0);
  useEffect(() => {
    if (contentReady) markShellContentReady();
  }, [contentReady]);

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
  // 只有「还没有任何响应」才整页 hero：已有响应（哪怕 0 条）刷新 / 平移区间时保留工具条与区间选择器，
  // 只在刷新钮上转圈——否则空看板「往后平移找排期」每一步都整页闪烁且不可操作（D2a-05）
  if (resp === null) {
    return <LoadingState variant="hero" immediate />;
  }

  // ---------- 甘特主体 ----------
  return (
    // 甘特是时间线视图、直接铺满全宽（用户拍板「大屏直接铺满」）、只留 padding
    <div className="flex h-full w-full flex-col gap-3 px-6 py-5 xl:px-10">
      <div className="flex shrink-0 items-center gap-2.5">
        <h1 className="text-lg font-semibold tracking-tight">我的排期</h1>
        {/* 当前默认空间名：只展示、不可点（切空间去设置页） */}
        <span className="text-xs text-muted-foreground">{meegleProject.name}</span>
        {resp.coveredTo !== undefined && resp.coveredTo < range.to ? (
          <span className="text-xs text-warning">
            区间太长，只显示到 {new Date(resp.coveredTo).getMonth() + 1}/
            {new Date(resp.coveredTo).getDate()}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          render={<Link href="/workitems/new" />}
        >
          手动建任务
        </Button>
        <Tooltip content="刷新">
          <span className="inline-flex">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-label="刷新"
            >
              <RefreshCw className={cn(refreshing && "animate-spin")} />
            </Button>
          </span>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1">
        <BoardTimeline
          items={items}
          onOpen={handleOpen}
          range={range}
          refreshing={refreshing}
          onRangeChange={(r) => {
            setRange(r);
            saveBoardRange(r);
          }}
        />
      </div>
    </div>
  );
};
