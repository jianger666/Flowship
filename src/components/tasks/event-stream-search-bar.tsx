"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { useShellPlatform } from "@/hooks/use-shell-platform";
import { getSearchThisPaneLabel } from "@/lib/platform-shortcuts";
import { cn } from "@/lib/utils";

interface Props {
  active: boolean;
  query: string;
  hitIndex: number;
  hitCount: number;
  onActivate: () => void;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** 受控聚焦：父组件 activate 后调用 */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** log 形态左侧标题 */
  leading?: ReactNode;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  inputClassName?: string;
}

export const EventStreamSearchBar = ({
  active,
  query,
  hitIndex,
  hitCount,
  onActivate,
  onQueryChange,
  onClose,
  onPrev,
  onNext,
  inputRef: inputRefProp,
  leading,
  placeholder = "搜索事件流…",
  ariaLabel = "搜索事件流",
  className,
  inputClassName,
}: Props) => {
  const platform = useShellPlatform();
  const searchLabel = getSearchThisPaneLabel(platform);
  const localInputRef = useRef<HTMLInputElement>(null);
  const inputRef = inputRefProp ?? localInputRef;

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, [inputRef]);

  useEffect(() => {
    if (active) focusInput();
  }, [active, focusInput]);

  const handleActivate = () => {
    onActivate();
    focusInput();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    onClose();
    inputRef.current?.blur();
  };

  const counter =
    hitCount > 0
      ? `${hitIndex + 1}/${hitCount}`
      : query.trim()
        ? "0/0"
        : null;

  if (!active) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 text-xs text-muted-foreground",
          className,
        )}
      >
        {leading}
        <Tooltip content={searchLabel} side="bottom" delay={200}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={searchLabel}
            onClick={handleActivate}
            className="shrink-0"
          >
            <Search className="size-4" />
          </Button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs text-muted-foreground",
        className,
      )}
    >
      {leading}
      <Input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={cn("h-7 min-w-0 flex-1 text-sm", inputClassName)}
      />
      {counter && (
        <span className="shrink-0 tabular-nums text-[11px]">{counter}</span>
      )}
      <Tooltip content="上一个（Shift+Enter）" side="bottom" delay={200}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="上一个匹配"
          disabled={hitCount === 0}
          onClick={onPrev}
        >
          <ChevronUp className="size-4" />
        </Button>
      </Tooltip>
      <Tooltip content="下一个（Enter）" side="bottom" delay={200}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="下一个匹配"
          disabled={hitCount === 0}
          onClick={onNext}
        >
          <ChevronDown className="size-4" />
        </Button>
      </Tooltip>
      <Tooltip content="关闭搜索（Esc）" side="bottom" delay={200}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="关闭搜索"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </Tooltip>
    </div>
  );
};
