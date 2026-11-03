"use client";

/**
 * 消息末尾的媒体卡片：封面（视频）/ 波形图标（音频）、时长、大小，点击进播放器。
 * 元数据在卡片进入视口后才加载（use-media-card-meta），尺寸固定，加载前后不撑高列表。
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { AudioLines, Copy, FolderOpen, Loader2, Play, SquareArrowOutUpRight, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { useMediaGroup } from "@/components/media/media-group-state";
import { usePlayingMediaPath } from "@/components/media/use-player-snapshot";
import { useMediaCardMeta } from "@/components/media/use-media-card-meta";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { requestOpenLocalPath, requestRevealLocalPath } from "@/lib/local-file-open";
import { detectMediaKind } from "@/lib/media/media-kind";
import { openMediaInGroup } from "@/lib/media/media-open";
import { formatMediaRefRange, type ResolvedMediaRef } from "@/lib/media/media-ref";
import { formatBytes, formatClock } from "@/lib/media/media-time";
import { pathBasename, shortenHomePathDisplay } from "@/lib/path-utils";
import { cn } from "@/lib/utils";

/** 卡片进入视口后一次性置 true */
const useOnceInView = (): [RefObject<HTMLDivElement | null>, boolean] => {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
};

export const MediaCard = ({ item }: { item: ResolvedMediaRef }) => {
  const kind = detectMediaKind(item.absolute) ?? "video";
  const group = useMediaGroup();
  const playingPath = usePlayingMediaPath();
  const [ref, seen] = useOnceInView();
  const meta = useMediaCardMeta(item.absolute, kind, seen);
  const playing = playingPath === item.absolute;
  const name = pathBasename(item.absolute);
  const range = formatMediaRefRange(item.start, item.end);

  const play = () => openMediaInGroup(group, item);
  const reveal = () =>
    void requestRevealLocalPath(item.absolute).catch((e: unknown) =>
      toast.error(e instanceof Error ? e.message : "在文件管理器中显示失败"),
    );
  const external = () =>
    void requestOpenLocalPath(item.absolute).catch((e: unknown) =>
      toast.error(e instanceof Error ? e.message : "打开失败"),
    );
  const copy = () =>
    void navigator.clipboard.writeText(item.absolute).then(
      () => toast.success("已复制路径"),
      () => toast.error("复制失败"),
    );

  const failed = meta.status === "error";

  return (
    <div ref={ref} className="w-44 shrink-0">
      <ContextMenu>
        <ContextMenuTrigger render={<div />}>
          <Tooltip content={`${item.absolute}\n点击播放，右键更多`}>
            <button
              type="button"
              onClick={play}
              aria-label={`播放 ${name}`}
              className={cn(
                "group/media-card flex h-[8.75rem] w-full flex-col overflow-hidden rounded-lg border bg-card text-left outline-none transition-colors",
                "hover:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring",
                playing ? "border-primary/60 ring-1 ring-primary/30" : "border-border",
              )}
            >
              <div
                className={cn(
                  "relative h-24 w-full shrink-0 overflow-hidden",
                  kind === "video" ? "bg-black" : "bg-muted/60",
                )}
              >
                {meta.status === "ready" && meta.poster ? (
                  // 封面是本地 canvas 生成的 data URL，用背景图画（全仓 <img> 入口有守卫，见 markdown-remote-image-ssr）
                  <div
                    aria-hidden
                    className="size-full bg-contain bg-center bg-no-repeat"
                    style={{ backgroundImage: `url(${meta.poster})` }}
                  />
                ) : kind === "audio" ? (
                  <div className="flex size-full items-center justify-center">
                    <AudioLines className={cn("size-8 text-primary opacity-70", playing && "animate-pulse motion-reduce:animate-none")} />
                  </div>
                ) : (
                  <div className="flex size-full items-center justify-center text-white/60">
                    {meta.status === "loading" ? (
                      <Loader2 className={cn("size-5", seen && "animate-spin")} />
                    ) : failed ? (
                      <TriangleAlert className="size-5 text-warning" />
                    ) : null}
                  </div>
                )}
                <span
                  className={cn(
                    "absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-opacity",
                    playing ? "opacity-100" : "opacity-0 group-hover/media-card:opacity-100 group-focus-visible/media-card:opacity-100",
                  )}
                >
                  {playing ? <AudioLines className="size-4 animate-pulse motion-reduce:animate-none" /> : <Play className="size-4 translate-x-px" />}
                </span>
                {meta.status === "ready" && meta.duration > 0 && (
                  <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 py-px font-mono text-[11px] text-white tabular-nums">
                    {formatClock(meta.duration)}
                  </span>
                )}
                {range && (
                  <span className="absolute top-1 left-1 rounded bg-info/90 px-1 py-px font-mono text-[11px] text-white tabular-nums">
                    {range}
                  </span>
                )}
              </div>
              <div className="flex min-h-0 flex-1 flex-col justify-center gap-0.5 px-2">
                <span className="truncate text-xs font-medium">{name}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {failed
                    ? meta.reason
                    : meta.status === "ready"
                      ? formatBytes(meta.size)
                      : shortenHomePathDisplay(item.absolute.slice(0, Math.max(0, item.absolute.length - name.length - 1)))}
                </span>
              </div>
            </button>
          </Tooltip>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem onClick={play}>
            <Play className="size-3.5" />
            播放
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={external}>
            <SquareArrowOutUpRight className="size-3.5" />
            用系统播放器打开
          </ContextMenuItem>
          <ContextMenuItem onClick={reveal}>
            <FolderOpen className="size-3.5" />
            在文件管理器中显示
          </ContextMenuItem>
          <ContextMenuItem onClick={copy}>
            <Copy className="size-3.5" />
            复制路径
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};
