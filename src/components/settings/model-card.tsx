"use client";

/**
 * 默认模型卡片
 *
 * 交互流程：
 *   1. 选 base model（dropdown）
 *   2. 该 model 有 parameters 时、自动展示 N 个二级 select（thinking / effort / context 等）
 *   3. 切 base model 时、自动用该 model 的 default variant 填 params
 *   4. 改任意 select 都通过 onChange(next: ModelSelection) 上传
 *
 * 显示约定：
 *   - 模型 displayName 带 ":icon-..." 时用 id fallback
 *   - 参数枚举 thinking 的 false/true 显示成「关 / 开」、其它直接用 displayName 或 value
 */

import { useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { ModelOption, ModelParameter, ModelSelection } from "@/lib/types";
import { SaveButton } from "./save-button";

// SDK 返回的 displayName 经常带 ":icon-brain:" 这种 IDE icon token、
// 在我们 UI 里显示出来又丑又看不懂、统一 fallback 到 value
const isIconToken = (s?: string) => !s || /:icon-/.test(s);

const renderParamLabel = (p: ModelParameter): string =>
  isIconToken(p.displayName) ? p.id : (p.displayName as string);

// 渲染参数枚举值的标签（如 thinking 的 false/true 显示为 "关 / 开"）
const renderParamValue = (v: { value: string; displayName?: string }): string => {
  if (isIconToken(v.displayName)) {
    if (v.value === "true") return "开";
    if (v.value === "false") return "关";
    return v.value;
  }
  return v.displayName as string;
};

// 选 base 模型时给个合理的初始 params：优先取 variants 里 isDefault 那个的 params
const defaultParamsFor = (
  m: ModelOption | undefined
): ModelSelection["params"] => {
  if (!m?.variants || m.variants.length === 0) return undefined;
  const def = m.variants.find((v) => v.isDefault) ?? m.variants[0];
  return def.params.length > 0 ? def.params : undefined;
};

interface ModelCardProps {
  models: ModelOption[];
  modelsError: string;
  selection: ModelSelection;
  onChange: (next: ModelSelection) => void;
  dirty: boolean;
  onSave: () => void;
  // 用于「获取列表」按钮：直接传 apiKey 给 fetchModels、不强制用户先去 ApiKeyCard 点验证
  apiKey: string;
  refreshing: boolean;
  onRefresh: (apiKey: string) => void;
}

export const ModelCard = ({
  models,
  modelsError,
  selection,
  onChange,
  dirty,
  onSave,
  apiKey,
  refreshing,
  onRefresh,
}: ModelCardProps) => {
  // 当前选中的 base model 完整定义（用 id 反查），用 useMemo 避免每次 render 重算
  const selectedModel = useMemo(
    () => models.find((m) => m.id === selection.id),
    [models, selection.id]
  );

  // 切换 base model：清掉旧 params、用新 model 的 default variant 填初始 params
  const onPickModel = (id: string) => {
    const m = models.find((x) => x.id === id);
    onChange({ id, params: defaultParamsFor(m) });
  };

  // 改单个参数：在现有 params 数组里替换或追加该 paramId
  const onPickParam = (paramId: string, value: string) => {
    const old = selection.params ?? [];
    const exists = old.some((p) => p.id === paramId);
    const next = exists
      ? old.map((p) => (p.id === paramId ? { ...p, value } : p))
      : [...old, { id: paramId, value }];
    onChange({ id: selection.id, params: next });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>默认模型</CardTitle>
        <CardDescription>
          {models.length === 0
            ? "点右侧「获取列表」按钮拉取可用模型（需先保存 API key）"
            : `共 ${models.length} 个可用模型`}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {/* 直接基于已保存的 apiKey 拉模型、和 ApiKeyCard 的「验证」按钮共用同一份 fetchModels */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onRefresh(apiKey)}
            disabled={refreshing || !apiKey.trim()}
            title={apiKey.trim() ? "重新拉取可用模型列表" : "请先填 API key"}
          >
            {refreshing ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            获取列表
          </Button>
          <SaveButton dirty={dirty} onSave={onSave} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {modelsError && (
          <div className="text-destructive text-xs">{modelsError}</div>
        )}

        {/* 一级：选 base model */}
        <Select
          value={selection.id || undefined}
          onValueChange={(v) => v && onPickModel(v)}
          disabled={models.length === 0}
        >
          <SelectTrigger className="w-full">
            <SelectValue
              placeholder={models.length === 0 ? "（暂无可选）" : "请选择模型"}
            />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="flex flex-col">
                  <span>{m.displayName}</span>
                  <span className="text-xs text-muted-foreground font-mono">
                    {m.id}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 二级：当前 base model 的可调参数（thinking / effort / context / fast 等）
            没有参数的模型（如 Auto / Composer 1.5）自然不显示 */}
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
                    value={current}
                    onValueChange={(v) => v && onPickParam(p.id, v)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {p.values.map((v) => (
                        <SelectItem key={v.value} value={v.value}>
                          {renderParamValue(v)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
