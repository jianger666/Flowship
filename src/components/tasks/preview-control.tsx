"use client";

/**
 * 仓卡片里的预览控件（原来 ▶ / ●预览中 + 打开 + 内置浏览器 + 日志 + 停止 共 6 个小图标，现在收成一个胶囊）：
 *
 *   未启动   [▶ 预览]
 *   启动中   [⟳ 启动中 ▾]
 *   已就绪   [● :8000 ▾]      点胶囊 = 打开（桌面端进内置浏览器，网页版开新标签页）
 *   运行中   [● 运行中 ▾]      超过 30s 仍没探到地址：命令可能不是 web 服务——点胶囊看日志
 *   已退出   [● 已退出 ▾]      点胶囊 = 看日志
 *
 * ▾ 菜单：在内置浏览器打开 / 在浏览器中打开 / 复制地址 / 查看日志 / 重启 / 停止（已退出：重新启动 / 清除状态）。
 * 日志在弹窗里看（比 popover 大、可复制、自动贴底、打开期间轮询加快）。
 *
 * 纯展示 + 弹窗内部状态：启动 / 停止 / 轮询都由 WorkspaceActions 持有（同仓一个预览位的权威状态在 server）。
 * 状态推导等纯逻辑在 @/lib/preview-ui-state。
 */

