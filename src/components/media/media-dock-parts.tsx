"use client";

/**
 * 播放窗的小零件：缩放把手、对比组标签、提示条、快捷键帮助。
 * 基本是无状态展示件（GroupTabs 只有一个「切换后滚进视野」的副作用），逻辑在 media-player-dock。
 */

import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import { AlertTriangle, AudioLines, Film, Info, X } from "lucide-react";

import type { ResizeEdge } from "@/lib/media/media-geometry";
import { detectMediaKind } from "@/lib/media/media-kind";
import type { MediaItem } from "@/lib/media/player-store";
import { Tooltip } from "@/components/ui/tooltip";
import { pathBasename } from "@/lib/path-utils";
import { cn } from "@/lib/utils";

const HANDLES: Array<{ edge: ResizeEdge; className: string }> = [
  { edge: "right", className: "right-0 top-3 bottom-3 w-1.5 cursor-ew-resize" },
  { edge: "left", className: "left-0 top-3 bottom-3 w-1.5 cursor-ew-resize" },
  { edge: "bottom", className: "bottom-0 left-3 right-3 h-1.5 cursor-ns-resize" },
  { edge: "top", className: "top-0 left-3 right-3 h-1.5 cursor-ns-resize" },
  { edge: "corner", className: "bottom-0 right-0 size-3.5 cursor-nwse-resize" },
  { edge: "bl", className: "bottom-0 left-0 size-3.5 cursor-nesw-resize" },
  { edge: "tr", className: "top-0 right-0 size-3.5 cursor-nesw-resize" },
  { edge: "tl", className: "top-0 left-0 size-3.5 cursor-nwse-resize" },
];

export const ResizeHandles = ({
  onStart,
}: {
  onStart: (edge: ResizeEdge, e: PointerEvent<HTMLDivElement>) => void;
}) => (
  <>
    {HANDLES.map((h) => (
      <div
        key={h.edge}
        aria-hidden
        onPointerDown={(e) => onStart(h.edge, e)}
        className={cn("absolute z-30 touch-none", h.className)}
      />
    ))}
  </>
);

/**
 * 对比组标签：一排文件，点哪个切到哪个（保持播放进度由 dock 负责）。
 * 标签平分一行（最窄 6rem、最宽 11rem），文件多了才横向滚动；切换后把选中的那个滚进视野——
 * 之前 2 个标签在窄窗里第 2 个被挤出右边缘，选中的是谁都看不见。
 */
export const GroupTabs = ({
  items,
  index,
  playingPath,
  onSelect,
}: {
  items: MediaItem[];
  index: number;
  playingPath: string | null;
  onSelect: (i: number) => void;
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 按 aria-selected 找选中的标签（Tooltip 会接管 trigger 的 ref，不在按钮上挂 ref）
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [index]);
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="对比组"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-2 py-1.5 [scrollbar-width:thin]"
    >
      {items.map((it, i) => {
        const active = i === index;
        const Icon = detectMediaKind(it.path) === "audio" ? AudioLines : Film;
        return (
          <Tooltip key={it.path} content={it.path}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(i)}
              className={cn(
                "inline-flex min-w-24 max-w-44 grow basis-24 items-center gap-1.5 rounded-md border px-2 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <span className="font-mono text-[11px] tabular-nums opacity-70">{i + 1}</span>
              <Icon className={cn("size-3 shrink-0", it.path === playingPath && "text-primary")} />
              <span className="min-w-0 truncate">{pathBasename(it.path)}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
};

export type BannerTone = "info" | "warning" | "error";

const TONE_CLASS: Record<BannerTone, string> = {
  info: "bg-info/10 text-foreground",
  warning: "bg-warning/15 text-foreground",
  error: "bg-destructive/10 text-foreground",
};

/** 窗口内的提示条（文件已更新 / 播放失败 / 已续播）。右侧放操作按钮 */
export const DockBanner = ({
  tone,
  children,
  actions,
  onDismiss,
}: {
  tone: BannerTone;
  children: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
}) => (
  <div
    role={tone === "error" ? "alert" : "status"}
    className={cn("flex shrink-0 items-start gap-2 px-3 py-1.5 text-xs leading-relaxed", TONE_CLASS[tone])}
  >
    {tone === "info" ? (
      <Info className="mt-0.5 size-3.5 shrink-0 text-info" />
    ) : (
      <AlertTriangle
        className={cn("mt-0.5 size-3.5 shrink-0", tone === "error" ? "text-destructive" : "text-warning")}
      />
    )}
    <div className="min-w-0 flex-1">{children}</div>
    {actions && <div className="flex shrink-0 flex-wrap items-center gap-1">{actions}</div>}
    {onDismiss && (
      <button
        type="button"
        aria-label="关闭提示"
        onClick={onDismiss}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    )}
  </div>
);

export const BannerButton = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button
    type="button"
    onClick={onClick}
    className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
  >
    {children}
  </button>
);

const SHORTCUT_ROWS: Array<[string, string]> = [
  ["空格 / K", "播放 / 暂停"],
  ["← →", "后退 / 前进 5 秒（Shift：30 秒）"],
  ["J  L", "后退 / 前进 10 秒"],
  [", .", "上一帧 / 下一帧（音频：±1 秒）"],
  ["[ ]  \\", "降速 / 升速 / 复位 1×"],
  ["↑ ↓", "音量"],
  ["M", "静音"],
  ["R", "循环：关 → 单个 → 整组"],
  ["F  P  C", "全屏 / 画中画 / 字幕（视频）"],
  ["0–9", "对比组：切换第几个；单个文件：跳到 0–90%"],
  ["Home  End", "跳到开头 / 结尾"],
  ["PageUp  PageDown", "上一个 / 下一个（对比组）"],
  ["Esc  Esc", "连按两次关闭播放器（1.5 秒内；全屏时 Esc 只退出全屏）"],
];

export const ShortcutHelp = ({ onClose }: { onClose: () => void }) => (
  <div
    role="dialog"
    aria-label="播放器快捷键"
    className="absolute inset-0 z-40 flex flex-col bg-background/95 backdrop-blur-sm"
  >
    <div className="flex items-center gap-2 border-b border-border/80 px-3 py-2 text-sm font-medium">
      键盘快捷键
      <span className="flex-1" />
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
    <ul className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {SHORTCUT_ROWS.map(([keys, desc]) => (
        <li key={keys} className="flex items-baseline gap-3 py-1 text-xs">
          <kbd className="w-32 shrink-0 rounded border bg-muted/50 px-1.5 py-0.5 text-center font-mono text-[11px]">
            {keys}
          </kbd>
          <span className="text-muted-foreground">{desc}</span>
        </li>
      ))}
      <li className="pt-2 text-[11px] leading-relaxed text-muted-foreground">
        快捷键在鼠标悬停在播放窗上、或焦点在播放窗内时生效；在输入框里打字不会触发。
        全屏时鼠标几秒不动会自动收起控件，动一下鼠标或按任意键就回来；暂停时一直显示。
      </li>
    </ul>
  </div>
);
