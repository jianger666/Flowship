"use client";

/**
 * 首页 task 卡片（V0.6 重写）
 *
 * 展示：
 *   - 标题 + 仓库路径 + 角色徽章
 *   - V0.6 双状态：repoStatus（业务态）+ runStatus（运行态、跑动中才显示）
 *   - 最近一次 action（类型 + 状态）
 *   - 时间
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Clock,
  ExternalLink,
  FolderGit2,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useDialog } from "@/hooks/use-dialog";
import {
  ACTION_LABEL,
  ACTION_STATUS_LABEL,
  ACTION_STATUS_VARIANT,
  REPO_STATUS_LABEL,
  REPO_STATUS_VARIANT,
  RUN_STATUS_LABEL,
  RUN_STATUS_VARIANT,
  formatRelative,
  formatRepoPathsForDisplay,
} from "@/lib/task-display";
import { TASK_ROLE_LABEL, type TaskSummary } from "@/lib/types";

interface Props {
  task: TaskSummary;
  onArchiveToggle?: () => void;
  onDelete?: () => void;
}

// 哪些状态值得显示「归档」按钮——merged / abandoned 是 task 的终态
const canArchive = (task: TaskSummary): boolean =>
  task.archived ||
  task.repoStatus === "merged" ||
  task.repoStatus === "abandoned";

export const TaskCard = ({ task, onArchiveToggle, onDelete }: Props) => {
  const router = useRouter();
  const { confirm } = useDialog();

  const handleCardClick = () => {
    router.push(`/tasks/${task.id}`);
  };

  const handleArchiveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onArchiveToggle?.();
  };

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

  // runStatus = idle 时不显示（避免视觉噪音）、其他状态都显示
  const showRunStatus = task.runStatus !== "idle";

  return (
    <Card
      className="group cursor-pointer transition-colors hover:bg-muted/30"
      onClick={handleCardClick}
    >
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* 角色徽章：当前只 fe、未来扩 be/data/mobile/qa 时一眼可分 */}
            <Badge variant="outline" className="shrink-0">
              {TASK_ROLE_LABEL[task.role]}
            </Badge>
            {/* chat 模式 task 单独打标、跟正经 task 模式一眼区分 */}
            {task.mode === "chat" && (
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                对话
              </Badge>
            )}
            {/* 标题真 Link：键盘 tab 可达（Enter 进详情）、鼠标用户整卡点击仍可用（外层 onClick） */}
            <h3 className="min-w-0 flex-1 truncate text-base font-medium">
              <Link
                href={`/tasks/${task.id}`}
                className="text-foreground no-underline outline-offset-2 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {task.title}
              </Link>
            </h3>
            <Badge
              variant={REPO_STATUS_VARIANT[task.repoStatus]}
              className="shrink-0"
            >
              {REPO_STATUS_LABEL[task.repoStatus]}
            </Badge>
            {showRunStatus && (
              <Badge
                variant={RUN_STATUS_VARIANT[task.runStatus]}
                className="shrink-0"
              >
                {RUN_STATUS_LABEL[task.runStatus]}
              </Badge>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span
              className="flex items-center gap-1"
              title={task.repoPaths.join("\n")}
            >
              <FolderGit2 className="size-3.5" />
              {task.repoPaths.length > 0
                ? formatRepoPathsForDisplay(task.repoPaths)
                : "(未绑仓库)"}
            </span>
            {/* 最近一次 action：类型 + 状态、null = 任务还没跑过 */}
            {task.lastActionType && task.lastActionStatus && (
              <span className="flex items-center gap-1">
                <span>最近 action：{ACTION_LABEL[task.lastActionType]}</span>
                <Badge
                  variant={ACTION_STATUS_VARIANT[task.lastActionStatus]}
                  className="shrink-0 text-[10px]"
                >
                  {ACTION_STATUS_LABEL[task.lastActionStatus]}
                </Badge>
              </span>
            )}
            <span className="flex items-center gap-1">
              <Clock className="size-3.5" />
              {formatRelative(task.updatedAt)}
            </span>
          </div>
          {/* V0.6.1：MR 链接行（ship action 后才有内容）—— 多仓 task 多条 link 平铺 */}
          {task.mrs.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {task.mrs.map((mr) => {
                // 显示名：repoPath 末段（如 crm-web）+ v<N>（>1 时）
                const tail = mr.repoPath.split("/").filter(Boolean).pop() ?? mr.repoPath;
                const versionTag = mr.version > 1 ? ` v${mr.version}` : "";
                return (
                  <a
                    key={`${mr.repoPath}-${mr.version}`}
                    href={mr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    title={`${mr.title}\n${mr.url}`}
                  >
                    <ExternalLink className="size-3" />
                    {tail}
                    {versionTag}
                  </a>
                );
              })}
            </div>
          )}
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
