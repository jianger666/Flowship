"use client";

/**
 * PPTX 大纲查看器
 *
 * 只展示每页的文字：标题、正文要点（保留缩进层级）、演讲者备注、图片 / 图表数——不渲染版式（那要完整的 OOXML 渲染引擎）。
 * 左侧页列表（带搜索过滤），右侧当前页详情，←/→ 翻页。要看真实版式请用系统应用打开。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Image as ImageIcon, Search, StickyNote } from "lucide-react";

import { Dot, PreviewToolbar, ToolButton } from "@/components/preview/preview-ui";
import { Input } from "@/components/ui/input";
import type { PreviewSlide } from "@/lib/preview/types";
import { cn } from "@/lib/utils";

const slideLabel = (s: PreviewSlide): string => s.title || s.paragraphs[0]?.text || "（无文字）";

const slideMatches = (s: PreviewSlide, q: string): boolean =>
  s.title.toLowerCase().includes(q) ||
  s.notes.toLowerCase().includes(q) ||
  s.paragraphs.some((p) => p.text.toLowerCase().includes(q));

export const SlidesViewer = ({ slides, slideCount }: { slides: PreviewSlide[]; slideCount?: number }) => {
  const [current, setCurrent] = useState(0);
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => (q ? slides.filter((s) => slideMatches(s, q)) : slides), [slides, q]);
  const selected = slides[current] ?? slides[0];
  const visibleIdx = selected ? visible.findIndex((s) => s.index === selected.index) : -1;

  // 内容换了（重新加载）别越界
  useEffect(() => {
    if (current >= slides.length) setCurrent(0);
  }, [slides.length, current]);

  // 翻页时让列表里当前项保持可见
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const go = (delta: 1 | -1) => {
    if (visible.length === 0) return;
    const at = visibleIdx < 0 ? 0 : visibleIdx;
    const next = visible[Math.min(visible.length - 1, Math.max(0, at + delta))];
    if (next) setCurrent(slides.findIndex((s) => s.index === next.index));
  };

  const total = slideCount ?? slides.length;

  return (
    <div
      className="flex h-full min-h-0 flex-col outline-none"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") go(1);
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") go(-1);
        else return;
        e.preventDefault();
      }}
    >
      <PreviewToolbar
        left={
          <>
            <span className="tabular-nums">
              第 {selected ? selected.index : 0} / {total} 页
            </span>
            <Dot />
            <span>文字大纲（不含版式）</span>
          </>
        }
        right={
          <>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="搜索幻灯片"
                aria-label="搜索幻灯片"
                className="h-6 w-40 pl-6 text-xs md:text-xs"
              />
            </div>
            <ToolButton label="上一页" shortcut="←" onClick={() => go(-1)} disabled={visibleIdx <= 0}>
              <ChevronLeft />
            </ToolButton>
            <ToolButton label="下一页" shortcut="→" onClick={() => go(1)} disabled={visibleIdx < 0 || visibleIdx >= visible.length - 1}>
              <ChevronRight />
            </ToolButton>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div ref={listRef} className="hidden w-56 shrink-0 overflow-y-auto border-r border-border/70 bg-muted/20 py-1 sm:block">
          {visible.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">没有匹配的幻灯片</p>
          ) : (
            visible.map((s) => {
              const isCur = selected?.index === s.index;
              return (
                <button
                  key={s.index}
                  type="button"
                  aria-current={isCur}
                  onClick={() => setCurrent(slides.findIndex((x) => x.index === s.index))}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                    isCur && "bg-accent font-medium",
                  )}
                >
                  <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{s.index}</span>
                  <span className="line-clamp-2 min-w-0 break-words">{slideLabel(s)}</span>
                </button>
              );
            })
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-5">
          {selected ? (
            <article className="mx-auto max-w-3xl">
              <h2 className="mb-4 text-lg font-semibold tracking-tight break-words">{selected.title || `第 ${selected.index} 页`}</h2>
              {selected.paragraphs.length === 0 ? (
                <p className="text-sm text-muted-foreground">这一页没有文字内容</p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {selected.paragraphs.map((p, i) => (
                    <li
                      key={i}
                      style={{ marginLeft: Math.min(p.level, 6) * 20 }}
                      className="relative pl-4 break-words whitespace-pre-wrap before:absolute before:top-[0.6em] before:left-0 before:size-1 before:rounded-full before:bg-muted-foreground"
                    >
                      {p.text}
                    </li>
                  ))}
                </ul>
              )}
              {selected.pictureCount > 0 && (
                <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ImageIcon className="size-3.5" />
                  这一页还有 {selected.pictureCount} 个图片 / 图表（此处不显示）
                </p>
              )}
              {selected.notes && (
                <section className="mt-5 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                  <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <StickyNote className="size-3.5" />
                    演讲者备注
                  </h3>
                  <p className="text-sm break-words whitespace-pre-wrap">{selected.notes}</p>
                </section>
              )}
            </article>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">没有可显示的幻灯片</p>
          )}
        </div>
      </div>
      {slideCount != null && slideCount > slides.length && (
        <p className="shrink-0 border-t border-border/70 bg-muted/20 px-3 py-1.5 text-xs text-warning">
          只解析了前 {slides.length} 页（共 {slideCount} 页）
        </p>
      )}
    </div>
  );
};
