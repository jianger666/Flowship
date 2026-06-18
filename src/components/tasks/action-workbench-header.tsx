"use client";

/**
 * 左侧工作区 header（V0.7 task 详情大改）
 *
 * 把「我在看哪个 action / 这份产物是什么文件」从 page 顶部归位到
 * artifact 工作区顶部——因为它控制的就是左侧正在看的产物。
 *
 * 职责边界（跟 ArtifactPanel 切开）：
 *   - Header = 「选哪个 + 是什么文件」
 *       · timeline 纯导航（选 action → 切 artifact）
 *       · selected 身份由 timeline 高亮 chip 表达
 *       · filename 由 ArtifactPanel 上报、在这里显示（口径：filename 归 Header）
 *       · action 单步状态（运行中 / 失败…）不展示——用户拍板：历史态意义不大、徒增噪音
 *   - ArtifactPanel = 「内容长啥 + 怎么看这份内容」（正文 / Diff / revision，仍在 Panel 内）
 *
 * 数据流：actions 全量只到这里（timeline 要它）；ArtifactPanel 只拿 selectedAction。
 */

import { FileText } from "lucide-react";

import { ActionTimeline } from "@/components/tasks/action-timeline";
import type { ActionRecord } from "@/lib/types";

interface Props {
  actions: ActionRecord[];
  /** 当前正在看的 action（null = 没选 / 空 task）；现仅用于「有选中才显示文件名」的门控 */
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
      {/* timeline 独占整行、拿满宽度——不再跟文件名抢同一行的宽度。
          之前 filename 在右侧同行：选不同 action 文件名变长 / 点击瞬间产物加载时文件名先消失，
          都会改变 timeline 可用宽度 → 换行重排 → 抖动。拆成上下两行根治。 */}
      <ActionTimeline
        actions={actions}
        selectedActionId={selectedActionId}
        onSelectAction={onSelectAction}
        onToggleExclude={onToggleExclude}
      />
      {/* 文件名单独一行 + 固定行高占位：加载中（artifactFilename 暂空）也不塌行、
          避免每次点击 load 时该行有无导致下方正文上下跳。action 单步状态用户拍板已移除。 */}
      {selectedAction && (
        <div className="mt-1 flex h-4 items-center gap-1 text-xs text-muted-foreground">
          {artifactFilename && (
            <>
              <FileText className="size-3.5 shrink-0" />
              <span className="max-w-[60%] truncate" title={artifactFilename}>
                {artifactFilename}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
};
