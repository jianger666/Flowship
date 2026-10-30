"use client";

/**
 * 输入框 `@` 唤起文件 / 目录引用（对标 Cursor IDE mention）
 *
 * 交互对齐 slash skill 菜单：↑↓ 选、Enter 确认、Esc 关、继续输入过滤。
 * 数据源 GET /api/repo-files；选中后 Lexical 插 FileTokenNode（`@rel/path`）。
 * 未绑 workdir 时打 `@` → toast 提示，不弹菜单。
 *
 * 触发口径见 lib/composer-trigger（`@` 任意位置、排除邮箱前缀与路径中段）。
 * 结果绑定其所属 query（lib/at-mention-pick）：候选是异步拉的，query 一变旧结果还在菜单里，
 * 此时选中会把 `@Button` 换成上一轮的 `@Bar.ts`（V5-02）——query 与结果不匹配一律拒选。
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { File as FileIcon, Folder } from "lucide-react";
import { toast } from "sonner";

import { EmptyHint } from "@/components/ui/empty-hint";
import { LoadingState } from "@/components/ui/loading-state";
import { useActiveOptionScroll } from "@/hooks/use-active-option-scroll";
import { fetchAtFiles, type AtFileHit } from "@/lib/at-mention-fetch";
import {
  atEmptyHint,
  atFooterHint,
  atMenuView,
  atResultsFromOutcome,
  normalizeAtQuery,
  pickableFor,
} from "@/lib/at-mention-pick";
import { matchAtTrigger } from "@/lib/composer-trigger";
import { optionDomId } from "@/lib/menu-scroll";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { isImeComposing } from "@/lib/ime";

export type { AtFileHit };

/** 一次候选结果 + 它是按哪个（已截断的）query 拉的 */
interface AtResults {
  query: string;
  files: AtFileHit[];
  /** 失败 / 超时落的空结果（空态文案与「无匹配」区分，Q6-09） */
  failed?: boolean;
  /** 服务端索引被截断：候选可能不全（空态 / footer 提示「仅索引前 N 项」）。缺省不带 */
  truncated?: true;
}

/** Lexical 注入：选中后直接插 FileTokenNode，成功返 true */
export type AtPickHandler = (hit: AtFileHit) => boolean;

export interface AtMentionApi {
  menuOpen: boolean;
  /** 菜单里画的候选（stale 时是上一轮的旧结果——只用来画、不能直接拿来选，选走 pickAt） */
  filtered: AtFileHit[];
  activeIndex: number;
  /** 没有可展示的结果、在等（首扫可能稍慢） */
  loading: boolean;
  /**
   * 候选还不是当前 query 的（在路上）：列表降透明 + aria-busy；
   * 此时 Enter / Tab 要拦下（不选陈旧项、也不能漏给「提交」）、菜单保持、等结果到。
   */
  stale: boolean;
  /** 当前 query 的候选请求失败 / 超时（空态要写「候选加载超时」而不是「无匹配」） */
  failed: boolean;
  /** 当前（新鲜）结果来自被截断的索引：空态 / footer 要提示「仅索引前 N 项」，候选可能不全 */
  truncated: boolean;
  /** 列表 DOM id（输入框 aria-controls / 选项 id 的前缀） */
  listId: string;
  onDraftChange: (draft: string, cursor: number) => void;
  onKeyDown: (e: KeyboardEvent) => boolean;
  /** 选中第 index 项；结果与当前 query 不匹配时拒选并返回 false */
  pickAt: (index: number) => boolean;
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
  // 候选 + 它所属的 query：不再单存 filtered——结果必须带着「按哪个 query 拉的」，
  // 选中前与当前 query 比对（V5-02）
  const [results, setResults] = useState<AtResults | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();

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
      setResults(null);
      return;
    }
    if (repoPathsRef.current.length === 0) {
      setResults(null);
      return;
    }
    const q = normalizeAtQuery(query);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // 请求 + 读 body 整体带超时（lib/at-mention-fetch，R6-07）：挂起的请求不再让菜单永远停在
      // loading、stale 永远为真、Enter / Tab 永远被拦
      void fetchAtFiles({
        taskId: taskIdRef.current,
        q,
        signal: controller.signal,
      }).then((out) => {
        // query 变化 / 卸载 abort 旧请求：静默，避免把结果冲掉
        if (controller.signal.aborted) return;
        // 失败 / 超时 = 这个 query 没有候选（结果所属 query 照记，菜单落空态、Enter 不再被吞），
        // 带 failed 标记：空态写「候选加载超时」而不是「无匹配文件」（Q6-09）
        const next = atResultsFromOutcome(q, out);
        if (!next) return;
        setResults(next);
        if (out.kind === "ok") setActiveIndex(0);
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
    const m = matchAtTrigger(before);
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
    setQuery(m.query);
  }, []);

  const registerPickHandler = useCallback((handler: AtPickHandler | null) => {
    pickHandlerRef.current = handler;
    return () => {
      if (pickHandlerRef.current === handler) pickHandlerRef.current = null;
    };
  }, []);

  const pickAt = useCallback(
    (index: number): boolean => {
      // 单点校验：结果必须是当前 query 拉的才选（键盘 Enter / Tab 与鼠标点击都走这里）。
      // 不匹配 = 候选在路上，拒选、菜单保持，用户等结果到再选
      const hit = pickableFor(
        query,
        results?.query ?? null,
        results?.files ?? [],
        index,
      );
      if (!hit) return false;
      if (pickHandlerRef.current?.(hit)) {
        setQuery(null);
        return true;
      }
      // fallback：字符串替换 `@partial` → `@path `（尾空格关菜单）
      const { draft: cur, cursor } = stateRef.current;
      const before = cur.slice(0, cursor);
      const m = matchAtTrigger(before);
      if (!m) {
        setQuery(null);
        return false;
      }
      const cut = before.slice(0, m.start);
      const token = `@${hit.path} `;
      const next = `${cut}${token}${cur.slice(cursor)}`;
      const nextCursor = cut.length + token.length;
      stateRef.current = { draft: next, cursor: nextCursor };
      applyDraftRef.current(next, nextCursor);
      setQuery(null);
      return true;
    },
    [query, results],
  );

  const menuOpen = query !== null;
  const view = atMenuView(query, results);
  const filtered = view.items as AtFileHit[];
  const { stale } = view;
  const loading = view.mode === "loading";
  const failed = view.mode === "empty" && results?.failed === true;
  const truncated = view.truncated === true;

  const onKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!menuOpen) return false;
      if (isImeComposing(e)) return false;
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
        // 结果已到且确实无匹配：不吞（让提交 / 换行 / Tab 走原逻辑）。
        // 候选还在路上（stale，含首次加载）：必须拦下——选不了陈旧项，
        // 放行的话半截的 `@But` 会被当成正文提交出去；菜单保持、等结果到再按一次
        if (filtered.length === 0 && !stale) return false;
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
    [menuOpen, filtered.length, stale, activeIndex, pickAt],
  );

  const reset = useCallback(() => {
    setQuery(null);
  }, []);

  return {
    menuOpen,
    filtered,
    activeIndex,
    loading,
    stale,
    failed,
    truncated,
    listId,
    onDraftChange,
    onKeyDown,
    pickAt,
    registerPickHandler,
    reset,
  };
};

