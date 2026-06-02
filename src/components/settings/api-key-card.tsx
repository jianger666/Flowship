"use client";

/**
 * API Key 卡片
 * - 默认密码框、可一键切换明文（防截图泄漏）
 * - 输入太短（< 10）时不脱敏、避免出现首尾重叠的奇怪展示（如 crsr_t...test）
 * - 「验证」按钮触发模型列表拉取（由父组件传入）、显示 spinner
 */

import { Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { useState } from "react";

// 太短就不要脱敏了、否则 6+4 切片会重叠出现 "crsr_t...test" 这种残影
const MASK_THRESHOLD = 10;

const maskKey = (key: string): string => {
  if (!key) return "";
  if (key.length < MASK_THRESHOLD) return key;
  const head = key.slice(0, 6);
  const tail = key.slice(-4);
  const middle = "•".repeat(Math.max(0, key.length - 10));
  return `${head}${middle}${tail}`;
};

interface ApiKeyCardProps {
  apiKey: string;
  // 输入时改草稿、失焦（onBlur）落盘
  onChange: (next: string) => void;
  onCommit: (value: string) => void;
  onValidate: (apiKey: string) => void;
  validating: boolean;
}

export const ApiKeyCard = ({
  apiKey,
  onChange,
  onCommit,
  onValidate,
  validating,
}: ApiKeyCardProps) => {
  // 是否明文显示 API Key（默认隐藏、防截图）
  const [showKey, setShowKey] = useState(false);

  const masked = !showKey && apiKey ? maskKey(apiKey) : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cursor API Key</CardTitle>
        <CardDescription>
          从 cursor.com/dashboard/integrations 创建、以 crsr_ 开头
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-2">
          <Input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => onCommit(apiKey)}
            placeholder="crsr_..."
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setShowKey((s) => !s)}
            title={showKey ? "隐藏" : "显示"}
          >
            {showKey ? <EyeOff /> : <Eye />}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onValidate(apiKey)}
            disabled={validating || !apiKey.trim()}
          >
            {validating ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            验证
          </Button>
        </div>
        {masked && (
          <div className="text-xs text-muted-foreground font-mono">{masked}</div>
        )}
      </CardContent>
    </Card>
  );
};
