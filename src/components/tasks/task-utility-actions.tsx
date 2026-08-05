"use client";

/**
 * TaskUtilityActions：任务级工具入口（需求群 / 任务文件夹）
 *
 * ghost 图标 + 文案形态，与「任务上下文 / MCP / 分批」（弹窗触发 chip）同排、
 * 中间用竖分隔线区分两类交互：需求群 / 任务文件夹是执行型按钮。
 */

import { useState } from "react";
import { FolderOpen, Loader2, Users } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useRequirementGroup } from "@/hooks/use-requirement-group";
import { isLightweightDailyTask } from "@/lib/lightweight-task";
import type { Task } from "@/lib/types";

// 轻量 ghost 按钮（图标 + 文案，与弹窗触发 chip 视觉区分）
const BTN_CLS = "h-6 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground";

interface Props {
  task: Task;
}

export const TaskUtilityActions = ({ task }: Props) => {
  const [openingTaskDir, setOpeningTaskDir] = useState(false);
  const [ensuringGroup, setEnsuringGroup] = useState(false);
  const { runEnsureGroup } = useRequirementGroup();
  // 需求任务才显示「需求群」（日常轻量任务无飞书工作项）
  const showRequirementGroup = !isLightweightDailyTask(task);
  const taskDirPath = task.taskDirPath?.trim() ?? "";

  const openTaskFolder = async () => {
    if (!taskDirPath || openingTaskDir) return;
    setOpeningTaskDir(true);
    try {
      const res = await fetch("/api/system/open-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: taskDirPath }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      toast.error(
        `打开任务文件夹失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setOpeningTaskDir(false);
    }
  };

  return (
    <>
      {showRequirementGroup && (
        <Tooltip content="创建或加入需求群">
          <Button
            variant="ghost"
            size="sm"
            className={BTN_CLS}
            disabled={ensuringGroup}
            onClick={() => {
              if (ensuringGroup) return;
              setEnsuringGroup(true);
              void runEnsureGroup(task.id).finally(() =>
                setEnsuringGroup(false),
              );
            }}
          >
            {ensuringGroup ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Users className="size-3" />
            )}
            需求群
          </Button>
        </Tooltip>
      )}
      {taskDirPath && (
        <Tooltip content="在文件管理器打开任务文件夹">
          <Button
            variant="ghost"
            size="sm"
            className={BTN_CLS}
            disabled={openingTaskDir}
            onClick={() => void openTaskFolder()}
          >
            {openingTaskDir ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <FolderOpen className="size-3" />
            )}
            任务文件夹
          </Button>
        </Tooltip>
      )}
    </>
  );
};
