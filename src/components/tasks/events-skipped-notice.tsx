"use client";

import { Info } from "lucide-react";

import { describeEventsSkipped } from "@/lib/events-skipped";
import { cn } from "@/lib/utils";

interface Props {
  /** 已加载范围内被跳过的坏行数（>0；0 / 缺省时父组件不渲染本组件） */
  count: number;
  className?: string;
}

/**
 * 「有记录读不出来」灰条（R14 B2-3 / Q9-08）：events.jsonl 里有非空但解析不了的行
 * （崩溃半行 / 断电后的全 0 填充 / 磁盘问题）时，在事件流顶部告诉用户，而不是让那几条悄悄消失。
 *
 * 它是信息提示、不是告警：中性灰底，不用 role="alert"（不打断读屏），也不常驻红色。
 * 与存储降级红条（StorageDegradedBar）同区域时叠在红条下面——红的更紧急，排在上面。
 * 补充说明靠 11px 字号退一档（ui-conventions：文字不叠 /40~/80 的 alpha），颜色继承外层的 text-muted-foreground。
 */
export const EventsSkippedNotice = ({ count, className }: Props) => {
  const { title, detail } = describeEventsSkipped(count);
  return (
    <div
      role="note"
      className={cn(
        "flex shrink-0 items-start gap-2 border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-[11px]">{detail}</p>
      </div>
    </div>
  );
};
