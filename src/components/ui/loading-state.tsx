import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

/**
 * 统一的「加载中」展示
 *
 * 抽出来的动机：app/page / settings/page / tasks/[id]/page 三处加载文案
 * 风格不一致（Card vs 裸 div、「...」vs「…」）。
 *
 * variant：
 * - hero：页面级「迷你甘特骨架」loading（v1.0.x 用户点名「炫酷点、后续都可以使用」）——
 *   几根排期条流光呼吸 + 一根「今天线」左右扫描、属于本产品（首页=排期甘特）的签名装置；
 *   纯 CSS 动画（globals.css hero-*）、reduced-motion 自动降级静态骨架
 * - block：屏幕中部一段灰色文本（不适合骨架的小页面用）
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

// 迷你甘特骨架的条形排布（left / width 百分比 + 錯落延迟）——静态写死、不随机（SSR 稳定）
const HERO_BARS: Array<{ left: string; width: string; delay: string }> = [
  { left: "6%", width: "34%", delay: "0s" },
  { left: "24%", width: "46%", delay: "0.25s" },
  { left: "14%", width: "26%", delay: "0.5s" },
  { left: "42%", width: "38%", delay: "0.75s" },
  { left: "30%", width: "22%", delay: "1s" },
];

const HeroLoading = ({ label, className }: { label: string; className?: string }) => (
  <div
    className={cn(
      "flex h-full min-h-[60vh] flex-col items-center justify-center gap-6",
      className,
    )}
    role="status"
    aria-label={label}
  >
    {/* 迷你甘特：排期条骨架 + 扫描「今天线」 */}
    <div className="relative w-full max-w-sm px-6">
      <div className="flex flex-col gap-3">
        {HERO_BARS.map((b, i) => (
          <div key={i} className="relative h-3">
            <div
              className="hero-loading-bar absolute inset-y-0 rounded-full"
              style={{ left: b.left, width: b.width, animationDelay: b.delay }}
            />
          </div>
        ))}
      </div>
      {/* 今天线：一根主题色细线左右扫描（甘特的身份符号） */}
      <div
        className="hero-loading-sweep pointer-events-none absolute -top-2 bottom-0 w-px bg-primary/60"
        aria-hidden
      >
        <span className="absolute -top-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-primary/80" />
      </div>
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
