"use client";

/**
 * 内嵌浏览器面板：工具栏 + tab 条 + 状态条 + 视口 + 操作记录。
 *
 * 浏览器本体是主进程里盖在 HTML 之上的原生 WebContentsView，这里只有占位视口（BrowserViewport）
 * 与围着它的 Flowship 自己的 UI；所有控制走 `window.__browser`，只能在 effect / 事件回调里碰
 * （SSR 不能碰 window），没有 bridge 时整块退化成「仅桌面端可用」。
 *
 * 状态条画在这里而不是页面里——「AI 操作中 / 你正在操作 / AI 请你操作」页面伪造不了。
 * 视觉走现有 token（border / muted / primary / info / warning）与 lucide 图标，暗色亮色自动适配。
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronRight,
  Code,
  ExternalLink,
  Globe,
  Hand,
  Info,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  MousePointerClick,
  MoreHorizontal,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Trash2,
  User,
  VenetianMask,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { useDialog } from "@/hooks/use-dialog";
import { insertIntoComposer } from "@/lib/composer-insert-bridge";
import type {
  ActivityActor,
  ActivityEntry,
  BrowserState,
  PickedElement,
  TabInfo,
} from "@/lib/browser-bridge-types";
import { cn } from "@/lib/utils";
import { BrowserDialogBar } from "./browser-dialog-bar";
import { BrowserExtraBars } from "./browser-extra-bars";
import { BrowserDownloads } from "./browser-downloads";
import { BrowserFindBar } from "./browser-find-bar";
import { BrowserUnavailable } from "./browser-unavailable";
import { BrowserViewport } from "./browser-viewport";
import {
  canZoomIn,
  canZoomOut,
  emulationLabelOf,
  fitScaleLabelOf,
  fitScalePercentOf,
  formatZoomLabel,
  isFindShortcut,
  readDownloads,
} from "./browser-user-logic";
import { subscribePendingNavigation, takePendingNavigationRequest } from "./browser-panel-bridge";
import {
  ACTIVITY_ACTOR_LABEL,
  TOOLTIP_TEXT_MAX,
  clipOneLine,
  decidePanelOpen,
  describeActivity,
  describeStatusBar,
  displayAddress,
  findActiveTab,
  formatActivityTime,
  isExternalOpenableUrl,
  orderActivityForDisplay,
  safeFaviconSrc,
  tabDisplayTitle,
  tabTooltipText,
  type StatusBarModel,
} from "./browser-status";
import { runClearBrowsingData } from "./clear-data-flow";
import { pasteImageIntoComposer } from "./composer-image-paste";
import { composePickedText } from "./pick-compose";
import { useBrowserAvailable, useBrowserSession } from "./use-browser-session";

interface BrowserPanelProps {
  taskId: string;
  className?: string;
  /**
   * 关闭浏览器面板（收起抽屉，会话仍在后台）：工具栏最右一个 X。不传 = 不画。
   * 以前只能再点一次头部的「浏览器」入口才关得掉，抽屉自己里面没有关闭入口。
   */
  onClose?: () => void;
  /**
   * 「放大浏览器」：折叠旁边的栏（对话页 = 对话；工作台 = 事件流），让浏览器占满整行；再点还原。
   * 不传 onToggleMaximize = 不画。coverTarget 只用于按钮文案里「盖住的是谁」。
   */
  maximized?: boolean;
  onToggleMaximize?: () => void;
  coverTarget?: string;
}

/** 拾取结果 → 输入框：文本走 composer-insert-bridge，截图走「粘贴图片」的现成通道 */
const deliverPickedElement = (taskId: string, picked: PickedElement) => {
  const text = composePickedText(picked);
  if (!insertIntoComposer(taskId, text)) {
    // 当前没有可用的输入框（比如输入框被禁用 / 页面没挂它）：别丢，放剪贴板
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast.info("找不到当前任务的输入框，已把页面元素复制到剪贴板"))
      .catch(() => toast.error("找不到当前任务的输入框，复制也失败了"));
    return;
  }
  if (picked.screenshot && !pasteImageIntoComposer(picked.screenshot)) {
    toast.warning("页面元素已引用，但截图没能附到输入框");
    return;
  }
  toast.success("已把页面元素引用到输入框");
};

