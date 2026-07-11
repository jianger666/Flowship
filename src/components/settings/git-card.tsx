"use client";

/**
 * GitLab 配置节（v1.0.x 设置整合：Card 壳退役、作为「连接」卡的一节）
 *
 * 只剩 Token 一个输入（用户拍板「host 输入框直接去掉」）：
 * GitLab Host 运行时自动从任务仓库的 origin remote 推导（resolveEffectiveGitHost）、
 * 不再需要用户填；settings.gitHost 字段保留（老配置的值继续当可选覆盖、无 UI）。
 */

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/ui/setting-row";

interface GitLabSectionProps {
  gitToken: string;
  onTokenChange: (next: string) => void;
  onTokenCommit: (value: string) => void;
}

export const GitLabSection = ({
  gitToken,
  onTokenChange,
  onTokenCommit,
}: GitLabSectionProps) => {
  // 是否明文显示 PAT（默认隐藏、防截图泄漏）
  const [showToken, setShowToken] = useState(false);

  return (
    <SettingRow
      stacked
      label="GitLab Token"
      control={
        <div className="flex gap-2">
          <Input
            type={showToken ? "text" : "password"}
            value={gitToken}
            onChange={(e) => onTokenChange(e.target.value)}
            onBlur={() => onTokenCommit(gitToken)}
            placeholder="glpat-..."
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setShowToken((s) => !s)}
            title={showToken ? "隐藏" : "显示"}
          >
            {showToken ? <EyeOff /> : <Eye />}
          </Button>
        </div>
      }
    />
  );
};
