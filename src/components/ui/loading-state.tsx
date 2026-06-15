import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

/**
 * 统一的「加载中」展示
 *
 * 抽出来的动机：app/page / settings/page / tasks/[id]/page 三处加载文案
 * 风格不一致（Card vs 裸 div、「...」vs「…」）。
 *
 * variant：
 * - block：屏幕中部一段灰色文本（页面级 loading 用）
 * - card：用 Card 包裹（首页列表 loading 用、跟其他卡片视觉对齐）
 * - inline：行内一小段灰色文本（按钮旁、面板里小区块用）
 *
 * 文案统一用「加载中…」（中文省略号、视觉上比「...」更内敛）。
 * 调用方可通过 `label` 覆盖文案（如「拉模型中…」）。
 */

interface LoadingStateProps {
  variant?: "block" | "card" | "inline";
  label?: string;
  className?: string;
}

export const LoadingState = ({
  variant = "block",
  label = "加载中…",
  className,
}: LoadingStateProps) => {
  if (variant === "card") {
    return (
      <Card className={className}>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          {label}
        </CardContent>
      </Card>
    );
  }
  if (variant === "inline") {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        {label}
      </span>
    );
  }
  return (
    <div
      className={cn(
        // h-full 填满父容器（外壳 main 已是「视口 - 顶栏」定高）、不再写死 calc
        "flex h-full min-h-[60vh] items-center justify-center text-sm text-muted-foreground",
        className,
      )}
    >
      {label}
    </div>
  );
};