const IconButton = ({
  label,
  onClick,
  disabled,
  pressed,
  size = "icon-sm",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  /** 模拟条这种紧凑的一行用 icon-xs（24px），工具栏默认 icon-sm（28px） */
  size?: "icon-sm" | "icon-xs";
  children: ReactNode;
}) => (
  // 工具栏在视口上方：tooltip 一律朝上，免得气泡落在视口里（原生视图盖在 HTML 之上，会触发整块遮盖）
  <Tooltip content={label} side="top">
    <Button
      type="button"
      variant={pressed ? "secondary" : "ghost"}
      size={size}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0"
    >
      {children}
    </Button>
  </Tooltip>
);

const TabFavicon = ({ tab }: { tab: TabInfo }) => {
  const [failed, setFailed] = useState(false);
  if (tab.loading) return <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />;
  const src = safeFaviconSrc(tab.favicon);
  if (!src || failed) return <Globe className="size-3.5 shrink-0 text-muted-foreground" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 页面给的 favicon 地址，不走 next/image
    <img
      src={src}
      alt=""
      width={14}
      height={14}
      draggable={false}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-3.5 shrink-0 rounded-sm"
    />
  );
};

const TabStrip = memo(function TabStrip({ taskId, tabs }: { taskId: string; tabs: TabInfo[] }) {
  const onNewTab = () => void window.__browser?.newTab(taskId);
  return (
    <div
      role="tablist"
      aria-label="浏览器标签页"
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2 py-1"
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={cn(
            "group/tab flex h-7 min-w-0 max-w-44 shrink-0 items-center rounded-md text-xs transition-colors",
            tab.isActive
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          {/* hover 显示完整标题 / 地址：走 Tooltip（项目约定不用原生 title）；tooltip 的遮盖由 use-overlay-cover 兜 */}
          {/* 内容压成单行并截到 300 字、剥掉方向控制符等格式字符：页面标题可达数 MB，也可能夹 U+202E（R1-37） */}
          <Tooltip
            content={tabTooltipText(
              clipOneLine(tab.title, TOOLTIP_TEXT_MAX) || clipOneLine(tab.url, TOOLTIP_TEXT_MAX),
              tab.incognito,
            )}
            side="top"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.isActive}
              onClick={() => window.__browser?.selectTab(taskId, tab.id)}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* key 跟着 favicon 地址走（R3-09 ③）：failed 状态只对「加载失败的那个地址」有效，换了地址（导航到别的站）要重新尝试 */}
              <TabFavicon key={tab.favicon ?? ""} tab={tab} />
              {/* E2·A6 无痕徽章：不是按钮（点击行为仍是切换标签页），说明走本 tab 的 Tooltip；读屏靠 sr-only 文案 */}
              {tab.incognito ? (
                <>
                  <VenetianMask aria-hidden="true" data-incognito-badge="" className="size-3.5 shrink-0 text-primary" />
                  <span className="sr-only">无痕标签页：</span>
                </>
              ) : null}
              <span className="min-w-0 truncate">{tabDisplayTitle(tab)}</span>
            </button>
          </Tooltip>
          <button
            type="button"
            aria-label={`关闭标签页 ${tabDisplayTitle(tab)}`}
            onClick={() => window.__browser?.closeTab(taskId, tab.id)}
            className={cn(
              "mx-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
              tab.isActive ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
            )}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <Tooltip content="新建标签页" side="top">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="新建标签页"
          onClick={onNewTab}
          className="shrink-0"
        >
          <Plus />
        </Button>
      </Tooltip>
    </div>
  );
});

