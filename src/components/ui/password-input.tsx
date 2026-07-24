"use client";

/**
 * 密码输入 + 小眼睛切换明文（与设置页 Cursor API Key 同款交互）
 * 环境配置多处密码框复用，避免每处手拷 Eye/EyeOff state。
 */

import { Eye, EyeOff } from "lucide-react";
import { useState, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type PasswordInputProps = Omit<ComponentProps<typeof Input>, "type"> & {
  /** 外层 flex 容器 class（默认 gap-2） */
  wrapperClassName?: string;
};

export const PasswordInput = ({
  className,
  wrapperClassName,
  ...props
}: PasswordInputProps) => {
  // 是否明文显示（默认掩码、防截图）
  const [show, setShow] = useState(false);

  return (
    <div className={cn("flex gap-2", wrapperClassName)}>
      <Input
        {...props}
        type={show ? "text" : "password"}
        className={cn("min-w-0 flex-1", className)}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-8 shrink-0"
        onClick={() => setShow((s) => !s)}
        title={show ? "隐藏" : "显示"}
        tabIndex={-1}
      >
        {show ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
};
