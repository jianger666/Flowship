"use client";

/**
 * 默认模型配置节（v1.0.x 设置整合：Card 壳退役、作为「偏好」卡的一节）
 *
 * 「获取列表」按钮 + 统一 ModelSelect；
 * 实际「搜索 base + 选 params」UI 在 `src/components/ui/model-select.tsx`、全站共享
 */

import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ModelSelect } from "@/components/ui/model-select";

import type { ModelOption, ModelSelection } from "@/lib/types";

interface ModelSectionProps {
  models: ModelOption[];
  modelsError: string;
  selection: ModelSelection;
  // 选择即存
  onChange: (next: ModelSelection) => void;
  apiKey: string;
  refreshing: boolean;
  onRefresh: (apiKey: string) => void;
}

export const ModelSection = ({
  models,
  modelsError,
  selection,
  onChange,
  apiKey,
  refreshing,
  onRefresh,
}: ModelSectionProps) => (
  <div className="space-y-3">
    <div className="flex items-center justify-between gap-2">
      {/* 小节头（跟连接卡同款层级） */}
      <div>
        <div className="text-sm font-medium">默认模型</div>
        <p className="text-xs text-muted-foreground">
          {models.length > 0 ? `共 ${models.length} 个可用模型` : "新任务 / 对话的默认 AI"}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onRefresh(apiKey)}
        disabled={refreshing || !apiKey.trim()}
        title={apiKey.trim() ? "重新拉取可用模型列表" : "请先填 API key"}
      >
        {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        获取列表
      </Button>
    </div>
    {modelsError && <div className="text-destructive text-xs">{modelsError}</div>}
    <ModelSelect
      models={models}
      selection={selection}
      onChange={onChange}
      variant="full"
    />
  </div>
);