/** 状态条：role="status"，所有文案来自 describeStatusBar（状态 → 文案的纯函数） */
const StatusBar = memo(function StatusBar({
  taskId,
  model,
}: {
  taskId: string;
  model: StatusBarModel;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  // 只在「你正在操作」时才有附言输入；controller 变了（被交还 / 被接管）就自然收起
  const showNote = noteOpen && model.kind === "user";

  if (model.kind === "none") return null;

  const handback = (withNote: boolean) => {
    window.__browser?.handback(taskId, withNote && note.trim() ? note.trim() : undefined);
    setNoteOpen(false);
    setNote("");
  };

  const tone = {
    ai: "bg-primary/5",
    user: "bg-info/10",
    ask: "bg-warning/10",
    idle: "",
  }[model.kind];

  return (
    <div role="status" aria-live="polite" className={cn("shrink-0 border-b text-xs", tone)}>
      <div className="flex min-h-8 items-center gap-2 px-3 py-1">
        {model.kind === "ai" && <Bot className="size-3.5 shrink-0 text-primary" aria-hidden />}
        {model.kind === "user" && <User className="size-3.5 shrink-0 text-info" aria-hidden />}
        {model.kind === "ask" && <Hand className="size-3.5 shrink-0 text-warning" aria-hidden />}
        {model.kind === "idle" && (
          <span className="mx-1 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
        )}
        <Tooltip content={model.text} side="top">
          <span
            className={cn(
              "min-w-0 flex-1",
              model.kind === "ask" ? "line-clamp-2 break-words" : "truncate",
              model.kind === "idle" && "text-muted-foreground",
            )}
          >
            {model.text}
            {/* 文字层级靠语义 token、不叠透明度；这里已在 idle 的 muted 文字里，不再另外淡化 */}
            {model.kind === "idle" && model.pendingNote && (
              <span className="ml-2 text-muted-foreground">· {model.pendingNote}</span>
            )}
          </span>
        </Tooltip>

        {model.kind === "ai" && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => window.__browser?.takeover(taskId)}
          >
            接管
          </Button>
        )}
        {model.kind === "user" && (
          <>
            <Button type="button" size="xs" variant="outline" onClick={() => handback(false)}>
              交还给 AI
            </Button>
            <Tooltip content="附一句话再交还" side="top">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="附一句话再交还给 AI"
                aria-expanded={showNote}
                onClick={() => setNoteOpen((v) => !v)}
              >
                <MessageSquarePlus />
              </Button>
            </Tooltip>
          </>
        )}
        {model.kind === "ask" && (
          <>
            <Button
              type="button"
              size="xs"
              onClick={() => window.__browser?.answerAsk(taskId, "done")}
            >
              完成
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => window.__browser?.answerAsk(taskId, "skipped")}
            >
              放弃
            </Button>
          </>
        )}
      </div>
      {showNote && (
        // 内联展开而不是弹层：浮层会盖住原生视口、触发遮盖截图；内联只是把视口往下推一点
        <form
          className="flex items-center gap-1.5 px-3 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            handback(true);
          }}
        >
          <Input
            autoFocus
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            placeholder="给 AI 留一句话（可选），比如：已经登录好了"
            aria-label="交还时附带的话"
            className="h-7 text-xs md:text-xs"
          />
          <Button type="submit" size="xs">
            交还
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setNoteOpen(false)}>
            取消
          </Button>
        </form>
      )}
    </div>
  );
});

const ACTOR_ICON: Record<ActivityActor, { Icon: typeof Bot; className: string }> = {
  ai: { Icon: Bot, className: "text-primary" },
  user: { Icon: User, className: "text-info" },
  system: { Icon: Info, className: "text-muted-foreground" },
};

const ActivityRow = memo(function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const { Icon, className } = ACTOR_ICON[entry.actor];
  const summary = describeActivity(entry);
  return (
    // 摘要在数据层已截到 160 字，这里直接换行显示全文：不 truncate 也就不需要 hover 补全。
    // 该区域在视口正下方，tooltip 向上弹会压到视口、触发遮盖闪烁，换行比 tooltip 更稳
    <li className="flex items-start gap-2 py-0.5 text-xs">
      <Icon
        className={cn("mt-0.5 size-3.5 shrink-0", className)}
        aria-label={ACTIVITY_ACTOR_LABEL[entry.actor]}
      />
      <span className="min-w-0 flex-1 break-words">{summary}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {formatActivityTime(entry.ts)}
      </span>
    </li>
  );
});

