"use client";

/**
 * ModelPicker（V0.6.0.1 末段抽）
 *
 * 「base model + parameters 双层 select」的纯 UI、不带 Card 包裹、不带 SaveButton。
 * 同时被 `settings/model-card.tsx`（设置页）和 `tasks/advance-dialog.tsx`（推进 dialog 里
 * 「强制起新 agent」时临时换模型）复用。
 *
 * 交互流程：
 *   1. 选 base model（dropdown）
 *   2. 该 model 有 parameters 时、自动展示 N 个二级 select（thinking / effort / context 等）
 *   3. 切 base model 时、自动用该 model 的 default variant 填初始 params
 *   4. 改任意 select 都通过 onChange(next: ModelSelection) 上传
 *
 * 显示约定：
 *   - 模型 displayName 带 ":icon-..." 时用 id fallback
 *   - 参数枚举 thinking 的 false/true 显示成「关 / 开」、其它直接用 displayName 或 value
 */

import { useMemo } from "react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type {
  ModelOption,
  ModelParameter,
  ModelSelection,
} from "@/lib/types";

const isIconToken = (s?: string) => !s || /:icon-/.test(s);

const renderParamLabel = (p: ModelParameter): string =>
  isIconToken(p.displayName) ? p.id : (p.displayName as string);

const renderParamValue = (
  p: ModelParameter,
  v: {
    value: string;
    displayName?: string;
  },
): string => {
  const base = isIconToken(v.displayName)
    ? v.value === "true"
      ? "开"
      : v.value === "false"
        ? "关"
        : v.value
    : (v.displayName as string);
  // MAX mode 警示（V0.7.14、用户是次数计费）：context 选 1m = Cursor MAX mode、
  // 整个 run 按 token 折算请求数（agentic 任务能烧几千次）；300k 以下 = 固定 1 次。
  // 官方文档：1M context requires Max Mode、request-based plan 下 MAX 走 token 计费
  if (p.id.toLowerCase() === "context" && /^1m$/i.test(v.value)) {
    return `${base}（MAX、按量计费）`;
  }
  return base;
};

// 选 base 模型时给个合理的初始 params：优先取 variants 里 isDefault 那个的 params
const defaultParamsFor = (
  m: ModelOption | undefined,
): ModelSelection["params"] => {
  if (!m?.variants || m.variants.length === 0) return undefined;
  const def = m.variants.find((v) => v.isDefault) ?? m.variants[0];
  return def.params.length > 0 ? def.params : undefined;
};

interface Props {
  models: ModelOption[];
  selection: ModelSelection;
  onChange: (next: ModelSelection) => void;
  // 透传给两个 select 的 disabled、外部可整组禁用（如 dialog 提交中）
  disabled?: boolean;
  // 模型列表为空时的 placeholder 文案；默认「（暂无可选）」
  emptyPlaceholder?: string;
  // 自定义 base select 的 placeholder
  placeholder?: string;
  // 显示模式：full 显示 base displayName + id 两行；compact 只显示 displayName 一行
  // 设置页用 full、dialog 里用 compact 省空间
  variant?: "full" | "compact";
}

export const ModelPicker = ({
  models,
  selection,
  onChange,
  disabled = false,
  emptyPlaceholder = "（暂无可选）",
  placeholder = "请选择模型",
  variant = "full",
}: Props) => {
  // 当前选中的 base model 完整定义（id 反查、避免每次 render 重算）
  const selectedModel = useMemo(
    () => models.find((m) => m.id === selection.id),
    [models, selection.id],
  );

  const onPickModel = (id: string) => {
    const m = models.find((x) => x.id === id);
    onChange({ id, params: defaultParamsFor(m) });
  };

  const onPickParam = (paramId: string, value: string) => {
    const old = selection.params ?? [];
    const exists = old.some((p) => p.id === paramId);
    const next = exists
      ? old.map((p) => (p.id === paramId ? { ...p, value } : p))
      : [...old, { id: paramId, value }];
    onChange({ id: selection.id, params: next });
  };

  return (
    <div className="space-y-2">
      <Select
        // 空值传 null 而非 undefined：Base UI Select 以「value 是否 undefined」判定受控/非受控，
        // settings 加载前 selection.id 为空 → undefined（非受控）、加载后 → string（受控）会触发切换警告
        value={selection.id || null}
        onValueChange={(v) => v && onPickModel(v)}
        disabled={disabled || models.length === 0}
      >
        <SelectTrigger className="w-full">
          <SelectValue
            placeholder={models.length === 0 ? emptyPlaceholder : placeholder}
          />
        </SelectTrigger>
        <SelectContent>
          {models.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {variant === "full" ? (
                <span className="flex flex-col">
                  <span>{m.displayName}</span>
                  <span className="text-xs text-muted-foreground font-mono">
                    {m.id}
                  </span>
                </span>
              ) : (
                <span>{m.displayName}</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* 二级：参数（thinking / effort / context / fast 等）。没参数的模型自然不显示 */}
      {selectedModel?.parameters && selectedModel.parameters.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {selectedModel.parameters.map((p) => {
            const current = selection.params?.find((x) => x.id === p.id)?.value;
            return (
              <div key={p.id} className="space-y-1">
                <Label className="text-xs text-muted-foreground capitalize">
                  {renderParamLabel(p)}
                </Label>
                <Select
                  // 同上：参数未选中时 current 为 undefined，用 null 兜底保持受控
                  value={current ?? null}
                  onValueChange={(v) => v && onPickParam(p.id, v)}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择" />
                  </SelectTrigger>
                  <SelectContent>
                    {p.values.map((v) => (
                      <SelectItem key={v.value} value={v.value}>
                        {renderParamValue(p, v)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
