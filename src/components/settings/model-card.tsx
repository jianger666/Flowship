"use client";

/**
 * 默认模型卡片
 *
 * 包了一层 Card + SaveButton + 「获取列表」按钮的 ModelPicker
 * 实际「选 base + 选 params」UI 已经下沉到 `src/components/ui/model-picker.tsx`、给 advance-dialog 共享
 */

import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ModelPicker } from "@/components/ui/model-picker";

import type { ModelOption, ModelSelection } from "@/lib/types";

interface ModelCardProps {
  models: ModelOption[];
  modelsError: string;
  selection: ModelSelection;
  // 选择即存
  onChange: (next: ModelSelection) => void;
  apiKey: string;
  refreshing: boolean;
  onRefresh: (apiKey: string) => void;
}

export const ModelCard = ({
  models,
  modelsError,
  selection,
  onChange,
  apiKey,
  refreshing,
  onRefresh,
}: ModelCardProps) => (
  <Card>
    <CardHeader>
      <CardTitle>默认模型</CardTitle>
      <CardDescription>
        {models.length === 0
          ? "点右侧「获取列表」按钮拉取可用模型（需先填好 API key）"
          : `共 ${models.length} 个可用模型`}
      </CardDescription>
      <CardAction className="flex items-center gap-2">
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
      </CardAction>
    </CardHeader>
    <CardContent className="space-y-3">
      {modelsError && (
        <div className="text-destructive text-xs">{modelsError}</div>
      )}
      <ModelPicker
        models={models}
        selection={selection}
        onChange={onChange}
        variant="full"
      />
    </CardContent>
  </Card>
);