/** 可展开的「操作记录」时间线：state.recent（AI / 用户 / 系统用不同图标与颜色，一行摘要，最新在上） */
const ActivityLog = memo(function ActivityLog({ recent }: { recent: ActivityEntry[] }) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => (open ? orderActivityForDisplay(recent) : []), [open, recent]);
  return (
    <div className="shrink-0 border-t">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center gap-1.5 px-3 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        操作记录
        <span className="tabular-nums">{recent.length > 0 ? `（${recent.length}）` : ""}</span>
      </button>
      {open && (
        <ul className="max-h-44 overflow-y-auto px-3 pb-2" aria-label="浏览器操作记录">
          {rows.length === 0 ? (
            <li className="py-1 text-xs text-muted-foreground">还没有操作记录</li>
          ) : (
            rows.map((e) => <ActivityRow key={e.id} entry={e} />)
          )}
        </ul>
      )}
    </div>
  );
});

const EmptyState = () => (
  <div className="absolute inset-0 flex items-center justify-center p-6">
    <EmptyHint
      variant="dashed"
      size="lg"
      align="center"
      icon={<Globe className="size-6 text-muted-foreground" aria-hidden />}
      className="max-w-sm"
    >
      <div className="text-sm font-medium text-foreground">还没有浏览器会话</div>
      <p className="mt-1">
        让 AI 去查资料或操作网页，会话会自动出现在这里；你也可以在上方地址栏输入网址，自己先开始。
      </p>
    </EmptyHint>
  </div>
);

