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
import { useImeInput } from "@/hooks/use-ime-input";
import { useShellPlatform } from "@/hooks/use-shell-platform";
import { getSearchThisPaneLabel } from "@/lib/platform-shortcuts";
import { isImeComposing } from "@/lib/ime";
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

interface SearchInputProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  placeholder: string;
  ariaLabel: string;
  className: string;
}

/**
 * 搜索框本体。单独成组件，是因为输入法组合态（useImeInput）要跟着输入框一起生灭：
 * 栏收起（active=false）时输入框卸载，组合标记随之清掉，不会残留成「还在组合」而吞掉之后的输入。
 * 组合中（拼音还没上屏）不向外上报查询词，上屏后才报——否则每个字母都会跑一遍全量搜索并跳转。
 */
const SearchInput = ({
  inputRef,
  query,
  onQueryChange,
  onKeyDown,
  placeholder,
  ariaLabel,
  className,
}: SearchInputProps) => {
  const ime = useImeInput({ value: query, onCommit: onQueryChange });
  return (
    <Input
      ref={inputRef}
      autoFocus
      value={ime.value}
      onChange={ime.onChange}
      onCompositionStart={ime.onCompositionStart}
      onCompositionEnd={ime.onCompositionEnd}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={className}
    />
  );
};

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
    // IME 选词中的 Enter 交给输入法（否则选词会顺带跳到下一个命中）
    if (e.key === "Enter" && !isImeComposing(e)) {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
      return;
    }
    // IME 里按 Esc 是取消候选词、不是关搜索（否则候选还在、搜索框先没了，查询词也被清空）
    if (e.key !== "Escape" || isImeComposing(e)) return;
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
      <SearchInput
        inputRef={inputRef}
        query={query}
        onQueryChange={onQueryChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
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
