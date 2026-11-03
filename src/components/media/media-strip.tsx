"use client";

/** 消息末尾的媒体条：这条消息里提到的音视频，一排卡片（同一条消息的多个文件 = 一个对比组） */

import { Layers } from "lucide-react";

import { MediaCard } from "@/components/media/media-card";
import type { ResolvedMediaRef } from "@/lib/media/media-ref";

export const MediaStrip = ({ refs }: { refs: ReadonlyArray<ResolvedMediaRef> }) => {
  if (refs.length === 0) return null;
  return (
    <div className="not-prose mt-2" data-media-strip="">
      {refs.length > 1 && (
        <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <Layers className="size-3" />
          {refs.length} 个文件，点开后可在播放器里用数字键 1–{Math.min(9, refs.length)} 对比切换
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {refs.map((r) => (
          <MediaCard key={r.absolute} item={r} />
        ))}
      </div>
    </div>
  );
};
