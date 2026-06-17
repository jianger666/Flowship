"use client";

/**
 * 全站顶部条（自定义标题栏、V0.7.x；V0.8 加侧栏 toggle）
 *
 * 用户要 Cursor 式「同色一体顶栏」——消除 mac 原生灰标题栏那条异色横条：
 * - 壳侧（electron-app/main.js）：mac 用 titleBarStyle hiddenInset 隐藏原生栏、红黄绿浮左上；
 *   win 用 titleBarOverlay 让系统画右上角窗口控制按钮。
 * - 本组件：整条设为可拖动窗口区（-webkit-app-region: drag）、交互元素 no-drag。
 *
 * 布局三段：
 *   左：侧栏展开 / 收起 toggle（⌘/Ctrl+B 同效、状态由 AppShell 持有；mac 让开左上角交通灯）
 *   中：品牌（logo + 名字、点击回首页）——absolute 居中、跨页最稳的锚点
 *   右：功能键（更新 / 主题 / 设置；win 让出右上角窗口控制按钮位）
 *
 * 滚动分隔：不滚时与内容同色无缝；主区滚动 >0（scrolled 由 AppShell 算后传入）才浮现 border-b。
 *
 * Windows：右侧控件让出窗口控制按钮宽度；主题切换时把应用真实 bg/fg 同步给壳更新 overlay。
 */

import Link from "next/link";
import { PanelLeft, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

import { ThemeToggle } from "@/components/theme-toggle";
import { UpdateBadge } from "@/components/update-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

declare global {
  interface Window {
    /** Electron preload 暴露的壳能力（仅桌面端有） */
    __shell?: {
      platform: string;
      setTitleBarOverlay: (opts: { color: string; symbolColor: string }) => void;
    };
  }
}

const TITLEBAR_OVERLAY_COLOR = {
  dark: { color: "#17181c", symbolColor: "#e5e5e5" },
  light: { color: "#f3f4f6", symbolColor: "#404040" },
};

interface AppHeaderProps {
  // 侧栏是否展开（决定 toggle 的 aria / title 文案）
  sidebarOpen: boolean;
  // 点 toggle 切换侧栏（状态由 AppShell 持有 + localStorage 记忆）
  onToggleSidebar: () => void;
  // 主区是否已向下滚动（由 AppShell 算、>0 时顶栏浮现分隔线）
  scrolled: boolean;
}

export const AppHeader = ({
  sidebarOpen,
  onToggleSidebar,
  scrolled,
}: AppHeaderProps) => {
  // 当前生效主题（深 / 浅）——变化时同步 Windows overlay 底色
  const { resolvedTheme } = useTheme();
  // 平台（"darwin" | "win32" | "linux" | ""）——决定左让交通灯 / 右让控制按钮
  const [platform, setPlatform] = useState("");

  useEffect(() => {
    setPlatform(window.__shell?.platform ?? "");
  }, []);

  // Windows 自定义标题栏：右上角窗口控制按钮条底色 / 图标色跟随应用主题（mac 走 hiddenInset、跳过）
  useEffect(() => {
    const shell = window.__shell;
    if (!shell || shell.platform === "darwin") return;
    // 不读 computed color：主题 token 是 OKLCH，Chromium 可能原样返回 oklch(...)
    // 让 rgb parser 失效，Windows overlay 留在启动期黑色。这里用壳侧同款 hex。
    const id = requestAnimationFrame(() => {
      shell.setTitleBarOverlay(
        TITLEBAR_OVERLAY_COLOR[resolvedTheme === "dark" ? "dark" : "light"],
      );
    });
    return () => cancelAnimationFrame(id);
  }, [resolvedTheme]);

  const isWin = platform === "win32";
  const isMac = platform === "darwin";

  return (
    <header
      className={cn(
        "sticky top-0 z-40 flex h-14 shrink-0 items-center border-b border-transparent bg-background transition-colors [-webkit-app-region:drag]",
        scrolled && "border-border/70",
      )}
    >
      {/* 左：侧栏 toggle 常驻顶栏（红绿灯右侧、位置固定不随开合跳——展开 / 收起都点这一个）。
          mac 用更大左 padding 让开交通灯、再多留一段间距（用户要「离红绿灯远一点」）。 */}
      <div
        className={cn(
          "flex items-center pl-3 *:[-webkit-app-region:no-drag]",
          isMac && "pl-22",
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleSidebar}
          aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
          title={sidebarOpen ? "收起侧栏（⌘/Ctrl+B）" : "展开侧栏（⌘/Ctrl+B）"}
        >
          <PanelLeft />
        </Button>
      </div>

      {/* 居中品牌：logo（圆角方块图标、与 app 图标一致）+ 名字、点击回首页 */}
      <Link
        href="/"
        className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2 font-semibold tracking-tight text-foreground no-underline hover:opacity-80 [-webkit-app-region:no-drag]"
      >
        {/* logo 图本身就是「扣了黑边」的透明角 squircle、不再加方框 ring / CSS 圆角 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="" className="size-7" />
        AI工作流
      </Link>

      {/* 右：功能键（win 让出右上角窗口控制按钮位）；主题 / 设置统一纯图标 ghost、规格对齐 */}
      <div
        className={cn(
          "ml-auto flex items-center gap-1 pr-4 *:[-webkit-app-region:no-drag]",
          isWin && "pr-34",
        )}
      >
        {/* 桌面端有新版本就绪时亮起（壳注入版本号后显示） */}
        <UpdateBadge />
        {/* 主题切换（浅色 / 深色 / 跟随系统） */}
        <ThemeToggle />
        <Button
          variant="ghost"
          size="icon-sm"
          nativeButton={false}
          render={
            <Link
              href="/settings"
              className="no-underline"
              aria-label="设置"
              title="设置"
            />
          }
        >
          <Settings />
        </Button>
      </div>
    </header>
  );
};
