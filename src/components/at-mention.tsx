"use client";

/**
 * 输入框 `@` 唤起文件 / 目录引用（对标 Cursor IDE mention）
 *
 * 交互对齐 slash skill 菜单：↑↓ 选、Enter 确认、Esc 关、继续输入过滤。
 * 数据源 GET /api/repo-files；选中后 Lexical 插 FileTokenNode（`@rel/path`）。
 * 未绑 workdir 时打 `@` → toast 提示，不弹菜单。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { File as FileIcon, Folder } from "lucide-react";
import { toast } from "sonner";

import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { REPO_FILES_Q_MAX_LEN } from "@/lib/repo-files-shared";
import { cn } from "@/lib/utils";

/** 光标前「正在打 @」：行首或空白后的 @partial（partial 可含 `/`、可空） */
export const AT_RE = /(^|\s)@([^\s:]*)$/;

export interface AtFileHit {
  path: string;
  isDir: boolean;
}

/** Lexical 注入：选中后直接插 FileTokenNode，成功返 true */
export type AtPickHandler = (hit: AtFileHit) => boolean;

export interface AtMentionApi {
  menuOpen: boolean;
  filtered: AtFileHit[];
  activeIndex: number;
  /** 是否在拉候选（空 query 首扫可能稍慢） */
  loading: boolean;
  onDraftChange: (draft: string, cursor: number) => void;
  onKeyDown: (e: KeyboardEvent) => boolean;
  pickAt: (index: number) => void;
  registerPickHandler: (handler: AtPickHandler | null) => () => void;
  reset: () => void;
}

interface UseAtMentionOpts {
  taskId: string;
  /** 当前绑仓；空 = 未绑，打 @ 只 toast */
  repoPaths: string[];
  applyDraft: (next: string, cursor?: number) => void;
}

const DEBOUNCE_MS = 120;

