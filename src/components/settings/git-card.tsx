"use client";

/**
 * GitLab 配置卡片（V0.6.1 新增、ship action 用）
 *
 * host 可留空：从 settings 仓库列表的 origin remote 自动推导；token 仍必填。
 */

import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import type { RepoConfig } from "@/lib/types";
import { cn } from "@/lib/utils";

interface GitCardProps {
  gitHost: string;
  gitToken: string;
  repos: RepoConfig[];
  onHostChange: (next: string) => void;
  onTokenChange: (next: string) => void;
  onHostCommit: (value: string) => void;
  onTokenCommit: (value: string) => void;
}

export const GitCard = ({
  gitHost,
  gitToken,
  repos,
  onHostChange,
  onTokenChange,
  onHostCommit,
  onTokenCommit,
}: GitCardProps) => {
  // 是否明文显示 PAT（默认隐藏、防截图泄漏）
  const [showToken, setShowToken] = useState(false);
  // 从仓库 remote 自动检测到的 host（settings 留空时展示）
  const [detectedHost, setDetectedHost] = useState<string | null>(null);
  // 检测请求中（防连点）
  const [detecting, setDetecting] = useState(false);

  const detectFromRepos = async (paths: string[]): Promise<string | null> => {
    if (paths.length === 0) {
      setDetectedHost(null);
      return null;
    }
    setDetecting(true);
    try {
      const q = encodeURIComponent(paths.join(","));
      const res = await fetch(`/api/repo-remote-meta?paths=${q}`);
      const data = (await res.json()) as { host?: string | null };
      const host = data.host?.trim() || null;
      setDetectedHost(host);
      return host;
    } catch {
      setDetectedHost(null);
      return null;
    } finally {
      setDetecting(false);
    }
  };

  // 有仓库且 host 留空时自动检测一次
  useEffect(() => {
    if (gitHost.trim()) {
      setDetectedHost(null);
      return;
    }
    void detectFromRepos(repos.map((r) => r.path).filter(Boolean));
  }, [gitHost, repos]);

  const handleDetectClick = async () => {
    const paths = repos.map((r) => r.path).filter(Boolean);
    if (paths.length === 0) {
      toast.error("请先在仓库列表添加仓库");
      return;
    }
    const host = await detectFromRepos(paths);
    if (!host) {
      toast.error("未从 remote 检测到 GitLab host");
      return;
    }
    onHostChange(host);
    onHostCommit(host);
    toast.success(`已填入 ${host}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitLab 配置</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="settings-git-host">GitLab Host</Label>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={detecting || repos.length === 0}
              onClick={() => void handleDetectClick()}
            >
              <RefreshCw className={cn(detecting && "animate-spin")} />
              从仓库检测
            </Button>
          </div>
          <Input
            id="settings-git-host"
            value={gitHost}
            onChange={(e) => onHostChange(e.target.value)}
            onBlur={() => onHostCommit(gitHost)}
            placeholder="留空则从仓库 remote 自动检测"
          />
          {!gitHost.trim() && detectedHost && (
            <p className="text-xs text-muted-foreground">
              已从 remote 检测：{detectedHost}
            </p>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="settings-git-token">Personal Access Token</Label>
          <div className="flex gap-2">
            <Input
              id="settings-git-token"
              type={showToken ? "text" : "password"}
              value={gitToken}
              onChange={(e) => onTokenChange(e.target.value)}
              onBlur={() => onTokenCommit(gitToken)}
              placeholder="glpat-xxx（需要 api scope）"
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
        </div>
      </CardContent>
    </Card>
  );
};
