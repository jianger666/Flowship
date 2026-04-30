"use client";

/**
 * 卡片头部右上角的保存按钮（4 张 settings Card 共用）
 *
 * 状态语义：
 * - dirty=false：当前字段未改、按钮 outline 灰色 + disabled、tooltip "无变更"
 * - disabled=true（来自校验失败）：高优先级、按钮也 disabled、tooltip "请先修复错误"
 * - dirty=true && !disabled：高亮可点
 */

import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SaveButtonProps {
  dirty: boolean;
  disabled?: boolean;
  onSave: () => void;
}

export const SaveButton = ({ dirty, disabled, onSave }: SaveButtonProps) => {
  const canClick = dirty && !disabled;
  return (
    <Button
      type="button"
      size="sm"
      variant={canClick ? "default" : "outline"}
      onClick={onSave}
      disabled={!canClick}
      title={!dirty ? "无变更" : disabled ? "请先修复错误" : "保存"}
    >
      <Check />
      保存
    </Button>
  );
};
