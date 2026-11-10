"use client";

/**
 * 页内查找条（契约 §14.3）：输入框 + 上一个 / 下一个 / 关闭 + 「3/12」计数 + 无结果态。
 *
 * 画在视口上方的一行（不是浮层）——浮层会触发整块遮盖截图，内联只是把视口往下推一点。
 * 查找本身在主进程：browser:find → webContents.findInPage；进度经 browser:found 推回来，本组件挂载期间订阅。
 * 按键：Enter 下一个 / Shift+Enter 上一个 / Esc 关闭并清掉页内高亮。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { BrowserIconButton } from "./browser-icon-button";
import { findKeyIntent, formatFindCount, type FindProgress } from "./browser-user-logic";

interface BrowserFindBarProps {
  taskId: string;
  /** 递增即「再按了一次 Cmd/Ctrl+F」：重新聚焦并全选输入框 */
  focusToken?: number;
  onClose: () => void;
}

export const BrowserFindBar = memo(function BrowserFindBar({ taskId, focusToken = 0, onClose }: BrowserFindBarProps) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<FindProgress | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  // 打开 / 再次 Cmd+F：聚焦并全选，方便直接覆盖上一次的查找词
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusToken]);

  // 订阅主进程的查找进度（只收本任务的）；老壳没有 onFound 就只是没有计数
  useEffect(() => {
    const bridge = window.__browser;
    if (!bridge?.onFound) return;
    return bridge.onFound((f) => {
      if (f.taskId === taskId) setFound({ activeMatchOrdinal: f.activeMatchOrdinal, matches: f.matches });
    });
  }, [taskId]);

  // 卸载（含 Esc / 点关闭 / 切 tab）一律清掉页内高亮，别让黄色标记留在页面上
  useEffect(
    () => () => {
      window.__browser?.stopFind?.(taskId);
    },
    [taskId],
  );

  // 注意 findNext 沿用 Electron findInPage 的原语义：true = **开始新一轮**查找（词变了 / 首次），
  // false = 同一轮里的后续请求（Enter 下一个 / Shift+Enter 上一个）。直觉上是反的，别「修正」
  const runFind = useCallback(
    (text: string, opts: { forward: boolean; findNext: boolean }) => {
      const bridge = window.__browser;
      if (text.trim() === "") {
        bridge?.stopFind?.(taskId);
        return;
      }
      bridge?.find?.(taskId, text, opts);
    },
    [taskId],
  );

  const step = (forward: boolean) => runFind(queryRef.current, { forward, findNext: false });

  const view = formatFindCount(query, found);

  return (
    <div
      role="search"
      aria-label="页内查找"
      className="flex shrink-0 items-center gap-1 border-b px-2 py-1"
    >
      <Input
        ref={inputRef}
        type="text"
        value={query}
        maxLength={200}
        spellCheck={false}
        autoComplete="off"
        placeholder="在页面中查找"
        aria-label="在页面中查找"
        className="h-7 min-w-0 flex-1 text-xs md:text-xs"
        onChange={(e) => {
          const text = e.target.value;
          setQuery(text);
          // 词变了 = 新一轮查找：旧计数作废，不要在新词旁边闪旧的「3/12」
          setFound(null);
          runFind(text, { forward: true, findNext: true });
        }}
        onKeyDown={(e) => {
          // 整个事件传进去：isImeComposing 要同时看 isComposing 与 keyCode 229（nativeEvent 上两个都有）
          const intent = findKeyIntent({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode, nativeEvent: e.nativeEvent });
          if (!intent) return;
          e.preventDefault();
          if (intent === "close") onClose();
          else step(intent === "next");
        }}
      />
      <span
        aria-live="polite"
        className={cn(
          "min-w-12 shrink-0 text-right text-[11px] tabular-nums",
          view.kind === "none" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {view.text}
      </span>
      <BrowserIconButton label="上一个匹配" disabled={view.kind !== "found"} onClick={() => step(false)}>
        <ChevronUp />
      </BrowserIconButton>
      <BrowserIconButton label="下一个匹配" disabled={view.kind !== "found"} onClick={() => step(true)}>
        <ChevronDown />
      </BrowserIconButton>
      <BrowserIconButton label="关闭查找" onClick={onClose}>
        <X />
      </BrowserIconButton>
    </div>
  );
});
