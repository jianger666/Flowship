"use client";

/**
 * 角色选择 chip 组（典型 UI 组件、单一视觉来源）
 *
 * 当前用在设置页偏好「我的角色」行（首页就绪清单已改全引导、不内嵌控件）；
 * 后续任何角色点选场景都用本组件、不要再拼 Select / 散装 chip。
 */

import { ChoiceButton } from "@/components/ui/choice-button";
import {
  USER_ROLE_LABEL,
  USER_ROLES,
  type UserRole,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface RolePickerProps {
  /** 当前角色；未选时无 chip 高亮 */
  value: UserRole | undefined;
  /** 点选即回调（受控；落盘由调用方负责） */
  onChange: (role: UserRole) => void;
  className?: string;
  disabled?: boolean;
}

export const RolePicker = ({
  value,
  onChange,
  className,
  disabled,
}: RolePickerProps) => (
  <div className={cn("flex flex-wrap gap-1.5", className)}>
    {USER_ROLES.map((id) => (
      <ChoiceButton
        key={id}
        shape="chip"
        selected={value === id}
        onClick={() => onChange(id)}
        disabled={disabled}
      >
        {USER_ROLE_LABEL[id]}
      </ChoiceButton>
    ))}
  </div>
);
