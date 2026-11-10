"use client";

/**
 * chat 页右侧浏览器栏的状态与行为（开合 / 宽度持久化 / 自动展开 / 「在内置浏览器打开」入口）。
 *
 * 为什么收成一个 hook：ChatView 已经 1100+ 行，开合状态要同时给头部按钮（BrowserToggleButton）和
 * 分栏（ChatBrowserSplit）用，收在这里 ChatView 只需「调一次 hook + 渲染两个组件」，diff 最小。
 *
 * 开合状态的真相源是 Panel 的折叠态（拖到最小宽度以下会自动折叠）：onResize 回写 open，
 * 按钮 / 自动展开 / 预览入口则命令式驱动 Panel（collapse / resize），两边最终都落在同一个 open 上。
 *
 * 「盖住对话」：浏览器栏可以一路拖宽到 100%，把对话栏（collapsible）挤成 0。对话栏的折叠态同样由它自己的
 * onResize 回写（chatCovered）。放大 / 还原 / 盖住态下关闭走 applyChatSplitCommand——
 * **盖住态下命令必须发给对话栏**（库对「最后一个 Panel 缩小、前面全折叠」静默无效，细节见该函数注释，审核 R8-02）。
 * 盖住是一次性的「放大」状态：不写进宽度记忆（见 CHAT_BROWSER_REMEMBER_MAX_PERCENT），关掉浏览器再打开回到记住的宽度；
 * 挂载时若库因容器放不下 320px 对话栏而把它折叠了，挂载后修一次（repairChatSplitAfterMount，审核 R8-03）。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGroupRef, usePanelRef } from "react-resizable-panels";

import {
  createUserResizeIntent,
  isSeparatorTarget,
  shouldRecordResizePointerDown,
} from "@/lib/user-resize-intent";
import { createUserCloseIntent } from "./browser-auto-open";
import { registerBrowserPanelOpener } from "./browser-panel-bridge";
import {
  applyChatSplitCommand,
  isChatCoveredSize,
  readChatBrowserOpen,
  readChatBrowserPercent,
  repairChatSplitAfterMount,
  resolveChatBrowserOpenPercent,
  writeChatBrowserOpen,
  writeChatBrowserPercent,
} from "./browser-layout-memory";
import { useBrowserAutoOpen } from "./use-browser-auto-open";

/** 折叠判定：Panel 上报的百分比小于它就当作已折叠（与 task 页 isArtifactCollapsedSize 同口径） */
const COLLAPSED_EPSILON = 0.5;

