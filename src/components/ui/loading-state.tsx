import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/ui/brand-mark";
import { Card, CardContent } from "@/components/ui/card";

/**
 * 统一的「加载中」展示
 *
 * 抽出来的动机：app/page / settings/page / tasks/[id]/page 三处加载文案
 * 风格不一致（Card vs 裸 div、「...」vs「…」）。
 *
 * variant：
 * - hero：页面级 loading = 品牌 logo「雷芯」通电形态（v1.0.x logo 重设计、
 *   用户拍板「loading 和 logo 同一图形」）——电流沿闪电轮廓环流 + 光晕呼吸；
 *   动画 CSS 见 globals.css brand-*、reduced-motion 自动降级静态 logo
 * - block：屏幕中部一段灰色文本（不适合动画的小场景用）
 * - card：用 Card 包裹（列表 loading 用、跟其他卡片视觉对齐）
 * - inline：行内一小段灰色文本（按钮旁、面板里小区块用）
 *
 * 文案统一用「加载中…」（中文省略号、视觉上比「...」更内敛）。
 */

interface LoadingStateProps {
  variant?: "hero" | "block" | "card" | "inline";
  label?: string;
  className?: string;
}

const HeroLoading = ({ label, className }: { label: string; className?: string }) => (
  <div
    className={cn(
      "flex h-full min-h-[60vh] flex-col items-center justify-center gap-4",
      // 延迟 250ms 出场（globals.css hero-appear）：秒开路径整个 loading 不闪现（用户实测）
      "hero-appear",
      className,
    )}
    role="status"
    aria-label={label}
  >
    <BrandMark size={52} animated />
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
