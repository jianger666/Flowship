"use client";

/**
 * GitLab 配置卡片（V0.6.1 新增、ship action 用）
 *
 * 设计取舍（V0.6.1 拍板）：
 * - server 内置 GitLab REST API、不依赖 glab CLI / 不引入外部 MCP server
 * - 公司内部场景所有仓共用同一个 GitLab 实例、所以是全局字段（不是 per-repo）
 * - PAT 明文 localStorage、跟 apiKey 同安全级别——别在共用机器配
 * - host 不带协议前缀、agent 端拼 `https://<host>` 调 API
 */

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { SaveButton } from "./save-button";

interface GitCardProps {
  gitHost: string;
  gitToken: string;
  onHostChange: (next: string) => void;
  onTokenChange: (next: string) => void;
  hostDirty: boolean;
  tokenDirty: boolean;
  onSaveHost: () => void;
  onSaveToken: () => void;
}

export const GitCard = ({
  gitHost,
  gitToken,
  onHostChange,
  onTokenChange,
  hostDirty,
  tokenDirty,
  onSaveHost,
  onSaveToken,
}: GitCardProps) => {
  // 卡片整体 dirty = 任意字段 dirty
  const cardDirty = hostDirty || tokenDirty;

  // 卡片级保存：哪个字段 dirty 就保存哪个；都 dirty 就一起保存
  const onSaveAll = () => {
    if (hostDirty) onSaveHost();
    if (tokenDirty) onSaveToken();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitLab 配置</CardTitle>
        <CardDescription>提测时走 REST API 创建 MR（目标分支固定 test）、不依赖 glab CLI</CardDescription>
        <CardAction>
          <SaveButton dirty={cardDirty} onSave={onSaveAll} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor="settings-git-host">GitLab Host</Label>
          <Input
            id="settings-git-host"
            value={gitHost}
            onChange={(e) => onHostChange(e.target.value)}
            placeholder="如 gitlab.wukongedu.net（不带 https://）"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="settings-git-token">Personal Access Token</Label>
          <Input
            id="settings-git-token"
            type="password"
            value={gitToken}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder="glpat-xxx（需要 api scope）"
          />
          <p className="text-xs text-muted-foreground">
            明文 localStorage、跟 API key 同安全级别、共用机器别配
          </p>
        </div>
      </CardContent>
    </Card>
  );
};
