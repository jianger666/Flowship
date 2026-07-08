"use client";

/**
 * ChatModelPicker：chat 自由对话「切模型」入口（V0.6.24、重构后只是 ModelSelect 的薄包装）
 *
 * 放输入框下方 footer 左侧。封装 chat 特有的业务逻辑、UI 全交给统一的 `ModelSelect`：
 * - 选模型 / 调参数 → 持久化到 task.model（同设置页习惯、成功不弹 toast、失败才提示）
 * - 打开时按需拉模型列表
 *
 * 硬约束（用户拍板的语义）：chat 是单个 SDK run、模型在 run 启动时绑死。所以：
 * - runStatus=running 时禁用：agent 正吐字、当前轮换不了、禁用避免误导
 * - 切了不立即停对话、只存 task.model（懒重启）：用户下条消息发出时、后端 chat-reply 比对
 *   「当前 run 绑定模型 vs 现在选的」——变了才取消旧 run + 用新模型起新 run（历史靠 events 续）、
 *   没变（切了又切回 / 没真改）就正常续接。所以这里切完零副作用、不必重启、不弹提示。
 *
 * 重构记：旧版是 Popover 套 ModelPicker(内含 Select) = 嵌套弹层、用户实测「选完点空白要两次才关」。
 * 改用 ModelSelect（自带单层 popover + chips 参数、零嵌套）后、点一次空白即关。
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ModelSelect } from "@/components/ui/model-select";
import { useModels } from "@/hooks/use-models";
import { getSettings, recordModelUsage } from "@/lib/local-store";
import { setTaskModel } from "@/lib/task-store";
import type { ModelSelection, Task } from "@/lib/types";

interface Props {
  task: Task;
  onTaskUpdate: (next: Task) => void;
}

export const ChatModelPicker = ({ task, onTaskUpdate }: Props) => {
  // 持久化飞行中：PATCH 期间禁用、防连点
  const [saving, setSaving] = useState(false);

  // 可选模型列表（按 settings.apiKey 拉一次、跟设置页 / dialog 同一套 hook）
  const { models, fetchModels } = useModels();

  // 当前生效模型：task.model 有 id 用它、否则回退 settings.defaultModel（跟 prepareRunArgs 同口径）
  const current: ModelSelection = useMemo(() => {
    if (task.model?.id?.trim()) return task.model;
    const s = getSettings();
    return s.defaultModel?.id?.trim() ? s.defaultModel : { id: "" };
  }, [task.model]);

  // 选模型 / 调参 → 持久化 task.model（每次 onChange 都存、同设置页习惯）
  const handlePick = async (next: ModelSelection) => {
    if (!next.id?.trim()) return;
    setSaving(true);
    try {
      const latest = await setTaskModel(task.id, next);
      recordModelUsage(next); // 常用模型计数（chat 换模型也是一次真实使用）
      onTaskUpdate(latest);
    } catch (err) {
      toast.error(`切换模型失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // 挂载即拉一次模型列表（不等 popover 打开）——否则 trigger 只能显示 task.model.id、
  // 反查不到完整 displayName + 参数摘要（用户实测「首次进对话模型名不全、点一下才对」）。
  // useModels 有 SWR 缓存、命中立即填充、不会每次进对话都打网络。
  useEffect(() => {
    const s = getSettings();
    if (s.apiKey?.trim() && models.length === 0) {
      void fetchModels(s.apiKey);
    }
  }, [models.length, fetchModels]);

  // 打开时按需拉模型列表（已有则跳过、省请求）
  const handleOpenChange = (open: boolean) => {
    if (!open) return;
    const s = getSettings();
    if (s.apiKey?.trim() && models.length === 0) {
      void fetchModels(s.apiKey);
    }
  };

  return (
    <ModelSelect
      models={models}
      selection={current}
      onChange={handlePick}
      // running 时模型已锁死（下轮才生效）、saving 时防连点——都禁用
      disabled={task.runStatus === "running" || saving}
      variant="compact"
      onOpenChange={handleOpenChange}
    />
  );
};
