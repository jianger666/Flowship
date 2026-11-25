"use client";

/**
 * 收藏夹：对话框（全部收藏、过滤、新标签页打开、删除可撤销）+ 空白页上的快捷列表（没有会话时的「新标签页」）。
 *
 * 数据来自全应用共用的收藏 store（useBookmarks）：对话框里删了，地址栏星标立刻跟着灭；打开对话框时顺手刷新一次，
 * 别处（另一个窗口 / 撤销）改过也能看到最新的。
 *
 * 安全：标题是页面可控的文字——入库时服务端已剥控制 / 格式字符并截断（@/lib/browser-bookmarks），这里按纯文本渲染，
 * 不做任何 HTML 解释；地址只作为 navigate / newTab 的参数交还给面板（主进程的 URL 策略再校验一次），这里不自己打开任何东西。
 * 对话框是 base-ui Dialog（data-slot="dialog-content"），use-overlay-cover 能识别并在盖住视口时遮盖原生视图。
 */
import { memo, useEffect, useMemo, useState } from "react";
import { BookMarked, Loader2, SquarePlus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { OverflowTooltip } from "@/components/ui/tooltip";
import { displayBookmarkUrl, type Bookmark } from "@/lib/browser-bookmarks";

import { BOOKMARK_QUICK_LIMIT, bookmarkListView } from "./bookmark-flow";
import type { BookmarksSnapshot } from "./bookmarks-store";
import { BrowserIconButton } from "./browser-icon-button";
import { clipOneLine } from "./browser-status";
import { useBookmarkActions } from "./use-bookmark-actions";
import { useBookmarks } from "./use-bookmarks";

/** newTab = true：在新标签页打开（没有会话时由面板退回「当前标签 + 启动会话」） */
export type OnOpenBookmark = (url: string, options: { newTab: boolean }) => void;

/** 按钮 aria-label / tooltip 里引用标题的长度（完整标题在行内） */
const LABEL_TITLE_MAX = 40;

/** 一行收藏：整行是「在当前标签打开」；悬停 / 键盘聚焦时右侧出「新标签页打开 / 删除」 */
export const BookmarkRow = memo(function BookmarkRow({
  bookmark,
  onOpen,
  onRemove,
}: {
  bookmark: Bookmark;
  onOpen: OnOpenBookmark;
  onRemove: (bookmark: Bookmark) => void;
}) {
  const quoted = `「${clipOneLine(bookmark.title, LABEL_TITLE_MAX)}」`;
  return (
    <li className="group/row flex items-center gap-1 rounded-md focus-within:bg-muted hover:bg-muted">
      <button
        type="button"
        onClick={() => onOpen(bookmark.url, { newTab: false })}
        className="flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <OverflowTooltip text={bookmark.title} side="top" className="w-full text-xs font-medium" />
        <OverflowTooltip text={displayBookmarkUrl(bookmark.url)} side="top" className="w-full text-[11px] text-muted-foreground" />
      </button>
      {/* 悬停显示、键盘聚焦（Tab 到按钮）同样显示：隐藏只是视觉上的，按钮始终在 Tab 序里 */}
      <div className="flex shrink-0 items-center pr-1 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
        <BrowserIconButton label={`在新标签页打开${quoted}`} onClick={() => onOpen(bookmark.url, { newTab: true })}>
          <SquarePlus />
        </BrowserIconButton>
        <BrowserIconButton label={`删除收藏${quoted}`} onClick={() => onRemove(bookmark)}>
          <Trash2 />
        </BrowserIconButton>
      </div>
    </li>
  );
});

/** 收藏列表（对话框正文）；单独导出，SSR 测试不必打开对话框就能断言行内容 */
export const BookmarkList = memo(function BookmarkList({
  bookmarks,
  onOpen,
  onRemove,
}: {
  bookmarks: readonly Bookmark[];
  onOpen: OnOpenBookmark;
  onRemove: (bookmark: Bookmark) => void;
}) {
  return (
    <ul aria-label="收藏列表" className="-mx-1 max-h-[min(60vh,24rem)] overflow-y-auto px-1">
      {bookmarks.map((b) => (
        <BookmarkRow key={b.id} bookmark={b} onOpen={onOpen} onRemove={onRemove} />
      ))}
    </ul>
  );
});

/**
 * 对话框正文的各个状态（纯展示：数据与回调都由对话框传入）。
 * 对话框内容在 Portal 里、服务端渲染是空的，拆出来是为了 SSR 测试能逐个状态断言，不必去戳 JSX 树。
 * 判定顺序：首次加载失败（还没有任何数据）→ 首次加载中 → 确实没有收藏 → 过滤后没有匹配 → 列表。
 * 已经有数据时后台刷新失败不会走到错误态（store 会保留陈旧列表，见 bookmarks-store.ts）。
 */
export const BookmarksBody = ({
  total,
  visible,
  query,
  status,
  error,
  onReload,
  onOpen,
  onRemove,
}: {
  /** 收藏总数（过滤前） */
  total: number;
  /** 过滤后要显示的 */
  visible: readonly Bookmark[];
  /** 生效中的过滤词（已 trim；过滤框不显示时是空串） */
  query: string;
  status: BookmarksSnapshot["status"];
  error: string | null;
  onReload: () => void;
  onOpen: OnOpenBookmark;
  onRemove: (bookmark: Bookmark) => void;
}) => {
  if (status === "error" && total === 0) {
    return (
      <div role="alert" className="flex flex-col items-center gap-2 py-6 text-center text-xs text-destructive">
        <span>{error ?? "读取收藏夹失败"}</span>
        <Button type="button" size="sm" variant="outline" onClick={onReload}>
          重试
        </Button>
      </div>
    );
  }
  if (total === 0 && (status === "idle" || status === "loading")) {
    return (
      <div role="status" className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        加载中…
      </div>
    );
  }
  if (total === 0) {
    return (
      <EmptyHint
        variant="dashed"
        size="md"
        align="center"
        icon={<BookMarked className="size-5 text-muted-foreground" aria-hidden />}
      >
        还没有收藏。浏览网页时点地址栏右侧的星标，就能把当前页收进来。
      </EmptyHint>
    );
  }
  if (visible.length === 0) {
    return <div className="py-6 text-center text-xs text-muted-foreground">没有匹配「{clipOneLine(query, 30)}」的收藏</div>;
  }
  return <BookmarkList bookmarks={visible} onOpen={onOpen} onRemove={onRemove} />;
};

export const BookmarksDialog = ({
  open,
  onOpenChange,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: OnOpenBookmark;
}) => {
  const { bookmarks, status, error, reload, removeWithUndo } = useBookmarkActions();
  const [query, setQuery] = useState("");

  // 每次打开刷新一次：别处改过（撤销 / 另一个窗口）也能看到最新的
  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const handleOpenChange = (next: boolean) => {
    if (!next) setQuery(""); // 过滤词不带到下一次打开
    onOpenChange(next);
  };
  const handleOpen: OnOpenBookmark = (url, options) => {
    onOpen(url, options);
    handleOpenChange(false); // 打开后收起对话框，让用户看到页面
  };

  const view = useMemo(() => bookmarkListView(bookmarks, query), [bookmarks, query]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>收藏夹</DialogTitle>
          <DialogDescription>所有任务共用同一份收藏。点击打开，悬停可在新标签页打开或删除。</DialogDescription>
        </DialogHeader>

        {view.showFilter && (
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索收藏"
            placeholder="搜索标题或网址"
            spellCheck={false}
            autoComplete="off"
          />
        )}

        <BookmarksBody
          total={bookmarks.length}
          visible={view.visible}
          query={view.query}
          status={status}
          error={error}
          onReload={() => void reload()}
          onOpen={handleOpen}
          onRemove={(b) => void removeWithUndo(b)}
        />
      </DialogContent>
    </Dialog>
  );
};

/**
 * 空白页（还没有会话）上的收藏快捷列表（纯展示）：最近的几条，点一下就在当前标签打开（会启动会话）。
 * 没有收藏时整块不渲染；超过快捷上限时「全部 N 个」进对话框。
 */
export const BookmarkQuickListView = ({
  bookmarks,
  onOpen,
  onManage,
}: {
  bookmarks: readonly Bookmark[];
  onOpen: OnOpenBookmark;
  onManage: () => void;
}) => {
  if (bookmarks.length === 0) return null;
  const shown = bookmarks.slice(0, BOOKMARK_QUICK_LIMIT);
  return (
    <section aria-label="收藏" className="w-full max-w-sm">
      <div className="mb-1 flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
        <span>收藏</span>
        <Button type="button" variant="ghost" size="xs" onClick={onManage}>
          {bookmarks.length > shown.length ? `全部 ${bookmarks.length} 个` : "管理"}
        </Button>
      </div>
      <ul>
        {shown.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => onOpen(b.url, { newTab: false })}
              className="flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{b.title}</span>
              <span className="max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground">{displayBookmarkUrl(b.url)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** 空白页快捷列表：从共用的收藏 store 取数据（服务端渲染恒为空，水合后才有内容） */
export const BookmarkQuickList = ({ onOpen, onManage }: { onOpen: OnOpenBookmark; onManage: () => void }) => {
  const { bookmarks } = useBookmarks();
  return <BookmarkQuickListView bookmarks={bookmarks} onOpen={onOpen} onManage={onManage} />;
};
