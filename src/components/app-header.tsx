"use client";

/**
 * 全站顶部条（自定义标题栏、V0.7.x）
 *
 * 用户要 Cursor 式「同色一体顶栏」——消除 mac 原生灰标题栏那条异色横条：
 * - 壳侧（electron-app/main.js）：mac 用 titleBarStyle hiddenInset 隐藏原生栏、红黄绿浮左上；
 *   win 用 titleBarOverlay 让系统画右上角窗口控制按钮。
 * - 本组件：整条设为可拖动窗口区（-webkit-app-region: drag）、交互元素 no-drag；
 *   品牌（logo + 名字）居中、功能键靠右；sticky 常驻顶部、保证拖拽区不随滚动消失。
 *
 * 为什么品牌居中（V0.7.x、用户拍板、对标 Cursor）：
 *   各页内容宽度并不统一——首页 max-w-4xl 居中、设置 max-w-3xl 居中、任务详情全宽 px-6。
 *   居中是跨页最稳的锚点（始终屏幕正中、不依赖某页的内容宽度）；靠左反而会被 mac 红黄绿
 *   交通灯挤到一起、且和各页左对齐内容的轴线对不上。功能键仍靠右（win 让出控制按钮位）。
 *
 * 滚动分隔（V0.7.x）：不滚时与内容同色无缝；滚动 >0 才浮现一条 border-b——
 *   一体化顶栏标准做法，既保证顶到顶的干净、又在长列表滚动时给出顶栏/内容边界。
 *
 * Windows：右侧控件让出窗口控制按钮宽度；主题切换时把应用真实 bg/fg 同步给壳更新 overlay。
 */

import Link from "next/link";
import { Settings } from "lucide-react";
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

// "rgb(r, g, b)" / "rgba(...)" → "#rrggbb"
const rgbToHex = (rgb: string): string => {
  const m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return "#000000";
  return (
    "#" +
    m
      .slice(0, 3)
      .map((v) => Number(v).toString(16).padStart(2, "0"))
      .join("")
  );
};

export const AppHeader = () => {
  // 当前生效主题（深 / 浅）——变化时同步 Windows overlay 底色
  const { resolvedTheme } = useTheme();
  // 平台（"darwin" | "win32" | "linux" | ""）——决定左让交通灯 / 右让控制按钮
  const [platform, setPlatform] = useState("");
  // 页面是否已向下滚动——滚了才给顶栏加分隔线
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    setPlatform(window.__shell?.platform ?? "");
  }, []);

  // 监听窗口滚动：>0 显示分隔线、回顶隐藏（首页 / 设置等长内容靠 body 滚；
  // 任务详情是定高内栏滚动、window.scrollY 恒 0、自然不显分隔线、它本就有自己的 Separator）
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Windows 自定义标题栏：右上角窗口控制按钮条底色 / 图标色跟随应用主题（mac 走 hiddenInset、跳过）
  useEffect(() => {
    const shell = window.__shell;
    if (!shell || shell.platform === "darwin") return;
    // 等主题 class 切到 <html> 后再读 computed 色、避免读到旧主题
    const id = requestAnimationFrame(() => {
      const cs = getComputedStyle(document.body);
      shell.setTitleBarOverlay({
        color: rgbToHex(cs.backgroundColor),
        symbolColor: rgbToHex(cs.color),
      });
    });
    return () => cancelAnimationFrame(id);
  }, [resolvedTheme]);

  const isWin = platform === "win32";

  return (
    <header
      className={cn(
        "sticky top-0 z-40 flex h-14 items-center border-b border-transparent bg-background transition-colors [-webkit-app-region:drag]",
        scrolled && "border-border/70",
      )}
    >
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
      {/* 右侧功能键（win 让出右上角窗口控制按钮位）；主题 / 设置统一纯图标 ghost、规格对齐 */}
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
