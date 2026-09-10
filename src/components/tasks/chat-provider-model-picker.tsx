"use client";

/**
 * 对话 footer：chat 空闲可切提供方（发过消息也行）、running 禁切。切了只 PATCH，下条消息懒重启。
 * V1 只做“能切 + 提示丢精细上下文”，不做交接摘要、不做自动故障转移。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ProviderModelPicker } from "@/components/ui/provider-model-picker";
import { useDialog } from "@/hooks/use-dialog";
import { useModels } from "@/hooks/use-models";
import {
  getModelCredsForProvider,
  hasModelCredsForProvider,
  isProviderSwitchLocked,
  resolveTaskProvider,
} from "@/lib/agent-provider";
import { getSettings } from "@/lib/local-store";
import { setTaskModel, setTaskProvider } from "@/lib/task-store";
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
  const [savingProvider, setSavingProvider] = useState(false);
  // 连点思考档只认最后一次 PATCH，避免乱序回写把 chip 打回上一档
  const modelSaveGen = useRef(0);
  const { models, fetchModels } = useModels();
  const settings = getSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const providerId = resolveTaskProvider(task, settings);

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
  // V1：chat 空闲就露提供方（发过消息也行）；running 由 busy 禁掉，后端再判一次。
  const showProvider = !isProviderSwitchLocked(task);
  const { confirm } = useDialog();

  const handleProviderChange = async (nextId: string) => {
    if (!showProvider || !nextId || nextId === providerId) return;
    // 硬约束 1：running 中禁止切，前端先拦（后端 setTaskProvider 还会再判）。
    if (task.runStatus === "running") {
      toast.error("正在运行中，不能切换提供方，等停下来再切");
      return;
    }
    // 有过会话锚点 = 发过消息：切即丢精细上下文，先让用户亲口确认。
    if (task.sessionAgentId?.trim()) {
      const ok = await confirm({
        title: "切换提供方？",
        description:
          "会丢掉当前会话的精细上下文（tool 调用历史），只保留界面上的消息记录和磁盘文件，下条消息用新提供方重新开始。",
        confirmLabel: "确认切换",
        cancelLabel: "再想想",
      });
      if (!ok) return;
    }
    setSavingProvider(true);
    try {
      const model = defaultModelForProvider(settingsRef.current, nextId);
      const latest = await setTaskProvider(
        task.id,
        nextId,
        model.id.trim() ? model : undefined,
      );
      onTaskUpdate(latest);
      pull(nextId);
      if (task.sessionAgentId?.trim()) {
        toast.success("已切换提供方，下条消息用新会话继续（精细上下文已丢）");
      }
    } catch (err) {
      toast.error(`切换提供方失败：${(err as Error).message}`);
    } finally {
      setSavingProvider(false);
    }
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
      differFromSettingsHint={showProvider}
      onModelOpenChange={(open) => {
        if (open && models.length === 0) pull(providerId);
      }}
    />
  );
};
