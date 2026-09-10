"use client";

/**
 * 任务详情：手动切提供方（V2a）。
 * 只做“能切 + 提示丢精细上下文”，不做交接摘要、不做自动故障转移。
 * 禁用看详情页 runActive latch（不只看 runStatus，盖住交卷后流式窗口），后端再判一次。
 */

import { useState } from "react";
import { toast } from "sonner";

import { Picker } from "@/components/ui/picker";
import { useDialog } from "@/hooks/use-dialog";
import {
  isProviderSwitchLocked,
  listProviderOptions,
  resolveTaskProvider,
} from "@/lib/agent-provider";
import { getSettings } from "@/lib/local-store";
import { setTaskProvider } from "@/lib/task-store";
import {
  CURSOR_PROVIDER_ID,
  defaultModelForProvider,
  type Task,
} from "@/lib/types";

interface Props {
  task: Task;
  /** 详情页主 run latch：交卷后流式窗口 runStatus 已翻但 run 还在吐，照样禁切 */
  runActive: boolean;
  onTaskUpdate: (next: Task) => void;
}

export const TaskProviderSwitch = ({
  task,
  runActive,
  onTaskUpdate,
}: Props) => {
  const [saving, setSaving] = useState(false);
  const { confirm } = useDialog();
  const settings = getSettings();
  const providerId = resolveTaskProvider(task, settings);

  if (task.mode !== "task") return null;
  if (task.repoStatus === "merged" || task.repoStatus === "abandoned")
    return null;

  const locked = isProviderSwitchLocked(task);
  const running = runActive || task.runStatus === "running";
  const disabled = saving || running || locked;
  const title = running
    ? "运行中不能切换，等停下来再切"
    : locked
      ? "当前步骤运行中，等停下来再切"
      : "切换提供方（丢精细上下文，只留消息记录 + 磁盘文件 + worktree）";

  const handleChange = async (nextId: string) => {
    if (!nextId || nextId === providerId || disabled) return;
    // 前端先拦（后端 setTaskProvider 还会再判一次）。
    if (task.runStatus === "running" || runActive) {
      toast.error("正在运行中，不能切换提供方，等停下来再切");
      return;
    }
    const ok = await confirm({
      title: "切换提供方？",
      description:
        "会丢掉当前会话的精细上下文（tool 调用历史），只保留界面消息、磁盘文件和 worktree，下次推进用新提供方重新开始。",
      confirmLabel: "确认切换",
      cancelLabel: "再想想",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const model = defaultModelForProvider(getSettings(), nextId);
      const latest = await setTaskProvider(
        task.id,
        nextId,
        model.id.trim() ? model : undefined,
      );
      onTaskUpdate(latest);
      toast.success(
        "已切换提供方，下次推进用新会话继续（精细上下文已丢，worktree 文件还在）",
      );
    } catch (err) {
      toast.error(`切换提供方失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <span title={title} className="inline-flex">
      <Picker
        value={providerId || CURSOR_PROVIDER_ID}
        onChange={(id) => void handleChange(id)}
        options={listProviderOptions(settings)}
        disabled={disabled}
        className="h-8 w-auto max-w-36 text-xs"
        wrapperClassName="w-auto"
        contentClassName="w-56 min-w-56 max-w-64"
      />
    </span>
  );
};
