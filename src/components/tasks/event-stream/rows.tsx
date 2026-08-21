"use client";

/**
 * 事件流子组件：Row 系列 + Markdown 渲染
 *
 * 从 event-stream.tsx 抽出（V0.5.11）：
 *   - MarkdownText：assistant_message 用 markdown 渲染
 *   - SkillTokenText：user_reply 纯文本 + 真实 skill `/name` 高亮
 *   - StreamingAssistantRow：chat 模式流式 placeholder「AI 回复中...」
 *   - EventRow：单条事件渲染（含图标 / phase 标签 / 时间 / 折叠 / 附图 / 附路径）
 *   - AskUserRequestRow：ask_user 事件历史回放卡（V0.3.2 起交互移到 modal、这里只放历史）
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  File as FileIcon,
  Folder,
  Loader2,
  MessageSquareText,
  PencilLine,
  Plug,
  Quote,
  RotateCcw,
  Send,
  Share2,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownText } from "@/components/markdown-text";
import { SearchHighlightText } from "@/components/ui/search-highlight-text";
import { useOwnerHasSearchHit } from "@/components/ui/pane-search-highlight-context";
import {
  ImageThumb,
  type PreviewImage,
} from "@/components/ui/image-preview";
import {
  MessageActionBar,
  MESSAGE_ACTION_HOST,
  type MessageActionInput,
} from "@/components/ui/message-action-bar";
import {
  SelectionFloatButton,
  useSelectionFloat,
} from "@/components/ui/selection-float";
import { useShareToGroup } from "@/hooks/use-share-to-group";
import {
  extractAskQuestions,
  isAskSkipped,
  isAskSuperseded,
} from "@/lib/ask-pending";
import { shouldCollapseUserMessage } from "@/lib/chat-stream-display";
import { formatDurationPrecise } from "@/lib/duration-display";
import { getIdeAnchorProps } from "@/lib/ide-open";
import { isLightweightDailyTask } from "@/lib/lightweight-task";
import { pathBasename } from "@/lib/path-utils";
import { shouldSubmitOnKeyDown } from "@/lib/submit-shortcut";
import { useJumpIde, useSubmitShortcut } from "@/hooks/use-settings";
import { ACTION_LABEL_SHORT } from "@/lib/task-display";
import { isInTurnToolErrorEvent } from "@/lib/tool-display";
import {
  JUMP_IDE_LABEL,
  type ActionType,
  type Task,
  type TaskEvent,
} from "@/lib/types";

import { ErrorCard } from "./error-card";
import {
  ActionTag,
  DEFAULT_EXPANDED_KINDS,
  EVENT_LABEL,
  extractUserReplyAttachments,
  extractUserReplyImages,
  formatTs,
  renderEventIcon,
  summarize,
  type ToolCallBatchItem,
} from "./utils";

// Markdown 渲染统一走 @/components/markdown-text（v1.0 迁 Streamdown）——
// 这里 re-export 保持既有 import 路径不变（ask-user-inline / workitem-detail 等仍从本文件拿）
export { MarkdownText } from "@/components/markdown-text";

/** 「引用」选区上限：整篇引进输入框会把草稿撑爆 */
const QUOTE_MAX_LENGTH = 1000;

/**
 * 流式 placeholder 卡片：复用 assistant_message 的视觉样式
 *
 * 出现条件：chat-view 收到 SDK assistant chunk 推 streamingText 非空
 * 消失条件：收到正式 assistant_message 事件、chat-view setStreamingText("")
 *
 * 视觉提示：左侧图标 + 标签「AI 回复中...」+ 末尾闪烁光标、明显区分「流式中」vs「已完成」
 */
const StreamingAssistantRowImpl = ({
  text,
  variant = "log",
  baseDir,
  ownerId = "__streaming__",
}: {
  text: string;
  variant?: "log" | "chat";
  baseDir?: string;
  ownerId?: string;
}) => {
  // chat 形态：跟正式 AI 回复同样平铺（Streamdown streaming 模式自带流式动画、无容器）
  // 字号 / 行高必须与正式 assistant 气泡（text-[15px] leading-7）一致——
  // 不一致的话流式结束换成正式行时整段文字会跳一下
  if (variant === "chat") {
    return (
      <div className="text-[15px] leading-7">
        <MarkdownText
          text={text}
          streaming
          baseDir={baseDir}
          searchOwnerId={ownerId}
          searchField="extra0"
        />
      </div>
    );
  }
  return (
    // 「AI 回复中」是进行中、不是成功：走 info 而非原来的 emerald
    <div className="flex gap-2 rounded-md border border-info/30 bg-info/5 p-2">
      <div className="mt-0.5 shrink-0">
        <Sparkles className="size-4 animate-pulse text-info" />
      </div>
      <div className="min-w-0 flex-1 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground/70 text-[11px]">
            AI 回复中…
          </span>
        </div>
        <div className="mt-1 leading-relaxed wrap-break-word text-foreground">
          {/* 流式过程按 markdown 渲染、Streamdown 未闭合块平滑处理 */}
          <MarkdownText
          text={text}
          streaming
          baseDir={baseDir}
          searchOwnerId={ownerId}
          searchField="extra0"
        />
        </div>
      </div>
    </div>
  );
};

// React.memo（V0.5.14）：text 频繁因 chunk 追加而变化、其他时候稳定
// memo 让 SSE 推 chunk 时只有 text 真的变了才重渲染、Virtuoso 内部 item 不无意义 reconcile
export const StreamingAssistantRow = memo(StreamingAssistantRowImpl);

