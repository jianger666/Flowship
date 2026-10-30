"use client";

import { TriangleAlert } from "lucide-react";

import {
  describeStorageDegraded,
  type StorageDegradedState,
} from "@/lib/storage-degraded";
import { cn } from "@/lib/utils";

interface Props {
  /** 降级状态（服务端 `storage_degraded` 帧；没降级时父组件不渲染本组件） */
  state: StorageDegradedState;
  className?: string;
}

/**
 * 存储降级红条（R14 B2-2 / Q9-01 = Q15-02）：事件写盘失败（磁盘满 / 数据目录只读 / IO 错误）期间
 * 常驻在事件流顶部，直到服务端确认写盘恢复后自己消失。
 *
 * 为什么要常驻而不是只弹一次 toast：这段时间 AI 的新输出只显示在当前页面、没有落盘，刷新或重启就没了——
 * 用户必须一直知道这件事，才会去腾磁盘空间 / 先把重要内容复制走。
 * 文案不带 errno 码（只进服务端日志），见 describeStorageDegraded。
 */
export const StorageDegradedBar = ({ state, className }: Props) => {
  const { title, detail } = describeStorageDegraded(state.code);
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
        <p className="font-medium">{title}</p>
        {/* 补充说明比标题弱一档：靠 11px 字号表达层级（ui-conventions：文字不叠 /40~/80 的 alpha），颜色继承外层的 text-destructive */}
        <p className="mt-0.5 text-[11px]">{detail}</p>
      </div>
    </div>
  );
};
