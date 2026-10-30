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
 * lightbox 自绘（不引库）：点背景 / Esc / 右上 X 关、多图左右切换 + 键盘 ←→、open 期间锁 body 滚动；
 * 打开时焦点移进灯箱（`ImageLightbox`）、关闭时还给触发它的元素。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import { useTitleBarOverlayDim } from "@/hooks/use-titlebar-overlay-dim";
import { toLoadableImageSrc } from "@/lib/local-image-src";
import { isUncLikePath } from "@/lib/unc-path";
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

/**
 * 外层已经是链接 / 按钮时为 true（`[![alt](img)](href)` 的徽章 / 二维码写法）。
 * MarkdownImage 据此退回改前的 `<img onClick>`：button 套 a / button 是无效 HTML、多一个 Tab 停靠点，
 * 焦点在内层按钮上按 Enter 还会同时触发灯箱和链接。
 */
const InsideInteractiveContext = createContext(false);

/** 包住链接 / 按钮的子内容（markdown-link.tsx 用）；本身不渲染任何 DOM */
export const InsideInteractive = ({ children }: { children: ReactNode }) => (
  <InsideInteractiveContext.Provider value>{children}</InsideInteractiveContext.Provider>
);

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

interface ImageLightboxProps {
  images: PreviewImage[];
  index: number;
  onClose: () => void;
  /** 环形切换：-1 上一张 / +1 下一张 */
  onGo: (delta: number) => void;
}

/**
 * 全屏灯箱本体。从 Provider 里抽出来（导出仅为测试能直接渲染 / 驱动它），好让「打开时把焦点移进来、
 * 关闭时还给原来的元素」跟着灯箱的挂载 / 卸载走（R14 Q19-02）：
 *  - 以前打开后焦点还留在触发它的缩略图上：键盘 / 读屏用户按 Tab 会在被遮住的页面里乱跳，关闭后焦点也丢了；
 *  - 焦点放在容器上（tabIndex=-1），不放关闭键：用空格键「打开」要到松开时才算一次点击，
 *    焦点若已落在关闭键上，松开空格就把刚打开的灯箱又关掉；
 *  - effect 依赖写死 []：只在挂载 / 卸载各跑一次，左右切图（还是同一个灯箱实例）不会把焦点抢回来。
 */
export const ImageLightbox = ({ images, index, onClose, onGo }: ImageLightboxProps) => {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    return () => {
      // 触发它的元素可能已经不在页面上了（比如点开的那张缩略图被重渲染掉）：不在就不还
      if (prev?.isConnected) prev.focus();
    };
  }, []);

  const current = images[index];
  if (!current) return null;
  const multi = images.length > 1;

  return (
    // z 取高于 Dialog（base-ui dialog 约 z-50）、保证从弹窗里点图也能盖住
    // [-webkit-app-region:no-drag]：灯箱盖在 header 的拖拽区上，而 Electron 的拖拽区按像素矩形算、不看 z-index，
    // 不显式 no-drag 的话顶部那一条（含关闭键）点不动、只会拖窗口
    <div
      ref={rootRef}
      className="fixed inset-0 z-200 flex items-center justify-center bg-black/80 backdrop-blur-sm outline-none [-webkit-app-region:no-drag]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      tabIndex={-1}
    >
      {/* 关闭（右上角）：top-16 = 64px，落在 Windows 系统窗口按钮条（titleBarOverlay，高 56px）下面——
          原来的 top-4 正好被那条盖住，点不到 */}
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-16 flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
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
              onGo(-1);
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
              onGo(1);
            }}
            className="absolute right-4 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
            aria-label="下一张"
          >
            <ChevronRight className="size-6" />
          </button>
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white">
            {index + 1} / {images.length}
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
  );
};

export const ImagePreviewProvider = ({ children }: { children: ReactNode }) => {
  // 当前预览态：null = 关闭；非 null = 展示 images[index]
  const [state, setState] = useState<PreviewState | null>(null);
  // Windows：全屏 lightbox 同样盖不住原生 titleBarOverlay，打开时压暗按钮条
  useTitleBarOverlayDim(!!state);

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
  // ⚠️ capture 阶段监听 + ESC 时 stopImmediatePropagation：lightbox 永远在最上层
  // （z-200、常常从 base-ui Dialog 里点图唤起）、ESC 必须抢在底层 Dialog 的 dismiss
  // 处理之前关掉自己、并拦住事件别让它继续传到 Dialog——否则会出现用户实测的反向顺序
  // 「第一次 ESC 关了底层再聊聊弹窗、第二次 ESC 才关图片预览」。capture 让本监听最先拿到
  // 事件、stopImmediatePropagation 切断后续所有 keydown 监听（含 base-ui 挂 document 上的）。
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      } else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [state, close, go]);

  return (
    <ImagePreviewContext.Provider value={{ open }}>
      {children}
      {state && (
        <ImageLightbox images={state.images} index={state.index} onClose={close} onGo={go} />
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
    // 悬浮提示走 Tooltip（规范：不用原生 title=）；content 为空时 Tooltip 直接返回子元素
    <Tooltip content={title ?? alt}>
      <div
        className={cn(
          "group relative size-14 overflow-hidden rounded-md border bg-card",
          className,
        )}
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
    </Tooltip>
  );
};

/**
 * markdown 正文里的图片（`![alt](src)`）统一渲染器——给 ReactMarkdown / Streamdown 的 `components={{ img }}`。
 *
 * markdown 图按自然尺寸内联展示（不是固定缩略图）、但同样点击进 lightbox 看大图。
 * 所有 Streamdown 实例都要配上 a+img（+ rehypeRewriteLocalImages）；本地路径转换见
 * `@/lib/local-image-src`（AST 层 sanitize 前也会改写，防 file:// 被剥掉）。
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
  const insideInteractive = useContext(InsideInteractiveContext);
  // src 可能是 string（url / dataUrl）；react-markdown 类型上带 Blob、运行时基本是 string
  const url = typeof src === "string" ? toLoadableImageSrc(src) : "";
  if (!url) {
    // UNC 形态是被安全守卫有意挡掉的（见 lib/unc-path）：别静默吞成空白，给个看得见的占位（R12-03），
    // 与 BlockedMarkdownImage 同款朴素文案
    if (typeof src === "string" && isUncLikePath(src)) {
      return <span className="text-muted-foreground">[图片：网络路径不支持预览]</span>;
    }
    return null;
  }
  if (insideInteractive) {
    // 外层已是链接 / 按钮：保持改前的写法（img 自己带 onClick），不再套 button
    return (
      <Tooltip content={title ?? alt}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={alt ?? ""}
          loading="lazy"
          onClick={() => open([{ src: url, alt, title }])}
          className="my-2 max-h-80 max-w-full cursor-zoom-in rounded-md border object-contain"
        />
      </Tooltip>
    );
  }
  // 点开大图的是一个真 <button>（R14 Q19-02）：以前是 <img onClick>——键盘 Tab 不到、读屏也不报「可点」，
  // 灯箱对只用键盘的人整个不可达；名字带上图的 alt，读屏才知道点的是哪一张
  return (
    <Tooltip content={title ?? alt}>
      <button
        type="button"
        onClick={() => open([{ src: url, alt, title }])}
        aria-label={alt ? `查看大图:${alt}` : "查看大图"}
        className="block w-fit max-w-full cursor-zoom-in"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={alt ?? ""}
          loading="lazy"
          className="my-2 max-h-80 max-w-full rounded-md border object-contain"
        />
      </button>
    </Tooltip>
  );
};
