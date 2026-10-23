"use client";

/**
 * 事件流左侧「提问时间线」（chat / task 共用，仿 Codex）。
 *
 * - **折叠态**：贴左边缘一列细刻度（一次提问一格，超过 36 次按比例并格），当前正在看的那一轮刻度拉长加深；
 *   跳转到窗口之外时目标刻度脉冲（点完面板就收起了，这是折叠态唯一的「正在找」反馈，另有 EventStream 的延迟 toast）；
 *   刻度列总宽 < 16px（与 task 形态 px-4 的内容区左缘错开、不压正文）；
 *   点刻度直接跳到那一轮；
 * - **展开态**（鼠标移上去 / 点一下 / 键盘 Enter 展开）：实心浮层，按日期分组列出每次提问的时刻 + 两行预览，
 *   当前轮用 `bg-selected` 高亮、打开时自动滚到它；点一行跳转并收起（好让用户看到跳到的内容）；
 * - **定时触发**（AI 给自己设的定时到点后落盘的 user_reply）默认不列，面板里有开关、偏好记在 localStorage；
 * - 项不足 2 个就整条不画（只有一次提问的对话没有「时间」可导航）。
 *
 * 性能：`activeStore`（外部 store、由 EventStream 的 rangeChanged 更新）只让本组件重渲，滚动不触发事件流整页重渲；
 * `items` 引用在内容没变时稳定（useTaskOutline 的 stabilizeOutline）+ memo，流式输出期间不重画。
 */

import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Clock, Flag, Loader2 } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { useTodayStart } from "@/hooks/use-today-start";
import {
  bucketOutlineTicks,
  formatOutlineTime,
  groupOutlineRows,
  resolveVisibleActiveId,
  visibleOutline,
  type ActiveOutlineStore,
  type OutlineItem,
} from "@/lib/stream-outline";
import { loadOutlineShowSchedule, saveOutlineShowSchedule } from "@/lib/view-memory";
import { cn } from "@/lib/utils";

/** 鼠标移上去多久展开 / 移开多久收起（ms）：前者防「划过左边缘」误开，后者防「斜着移向面板」闪退 */
const HOVER_OPEN_DELAY_MS = 80;
const HOVER_CLOSE_DELAY_MS = 160;
/** 不足这么多个可见项就不画 */
const MIN_VISIBLE_ITEMS = 2;

const noActive = (): null => null;

interface StreamOutlineRailProps {
  /** 全部时间线项（含定时触发项；是否画由本组件按开关决定） */
  items: readonly OutlineItem[];
  /** 当前轮 id（滚动时由 EventStream 写入） */
  activeStore: ActiveOutlineStore;
  /** 点击跳转（事件 id） */
  onJump: (eventId: string) => void;
  /** 正在往前加载、要跳去的那一项（该项显示加载中；跳转进行时不重复触发） */
  jumpingId: string | null;
}

