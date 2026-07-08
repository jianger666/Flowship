"use client";

/**
 * RestartDialog：重启当前 action 时选模型
 *
 * 把原来「重启当前阶段」的纯文字 confirm 升级成带 ModelSelect 的轻量 dialog：
 * - 模型默认选中该 action 当初实际跑的 `agentModel`（拉不到回退 task.model → settings.defaultModel）
 *   —— 不改就沿用原模型重跑、想换个更强 / 更省的模型接手就改了再重启
 * - 带模型草稿 → `disablePointerDismissal`（点外不关、防误丢选择；Esc / X / 取消仍可关）
 *
 * 提交态（submitting）由父组件持有（page 的 starting）、避免本组件和父组件各存一份漂移。
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ModelSelect } from "@/components/ui/model-select";
import { useModels } from "@/hooks/use-models";
import { getSettings, recordModelUsage } from "@/lib/local-store";
import { actionDisplayLabel } from "@/lib/task-display";
import type { ActionRecord, ModelSelection, Task } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task;
  // 要重启的 action（默认模型从它的 agentModel 取）
  action: ActionRecord;
  // 提交中：父组件 starting 态、提交期间禁用全部交互
  submitting: boolean;
  // 确认重启：把用户最终选定的模型回传给父组件去发请求
  onConfirm: (model: ModelSelection) => void;
}

export const RestartDialog = ({
  open,
  onOpenChange,
  task,
  action,
  submitting,
  onConfirm,
}: Props) => {
  // 可选模型列表：按 settings.apiKey 拉一次（跟设置页 / advance-dialog 同一套 hook）
  const { models, fetchModels } = useModels();

  // 默认模型：该 action 实际跑的 agentModel → task.model → settings.defaultModel（跟后端重启口径一致）
  const initialModel = useMemo<ModelSelection>(() => {
    if (action.agentModel?.id?.trim()) return action.agentModel;
    if (task.model?.id?.trim()) return task.model;
    const s = getSettings();
    return s.defaultModel?.id?.trim() ? s.defaultModel : { id: "" };
  }, [action.agentModel, task.model]);

  // 重启用的模型草稿：打开时初始化成默认、用户可改
  const [model, setModel] = useState<ModelSelection>(initialModel);

  // 每次打开重置成默认（避免上次改的残留）
  useEffect(() => {
    if (open) setModel(initialModel);
  }, [open, initialModel]);

  // 打开时按需拉模型列表（已有则跳过、省请求）
  useEffect(() => {
    if (!open) return;
    const s = getSettings();
    if (s.apiKey?.trim() && models.length === 0) {
      void fetchModels(s.apiKey);
    }
  }, [open, models.length, fetchModels]);

  const handleConfirm = () => {
    if (!model.id?.trim()) return;
    recordModelUsage(model); // 常用模型计数（重启也是一次真实使用）
    onConfirm(model);
  };

  return (
    // disablePointerDismissal：带模型草稿、点外误关丢选择；Esc / X / 取消仍可关
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>重启当前 {actionDisplayLabel(action)} 阶段</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            起新 agent 先读事件和 artifact 再接着这个阶段、可换个模型重跑（不新建 action、不丢产物）。
          </p>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">重启用的模型</span>
            <ModelSelect
              models={models}
              selection={model}
              onChange={setModel}
              disabled={submitting}
              variant="full"
              quickPicks
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={submitting || !model.id?.trim()}
          >
            {submitting ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RotateCcw />
            )}
            重启当前阶段
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
