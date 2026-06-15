"use client";

/**
 * 应用外壳（V0.8 侧栏导航）
 *
 * 结构：顶栏（全宽、含 mac 交通灯拖拽区 + 居中品牌 + 侧栏 toggle）
 *      └ 下方横向：侧栏（可展开 / 收起）| 主内容区（滚动）
 *
 * 职责：
 *  - 持侧栏展开 / 收起态、localStorage 记忆、Cmd/Ctrl+B 快捷切换
 *  - 主区滚动 → scrolled 状态传给顶栏（保留原「滚动才显分隔线」体验）
 *  - 路由切换时主区归顶 + 重置 scrolled
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";

const STORAGE_KEY = "fe-ai-flow:sidebar-open";

export const AppShell = ({ children }: { children: React.ReactNode }) => {
  // 侧栏展开 / 收起（默认展开；mount 后读 localStorage 覆盖、避免 SSR hydration mismatch）
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // 主区是否已向下滚动——传给顶栏控制分隔线
  const [scrolled, setScrolled] = useState(false);
  // 主滚动容器 ref（onScroll 算 scrolled、路由切换归顶）
  const mainRef = useRef<HTMLElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved !== null) setSidebarOpen(saved === "1");
    } catch {
      /* localStorage 不可用、用默认展开 */
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* 忽略写入失败 */
      }
      return next;
    });
  }, []);

  // Cmd/Ctrl+B 切侧栏（对标 VSCode / Cursor）；焦点在输入框时让行、不抢打字
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "b" || !(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

  // 路由切换：主区归顶 + 重置 scrolled（详情页 h-full 不滚、避免残留上一页的分隔线）
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
    setScrolled(false);
  }, [pathname]);

  const handleMainScroll = () => {
    const el = mainRef.current;
    if (el) setScrolled(el.scrollTop > 0);
  };

  return (
    <div className="flex h-screen flex-col">
      <AppHeader
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        scrolled={scrolled}
      />
      <div className="flex min-h-0 flex-1">
        <AppSidebar open={sidebarOpen} />
        <main
          ref={mainRef}
          onScroll={handleMainScroll}
          className="min-w-0 flex-1 overflow-y-auto"
        >
          {children}
        </main>
      </div>
    </div>
  );
};
