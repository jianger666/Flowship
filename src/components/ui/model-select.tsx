"use client";

/**
 * ModelSelect（统一模型选择器）
 *
 * 全站模型选择的唯一组件：trigger + 可搜索 popover + 思考档 chips。
 * 常用 = 当前提供方下拉里点五角星钉住的最多 2 个模型（不是使用次数）。
 */

import { useMemo, useState } from "react";
import { Star } from "lucide-react";
import { toast } from "sonner";

import { ChoiceButton } from "@/components/ui/choice-button";
import { Picker } from "@/components/ui/picker";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DEFAULT_THINKING_VALUE,
  isDefaultThinkingValue,
  isThinkingParamId,
  resolveThinkingTriggerLabel,
  thinkingChipLabel,
  withDefaultThinkingParam,
} from "@/lib/custom-effort";
import { getStarredModelIds, toggleStarredModel } from "@/lib/local-store";
import {
  visibleModelParameters,
  withoutHiddenModelParams,
} from "@/lib/model-params";
import { settingsUrl } from "@/lib/settings-link";
import {
  isCursorProvider,
  type ModelOption,
  type ModelParameter,
  type ModelSelection,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const isIconToken = (s?: string) => !s || /:icon-/.test(s);

/** Cursor 用 SDK 原文案；自定义思考档统一 thinking + 英文协议值 */
const renderParamLabel = (p: ModelParameter, cursorNative: boolean): string => {
  if (!cursorNative && isThinkingParamId(p.id)) return "thinking";
  return isIconToken(p.displayName) ? p.id : (p.displayName as string);
};

const renderParamValue = (
  p: ModelParameter,
  v: { value: string; displayName?: string },
  cursorNative: boolean,
): string => {
  if (!cursorNative && isThinkingParamId(p.id)) return thinkingChipLabel(v.value);
  if (isIconToken(v.displayName)) {
    return v.value === "true" ? "开" : v.value === "false" ? "关" : v.value;
  }
  return v.displayName as string;
};

const thinkingParamOf = (m: ModelOption | undefined): ModelParameter | undefined =>
  visibleModelParameters(m?.parameters)?.find((p) => isThinkingParamId(p.id));

// 自定义：切模型落到 Default（不传思考覆盖）。Cursor：走 SDK 自己的 isDefault variant。
const defaultParamsFor = (
  m: ModelOption | undefined,
  cursorNative: boolean,
): ModelSelection["params"] => {
  if (!cursorNative) {
    const thinking = thinkingParamOf(m);
    if (thinking) {
      return withoutHiddenModelParams([
        { id: thinking.id, value: DEFAULT_THINKING_VALUE },
      ]);
    }
  }
  if (!m?.variants || m.variants.length === 0) return undefined;
  const def = m.variants.find((v) => v.isDefault) ?? m.variants[0];
  return withoutHiddenModelParams(def.params.length > 0 ? def.params : undefined);
};

const modelName = (m: ModelOption): string =>
  isIconToken(m.displayName) ? m.id : m.displayName;

/** 建任务 / 推进：常用 chip 单独一行，不塞进模型列、避免和提供方并排错位 */
export const ModelQuickPicks = ({
  models,
  selection,
  onChange,
  disabled = false,
  providerId,
  starTick,
}: {
  models: ModelOption[];
  selection: ModelSelection;
  onChange: (next: ModelSelection) => void;
  disabled?: boolean;
  providerId: string;
  /** 跟下拉里点星共用的刷新信号 */
  starTick: number;
}) => {
  const starredIds = useMemo(
    () => getStarredModelIds(providerId),
    [providerId, starTick],
  );
  if (starredIds.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="shrink-0 text-[11px] text-muted-foreground/70">常用</span>
      {starredIds.map((id) => {
        const m = models.find((x) => x.id === id);
        return (
          <ChoiceButton
            key={id}
            shape="chip"
            selected={selection.id === id}
            disabled={disabled}
            onClick={() => {
              if (m) onChange({ id: m.id, params: defaultParamsFor(m, isCursorProvider(providerId)) });
              else onChange({ id, params: undefined });
            }}
            className="text-xs"
          >
            {m ? modelName(m) : id}
          </ChoiceButton>
        );
      })}
    </div>
  );
};

const modelLabelOf = (models: ModelOption[], id: string): string => {
  const m = models.find((x) => x.id === id);
  return m ? modelName(m) : id;
};

interface Props {
  models: ModelOption[];
  selection: ModelSelection;
  onChange: (next: ModelSelection) => void;
  disabled?: boolean;
  variant?: "full" | "compact";
  emptyPlaceholder?: string;
  onOpenChange?: (open: boolean) => void;
  /** 当前提供方：有值才画五角星 / 常用 chip */
  providerId?: string;
  /** 常用 chip 行（full 表单用；compact footer 只留星标在下拉里） */
  quickPicks?: boolean;
  /** 点星后通知外层（ProviderModelPicker 的常用行跟下拉里的星同步） */
  onStarredChange?: () => void;
}

export const ModelSelect = ({
  models,
  selection,
  onChange,
  disabled = false,
  variant = "full",
  emptyPlaceholder = "选择模型",
  onOpenChange,
  providerId,
  quickPicks = false,
  onStarredChange,
}: Props) => {
  // 弹层开关：选模型 / 调参数都不主动关；点外 / Esc 才关
  const [open, setOpen] = useState(false);
  // 点星后刷新常用列表（settings 缓存变了、组件自己再读一遍）
  const [starTick, setStarTick] = useState(0);

  const cursorNative = isCursorProvider(providerId);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === selection.id),
    [models, selection.id],
  );

  const thinkingLabel = useMemo(
    () =>
      selection.id
        ? resolveThinkingTriggerLabel(
            selectedModel,
            selection.params,
            cursorNative,
          )
        : null,
    [selection.id, selection.params, selectedModel, cursorNative],
  );

  const starredIds = useMemo(
    () => (providerId ? getStarredModelIds(providerId) : []),
    [providerId, starTick],
  );

  const pickerOptions = useMemo(
    () => models.map((m) => ({ value: m.id, label: modelName(m) })),
    [models],
  );

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const handlePickModel = (m: ModelOption) => {
    onChange({ id: m.id, params: defaultParamsFor(m, cursorNative) });
  };

  const handlePickParam = (paramId: string, value: string) => {
    const old = selection.params ?? [];
    const exists = old.some((p) => p.id === paramId);
    const next = exists
      ? old.map((p) => (p.id === paramId ? { ...p, value } : p))
      : [...old, { id: paramId, value }];
    onChange({
      id: selection.id,
      params: withoutHiddenModelParams(next),
    });
  };

  const handleToggleStar = (modelId: string) => {
    if (!providerId || disabled) return;
    const result = toggleStarredModel(providerId, modelId);
    if (result.full) {
      toast.error("该提供方最多 2 个常用", { id: "starred-models-full" });
      return;
    }
    setStarTick((n) => n + 1);
    onStarredChange?.();
  };

  const quickPickRow =
    quickPicks && providerId ? (
      <ModelQuickPicks
        models={models}
        selection={selection}
        onChange={onChange}
        disabled={disabled}
        providerId={providerId}
        starTick={starTick}
      />
    ) : null;

  const visibleParams = (
    visibleModelParameters(selectedModel?.parameters) ?? []
  ).map((p) => (cursorNative ? p : withDefaultThinkingParam(p)));
  const paramFooter =
    visibleParams.length > 0 ? (
      <div className="flex flex-col gap-2 border-t px-3 py-2">
        {visibleParams.map((p) => {
          const rawCurrent = selection.params?.find((x) => x.id === p.id)?.value;
          const current =
            cursorNative &&
            rawCurrent != null &&
            isThinkingParamId(p.id) &&
            isDefaultThinkingValue(rawCurrent)
              ? undefined
              : rawCurrent;
          return (
            <div key={p.id} className="flex flex-col gap-1">
              <span className="text-[11px] capitalize text-muted-foreground">
                {renderParamLabel(p, cursorNative)}
              </span>
              <div className="flex flex-wrap gap-1">
                {p.values.map((v) => {
                  const selected =
                    current === v.value ||
                    (!cursorNative &&
                      isThinkingParamId(p.id) &&
                      isDefaultThinkingValue(v.value) &&
                      (current == null || isDefaultThinkingValue(current)));
                  return (
                    <ChoiceButton
                      key={v.value}
                      shape="chip"
                      selected={selected}
                      disabled={disabled}
                      onClick={() => handlePickParam(p.id, v.value)}
                    >
                      {renderParamValue(p, v, cursorNative)}
                    </ChoiceButton>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    ) : null;

  const popoverEl = (
    <Picker
      open={open}
      onOpenChange={handleOpenChange}
      options={pickerOptions}
      value={selection.id}
      onChange={(id) => {
        const m = models.find((x) => x.id === id);
        if (m) handlePickModel(m);
      }}
      searchable
      closeOnSelect={false}
      disabled={disabled}
      placeholder={emptyPlaceholder}
      searchPlaceholder="搜索模型…"
      className={
        variant === "compact" ? "h-7 min-w-0 w-auto max-w-64 text-xs" : undefined
      }
      wrapperClassName={variant === "compact" ? "w-auto" : undefined}
      contentClassName={variant === "compact" ? "w-72 min-w-72 max-w-72" : undefined}
      emptyHint={
        models.length === 0 ? (
          <a
            href={settingsUrl("model")}
            className="text-primary underline-offset-2 hover:underline"
          >
            去设置页拉取模型列表
          </a>
        ) : (
          "无候选"
        )
      }
      filterOption={(option, query) => {
        const q = query.trim().toLowerCase();
        if (!q) return true;
        const m = models.find((x) => x.id === option.value);
        if (!m) return option.value.toLowerCase().includes(q);
        return (
          m.id.toLowerCase().includes(q) ||
          m.displayName.toLowerCase().includes(q)
        );
      }}
      renderOption={(option) => {
        const m = models.find((x) => x.id === option.value);
        if (!m) return option.label;
        return (
          <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <span className="truncate text-sm">{modelName(m)}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {m.id}
            </span>
          </span>
        );
      }}
      renderOptionAction={
        providerId
          ? (option) => {
              const starred = starredIds.includes(option.value);
              return (
                <Tooltip content={starred ? "取消常用" : "设为常用"}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={starred ? "取消常用" : "设为常用"}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleToggleStar(option.value);
                    }}
                    className={cn(
                      "shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                      starred && "text-foreground",
                    )}
                  >
                    <Star
                      className={cn("size-3.5", starred && "fill-current")}
                    />
                  </button>
                </Tooltip>
              );
            }
          : undefined
      }
      renderTrigger={() => (
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center text-left",
            !selection.id && "text-muted-foreground",
          )}
        >
          <span className="min-w-0 truncate">
            {selection.id
              ? modelLabelOf(models, selection.id)
              : emptyPlaceholder}
          </span>
          {thinkingLabel ? (
            <span className="shrink-0 text-muted-foreground">
              {" · "}
              {thinkingLabel}
            </span>
          ) : null}
        </span>
      )}
      footer={paramFooter}
    />
  );

  if (!quickPickRow) return popoverEl;
  return (
    <div className="flex flex-col gap-1.5">
      {quickPickRow}
      {popoverEl}
    </div>
  );
};
