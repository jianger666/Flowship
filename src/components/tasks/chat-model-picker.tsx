"use client";

/**
 * ChatModelPicker：chat 自由对话「切模型」入口（V0.6.24）
 *
 * 放输入框下方那行 footer 左侧（对齐 Cursor 的模型下拉位置）。
 * - 触发器：紧凑 button、显示当前模型 displayName（拉不到列表就退显 id）
 * - 点开 Popover：完整 ModelPicker（base + thinking/effort 参数）、选择即存（同设置页习惯）
 *
 * 硬约束（用户拍板的语义）：chat 是单个 SDK run、模型在 run 启动时绑死。所以：
 * - runStatus=running 时禁用：当前轮换不了、禁用避免误导
 * - 切了不立即重启：用户下条消息起的新 run 才用新模型（chat 本来 done 后再发消息就自动起新 run）
 * - 成功不弹 toast（用户要求）、失败才提示
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";

import { ModelPicker } from "@/components/ui/model-picker";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useModels } from "@/hooks/use-models";
import { getSettings } from "@/lib/local-store";
import { setTaskModel } from "@/lib/task-store";
import type { ModelSelection, Task } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  task: Task;
  onTaskUpdate: (next: Task) => void;
}

export const ChatModelPicker = ({ task, onTaskUpdate }: Props) => {
  // popover 开关（受控）：点外部 / Esc 关、选模型不主动关（允许连续调 base + params）
  const [open, setOpen] = useState(false);
  // 持久化飞行中：PATCH 期间禁用 picker、防连点
  const [saving, setSaving] = useState(false);

  // 可选模型列表、按 settings.apiKey 拉一次（跟设置页 / advance-dialog 同一套 hook）
  const { models, fetchModels } = useModels();

  // 当前生效模型：task.model 有 id 用它、否则回退 settings.defaultModel（跟 prepareRunArgs 同口径）
  const current: ModelSelection = useMemo(() => {
    if (task.model?.id?.trim()) return task.model;
    const s = getSettings();
    return s.defaultModel?.id?.trim() ? s.defaultModel : { id: "" };
  }, [task.model]);

  // 打开时按需拉一次模型列表（已有则跳过、省请求）
  useEffect(() => {
    if (!open) return;
    const s = getSettings();
    if (s.apiKey?.trim() && models.length === 0) {
      void fetchModels(s.apiKey);
    }
  }, [open, models.length, fetchModels]);

  // 触发器展示名：列表里反查 displayName、拉不到退显 id、再不行占位
  const label = useMemo(() => {
    const m = models.find((x) => x.id === current.id);
    if (m?.displayName) return m.displayName;
    return current.id || "选择模型";
  }, [models, current.id]);

  // 选模型 / 调参 → 持久化 task.model（不关 popover、允许接着调 params）
  const handlePick = async (next: ModelSelection) => {
    if (!next.id?.trim()) return;
    setSaving(true);
    try {
      const latest = await setTaskModel(task.id, next);
      onTaskUpdate(latest);
    } catch (err) {
      toast.error(`切换模型失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // running 时禁用：当前轮模型已锁死、切了也是下一轮、禁用避免误导
  const disabled = task.runStatus === "running";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className={cn(
          "inline-flex h-7 max-w-44 items-center gap-1 rounded-md border border-input bg-transparent px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
        )}
        title={
          disabled
            ? "agent 正在回、当前轮模型已锁定（下轮可切）"
            : "切换模型（下条消息生效）"
        }
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72">
        <div className="mb-2 text-xs text-muted-foreground">
          切换后下一条消息生效
        </div>
        <ModelPicker
          models={models}
          selection={current}
          onChange={handlePick}
          disabled={saving}
          variant="compact"
        />
      </PopoverContent>
    </Popover>
  );
};
