import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 统一的「空态提示」
 *
 * 抽出来的动机：项目里至少 5 处用 `border border-dashed ... text-muted-foreground`
 * 写空态、间距 / 圆角 / 文案对齐方式各不相同。统一一下避免视觉漂移。
 *
 * variant：
 * - dashed：虚线边框（次级容器、提示「这里可以加东西」、用得最多）
 * - solid：实线边框（更正式、稀少场景）
 *
 * size：
 * - sm：紧凑（行内 / 弹窗内嵌、px-3 py-3）
 * - md：默认（面板 / 卡片内、px-3 py-4）
 * - lg：撑开（首页空列表、py-12）
 */

interface EmptyHintProps {
  variant?: "dashed" | "solid";
  size?: "sm" | "md" | "lg";
  align?: "left" | "center";
  // 整段提示文本、可以是 string 或者带 strong / link 的 ReactNode
  children: ReactNode;
  // 顶部图标（首页空列表那种 Sparkles）、可选
  icon?: ReactNode;
  className?: string;
}

export const EmptyHint = ({
  variant = "dashed",
  size = "md",
  align = "left",
  children,
  icon,
  className,
}: EmptyHintProps) => {
  return (
    <div
      className={cn(
        "rounded-md text-xs text-muted-foreground",
        variant === "dashed" && "border border-dashed",
        variant === "solid" && "border",
        size === "sm" && "px-3 py-3",
        size === "md" && "px-3 py-4",
        size === "lg" && "p-6 py-12",
        align === "center" && "text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-2 flex justify-center">
          {icon}
        </div>
      )}
      {children}
    </div>
  );
};
