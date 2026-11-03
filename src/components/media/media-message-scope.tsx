"use client";

/**
 * 一条消息的音视频作用域：
 * - 提取正文里的音视频引用，提供给行内 chip / 链接 / 卡片做对比组；
 * - 在正文后渲染媒体条（卡片）。
 *
 * 流式输出中不提取（半截 markdown 会抖）；定稿后才出现媒体条。
 * Provider 恒定存在：流式 → 定稿是同一个 MarkdownText 实例原地切换（stream-handoff），不能因为多了一层包装而重挂。
 */

import { useMemo, type ReactNode } from "react";

import { MediaGroupContext } from "@/components/media/media-group-state";
import { MediaStrip } from "@/components/media/media-strip";
import { extractMediaRefsFromMarkdown } from "@/lib/media/media-ref";

export const MediaMessageScope = ({
  text,
  baseDir,
  streaming = false,
  showStrip = true,
  children,
}: {
  text: string;
  baseDir?: string;
  streaming?: boolean;
  /** 是否在正文后渲染媒体条 */
  showStrip?: boolean;
  children: ReactNode;
}) => {
  const refs = useMemo(
    () => (streaming ? [] : extractMediaRefsFromMarkdown(text, baseDir)),
    [text, baseDir, streaming],
  );
  // Provider 始终存在（哪怕没有引用）：流式 → 定稿时 children（MarkdownText）的树位置不变，不会被卸载重挂
  return (
    <MediaGroupContext.Provider value={refs.length > 0 ? refs : null}>
      {children}
      {showStrip && refs.length > 0 && <MediaStrip refs={refs} />}
    </MediaGroupContext.Provider>
  );
};
