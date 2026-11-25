"use client";

/**
 * 地址栏输入框 + 联想下拉（地址栏记忆）。
 *
 * 联想是什么：敲字时按「已访问过的网址 + 收藏夹」匹配地址与标题，常去 / 刚去过 / 收藏过的排前面（匹配与排序在 lib/browser-history.ts 的 suggestAddresses，
 * 调用方算好传进来）。这里只管输入框与下拉的交互：
 * - ↑ ↓ 选择、Enter 打开高亮项（没有高亮项 = 照旧提交输入框里的文字）、Esc：下拉开着时第一下只收下拉，再按才退出编辑；
 * - 鼠标点一项 = 打开；历史项右端的「×」（或高亮后按 Shift+Delete / Shift+Backspace）= 从记忆里删掉这一条，下拉不关；
 * - 刻意不做行内补全（输入框里自动补出后半截网址）：它和输入法组词冲突（中文输入法敲拼音时会被补全打断）。
 *
 * 输入框的值始终由调用方说了算（聚焦编辑时是草稿，其余时候是当前页地址）：base-ui 在选中项 / Esc 时想改输入值的请求一律忽略，
 * 只认用户亲自敲 / 贴出来的变化（reason === "input-change"）。
 *
 * 下拉的 role="listbox" 会触发内置浏览器的原生视图遮盖让位（use-overlay-cover），不用额外接线；
 * 选项按下时不抢输入框焦点（base-ui 在 item 上拦了 pointerdown / mousedown），所以点选不会先触发 blur 把下拉收掉。
 */
import { History, Star, X } from "lucide-react";
import { useMemo, useRef, useState, type FocusEvent, type RefObject } from "react";

import { Autocomplete, AutocompleteContent, AutocompleteInput, AutocompleteItem, AutocompleteList } from "@/components/ui/autocomplete";
import { displayBookmarkUrl } from "@/lib/browser-bookmarks";
import type { AddressSuggestion } from "@/lib/browser-history";

import { removeSuggestionLabel, suggestionLabel } from "./history-flow";

export interface AddressInputProps {
  /** 输入框里显示的文字 */
  value: string;
  /** 用户敲 / 贴出了新的文字 */
  onTextChange: (text: string) => void;
  onFocus: (e: FocusEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  /** 下拉没开着时按 Esc（下拉开着时第一下 Esc 只收下拉，不会走到这里） */
  onEscape: (input: HTMLInputElement) => void;
  /** 当前联想；空数组 = 不弹 */
  suggestions: readonly AddressSuggestion[];
  /** 选中一条联想：调用方负责打开它 */
  onPick: (suggestion: AddressSuggestion) => void;
  /** 删掉一条历史联想（只会传 historyId 非空的） */
  onRemove: (suggestion: AddressSuggestion) => void;
  /** 下拉的定位参照：整条工具栏——下拉与它同宽、贴着它的下沿（窄面板里不会缩成输入框那么窄） */
  anchorRef: RefObject<HTMLElement | null>;
  placeholder: string;
  className?: string;
}

export const SuggestionRow = ({
  suggestion,
  onPick,
  onRemove,
}: {
  suggestion: AddressSuggestion;
  onPick: (s: AddressSuggestion) => void;
  onRemove: (s: AddressSuggestion) => void;
}) => (
  <AutocompleteItem value={suggestion.url} onClick={() => onPick(suggestion)} className="group">
    {suggestion.bookmarked ? (
      <>
        <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-hidden />
        <span className="sr-only">已收藏：</span>
      </>
    ) : (
      <History className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    )}
    <span className="max-w-[55%] shrink-0 truncate font-medium">{suggestionLabel(suggestion)}</span>
    <span className="min-w-0 flex-1 truncate text-muted-foreground">{displayBookmarkUrl(suggestion.url)}</span>
    {suggestion.historyId !== null && (
      <button
        type="button"
        tabIndex={-1}
        aria-label={removeSuggestionLabel(suggestion)}
        // 不抢输入框焦点（否则 blur 会先把下拉收掉）；click 不冒泡：不能同时触发「选中这一项」
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove(suggestion);
        }}
        // 只在该行高亮（鼠标悬停 / 键盘选中）时可见可点：平时不占视觉
        className="invisible -mr-1 grid size-5 shrink-0 place-items-center rounded text-muted-foreground group-data-[highlighted]:visible hover:bg-background hover:text-foreground"
      >
        <X className="size-3" aria-hidden />
      </button>
    )}
  </AutocompleteItem>
);

export const AddressInput = ({ value, onTextChange, onFocus, onBlur, onEscape, suggestions, onPick, onRemove, anchorRef, placeholder, className }: AddressInputProps) => {
  // 用户按 Esc / 选中 / 失焦收起下拉后到「再敲字 / 再聚焦 / 按 ↑↓」之前保持收起；联想为空时本来就不开
  const [dismissed, setDismissed] = useState(false);
  const highlightedRef = useRef<string | undefined>(undefined);
  const urls = useMemo(() => suggestions.map((s) => s.url), [suggestions]);
  const byUrl = useMemo(() => new Map(suggestions.map((s) => [s.url, s] as const)), [suggestions]);
  const open = suggestions.length > 0 && !dismissed;

  return (
    <Autocomplete
      items={urls}
      mode="none"
      value={value}
      open={open}
      onOpenChange={(next) => setDismissed(!next)}
      onValueChange={(text, details) => {
        if (details.reason !== "input-change") return;
        setDismissed(false);
        onTextChange(text);
      }}
      onItemHighlighted={(url) => {
        highlightedRef.current = url;
      }}
    >
      <AutocompleteInput
        type="text"
        aria-label="地址栏"
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={className}
        onFocus={(e) => {
          setDismissed(false);
          onFocus(e);
        }}
        onBlur={() => {
          setDismissed(true);
          highlightedRef.current = undefined;
          onBlur();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (open) {
              // 第一下 Esc 只收下拉：别让全局的 Esc 处理（关面板 / 退出放大）也跟着响应
              e.stopPropagation();
              setDismissed(true);
              return;
            }
            onEscape(e.currentTarget);
            return;
          }
          // 键盘上删一条历史联想：Shift+Delete（Mac 键盘上常是 Shift+Backspace）作用在当前高亮项上
          if (open && e.shiftKey && (e.key === "Delete" || e.key === "Backspace")) {
            const target = highlightedRef.current !== undefined ? byUrl.get(highlightedRef.current) : undefined;
            if (target && target.historyId !== null) {
              e.preventDefault();
              onRemove(target);
            }
          }
        }}
      />
      {/*
        默认提交按钮：让「在输入框里按 Enter」继续提交所在的 <form>。
        base-ui 的 Autocomplete 会在 Root 旁边塞一个隐藏的文本输入框（做表单值同步），于是表单里有两个文本框——
        浏览器的「只有一个文本框才靠 Enter 隐式提交」规则就失效了，Enter 什么都不会发生；
        有一个默认提交按钮时，Enter 会改为点它（隐藏的也算；输入法组词中按 Enter 不会触发，与普通输入框一致）。
      */}
      <button type="submit" hidden aria-hidden tabIndex={-1} />
      <AutocompleteContent anchor={anchorRef}>
        <AutocompleteList aria-label="地址联想">
          {(url: string) => {
            const suggestion = byUrl.get(url);
            return suggestion ? <SuggestionRow key={url} suggestion={suggestion} onPick={onPick} onRemove={onRemove} /> : null;
          }}
        </AutocompleteList>
      </AutocompleteContent>
    </Autocomplete>
  );
};
