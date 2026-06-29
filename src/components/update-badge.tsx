"use client";

/**
 * 桌面端「新版本」标识（V0.7.3）
 *
 * 链路：Electron 壳发现更新后通过 executeJavaScript 注入 window.__appUpdateVersion
 * + 派发 app-update-ready 事件（见 electron-app/main.js）；本组件读到版本号就亮起、
 * 点击 confirm 后导航 app-update://install、壳在 will-navigate 拦截 →
 * win/mac 一致：下载更新（任务栏 / Dock 显示进度）、完成后提示重启。
 *
 * 壳未注入版本号时（首帧 / 注入前）组件恒 null、零成本。
 */

import { useEffect, useState } from "react";
import { ArrowUpCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDialog } from "@/hooks/use-dialog";

declare global {
  interface Window {
    /** Electron 壳注入：当前 app 版本号（设置页展示用） */
    __appVersion?: string;
    /** Electron 壳注入：已发现的新版本号（点亮标识用） */
    __appUpdateVersion?: string;
  }
}

export const UpdateBadge = () => {
  // 已发现的新版本号（null 时不渲染）
  const [version, setVersion] = useState<string | null>(null);
  const { confirm } = useDialog();

  useEffect(() => {
    // 变量给「注入早于 mount」兜底、事件给「注入晚于 mount」实时响应
    const read = () => setVersion(window.__appUpdateVersion ?? null);
    read();
    window.addEventListener("app-update-ready", read);
    return () => window.removeEventListener("app-update-ready", read);
  }, []);

  if (!version) return null;

  const install = async () => {
    const ok = await confirm({
      title: `更新到 v${version}？`,
      description: "下载并安装更新、完成后会提示重启、数据不丢。",
      confirmLabel: "立即更新",
      // 重操作（重启 app 中断任务）opt-out 默认聚焦：焦点留「取消」、避免回车误触发更新
      defaultFocus: "cancel",
    });
    // 壳的 will-navigate 拦截这个伪协议——win downloadUpdate、mac 壳内下载替换自身、两端完成后提示重启
    if (ok) window.location.href = "app-update://install";
  };

  return (
    <Button
      size="sm"
      variant="outline"
      className="text-primary border-primary/40 hover:bg-primary/10"
      onClick={install}
    >
      <ArrowUpCircle />
      新版本 v{version}
    </Button>
  );
};
