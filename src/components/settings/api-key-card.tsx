"use client";

/**
 * Cursor API Key 配置节 + 共用的「默认模型」行
 * - 默认密码框、可一键切换明文（防截图泄漏）
 * - 输入太短（< 10）时不脱敏、避免出现首尾重叠的奇怪展示（如 crsr_t...test）
 * - 账号信息用灰底信息块贴在 Key 下面（姓名/邮箱一行、密钥名/日期一行）
 */

import { Eye, EyeOff, Loader2, RefreshCw, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { ModelSelect } from "@/components/ui/model-select";
import { SettingRow } from "@/components/ui/setting-row";

import { useState } from "react";

import type { ApiKeyInfo, ModelOption, ModelSelection } from "@/lib/types";

interface ApiKeySectionProps {
  apiKey: string;
  // 验证通过后的 API Key 归属信息（Cursor.me）、null = 未验证 / 团队 key
  info: ApiKeyInfo | null;
  // 输入时改草稿、失焦（onBlur）落盘
  onChange: (next: string) => void;
  onCommit: (value: string) => void;
}

// createdAt 是 ISO 串、展示成「YYYY-MM-DD」即可
const formatCreatedAt = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// 拼用户全名（姓 / 名可能缺、按有的拼）
const fullName = (info: ApiKeyInfo): string =>
  [info.userFirstName, info.userLastName].filter(Boolean).join(" ").trim();

export const ApiKeySection = ({
  apiKey,
  info,
  onChange,
  onCommit,
  className,
}: ApiKeySectionProps & { className?: string }) => {
  // 是否明文显示 API Key（默认隐藏、防截图）
  const [showKey, setShowKey] = useState(false);
  const name = info ? fullName(info) : "";

  return (
    <SettingRow
      stacked
      className={className}
      label="API Key"
      hint="从 cursor.com/dashboard/integrations 创建"
      control={
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <Input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => onChange(e.target.value)}
              onBlur={() => onCommit(apiKey)}
              placeholder="crsr_..."
              className="font-mono"
            />
            <Tooltip content={showKey ? "隐藏" : "显示"}>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setShowKey((s) => !s)}
              >
                {showKey ? <EyeOff /> : <Eye />}
              </Button>
            </Tooltip>
          </div>
          {info && (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <User className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 space-y-0.5">
                {/* 第一行：姓名 + 邮箱（团队 / service key 可能都没有、退回只显示密钥名） */}
                <div className="font-medium">
                  {name || info.userEmail || info.apiKeyName}
                  {name && info.userEmail && (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {info.userEmail}
                    </span>
                  )}
                </div>
                {/* 第二行：密钥名 · 创建时间 */}
                <div className="text-muted-foreground">
                  密钥「{info.apiKeyName}」· 创建于 {formatCreatedAt(info.createdAt)}
                </div>
              </div>
            </div>
          )}
        </div>
      }
    />
  );
};

export const DefaultModelSection = ({
  models,
  modelSelection,
  onModelChange,
  canRefreshModels,
  onModelsRefresh,
  modelsRefreshing,
  modelsError,
  className,
  providerId,
}: {
  models: ModelOption[];
  modelSelection: ModelSelection;
  onModelChange: (next: ModelSelection) => void;
  canRefreshModels: boolean;
  onModelsRefresh: () => void;
  modelsRefreshing: boolean;
  modelsError?: string;
  className?: string;
  providerId?: string;
}) => (
  <SettingRow
    stacked
    className={className}
    label="默认模型"
    labelExtra={
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onModelsRefresh}
        disabled={modelsRefreshing || !canRefreshModels}
      >
        {modelsRefreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        获取列表
      </Button>
    }
    control={
      <div className="space-y-1.5">
        <ModelSelect
          models={models}
          selection={modelSelection}
          onChange={onModelChange}
          variant="full"
          providerId={providerId}
        />
        {modelsError ? (
          <p className="text-xs text-destructive">{modelsError}</p>
        ) : null}
      </div>
    }
  />
);
