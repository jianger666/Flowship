"use client";

import { TriangleAlert } from "lucide-react";

import { useLowDisk } from "@/hooks/use-low-disk";
import { describeLowDisk, type DiskReading } from "@/lib/low-disk";
import { cn } from "@/lib/utils";

interface BarProps {
  /** 当前读数；不是「严重」（critical）时不画 */
  reading: DiskReading | null;
  className?: string;
}

/**
 * 低磁盘预警红条（R14 B2-4c / Q15-10）：数据目录所在盘剩余 < 500MB 时常驻在事件流顶部。
 *
 * 和存储降级红条（StorageDegradedBar）同款外观、同款文字层级，但语义不同：那条是「已经写失败、新内容没落盘」，
 * 这条是「快写不下了」——所以文案说「随时可能保存不了」，不说「没能保存」。
 * 壳侧另有系统通知（< 2GB 偏低、< 500MB 严重），通知会被关 / 被勿扰吞掉，这条不依赖它。
 * 文案见 describeLowDisk；补充说明靠 11px 字号退一档（ui-conventions：文字不叠 /40~/80 的 alpha），颜色继承外层 text-destructive。
 */
export const LowDiskBar = ({ reading, className }: BarProps) => {
  const copy = describeLowDisk(reading);
  if (!copy) return null;
  return (
    <div
      role="alert"
      className={cn(
        "flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive",
        className,
      )}
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium">{copy.title}</p>
        <p className="mt-0.5 text-[11px]">{copy.detail}</p>
      </div>
    </div>
  );
};

interface BannerProps {
  /**
   * 已经有「存储降级」红条（真的写失败了）时为 true：那条更紧急、已经把磁盘问题说清了，
   * 这条就不画，免得两条红的说同一件事。轮询照常（成本可忽略），降级解除后读数现成可用。
   */
  suppressed?: boolean;
}

/**
 * 自己取读数并决定画不画的容器——`EventStream` 只需要放一行 `<LowDiskBanner suppressed={…} />`。
 * 读数状态收在这个小组件里：每 5 分钟的状态变化只重渲染它自己，不牵动几百条事件的 EventStream 子树。
 */
export const LowDiskBanner = ({ suppressed = false }: BannerProps) => {
  const reading = useLowDisk();
  if (suppressed) return null;
  return <LowDiskBar reading={reading} />;
};
