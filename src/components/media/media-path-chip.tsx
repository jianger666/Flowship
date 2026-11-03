"use client";

/**
 * 行内音视频路径：消息正文里的 `/abs/x.mp4#t=12.4,15` 渲染成可点的小标签（▶ + 文件名 + 时间徽标），
 * 点击进播放器（所在消息的所有音视频自动成对比组），右键有更多打开方式。
 */

import type { ReactNode } from "react";
import { AudioLines, Copy, FolderOpen, Play, SquareArrowOutUpRight } from "lucide-react";
import { toast } from "sonner";

import { useMediaGroup } from "@/components/media/media-group-state";
import { usePlayingMediaPath } from "@/components/media/use-player-snapshot";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { requestOpenLocalPath, requestRevealLocalPath } from "@/lib/local-file-open";
import { openMediaInGroup } from "@/lib/media/media-open";
import { formatMediaRefRange } from "@/lib/media/media-ref";
import { pathDisplayLabel } from "@/lib/path-utils";
import { cn } from "@/lib/utils";

export const MediaPathChip = ({
  absolute,
  start,
  end,
  className,
  children,
}: {
  absolute: string;
  start?: number;
  end?: number;
  className?: string;
  /** 自定义显示文字（markdown 链接的文字）；缺省显示缩短后的路径 */
  children?: ReactNode;
}) => {
  const group = useMediaGroup();
  const playing = usePlayingMediaPath() === absolute;
  const range = formatMediaRefRange(start, end);

  const play = () => openMediaInGroup(group, { absolute, start, end });
  const reveal = () =>
    void requestRevealLocalPath(absolute).catch((e: unknown) =>
      toast.error(e instanceof Error ? e.message : "在文件管理器中显示失败"),
    );
  const external = () =>
    void requestOpenLocalPath(absolute).catch((e: unknown) =>
      toast.error(e instanceof Error ? e.message : "打开失败"),
    );
  const copy = () =>
    void navigator.clipboard.writeText(absolute).then(
      () => toast.success("已复制路径"),
      () => toast.error("复制失败"),
    );

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span className="inline" />}>
        <Tooltip content={`点击播放${range ? `（${range}）` : ""}，右键更多\n${absolute}`}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              play();
            }}
            className={cn(
              "inline-flex min-w-0 max-w-full cursor-pointer items-baseline gap-1 bg-transparent p-0 text-left align-baseline font-mono text-info underline-offset-2 hover:underline",
              playing && "font-semibold",
              className,
            )}
          >
            {playing ? (
              <AudioLines className="size-3 shrink-0 translate-y-0.5 animate-pulse motion-reduce:animate-none" />
            ) : (
              <Play className="size-3 shrink-0 translate-y-0.5" />
            )}
            <span className="min-w-0 break-all">{children ?? pathDisplayLabel(absolute)}</span>
            {range && (
              <span className="shrink-0 rounded bg-info/10 px-1 text-[0.9em] leading-tight tabular-nums">
                {range}
              </span>
            )}
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
  );
};
