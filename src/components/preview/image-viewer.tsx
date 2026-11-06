"use client";

/**
 * 图片查看器（png / jpg / gif / webp / bmp / svg）
 *
 * 滚轮以指针为锚点缩放、拖拽平移、双击在「适应窗口 / 100%」间切换、90° 旋转、
 * 透明底图可切棋盘格背景、放大到 ≥300% 时像素不插值（看像素画 / 二维码更清楚）。
 * 缩放 / 平移数学在 lib/preview/zoom（纯函数，有单测）；这里只管事件与布局。
 *
 * <img> 的 src 只来自调用方：本机图片通道（mediaPath）或 SVG 文本生成的 blob URL。
 * 放在 <img> 里的 SVG 不会执行脚本、也不加载外部资源，这是预览 SVG 的安全前提——不要改成 inline / iframe / object。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FlipHorizontal2, Maximize, RotateCcw, RotateCw, ScanSearch, ZoomIn, ZoomOut } from "lucide-react";

import { Dot, PreviewToolbar, TextButton, ToolButton } from "@/components/preview/preview-ui";
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
}

const CHECKER_STYLE = {
  backgroundImage: "repeating-conic-gradient(var(--muted) 0% 25%, transparent 0% 50%)",
  backgroundSize: "16px 16px",
} as const;

export const ImageViewer = ({ src, alt, size, leading }: ImageViewerProps) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [rotation, setRotation] = useState(0);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [fit, setFit] = useState(true);
  const [checker, setChecker] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);
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

  const onKeyDown = (e: React.KeyboardEvent) => {
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
          </>
        }
      />
      <div
        ref={boxRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
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
      </div>
    </div>
  );
};
