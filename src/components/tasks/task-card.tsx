"use client";

/**
 * 首页 task 卡片
 * - 标题 + 仓库路径 + 当前阶段 + 状态徽章 + 时间
 * - 整张卡可点、跳详情页（用 div + onClick 包裹、避免 Link 套 Button 的 hydration 警告）
 * - 完成/失败的卡片右上显示「归档」按钮、归档视图里显示「取消归档」按钮
 * - 永远显示「删除」按钮、点击走全局 useDialog().confirm 二次确认（统一弹窗风格）
 */

import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  FolderGit2,
  MessageCircle,
  Trash2,
  Workflow,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useDialog } from "@/hooks/use-dialog";
import {
  PHASE_LABEL,
  STATUS_LABEL,
  STATUS_VARIANT,
  formatRelative,
} from "@/lib/task-display";
import type { TaskSummary } from "@/lib/types";

interface Props {
  // V0.5.3：卡片只渲染概要字段（title / status / currentPhase / updatedAt 等）、
  // 不需要 events / phases.artifact 详细产物、类型上明确收窄到 TaskSummary
  task: TaskSummary;
  onArchiveToggle?: () => void;
  onDelete?: () => void;
}

// 哪些状态值得显示「归档」按钮（draft / running / awaiting_user 显示意义不大）
const canArchive = (task: TaskSummary): boolean =>
  task.archived ||
  task.status === "completed" ||
  task.status === "failed";

export const TaskCard = ({ task, onArchiveToggle, onDelete }: Props) => {
  const router = useRouter();
  // 全局 confirm hook：替代以前手写的 AlertDialog 三件套（state + handlers + JSX）
  // 跟其他「删除 / 覆盖」类操作走同款 modal、风格一致 + 零 state
  const { confirm } = useDialog();

  // 卡片点击跳详情；归档 / 删除按钮的点击 stopPropagation 避免冒泡
  const handleCardClick = () => {
    router.push(`/tasks/${task.id}`);
  };

  const handleArchiveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onArchiveToggle?.();
  };

  // 删除：弹 destructive 确认、用户点确认才调 onDelete
  // useDialog 内部封了 Promise、await 串行最自然
  const handleDeleteClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await confirm({
      title: "确认删除任务",
      description: `「${task.title}」将被永久删除、连同 data/tasks/${task.id}/ 整个目录（产物 / 事件流 / 元信息）、操作不可恢复。`,
      destructive: true,
      confirmLabel: "确认删除",
    });
    if (ok) onDelete?.();
  };

  return (
    <Card
      className="group cursor-pointer transition-colors hover:bg-muted/30"
      onClick={handleCardClick}
    >
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {/* mode badge：chat / plan 一眼可分 */}
            <Badge variant="outline" className="shrink-0 gap-1">
              {task.mode === "chat" ? (
                <>
                  <MessageCircle className="size-3" />
                  自由对话
                </>
              ) : (
                <>
                  <Workflow className="size-3" />
                  方案规划
                </>
              )}
            </Badge>
            <h3 className="truncate text-base font-medium text-foreground">
              {task.title}
            </h3>
            <Badge variant={STATUS_VARIANT[task.status]} className="shrink-0">
              {STATUS_LABEL[task.status]}
            </Badge>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <FolderGit2 className="size-3.5" />
              {task.repoPath || "(未配置仓库)"}
            </span>
            {/* chat 模式没有 phase 概念、不展示「当前阶段」 */}
            {task.mode === "plan" && (
              <span>当前阶段：{PHASE_LABEL[task.currentPhase]}</span>
            )}
            <span>{formatRelative(task.updatedAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onArchiveToggle && canArchive(task) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleArchiveClick}
              title={task.archived ? "取消归档" : "归档"}
            >
              {task.archived ? <ArchiveRestore /> : <Archive />}
              {task.archived ? "取消归档" : "归档"}
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDeleteClick}
              title="删除任务（不可恢复）"
              className="text-destructive hover:text-destructive"
            >
              <Trash2 />
              删除
            </Button>
          )}
          <ArrowRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </div>
    </Card>
  );
};