const BrowserPanelInner = ({
  taskId,
  className,
  onClose,
  maximized = false,
  onToggleMaximize,
  coverTarget = "对话",
}: BrowserPanelProps) => {
  const { state } = useBrowserSession(taskId);
  const { confirm } = useDialog();

  const exists = !!state?.exists;
  // 空状态下用户输入网址 = 要启动会话：这时才 attach（attach 会懒创建会话与渲染进程）
  const [started, setStarted] = useState(false);
  const attachEnabled = exists || started;

  const stateRef = useRef<BrowserState | null>(state);
  stateRef.current = state;
  // 会话还没建好时输入的网址：等视口 attach 成功后再导航
  const pendingNavRef = useRef<string | null>(null);

  const doNavigate = useCallback(
    async (input: string) => {
      const bridge = window.__browser;
      if (!bridge) return;
      try {
        const res = await bridge.navigate(taskId, input);
        if (!res.ok) toast.error(res.error ?? "无法打开这个地址");
      } catch (err) {
        toast.error(`打开失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [taskId],
  );

  const navigate = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      if (stateRef.current?.exists) {
        void doNavigate(text);
        return;
      }
      pendingNavRef.current = text;
      setStarted(true);
    },
    [doNavigate],
  );

  const handleAttached = useCallback(() => {
    const pending = pendingNavRef.current;
    if (!pending) return;
    pendingNavRef.current = null;
    void doNavigate(pending);
  }, [doNavigate]);

  // 聊天里的链接 / 本地 HTML 要求「在新标签打开」：会话已存在且当前标签有内容 → newTab；失败（地址被策略拒绝等）给个提示
  const openInNewTab = useCallback(
    async (url: string) => {
      const bridge = window.__browser;
      if (!bridge) return;
      try {
        const id = await bridge.newTab(taskId, url);
        if (!id) toast.error("内置浏览器打不开这个地址");
      } catch (err) {
        toast.error(`打开失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [taskId],
  );

  // 预览入口 / 聊天链接「在内置浏览器打开」：面板刚挂载时取一次；面板已挂着时靠订阅通知
  useEffect(() => {
    const consume = () => {
      const nav = takePendingNavigationRequest(taskId);
      if (!nav) return;
      if (decidePanelOpen(stateRef.current, nav) === "new-tab") void openInNewTab(nav.url);
      else navigate(nav.url);
    };
    consume();
    return subscribePendingNavigation(taskId, consume);
  }, [taskId, navigate, openInNewTab]);

  // 会话建好后，「启动意图」就由 exists 接管（否则会话被关闭后 started 还为真，会立刻又 attach 一个新的）
  useEffect(() => {
    if (exists) setStarted(false);
  }, [exists]);

  // 拾取：onPicked → 输入框；Esc 取消；面板卸载时若还在拾取就取消（视图会被撤走，别让它卡在拾取态）
  useEffect(() => {
    const bridge = window.__browser;
    if (!bridge) return;
    return bridge.onPicked((tid, picked) => {
      if (tid === taskId) deliverPickedElement(taskId, picked);
    });
  }, [taskId]);
  const picking = !!state?.picking;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  useEffect(
    () => () => {
      if (pickingRef.current) window.__browser?.cancelPick(taskId);
    },
    [taskId],
  );
  useEffect(() => {
    if (!picking) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") window.__browser?.cancelPick(taskId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [picking, taskId]);

  const activeTab = findActiveTab(state);

  // 页内查找条（契约 §14.3）：记「在哪个 tab 上打开的」——切 tab 后条自然收起，不用 effect 同步 state
  const [findTabId, setFindTabId] = useState<string | null>(null);
  const [findToken, setFindToken] = useState(0);
  const activeTabId = state?.activeTabId ?? null;
  const findOpen = findTabId !== null && findTabId === activeTabId;
  const openFind = useCallback(() => {
    setFindTabId(stateRef.current?.activeTabId ?? null);
    setFindToken((n) => n + 1);
  }, []);
  const closeFind = useCallback(() => setFindTabId(null), []);
  // 页面持有焦点时 Cmd/Ctrl+F 经主进程 before-input-event 推 browser:findRequested；老壳没有该订阅就只靠面板内快捷键
  useEffect(
    () =>
      window.__browser?.onFindRequested?.((tid) => {
        if (tid === taskId) openFind();
      }),
    [taskId, openFind],
  );

  const currentUrl = displayAddress(activeTab?.url);
  // 地址栏：聚焦编辑时用草稿，其余时候直接显示当前 URL（不用 effect 同步，导航后自然跟上）
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const addressValue = editing ? draft : currentUrl;
  const loading = !!activeTab?.loading;

  const onSubmitAddress = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    navigate(draft);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const statusModel = describeStatusBar(state);
  const recent = state?.recent;
  // V4 新增状态：全部可选字段，老壳缺省按「无」处理
  const zoomLabel = formatZoomLabel(activeTab?.zoom);
  const emulationLabel = emulationLabelOf(activeTab);
  // 设备视口比面板大时页面被整体缩小：给个「适应 72%」，免得用户以为页面本身变小了
  const fitLabel = fitScaleLabelOf(activeTab);
  const fitPercent = fitScalePercentOf(activeTab);
  const downloads = useMemo(() => readDownloads(state?.downloads), [state?.downloads]);
  const bridgeCaps = typeof window === "undefined" ? undefined : window.__browser;
  const canOpenDevTools = typeof bridgeCaps?.openDevTools === "function";

  const openExternal = () => {
    if (!isExternalOpenableUrl(activeTab?.url)) return;
    const url = activeTab.url;
    const open = window.__shell?.openExternal;
    if (open) open(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  // 确认 → 清除的流程与设置页共用（clear-data-flow.ts）：同一份文案、取消绝不碰数据
  const clearData = async () => {
    await runClearBrowsingData({
      confirm,
      clear: () => window.__browser?.clearBrowsingData(),
      onSuccess: () => toast.success("已清除浏览器登录数据"),
      onError: (msg) => toast.error(`清除失败：${msg}`),
    });
  };

  return (
    <div
      className={cn("flex h-full min-h-0 w-full flex-col bg-background", className)}
      onKeyDown={(e) => {
        // 焦点在面板里（地址栏 / 按钮）时的 Cmd/Ctrl+F；焦点在页面里由主进程推 browser:findRequested
        if (exists && isFindShortcut(e, window.__shell?.platform === "darwin")) {
          e.preventDefault();
          // 不让事件继续冒泡到 window：app-shell 的全局 Cmd/Ctrl+F 会在任务页再弹对话流 / 产物搜索条并抢焦点（R1-15）。
          // app-shell 那头另有 defaultPrevented 判断做第二道
          e.stopPropagation();
          openFind();
        }
      }}
    >
      {/* 工具栏。整行不换行：唯一能压缩的是地址栏（min-w-0 flex-1），其余按钮都是 shrink-0。
          外层 @container：按面板自己的宽度（不是窗口宽度）收紧——面板最窄 300px，再塞缩放标签 + 下载钮地址栏就被压没、
          按钮挤出面板（R9-05）。窄于 360px：缩放标签让位（「更多」菜单里仍有重置缩放）、间距 / 左右留白收紧。
          内层 min-w-0 overflow-hidden 是最后一道兜底：真有放不下的组合，宁可裁掉也别把面板撑出横向滚动条 */}
      <div className="@container min-w-0 shrink-0">
        <div
          data-slot="browser-toolbar"
          className="relative flex min-w-0 items-center gap-1 overflow-hidden border-b px-2 py-1.5 @max-[360px]:gap-0.5 @max-[360px]:px-1"
        >
          <IconButton
            label="后退"
            disabled={!activeTab?.canGoBack}
            onClick={() => window.__browser?.back(taskId)}
          >
            <ArrowLeft />
          </IconButton>
          <IconButton
            label="前进"
            disabled={!activeTab?.canGoForward}
            onClick={() => window.__browser?.forward(taskId)}
          >
            <ArrowRight />
          </IconButton>
          {loading ? (
            <IconButton label="停止加载" onClick={() => window.__browser?.stop(taskId)}>
              <X />
            </IconButton>
          ) : (
            <IconButton
              label="刷新"
              disabled={!exists}
              onClick={() => window.__browser?.reload(taskId)}
            >
              <RotateCw />
            </IconButton>
          )}

          {picking ? (
            // 拾取模式：地址栏位置换成提示（Esc / 按钮都能取消）
            <div
              role="status"
              className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-2.5 text-xs"
            >
              <MousePointerClick className="size-3.5 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0 flex-1 truncate">正在拾取，点击页面元素；Esc 取消</span>
            </div>
          ) : (
            <form onSubmit={onSubmitAddress} className="min-w-0 flex-1">
              <Input
                type="text"
                value={addressValue}
                aria-label="地址栏"
                placeholder={exists ? "输入网址或搜索词" : "输入网址开始浏览"}
                spellCheck={false}
                autoComplete="off"
                className="h-7 text-xs md:text-xs"
                onFocus={(e) => {
                  setDraft(currentUrl);
                  setEditing(true);
                  e.currentTarget.select();
                }}
                onBlur={() => setEditing(false)}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setEditing(false);
                    e.currentTarget.blur();
                  }
                }}
              />
            </form>
          )}

          {/* 缩放 ≠ 100% 才显示；点一下重置。工具栏窄于 360px 时先让位（「更多」菜单里仍有重置缩放） */}
          {zoomLabel && (
            <Tooltip content="点击重置缩放" side="top">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={`缩放 ${zoomLabel}，点击重置`}
                onClick={() => window.__browser?.zoom?.(taskId, "reset")}
                className="shrink-0 tabular-nums @max-[360px]:hidden"
              >
                {zoomLabel}
              </Button>
            </Tooltip>
          )}

          <BrowserDownloads taskId={taskId} downloads={downloads} />

          <IconButton
            label={picking ? "取消拾取元素" : "拾取元素"}
            pressed={picking}
            disabled={!exists}
            onClick={() =>
              picking ? window.__browser?.cancelPick(taskId) : window.__browser?.startPick(taskId)
            }
          >
            <MousePointerClick />
          </IconButton>

          <DropdownMenu>
            <Tooltip content="更多" side="top">
              <DropdownMenuTrigger
                aria-label="更多"
                className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "shrink-0")}
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem onClick={openFind} disabled={!exists}>
                <Search className="size-3.5" />
                在页面中查找
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => window.__browser?.zoom?.(taskId, "in")}
                disabled={!exists || !canZoomIn(activeTab?.zoom)}
              >
                <ZoomIn className="size-3.5" />
                放大
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => window.__browser?.zoom?.(taskId, "out")}
                disabled={!exists || !canZoomOut(activeTab?.zoom)}
              >
                <ZoomOut className="size-3.5" />
                缩小
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => window.__browser?.zoom?.(taskId, "reset")}
                disabled={!exists || !zoomLabel}
              >
                <RotateCcw className="size-3.5" />
                重置缩放
              </DropdownMenuItem>
              {canOpenDevTools && (
                <DropdownMenuItem onClick={() => window.__browser?.openDevTools?.(taskId)} disabled={!exists}>
                  <Code className="size-3.5" />
                  开发者工具
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={openExternal}
                disabled={!isExternalOpenableUrl(activeTab?.url)}
              >
                <ExternalLink className="size-3.5" />
                在系统浏览器打开当前页
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void clearData()} className="text-destructive">
                <Trash2 className="size-3.5" />
                清除登录数据
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* 面板级操作放最右、与页面级工具隔开：放大（盖住旁边的栏）/ 关闭抽屉。
              关闭用 X、放大用 Maximize2：loading 时最左的 X 是「停止加载」，靠 tooltip 与位置区分 */}
          {onToggleMaximize && (
            <IconButton
              label={maximized ? `还原（重新显示${coverTarget}）` : `放大浏览器，盖住${coverTarget}`}
              pressed={maximized}
              onClick={onToggleMaximize}
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </IconButton>
          )}
          {onClose && (
            <IconButton label="关闭浏览器" onClick={onClose}>
              <X />
            </IconButton>
          )}

          {/* 加载进度：主进程只给 loading 布尔、没有百分比——画一条静态细线（无 aria-valuenow = 不确定进度）。
              不用 animate-pulse：ui-conventions「同屏只留一处主动效」，加载中的动态已经有标签页里的 spinner（R2-14 ⑤） */}
          {loading && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-info"
              role="progressbar"
              aria-label="页面加载中"
            />
          )}
        </div>
      </div>

      {/* 设备 / 环境模拟条（V5 生产 TabInfo.emulation）：独占一整行，不再和地址栏抢工具栏宽度（R9-05：以前挤在工具栏里，
          窄面板 + 「适应 xx%」时地址栏被压到 22px、右侧按钮被挤出面板）。「适应 xx%」是独立的 shrink-0 徽标：
          摘要太长时只截摘要，不会先把它截掉。tooltip 朝上：朝下会落进视口，原生视图盖在 HTML 之上会触发整块遮盖 */}
      {emulationLabel && (
        <div
          data-slot="browser-emulation-bar"
          className="flex min-w-0 shrink-0 items-center gap-1 border-b bg-info/10 py-0.5 pr-1.5 pl-2.5 text-[11px] text-info"
        >
          <Tooltip
            content={fitPercent !== null ? `模拟中：${emulationLabel}（页面已整体缩小到 ${fitPercent}% 以放进面板，放大面板可恢复）` : `模拟中：${emulationLabel}`}
            side="top"
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="min-w-0 truncate">模拟中：{emulationLabel}</span>
              {fitLabel && <span className="shrink-0 tabular-nums">{fitLabel}</span>}
            </span>
          </Tooltip>
          <IconButton size="icon-xs" label="重置设备模拟" onClick={() => window.__browser?.resetEmulation?.(taskId)}>
            <RotateCcw />
          </IconButton>
        </div>
      )}

      {state && state.tabs.length > 0 && <TabStrip taskId={taskId} tabs={state.tabs} />}

      <StatusBar taskId={taskId} model={statusModel} />

      {/* 页面 JS 对话框（state.dialog，V5 生产）：状态条下方一条，缺省不画 */}
      <BrowserDialogBar taskId={taskId} dialog={state?.dialog} />

      {/* 增强包 E2（契约 §15.2）：等待用户处理的提示 / 断点暂停 / AI 的网络规则 / 录制中，缺省不画 */}
      <BrowserExtraBars taskId={taskId} state={state} />

      {findOpen && <BrowserFindBar taskId={taskId} focusToken={findToken} onClose={closeFind} />}

      <BrowserViewport taskId={taskId} attachEnabled={attachEnabled} onAttached={handleAttached}>
        {!attachEnabled && <EmptyState />}
      </BrowserViewport>

      {exists && <ActivityLog recent={recent ?? []} />}
    </div>
  );
};

/**
 * 面板入口。没有 `window.__browser`（网页版 / 旧壳 / SSR）→「仅桌面端可用」，不报错。
 * 内层以 taskId 为 key：切任务时整块重建，避免上一个任务的「启动意图 / 草稿」串过去。
 */
export const BrowserPanel = ({ taskId, className, ...panelProps }: BrowserPanelProps) => {
  const available = useBrowserAvailable();
  if (!available) return <BrowserUnavailable className={className} />;
  return <BrowserPanelInner key={taskId} taskId={taskId} className={className} {...panelProps} />;
};
