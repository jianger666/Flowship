"use client";

/**
 * markdown 里 <a> 的统一渲染器（V0.7.7、事件流 MarkdownText + artifact-panel 共用）
 *
 * 背景：AI 回复里的链接此前渲染成裸 <a>（同 frame 导航）——桌面端点相对路径
 * 链接会把当前窗口跳到 404、用户实测「点了没反应」。统一规则：
 * - http / https 绝对链接 → 新窗口打开（浏览器开新 tab；Electron 壳的
 *   setWindowOpenHandler 拦下转系统默认浏览器）
 * - 其它（相对路径 / file:// 等 AI 幻觉链接、点了必 404）→ 渲染成等宽纯文本、
 *   不可点、保留可复制
 */

import type { AnchorHTMLAttributes } from "react";

const CLICKABLE = /^https?:\/\//;

export const MarkdownLink = ({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => {
  // react-markdown 给 components.a 传 AST node、不能透传给 DOM 元素
  delete rest.node;
  if (!href || !CLICKABLE.test(href)) {
    return (
      <span className="font-mono text-[0.9em] text-foreground/80" title={href}>
        {children}
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
};
