"use client";

/**
 * 首页 task 卡片
 * - 标题 + 仓库路径 + 当前阶段 + 状态徽章 + 时间
 * - 整张卡可点、跳详情页（用 div + onClick 包裹、避免 Link 套 Button 的 hydration 警告）
 * - 完成/失败的卡片右上显示「归档」按钮、归档视图里显示「取消归档」按钮
 * - 永远显示「删除」按钮（带 shadcn AlertDialog 二次确认）、避免操作不可逆
 */

import { useState } from "react";
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

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  PHASE_LABEL,
  STATUS_LABEL,
  STATUS_VARIANT,
  formatRelative,
} from "@/lib/task-display";
import type { Task } from "@/lib/types";

interface Props {
  task: Task;
  onArchiveToggle?: () => void;
  onDelete?: () => void;
}

// 哪些状态值得显示「归档」按钮（draft / running / awaiting_user 显示意义不大）
const canArchive = (task: Task): boolean =>
  task.archived ||
  task.status === "completed" ||
  task.status === "failed";

export const TaskCard = ({ task, onArchiveToggle, onDelete }: Props) => {
  const router = useRouter();
  // 删除确认 dialog 的开关：点删除按钮打开、确定 / 取消都关
  const [deleteOpen, setDeleteOpen] = useState(false);

  // 卡片点击跳详情；归档 / 删除按钮的点击 stopPropagation 避免冒泡
  const handleCardClick = () => {
    router.push(`/tasks/${task.id}`);
  };

  const handleArchiveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onArchiveToggle?.();
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteOpen(true);
  };

  const handleDeleteConfirm = () => {
    setDeleteOpen(false);
    onDelete?.();
  };

  return (
    <>
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

      {/* 删除二次确认：用 shadcn AlertDialog 替代浏览器原生 confirm */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除任务</AlertDialogTitle>
            <AlertDialogDescription>
              「{task.title}」将被永久删除、连同 data/tasks/{task.id}/ 整个目录（产物 / 事件流 / 元信息）、操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDeleteConfirm}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
