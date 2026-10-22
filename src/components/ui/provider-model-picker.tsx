"use client";

/**
 * 提供方 + 模型组合选择器
 *
 * 两个 picker 一律并排、跟对话 footer 同一套 compact 样式。
 * 提供方下拉在建任务 / 对话 footer / 推进弹窗 / 任务说话条都有（空闲时可切）；运行中只灰掉、不卸载，
 * 卸载会让模型框每轮左移再回弹（第二轮 review V5-04）。`showProvider=false` 只给确实不该切的场景。
 * full 表单在上方多一行常用 chip；compact 只留下拉里的星。
 */

import { useState } from "react";

import { ModelQuickPicks, ModelSelect } from "@/components/ui/model-select";
import { Picker } from "@/components/ui/picker";
import { Tooltip } from "@/components/ui/tooltip";
import { listProviderOptions, providerDisplayName } from "@/lib/agent-provider";
import { getSettings } from "@/lib/local-store";
import {
  CURSOR_PROVIDER_ID,
  isCursorProvider,
  type ModelOption,
  type ModelSelection,
} from "@/lib/types";

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
  /** 提供方下拉被灰掉时 hover 说明原因（如「AI 运行中不能切换」）；只在 disabled 且有值时替换默认提示 */
  providerDisabledReason?: string;
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
  providerDisabledReason,
}: Props) => {
  const settings = getSettings();
  const options = listProviderOptions(settings);
  const compact = variant === "compact";
  const settingsDefault = settings.provider ?? CURSOR_PROVIDER_ID;
  const showHint =
    differFromSettingsHint && providerId !== settingsDefault;
  // 下拉里点星后刷新上方常用行
  const [starTick, setStarTick] = useState(0);

  // 当前值不在可选列表里（绑定的自定义提供方被删了 / 地址被清空）：下拉显示占位，选哪家都会触发切换
  const unavailable =
    !isCursorProvider(providerId) && !options.some((o) => o.value === providerId);
  const providerPicker = (
    <Picker
      value={providerId}
      placeholder={unavailable ? "请重选" : undefined}
      onChange={(id) => onProviderChange?.(id)}
      options={options}
      disabled={disabled}
      className="h-7 min-w-0 w-auto max-w-24 text-xs"
      wrapperClassName="w-auto min-w-0 max-w-full"
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

  const providerName = providerDisplayName(settings, providerId);
  // 提示优先级：灰掉的原因 > 与设置页默认不一致 > 长名全名（max-w-24 会截断，hover 给全名）。
  // 原生 disabled 控件收不到鼠标事件，所以 Tooltip 一律挂在外层 span 上。
  const providerTip = unavailable
    ? "原来绑定的提供方已删除或没配好，请重新选择一个提供方再发送"
    : disabled && providerDisabledReason
      ? providerDisabledReason
      : showHint
        ? `本窗口用这个提供方，设置页默认是 ${providerDisplayName(settings, settingsDefault)}`
        : providerName;
  const providerEl = (
    <Tooltip content={providerTip}>
      <span className="inline-flex w-auto max-w-24 shrink-0">{providerPicker}</span>
    </Tooltip>
  );

  // 输入框底栏窄屏：模型保底 128px（至少认得出是哪个模型），提供方保持 96px 不让位——
  // 压成「C…」没有信息量。再窄就由 RichInput footer 折行（它的 basis-58 = 这两个保底之和）。
  // compact 才保底：full 表单（推进弹窗 / 建任务）宽度充足，不需要。
  const modelSlotClass = compact ? "min-w-32 flex-1" : "min-w-0 flex-1";

  const pickerRow = showProvider ? (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <div className="w-auto max-w-24 shrink-0">{providerEl}</div>
      <div className={modelSlotClass}>{modelSelect}</div>
    </div>
  ) : (
    <div className={modelSlotClass}>{modelSelect}</div>
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
