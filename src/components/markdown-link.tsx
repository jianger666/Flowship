"use client";

/**
 * markdown 里 <a> 的统一渲染器（V0.7.7、事件流 MarkdownText + artifact-panel 共用）
 *
 * 背景：AI 回复里的链接此前渲染成裸 <a>（同 frame 导航）——桌面端点相对路径
 * 链接会把当前窗口跳到 404、用户实测「点了没反应」。统一规则：
 * - http / https 绝对链接 → 新窗口打开（浏览器开新 tab；Electron 壳的
 *   setWindowOpenHandler 拦下转系统默认浏览器）
 * - 本地绝对路径且是**图片**（v1.0、AI 生成二维码 / 图表场景）→ 可点、
 *   站内 lightbox 预览（走 /api/local-image 通道）
 * - 其它（相对路径 / file:// 等 AI 幻觉链接、点了必 404）→ 渲染成等宽纯文本、
 *   不可点、保留可复制
 */

import type { AnchorHTMLAttributes } from "react";

import { useImagePreview } from "@/components/ui/image-preview";

const CLICKABLE = /^https?:\/\//;
// 本地绝对路径（POSIX / Windows 盘符、含 file:// 前缀）+ 图片扩展名
const LOCAL_IMAGE = /^(file:\/\/)?(\/|[a-zA-Z]:[\\/]).*\.(png|jpe?g|webp|gif|bmp)$/i;

export const MarkdownLink = ({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => {
  // react-markdown 给 components.a 传 AST node、不能透传给 DOM 元素；解构剥离、不就地改 props
  const { node, ...domProps } = rest;
  void node;
  const { open } = useImagePreview();
  if (href && LOCAL_IMAGE.test(href)) {
    const p = href.startsWith("file://") ? href.slice("file://".length) : href;
    const src = `/api/local-image?path=${encodeURIComponent(p)}`;
    return (
      <button
        type="button"
        onClick={() => open([{ src, alt: p }])}
        title={`预览图片：${p}`}
        className="cursor-zoom-in font-mono text-[0.9em] text-primary underline-offset-2 hover:underline"
      >
        {children}
      </button>
    );
  }
  if (!href || !CLICKABLE.test(href)) {
    return (
      <span className="font-mono text-[0.9em] text-foreground/80" title={href}>
        {children}
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...domProps}>
      {children}
    </a>
  );
};
