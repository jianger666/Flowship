"use client";

import type { ReactNode } from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { BrowserPanel } from "./browser-panel";
import { CHAT_BROWSER_MAX_PERCENT, CHAT_BROWSER_MIN_PX, CHAT_MAIN_MIN_PX } from "./browser-layout-memory";
import type { ChatBrowserPane } from "./use-chat-browser-pane";

interface ChatBrowserSplitProps {
  taskId: string;
  pane: ChatBrowserPane;
  /** 左侧对话主体（事件流 + 输入框） */
  children: ReactNode;
}

/**
 * chat 页主体的左右分栏：左对话、右浏览器。
 *
 * 分栏组始终挂着、右栏默认折叠成 0 宽：这样对话主体（EventStream）的 React 位置不随浏览器开合变化，
 * 不会因为「条件包一层 Group」而整棵卸载重挂（会丢滚动位置 / 输入草稿）。收起时分隔条隐藏、
 * 右栏 inert，视觉与行为都与改动前一致。
 * 右栏的 BrowserPanel 只在打开时才渲染——没开过浏览器的用户零开销。
 */
export const ChatBrowserSplit = ({ taskId, pane, children }: ChatBrowserSplitProps) => {
  const { open, initial } = pane;
  return (
    <div className="min-h-0 flex-1" {...pane.wrapperProps}>
      <ResizablePanelGroup
        key={taskId}
        id={`chat-layout-${taskId}`}
        orientation="horizontal"
        onLayoutChanged={pane.onLayoutChanged}
      >
        <ResizablePanel
          id="chat-main"
          defaultSize={`${initial.open ? 100 - initial.percent : 100}%`}
          // 像素下限：对话栏再窄输入框 / 答题卡就失效
          minSize={`${CHAT_MAIN_MIN_PX}px`}
        >
          {children}
        </ResizablePanel>
        <ResizableHandle
          withHandle
          // 收起时整条隐藏（含禁用）：否则对话区右缘会多出一根可拖的竖条
          disabled={!open}
          className={cn(!open && "hidden")}
        />
        <ResizablePanel
          id="chat-browser"
          panelRef={pane.panelRef}
          defaultSize={`${initial.open ? initial.percent : 0}%`}
          minSize={`${CHAT_BROWSER_MIN_PX}px`}
          maxSize={`${CHAT_BROWSER_MAX_PERCENT}%`}
          // 拖到最小宽度以下自动收起；收起 = 0 宽
          collapsible
          collapsedSize={0}
          onResize={pane.onResize}
        >
          {/* 收起时子树 inert：退出 Tab 序与读屏（与 task 页产物栏同做法） */}
          <div className="h-full" inert={!open}>
            {open && <BrowserPanel taskId={taskId} className="border-l" />}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
};
