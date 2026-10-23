"use client";

/**
 * 事件流左侧「提问时间线」（chat / task 共用，仿 Codex）。
 *
 * - **折叠态**：顶上一个小图标（让它读作「一个控件」而不是装饰线）+ 一列刻度（一次提问一格，超过 36 次按比例并格），
 *   当前正在看的那一轮刻度拉长加深；跳转到窗口之外时目标刻度脉冲（点完面板就收起了，这是折叠态唯一的
 *   「正在找」反馈，另有 EventStream 的延迟 toast）；点刻度直接跳到那一轮；
 *   位置由 `anchor` 定：task 形态贴事件区最左缘；chat 形态贴**居中内容列的左缘外侧**——chat 内容居中、两侧是大片
 *   空白，贴最左缘时它离正文几百 px、在余光里根本看不见（用户反馈「我都不知道左边有个这个」）；
 *   整条宽度 < 16px：落在正文左侧的内边距里（task px-4 / chat px-6），不压正文；
 * - **展开态**（鼠标移上去 / 点一下 / 键盘 Enter 展开）：实心浮层，按日期分组列出每次提问的时刻 + 两行预览，
 *   当前轮用 `bg-selected` 高亮、打开时自动滚到它；点一行跳转并收起（好让用户看到跳到的内容）；
 *   朝向：把手左侧放得下就向左开（落在左侧空白区、不盖正文），放不下才向右开（`pickOutlinePanelSide`）；
 *   向右开时面板钉回事件区最左缘（`outlinePanelRightShift`）：对正文的覆盖量与旧版（把手本来就贴最左缘）逐档相等；
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Clock, Flag, ListTree, Loader2 } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { useTodayStart } from "@/hooks/use-today-start";
import {
  bucketOutlineTicks,
  formatOutlineTime,
  groupOutlineRows,
  outlinePanelRightShift,
  pickOutlinePanelSide,
  resolveVisibleActiveId,
  visibleOutline,
  type ActiveOutlineStore,
  type OutlineItem,
  type OutlinePanelSide,
} from "@/lib/stream-outline";
import { loadOutlineShowSchedule, saveOutlineShowSchedule } from "@/lib/view-memory";
import { cn } from "@/lib/utils";

/** 鼠标移上去多久展开 / 移开多久收起（ms）：前者防「划过左边缘」误开，后者防「斜着移向面板」闪退 */
const HOVER_OPEN_DELAY_MS = 80;
const HOVER_CLOSE_DELAY_MS = 160;
/** 不足这么多个可见项就不画 */
const MIN_VISIBLE_ITEMS = 2;

/**
 * chat 形态（anchor="column"）把手的 `left`：贴居中内容列（`max-w-3xl` = 48rem）的左缘外侧。
 * - 事件区宽 100%，Virtuoso 右侧留 8px 滚动条槽（scrollbar-gutter: stable），内容列居中在剩下的宽度里，
 *   所以列左缘 = (100% - 8px - 48rem) / 2；
 * - 再往左挪 6px：把手（宽 ≤ 14px）占 [列左缘 - 6px, 列左缘 + 8px]，而正文从列左缘 + 24px（px-6）才开始，
 *   中间还剩 16px 空隙——贴得够近、一眼能和正文联系起来，又不压字；
 * - 窗口窄到内容列顶满时 max(2px, …) 把它夹回最左缘，与 task 形态的 left-0.5 同位、整条仍落在 px-6 的内边距里。
 * 48rem 必须与 EventStream 里 chat 内容列的 `max-w-3xl` 同步（契约测试钉着）。
 */
const COLUMN_ANCHOR_LEFT = "max(2px, calc((100% - 8px - 48rem) / 2 - 6px))";

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
  /**
   * 把手放哪：
   * - `edge`（默认，task 形态）：贴事件区最左缘——task 内容铺满，最左缘就在正文旁；
   * - `column`（chat 形态）：贴居中内容列的左缘外侧——chat 内容居中、两侧是大片空白，
   *   贴最左缘离正文几百 px，在余光里看不见。
   */
  anchor?: "edge" | "column";
}

