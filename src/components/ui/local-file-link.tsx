"use client";

/**
 * 本地路径链接：展示 pathDisplayLabel、hover 全路径；按文件意图进入浏览器、IDE 或预览弹窗
 *
 * 与 IdePathLink 共用 baseDir 解析；拼不出绝对路径 → 纯文本（同退化原则）。
 */

import { useCallback, useMemo, type MouseEvent, type ReactNode } from "react";
import {
  Code2,
  Copy,
  ExternalLink,
  Eye,
  FolderOpen,
  Globe,
  MoreHorizontal,
} from "lucide-react";
import { toast } from "sonner";

import {
  openLocalHtmlInBuiltin,
  readLinkOpenMode,
} from "@/components/browser/open-in-builtin";
import { useBrowserAvailable } from "@/components/browser/use-browser-session";
import { useMediaGroup } from "@/components/media/media-group-state";
import {
  resolveLocalFileAbsolute,
  useLocalFilePreview,
} from "@/components/ui/local-file-preview-context";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLinkItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { getIdeAnchorProps } from "@/lib/ide-open";
import {
  canOpenInIde,
  canPreviewInSheet,
  detectLocalFileKind,
  resolveLocalFileOpenTarget,
  shouldOpenLocalFileInBrowser,
} from "@/lib/local-file-kind";
import {
  requestOpenLocalPath,
  requestRevealLocalPath,
} from "@/lib/local-file-open";
import { openMediaInGroup } from "@/lib/media/media-open";
import { pathDisplayLabel } from "@/lib/path-utils";
import { JUMP_IDE_LABEL } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface LocalFilePathLinker {
  /** 拼得出绝对路径 → 目标；拼不出 → null */
  resolveFor: (pathLike: string, line?: number) => { absolute: string; line?: number } | null;
  baseDir?: string;
}

/** 一块 UI 调一次、块内路径共用 baseDir */
export const useLocalFilePathLinker = (baseDir?: string): LocalFilePathLinker => {
  const resolveFor = useCallback(
    (pathLike: string, line?: number) =>
      resolveLocalFileAbsolute(
        line != null ? `${pathLike}:${line}` : pathLike,
        baseDir,
      ),
    [baseDir],
  );
  return useMemo(() => ({ resolveFor, baseDir }), [resolveFor, baseDir]);
};

interface LocalFileLinkProps {
  linker: LocalFilePathLinker;
  path: string;
  line?: number;
  children?: ReactNode;
  className?: string;
  linkClassName?: string;
  /** 结构化产物区 hover 时显示更多入口；行内聊天只保留右键菜单。 */
  showActions?: boolean;
}

interface LocalFileMenuItemsProps {
  variant: "context" | "dropdown";
  isHtml: boolean;
  /** 出「在内置浏览器打开」（桌面端才有；undefined = 不出） */
  onBuiltinOpen?: () => void;
  canPreview: boolean;
  ideAnchor: ReturnType<typeof getIdeAnchorProps>;
  ideLabel: string;
  previewLabel: string;
  /** 在系统浏览器打开（HTML：交给系统默认应用，与原行为一致） */
  onBrowserOpen: () => void;
  onPreview: () => void;
  onReveal: () => void;
  onCopy: () => void;
}

/**
 * tooltip 首行（浏览器类链接）：它只在 tooltip 的 Popup 挂载时渲染，所以 `readLinkOpenMode()` 读到的是「此刻」的设置。
 * 不能在 LocalFileLink 的渲染里读——设置页切换后，已渲染的链接不会重渲，tooltip 会一直是旧文案。
 * （导出仅供测试：tests/browser-open-hint.test.ts 直接渲染它验证文案随「此刻」的设置变化。）
 */
export const BrowserOpenHint = ({ builtinBridge }: { builtinBridge: boolean }) => (
  <>
    {readLinkOpenMode() === "builtin" && builtinBridge
      ? "点击在内置浏览器打开"
      : "点击在系统浏览器打开"}
  </>
);