/** `@` 文件菜单（挂输入岛上方、视觉对齐 SlashSkillMenu） */
export const AtMentionMenu = ({ at }: { at: AtMentionApi }) => {
  // hook 必须在 early return 之前（hooks 顺序固定）
  const listRef = useActiveOptionScroll({
    activeIndex: at.activeIndex,
    itemCount: at.filtered.length,
    open: at.menuOpen,
  });
  if (!at.menuOpen) return null;
  const hasItems = at.filtered.length > 0;
  // 只有「还画着旧列表」才降透明；首次加载（没有旧结果）画的是 spinner，不压暗
  const dim = at.stale && hasItems;
  return (
    <div className="absolute bottom-full left-2 z-30 mb-1 w-96 max-w-[calc(100%-1rem)] overflow-hidden rounded-lg border bg-popover shadow-md">
      {/* 列表区域（不是整行）：加载中还留着上一轮旧结果时降透明 + aria-busy——瞬时加载态，
          告诉用户「这不是你现在这串字的结果」（此时也选不了，见 pickAt） */}
      <div
        ref={listRef}
        id={at.listId}
        role={hasItems ? "listbox" : undefined}
        aria-label={hasItems ? "文件" : undefined}
        aria-busy={at.stale}
        className={cn(
          "relative max-h-64 overflow-y-auto p-1 transition-opacity motion-reduce:transition-none",
          dim && "opacity-60",
        )}
      >
        {at.loading && !hasItems ? (
          <LoadingState variant="inline" className="px-2 py-3" />
        ) : !hasItems ? (
          <EmptyHint variant="dashed" size="sm" align="center" className="m-1">
            {atEmptyHint(at.failed, at.truncated)}
          </EmptyHint>
        ) : (
          at.filtered.map((f, i) => (
            <button
              key={`${f.path}-${i}`}
              type="button"
              role="option"
              id={optionDomId(at.listId, i)}
              aria-selected={i === at.activeIndex}
              data-option-index={i}
              tabIndex={-1}
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
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <Tooltip content={f.path}>
                <span className="min-w-0 truncate font-mono text-xs">
                  {f.path}
                </span>
              </Tooltip>
            </button>
          ))
        )}
      </div>
      <div className="border-t bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
        {atFooterHint(at.truncated)}
      </div>
    </div>
  );
};
