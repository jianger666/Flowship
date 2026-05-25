"use client";

/**
 * Resizable 布局组件（V0.5.10 加、shadcn-style stub）
 *
 * 基于 react-resizable-panels 4.x 封装。
 *
 * ⚠️ **4.x API 跟 shadcn 文档（基于 2.x）已经不一样**：
 *   - 旧（2.x/3.x）：`PanelGroup` / `Panel` / `PanelResizeHandle`、`onLayout(sizes: number[])`
 *   - 新（4.x）：`Group` / `Panel` / `Separator`、`onLayoutChanged(layout: Record<panelId, flexGrow>)`
 *
 * 本文件按 4.x API 直接 re-export：
 * - `ResizablePanelGroup`（直 re-export `Group`、Group 自带 inline style display/flex/width/height、不要再用 className 覆盖）
 * - `ResizablePanel`（直 re-export `Panel`、id / defaultSize / minSize / maxSize）
 * - `ResizableHandle`（包 `Separator`、`withHandle` 显示中间 grip 图标）
 *
 * 持久化用法（V0.5.10 task.uiLayout）：
 * - Group 上接 `onLayoutChanged`、释放鼠标后才触发（区别于 onLayoutChange 在拖动中高频触发）
 * - 用 `Layout[panelId]` 拿对应 panel 的 flexGrow 数值（百分比 × 100）
 * - 调用方拿到 layout 后 debounce 500ms 写 PATCH /api/tasks/[id] { uiLayout }
 *
 * V0.5.10 hot-fix：
 * - 4.x Separator DOM 上只有 `data-separator`（active/focus/inactive/disabled）+ `aria-orientation`、**没有** `data-orientation`
 * - 之前用的 `data-[orientation=vertical]:...` selector 全部失效、所以纯 vertical group 视觉错乱（项目当前只用 horizontal、暂不修 vertical）
 * - 之前 separator 视觉宽 1px、用户根本看不到「这里能拖」、改成 1.5px 实体 + 8px hit-region + 中间 grip 4×8 醒目
 * - 用 lib 自带 `data-separator=active/focus` 走拖动 / 聚焦态颜色、不要自己写 group/handle
 */

import { GripVertical } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { cn } from "@/lib/utils";

const ResizablePanelGroup = Group;

const ResizablePanel = Panel;

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean;
}) => (
  <Separator
    className={cn(
      // 视觉条：1.5px 实体宽（横向 group）/ 1.5px 实体高（纵向 group）
      // hit region：::after 扩展到 8px 总命中宽、用户哪怕鼠标偏一点也能抓住
      // aria-orientation 跟 Group orientation **相反**：horizontal group → separator aria-orientation=vertical
      "relative flex items-center justify-center bg-border transition-colors",
      // 横向 group（separator aria-orientation=vertical）：1.5px 宽、自身高度占满
      "aria-[orientation=vertical]:w-1.5 aria-[orientation=vertical]:cursor-col-resize",
      "aria-[orientation=vertical]:after:absolute aria-[orientation=vertical]:after:inset-y-0 aria-[orientation=vertical]:after:left-1/2 aria-[orientation=vertical]:after:w-2 aria-[orientation=vertical]:after:-translate-x-1/2",
      // 纵向 group（separator aria-orientation=horizontal）：1.5px 高
      "aria-[orientation=horizontal]:h-1.5 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize",
      "aria-[orientation=horizontal]:after:absolute aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:-translate-y-1/2",
      // hover / active / focus 用 lib 自带 data-separator state（active=拖动中、focus=键盘聚焦）
      "hover:bg-primary/40",
      "data-[separator=active]:bg-primary",
      "data-[separator=focus]:ring-1 data-[separator=focus]:ring-ring data-[separator=focus]:ring-offset-1 data-[separator=focus]:outline-none",
      // 纵向 group 时 grip 图标转 90°（separator aria-orientation=horizontal）
      "[&[aria-orientation=horizontal]>div]:rotate-90",
      className,
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-8 w-4 items-center justify-center rounded-sm border bg-border transition-colors hover:bg-primary/20">
        <GripVertical className="h-3.5 w-3.5" />
      </div>
    )}
  </Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
