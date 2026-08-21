"use client";

/**
 * 对话 footer：空对话可切提供方；发过消息后只留模型。切了只 PATCH，下条消息懒重启。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ProviderModelPicker } from "@/components/ui/provider-model-picker";
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
  const [saving, setSaving] = useState(false);
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

  const busy = task.runStatus === "running" || saving;
  const showProvider = !isProviderSwitchLocked(task);

  const handleProviderChange = async (nextId: string) => {
    if (!showProvider || !nextId || nextId === providerId) return;
    setSaving(true);
    try {
      const model = defaultModelForProvider(settingsRef.current, nextId);
      const latest = await setTaskProvider(
        task.id,
        nextId,
        model.id.trim() ? model : undefined,
      );
      onTaskUpdate(latest);
      pull(nextId);
    } catch (err) {
      toast.error(`切换提供方失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleModelChange = async (next: ModelSelection) => {
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
