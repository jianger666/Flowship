"use client";

/**
 * 图片查看器（png / jpg / gif / webp / bmp / svg）
 *
 * 滚轮以指针为锚点缩放、拖拽平移、双击在「适应窗口 / 100%」间切换、90° 旋转、
 * 透明底图可切棋盘格背景、放大到 ≥300% 时像素不插值（看像素画 / 二维码更清楚）。
 * 缩放 / 平移数学在 lib/preview/zoom（纯函数，有单测）；这里只管事件与布局。
 *
 * 复制图片（R7-10）：工具栏按钮 / 图片区右键菜单 / 图片区聚焦时 ⌘C·Ctrl+C，三条入口都走同一个 `copyOriginal`，
 * 底层是 lib/copy-image 的 `copyImageToClipboard`（`<img>` 加载 → canvas → PNG → clipboard.write，没有第二套）。
 * 复制的永远是**原图**（`src` 原样；不含当前的缩放 / 平移 / 旋转 / 翻转 / 棋盘格），GIF / 动图只复制第一帧。
 *
 * <img> 的 src 只来自调用方：本机图片通道（mediaPath）或 SVG 文本生成的 blob URL。
 * 放在 <img> 里的 SVG 不会执行脚本、也不加载外部资源，这是预览 SVG 的安全前提——不要改成 inline / iframe / object。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Copy,
  FlipHorizontal2,
  Maximize,
  RotateCcw,
  RotateCw,
  ScanSearch,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";

import { Dot, PreviewToolbar, TextButton, ToolButton } from "@/components/preview/preview-ui";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useCanCopyImage } from "@/hooks/use-can-copy-image";
import { useShellPlatform } from "@/hooks/use-shell-platform";
import { copyImageToClipboard } from "@/lib/copy-image";
import { getModShortcutLabel, isModCombo } from "@/lib/keyboard-shortcuts";
import { formatBytes } from "@/lib/preview/format";
import { clampScale, fitScale, rotateBy, wheelFactor, zoomAt, type View } from "@/lib/preview/zoom";
import { cn } from "@/lib/utils";

export interface ImageViewerProps {
  src: string;
  alt: string;
  /** 文件大小（字节），显示在工具栏 */
  size?: number;
  /** 工具栏最左侧（svg 的「图像 / 源码」页签） */
  leading?: ReactNode;
  /** 矢量图（SVG）：复制时小图标放大后再栅格化、无固有尺寸按显示用的兜底尺寸画（见 lib/copy-image） */
  vector?: boolean;
}

/** 复制成功后图标切成对勾的时长（与站内其它复制按钮同一做法：切勾 → 定时回落 → 卸载时清定时器） */
const COPIED_FEEDBACK_MS = 1500;

const CHECKER_STYLE = {
  backgroundImage: "repeating-conic-gradient(var(--muted) 0% 25%, transparent 0% 50%)",
  backgroundSize: "16px 16px",
} as const;