export const useAtMention = (opts: UseAtMentionOpts): AtMentionApi => {
  // null = 没在打 @；string = 当前过滤词（可空串 = 刚打出 @）
  const [query, setQuery] = useState<string | null>(null);
  const [filtered, setFiltered] = useState<AtFileHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);

  const stateRef = useRef({ draft: "", cursor: 0 });
  const pickHandlerRef = useRef<AtPickHandler | null>(null);
  const applyDraftRef = useRef(opts.applyDraft);
  applyDraftRef.current = opts.applyDraft;
  const repoPathsRef = useRef(opts.repoPaths);
  repoPathsRef.current = opts.repoPaths;
  const taskIdRef = useRef(opts.taskId);
  taskIdRef.current = opts.taskId;
  // 同一轮 @ 只 toast 一次「先绑定」、避免每键都弹
  const unboundToastedRef = useRef(false);

  // query 变化 → debounce 拉 API
  useEffect(() => {
    if (query === null) {
      setFiltered([]);
      setLoading(false);
      return;
    }
    if (repoPathsRef.current.length === 0) {
      setFiltered([]);
      setLoading(false);
      return;
    }
    const q = query.slice(0, REPO_FILES_Q_MAX_LEN);
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        taskId: taskIdRef.current,
        q,
      });
      void fetch(`/api/repo-files?${params}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then((r) => {
          // 响应已落地后 abort 不再抛 AbortError——.then 里再判，防慢请求覆盖新 query
          if (controller.signal.aborted) return null;
          return r.json();
        })
        .then((d: { files?: AtFileHit[]; error?: string } | null) => {
          if (d === null || controller.signal.aborted) return;
          setFiltered(Array.isArray(d.files) ? d.files : []);
          setActiveIndex(0);
          setLoading(false);
        })
        .catch((err: unknown) => {
          // query 变化 abort 旧请求：静默，避免把 loading/结果冲掉
          if (
            controller.signal.aborted ||
            (err instanceof DOMException && err.name === "AbortError") ||
            (err instanceof Error && err.name === "AbortError")
          ) {
            return;
          }
          setFiltered([]);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const onDraftChange = useCallback((nextDraft: string, cursor: number) => {
    stateRef.current = { draft: nextDraft, cursor };
    const before = nextDraft.slice(0, cursor);
    const m = before.match(AT_RE);
    if (!m) {
      setQuery(null);
      unboundToastedRef.current = false;
      return;
    }
    if (repoPathsRef.current.length === 0) {
      // 未绑仓：关菜单 + 轻提示（简单 toast、不占菜单空态）
      setQuery(null);
      if (!unboundToastedRef.current) {
        unboundToastedRef.current = true;
        toast.message("先绑定工作目录");
      }
      return;
    }
    unboundToastedRef.current = false;
    setQuery(m[2] ?? "");
  }, []);

  const registerPickHandler = useCallback((handler: AtPickHandler | null) => {
    pickHandlerRef.current = handler;
    return () => {
      if (pickHandlerRef.current === handler) pickHandlerRef.current = null;
    };
  }, []);

  const pickAt = useCallback(
    (index: number) => {
      const hit = filtered[index];
      if (!hit) return;
      if (pickHandlerRef.current?.(hit)) {
        setQuery(null);
        return;
      }
      // fallback：字符串替换 `@partial` → `@path `（尾空格关菜单）
      const { draft: cur, cursor } = stateRef.current;
      const before = cur.slice(0, cursor);
      const m = before.match(AT_RE);
      if (!m) {
        setQuery(null);
        return;
      }
      const partialLen = (m[2]?.length ?? 0) + 1; // `@` + partial
      const cut = before.slice(0, before.length - partialLen);
      const token = `@${hit.path} `;
      const next = `${cut}${token}${cur.slice(cursor)}`;
      const nextCursor = cut.length + token.length;
      stateRef.current = { draft: next, cursor: nextCursor };
      applyDraftRef.current(next, nextCursor);
      setQuery(null);
    },
    [filtered],
  );

  const menuOpen = query !== null;

  const onKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!menuOpen) return false;
      if ((e.nativeEvent as globalThis.KeyboardEvent).isComposing) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (filtered.length === 0) return true;
        setActiveIndex((i) => (i + 1) % filtered.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (filtered.length === 0) return true;
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (filtered.length === 0) return false;
        e.preventDefault();
        pickAt(activeIndex);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setQuery(null);
        return true;
      }
      return false;
    },
    [menuOpen, filtered.length, activeIndex, pickAt],
  );

  const reset = useCallback(() => {
    setQuery(null);
  }, []);

  return {
    menuOpen,
    filtered,
    activeIndex,
    loading,
    onDraftChange,
    onKeyDown,
    pickAt,
    registerPickHandler,
    reset,
  };
};

/** `@` 文件菜单（挂输入岛上方、视觉对齐 SlashSkillMenu） */
export const AtMentionMenu = ({ at }: { at: AtMentionApi }) => {
  if (!at.menuOpen) return null;
  return (
    <div className="absolute bottom-full left-2 z-30 mb-1 w-96 max-w-[calc(100%-1rem)] overflow-hidden rounded-lg border bg-popover shadow-md">
      <div className="max-h-64 overflow-y-auto p-1">
        {at.loading && at.filtered.length === 0 ? (
          <LoadingState variant="inline" className="px-2 py-3" />
        ) : at.filtered.length === 0 ? (
          <EmptyHint variant="dashed" size="sm" align="center" className="m-1">
            无匹配文件
          </EmptyHint>
        ) : (
          at.filtered.map((f, i) => (
            <button
              key={`${f.path}-${i}`}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                at.pickAt(i);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors",
                i === at.activeIndex ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              {f.isDir ? (
                <Folder className="size-3.5 shrink-0 text-amber-500" />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 truncate font-mono text-xs" title={f.path}>
                {f.path}
              </span>
            </button>
          ))
        )}
      </div>
      <div className="border-t bg-muted/40 px-2.5 py-1 text-[10px] text-muted-foreground">
        ↑↓ 选择 · Enter 确认 · Esc 关闭
      </div>
    </div>
  );
};
