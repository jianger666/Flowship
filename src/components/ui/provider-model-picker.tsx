"use client";

/**
 * 提供方 + 模型组合选择器
 *
 * 两个 picker 一律并排、跟对话 footer 同一套 compact 样式。
 * 提供方下拉只在建任务 / 空对话出现；chat 发过消息、推进里只留模型。
 * full 表单在上方多一行常用 chip；compact 只留下拉里的星。
 */

import { useState } from "react";

import { ModelQuickPicks, ModelSelect } from "@/components/ui/model-select";
import { Picker } from "@/components/ui/picker";
import { Tooltip } from "@/components/ui/tooltip";
import { listProviderOptions, providerDisplayName } from "@/lib/agent-provider";
import { getSettings } from "@/lib/local-store";
import { CURSOR_PROVIDER_ID, type ModelOption, type ModelSelection } from "@/lib/types";

interface Props {
  providerId: string;
  onProviderChange?: (nextId: string) => void;
  models: ModelOption[];
  selection: ModelSelection;
  onModelChange: (next: ModelSelection) => void;
  disabled?: boolean;
  /** full：建任务 / 推进，多常用 chip；compact：对话 footer */
  variant?: "full" | "compact";
  /** false：只画模型（chat 已发过 / 推进）。默认 true */
  showProvider?: boolean;
  emptyPlaceholder?: string;
  onModelOpenChange?: (open: boolean) => void;
  /** 本窗口提供方和设置页默认不一致时，hover 提示（对话 footer 用） */
  differFromSettingsHint?: boolean;
}

export const ProviderModelPicker = ({
  providerId,
  onProviderChange,
  models,
  selection,
  onModelChange,
  disabled = false,
  variant = "full",
  showProvider = true,
  emptyPlaceholder = "选择模型",
  onModelOpenChange,
  differFromSettingsHint = false,
}: Props) => {
  const settings = getSettings();
  const options = listProviderOptions(settings);
  const compact = variant === "compact";
  const settingsDefault = settings.provider ?? CURSOR_PROVIDER_ID;
  const showHint =
    differFromSettingsHint && providerId !== settingsDefault;
  // 下拉里点星后刷新上方常用行
  const [starTick, setStarTick] = useState(0);

  const providerPicker = (
    <Picker
      value={providerId}
      onChange={(id) => onProviderChange?.(id)}
      options={options}
      disabled={disabled}
      className="h-7 min-w-0 w-auto max-w-36 text-xs"
      wrapperClassName="w-auto"
      contentClassName="w-56 min-w-56 max-w-64"
    />
  );

  const modelSelect = (
    <ModelSelect
      models={models}
      selection={selection}
      onChange={onModelChange}
      disabled={disabled}
      variant="compact"
      emptyPlaceholder={emptyPlaceholder}
      onOpenChange={onModelOpenChange}
      providerId={providerId}
      onStarredChange={() => setStarTick((n) => n + 1)}
    />
  );

  const providerEl = showHint ? (
    <Tooltip
      content={`本窗口用这个提供方，设置页默认是 ${providerDisplayName(settings, settingsDefault)}`}
    >
      <span className="inline-flex w-auto max-w-36 shrink-0">{providerPicker}</span>
    </Tooltip>
  ) : (
    providerPicker
  );

  const pickerRow = showProvider ? (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="w-auto max-w-36 shrink-0">{providerEl}</div>
      <div className="min-w-0">{modelSelect}</div>
    </div>
  ) : (
    <div className="min-w-0">{modelSelect}</div>
  );

  if (compact) return pickerRow;

  return (
    <div className="flex flex-col gap-1.5">
      <ModelQuickPicks
        models={models}
        selection={selection}
        onChange={onModelChange}
        disabled={disabled}
        providerId={providerId}
        starTick={starTick}
      />
      {pickerRow}
    </div>
  );
};