export const StreamOutlineRail = memo(function StreamOutlineRail({
  items,
  activeStore,
  onJump,
  jumpingId,
  anchor = "edge",
}: StreamOutlineRailProps) {
  const panelId = useId();
  const today0 = useTodayStart();
  const [showSchedule, setShowSchedule] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [panelSide, setPanelSide] = useState<OutlinePanelSide>("right");
  // 向右开时面板 `left` 的像素值（≤ 0，把面板拉回事件区最左缘）；向左开用不到
  const [panelShiftPx, setPanelShiftPx] = useState(0);
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

  // 展开那一刻量一次把手左侧还剩多少空间，决定面板往哪边开、向右开时往回拉多少（layout effect：在绘制前定好，
  // 用户看不到先错位再跳）。只在展开时量：展开期间改窗口大小不动它——面板正在被看，中途翻面比继续用旧朝向更扎眼
  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (!root) return;
    // root 是 absolute、相对事件区定位：offsetLeft 就是把手左缘到事件区左缘的距离
    const roomLeft = root.offsetLeft;
    setPanelSide(pickOutlinePanelSide(roomLeft));
    setPanelShiftPx(outlinePanelRightShift(roomLeft));
  }, [open]);

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
      className={cn(
        "pointer-events-none absolute inset-y-0 z-20 flex items-center",
        anchor === "edge" && "left-0.5",
      )}
      style={anchor === "column" ? { left: COLUMN_ANCHOR_LEFT } : undefined}
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
        className="group/rail pointer-events-auto flex max-h-full flex-col items-start justify-center overflow-hidden rounded-md py-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {/* 把手图标：没有它整条只是几根浅灰细线，读起来是装饰、不是能点的控件 */}
        <ListTree
          aria-hidden
          className="mb-1 size-3 shrink-0 text-muted-foreground transition-colors group-hover/rail:text-foreground group-focus-visible/rail:text-foreground motion-reduce:transition-none"
        />
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
                  // 3px 粗：原来 2px × 6px 的 bg-border（对白底约 1.2:1）几乎看不见。非当前刻度是可点控件的图形部分，
                  // 要过 WCAG 1.4.11 的 3:1（它不是文字，所以「文字不叠 alpha / 4.5:1」不适用）：/60 浅色只有 2.7:1，/70 是 3.3:1
                  "h-[3px] rounded-full transition-[width,background-color] motion-reduce:transition-none",
                  // 跳转目标刻度：加长 + 变深 + 脉冲（减少动态效果时只剩加长变深，不靠动画传达）
                  isJumpTarget
                    ? "w-3 animate-pulse bg-muted-foreground motion-reduce:animate-none"
                    : isActive
                      ? "w-3 bg-foreground"
                      : "w-2 bg-muted-foreground/70 group-hover/tick:bg-foreground",
                )}
              />
            </span>
          );
        })}
      </button>

      {open && (
        <div
          id={panelId}
          className={cn(
            "pointer-events-auto absolute top-1/2 flex max-h-[calc(100%-1rem)] w-72 -translate-y-1/2 flex-col rounded-lg border border-border bg-background shadow-sm animate-in fade-in-0 duration-150 motion-reduce:animate-none",
            // 向左开：右缘贴把手左缘（留 4px 缝）；向右开的 left 走下面的 style（要按把手离最左缘多远来算）。
            // w-72 / mr-1 与 stream-outline.ts 里的 OUTLINE_PANEL_WIDTH_PX / OUTLINE_PANEL_GAP_PX 同值
            panelSide === "left" && "right-full mr-1",
          )}
          // 向右开：把面板拉回事件区最左缘（盖住把手，与老行为一致）。chat 把手离最左缘可能有几百 px，
          // 若与把手左缘对齐，窄窗口里会固定盖住正文 258px，比旧版（面板钉在最左缘）多盖 100~250px
          style={panelSide === "right" ? { left: panelShiftPx } : undefined}
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