interface ProcessEventRowProps {
  ev: TaskEvent;
  collapsed: boolean;
  summary: string;
  batch: ToolCallBatchItem[] | null;
  actionTag?: string;
  isToolCall: boolean;
  isThinking: boolean;
  onToggle: () => void;
}

/**
 * 过程事件行：thinking / tool_call / 普通 info 等低权重事件统一用 chat 的细行样式。
 * task(log) 会额外传 actionTag 保留归属，chat 不传，避免两种场景丢上下文。
 */
const CollapseChevron = ({ open }: { open: boolean }) => (
  <ChevronRight
    className={cn(
      "size-3 shrink-0 opacity-50 transition-transform duration-150",
      open && "rotate-90",
    )}
  />
);

const ProcessEventRow = ({
  ev,
  collapsed,
  summary,
  batch,
  actionTag,
  isToolCall,
  isThinking,
  onToggle,
}: ProcessEventRowProps) => {
  // 思考耗时：SDK 给的 thinking_duration_ms，mergeAdjacentThinking 已把连续几段累加好。
  // 工具块 / 工作过程组都显示耗时，唯独思考一直没显示（Claude Code / Cursor 都有「Thought for 12s」）
  const thinkingDuration = isThinking
    ? formatDurationPrecise(ev.meta?.durationMs)
    : null;
  return (
  <div className="group/proc">
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-muted-foreground"
    >
      <CollapseChevron open={!collapsed} />
      <span className="shrink-0 [&_svg]:size-3">
        {renderEventIcon(ev.kind)}
      </span>
      <span className="shrink-0 text-[11px]">{EVENT_LABEL[ev.kind]}</span>
      {thinkingDuration && (
        <span className="shrink-0 tabular-nums text-[11px] opacity-80">
          · {thinkingDuration}
        </span>
      )}
      {actionTag && <ActionTag label={actionTag} />}
      {collapsed && summary && (
        <span className="min-w-0 flex-1 truncate text-[11px] opacity-80">
          {summary}
        </span>
      )}
      <span className="ml-auto shrink-0 text-[11px] opacity-0 transition-opacity group-hover/proc:opacity-60">
        {formatTs(ev.ts)}
      </span>
    </button>
    {!collapsed && (
      <div className="ml-5 mt-1 border-l border-border/50 pl-3">
        {batch ? (
          <ul className="space-y-1">
            {batch.map((item) => (
              <li
                key={item.id}
                className="flex gap-2 break-all font-mono text-[11px] text-muted-foreground"
              >
                <span className="shrink-0 opacity-60">{formatTs(item.ts)}</span>
                {item.name && (
                  <span className="shrink-0 text-info/80">{item.name}</span>
                )}
                <span className="min-w-0 flex-1">{item.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div
            className={cn(
              "wrap-break-word text-xs leading-relaxed text-muted-foreground",
              isToolCall && "break-all font-mono text-[11px]",
              isThinking && "italic",
              // 行动指引类提示常是「一句结论 + 逐条明细」，不保留换行会糊成一团
              ev.meta?.notice === true && "whitespace-pre-wrap",
            )}
          >
            <SearchHighlightText
              ownerId={ev.id}
              field="body"
              text={ev.text}
            />
          </div>
        )}
      </div>
    )}
  </div>
  );
};

// V0.13.x「重连中」过程行（自动重连、event-stream 分流层直挂）：
// spinner + warning 文案、同 thinking / 工具调用一档的细行、不可折叠。
// 是否还在转圈看后续事件：出现 reconnected / error / 更新的 reconnecting 后静态显示
export const ReconnectingRow = memo(
  ({ ev, events }: { ev: TaskEvent; events: TaskEvent[] }) => {
    const idx = events.findIndex((e) => e.id === ev.id);
    const settled =
      idx < 0 ||
      events
        .slice(idx + 1)
        .some(
          (e) =>
            e.kind === "error" ||
            (e.kind === "info" &&
              (e.meta?.kind === "reconnected" ||
                e.meta?.kind === "reconnecting")),
        );
    return (
      <div className="flex items-center gap-2 px-1.5 py-1 text-xs text-warning">
        {settled ? (
          <Plug className="size-3.5 shrink-0 opacity-60" />
        ) : (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        )}
        <span className={cn(settled && "opacity-60")}>
          <SearchHighlightText ownerId={ev.id} field="body" text={ev.text} />
        </span>
        <span className="text-[11px] text-muted-foreground/70">
          {formatTs(ev.ts)}
        </span>
      </div>
    );
  },
);
ReconnectingRow.displayName = "ReconnectingRow";

/** 用户消息气泡：w-fit 短句收窄；max-w + min-w-0 + 内层 w-full wrap-anywhere 防长 URL 撑破 */
const USER_REPLY_BUBBLE =
  "ml-auto w-fit max-w-[85%] min-w-0 rounded-lg border border-border/60 bg-muted/40 px-3.5 py-2.5";
const USER_REPLY_TEXT =
  "w-full min-w-0 wrap-anywhere whitespace-pre-wrap text-sm leading-relaxed";

/** 本地排队占位气泡（半透明 + 时钟；uncertain 显示确认中）——用户消息、跟正式气泡同样右对齐 */
export const PendingLocalReplyRow = memo(
  ({
    text,
    uncertain,
    ownerId,
  }: {
    text: string;
    uncertain?: boolean;
    ownerId: string;
  }) => (
    <div className="ml-auto flex w-fit max-w-[85%] min-w-0 items-start gap-2 rounded-lg border border-dashed border-border/60 bg-muted/20 px-3.5 py-2.5 opacity-70">
      <Clock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div
        className={cn(
          USER_REPLY_TEXT,
          "flex-1 text-muted-foreground",
        )}
      >
        <span className="mb-0.5 block text-[11px] tracking-wide">
          {uncertain ? "发送状态未知、正在确认…" : "待发送"}
        </span>
        <SearchHighlightText ownerId={ownerId} field="extra0" text={text} />
      </div>
    </div>
  ),
);
PendingLocalReplyRow.displayName = "PendingLocalReplyRow";

const EventRowImpl = ({
  ev,
  taskId,
  task,
  variant = "log",
  onResend,
  onRegenerate,
  onRewind,
  onQuote,
  runActive = false,
}: {
  ev: TaskEvent;
  taskId: string;
  task: Task;
  // log：task 模式事件流（卡片 + header + 折叠、信息密度优先）
  // chat：自由模式对话（V0.7.11、Cursor agent window 风格——AI 平铺 / 用户浅色块 / 过程细行）
  variant?: "log" | "chat";
  // v1.0：chat「最后一条用户消息」的重发 / 原地编辑（手动停止 / 断网后想改一下重说）——
  // hover 出两个 icon：↻ 原样重发、✎ 原地编辑后发；都是「发一条新消息到末尾」（架构是
  // 持久会话 append-only、做不了 ChatGPT 那种 fork 截断）；只有最后一条用户消息才传（父组件把关）
  // 第二参 sourceEv：重发时带回原 meta.images / attachments（批 B）
  // 返回 false = 发送失败（编辑态保持）；true / void = 成功可关编辑
  onResend?: (
    text: string,
    sourceEv?: TaskEvent,
  ) => boolean | void | Promise<boolean | void>;
  // chat「最后一条 AI 回复」的重新生成：等价于把最后一条用户消息原样再发一遍
  // （append-only、历史保留、不做 fork）；父组件只给最后一条 assistant 传、内部复用 handleResend
  onRegenerate?: () => void | Promise<void>;
  /** chat checkpoint 回退：仅 checkpointed user_reply + 非 running 时传 */
  onRewind?: (eventId: string) => void;
  /**
   * chat「引用追问」：选中 AI 回复一段文字后点浮动「引用」——把选区文本回传给父、
   * 由 event-stream 前置成 markdown blockquote 写进 draft（零服务端改动）。
   * 仅 chat + canCompose 时父才传；本组件只在 assistant 分支启用选中检测。
   */
  onQuote?: (text: string) => void;
  /** agent 正在跑：隐藏回退按钮 */
  runActive?: boolean;
}) => {
  const action = ev.actionId
    ? task.actions.find((a) => a.id === ev.actionId)
    : undefined;
  const actionType: ActionType | undefined = action?.type;
  const markdownBaseDir = action?.cwd ?? task.workCwd;

  // 原地编辑态（仅 chat 用户消息 + onResend 存在时有意义）：
  // editing=进入编辑、editDraft=编辑草稿（进入时用原文初始化）
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  // 超长用户消息折叠展开态（Codex「显示更多」同款）：组件内 state、默认折叠
  const [userExpanded, setUserExpanded] = useState(false);
  // 编辑 / 重发飞行锁（防连点；失败时保持 editing）
  const [editSubmitting, setEditSubmitting] = useState(false);
  const resendLockRef = useRef(false);
  // 提交快捷键跟随设置页偏好（Enter / Cmd+Enter、别写死）
  const submitShortcut = useSubmitShortcut();
  // 选中 AI 正文 → 浮「引用」；与产物面板的「选中 → 分享到群」共用公共件
  // containerRef 挂在 AI 回复容器上（已 relative），按钮相对它定位
  const {
    containerRef: assistantContainerRef,
    selection: quoteSelection,
    onMouseUp: onAssistantMouseUp,
    clear: clearQuoteSelection,
  } = useSelectionFloat({ enabled: !!onQuote, maxLength: QUOTE_MAX_LENGTH });
  // 分享到需求群：日常任务隐藏；飞行中 spinner 防双击
  // guideDialog = bot 不在群时的手动添加引导（平时是 null、只在两个能分享的分支里渲染）
  const { runShare, guideDialog } = useShareToGroup();
  const canShareToGroup = !isLightweightDailyTask(task);
  const [sharingMessage, setSharingMessage] = useState(false);

  const handleShareAssistant = async () => {
    if (sharingMessage || !ev.text.trim()) return;
    setSharingMessage(true);
    try {
      await runShare(taskId, { kind: "message", content: ev.text });
    } finally {
      setSharingMessage(false);
    }
  };

  // 入口消失（新消息到来 / 不可发送）时退出编辑态、防 stale 草稿残留
  useEffect(() => {
    if (!onResend) setEditing(false);
  }, [onResend]);

  const runResend = async (
    text: string,
    sourceEv?: TaskEvent,
  ): Promise<boolean> => {
    if (!onResend || resendLockRef.current) return false;
    resendLockRef.current = true;
    try {
      const result = await onResend(text, sourceEv);
      return result !== false;
    } finally {
      resendLockRef.current = false;
    }
  };

  // 附件 chip 的跳转 IDE（设置页可切 Cursor / IDEA）
  const jumpIde = useJumpIde();
  const isUser = ev.kind === "user_reply";
  // ask_user_reply（弹窗答题）也可能带每题贴的图、meta.images 形状跟 user_reply 一致、
  // 共用同一套缩略图渲染（V0.8.3）。attachments 仍只 user_reply 有、不放宽。
  const hasImageMeta = isUser || ev.kind === "ask_user_reply";
  const isAssistant = ev.kind === "assistant_message";
  const isThinking = ev.kind === "thinking";
  const isToolCall = ev.kind === "tool_call";
  const isAwaitingAck = ev.meta?.awaitingAck === true;
  // 需要用户看见并照做的系统提示（如 wk 门禁「跳过了、去设置页配文档仓」）：
  // 普通 info 会被压成一行 truncate 灰字、行动指引全被吃掉，这类走默认展开的可见形态
  const isNotice = ev.meta?.notice === true;
  // checkpointed：可回退到这条用户消息
  const canRewind =
    variant === "chat" &&
    isUser &&
    ev.meta?.checkpointed === true &&
    !!onRewind &&
    !runActive;
  // log 形态降权只看默认折叠规则：过程类降噪，HITL / 失败 / 核心对话保持可见。
  const isDefaultVisible =
    DEFAULT_EXPANDED_KINDS.has(ev.kind) || isAwaitingAck || isNotice;
  // 是否用 markdown 渲染：仅 AI 回复（用户也可能贴 markdown，但气泡要高亮
  // `/skill-name` token，markdown AST 改太重 → user_reply 走 SkillTokenText 纯文本）
  // thinking / tool_call / info / error 一律纯文本（结构化输出 / 错误消息、markdown 反而碍事）
  const useMarkdown = isAssistant;

  const handleCopyAssistant = async () => {
    try {
      await navigator.clipboard.writeText(ev.text);
      toast.success("已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  // tool_call 合并卡判定（V0.5.13）：mergeAdjacentToolCall 给同 phase + 同 tool name
  // 连续 ≥2 条合一时塞 meta.batch + meta.count、UI 折叠 / 展开走 batch 分支
  const batch = useMemo<ToolCallBatchItem[] | null>(
    () => (Array.isArray(ev.meta?.batch) ? (ev.meta.batch as ToolCallBatchItem[]) : null),
    [ev.meta],
  );
  const batchCount = batch?.length ?? 0;

  // user_reply 才解 meta.images / meta.attachments、其他 kind 一律空
  // 避免每行都跑一遍 extract
  const images = useMemo(
    () => (hasImageMeta ? extractUserReplyImages(ev.meta) : []),
    [hasImageMeta, ev.meta],
  );
  const attachments = useMemo(
    () => (isUser ? extractUserReplyAttachments(ev.meta) : []),
    [isUser, ev.meta],
  );

  // 同组附图（lightbox 内左右切换整组）：缩略图 / 大图同源（uploads 静态文件）、title 带文件名 + 大小
  const imageGroup = useMemo<PreviewImage[]>(
    () =>
      images.map((img) => {
        const url = `/api/tasks/${taskId}/uploads/${pathBasename(img.absPath)}`;
        const sizeKb = img.bytes > 0 ? (img.bytes / 1024).toFixed(1) : "?";
        return {
          src: url,
          alt: img.filename ?? "附图",
          title: `${img.filename ?? pathBasename(img.absPath)} · ${sizeKb} KB`,
        };
      }),
    [images, taskId],
  );

  // 折叠状态：所有事件都可折叠、默认值由 DEFAULT_EXPANDED_KINDS 决定
  // - assistant_message / user_reply：默认展开（用户主要看的就是这俩）
  // - info 里带 meta.awaitingAck 的「Action 产出完成、等待 ack」里程碑事件也默认展开（用户要 ack）
  // - 其他：默认折叠（避免 thinking / tool_call 刷屏）
  // 组件内 state、用户手动切换后保持（不会被新事件刷掉）
  const defaultCollapsed = !isDefaultVisible;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const hasSearchHit = useOwnerHasSearchHit(ev.id);

  useEffect(() => {
    if (hasSearchHit) setCollapsed(false);
  }, [hasSearchHit]);

  useEffect(() => {
    if (hasSearchHit) setUserExpanded(true);
  }, [hasSearchHit]);

  const handleToggle = () => setCollapsed((c) => !c);

  // 折叠态文本：摘要、不让超长
  // 展开态：原样 ev.text；batch 模式下展开走 batch 列表
  // batch 模式 summary 追加「×N」后缀、用户一眼看到「这 N 条都是同种工具调用」
  const summary = batch ? `${summarize(ev.text)} ×${batchCount}` : summarize(ev.text);
  const processRow = (
    <ProcessEventRow
      ev={ev}
      collapsed={collapsed}
      summary={summary}
      batch={batch}
      actionTag={variant === "log" && actionType ? (ACTION_LABEL_SHORT[actionType] ?? actionType) : undefined}
      isToolCall={isToolCall}
      isThinking={isThinking}
      onToggle={handleToggle}
    />
  );

  // 错误：chat / log 共用同一张 destructive 卡（原始诊断 meta.detail、复制、当轮重试都在卡里）。
  // 只给「整轮崩溃」（断网 / key / run 挂死）。回合内工具失败带 meta.callId，不画红卡、不给重试——
  // mergeToolDisplayEvents 已丢掉；这里再挡一层，避免漏网。
  // error 已不进「工作过程」组（见 lib/chat-turns.ts 的 MEMBER_KINDS）——run 一结束整组
  // 自动收起、用户正在读的错误会啪一下消失，这是它必须独立平铺的原因。
  if (ev.kind === "error") {
    if (isInTurnToolErrorEvent(ev)) return null;
    return (
      <ErrorCard
        ev={ev}
        events={task.events}
        runActive={runActive}
        // log 形态保留 action 归属标（跟其它 log 行一致、知道是哪个 action 挂的）
        actionTag={
          variant === "log" && actionType
            ? (ACTION_LABEL_SHORT[actionType] ?? actionType)
            : undefined
        }
      />
    );
  }

  // AI 回复的 hover 动作条：chat / log 两形态共用同一份定义（视觉契约在 MessageActionBar）。
  // onRegenerate 只有 chat 的最后一条才有、log 形态天然只剩复制 + 分享。
  const assistantActions: MessageActionInput[] = [
    {
      key: "copy",
      icon: <Copy className="size-3" />,
      label: "复制原文",
      onClick: () => void handleCopyAssistant(),
    },
    canShareToGroup && {
      key: "share",
      icon: <Share2 className="size-3" />,
      label: "分享到需求群",
      onClick: () => void handleShareAssistant(),
      disabled: !ev.text.trim(),
      busy: sharingMessage,
    },
    onRegenerate && {
      key: "regenerate",
      icon: <RotateCcw className="size-3" />,
      label: "重新生成回答",
      // 防连点走父组件 handleResend 的 resendLockRef（与用户消息「重发」同锁）
      onClick: () => void onRegenerate(),
    },
  ];

  // ---------- chat 形态（V0.7.11）----------
  // 设计参照 Cursor agent window：
  //   - AI 回复：无容器平铺、prose 直接落在页面底色上（对话主体、最大可读性）
  //   - 用户消息：浅色圆角块（带左侧细线、视觉「引用」感）、附件随块内显示
  //   - thinking / tool_call / info：单行细条目（小图标 + 摘要 + 时间）、点击展开、
  //     视觉权重压到最低——过程可查但不抢戏
  if (variant === "chat") {
    // AI 回复：平铺 prose、hover 出「复制」；最后一条还可「重新生成」（与复制并排）
    // 字号略大于过程行、长文可读性优先
    if (isAssistant) {
      return (
        <div
          ref={assistantContainerRef}
          className={cn(MESSAGE_ACTION_HOST, "text-[15px] leading-7")}
          onMouseUp={onAssistantMouseUp}
        >
          <MessageActionBar actions={assistantActions} />
          {/* 选区浮动「引用」：定位 / 样式 / 防选区塌陷都在公共件里 */}
          {quoteSelection && onQuote && (
            <SelectionFloatButton
              state={quoteSelection}
              label="引用"
              icon={<Quote className="size-3" />}
              onTrigger={(text) => {
                onQuote(text);
                clearQuoteSelection(true);
              }}
            />
          )}
          <MarkdownText
            text={ev.text}
            baseDir={markdownBaseDir}
            searchOwnerId={ev.id}
            searchField="body"
          />
          {guideDialog}
        </div>
      );
    }
    // 用户消息：浅色圆角块 + 附件；最后一条 hover 右上角出「重发 / 编辑」两 icon（v1.0）
    if (isUser) {
      // 原地编辑态：气泡整体换成 textarea + 取消 / 发送（对齐 ChatGPT / Claude 的编辑交互；
      // 语义是「编辑后作为新消息发到末尾」、原消息保留、不是 fork）
      if (editing && onResend) {
        const trimmed = editDraft.trim();
        const submitEdit = () => {
          if (!trimmed || editSubmitting) return;
          setEditSubmitting(true);
          void (async () => {
            try {
              const ok = await runResend(trimmed, ev);
              if (ok) setEditing(false);
            } finally {
              setEditSubmitting(false);
            }
          })();
        };
        return (
          <div className="rounded-lg border border-ring/60 bg-muted/40 p-2 shadow-sm">
            <Textarea
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              autoFocus
              disabled={editSubmitting}
              className="max-h-64 min-h-[52px] resize-none border-none bg-transparent p-1.5 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
              onKeyDown={(e) => {
                if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!editSubmitting) setEditing(false);
                  return;
                }
                // 提交快捷键跟设置页偏好一致（helper 内部已处理 IME / enter vs mod-enter）
                if (shouldSubmitOnKeyDown(e, submitShortcut)) {
                  e.preventDefault();
                  submitEdit();
                }
              }}
            />
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={editSubmitting}
                onClick={() => setEditing(false)}
              >
                取消
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={!trimmed || editSubmitting}
                onClick={submitEdit}
              >
                {editSubmitting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Send className="size-3" />
                )}
                发送
              </Button>
            </div>
          </div>
        );
      }
      // 折叠判定纯逻辑在 lib/chat-stream-display（可单测）；行数阈值与 line-clamp-8 对应
      const userCollapsible = shouldCollapseUserMessage(ev.text);
      return (
        // 右对齐收窄块（Codex 风、A1）：ml-auto + max-w 85%；min-w-0 + wrap-anywhere 防长 URL 撑破
        <div className={cn(MESSAGE_ACTION_HOST, USER_REPLY_BUBBLE)}>
          <MessageActionBar
            actions={[
              canRewind && {
                key: "rewind",
                icon: <RotateCcw className="size-3" />,
                label: "回退到这里",
                text: "回退到这里",
                onClick: () => onRewind?.(ev.id),
              },
              onResend && {
                key: "resend",
                icon: <RotateCcw className="size-3" />,
                label: "原样重发这条消息",
                onClick: () => void runResend(ev.text, ev),
              },
              onResend && {
                key: "edit",
                icon: <PencilLine className="size-3" />,
                label: "编辑后重发（原消息保留）",
                onClick: () => {
                  setEditDraft(ev.text);
                  setEditing(true);
                },
              },
            ]}
          />
          {/* 飞书桥接来的消息带来源标（方案决策 #1 回显细节：一眼区分「在外面发的」）
              带 info 蓝底衬（2026-07-20 用户反馈灰字太弱） */}
          {ev.meta?.source === "feishu" && (
            <div className="mb-1.5">
              <span className="inline-flex items-center gap-1 rounded-sm bg-info/15 px-1.5 py-0.5 text-[11px] font-medium text-info">
                <MessageSquareText className="size-3" />
                来自飞书
              </span>
            </div>
          )}
          <div
            className={cn(
              USER_REPLY_TEXT,
              userCollapsible && !userExpanded && "line-clamp-8",
            )}
          >
            <SearchHighlightText ownerId={ev.id} field="body" text={ev.text} />
          </div>
          {userCollapsible && (
            <button
              type="button"
              onClick={() => setUserExpanded((v) => !v)}
              className="mt-1 flex cursor-pointer items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {userExpanded ? "收起" : "显示更多"}
              <ChevronDown
                className={cn(
                  "size-3 transition-transform",
                  userExpanded && "rotate-180",
                )}
              />
            </button>
          )}
          {images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {imageGroup.map((g, i) => (
                <ImageThumb
                  key={images[i].absPath}
                  src={g.src}
                  alt={g.alt}
                  title={g.title}
                  group={imageGroup}
                  index={i}
                />
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {attachments.map((att) => (
                <Tooltip
                  key={att.absPath}
                  content={`${att.absPath}\n点击在 ${JUMP_IDE_LABEL[jumpIde]} 中打开`}
                >
                  <a
                    {...(getIdeAnchorProps(att.absPath, undefined, jumpIde) ?? { href: "" })}
                    className="flex min-w-0 max-w-full items-center gap-1 rounded border border-border/60 bg-background/60 px-1.5 py-0.5 text-[11px] no-underline hover:bg-muted"
                  >
                    {/* 目录 / 文件用图标形状区分即可；原来目录染 amber 会跟「等你行动」
                        的品牌琥珀抢注意力（附件 chip 并不需要用户行动） */}
                    {att.isDir ? (
                      <Folder className="size-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 truncate font-mono">{pathBasename(att.absPath)}</span>
                  </a>
                </Tooltip>
              ))}
            </div>
          )}
        </div>
      );
    }
    // ask 答题带图：过程行下挂缩略图（2026-07-20 用户实测：飞书答题贴图 app 里看不见——
    // chat 形态 ask_user_reply 走过程行、原图渲染只在 log 形态有）
    if (ev.kind === "ask_user_reply" && images.length > 0) {
      return (
        <div>
          {processRow}
          <div className="mt-1.5 flex flex-wrap gap-2 pl-6">
            {imageGroup.map((g, i) => (
              <ImageThumb
                key={images[i].absPath}
                src={g.src}
                alt={g.alt}
                title={g.title}
                className="size-16"
                group={imageGroup}
                index={i}
              />
            ))}
          </div>
        </div>
      );
    }
    // info 细线化（Batch C）：普通系统提示降权成居中短线 + 小字；
    // awaitingAck 里程碑 / notice 行动指引仍走 processRow（要可见、可展开看全文）；
    // reconnecting / boot 已在上层分流 / 过滤
    if (ev.kind === "info" && !isAwaitingAck && !isNotice) {
      return (
        <Tooltip content={ev.text}>
          <div className="group/info flex items-center justify-center gap-2 py-0.5">
            <div className="h-px w-12 shrink bg-gradient-to-r from-transparent to-border" />
            <span className="max-w-[70%] truncate text-[11px] text-muted-foreground/60">
              <SearchHighlightText ownerId={ev.id} field="body" text={ev.text} />
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground/50 opacity-0 transition-opacity group-hover/info:opacity-100">
              {formatTs(ev.ts)}
            </span>
            <div className="h-px w-12 shrink bg-gradient-to-l from-transparent to-border" />
          </div>
        </Tooltip>
      );
    }
    // 过程行（thinking / tool_call / error / awaitingAck info…）：单行细条目、可展开
    return processRow;
  }

  if (!isDefaultVisible) {
    return processRow;
  }

  return (
    <div
      className={cn(
        MESSAGE_ACTION_HOST,
        "flex gap-2 rounded-md transition-colors",
        isDefaultVisible
          ? "border bg-card/40 p-2"
          : "border border-transparent bg-transparent px-1.5 py-1 text-muted-foreground/80 hover:bg-muted/20",
        isDefaultVisible && isUser && "border-primary/30 bg-primary/5",
      )}
    >
      {isAssistant && guideDialog}
      {/* log 形态 AI 回复：跟 chat 形态同一条动作条（以前这里只有分享、连复制都没有，
          日常任务 canShareToGroup=false 时整条都不渲染——看方案时一个动作都没有） */}
      {isAssistant && <MessageActionBar actions={assistantActions} />}
      <div
        className={cn(
          "mt-0.5 shrink-0",
          !isDefaultVisible && "opacity-60 [&_svg]:text-muted-foreground",
        )}
      >
        {renderEventIcon(ev.kind)}
      </div>
      {/* min-w-0 防止 flex 子项把容器撑爆、配合下面的 break-all / break-words 让长文本自动换行 */}
      <div className="min-w-0 flex-1 text-xs">
        {/* header：整行 hover、点击切换折叠 */}
        <button
          type="button"
          onClick={handleToggle}
          className={cn(
            "flex w-full cursor-pointer items-center text-left hover:opacity-80",
            isDefaultVisible ? "gap-2" : "gap-1.5",
          )}
        >
          <CollapseChevron open={!collapsed} />
          {actionType && (
            <ActionTag label={ACTION_LABEL_SHORT[actionType] ?? actionType} />
          )}
          <span className="text-muted-foreground/70 text-[11px]">
            {EVENT_LABEL[ev.kind]}
          </span>
          <span className="text-muted-foreground">{formatTs(ev.ts)}</span>
          {/* 折叠态把摘要也放 header 里、用户一眼看到这是啥事件、不用展开 */}
          {collapsed && summary && (
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                isDefaultVisible
                  ? "text-muted-foreground/80"
                  : "text-muted-foreground/65",
              )}
            >
              {summary}
            </span>
          )}
        </button>
        {/* 展开态才渲染 body */}
        {!collapsed &&
          (batch ? (
            // tool_call 合并卡展开：列表展示每条子 tool_call 的时间 + tool 名 + 文案
            // 一行一条、紧凑、所有路径 break-all 防溢出
            // V0.5.13.1 合并放宽到「不分 tool 名」、给每条加 `[name]` prefix 看得清谁是谁
            <ul className="mt-1 space-y-1">
              {batch.map((item) => (
                <li
                  key={item.id}
                  className="flex gap-2 break-all font-mono text-[11px] text-foreground/80"
                >
                  <span className="shrink-0 text-muted-foreground">
                    {formatTs(item.ts)}
                  </span>
                  {item.name && (
                    <span className="shrink-0 rounded-sm bg-info/10 px-1 text-info">
                      {item.name}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">{item.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div
              className={cn(
                "mt-1 leading-relaxed wrap-break-word",
                // tool_call 文本里常含长 JSON 路径、break-all 比 break-words 更强（任意字符断行）
                isToolCall &&
                  "break-all font-mono text-[11px] text-muted-foreground/75",
                isThinking && "italic text-muted-foreground",
                // 行动指引类提示是多行结构（结论 + 明细 + 下一步）、换行得留住
                isNotice && "whitespace-pre-wrap",
                !isToolCall &&
                  !isThinking &&
                  !useMarkdown &&
                  (isDefaultVisible ? "text-foreground" : "text-muted-foreground/75"),
              )}
            >
              {isUser ? (
                <SearchHighlightText ownerId={ev.id} field="body" text={ev.text} />
              ) : useMarkdown ? (
                <MarkdownText
                  text={ev.text}
                  baseDir={markdownBaseDir}
                  searchOwnerId={ev.id}
                  searchField="body"
                />
              ) : (
                <SearchHighlightText
                  ownerId={ev.id}
                  field="body"
                  text={ev.text}
                />
              )}
            </div>
          ))}
        {/* user_reply / ask_user_reply 附图缩略图：折叠 / 展开都显示（图比文字更值得"始终见到"）
            点缩略图站内 lightbox 看大图、多图可左右切换（V0.8.8 统一 ImageThumb）*/}
        {hasImageMeta && images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {imageGroup.map((g, i) => (
              <ImageThumb
                key={images[i].absPath}
                src={g.src}
                alt={g.alt}
                title={g.title}
                className="size-16"
                group={imageGroup}
                index={i}
              />
            ))}
          </div>
        )}
        {/* user_reply 附路径 chips：跟图片一样、始终显示（不受折叠影响）
            点击在 Cursor 中打开（cursor:// deep link、跟 artifact-panel 同款）*/}
        {isUser && attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {attachments.map((att) => {
              const sizeStr =
                att.bytes != null
                  ? att.bytes < 1024
                    ? `${att.bytes} B`
                    : att.bytes < 1024 * 1024
                      ? `${(att.bytes / 1024).toFixed(1)} KB`
                      : `${(att.bytes / 1024 / 1024).toFixed(1)} MB`
                  : "";
              // att.absPath 一定是绝对路径（原生 picker 选出来的）、
              // getIdeAnchorProps 在绝对路径下永远不会返 null；?? 兜底纯为满足类型
              const anchor =
                getIdeAnchorProps(att.absPath, undefined, jumpIde) ?? { href: "" };
              return (
                <Tooltip
                  key={att.absPath}
                  content={`${att.absPath}${sizeStr ? ` · ${sizeStr}` : ""}\n点击在 ${JUMP_IDE_LABEL[jumpIde]} 中打开`}
                >
                  <a
                    {...anchor}
                    className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs no-underline hover:bg-muted"
                  >
                    {att.isDir ? (
                      <Folder className="size-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 truncate font-mono text-[11px] text-info">
                      {pathBasename(att.absPath)}
                    </span>
                  </a>
                </Tooltip>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

// React.memo（V0.5.14）：props 是 ev / taskId 这种引用稳定值、Virtuoso 滚动时
// 已渲染 item 不重渲染、SSE 推新 chunk 时其他 item props 不变也跳过 reconcile
export const EventRow = memo(EventRowImpl);

// ===========================================
// AskUserRequestRow（V0.3.2 简化版：纯回放卡片）
// ===========================================
//
// V0.3.2 改造（用户拍板）：交互移到 AskUserDialog modal、事件流里只做「历史回放」
//
// 渲染规则：
//   - 没找到 reply：显示「AI 在弹窗里问你 N 个问题、请到弹窗答」（简洁占位、不放交互）
//   - 找到 reply：显示拼接好的 Q&A 文本（reply 事件的 text 就是 markdown 拼好的）
//
// 这样做的好处：
//   - 不会被 thinking / tool_call 等过程事件淹没（真正的交互在 modal、屏幕中央可见）
//   - 历史回放清晰、所有 Q1/Q2 一目了然
//   - 取消「inline 一次只能答一个」的破碎感

interface AskUserRequestRowProps {
  ev: TaskEvent;
  task: Task;
}

/**
 * 「用户没答、直接发新消息」跳过的提问：收成一行灰色细行、点开看原问题。
 *
 * 为什么不直接从事件流里抹掉（用户拍板）：事件流是历史记录、AI 确实问过，
 * 彻底删掉会让回溯时看不懂 agent 后面那句「按你说的继续」是接着什么说的。
 */
const SkippedAskRow = ({ ev, count }: { ev: TaskEvent; count: number }) => {
  // 展开看原问题（默认收起——跳过了就说明用户不关心）
  const [open, setOpen] = useState(false);
  const questions = useMemo(() => extractAskQuestions(ev.meta), [ev.meta]);

  return (
    <div className="rounded-md border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <Ban className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          AI 提过 {count} 个问题 · 已跳过
        </span>
        <span className="shrink-0 tabular-nums opacity-70">
          {formatTs(ev.ts)}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-t border-border/50 px-2.5 py-2 text-xs text-muted-foreground">
          {questions.length > 0 ? (
            questions.map((q, idx) => (
              <div key={q.id} className="flex items-start gap-2">
                <span className="mt-px shrink-0 font-mono text-[11px] opacity-70">
                  Q{idx + 1}
                </span>
                <div className="min-w-0 flex-1 wrap-break-word">
                  {q.question}
                </div>
              </div>
            ))
          ) : (
            // meta.questions 丢了的脏数据：退回事件原文
            <div className="wrap-break-word">{ev.text}</div>
          )}
        </div>
      )}
    </div>
  );
};

const AskUserRequestRowImpl = ({ ev, task }: AskUserRequestRowProps) => {
  const askId =
    ev.meta && typeof ev.meta.askId === "string" ? ev.meta.askId : "";

  // 找对应 reply 事件
  const replyEvent = useMemo(
    () =>
      task.events.find(
        (e) =>
          e.kind === "ask_user_reply" &&
          typeof e.meta?.askId === "string" &&
          e.meta.askId === askId,
      ),
    [task.events, askId],
  );
  const answered = !!replyEvent;

  // 是否已被作废：断线重启 / 换 agent / 停止时后端补一条 info 标记（判定见 lib/ask-pending）。
  // 作废的 ask 没有真实 reply、显示中性失效态、别再误导成「正在等你答」。
  const superseded = useMemo(
    () => isAskSuperseded(task.events, askId),
    [task.events, askId],
  );

  // 「用户没答、直接发了新消息」这一种作废（ask-skip 写的标记）——收成一行、可展开看原问题。
  // answered 优先：极窄竞态下可能同时存在 reply 和跳过标记，有真答案就按已答显示
  const skipped = useMemo(
    () => !answered && isAskSkipped(task.events, askId),
    [answered, task.events, askId],
  );

  // 问题数量：从 meta.questions 拿、没有就尝试用 text 行数估
  const questionsCount =
    ev.meta && Array.isArray(ev.meta.questions)
      ? (ev.meta.questions as unknown[]).length
      : ev.text.split("\n").filter((l) => l.trim().length > 0).length;

  if (skipped) {
    return <SkippedAskRow ev={ev} count={questionsCount} />;
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border-2 p-3",
        superseded
          ? "border-muted bg-muted/30"
          : answered
            ? "border-success/30 bg-success/5"
            : // 未答 = 「等你行动」信号族、走品牌琥珀
              "border-brand/40 bg-brand/10",
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        {superseded ? (
          <Ban className="size-4 text-muted-foreground" />
        ) : answered ? (
          <CheckCircle2 className="size-4 text-success" />
        ) : (
          <Sparkles className="size-4 animate-pulse text-brand" />
        )}
        <span
          className={cn("font-medium", superseded && "text-muted-foreground")}
        >
          {superseded
            ? "这组提问已失效"
            : answered
              ? `已回答 ${questionsCount} 个问题`
              : `AI 问了 ${questionsCount} 个问题`}
        </span>
        <span className="text-muted-foreground/70">{formatTs(ev.ts)}</span>
      </div>

      {/* 未答且未失效但没走内联卡（非最新一条的脏数据残留）：中性占位、不放交互 */}
      {!answered && !superseded && (
        <div className="rounded-md border border-dashed bg-card/40 px-3 py-2 text-xs text-muted-foreground">
          这组提问未被回答（已被更新的提问顶替）
        </div>
      )}

      {/* 已答：展示拼接好的 Q&A markdown */}
      {answered && replyEvent && (
        <div className="rounded-md border bg-card/60 px-3 py-2 text-sm">
          <MarkdownText
            text={replyEvent.text}
            baseDir={task.workCwd}
            searchOwnerId={replyEvent.id}
            searchField="body"
          />
        </div>
      )}
    </div>
  );
};

// React.memo（V0.5.14）：props 是 ev / task、ev 稳定 + task 父组件 memo 过的引用
// 跟 EventRow 同理、SSE 频繁推 chunk 时 ask 卡片不无意义重渲染
export const AskUserRequestRow = memo(AskUserRequestRowImpl);