const LocalFileMenuItems = ({
  variant,
  isHtml,
  onBuiltinOpen,
  canPreview,
  ideAnchor,
  ideLabel,
  previewLabel,
  onBrowserOpen,
  onPreview,
  onReveal,
  onCopy,
}: LocalFileMenuItemsProps) => {
  const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
  const LinkItem =
    variant === "context" ? ContextMenuLinkItem : DropdownMenuLinkItem;
  const Separator =
    variant === "context" ? ContextMenuSeparator : DropdownMenuSeparator;

  return (
    <>
      {isHtml && onBuiltinOpen && (
        <Item onClick={onBuiltinOpen}>
          <Globe className="size-3.5" />
          在内置浏览器打开
        </Item>
      )}
      {isHtml && (
        <Item onClick={onBrowserOpen}>
          <ExternalLink className="size-3.5" />
          在系统浏览器打开
        </Item>
      )}
      {ideAnchor && (
        <LinkItem
          {...ideAnchor}
          onClick={(e) => {
            e.stopPropagation();
            ideAnchor.onClick?.(e);
          }}
        >
          <Code2 className="size-3.5" />
          在 {ideLabel} 打开
        </LinkItem>
      )}
      {canPreview && (
        <Item onClick={onPreview}>
          <Eye className="size-3.5" />
          {previewLabel}
        </Item>
      )}
      <Separator />
      <Item onClick={onReveal}>
        <FolderOpen className="size-3.5" />
        在文件管理器中显示
      </Item>
      <Item onClick={onCopy}>
        <Copy className="size-3.5" />
        复制路径
      </Item>
    </>
  );
};

