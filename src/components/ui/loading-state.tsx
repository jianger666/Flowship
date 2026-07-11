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
  /**
   * hero 专用：跳过 200ms 延迟出场、立即可见。
   * 启动链（首页 gate → 看板拉取）连续两段 loading 都带延迟会「亮-灭-亮」闪几下
   *（用户实测）——必然要等的场景用 immediate、只有「大概率秒开」的路径保留延迟防闪现。
   * 注意只在启动窗口内生效（见 APP_BOOT_TS）。
   */
  immediate?: boolean;
}

// 页面 JS 启动时刻：immediate 只在启动后的短窗口内生效——启动链（splash 接力）必须
// 立即可见防白屏；之后的应用内切换（胶囊来回等）常常秒开、loading 闪一下就没很突兀
//（用户点名「加个 delay、小于阈值就不展示」）——统一回 hero-appear 延迟出场
const APP_BOOT_TS = Date.now();
const BOOT_WINDOW_MS = 10_000;

const HeroLoading = ({
  label,
  className,
  immediate,
}: {
  label: string;
  className?: string;
  immediate?: boolean;
}) => {
  // 出场是否延迟（200ms 内秒开就完全不显示、阈值用户拍板）：非 immediate、或已过启动窗口
  const delayed = !immediate || Date.now() - APP_BOOT_TS > BOOT_WINDOW_MS;
  return (
    <div
      className={cn(
        "flex h-full min-h-[60vh] flex-col items-center justify-center gap-4",
        // 延迟 250ms 出场（globals.css hero-appear）：秒开路径整个 loading 不闪现（用户实测）
        delayed && "hero-appear",
        className,
      )}
      role="status"
      aria-label={label}
    >
      <BrandMark size={64} animated />
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  );
};

export const LoadingState = ({
  variant = "block",
  label = "加载中…",
  className,
  immediate,
}: LoadingStateProps) => {
  if (variant === "hero") {
    return <HeroLoading label={label} className={className} immediate={immediate} />;
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
