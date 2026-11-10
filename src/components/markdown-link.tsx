"use client";

/**
 * markdown 里 <a> 的统一渲染器（V0.7.7、事件流 MarkdownText + artifact-panel 共用）
 *
 * 背景：AI 回复里的链接此前渲染成裸 <a>（同 frame 导航）——桌面端点相对路径
 * 链接会把当前窗口跳到 404、用户实测「点了没反应」。统一规则：
 * - http / https 绝对链接 → 默认在当前任务的内置浏览器新标签打开（设置「链接默认打开方式」，默认内置）；
 *   自动回退新窗口 / 系统浏览器（`<a target=_blank>`；Electron 壳的 setWindowOpenHandler 拦下转系统默认浏览器）的情况：
 *   选了系统浏览器、非桌面端、当前页面没有任务、登录授权类链接、Flowship 自己的地址、按住 ⌘ / Ctrl / Shift / Alt 点击。
 *   右键菜单：在内置浏览器打开 / 在系统浏览器打开 / 复制链接
 * - 本地绝对路径且是**图片**（v1.0、AI 生成二维码 / 图表场景）→ 可点、
 *   站内 lightbox 预览（走 /api/local-image 通道）
 * - 本地绝对路径且是**音视频**（可带 `#t=12.4,15` 时间片段）→ 可点、进全局播放器悬浮窗
 * - 其它（相对路径 / file:// 等 AI 幻觉链接、点了必 404）→ 渲染成等宽纯文本、
 *   不可点、保留可复制
 */

import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { Copy, ExternalLink, Globe } from "lucide-react";
import { toast } from "sonner";

import { openHttpInBuiltin, openHttpInSystem } from "@/components/browser/open-in-builtin";
import { useBrowserAvailable } from "@/components/browser/use-browser-session";
import { MediaPathChip } from "@/components/media/media-path-chip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { InsideInteractive, useImagePreview } from "@/components/ui/image-preview";
import { Tooltip } from "@/components/ui/tooltip";
import { toLoadableImageSrc } from "@/lib/local-image-src";
import { parseMediaRefToken, resolveMediaRef } from "@/lib/media/media-ref";
import { isUncLikePath } from "@/lib/unc-path";

const CLICKABLE = /^https?:\/\//;
// 本地绝对路径（POSIX / Windows 盘符、含 file:// 前缀）+ 图片扩展名
const LOCAL_IMAGE = /^(file:\/\/)?(\/|[a-zA-Z]:[\\/]).*\.(png|jpe?g|webp|gif|bmp)$/i;
// 本地绝对路径（POSIX / Windows 盘符、含 file:// 前缀）：音视频判定交给 parseMediaRefToken（含 #t= 片段）
const LOCAL_ABS = /^(file:\/\/)?(\/|[a-zA-Z]:[\\/])/;

/** markdown 链接 href → 音视频引用（href 里的空格等可能被编码成 %20，先解码） */
const resolveMediaHref = (href: string | undefined) => {
  if (!href || !LOCAL_ABS.test(href) || isUncLikePath(href)) return null;
  let decoded = href;
  try {
    decoded = decodeURI(href);
  } catch {
    // 编码残缺：按原样试
  }
  const ref = parseMediaRefToken(decoded.startsWith("file://") ? decoded.slice("file://".length) : decoded);
  return ref ? resolveMediaRef(ref) : null;
};

export const MarkdownLink = ({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => {
  // react-markdown 给 components.a 传 AST node、不能透传给 DOM 元素；解构剥离、不就地改 props
  const { node, ...domProps } = rest;
  void node;
  const { open } = useImagePreview();
  const builtinBridge = useBrowserAvailable();
  const media = resolveMediaHref(href);
  if (media) {
    return (
      <MediaPathChip absolute={media.absolute} start={media.start} end={media.end} className="text-[0.9em]">
        {children}
      </MediaPathChip>
    );
  }
  // UNC 形态（`//host/a.png`）虽然匹配 LOCAL_IMAGE，但被安全守卫有意挡掉、src 会是空串——
  // 不进可点的灯箱按钮（点开是空白全屏），落到下面的纯文本分支，路径仍可见 / 可复制（R12-03）
  if (href && LOCAL_IMAGE.test(href) && !isUncLikePath(href)) {
    const src = toLoadableImageSrc(href);
    return (
      <Tooltip content={`预览图片：${href}`}>
        <button
          type="button"
          onClick={() => open([{ src, alt: href }])}
          className="cursor-zoom-in font-mono text-[0.9em] text-primary underline-offset-2 hover:underline"
        >
          <InsideInteractive>{children}</InsideInteractive>
        </button>
      </Tooltip>
    );
  }
  if (!href || !CLICKABLE.test(href)) {
    return (
      <Tooltip content={href}>
        <span className="font-mono text-[0.9em] text-foreground">
          {children}
        </span>
      </Tooltip>
    );
  }
  const onLinkClick = (e: MouseEvent<HTMLAnchorElement>) => {
    domProps.onClick?.(e);
    if (e.defaultPrevented) return;
    // 修饰键点击 = 用户明确要系统浏览器 / 新窗口的惯例：不拦，走 <a target=_blank>
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (openHttpInBuiltin(href) === "builtin") e.preventDefault();
  };
  const openBuiltinFromMenu = () => {
    // 环境不允许（没有任务 / 站内地址…）时 openHttpInBuiltin 返回 system：照样给用户打开，别吞掉这次点击
    if (openHttpInBuiltin(href, { forceBuiltin: true }) === "system") openHttpInSystem(href);
  };
  const copyLink = () => {
    void navigator.clipboard.writeText(href).then(
      () => toast.success("已复制链接"),
      () => toast.error("复制失败"),
    );
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span className="inline" />}>
        <a href={href} target="_blank" rel="noopener noreferrer" {...domProps} onClick={onLinkClick}>
          <InsideInteractive>{children}</InsideInteractive>
        </a>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        {builtinBridge && (
          <ContextMenuItem onClick={openBuiltinFromMenu}>
            <Globe className="size-3.5" />
            在内置浏览器打开
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => openHttpInSystem(href)}>
          <ExternalLink className="size-3.5" />
          在系统浏览器打开
        </ContextMenuItem>
        <ContextMenuItem onClick={copyLink}>
          <Copy className="size-3.5" />
          复制链接
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};
