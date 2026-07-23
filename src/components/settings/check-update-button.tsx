"use client";

/**
 * 桌面端「检查更新」按钮（设置页版本号旁）
 *
 * 壳通过 preload 暴露 window.__appUpdater.check()（见 electron-app/preload.cjs）。
 * 点一下按需查一次 GitHub 最新 release：已是最新 / 发现新版 / 失败都给 toast 反馈；
 * 发现新版时壳会同步点亮右上角「新版本」标识（UpdateBadge）、走既有自更新流程。
 * web 版没壳、window.__appUpdater 不存在 → 组件恒 null、零成本。
 */

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
// 副作用 import：window.__appUpdater 全局类型声明集中在这（UpdateBadge 共用）
import "@/lib/app-updater";

export const CheckUpdateButton = () => {
  // 当前是否跑在桌面壳里（web 版无 __appUpdater、不渲染按钮）
  const [hasShell, setHasShell] = useState(false);
  // 正在查更新——按钮 disabled + spinner 防双击连查
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setHasShell(typeof window.__appUpdater?.check === "function");
  }, []);

  if (!hasShell) return null;

  const handleCheck = async () => {
    const updater = window.__appUpdater;
    if (!updater || checking) return;
    setChecking(true);
    try {
      const r = await updater.check();
      if (r.status === "latest") {
        toast.success(`已是最新版本 v${r.current}`);
      } else if (r.status === "available") {
        // 壳已点亮右上角徽标（mac 已暂存时显示「重启更新」、其余「新版本」）、引导去那更新
        toast.success(`发现新版本 v${r.latest}、点右上角按钮完成更新`);
      } else {
        toast.error(`检查更新失败：${r.message ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(
        `检查更新失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs text-muted-foreground"
      onClick={handleCheck}
      disabled={checking}
    >
      <RefreshCw className={checking ? "animate-spin" : ""} />
      {checking ? "检查中…" : "检查更新"}
    </Button>
  );
};
