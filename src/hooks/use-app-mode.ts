"use client";

/**
 * 应用双模式推导（v1.0 胶囊双模式、用户拍板「工作台 / 对话分开显示 + 快速切换」）
 *
 * 模式不是全局 state、由 **URL 单一事实源**推导（刷新 / 直开链接不漂移）：
 * - work（工作台）：`/`（飞书看板）、`/workitems/*`（需求预览）、`/tasks/:id`（task 模式任务）
 * - chat（对话）：`/chats`（对话落点）、`/tasks/:id`（chat 模式任务）
 * - 中性页（/settings、/actions 等）：维持上一个模式（localStorage 记忆、防胶囊乱跳）
 *
 * `/tasks/:id` 的归属看 task.mode——从全局任务列表（useTaskList、侧栏本来就订着）查；
 * 列表还没加载完时先用记忆模式兜底、加载后自动校正。
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, usePathname } from "next/navigation";

import { useTaskList } from "@/hooks/use-task-list";

export type AppMode = "work" | "chat";

const MODE_STORAGE_KEY = "flowship:app-mode";

export const useAppMode = (): AppMode => {
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const { tasks, loaded } = useTaskList();
  // 记忆模式（中性页 / 任务列表未加载时的兜底）。仓库既定 hydration 模式：
  // useState 默认值 + mount 后 effect 读 localStorage 覆盖——SSR 与 client 首帧
  // 都渲 "work"、不在渲染期读 localStorage（防 hydration mismatch、审计 P2）
  const [remembered, setRemembered] = useState<AppMode>("work");
  useEffect(() => {
    try {
      if (localStorage.getItem(MODE_STORAGE_KEY) === "chat") {
        setRemembered("chat");
      }
    } catch {
      /* localStorage 不可用、用默认 work */
    }
  }, []);

  const mode = useMemo<AppMode>(() => {
    if (!pathname) return "work";
    if (pathname === "/" || pathname.startsWith("/workitems")) return "work";
    if (pathname.startsWith("/chats")) return "chat";
    if (pathname.startsWith("/tasks/") && params?.id) {
      const t = tasks.find((x) => x.id === params.id);
      if (t) return t.mode === "chat" ? "chat" : "work";
      // 列表没回来 / 任务不在列表（刚删）→ 记忆模式兜底
      return remembered;
    }
    // 中性页（设置 / 自定义 Action 等）：维持上次模式
    return remembered;
  }, [pathname, params?.id, tasks, remembered]);

  // 确定态（非兜底推导出的）落记忆——loaded 后 tasks 查得到、或非任务页的明确路由。
  // 同步 setRemembered：下一个中性页 / 兜底场景直接用最新值、不再等 localStorage 读
  useEffect(() => {
    const definite =
      pathname === "/" ||
      pathname?.startsWith("/workitems") ||
      pathname?.startsWith("/chats") ||
      (pathname?.startsWith("/tasks/") && loaded);
    if (!definite) return;
    setRemembered(mode);
    try {
      localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      /* 忽略写入失败 */
    }
  }, [mode, pathname, loaded]);

  return mode;
};
