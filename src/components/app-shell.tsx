"use client";

/**
 * 应用外壳（V0.8 侧栏导航、v1.0 按页型自适应）
 *
 * 结构：顶栏（全宽、含 mac 交通灯拖拽区 + 模式胶囊 + 侧栏 toggle）
 *      └ 下方横向：侧栏（可展开 / 收起）| 主内容区（滚动）
 *
 * v1.0 侧栏自适应（用户拍板「看板=导航中心、侧栏=快切」）：
 *  - 看板页（/）自动收侧栏——全屏甘特、看板本身就是导航、侧栏不抢戏
 *  - 详情页（任务 / 对话 / 设置等）自动展侧栏——多任务快切是刚需
 *  - **手动 toggle 最高优先级**：在某页型手动开 / 关后、留在同页型内不再被自动改；
 *    切到另一页型时恢复该页型的自动默认（用 ref 记「上次自动应用的页型」判断切换沿）
 *
 * 职责：
 *  - 持侧栏展开 / 收起态、Cmd/Ctrl+B 快捷切换
 *  - 主区滚动 → scrolled 状态传给顶栏（保留原「滚动才显分隔线」体验）
 *  - 路由切换时主区归顶 + 重置 scrolled
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { isModCombo } from "@/lib/keyboard-shortcuts";
import { createModHotkeyHandler, isSidebarToggleCombo } from "@/components/hotkey-handler";
import {
  dispatchArtifactSearchFocus,
  dispatchEventStreamSearchFocus,
  getActivePaneSearchScope,
  isArtifactPaneCollapsed,
  resolvePaneSearchScope,
  setActivePaneSearchScope,
  type PaneSearchScope,
} from "@/lib/pane-search";

// 页型：board（看板首页、默认展——2026-07-13 用户拍板「和对话保持一致、别切来切去
// 一收一放」）/ standalone（设置 / 能力 / 会话管理页、默认收——这类页有自己的内部导航、任务侧栏
// 叠上去是双侧栏、用户点名「设置页左边还有侧边栏」）/ detail（其余、默认展）
const routeType = (pathname: string): "board" | "standalone" | "detail" => {
  if (pathname === "/") return "board";
  if (
    pathname.startsWith("/settings") ||
    pathname.startsWith("/actions") ||
    pathname.startsWith("/sessions") ||
    pathname.startsWith("/schedules")
  ) {
    return "standalone";
  }
  return "detail";
};

export const AppShell = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname();
  // 侧栏展开 / 收起：初值按当前页型的自动默认（仅 standalone 收、其余展）
  const [sidebarOpen, setSidebarOpen] = useState(
    () => routeType(pathname) !== "standalone",
  );
  // 主区是否已向下滚动——传给顶栏控制分隔线
  const [scrolled, setScrolled] = useState(false);
  // 主滚动容器 ref（onScroll 算 scrolled、路由切换归顶）
  const mainRef = useRef<HTMLElement>(null);
  // 上次「自动应用默认」的页型——只在页型切换沿重置侧栏、同页型内保留用户手动结果
  const lastAutoTypeRef = useRef<"board" | "standalone" | "detail">(
    routeType(pathname),
  );

  // 页型切换沿：应用该页型的自动默认（仅 standalone 收、其余展）；
  // 同页型内不动（保留手动 toggle）
  useEffect(() => {
    const type = routeType(pathname);
    if (type === lastAutoTypeRef.current) return;
    lastAutoTypeRef.current = type;
    setSidebarOpen(type !== "standalone");
  }, [pathname]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => !v);
  }, []);

  // Cmd/Ctrl+B 切侧栏（对标 VSCode / Cursor）。
  // 不看焦点：本仓没有富文本编辑器——主输入条是 Lexical PlainTextPlugin 的 ContentEditable、其余是 input / textarea，
  // ⌘B 在它们里面都没有「加粗」之类的编辑语义。原先对 contentEditable 让行，会让主输入条里这个快捷键整个失效
  // （评审：打字时想收侧栏得先点出去）。长按 repeat 帧只吞默认行为、不重复切（见 hotkey-handler）。
  useEffect(() => {
    const onKeyDown = createModHotkeyHandler(isSidebarToggleCombo, toggleSidebar);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

  // Cmd/Ctrl+F：按作用域打开产物栏或事件流内联搜索（覆盖浏览器默认查找）
  useEffect(() => {
    const syncScopeFromTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return;
      const pane = el.closest("[data-pane-search]");
      if (!(pane instanceof HTMLElement)) return;
      const scope = pane.dataset.paneSearch as PaneSearchScope | undefined;
      if (scope === "event-stream" || scope === "artifact") {
        setActivePaneSearchScope(scope);
      }
    };

    const onPointerDown = (e: PointerEvent) => syncScopeFromTarget(e.target);
    const onFocusIn = (e: FocusEvent) => syncScopeFromTarget(e.target);

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isModCombo(e, "f")) return;
      // 已被更近的处理者接管（浏览器面板的查找条、预览里的查找框等 preventDefault 过）就别再弹对话流 / 产物搜索条，
      // 否则任务页上 Cmd/Ctrl+F 会双触发、抢走焦点（R1-15）
      if (e.defaultPrevented) return;
      const scope = resolvePaneSearchScope(
        getActivePaneSearchScope(),
        pathname,
        isArtifactPaneCollapsed(),
      );
      if (!scope) return;
      e.preventDefault();
      if (scope === "artifact") {
        dispatchArtifactSearchFocus();
      } else {
        dispatchEventStreamSearchFocus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pathname]);

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
          // 滚动条槽位预留（防切页/切 tab 抖动）由 globals.css 对 .overflow-y-auto 全局治理
          className="min-w-0 flex-1 overflow-y-auto"
        >
          {children}
        </main>
      </div>
    </div>
  );
};