export const ImageViewer = ({ src, alt, size, leading, vector }: ImageViewerProps) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [rotation, setRotation] = useState(0);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [fit, setFit] = useState(true);
  const [checker, setChecker] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);
  // 复制：环境支持（SSR / 水合首帧恒 false）、在途（按钮置灰）、刚复制完（图标切勾）
  const canCopy = useCanCopyImage();
  const platform = useShellPlatform();
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  // 在途保护再加一层 ref：连按 ⌘C 时两次 keydown 可能共用同一份（还没重渲的）闭包，光靠 state 拦不住
  const copyingRef = useRef(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);
  const dragRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  // wheel 监听器是原生（passive:false）的，闭包里要读最新 view：用 ref 镜像
  const viewRef = useRef(view);
  viewRef.current = view;

  // 容器尺寸（弹窗放大 / 缩小也要跟）
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // src 变了（文件被重新加载）：回到「适应窗口」
  useEffect(() => {
    setNatural(null);
    setFailed(false);
    setRotation(0);
    setFit(true);
    setView({ scale: 1, x: 0, y: 0 });
  }, [src]);

  // 适应窗口模式下，随容器 / 旋转 / 图片尺寸重新算比例
  useEffect(() => {
    if (!fit || !natural) return;
    setView({ scale: fitScale(natural, box, rotation), x: 0, y: 0 });
  }, [fit, natural, box, rotation]);

  const zoomBy = useCallback((factor: number, px = 0, py = 0) => {
    setFit(false);
    setView((v) => zoomAt(v, v.scale * factor, px, py));
  }, []);

  // 滚轮缩放：React 的 onWheel 是 passive 的（preventDefault 无效、页面会跟着滚），必须原生非 passive 监听
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - rect.width / 2;
      const py = e.clientY - rect.top - rect.height / 2;
      setFit(false);
      setView(zoomAt(viewRef.current, viewRef.current.scale * wheelFactor(e.deltaY), px, py));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const actualSize = () => {
    setFit(false);
    setView({ scale: 1, x: 0, y: 0 });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    setFit(false);
    setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.id === e.pointerId) {
      dragRef.current = null;
      setDragging(false);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!natural || !boxRef.current) return;
    const rect = boxRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;
    const fitted = fitScale(natural, box, rotation);
    if (fit) {
      // 现在是「适应窗口」：双击放大（图比窗口大 → 100%；本来就小 → 翻倍），锚在点击处；再双击回到适应窗口
      setFit(false);
      setView(zoomAt({ scale: fitted, x: 0, y: 0 }, fitted < 1 ? 1 : fitted * 2, px, py));
    } else {
      setFit(true);
    }
  };

  // 图片没加载出来 / 加载失败 / 环境不支持 / 上一次还在途：不能复制（按钮置灰、菜单项禁用、快捷键与 copy 事件不调用）
  const copyDisabled = !canCopy || !natural || failed || copying;

  /** 复制原图：三条入口（按钮 / 右键菜单 / 快捷键）共用。`src` 原样传下去，不是旋转后的、也不是别的 */
  const copyOriginal = () => {
    if (!canCopy || !natural || failed || copyingRef.current) return;
    copyingRef.current = true;
    setCopying(true);
    // fallbackSize = 查看器显示用的尺寸（SVG 缺固有尺寸时已是 300×150 兜底）；vector 由调用方（SvgViewer）声明
    void copyImageToClipboard(src, { fallbackSize: natural, vector }).then(
      () => {
        copyingRef.current = false;
        setCopying(false);
        toast.success("已复制图片");
        setCopied(true);
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
      },
      (e: unknown) => {
        copyingRef.current = false;
        setCopying(false);
        toast.error(e instanceof Error ? e.message : "复制图片失败");
      },
    );
  };

  // 提示随状态变；aria-label 一直是「复制图片」。快捷键只在真能复制时才写（不能复制时写了是骗人）
  const copyTooltip = !canCopy
    ? "当前环境不支持复制图片"
    : failed
      ? "图片加载失败，无法复制"
      : !natural
        ? "图片加载完成后才能复制"
        : copied
          ? "已复制"
          : "复制原图";
  const copyShortcut = canCopy && natural && !failed ? getModShortcutLabel(platform, "C") : undefined;

  // 菜单栏「编辑 ▸ 拷贝」（mac 的 `role: copy` → webContents.copy()）不经 keydown，而是直接给聚焦元素派发 copy 事件
  // （真 Electron 实测：target 就是下面这个图片区 div）。图片区是 select-none、没有可复制的文字，默认动作什么也不复制——
  // 这里接成「复制原图」，菜单栏的「拷贝」与 ⌘C 同一个结果。keydown 命中 ⌘C 时已 preventDefault，不会再派发 copy，不会复制两次
  const onCopy = (e: React.ClipboardEvent) => {
    e.preventDefault();
    copyOriginal();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // ⌘C（mac 只认 ⌘；其它平台 Ctrl / Meta）= 复制原图。只在命中时 preventDefault，其它按键走下面原有的分支、不受影响
    if (isModCombo(e, "c")) {
      e.preventDefault();
      copyOriginal();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomBy(1.25);
    else if (e.key === "-" || e.key === "_") zoomBy(0.8);
    else if (e.key === "0") setFit(true);
    else if (e.key === "1") actualSize();
    else if (e.key === "r" || e.key === "R") setRotation((r) => rotateBy(r, e.shiftKey ? -90 : 90));
    else return;
    e.preventDefault();
  };

  const percent = Math.round(view.scale * 100);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PreviewToolbar
        left={
          <>
            {leading}
            <span className="tabular-nums">{natural ? `${natural.w} × ${natural.h}` : "—"}</span>
            {size != null && (
              <>
                <Dot />
                <span>{formatBytes(size)}</span>
              </>
            )}
          </>
        }
        right={
          <>
            <ToolButton label="缩小" shortcut="-" onClick={() => zoomBy(0.8)}>
              <ZoomOut />
            </ToolButton>
            <TextButton onClick={actualSize} className="min-w-12 justify-center tabular-nums">
              {percent}%
            </TextButton>
            <ToolButton label="放大" shortcut="+" onClick={() => zoomBy(1.25)}>
              <ZoomIn />
            </ToolButton>
            <ToolButton label="适应窗口" shortcut="0" onClick={() => setFit(true)} active={fit}>
              <Maximize />
            </ToolButton>
            <ToolButton label="实际大小（100%）" shortcut="1" onClick={actualSize}>
              <ScanSearch />
            </ToolButton>
            <ToolButton label="向左旋转 90°" shortcut="Shift+R" onClick={() => setRotation((r) => rotateBy(r, -90))}>
              <RotateCcw />
            </ToolButton>
            <ToolButton label="向右旋转 90°" shortcut="R" onClick={() => setRotation((r) => rotateBy(r, 90))}>
              <RotateCw />
            </ToolButton>
            <ToolButton label="棋盘格背景（看透明区域）" onClick={() => setChecker((v) => !v)} active={checker}>
              <FlipHorizontal2 />
            </ToolButton>
            {/* 复制的是原图（不含缩放 / 旋转），提示里写明，免得以为复制的是眼前这个视图 */}
            <ToolButton
              label="复制图片"
              tooltip={copyTooltip}
              shortcut={copyShortcut}
              onClick={copyOriginal}
              disabled={copyDisabled}
            >
              {copied ? <Check className="text-success" /> : <Copy />}
            </ToolButton>
          </>
        }
      />
      {/* 右键菜单包住整个图片区（不只 <img>：缩得很小 / 旋转后 <img> 的命中区会变小）。
          Trigger 用 render 直接「变成」下面这个图片区 div（ref / 键盘 / 拖拽处理器都原样合并过去）。
          菜单弹层（ContextMenuContent）是 Trigger 的兄弟、不在图片区 DOM / React 子树里——点菜单不会触发图片区的
          onPointerDown / onDoubleClick。onPointerDown 只认左键（button 0），右键不会开始拖拽 / setPointerCapture。 */}
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              ref={boxRef}
              tabIndex={0}
              onKeyDown={onKeyDown}
              onCopy={onCopy}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={onDoubleClick}
              style={checker ? CHECKER_STYLE : undefined}
              className={cn(
                "relative min-h-0 flex-1 touch-none overflow-hidden bg-muted/30 outline-none select-none focus-visible:ring-1 focus-visible:ring-ring",
                dragging ? "cursor-grabbing" : "cursor-grab",
              )}
            />
          }
        >
          {failed ? (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-destructive">图片加载失败</p>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={alt}
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  // 没有固有尺寸的 SVG：浏览器给 0（或 Firefox 的 300×150 缺省）——用 300×150 兜底，至少能显示
                  setNatural({ w: img.naturalWidth || 300, h: img.naturalHeight || 150 });
                }}
                onError={() => setFailed(true)}
                style={{
                  maxWidth: "none",
                  flexShrink: 0,
                  transform: `translate(${view.x}px, ${view.y}px) scale(${clampScale(view.scale)}) rotate(${rotation}deg)`,
                  imageRendering: view.scale >= 3 ? "pixelated" : "auto",
                  visibility: natural ? "visible" : "hidden",
                }}
              />
            </div>
          )}
        </ContextMenuTrigger>
        {/* 弹窗（dialog.tsx 的外层 fixed 容器是 z-50）里弹菜单：菜单也是 portal 到 body 的 z-50，靠「后挂载」才盖得住——
            不靠挂载顺序，positionerClassName 显式抬到 z-60（tests/image-viewer-copy.test.ts 钉着它必须高于弹窗） */}
        <ContextMenuContent positionerClassName="z-60" className="min-w-36">
          <ContextMenuItem disabled={copyDisabled} onClick={copyOriginal}>
            <Copy className="size-3.5" />
            复制图片
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};
