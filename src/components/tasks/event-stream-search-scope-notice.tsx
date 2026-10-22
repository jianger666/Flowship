"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  /** 范围说明，如「仅搜索已加载的最近 300 条」 */
  text: string;
  /** 是否提供「加载更早的再搜」入口 */
  canLoadEarlier: boolean;
  /** 更早事件正在拉取（入口置灰、避免重复点） */
  loading: boolean;
  onLoadEarlier: () => void;
  className?: string;
}

/**
 * 事件流搜索的范围提示条：只搜了已加载的那一段时，说明「0/0 ≠ 没有」并给出加载更早的入口。
 * 独立成组件而不改 EventStreamSearchBar——后者与产物面板共用，那边搜的是整份文档、不需要这条提示。
 */
export const EventStreamSearchScopeNotice = ({
  text,
  canLoadEarlier,
  loading,
  onLoadEarlier,
  className,
}: Props) => (
  <div
    role="status"
    className={cn(
      "flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground",
      className,
    )}
  >
    <span className="min-w-0 truncate">{text}</span>
    {canLoadEarlier && (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={loading}
        onClick={onLoadEarlier}
        className="shrink-0"
      >
        {loading ? "加载中…" : "加载更早的再搜"}
      </Button>
    )}
  </div>
);
