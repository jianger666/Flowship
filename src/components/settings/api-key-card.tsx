"use client";

/**
 * Cursor API Key 配置节（v1.0.x 设置整合：Card 壳退役、作为「连接」卡的一节）
 * - 默认密码框、可一键切换明文（防截图泄漏）
 * - 输入太短（< 10）时不脱敏、避免出现首尾重叠的奇怪展示（如 crsr_t...test）
 * - 「验证」按钮触发模型列表拉取（由父组件传入）、显示 spinner
 */

import { Eye, EyeOff, Loader2, RefreshCw, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/ui/setting-row";

import { useState } from "react";

import type { ApiKeyInfo } from "@/lib/types";

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

interface ApiKeySectionProps {
  apiKey: string;
  // 验证通过后的 API Key 归属信息（Cursor.me）、null = 未验证 / 团队 key
  info: ApiKeyInfo | null;
  // 输入时改草稿、失焦（onBlur）落盘
  onChange: (next: string) => void;
  onCommit: (value: string) => void;
  onValidate: (apiKey: string) => void;
  validating: boolean;
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
  onValidate,
  validating,
}: ApiKeySectionProps) => {
  // 是否明文显示 API Key（默认隐藏、防截图）
  const [showKey, setShowKey] = useState(false);

  const masked = !showKey && apiKey ? maskKey(apiKey) : "";
  const name = info ? fullName(info) : "";

  return (
    <SettingRow
      stacked
      // 连接卡 space-y + Separator 分节、去掉自带 py 防双倍间距（同 GitLabSection）
      className="py-0"
      label="Cursor API Key"
      hint="从 cursor.com/dashboard/integrations 创建、以 crsr_ 开头"
      control={
        <div className="space-y-2">
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
