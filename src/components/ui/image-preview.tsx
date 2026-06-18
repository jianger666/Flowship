"use client";

/**
 * 统一图片组件 + 站内全屏预览（lightbox）
 *
 * 全站涉及图片展示的地方（贴图缩略图、事件流已发送图、context-docs 图片 doc）统一走 `ImageThumb`、
 * 点击在站内弹大图（不再 `<a target="_blank">` 跳系统浏览器——Electron 壳里那是跳出 app、体验差）。
 *
 * 组成：
 * - `ImagePreviewProvider`：挂在 providers.tsx 根、持 lightbox 状态、渲染全屏 overlay
 * - `useImagePreview()`：暴露 `open(images, index)`、任意组件可手动唤起
 * - `ImageThumb`：统一缩略图（点击进 lightbox、可选 onRemove 显示移除 X、可传同组图支持左右切换）
 *
 * lightbox 自绘（不引库）：点背景 / Esc / 右上 X 关、多图左右切换 + 键盘 ←→、open 期间锁 body 滚动。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { cn } from "@/lib/utils";

export interface PreviewImage {
  src: string;
  alt?: string;
  title?: string;
}

interface ImagePreviewContextValue {
  /** 打开 lightbox：传整组图 + 初始索引（单图传长度 1 的数组即可） */
  open: (images: PreviewImage[], index?: number) => void;
}

const ImagePreviewContext = createContext<ImagePreviewContextValue | null>(null);

export const useImagePreview = (): ImagePreviewContextValue => {
  const ctx = useContext(ImagePreviewContext);
  if (!ctx) {
    throw new Error("useImagePreview 必须在 ImagePreviewProvider 内使用");
  }
  return ctx;
};

interface PreviewState {
  images: PreviewImage[];
  index: number;
}

export const ImagePreviewProvider = ({ children }: { children: ReactNode }) => {
  // 当前预览态：null = 关闭；非 null = 展示 images[index]
  const [state, setState] = useState<PreviewState | null>(null);

  const open = useCallback((images: PreviewImage[], index = 0) => {
    if (images.length === 0) return;
    setState({
      images,
      index: Math.max(0, Math.min(index, images.length - 1)),
    });
  }, []);

  const close = useCallback(() => setState(null), []);

  // 切换：环形（首尾相接）、delta=-1 上一张 / +1 下一张
  const go = useCallback((delta: number) => {
    setState((s) => {
      if (!s) return s;
      const n = s.images.length;
      return { ...s, index: (s.index + delta + n) % n };
    });
  }, []);

  // 键盘 Esc 关 / ←→ 切换；open 期间锁 body 滚动（关了还原）
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [state, close, go]);

  const current = state?.images[state.index];
  const multi = (state?.images.length ?? 0) > 1;

  return (
    <ImagePreviewContext.Provider value={{ open }}>
      {children}
      {state && current && (
        // z 取高于 Dialog（base-ui dialog 约 z-50）、保证从弹窗里点图也能盖住
        <div
          className="fixed inset-0 z-200 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={close}
          role="dialog"
          aria-modal="true"
        >
          {/* 关闭（右上角） */}
          <button
            type="button"
            onClick={close}
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
            aria-label="关闭"
          >
            <X className="size-5" />
          </button>

          {/* 多图：左右切换（垂直居中、不跟右上关闭冲突）+ 底部计数 */}
          {multi && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  go(-1);
                }}
                className="absolute left-4 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                aria-label="上一张"
              >
                <ChevronLeft className="size-6" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  go(1);
                }}
                className="absolute right-4 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                aria-label="下一张"
              >
                <ChevronRight className="size-6" />
              </button>
              <div className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white">
                {state.index + 1} / {state.images.length}
              </div>
            </>
          )}

          {/* 大图：点图本身不关（只点背景关） */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.src}
            alt={current.alt ?? ""}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] max-w-[90vw] rounded-md object-contain shadow-2xl"
          />
        </div>
      )}
    </ImagePreviewContext.Provider>
  );
};

interface ImageThumbProps {
  /** 缩略图 src（一般跟大图同源、内部静态 / dataUrl 都行） */
  src: string;
  alt?: string;
  /** 悬浮提示（默认用 alt） */
  title?: string;
  /** 缩略图框样式（覆盖默认 size-14 rounded-md border bg-card） */
  className?: string;
  /** img 元素样式（覆盖默认 size-full object-cover） */
  imgClassName?: string;
  /** 传了就在右上角显示移除 X（发送前预览用） */
  onRemove?: () => void;
  /** 同组图（lightbox 内左右切换整组）；不传则只预览自己 */
  group?: PreviewImage[];
  /** 自己在 group 里的索引 */
  index?: number;
  /** 大图源（默认 = src；缩略图和大图不同源时传） */
  previewSrc?: string;
}

export const ImageThumb = ({
  src,
  alt,
  title,
  className,
  imgClassName,
  onRemove,
  group,
  index = 0,
  previewSrc,
}: ImageThumbProps) => {
  const { open } = useImagePreview();

  const handleOpen = () => {
    if (group && group.length > 0) open(group, index);
    else open([{ src: previewSrc ?? src, alt, title }], 0);
  };

  return (
    <div
      className={cn(
        "group relative size-14 overflow-hidden rounded-md border bg-card",
        className,
      )}
      title={title ?? alt}
    >
      <button
        type="button"
        onClick={handleOpen}
        className="block size-full cursor-zoom-in"
        aria-label="查看大图"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt ?? ""}
          loading="lazy"
          className={cn("size-full object-cover", imgClassName)}
        />
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
          aria-label="移除"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
};

/**
 * markdown 正文里的图片（`![alt](src)`）统一渲染器——给 ReactMarkdown 的 `components={{ img }}`。
 *
 * markdown 图按自然尺寸内联展示（不是固定缩略图）、但同样点击进 lightbox 看大图。
 * 所有 ReactMarkdown 实例都要配上、否则 markdown 里的图会退回不可预览的原生 <img>。
 */
export const MarkdownImage = ({
  src,
  alt,
  title,
}: {
  src?: string | Blob;
  alt?: string;
  title?: string;
}) => {
  const { open } = useImagePreview();
  // src 可能是 string（url / dataUrl）；react-markdown 类型上带 Blob、运行时基本是 string
  const url = typeof src === "string" ? src : "";
  if (!url) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt ?? ""}
      title={title ?? alt}
      loading="lazy"
      onClick={() => open([{ src: url, alt, title }])}
      className="my-2 max-h-80 max-w-full cursor-zoom-in rounded-md border object-contain"
    />
  );
};