import {
  ChevronDown,
  Copy,
  ExternalLink,
  FileTerminal,
  Globe,
  Loader2,
  Play,
  RotateCw,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import {
  PREVIEW_LOG_TAIL_LINES,
  PREVIEW_POLL_FAST_MS,
  derivePreviewPhase,
  isPreviewAlive,
  previewOccupiedHint,
  previewPortLabel,
  previewStatusText,
} from "@/lib/preview-ui-state";
import type { PreviewSlotStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  /** 卡片上显示的仓短名（读屏用：多仓时每个仓都有一个同样的控件，名字里要带仓名） */
  repoName: string;
  /** 设置页配的启动命令（只用于展示，实际执行的命令由 server 从权威配置查） */
  command: string;
  /** 本任务在该仓的预览位（没有 = 未启动） */
  slot: PreviewSlotStatus | undefined;
  /** 同仓被别的任务占着的预览位——启动会把它顶掉，只用来提醒 */
  occupiedBy: PreviewSlotStatus | undefined;
  /** 当前时间（由父组件随轮询刷新；组件自身不读时钟，保持渲染纯净） */
  now: number;
  /** 启动 / 停止请求进行中 */
  pending: boolean;
  /** 桌面端才有内置浏览器 */
  browserAvailable: boolean;
  /** 启动 / 重启 / 重新启动共用：server 起新进程前会先清掉同仓旧进程 */
  onStart: () => void;
  onStop: () => void;
  onOpenInBrowserPanel: (url: string) => void;
  /** 立即拉一次预览状态（日志弹窗打开期间用来加快刷新） */
  onRefresh: () => void;
}

// 可访问名 = 动作 +（仓名）：多仓时每仓一份同样的控件，不带仓名读屏分不清（R14 Q19-01，同 workspace-actions）
const iconLabel = (action: string, repoName: string): string => `${action}（${repoName}）`;

const PILL_BTN = "h-6 min-w-0 gap-1 px-1.5 text-xs font-normal";

export const PreviewControl = ({
  repoName,
  command,
  slot,
  occupiedBy,
  now,
  pending,
  browserAvailable,
  onStart,
  onStop,
  onOpenInBrowserPanel,
  onRefresh,
}: Props) => {
  const [logOpen, setLogOpen] = useState(false);
  const phase = derivePreviewPhase(slot, now);
  const alive = isPreviewAlive(phase);
  const url = slot?.url ?? null;
  // 菜单里「打开 / 复制地址」只在进程还活着时给：进程退出后 slot.url 还留着，但那个地址已经打不开了
  const liveUrl = alive ? url : null;

  // 预览位没了（停止 / 被别的任务顶掉）：弹窗不能留着「开」的状态，否则下次启动会无故弹出来
  // （React 推荐的「渲染期按 props 调整 state」写法，不用 effect）。
  // 重启 / 停止请求在途（pending）时服务端有「旧槽已删、新槽未放」的空窗，此时的 idle 不算数，别把弹窗关掉
  if (phase === "idle" && logOpen && !pending) setLogOpen(false);

  // 日志弹窗开着：加快刷新，输出滚动得跟得上。
  // onRefresh 用 ref 取最新值、effect 只依赖 logOpen：父组件每次渲染（agent 的事件流会让任务页高频重渲染）
  // 都可能换一个新的回调引用，依赖它会让定时器不停地被清掉重建、一次都触发不了
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  });
  useEffect(() => {
    if (!logOpen) return;
    const timer = setInterval(() => onRefreshRef.current(), PREVIEW_POLL_FAST_MS);
    return () => clearInterval(timer);
  }, [logOpen]);

  const copyUrl = async () => {
    if (!liveUrl) return;
    try {
      await navigator.clipboard.writeText(liveUrl);
      toast.success("预览地址已复制");
    } catch {
      toast.error("复制失败、请手动复制");
    }
  };

  // 复制日志：navigator.clipboard 在非安全上下文（网页版经 http 局域网 IP 访问）里是 undefined，
  // 同步取属性会抛——整个放进 async 的 try 里；没有日志时不假装复制成功
  const logLines = slot?.logTail ?? [];
  const copyLog = async () => {
    if (logLines.length === 0) return;
    try {
      await navigator.clipboard.writeText(logLines.join("\n"));
      toast.success("日志已复制");
    } catch {
      toast.error("复制失败、请手动复制");
    }
  };

  // ① 未启动：一个带字的启动钮（比单个 ▶ 图标好认）
  if (phase === "idle") {
    const occupied = previewOccupiedHint(occupiedBy);
    return (
      <Tooltip
        content={
          <div className="space-y-0.5">
            <div className="font-mono">$ {command}</div>
            {occupied && <div className="text-muted-foreground">{occupied}</div>}
          </div>
        }
      >
        {/* span 包一层：disabled 的按钮不触发 hover，tooltip 会丢 */}
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="sm"
            className={cn(PILL_BTN, "text-muted-foreground hover:text-foreground")}
            aria-label={iconLabel(`启动预览:${command}`, repoName)}
            disabled={pending}
            onClick={onStart}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            预览
          </Button>
        </span>
      </Tooltip>
    );
  }

  // ② 已有预览位：状态胶囊 + 菜单
  const dot =
    phase === "starting" ? (
      <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
    ) : (
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          phase === "exited" ? "bg-destructive/80" : "bg-success",
        )}
      />
    );
  const mainLabel =
    phase === "starting"
      ? "启动中"
      : phase === "ready"
        ? (previewPortLabel(url) ?? "运行中")
        : phase === "running"
          ? "运行中"
          : "已退出";
  const mainContent = (
    <>
      {dot}
      <span className={cn("truncate", phase === "exited" && "text-destructive")}>{mainLabel}</span>
    </>
  );
  const mainClass = cn(PILL_BTN, "rounded-r-none text-foreground");

  // 已就绪：点胶囊 = 打开地址；其余状态：点胶囊 = 看日志（失败排查 / 看到哪一步了）
  const mainTip =
    phase === "ready" && url
      ? browserAvailable
        ? `在内置浏览器打开 ${url}`
        : `打开 ${url}`
      : `${previewStatusText(phase, slot, now)} · 点击查看日志`;
  const main =
    phase === "ready" && url ? (
      browserAvailable ? (
        <Button
          variant="ghost"
          size="sm"
          className={mainClass}
          aria-label={iconLabel(`在内置浏览器打开 ${url}`, repoName)}
          onClick={() => onOpenInBrowserPanel(url)}
        >
          {mainContent}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className={mainClass}
          aria-label={iconLabel(`打开 ${url}`, repoName)}
          nativeButton={false}
          render={<a href={url} target="_blank" rel="noopener noreferrer" className="no-underline" />}
        >
          {mainContent}
        </Button>
      )
    ) : (
      <Button
        variant="ghost"
        size="sm"
        className={mainClass}
        aria-label={iconLabel(`查看预览状态与日志（${mainLabel}）`, repoName)}
        onClick={() => setLogOpen(true)}
      >
        {mainContent}
      </Button>
    );

  return (
    <>
      <div className="inline-flex items-center rounded-md bg-muted/50">
        <Tooltip content={mainTip}>{main}</Tooltip>
        <DropdownMenu>
          <Tooltip content="预览操作">
            <DropdownMenuTrigger
              aria-label={iconLabel("预览更多操作", repoName)}
              disabled={pending}
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "h-6 w-5 shrink-0 rounded-l-none p-0 text-muted-foreground",
              )}
            >
              {pending ? <Loader2 className="size-3 animate-spin" /> : <ChevronDown className="size-3" />}
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="start" className="min-w-44">
            {liveUrl && browserAvailable && (
              <DropdownMenuItem onClick={() => onOpenInBrowserPanel(liveUrl)}>
                <Globe className="size-3.5" />
                在内置浏览器打开
              </DropdownMenuItem>
            )}
            {liveUrl && (
              <DropdownMenuLinkItem href={liveUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3.5" />
                在浏览器中打开
              </DropdownMenuLinkItem>
            )}
            {liveUrl && (
              <DropdownMenuItem onClick={() => void copyUrl()}>
                <Copy className="size-3.5" />
                复制地址
              </DropdownMenuItem>
            )}
            {liveUrl && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => setLogOpen(true)}>
              <FileTerminal className="size-3.5" />
              查看日志
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onStart}>
              <RotateCw className="size-3.5" />
              {alive ? "重启" : "重新启动"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onStop} className={alive ? "text-destructive" : undefined}>
              <Square className="size-3.5" />
              {alive ? "停止" : "清除状态"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              预览日志 · {repoName}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                最近 {PREVIEW_LOG_TAIL_LINES} 行
              </span>
            </DialogTitle>
            <DialogDescription>{previewStatusText(phase, slot, now)}</DialogDescription>
          </DialogHeader>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            $ {slot?.command ?? command}
          </div>
          <LogPane lines={logLines} />
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={logLines.length === 0}
              onClick={() => void copyLog()}
            >
              <Copy className="size-3.5" />
              复制日志
            </Button>
            <Button variant="outline" size="sm" disabled={pending} onClick={onStart}>
              <RotateCw className="size-3.5" />
              {alive ? "重启" : "重新启动"}
            </Button>
            {alive && (
              <Button variant="outline" size="sm" disabled={pending} onClick={onStop}>
                <Square className="size-3.5" />
                停止
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

/** 日志面板：用户停在底部时随新输出自动贴底；往上翻了就不抢滚动位置 */
const LogPane = ({ lines }: { lines: string[] }) => {
  const ref = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  const text = lines.length > 0 ? lines.join("\n") : "（暂无输出）";

  useEffect(() => {
    const el = ref.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-[55vh] min-h-32 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap wrap-anywhere"
    >
      {text}
    </pre>
  );
};
