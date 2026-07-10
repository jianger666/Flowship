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
import { useRouter } from "next/navigation";
import { Blocks, LayoutDashboard, MessageSquare, PanelLeft, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

import { ThemeToggle } from "@/components/theme-toggle";
import { UpdateBadge } from "@/components/update-badge";
import { Button } from "@/components/ui/button";
import { useAppMode, type AppMode } from "@/hooks/use-app-mode";
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

// 底色 = globals.css --background 的 oklch 精确换算 hex（深 oklch(0.17 0.005 264)、
// 浅 oklch(0.967 0.002 247)）——写死值跟真实背景差一截会让 win 控制按钮条一眼异色（同事实测踩过）。
// 改主题色时这里（和 electron-app/main.js 的 HEADER_BG_*）要一起换算更新。
const TITLEBAR_OVERLAY_COLOR = {
  dark: { color: "#0e0f12", symbolColor: "#e5e5e5" },
  light: { color: "#f3f4f5", symbolColor: "#404040" },
};

interface AppHeaderProps {
  // 侧栏是否展开（决定 toggle 的 aria / title 文案）
  sidebarOpen: boolean;
  // 点 toggle 切换侧栏（状态由 AppShell 持有 + localStorage 记忆）
  onToggleSidebar: () => void;
  // 主区是否已向下滚动（由 AppShell 算、>0 时顶栏浮现分隔线）
  scrolled: boolean;
}

/**
 * 胶囊双模式切换（v1.0 界面重构核心）：顶栏居中、点段切模式——
 * 工作台 → `/`（飞书看板 + task 类任务）、对话 → `/chats`（chat 类任务落点）。
 * 当前模式由 URL 推导（useAppMode）、不是本地 state——刷新 / 直开链接不漂移。
 */
const ModeSwitch = ({ mode }: { mode: AppMode }) => {
  const router = useRouter();
  const segments: Array<{ key: AppMode; label: string; icon: React.ReactNode; href: string }> = [
    { key: "work", label: "工作台", icon: <LayoutDashboard className="size-3.5" />, href: "/" },
    { key: "chat", label: "对话", icon: <MessageSquare className="size-3.5" />, href: "/chats" },
  ];
  return (
    <div
      role="tablist"
      aria-label="模式切换"
      className="flex items-center gap-0.5 rounded-full border border-border/70 bg-muted/50 p-0.5"
    >
      {segments.map((s) => {
        const active = mode === s.key;
        return (
          <button
            key={s.key}
            role="tab"
            aria-selected={active}
            onClick={() => router.push(s.href)}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s.icon}
            {s.label}
          </button>
        );
      })}
    </div>
  );
};

export const AppHeader = ({
  sidebarOpen,
  onToggleSidebar,
  scrolled,
}: AppHeaderProps) => {
  // 当前生效主题（深 / 浅）——变化时同步 Windows overlay 底色
  const { resolvedTheme } = useTheme();
  // 平台（"darwin" | "win32" | "linux" | ""）——决定左让交通灯 / 右让控制按钮
  const [platform, setPlatform] = useState("");
  // 当前模式（URL 推导）——胶囊高亮 + 侧栏过滤都用它
  const mode = useAppMode();

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
          "flex items-center gap-2 pl-3 *:[-webkit-app-region:no-drag]",
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
        {/* v1.0：品牌挪左（居中位让给模式胶囊）、点击回当前模式首页 */}
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold tracking-tight text-foreground no-underline hover:opacity-80"
        >
          {/* logo 图本身就是「扣了黑边」的透明角 squircle、不再加方框 ring / CSS 圆角 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="size-7" />
          <span className="hidden sm:inline">AI工作流</span>
        </Link>
      </div>

      {/* 居中：工作台 / 对话 胶囊切换（v1.0 双模式核心） */}
      <div className="absolute left-1/2 -translate-x-1/2 [-webkit-app-region:no-drag]">
        <ModeSwitch mode={mode} />
      </div>

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
        {/* 自定义 Action 管理入口 */}
        <Button
          variant="ghost"
          size="icon-sm"
          nativeButton={false}
          render={
            <Link
              href="/actions"
              className="no-underline"
              aria-label="自定义 Action"
              title="自定义 Action"
            />
          }
        >
          <Blocks />
        </Button>
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
