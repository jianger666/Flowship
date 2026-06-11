"use client";

/**
 * 桌面端「新版本」标识（V0.7.3）
 *
 * 链路：Electron 壳 update-downloaded 后通过 executeJavaScript 注入
 * window.__appUpdateVersion + 派发 app-update-ready 事件（见 electron-app/main.js）；
 * 本组件读到版本号就亮起、点击 confirm 后导航 app-update://install、
 * 壳在 will-navigate 拦截并 quitAndInstall。
 *
 * 浏览器 / mac 环境壳不会注入变量、组件恒 null、零成本。
 */

import { useEffect, useState } from "react";
import { ArrowUpCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDialog } from "@/hooks/use-dialog";

declare global {
  interface Window {
    /** Electron 壳注入：已下载就绪的新版本号 */
    __appUpdateVersion?: string;
  }
}

export const UpdateBadge = () => {
  // 就绪的新版本号（null = 无更新、不渲染）
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
      description: "应用会重启、正在运行的任务会被中断。",
      confirmLabel: "重启更新",
    });
    // 壳的 will-navigate 拦截这个伪协议并触发 quitAndInstall
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