export const useChatBrowserPane = (taskId: string, enabled = true) => {
  // 浏览器栏 / 对话栏 / 整个分栏组的命令式句柄：盖住态下的还原与关闭要对「对话栏」下命令（见 applyChatSplitCommand）
  const panelRef = usePanelRef();
  const mainPanelRef = usePanelRef();
  const groupRef = useGroupRef();
  const splitHandles = useCallback(
    () => ({ main: mainPanelRef.current, browser: panelRef.current, group: groupRef.current }),
    [mainPanelRef, panelRef, groupRef],
  );

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

  // 分栏组外层 div：打开浏览器时量它的像素宽度，免得记住的宽度在较窄的窗口里把对话栏挤到被库折叠
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // 对话栏是否被浏览器盖住（对话栏折叠成 0）。同样按任务隔离：key 对不上就当没盖住，不用 effect 重置
  const [coverState, setCoverState] = useState({ taskId, covered: false });
  const chatCovered = coverState.taskId === taskId && coverState.covered;
  const chatCoveredRef = useRef(chatCovered);
  chatCoveredRef.current = chatCovered;

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
      if (!next) {
        // 关闭走命令层：盖住态下（对话栏折叠）对浏览器栏 collapse() 是静默无效的，它会改为让对话栏占满
        applyChatSplitCommand({ kind: "close" }, splitHandles());
        return;
      }
      try {
        // 展开用 resize(记住的宽度)而不是 expand()：从没展开过的 Panel 没有「上一次宽度」
        const percent = resolveChatBrowserOpenPercent(
          readChatBrowserPercent(),
          wrapperRef.current?.clientWidth,
        );
        panel.resize(`${percent}%`);
      } catch {
        // Group 还没挂好 / 约束冲突：状态已更新，Panel 在下一次布局时会按 defaultSize 兜底
      }
    },
    [taskId, panelRef, splitHandles],
  );
  // 「用户主动收起」的意图（R2-14 ③）：头部按钮收起时先 mark；拖分隔条的意图用下面的 intentRef。
  // 窗口缩小到放不下时库自动折叠浏览器栏（onResize 回写 open=false）两者都不是，自动展开 hook 据此不记「已收起」
  const userCloseIntentRef = useRef(createUserCloseIntent());
  const show = useCallback(() => setOpen(true), [setOpen]);
  const toggle = useCallback(() => {
    if (openRef.current) userCloseIntentRef.current.mark(Date.now());
    setOpen(!openRef.current);
  }, [setOpen]);
  // 浏览器栏自己的 X：只关不开（头部「浏览器」入口是开关，面板里的 X 在关闭态根本不会渲染）；关闭意图与 toggle 同口径
  const close = useCallback(() => {
    if (!openRef.current) return;
    userCloseIntentRef.current.mark(Date.now());
    setOpen(false);
  }, [setOpen]);

  // 对话栏的折叠态（含拖分隔条把它挤没）→ 回写 chatCovered
  const onMainResize = useCallback(
    (size: { asPercentage: number }) => {
      const next = isChatCoveredSize(size.asPercentage);
      setCoverState((prev) =>
        prev.taskId === taskId && prev.covered === next ? prev : { taskId, covered: next },
      );
    },
    [taskId],
  );

  // 放大 / 还原：放大 = 浏览器栏 100%（库把对话栏折叠成 0）；还原 = 让**对话栏**展开到「100 − 记住的浏览器宽度」
  // （记住的宽度同样夹在对话栏下限内）。是否盖住以布局本身（对话栏折叠态）为准，React 里的 chatCovered 可能慢一拍
  const toggleCover = useCallback(() => {
    if (!openRef.current) return;
    const handles = splitHandles();
    let covered = chatCoveredRef.current;
    try {
      covered = handles.main?.isCollapsed() ?? covered;
    } catch {
      // Panel 还没注册完：用 React 里的盖住态
    }
    if (!covered) {
      applyChatSplitCommand({ kind: "cover" }, handles);
      return;
    }
    const browserPercent = resolveChatBrowserOpenPercent(
      readChatBrowserPercent(),
      wrapperRef.current?.clientWidth,
    );
    applyChatSplitCommand({ kind: "restore", browserPercent }, handles);
  }, [splitHandles]);

  // 只「还原」不「放大」：新的待回答提问出现、答题卡在被盖住的对话栏里时调（useRevealOnNewAsk，审核 R8-05 ①）。
  // 没盖住就什么都不做——不能像 toggleCover 那样反过来把对话盖上
  const revealChat = useCallback(() => {
    if (openRef.current && chatCoveredRef.current) toggleCover();
  }, [toggleCover]);

  // 挂载后修一次：记住的宽度 ≥85% 而容器放不下 320px 对话栏时，库在注册 defaultSize 时就把对话栏折叠了（= 一打开就盖住）。
  // 只在「挂载时就是开着」的情况；useLayoutEffect：在首帧绘制前改回来，不让用户看到一帧被盖住的页面
  useLayoutEffect(() => {
    if (!initial.open) return;
    repairChatSplitAfterMount(splitHandles(), initial.percent, wrapperRef.current?.clientWidth);
  }, [initial, splitHandles]);

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
      ref: wrapperRef,
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
    close,
    chatCovered,
    toggleCover,
    revealChat,
    onMainResize,
    panelRef,
    mainPanelRef,
    groupRef,
    initial,
    wrapperProps,
    onResize,
    onLayoutChanged,
  };
};

export type ChatBrowserPane = ReturnType<typeof useChatBrowserPane>;
