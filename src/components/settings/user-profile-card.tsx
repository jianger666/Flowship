"use client";

/**
 * 用户基本信息卡片（V0.6 新增）
 *
 * V0.6 加 username：
 *   - 用于 ship action 拼 branch 前缀：`feature/<username>/<feishu-id>-<task.title>`
 *   - 多人共用 fe-ai-flow 时、branch 不互踩
 *   - 不填的话 ship action 准入条件会拒（V0.6.1 上线 ship 时强校验）
 *
 * 设计取舍：
 *   - 不限制字符（数字 / 英文 / 拼音 缩写都行）、agent 写 branch 时再做防御性处理
 *   - 长度建议 ≤ 20、UI 只 placeholder 提示、不硬校验
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

interface UserProfileCardProps {
  username: string;
  onChange: (next: string) => void;
  dirty: boolean;
  onSave: () => void;
}

export const UserProfileCard = ({
  username,
  onChange,
  dirty,
  onSave,
}: UserProfileCardProps) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>个人信息</CardTitle>
        <CardDescription>用户名用于拼 git branch 前缀</CardDescription>
        <CardAction>
          <SaveButton dirty={dirty} onSave={onSave} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor="settings-username">用户名 / 缩写</Label>
          <Input
            id="settings-username"
            value={username}
            onChange={(e) => onChange(e.target.value)}
            placeholder="如 clj"
          />
          <p className="text-xs text-muted-foreground">
            branch 模板 ={" "}
            <code className="font-mono">
              feature/{username || "<username>"}/&lt;id&gt;-&lt;任务名&gt;
            </code>
          </p>
        </div>
      </CardContent>
    </Card>
  );
};
