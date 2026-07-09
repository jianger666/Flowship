"use client";

/**
 * 用户基本信息卡片（V0.6 新增、V0.6.7 加分支命名模板）
 *
 * V0.6.7 branchTemplate：全局默认 feature 分支命名模板、支持占位符、
 *   per-repo 可在「仓库列表」卡覆盖（如后端用 {date:MM-dd} 段替代 {username} 段）。
 *
 * 设计取舍：
 *   - 文本框走 onChange 改草稿、onBlur 落盘（跟其它设置卡一致、避免每字符写 localStorage）
 *   - 模板预览用示例变量实时渲染、让用户直观看到分支名长啥样
 */

import { useEffect, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { renderBranchName } from "@/lib/branch-template";
import { JUMP_IDES, JUMP_IDE_LABEL, type JumpIde } from "@/lib/types";

interface UserProfileCardProps {
  branchTemplate: string;
  // 代码跳转 IDE（artifact / 事件流里路径链接的打开目标）、选择即保存
  jumpIde: JumpIde;
  onJumpIdeChange: (next: JumpIde) => void;
  // 分支模板：输入改草稿、失焦落盘
  onBranchTemplateChange: (next: string) => void;
  onBranchTemplateCommit: (value: string) => void;
}

export const UserProfileCard = ({
  branchTemplate,
  jumpIde,
  onJumpIdeChange,
  onBranchTemplateChange,
  onBranchTemplateCommit,
}: UserProfileCardProps) => {
  // 本机探测到的可用 IDE 集合（V0.11.8：后端扫安装位置 + PATH、不再写死两个）；
  // null = 探测结果还没回来（全部可选、不置灰）
  const [availableIdes, setAvailableIdes] = useState<Set<JumpIde> | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/system/ide-tools")
      .then((r) => r.json())
      .then((data: { tools?: Array<{ id: JumpIde; available: boolean }> }) => {
        if (!alive || !Array.isArray(data.tools)) return;
        setAvailableIdes(
          new Set(data.tools.filter((t) => t.available).map((t) => t.id)),
        );
      })
      .catch(() => {
        // 探测失败不挡配置、保持全部可选
      });
    return () => {
      alive = false;
    };
  }, []);

  // 模板预览：用一组示例变量渲染当前模板（留空 = 内置兜底）、用户改模板时实时看到效果
  const preview = useMemo(
    () =>
      renderBranchName(branchTemplate, {
        storyId: "6956910305",
        taskTitle: "需求标题",
      }),
    [branchTemplate],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>个人信息</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor="settings-jump-ide">代码跳转 IDE</Label>
          <Select
            value={jumpIde}
            onValueChange={(v) =>
              onJumpIdeChange(
                JUMP_IDES.includes(v as JumpIde) ? (v as JumpIde) : "cursor",
              )
            }
          >
            <SelectTrigger id="settings-jump-ide" className="w-52">
              <SelectValue>{JUMP_IDE_LABEL[jumpIde]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {JUMP_IDES.filter(
                // 只列本机装了的（用户拍板「没有的就不展示」）；当前已选的即使没探到也列
                //（免得下拉里连当前值都找不到）；探测没回来前先全列
                (id) =>
                  availableIdes === null ||
                  availableIdes.has(id) ||
                  id === jumpIde,
              ).map((id) => (
                <SelectItem key={id} value={id}>
                  {JUMP_IDE_LABEL[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="settings-branch-template">默认分支命名模板</Label>
          <Input
            id="settings-branch-template"
            value={branchTemplate}
            onChange={(e) => onBranchTemplateChange(e.target.value)}
            onBlur={() => onBranchTemplateCommit(branchTemplate)}
            placeholder="留空默认 feature/{storyId}-{taskTitle}（想带名字直接写、如 feature/clj/…）"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            占位符 <code className="font-mono">{"{storyId}"}</code>{" "}
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