export const LocalFileLink = ({
  linker,
  path,
  line,
  children,
  className,
  linkClassName,
  showActions = false,
}: LocalFileLinkProps) => {
  const { open, ide: jumpIde } = useLocalFilePreview();
  const mediaGroup = useMediaGroup();
  // 桥是否存在：SSR / 水合首帧恒 false，水合后更新；决定右键菜单是否出「在内置浏览器打开」
  const builtinBridge = useBrowserAvailable();
  const target = linker.resolveFor(path, line);

  if (!target) {
    return (
      <Tooltip content={path}>
        <span className={cn("min-w-0 max-w-full", className)}>
          {children ?? path}
        </span>
      </Tooltip>
    );
  }

  const shown = children ?? pathDisplayLabel(target.absolute);
  const effectiveLine = target.line ?? line;
  const kind = detectLocalFileKind(target.absolute);
  const openTarget = resolveLocalFileOpenTarget(target.absolute, effectiveLine);
  const pathForIde =
    effectiveLine != null
      ? `${target.absolute}:${effectiveLine}`
      : target.absolute;
  const ideAnchor = canOpenInIde(kind)
    ? getIdeAnchorProps(pathForIde, undefined, jumpIde)
    : null;
  const linkClasses = cn(
    "min-w-0 max-w-full cursor-pointer bg-transparent p-0 text-left align-baseline",
    className,
    linkClassName ?? "font-mono text-info underline-offset-2 hover:underline",
  );

  const reportOpenFailure = (err: unknown) => {
    toast.error(
      err instanceof Error ? `浏览器打开失败：${err.message}` : "浏览器打开失败",
    );
  };
  /** 左键默认：按设置「链接默认打开方式」——内置（当前任务的内置浏览器新标签）/ 系统；环境不允许时自动回退系统 */
  const launchInBrowser = () => {
    void openLocalHtmlInBuiltin(target.absolute).catch(reportOpenFailure);
  };
  /** 右键「在内置浏览器打开」：无视「默认系统」的设置；环境不允许仍回退系统 */
  const launchInBuiltin = () => {
    void openLocalHtmlInBuiltin(target.absolute, { forceBuiltin: true }).catch(
      reportOpenFailure,
    );
  };
  /** 右键「在系统浏览器打开」：系统默认应用（原行为） */
  const launchInSystem = () => {
    void requestOpenLocalPath(target.absolute).catch(reportOpenFailure);
  };

  const openPreview = () => {
    // 音视频不进预览弹窗：进全局播放器（同一条消息里的音视频自动成对比组）
    if (openTarget === "media") {
      openMediaInGroup(mediaGroup, { absolute: target.absolute });
      return;
    }
    open(line != null ? `${path}:${line}` : path, {
      baseDir: linker.baseDir,
      line: effectiveLine,
    });
  };

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (openTarget === "browser") {
      launchInBrowser();
      return;
    }
    openPreview();
  };

  const revealInFolder = () => {
    void requestRevealLocalPath(target.absolute).catch((err) => {
      toast.error(
        err instanceof Error ? err.message : "在文件管理器中显示失败",
      );
    });
  };

  const copyPath = () => {
    void navigator.clipboard.writeText(target.absolute).then(
      () => toast.success("已复制路径"),
      () => toast.error("复制失败"),
    );
  };

  const locationLabel = `${target.absolute}${effectiveLine != null ? `:${effectiveLine}` : ""}`;
  // 浏览器类：首行文案由 BrowserOpenHint 在 tooltip 真正打开（Popup 挂载）时才读设置，所以设置页切换「链接默认打开方式」后
  // 不用等本组件重新渲染，下一次悬停看到的就是新的（R7-09-4）
  const defaultActionLabel =
    openTarget === "browser"
      ? <BrowserOpenHint builtinBridge={builtinBridge} />
      : openTarget === "ide"
        ? `点击在 ${JUMP_IDE_LABEL[jumpIde]} 打开${effectiveLine != null ? `第 ${effectiveLine} 行` : ""}`
        : openTarget === "media"
          ? "点击在播放器打开"
          : "点击在 Flowship 预览";
  const tooltipContent = (
    <>
      {defaultActionLabel}，右键选择打开方式{"\n"}
      {locationLabel}
    </>
  );
  const primary =
    openTarget === "ide" && ideAnchor ? (
      <Tooltip content={tooltipContent}>
        <a
          {...ideAnchor}
          onClick={(e) => {
            e.stopPropagation();
            ideAnchor.onClick?.(e);
          }}
          className={linkClasses}
        >
          {shown}
        </a>
      </Tooltip>
    ) : (
      <Tooltip content={tooltipContent}>
        <button type="button" onClick={onClick} className={linkClasses}>
          {shown}
        </button>
      </Tooltip>
    );
  const menuProps = {
    isHtml: shouldOpenLocalFileInBrowser(target.absolute),
    // 桌面端才出；当前页面没有任务上下文时点了会自动回退系统（决策在 lib/builtin-open）
    onBuiltinOpen: builtinBridge ? launchInBuiltin : undefined,
    canPreview: canPreviewInSheet(kind) || openTarget === "media",
    ideAnchor,
    ideLabel: JUMP_IDE_LABEL[jumpIde],
    previewLabel:
      openTarget === "media"
        ? "在播放器打开"
        : kind === "code"
          ? "在 Flowship 预览源码"
          : "在 Flowship 预览",
    onBrowserOpen: launchInSystem,
    onPreview: openPreview,
    onReveal: revealInFolder,
    onCopy: copyPath,
  };
  const contextMenu = (
    <ContextMenu>
      <ContextMenuTrigger render={<span className="inline" />}>
        {primary}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <LocalFileMenuItems variant="context" {...menuProps} />
      </ContextMenuContent>
    </ContextMenu>
  );

  if (!showActions) return contextMenu;

  return (
    <span className="group/local-file inline-flex max-w-full items-baseline gap-0.5">
      {contextMenu}
      <DropdownMenu>
        <Tooltip content="更多打开方式">
          <DropdownMenuTrigger
            aria-label={`更多打开方式 ${target.absolute}`}
            className={cn(
              "inline-flex size-4 shrink-0 translate-y-0.5 items-center justify-center rounded-sm text-muted-foreground outline-none transition-opacity",
              "opacity-0 hover:bg-accent hover:text-foreground group-hover/local-file:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:opacity-100",
            )}
          >
            <MoreHorizontal className="size-3" />
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="start" side="bottom" className="min-w-48">
          <LocalFileMenuItems variant="dropdown" {...menuProps} />
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
};

/** artifact 多段行号：代码（含 HTML）直接定位 IDE，非代码打开同一预览。 */
export const LocalFilePathSegments = ({
  linker,
  parsedPath,
  segments,
  className,
  showActions = false,
}: {
  linker: LocalFilePathLinker;
  parsedPath: string;
  segments: Array<{ text: string; line: number; sep: string }>;
  className?: string;
  showActions?: boolean;
}) => {
  return (
    <span className={cn("font-mono text-[0.85em]", className)}>
      {segments.map((seg, i) => (
        <span key={`${seg.line}-${i}`}>
          {seg.sep}
          <LocalFileLink
            linker={linker}
            path={parsedPath}
            line={seg.line}
            showActions={showActions && i === 0}
            linkClassName="cursor-pointer bg-transparent p-0 text-info underline-offset-2 hover:underline"
          >
            {i === 0 ? `${parsedPath}:${seg.text}` : seg.text}
          </LocalFileLink>
        </span>
      ))}
    </span>
  );
};
