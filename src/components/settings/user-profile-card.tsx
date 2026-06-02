"use client";

/**
 * 用户基本信息卡片（V0.6 新增、V0.6.7 加分支命名模板）
 *
 * V0.6 username：用于拼 feature 分支前缀、多人共用 fe-ai-flow 不互踩。
 * V0.6.7 branchTemplate：全局默认 feature 分支命名模板、支持占位符、
 *   per-repo 可在「仓库列表」卡覆盖（如后端用 {date:MM-dd} 段替代 {username} 段）。
 *
 * 设计取舍：
 *   - 文本框走 onChange 改草稿、onBlur 落盘（跟其它设置卡一致、避免每字符写 localStorage）
 *   - 模板预览用示例变量实时渲染、让用户直观看到分支名长啥样
 */

import { useMemo } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { renderBranchName } from "@/lib/branch-template";

interface UserProfileCardProps {
  username: string;
  branchTemplate: string;
  // 用户名：输入改草稿、失焦落盘
  onChange: (next: string) => void;
  onCommit: (value: string) => void;
  // 分支模板：输入改草稿、失焦落盘
  onBranchTemplateChange: (next: string) => void;
  onBranchTemplateCommit: (value: string) => void;
}

export const UserProfileCard = ({
  username,
  branchTemplate,
  onChange,
  onCommit,
  onBranchTemplateChange,
  onBranchTemplateCommit,
}: UserProfileCardProps) => {
  // 模板预览：用一组示例变量渲染当前模板、用户改模板时实时看到效果
  const preview = useMemo(
    () =>
      renderBranchName(branchTemplate, {
        username: username || "clj",
        storyId: "6956910305",
        taskTitle: "需求标题",
      }),
    [branchTemplate, username],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>个人信息</CardTitle>
        <CardDescription>
          用户名 + feature 分支命名模板（建任务时按此生成分支名）
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor="settings-username">用户名 / 缩写</Label>
          <Input
            id="settings-username"
            value={username}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => onCommit(username)}
            placeholder="如 clj"
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="settings-branch-template">默认分支命名模板</Label>
          <Input
            id="settings-branch-template"
            value={branchTemplate}
            onChange={(e) => onBranchTemplateChange(e.target.value)}
            onBlur={() => onBranchTemplateCommit(branchTemplate)}
            placeholder="feature/{username}/{storyId}-{taskTitle}"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            占位符 <code className="font-mono">{"{username}"}</code>{" "}
            <code className="font-mono">{"{storyId}"}</code>{" "}
            <code className="font-mono">{"{taskTitle}"}</code>{" "}
            <code className="font-mono">{"{date:MM-dd}"}</code>；可在仓库列表为单仓覆盖
          </p>
          <p className="text-xs text-muted-foreground">
            预览：
            <code className="font-mono text-foreground/80">{preview}</code>
          </p>
        </div>
      </CardContent>
    </Card>
  );
};
