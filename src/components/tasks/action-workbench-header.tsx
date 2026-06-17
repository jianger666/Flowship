"use client";

/**
 * 左侧工作区 header（V0.7 task 详情大改）
 *
 * 把「我在看哪个 action / 这步什么状态 / 这份产物是什么文件」从 page 顶部归位到
 * artifact 工作区顶部——因为它控制的就是左侧正在看的产物。
 *
 * 职责边界（跟 ArtifactPanel 切开）：
 *   - Header = 「选哪个 + 是什么 + 什么状态」
 *       · timeline 纯导航（选 action → 切 artifact）
 *       · selected 身份由 timeline 高亮 chip 表达
 *       · 这一步 status 由 badge 表达（单一源 ACTION_STATUS_*、不自写状态色）
 *       · filename 由 ArtifactPanel 上报、在这里显示（口径：filename 归 Header）
 *   - ArtifactPanel = 「内容长啥 + 怎么看这份内容」（正文 / Diff / revision，仍在 Panel 内）
 *
 * 数据流：actions 全量只到这里（timeline 要它）；ArtifactPanel 只拿 selectedAction。
 */

import { FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ActionTimeline } from "@/components/tasks/action-timeline";
import {
  ACTION_STATUS_LABEL,
  ACTION_STATUS_VARIANT,
} from "@/lib/task-display";
import type { ActionRecord } from "@/lib/types";

interface Props {
  actions: ActionRecord[];
  /** 当前正在看的 action（null = 没选 / 空 task）；只用来显示这一步的 status */
  selectedAction: ActionRecord | null;
  selectedActionId: string | null;
  onSelectAction: (actionId: string) => void;
  onToggleExclude?: (action: ActionRecord) => void;
  /** 当前 artifact 文件名（ArtifactPanel 上报、page 透传）；null = 无产物 / 加载中 */
  artifactFilename?: string | null;
}

export const ActionWorkbenchHeader = ({
  actions,
  selectedAction,
  selectedActionId,
  onSelectAction,
  onToggleExclude,
  artifactFilename,
}: Props) => {
  return (
    <div className="shrink-0 border-b px-4 py-2">
      {/* 窄屏时右侧 status+filename 会换到第二行、整体最多两行、不堆成厚 chrome */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <ActionTimeline
            actions={actions}
            selectedActionId={selectedActionId}
            onSelectAction={onSelectAction}
            onToggleExclude={onToggleExclude}
          />
        </div>
        {selectedAction && (
          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <Badge
              variant={ACTION_STATUS_VARIANT[selectedAction.status]}
              className="h-5 shrink-0 px-1.5 text-xs font-normal"
            >
              {ACTION_STATUS_LABEL[selectedAction.status]}
            </Badge>
            {artifactFilename && (
              <span className="flex items-center gap-1">
                <FileText className="size-3.5 shrink-0" />
                <span className="max-w-[220px] truncate" title={artifactFilename}>
                  {artifactFilename}
                </span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
