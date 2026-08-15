"use client";

/**
 * 自定义 provider 配置节（v1.2.x 引入）——「连接」卡里与 Cursor API Key 互斥的一段：
 * - ProviderSection：cursor sdk / 自定义 provider 二选一切换
 * - CustomProviderSection：baseUrl + apiKey + 协议（openai/anthropic）+ 验证
 *
 * 说明：只在 provider === "custom" 时渲染 CustomProviderSection；cursor 时渲染 ApiKeySection。
 */

import { Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { ChoiceButton } from "@/components/ui/choice-button";
import { SettingRow } from "@/components/ui/setting-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useState } from "react";

import {
  AGENT_PROVIDER_LABEL,
  CUSTOM_PROVIDER_FORMAT_LABEL,
  type AgentProviderId,
  type CustomProviderConfig,
  type CustomProviderFormat,
} from "@/lib/types";

// 太短就不要脱敏了、否则 6+4 切片会重叠出现 "sk-xx...test" 这种残影
const MASK_THRESHOLD = 10;

const maskKey = (key: string): string => {
  if (!key) return "";
  if (key.length < MASK_THRESHOLD) return key;
  const head = key.slice(0, 6);
  const tail = key.slice(-4);
  const middle = "•".repeat(Math.max(0, key.length - 10));
  return `${head}${middle}${tail}`;
};

export const emptyCustomProvider = (): CustomProviderConfig => ({
  baseUrl: "",
  apiKey: "",
  format: "openai",
});

export const ProviderSection = ({
  value,
  onChange,
}: {
  value: AgentProviderId;
  onChange: (next: AgentProviderId) => void;
}) => (
  <SettingRow
    stacked
    className="py-0"
    label="Agent 后端"
    hint="自定义 provider = 用你自己的 HTTP API（baseUrl + apiKey）跑 agent、不依赖 Cursor 账号"
    control={
      <div className="flex items-center gap-1.5">
        {(Object.keys(AGENT_PROVIDER_LABEL) as AgentProviderId[]).map((id) => (
          <ChoiceButton
            key={id}
            shape="chip"
            selected={value === id}
            onClick={() => onChange(id)}
            className="text-xs"
          >
            {AGENT_PROVIDER_LABEL[id]}
          </ChoiceButton>
        ))}
      </div>
    }
  />
);

interface CustomProviderSectionProps {
  value: CustomProviderConfig;
  onChange: (next: CustomProviderConfig) => void;
  onCommit: (value: CustomProviderConfig) => void;
  onValidate: (value: CustomProviderConfig) => void;
  validating: boolean;
}

export const CustomProviderSection = ({
  value,
  onChange,
  onCommit,
  onValidate,
  validating,
}: CustomProviderSectionProps) => {
  const [showKey, setShowKey] = useState(false);
  const masked = !showKey && value.apiKey ? maskKey(value.apiKey) : "";

  const setField = <K extends keyof CustomProviderConfig>(
    key: K,
    v: CustomProviderConfig[K],
  ) => onChange({ ...value, [key]: v });

  return (
    <SettingRow
      stacked
      className="py-0"
      label="自定义 Provider"
      hint="baseUrl 填 HTTP API 根地址（可带 /v1）；模型列表走 /v1/models、拉不到可手填 model id"
      control={
        <div className="space-y-2">
          <Input
            type="text"
            value={value.baseUrl}
            onChange={(e) => setField("baseUrl", e.target.value)}
            onBlur={() => onCommit(value)}
            placeholder="https://api.deepseek.com 或 https://api.anthropic.com"
            className="font-mono"
          />
          <div className="flex gap-2">
            <Input
              type={showKey ? "text" : "password"}
              value={value.apiKey}
              onChange={(e) => setField("apiKey", e.target.value)}
              onBlur={() => onCommit(value)}
              placeholder="sk-...（本地无鉴权端点可留空）"
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
          <div className="flex items-center gap-2">
            <Select
              value={value.format}
              onValueChange={(v) =>
                setField(
                  "format",
                  v === "anthropic" ? "anthropic" : "openai",
                )
              }
            >
              <SelectTrigger className="w-44">
                <SelectValue>
                  {CUSTOM_PROVIDER_FORMAT_LABEL[value.format]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CUSTOM_PROVIDER_FORMAT_LABEL) as CustomProviderFormat[]).map(
                  (id) => (
                    <SelectItem key={id} value={id}>
                      {CUSTOM_PROVIDER_FORMAT_LABEL[id]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              onClick={() => onValidate(value)}
              disabled={validating || !value.baseUrl.trim()}
            >
              {validating ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              验证
            </Button>
          </div>
          {masked && (
            <div className="text-xs text-muted-foreground font-mono">{masked}</div>
          )}
        </div>
      }
    />
  );
};
