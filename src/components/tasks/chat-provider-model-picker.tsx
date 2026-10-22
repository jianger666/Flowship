"use client";

/**
 * 对话 footer：chat 空闲可切提供方（发过消息也行）、running 禁切。切了只 PATCH，下条消息懒重启。
 * V1 只做“能切 + 提示丢精细上下文”，不做交接摘要、不做自动故障转移。
 */

import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";

import { ProviderModelPicker } from "@/components/ui/provider-model-picker";
import { useModels } from "@/hooks/use-models";
import { useProviderSwitch } from "@/hooks/use-provider-switch";
import {
  getModelCredsForProvider,
  hasModelCredsForProvider,
  isProviderSwitchLocked,
  resolveTaskProviderForPicker,
} from "@/lib/agent-provider";
import { getSettings } from "@/lib/local-store";
import { setTaskModel } from "@/lib/task-store";
import {
  CURSOR_PROVIDER_ID,
  defaultModelForProvider,
  type ModelSelection,
  type Task,
} from "@/lib/types";

interface Props {
  task: Task;
  onTaskUpdate: (next: Task) => void;
}

export const ChatProviderModelPicker = ({ task, onTaskUpdate }: Props) => {
  // 只在切提供方时锁 UI。切模型 / 思考档也会 PATCH，但不能 disabled：
  // Picker 在 disabled 时会强制关弹层，请求一结束又按还开着的 open 重开，下拉会闪一下。
  // 切换动作走共享 hook（输入条 / 推进弹窗同款：有锚点先确认、清覆盖、toast）
  const { switchProvider, saving: savingProvider } = useProviderSwitch({
    taskId: task.id,
    sessionAgentId: task.sessionAgentId,
    onSwitched: onTaskUpdate,
  });
  // 连点思考档只认最后一次 PATCH，避免乱序回写把 chip 打回上一档
  const modelSaveGen = useRef(0);
  const { models, fetchModels } = useModels();
  const settings = getSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // 绑定的条目已删除时是悬空 id（下拉显示「请重选」，选任意一家都会触发切换）
  const providerId = resolveTaskProviderForPicker(task, settings);

  const current: ModelSelection = useMemo(() => {
    if (task.model?.id?.trim()) return task.model;
    const m = defaultModelForProvider(settings, providerId);
    return m?.id?.trim() ? m : { id: "" };
  }, [task.model, settings, providerId]);

  const pull = (id: string) => {
    const s = settingsRef.current;
    if (!hasModelCredsForProvider(s, id)) return;
    const creds = getModelCredsForProvider(s, id);
    void fetchModels({ ...creds, provider: id });
  };

  useEffect(() => {
    const s = settingsRef.current;
    if (!hasModelCredsForProvider(s, providerId)) return;
    void fetchModels({
      ...getModelCredsForProvider(s, providerId),
      provider: providerId,
    });
  }, [providerId, fetchModels]);

  const busy = task.runStatus === "running" || savingProvider;
  // V1：chat 一直露提供方（发过消息也行），running 只走 `disabled`（由 busy 灰掉），后端再判一次。
  // 以前这里用 `!isProviderSwitchLocked(task)` 当「显不显示」：每轮开始 / 结束提供方下拉整个卸载 / 冒出，
  // 模型框左移再回弹（每轮抖两次），运行中也看不出「当前在用哪家」（第二轮 review V5-04）。
  const showProvider = true;
  // 真正能不能切仍以锁判据为准（running 会被 busy 灰掉、handleProviderChange 再拦一次）
  const switchLocked = isProviderSwitchLocked(task);

  const handleProviderChange = async (nextId: string) => {
    if (!nextId || nextId === providerId) return;
    // 硬约束 1：running 中禁止切，前端先拦（后端 setTaskProvider 还会再判）。
    if (task.runStatus === "running") {
      toast.error("正在运行中，不能切换提供方，等停下来再切");
      return;
    }
    if (switchLocked) return;
    const latest = await switchProvider(nextId);
    if (latest) pull(nextId);
  };

  const handleModelChange = async (next: ModelSelection) => {
    if (!next.id?.trim()) return;
    const gen = ++modelSaveGen.current;
    try {
      const latest = await setTaskModel(task.id, next);
      if (gen !== modelSaveGen.current) return;
      onTaskUpdate(latest);
    } catch (err) {
      if (gen !== modelSaveGen.current) return;
      toast.error(`切换模型失败：${(err as Error).message}`);
    }
  };

  return (
    <ProviderModelPicker
      variant="compact"
      showProvider={showProvider}
      providerId={providerId || CURSOR_PROVIDER_ID}
      onProviderChange={(id) => void handleProviderChange(id)}
      models={models}
      selection={current}
      onModelChange={(next) => void handleModelChange(next)}
      disabled={busy}
      // 运行中灰掉提供方时说明原因（V5-04：以前是整个卸载，用户看不出「现在在用哪家」也不知道为什么没了）
      providerDisabledReason={
        task.runStatus === "running" ? "AI 运行中不能切换提供方，等它停下来再切" : undefined
      }
      differFromSettingsHint={showProvider}
      onModelOpenChange={(open) => {
        if (open && models.length === 0) pull(providerId);
      }}
    />
  );
};
