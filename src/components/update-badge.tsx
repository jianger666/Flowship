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
 */

import { useEffect, useState } from "react";
import { ArrowUpCircle, Loader2, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDialog } from "@/hooks/use-dialog";
import type { UpdateState } from "@/lib/app-updater";

export const UpdateBadge = () => {
  // 更新状态机快照（null = 无壳 / 尚未拉到、不渲染）
  const [state, setState] = useState<UpdateState | null>(null);
  const { confirm } = useDialog();

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
    // ready = 已下载完、点了就重启装；available = 还没下（win）/ 上次失败可重试（mac）
    const ok = await confirm({
      title: `更新到 v${version}？`,
      description:
        phase === "ready"
          ? "新版本已下载完成、点击后将自动重启完成更新、数据不丢。"
          : "将下载并安装更新、完成后自动重启、数据不丢。",
      confirmLabel: phase === "ready" ? "重启更新" : "立即更新",
      // 重操作（重启 app 中断任务）opt-out 默认聚焦：焦点留「取消」、避免回车误触发更新
      defaultFocus: "cancel",
    });
    if (ok) window.__appUpdater?.install();
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
