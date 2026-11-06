"use client";

/**
 * 渲染后文档的外框：工具栏 + 页内查找 + 右侧目录（markdown 预览 / docx 共用）
 *
 * 目录从渲染出来的 DOM 里扫 h1–h4（不依赖 markdown 解析器的内部结构，docx 转出来的 HTML 同样适用）；
 * MutationObserver 跟着内容变（Streamdown 分块渲染、mermaid 异步出图）。滚动时高亮当前所在章节。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ListTree, Search } from "lucide-react";

import { FindBar, PreviewToolbar, ToolButton } from "@/components/preview/preview-ui";
import { useDocFind } from "@/components/preview/use-doc-find";
import { usePersistedBoolean } from "@/components/preview/use-persisted";
import { useShellPlatform } from "@/hooks/use-shell-platform";
import { getModShortcutLabel, isModCombo } from "@/lib/keyboard-shortcuts";
import { cn } from "@/lib/utils";

interface OutlineItem {
  level: number;
  text: string;
}

const MAX_OUTLINE_ITEMS = 300;

const useDomOutline = (contentRef: React.RefObject<HTMLElement | null>, scrollRef: React.RefObject<HTMLElement | null>, contentKey: unknown) => {
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const headingsRef = useRef<HTMLElement[]>([]);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    let raf = 0;
    const scan = () => {
      raf = 0;
      const hs = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4"))
        .filter((h) => (h.textContent ?? "").trim() !== "")
        .slice(0, MAX_OUTLINE_ITEMS);
      headingsRef.current = hs;
      setItems((prev) => {
        const next = hs.map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent ?? "").trim() }));
        const same = prev.length === next.length && prev.every((p, i) => p.text === next[i]!.text && p.level === next[i]!.level);
        return same ? prev : next;
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(scan);
    };
    scan();
    const mo = new MutationObserver(schedule);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [contentRef, contentKey]);

  // 滚动时算当前章节：最后一个顶边已越过容器顶部（留 48px 余量）的标题
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const top = sc.getBoundingClientRect().top + 48;
        let cur = 0;
        headingsRef.current.forEach((h, i) => {
          if (h.getBoundingClientRect().top <= top) cur = i;
        });
        setActiveIdx(cur);
      });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef]);

  const jumpTo = useCallback((i: number) => {
    headingsRef.current[i]?.scrollIntoView({ block: "start", behavior: "smooth" });
    setActiveIdx(i);
  }, []);

  return { items, activeIdx, jumpTo };
};

export const DocumentPane = ({
  leading,
  contentKey,
  children,
  contentClassName,
}: {
  leading?: ReactNode;
  /** 文档内容标识：变了就重扫目录、重搜查找 */
  contentKey: unknown;
  children: ReactNode;
  contentClassName?: string;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const platform = useShellPlatform();
  const find = useDocFind(contentRef, contentKey);
  const { items, activeIdx, jumpTo } = useDomOutline(contentRef, scrollRef, contentKey);
  const [outlineOn, setOutlineOn] = usePersistedBoolean("flowship.preview.outline", true);
  const showOutline = outlineOn && items.length >= 3;
  const minLevel = items.reduce((m, i) => Math.min(m, i.level), 6);

  const openFind = () => {
    find.setOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col outline-none"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (find.supported && isModCombo(e, "f")) {
          e.preventDefault();
          openFind();
        }
      }}
    >
      <PreviewToolbar
        left={leading}
        right={
          <>
            {find.supported && (
              <ToolButton label="查找" shortcut={getModShortcutLabel(platform, "F")} onClick={openFind} active={find.open}>
                <Search />
              </ToolButton>
            )}
            {items.length >= 3 && (
              <ToolButton label={outlineOn ? "隐藏目录" : "显示目录"} onClick={() => setOutlineOn(!outlineOn)} active={outlineOn}>
                <ListTree />
              </ToolButton>
            )}
          </>
        }
      />
      {find.open && (
        <FindBar
          value={find.query}
          onChange={find.setQuery}
          inputRef={findInputRef}
          placeholder="在文档中查找"
          current={find.current}
          total={find.total}
          capped={find.capped}
          caseSensitive={find.caseSensitive}
          onToggleCase={find.toggleCase}
          onNext={find.next}
          onPrev={find.prev}
          onClose={find.close}
        />
      )}
      <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4">
          <div ref={contentRef} className={cn("min-w-0", contentClassName)}>
            {children}
          </div>
        </div>
        {showOutline && (
          <nav aria-label="目录" className="hidden w-56 shrink-0 overflow-y-auto border-l border-border/70 bg-muted/20 py-2 sm:block">
            <p className="px-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground">目录</p>
            {items.map((it, i) => (
              <button
                key={i}
                type="button"
                onClick={() => jumpTo(i)}
                style={{ paddingLeft: 12 + (it.level - minLevel) * 12 }}
                className={cn(
                  "block w-full truncate py-1 pr-3 text-left text-xs transition-colors hover:bg-accent",
                  i === activeIdx ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {it.text}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
};
