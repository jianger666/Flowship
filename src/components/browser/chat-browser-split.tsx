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
 *
 * 浏览器可以盖住对话：浏览器栏 maxSize=100%、对话栏 collapsible（被挤到下限一半以下折叠成 0）。
 * 对话内容永远按至少 CHAT_MAIN_MIN_PX 的宽度排版、被盖住时只是被外层裁掉——不重排：
 * 否则 0 宽下每个字一行，EventStream 的滚动位置 / 虚拟列表高度缓存全乱，还原后回不到原来的位置。
 */
export const ChatBrowserSplit = ({ taskId, pane, children }: ChatBrowserSplitProps) => {
  const { open, initial, chatCovered } = pane;
  return (
    <div className="min-h-0 flex-1" {...pane.wrapperProps}>
      <ResizablePanelGroup
        key={taskId}
        id={`chat-layout-${taskId}`}
        orientation="horizontal"
        groupRef={pane.groupRef}
        onLayoutChanged={pane.onLayoutChanged}
      >
        <ResizablePanel
          id="chat-main"
          panelRef={pane.mainPanelRef}
          defaultSize={`${initial.open ? 100 - initial.percent : 100}%`}
          // 像素下限：对话栏再窄输入框 / 答题卡就失效
          minSize={`${CHAT_MAIN_MIN_PX}px`}
          // 可折叠：浏览器拖得够宽时把对话栏整个盖住（折叠成 0）
          collapsible
          collapsedSize={0}
          onResize={pane.onMainResize}
          // Panel 内层默认 overflow:auto（内联样式，className 压不过）：被盖住（0 宽）时固定 min-width 的内容会冒出横向滚动条，
          // 盖住时改成直接裁掉；平时不动它，行为与改动前一致
          style={chatCovered ? { overflow: "hidden" } : undefined}
        >
          {/* 被盖住时子树 inert：对话看不见了，输入框也不该还在 Tab 序 / 读屏里 */}
          <div className="h-full" style={{ minWidth: CHAT_MAIN_MIN_PX }} inert={chatCovered}>
            {children}
          </div>
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
            {open && (
              <BrowserPanel
                taskId={taskId}
                className="border-l"
                onClose={pane.close}
                maximized={chatCovered}
                onToggleMaximize={pane.toggleCover}
                coverTarget="对话"
              />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
};
