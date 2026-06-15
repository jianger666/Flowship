"use client";

/**
 * 桌面端「新版本」标识（V0.7.3、V0.7.7 加 mac 下载模式）
 *
 * 链路：Electron 壳发现更新后通过 executeJavaScript 注入
 * window.__appUpdateVersion / __appUpdateMode + 派发 app-update-ready 事件
 * （见 electron-app/main.js）；本组件读到版本号就亮起、点击 confirm 后导航
 * app-update://install、壳在 will-navigate 拦截——win 重启即装、mac 打开下载页。
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
    /** Electron 壳注入：已就绪的新版本号 */
    __appUpdateVersion?: string;
    /** Electron 壳注入：更新方式（win 重启即装 / mac 打开下载页） */
    __appUpdateMode?: "install" | "download";
  }
}

export const UpdateBadge = () => {
  // 就绪的新版本号 + 更新方式（version=null 时不渲染）
  const [update, setUpdate] = useState<{
    version: string;
    mode: "install" | "download";
  } | null>(null);
  const { confirm } = useDialog();

  useEffect(() => {
    // 变量给「注入早于 mount」兜底、事件给「注入晚于 mount」实时响应
    const read = () =>
      setUpdate(
        window.__appUpdateVersion
          ? {
              version: window.__appUpdateVersion,
              mode: window.__appUpdateMode ?? "install",
            }
          : null,
      );
    read();
    window.addEventListener("app-update-ready", read);
    return () => window.removeEventListener("app-update-ready", read);
  }, []);

  if (!update) return null;
  const { version, mode } = update;

  const install = async () => {
    const download = mode === "download";
    const ok = await confirm({
      title: `更新到 v${version}？`,
      description: download
        ? "自动下载安装（Dock 图标显示进度）、完成后重启生效、数据不丢。"
        : "应用会重启、正在运行的任务会被中断。",
      confirmLabel: download ? "立即更新" : "重启更新",
    });
    // 壳的 will-navigate 拦截这个伪协议——win quitAndInstall、mac 壳内下载替换自身
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
