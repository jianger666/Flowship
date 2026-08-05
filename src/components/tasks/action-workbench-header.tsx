"use client";

/**
 * 左侧工作区 header（V0.7 task 详情大改）
 *
 * 把「我在看哪个 action」从 page 顶部归位到 artifact 工作区顶部。
 *
 * 职责边界（跟 ArtifactPanel 切开）：
 *   - Header = 「选哪个」
 *       · timeline 纯导航（选 action → 切 artifact）
 *       · selected 身份由 timeline 高亮 chip 表达
 *       · action 单步状态（运行中 / 失败…）不展示——用户拍板：历史态意义不大、徒增噪音
 *   - ArtifactPanel = 「内容长啥 + 怎么看这份内容」（正文 / Diff / revision；
 *      文件名并入其 toolbar、不再独占一行）
 *
 * 数据流：actions 全量只到这里（timeline 要它）；ArtifactPanel 只拿 selectedAction。
 */

import { ActionTimeline } from "@/components/tasks/action-timeline";
import type { ActionRecord } from "@/lib/types";

interface Props {
  actions: ActionRecord[];
  selectedActionId: string | null;
  onSelectAction: (actionId: string) => void;
  onToggleExclude?: (action: ActionRecord) => void;
}

export const ActionWorkbenchHeader = ({
  actions,
  selectedActionId,
  onSelectAction,
  onToggleExclude,
}: Props) => {
  return (
    <div className="min-w-0 shrink-0 overflow-hidden border-b px-4 py-2">
      <ActionTimeline
        actions={actions}
        selectedActionId={selectedActionId}
        onSelectAction={onSelectAction}
        onToggleExclude={onToggleExclude}
      />
    </div>
  );
};