export const StreamOutlineRail = memo(function StreamOutlineRail({
  items,
  activeStore,
  onJump,
  jumpingId,
}: StreamOutlineRailProps) {
  const panelId = useId();
  const today0 = useTodayStart();
  const [showSchedule, setShowSchedule] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 偏好挂载后再读（SSR 安全）
  useEffect(() => {
    setShowSchedule(loadOutlineShowSchedule());
  }, []);
  useEffect(
    () => () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    },
    [],
  );

  const scheduleCount = useMemo(
    () => items.reduce((n, it) => n + (it.schedule ? 1 : 0), 0),
    [items],
  );
  const visible = useMemo(() => visibleOutline(items, showSchedule), [items, showSchedule]);
  const activeId = useSyncExternalStore(activeStore.subscribe, activeStore.get, noActive);
  const activeVisibleId = useMemo(
    () => resolveVisibleActiveId(visible, items, activeId),
    [visible, items, activeId],
  );
  const activeIndex = useMemo(
    () => (activeVisibleId ? visible.findIndex((it) => it.id === activeVisibleId) : -1),
    [visible, activeVisibleId],
  );
  const ticks = useMemo(() => bucketOutlineTicks(visible.length), [visible.length]);
  // 正在往前加载、要跳去的那一项落在哪个下标（折叠态靠它给目标刻度反馈：点完面板就收起了）
  const jumpingIndex = useMemo(
    () => (jumpingId ? visible.findIndex((it) => it.id === jumpingId) : -1),
    [visible, jumpingId],
  );
  const rows = useMemo(() => groupOutlineRows(visible, today0 + 12 * 3600_000), [visible, today0]);

  const open = hoverOpen || pinned;

  // 展开时把当前轮滚到面板中间（手算 scrollTop：scrollIntoView 会连带滚外层）
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const list = listRef.current;
      const row = activeRowRef.current;
      if (!list || !row) return;
      list.scrollTop = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2;
    });
    return () => cancelAnimationFrame(raf);
    // 只在展开那一刻定位（依赖只有 open）；展开期间当前轮变了（滚动）不抢用户在面板里的滚动位置
  }, [open]);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };
  const onMouseEnter = () => {
    clearHoverTimer();
    if (hoverOpen) return;
    hoverTimerRef.current = setTimeout(() => setHoverOpen(true), HOVER_OPEN_DELAY_MS);
  };
  const onMouseLeave = () => {
    clearHoverTimer();
    if (!hoverOpen) return;
    hoverTimerRef.current = setTimeout(() => setHoverOpen(false), HOVER_CLOSE_DELAY_MS);
  };
  const close = () => {
    clearHoverTimer();
    setHoverOpen(false);
    setPinned(false);
  };

  const jump = (id: string) => {
    if (jumpingId) return; // 上一次跳转还在加载，不叠加
    onJump(id);
    close();
  };

  const onToggleSchedule = (next: boolean) => {
    setShowSchedule(next);
    saveOutlineShowSchedule(next);
  };

  if (visible.length < MIN_VISIBLE_ITEMS) return null;

  return (
    <div
      ref={rootRef}
      role="navigation"
      aria-label="提问时间线"
      className="pointer-events-none absolute inset-y-0 left-0.5 z-20 flex items-center"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onBlur={(e) => {
        // 焦点整体离开本组件（不是在按钮 / 面板之间挪）才收起
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) {
          setPinned(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        close();
        buttonRef.current?.focus();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={`提问时间线，共 ${visible.length} 项`}
        aria-expanded={open}
        aria-busy={jumpingId ? true : undefined}
        aria-controls={open ? panelId : undefined}
        onClick={() => setPinned((p) => !p)}
        className="pointer-events-auto flex max-h-full flex-col items-start justify-center overflow-hidden rounded-md py-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {ticks.map((t) => {
          const first = visible[t.first]!;
          const isActive = activeIndex >= t.first && activeIndex <= t.last;
          const isJumpTarget = jumpingIndex >= t.first && jumpingIndex <= t.last;
          return (
            // 刻度只负责鼠标点：键盘走展开面板里的按钮（按钮里不嵌可聚焦元素）
            <span
              key={first.id}
              aria-hidden
              onClick={(e) => {
                e.stopPropagation();
                jump(first.id);
              }}
              className="group/tick flex h-2.5 w-3.5 cursor-pointer items-center"
            >
              <span
                className={cn(
                  "h-0.5 rounded-full transition-[width,background-color] motion-reduce:transition-none",
                  // 跳转目标刻度：加长 + 变深 + 脉冲（减少动态效果时只剩加长变深，不靠动画传达）
                  isJumpTarget
                    ? "w-3 animate-pulse bg-muted-foreground motion-reduce:animate-none"
                    : isActive
                      ? "w-3 bg-foreground"
                      : "w-1.5 bg-border group-hover/tick:bg-muted-foreground",
                )}
              />
            </span>
          );
        })}
      </button>

      {open && (
        <div
          id={panelId}
          className="pointer-events-auto absolute top-1/2 left-0 flex max-h-[calc(100%-1rem)] w-72 -translate-y-1/2 flex-col rounded-lg border border-border bg-background shadow-sm animate-in fade-in-0 duration-150 motion-reduce:animate-none"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2 pb-1">
            <span className="text-xs font-medium">提问时间线</span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {visible.length} 项
            </span>
          </div>
          {scheduleCount > 0 && (
            <label className="flex shrink-0 cursor-pointer items-center justify-between gap-2 px-3 pb-1.5 text-[11px] text-muted-foreground">
              <span>显示定时触发（{scheduleCount}）</span>
              <Switch checked={showSchedule} onCheckedChange={onToggleSchedule} />
            </label>
          )}
          <div
            ref={listRef}
            className="relative min-h-0 flex-1 overflow-y-auto border-t border-border px-1 pb-1"
          >
            {rows.map((row) => {
              if (row.type === "day") {
                return (
                  <div
                    key={row.key}
                    className="sticky top-0 z-10 bg-background px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground"
                  >
                    {row.label}
                  </div>
                );
              }
              const { item } = row;
              const isActive = item.id === activeVisibleId;
              const isJumping = item.id === jumpingId;
              return (
                <button
                  key={row.key}
                  ref={isActive ? activeRowRef : undefined}
                  type="button"
                  aria-current={isActive ? "true" : undefined}
                  aria-busy={isJumping || undefined}
                  disabled={Boolean(jumpingId) && !isJumping}
                  onClick={() => jump(item.id)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed",
                    isActive ? "bg-selected text-selected-foreground" : "hover:bg-accent",
                  )}
                >
                  <span
                    className={cn(
                      "mt-px w-9 shrink-0 text-[11px] tabular-nums",
                      isActive ? "text-selected-foreground" : "text-muted-foreground",
                    )}
                  >
                    {formatOutlineTime(item.ts)}
                  </span>
                  <span className="line-clamp-2 min-w-0 flex-1 wrap-anywhere">{item.text}</span>
                  {isJumping ? (
                    <Loader2 className="mt-px size-3 shrink-0 animate-spin motion-reduce:animate-none" />
                  ) : item.kind === "action_start" ? (
                    <Flag className="mt-px size-3 shrink-0" aria-hidden />
                  ) : item.schedule ? (
                    <Clock className="mt-px size-3 shrink-0" aria-hidden />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});
