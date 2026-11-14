"use client";

/**
 * 桌面端「新版本」徽标（V0.7.3、2026-07-23 状态机重构）
 *
 * 链路：Electron 壳主进程维护更新状态机（idle/available/downloading/ready/installing、
 * 见 electron-app/main.js updateState）、preload 暴露 window.__appUpdater 的
 * getState（mount 拉全量）+ onState（实时订阅）；本组件纯状态驱动渲染：
 *   available    「新版本 vX」    点击 → confirm → install()（win 开始下载 / mac 重试暂存）
 *   downloading  「下载中 x%」   禁用（mac 发现新版后台暂存 / win 点击后下载、进度实时刷）
 *   ready        「重启更新 vX」 点击 → confirm → install()（已下载完、重启即完成更新）
 *   installing   「更新中…」     禁用（防重复触发、主进程还有互斥锁双保险）
 *
 * web 版没壳、window.__appUpdater 不存在 → 组件恒 null、零成本。
 *
 * 更新前提示「有任务在运行」（只提示、不阻止）：mac（ready/available 点徽标 → applyStagedUpdate 重启）与
 * win（点徽标 → 下载 → quitAndInstall）都是用户在 install() 这一处拍板、主进程没有任何原生确认框，
 * 所以只在这里拦：确认前现拉一次任务列表，有 runStatus=running 的任务就把「会中断它们」写进同一个确认弹窗
 * （判定与文案见 lib/running-tasks）。用户取消 = 不更新。
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, Loader2, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDialog } from "@/hooks/use-dialog";
import { useTaskList } from "@/hooks/use-task-list";
import type { UpdateState } from "@/lib/app-updater";
import {
  buildUpdateConfirmCopy,
  resolveTasksForUpdateCheck,
  summarizeRunningTasks,
} from "@/lib/running-tasks";
import { fetchTaskList } from "@/lib/task-store";

export const UpdateBadge = () => {
  // 更新状态机快照（null = 无壳 / 尚未拉到、不渲染）
  const [state, setState] = useState<UpdateState | null>(null);
  const { confirm } = useDialog();
  // 全局任务列表（侧栏同一份）：现拉最新失败 / 超时时的兜底
  const { tasks } = useTaskList();
  // install 是 async，闭包里的 tasks 会陈旧：用 ref 取点击时刻的最新缓存
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  // 防重入：点击后要先现拉一次任务列表再弹确认（最多 1.5s），这段空档里连点会叠出两个确认弹窗
  const confirmingRef = useRef(false);

  useEffect(() => {
    const updater = window.__appUpdater;
    if (typeof updater?.getState !== "function") return;
    // 先订阅再拉全量（页面刷新 / 组件晚挂载不丢状态）——顺序不能反：
    // 下载中主进程高频推 percent、getState 回包若晚于推送落地会用旧快照倒退进度
    let disposed = false;
    let pushed = false;
    const unsubscribe = updater.onState?.((s) => {
      pushed = true;
      setState(s);
    });
    void updater.getState().then((s) => {
      if (!disposed && !pushed) setState(s);
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  if (!state || state.phase === "idle" || !state.version) return null;
  const { phase, version, percent } = state;

  const install = async () => {
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    try {
      // 点击这一刻有哪些任务在跑：现拉最新列表（列表轮询只在有任务在跑时才 2s 一次，缓存可能是几十秒前的），
      // 拉不到 / 超时退回缓存——只提示、不阻止，这一步任何失败都不能让「更新」点不动
      const latest = await resolveTasksForUpdateCheck({
        fetchLatest: async () => (await fetchTaskList()).tasks,
        fallback: tasksRef.current,
      });
      // ready = 已下载完、点了就重启装；available = 还没下（win）/ 上次失败可重试（mac）
      const ok = await confirm({
        ...buildUpdateConfirmCopy({
          phase: phase === "ready" ? "ready" : "available",
          version,
          running: summarizeRunningTasks(latest),
        }),
        // 重操作（重启 app 中断任务）opt-out 默认聚焦：焦点留「取消」、避免回车误触发更新
        defaultFocus: "cancel",
      });
      if (ok) window.__appUpdater?.install();
    } finally {
      confirmingRef.current = false;
    }
  };

  if (phase === "downloading") {
    // 封顶 99%：下载完成时 phase 已切 ready、downloading 态显示 100% 会造成
    // 「下完了怎么还在下载」错觉；percent=0（无 Content-Length / 刚起步）不显示百分比
    return (
      <Button
        size="sm"
        variant="outline"
        className="text-primary border-primary/40"
        disabled
      >
        <Loader2 className="animate-spin" />
        {percent > 0 ? `下载中 ${Math.min(percent, 99)}%` : "下载中…"}
      </Button>
    );
  }

  if (phase === "installing") {
    return (
      <Button
        size="sm"
        variant="outline"
        className="text-primary border-primary/40"
        disabled
      >
        <Loader2 className="animate-spin" />
        更新中…
      </Button>
    );
  }

  // available / ready：可点击
  return (
    <Button
      size="sm"
      variant="outline"
      className="text-primary border-primary/40 hover:bg-primary/10"
      onClick={install}
    >
      {phase === "ready" ? <RotateCw /> : <ArrowUpCircle />}
      {phase === "ready" ? `重启更新 v${version}` : `新版本 v${version}`}
    </Button>
  );
};
