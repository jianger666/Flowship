"use client";

/**
 * chat 页右侧浏览器栏的状态与行为（开合 / 宽度持久化 / 自动展开 / 「在内置浏览器打开」入口）。
 *
 * 为什么收成一个 hook：ChatView 已经 1100+ 行，开合状态要同时给头部按钮（BrowserToggleButton）和
 * 分栏（ChatBrowserSplit）用，收在这里 ChatView 只需「调一次 hook + 渲染两个组件」，diff 最小。
 *
 * 开合状态的真相源是 Panel 的折叠态（拖到最小宽度以下会自动折叠）：onResize 回写 open，
 * 按钮 / 自动展开 / 预览入口则命令式驱动 Panel（collapse / resize），两边最终都落在同一个 open 上。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";

import {
  createUserResizeIntent,
  isSeparatorTarget,
  shouldRecordResizePointerDown,
} from "@/lib/user-resize-intent";
import { createUserCloseIntent } from "./browser-auto-open";
import { registerBrowserPanelOpener } from "./browser-panel-bridge";
import {
  readChatBrowserOpen,
  readChatBrowserPercent,
  writeChatBrowserOpen,
  writeChatBrowserPercent,
} from "./browser-layout-memory";
import { useBrowserAutoOpen } from "./use-browser-auto-open";

/** 折叠判定：Panel 上报的百分比小于它就当作已折叠（与 task 页 isArtifactCollapsedSize 同口径） */
const COLLAPSED_EPSILON = 0.5;

export const useChatBrowserPane = (taskId: string, enabled = true) => {
  const panelRef = usePanelRef();

  // open 跟着任务走：同一个 ChatView 实例会在不同对话间复用（page 不 key 它），
  // 切任务时用「渲染期按 taskId 重置」，比 effect 少一帧错误状态
  const [state, setState] = useState(() => ({ taskId, open: readChatBrowserOpen(taskId) }));
  let open = state.open;
  if (state.taskId !== taskId) {
    open = readChatBrowserOpen(taskId);
    setState({ taskId, open });
  }
  const openRef = useRef(open);
  openRef.current = open;

  // 分栏组按任务重挂（key=taskId），初始宽度只在挂载时取一次：之后的开合靠命令式 resize，
  // 不能让 defaultSize 随 open 变（库只在注册时读它）
  const initial = useMemo(
    () => ({ open: readChatBrowserOpen(taskId), percent: readChatBrowserPercent() }),
    [taskId],
  );

  const setOpen = useCallback(
    (next: boolean) => {
      if (openRef.current === next) return;
      writeChatBrowserOpen(taskId, next);
      openRef.current = next;
      setState({ taskId, open: next });
      const panel = panelRef.current;
      if (!panel) return;
      try {
        // 展开用 resize(记住的宽度)而不是 expand()：从没展开过的 Panel 没有「上一次宽度」
        if (next) panel.resize(`${readChatBrowserPercent()}%`);
        else panel.collapse();
      } catch {
        // Group 还没挂好 / 约束冲突：状态已更新，Panel 在下一次布局时会按 defaultSize 兜底
      }
    },
    [taskId, panelRef],
  );
  // 「用户主动收起」的意图（R2-14 ③）：头部按钮收起时先 mark；拖分隔条的意图用下面的 intentRef。
  // 窗口缩小到放不下时库自动折叠浏览器栏（onResize 回写 open=false）两者都不是，自动展开 hook 据此不记「已收起」
  const userCloseIntentRef = useRef(createUserCloseIntent());
  const show = useCallback(() => setOpen(true), [setOpen]);
  const toggle = useCallback(() => {
    if (openRef.current) userCloseIntentRef.current.mark(Date.now());
    setOpen(!openRef.current);
  }, [setOpen]);

  // Panel 尺寸变化（含拖到最小宽度以下自动折叠）→ 回写 open
  const onResize = useCallback(
    (size: { asPercentage: number }) => {
      const nextOpen = size.asPercentage > COLLAPSED_EPSILON;
      if (nextOpen === openRef.current) return;
      writeChatBrowserOpen(taskId, nextOpen);
      openRef.current = nextOpen;
      setState({ taskId, open: nextOpen });
    },
    [taskId],
  );

  // 只有用户真的在分隔条上拖 / 按键后的 onLayoutChanged 才写宽度：挂载 / 窗口缩放重算也会触发它，
  // 不拦的话窄窗口里会把用户拖出来的宽度改写成「校准后的值」（同 task 页 R9a-03）
  const intentRef = useRef(createUserResizeIntent());
  useEffect(() => {
    const end = () => intentRef.current.pointerUp(Date.now());
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, []);
  const wrapperProps = useMemo(
    () => ({
      onPointerDownCapture: (e: React.PointerEvent) => {
        if (shouldRecordResizePointerDown(e)) intentRef.current.pointerDown();
      },
      onKeyDownCapture: (e: React.KeyboardEvent) => {
        if (isSeparatorTarget(e.target)) intentRef.current.key(Date.now());
      },
    }),
    [],
  );
  const onLayoutChanged = useCallback((layout: Record<string, number>) => {
    const browser = layout["chat-browser"];
    // writeChatBrowserPercent 只收有效值：折叠时的 0 不会覆盖用户上次拖出来的宽度
    if (typeof browser === "number" && intentRef.current.isActive(Date.now())) {
      writeChatBrowserPercent(browser);
    }
  }, []);

  // 预览入口「在内置浏览器打开」/ 自动展开
  useEffect(() => {
    if (!enabled) return;
    return registerBrowserPanelOpener(taskId, show);
  }, [taskId, enabled, show]);
  const isUserClosePane = useCallback(() => {
    const now = Date.now();
    return userCloseIntentRef.current.isRecent(now) || intentRef.current.isActive(now);
  }, []);
  useBrowserAutoOpen({ taskId, enabled, panelOpen: open, onOpen: show, isUserClose: isUserClosePane });

  return {
    open,
    toggle,
    panelRef,
    initial,
    wrapperProps,
    onResize,
    onLayoutChanged,
  };
};

export type ChatBrowserPane = ReturnType<typeof useChatBrowserPane>;
