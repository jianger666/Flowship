import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

/**
 * 统一的「加载中」展示
 *
 * 抽出来的动机：app/page / settings/page / tasks/[id]/page 三处加载文案
 * 风格不一致（Card vs 裸 div、「...」vs「…」）。
 *
 * variant：
 * - hero：页面级通用 loading（v1.0.x 用户点名「通用的好看的全局 loading」）——
 *   双弧环（主题色渐变弧快转 + 细弧反向慢转）+ 中心柔光呼吸；
 *   纯 CSS 动画（globals.css hero-*）、reduced-motion 自动降级静态环
 * - block：屏幕中部一段灰色文本（不适合动画的小场景用）
 * - card：用 Card 包裹（列表 loading 用、跟其他卡片视觉对齐）
 * - inline：行内一小段灰色文本（按钮旁、面板里小区块用）
 *
 * 文案统一用「加载中…」（中文省略号、视觉上比「...」更内敛）。
 * 调用方可通过 `label` 覆盖文案（如「正在拉取飞书排期…」）。
 */

interface LoadingStateProps {
  variant?: "hero" | "block" | "card" | "inline";
  label?: string;
  className?: string;
}

const HeroLoading = ({ label, className }: { label: string; className?: string }) => (
  <div
    className={cn(
      "flex h-full min-h-[60vh] flex-col items-center justify-center gap-5",
      className,
    )}
    role="status"
    aria-label={label}
  >
    {/* 双弧环 + 柔光：三层同心、全 CSS 动画 */}
    <div className="relative size-12">
      <div className="hero-loading-glow absolute inset-0 rounded-full" aria-hidden />
      <div className="hero-loading-ring absolute inset-0 rounded-full" aria-hidden />
      <div className="hero-loading-ring-inner absolute inset-[7px] rounded-full" aria-hidden />
    </div>
    <div className="text-sm text-muted-foreground">{label}</div>
  </div>
);

export const LoadingState = ({
  variant = "block",
  label = "加载中…",
  className,
}: LoadingStateProps) => {
  if (variant === "hero") {
    return <HeroLoading label={label} className={className} />;
  }
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
